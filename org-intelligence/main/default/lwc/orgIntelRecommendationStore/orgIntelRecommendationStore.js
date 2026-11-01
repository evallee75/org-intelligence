/**
 * Recommandations de l'édition sans objet : une recommandation par empreinte (règle + composant),
 * gardée dans le navigateur, avec les mêmes noms de champs que l'objet OrgRecommendation__c du
 * module collaboratif (Title__c, Severity__c, Status__c…), pour que les écrans servent les deux.
 *
 * Envoi depuis les analyses (scan, Security, Adoption, Objects & Fields) : sendRecommendations.
 * - module Recommendations installé et accessible → action « upsertExternal » (enregistrements
 *   partagés, collaboration Chatter) ;
 * - sinon → stockage local (décisions conservées, partage par fichier).
 * Le mode est détecté strictement : si la liste des modules ne peut pas être lue (réseau, session
 * expirée), une erreur est levée au lieu de basculer en local en silence.
 *
 * Mêmes règles de fusion que upsertExternal : une décision prise (statut, motif, gravité ajustée,
 * échéance, responsable, notes) n'est jamais écrasée ; une recommandation résolue puis re-détectée
 * par une autre analyse repasse « To Review ». Severity__c est la gravité de la règle (mise à jour à
 * chaque détection), AdjustedSeverity__c la gravité choisie par l'utilisateur (affichée en priorité).
 *
 * Écritures locales : une file par clé (pas deux lecture-modification-écriture en même temps dans
 * l'onglet), relecture juste avant la fusion, et signal aux autres onglets (BroadcastChannel,
 * événement « storage ») pour qu'ils rechargent leur liste.
 */
import userId from "@salesforce/user/Id";
import {
  callModule,
  loadInstalledModulesStrict,
  MODULES
} from "c/orgIntelModuleApi";
import {
  loadValue,
  removeValue,
  saveValue,
  STORE_KEYS,
  StoreError
} from "c/orgIntelStore";
import { reduceErrors } from "c/orgIntelUtils";

export const LOCAL_MODE = "local";
export const COLLABORATIVE_MODE = "collaborative";

/** Pierres tombales des recommandations effacées (empreinte → date), pour l'import. */
const DELETED_KEY = `${STORE_KEYS.RECOMMENDATIONS}.deleted`;

/** Champs de décision : jamais écrasés par une nouvelle détection. */
const DECISION_FIELDS = new Set([
  "Status__c",
  "DecisionReason__c",
  "DueDate__c",
  "EffortSize__c",
  "Notes__c",
  "Owner__c",
  "AdjustedSeverity__c",
  "StatusChangedAt__c",
  "ResolvedDate__c",
  "DecidedAt",
  "History"
]);

/** Plafond par appel du module (10 000 lignes DML par transaction côté Apex). */
const MAX_BATCH = 4000;
/** Lots de reprise des décisions (contenu complet : descriptions, preuves). */
const IMPORT_BATCH = 500;

// ---------- Mode (strict) ----------

const MODE_CACHE_MS = 30000;
let modeCache = null;

/**
 * Le module collaboratif est-il installé et accessible ? Lève une erreur si la liste des modules
 * n'a pas pu être lue (jamais de bascule silencieuse en local). `refresh` ignore le cache (30 s).
 */
export async function recommendationsMode({ refresh = false } = {}) {
  if (refresh || !modeCache || Date.now() - modeCache.at > MODE_CACHE_MS) {
    const promise = loadInstalledModulesStrict().then((keys) => {
      return keys.includes(MODULES.RECOMMENDATIONS)
        ? COLLABORATIVE_MODE
        : LOCAL_MODE;
    });
    modeCache = { promise, at: Date.now() };
    promise.catch(() => {
      if (modeCache && modeCache.promise === promise) {
        modeCache = null;
      }
    });
  }
  try {
    return await modeCache.promise;
  } catch (error) {
    throw new Error(
      `The installed modules could not be read, so the recommendations were not loaded or changed (${reduceErrors(
        error
      )}). Try again.`
    );
  }
}

// ---------- File d'écriture et signal entre onglets ----------

const queues = new Map();

/** Exécute `task` après les écritures en attente sur la même clé (dans cet onglet). */
function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function settled(key) {
  return queues.get(key) || Promise.resolve();
}

const CHANNEL_NAME = `orgIntelligence.recommendations.${userId}`;
let senderChannel;

function channelFor() {
  try {
    return typeof BroadcastChannel === "function"
      ? new BroadcastChannel(CHANNEL_NAME)
      : null;
  } catch {
    return null; // Locker / navigateur sans BroadcastChannel
  }
}

function notifyChange() {
  if (senderChannel === undefined) {
    senderChannel = channelFor();
  }
  try {
    if (senderChannel) {
      senderChannel.postMessage({ type: "changed", at: Date.now() });
    }
  } catch {
    // signal facultatif
  }
}

/**
 * Appelle `callback` quand les recommandations locales changent dans un autre onglet ou un autre
 * composant (BroadcastChannel, ou événement « storage » quand le support est localStorage).
 * Renvoie la fonction de désabonnement.
 */
export function onLocalRecommendationsChange(callback) {
  let timer;
  const fire = () => {
    window.clearTimeout(timer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    timer = window.setTimeout(() => callback(), 300);
  };
  const channel = channelFor();
  if (channel) {
    channel.onmessage = fire;
  }
  const onStorage = (event) => {
    if (
      event &&
      typeof event.key === "string" &&
      event.key.includes(`.${userId}.${STORE_KEYS.RECOMMENDATIONS}`)
    ) {
      fire();
    }
  };
  try {
    window.addEventListener("storage", onStorage);
  } catch {
    // pas d'événement storage
  }
  return () => {
    window.clearTimeout(timer);
    try {
      if (channel) {
        channel.close();
      }
      window.removeEventListener("storage", onStorage);
    } catch {
      // rien à fermer
    }
  };
}

// ---------- Lecture et écriture locales ----------

const time = (value) => (value ? new Date(value).getTime() || 0 : 0);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reprise des données d'avant AdjustedSeverity__c : une gravité changée à la main (historique
 * « Severity__c ») devient la gravité ajustée.
 */
function normalize(rec) {
  if (!isPlainObject(rec) || "AdjustedSeverity__c" in rec) {
    return rec;
  }
  const adjusted = (rec.History || []).some(
    (entry) => entry && entry.field === "Severity__c"
  );
  rec.AdjustedSeverity__c = adjusted ? rec.Severity__c || null : null;
  return rec;
}

async function readRecommendations() {
  const stored = await loadValue(STORE_KEYS.RECOMMENDATIONS, null);
  if (stored === null || stored === undefined) {
    return {};
  }
  if (!isPlainObject(stored)) {
    // Ne jamais écrire par-dessus une valeur illisible : les décisions seraient perdues
    throw new StoreError(
      "The recommendations stored in this browser are unreadable: nothing was changed. Save them to a file from Settings before clearing them."
    );
  }
  Object.values(stored).forEach(normalize);
  return stored;
}

async function readTombstones() {
  const stored = await loadValue(DELETED_KEY, null);
  return isPlainObject(stored) ? stored : {};
}

/** Recommandations locales, indexées par empreinte (après les écritures en attente). */
export async function loadLocalRecommendations() {
  await settled(STORE_KEYS.RECOMMENDATIONS);
  return readRecommendations();
}

/** Dernier changement connu d'une recommandation (décision, détection ou création). */
function lastChange(rec) {
  return Math.max(
    time(rec && rec.DecidedAt),
    time(rec && rec.LastDetectedAt__c),
    time(rec && rec.CreatedDate)
  );
}

function historyKey(entry) {
  return `${entry.changedAt}|${entry.field}|${entry.newValue}`;
}

const MAX_HISTORY = 50;

function mergeHistory(a, b) {
  const entries = new Map();
  [...(a || []), ...(b || [])].forEach((entry) => {
    if (entry) {
      entries.set(historyKey(entry), entry);
    }
  });
  return [...entries.values()]
    .sort((x, y) => time(x.changedAt) - time(y.changedAt))
    .slice(-MAX_HISTORY);
}

/**
 * Réconcilie une copie modifiée (lue plus tôt, ex. au début d'un scan) avec l'état stocké relu
 * juste avant d'écrire : décisions les plus récentes gardées, recommandations créées entre-temps
 * conservées, recommandations effacées entre-temps non ressuscitées sauf nouvelle détection.
 */
function reconcile(incoming, latest, tombstones) {
  const result = { ...incoming };
  Object.entries(latest).forEach(([fingerprint, stored]) => {
    const mine = result[fingerprint];
    if (!mine) {
      result[fingerprint] = stored;
      return;
    }
    if (time(stored.DecidedAt) > time(mine.DecidedAt)) {
      const next = { ...mine };
      DECISION_FIELDS.forEach((field) => {
        if (field !== "History") {
          next[field] = stored[field] === undefined ? null : stored[field];
        }
      });
      next.History = mergeHistory(mine.History, stored.History);
      result[fingerprint] = next;
    }
  });
  Object.keys(result).forEach((fingerprint) => {
    const deletedAt = time(tombstones[fingerprint]);
    if (!deletedAt) {
      return;
    }
    if (!latest[fingerprint] && lastChange(result[fingerprint]) <= deletedAt) {
      delete result[fingerprint];
    } else {
      delete tombstones[fingerprint]; // détectée ou décidée après l'effacement
    }
  });
  return result;
}

async function writeState(byFingerprint, tombstones) {
  await saveValue(STORE_KEYS.RECOMMENDATIONS, byFingerprint);
  if (tombstones) {
    if (Object.keys(tombstones).length) {
      await saveValue(DELETED_KEY, tombstones);
    } else {
      await removeValue(DELETED_KEY);
    }
  }
  notifyChange();
}

/**
 * Lecture-modification-écriture protégée : `mutator(byFingerprint, tombstones)` reçoit l'état relu
 * juste avant, le modifie sur place et renvoie un résultat ; l'écriture suit dans la même file.
 */
export function updateLocalRecommendations(mutator) {
  return enqueue(STORE_KEYS.RECOMMENDATIONS, async () => {
    const byFingerprint = await readRecommendations();
    const tombstones = await readTombstones();
    const result = await mutator(byFingerprint, tombstones);
    await writeState(byFingerprint, tombstones);
    return result;
  });
}

/**
 * Enregistre une copie complète (lue plus tôt par l'appelant) : elle est réconciliée avec l'état
 * relu juste avant l'écriture, pour ne pas écraser une décision prise entre-temps (autre onglet,
 * panneau ouvert pendant un scan). Préférer updateLocalRecommendations.
 */
export function saveLocalRecommendations(byFingerprint) {
  if (!isPlainObject(byFingerprint)) {
    return Promise.reject(
      new StoreError("Nothing to save: the recommendations are unreadable.")
    );
  }
  return enqueue(STORE_KEYS.RECOMMENDATIONS, async () => {
    const latest = await readRecommendations();
    const tombstones = await readTombstones();
    const merged = reconcile(byFingerprint, latest, tombstones);
    await writeState(merged, tombstones);
    // L'appelant garde la même référence : qu'il voie l'état réellement écrit
    Object.keys(byFingerprint).forEach((key) => {
      if (!(key in merged)) {
        delete byFingerprint[key];
      }
    });
    Object.assign(byFingerprint, merged);
  });
}

// ---------- Numéros lisibles ----------

/** Hash court et stable (FNV-1a 32 bits) d'une empreinte, en base 36. */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 2176782336).toString(36).toUpperCase().padStart(6, "0");
}

/**
 * Numéro dérivé de l'empreinte (REC-XXXXXX) : le même sur tous les postes, donc les références
 * citées dans Jira ou un e-mail restent valables. Collision (rare) : variante salée.
 */
export function recommendationName(fingerprint, takenNames) {
  let name = `REC-${shortHash(String(fingerprint))}`;
  let salt = 1;
  while (takenNames && takenNames.has(name) && salt < 50) {
    name = `REC-${shortHash(`${salt}:${fingerprint}`)}`;
    salt++;
  }
  return name;
}

function namesOf(byFingerprint) {
  return new Set(
    Object.values(byFingerprint)
      .map((rec) => rec && rec.Name)
      .filter(Boolean)
  );
}

// ---------- Fusion des détections ----------

/** Même analyse : même nom de scan, ou à défaut même date de détection (renvoi d'un résultat). */
function isSameRun(spec, current) {
  if (spec.LastScanName__c) {
    return spec.LastScanName__c === current.LastScanName__c;
  }
  return (
    !!spec.LastDetectedAt__c &&
    time(spec.LastDetectedAt__c) === time(current.LastDetectedAt__c)
  );
}

/**
 * Fusionne des recommandations dans le stockage local (même contrat que upsertExternal).
 * `specs` : objets aux noms de champs d'OrgRecommendation__c, `Fingerprint__c` obligatoire.
 * Occurrences comptées par analyse distincte (LastScanName__c, sinon LastDetectedAt__c).
 */
export function mergeRecommendations(
  byFingerprint,
  specs,
  reopenReason,
  now = new Date()
) {
  const stamp = now.toISOString();
  const names = namesOf(byFingerprint);
  let created = 0;
  let updated = 0;
  (specs || []).forEach((spec) => {
    const fingerprint = spec && spec.Fingerprint__c;
    if (!fingerprint) {
      return;
    }
    const current = byFingerprint[fingerprint];
    if (!current) {
      const content = {};
      Object.keys(spec).forEach((field) => {
        if (!DECISION_FIELDS.has(field)) {
          content[field] = spec[field];
        }
      });
      const name = recommendationName(fingerprint, names);
      names.add(name);
      byFingerprint[fingerprint] = {
        ...content,
        Id: `local:${fingerprint}`,
        Name: name,
        Status__c: "New",
        AdjustedSeverity__c: null,
        FirstDetectedAt__c: stamp,
        LastDetectedAt__c: spec.LastDetectedAt__c || stamp,
        StillDetected__c: spec.StillDetected__c !== false,
        OccurrenceCount__c: 1,
        CreatedDate: stamp
      };
      created++;
      return;
    }
    normalize(current);
    const sameRun = isSameRun(spec, current);
    const next = { ...current };
    Object.keys(spec).forEach((field) => {
      if (!DECISION_FIELDS.has(field)) {
        next[field] = spec[field];
      }
    });
    next.Id = current.Id;
    next.Name = current.Name;
    next.OccurrenceCount__c =
      (current.OccurrenceCount__c || 0) + (sameRun ? 0 : 1);
    next.LastDetectedAt__c = spec.LastDetectedAt__c || stamp;
    next.StillDetected__c = spec.StillDetected__c !== false;
    if (!sameRun && current.Status__c === "Resolved") {
      next.Status__c = "To Review";
      next.DecisionReason__c = reopenReason || current.DecisionReason__c;
      next.StatusChangedAt__c = stamp;
      next.ResolvedDate__c = null;
      next.DecidedAt = stamp;
      next.History = [
        ...(current.History || []),
        {
          field: "Status__c",
          fieldLabel: "Status",
          oldValue: "Resolved",
          newValue: "To Review",
          changedAt: stamp,
          changedByName: "Detected again"
        }
      ].slice(-MAX_HISTORY);
    }
    byFingerprint[fingerprint] = next;
    updated++;
  });
  return { created, updated };
}

/**
 * Marque « plus détectées » les recommandations des règles évaluées sans échec et absentes du
 * dernier résultat (jamais résolues automatiquement).
 */
export function markNotDetected(
  byFingerprint,
  reliableRules,
  detectedFingerprints
) {
  const rules = new Set(reliableRules || []);
  const detected = new Set(detectedFingerprints || []);
  let count = 0;
  Object.values(byFingerprint).forEach((rec) => {
    if (
      rules.has(rec.RuleCode__c) &&
      !detected.has(rec.Fingerprint__c) &&
      rec.StillDetected__c !== false
    ) {
      rec.StillDetected__c = false;
      count++;
    }
  });
  return count;
}

function chunks(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }
  return result;
}

/**
 * Envoie des recommandations vers le module collaboratif s'il est installé, sinon vers le
 * stockage local. Renvoie { created, updated, mode }.
 */
export async function sendRecommendations(specs, { reopenReason } = {}) {
  const list = (specs || []).filter((spec) => spec && spec.Fingerprint__c);
  const mode = await recommendationsMode();
  if (!list.length) {
    return { created: 0, updated: 0, mode };
  }
  if (mode === COLLABORATIVE_MODE) {
    let created = 0;
    let updated = 0;
    for (const batch of chunks(list, MAX_BATCH)) {
      // eslint-disable-next-line no-await-in-loop
      const counts = await callModule(
        MODULES.RECOMMENDATIONS,
        "upsertExternal",
        {
          recommendations: batch,
          reopenReason
        }
      );
      created += (counts && counts.created) || 0;
      updated += (counts && counts.updated) || 0;
    }
    return { created, updated, mode };
  }
  const counts = await updateLocalRecommendations(
    (byFingerprint, tombstones) => {
      list.forEach((spec) => delete tombstones[spec.Fingerprint__c]);
      return mergeRecommendations(byFingerprint, list, reopenReason);
    }
  );
  return { ...counts, mode };
}

// ---------- Édition sans objet : lecture et décisions dans le navigateur ----------

/** Préfixe des identifiants locaux (« local:<empreinte> »), distincts des Id Salesforce. */
export const LOCAL_ID_PREFIX = "local:";

/** Statuts ouverts (même liste que la formule IsOpen__c du module). */
const OPEN_STATUSES = ["New", "To Review", "Accepted"];

/** Statuts qui exigent un motif. */
export const REASON_REQUIRED_STATUSES = ["Ignored", "Resolved"];

/** Domaine par préfixe de règle : même convention que la formule Domain__c et REC_DOMAINS. */
const DOMAIN_PREFIXES = [
  [["APEX_", "TRIGGER_"], "Apex"],
  [["FLOW_", "AUTOMATION_"], "Flows & Automation"],
  [["OBJECT_", "FIELD_"], "Data Model"],
  [["VR_"], "Data Quality"],
  [["STORAGE_"], "Storage"],
  [["ADOPTION_"], "Adoption"],
  [["SECURITY_"], "Security"]
];

export function recommendationDomain(ruleCode) {
  const code = ruleCode || "";
  const match = DOMAIN_PREFIXES.find(([prefixes]) =>
    prefixes.some((prefix) => code.startsWith(prefix))
  );
  return match ? match[1] : "Other";
}

export function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status || "New");
}

export function isLocalId(id) {
  return typeof id === "string" && id.startsWith(LOCAL_ID_PREFIX);
}

function localId(rec) {
  return rec.Id || `${LOCAL_ID_PREFIX}${rec.Fingerprint__c}`;
}

function findLocal(byFingerprint, id) {
  if (!id) {
    return null;
  }
  const fingerprint = isLocalId(id) ? id.slice(LOCAL_ID_PREFIX.length) : id;
  return (
    byFingerprint[fingerprint] ||
    Object.values(byFingerprint).find((rec) => localId(rec) === id) ||
    null
  );
}

function splitLines(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  return value
    ? String(value)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

/** Ligne de liste au format de OrgRecommendationService.Row (mêmes écrans dans les deux éditions). */
export function toRow(rec) {
  const status = rec.Status__c || "New";
  return {
    id: localId(rec),
    name: rec.Name,
    fingerprint: rec.Fingerprint__c,
    title: rec.Title__c,
    severity: rec.AdjustedSeverity__c || rec.Severity__c,
    ruleSeverity: rec.Severity__c || null,
    severityAdjusted:
      !!rec.AdjustedSeverity__c && rec.AdjustedSeverity__c !== rec.Severity__c,
    category: rec.Category__c,
    confidence: rec.Confidence__c,
    status,
    componentType: rec.ComponentType__c,
    componentName: rec.ComponentName__c,
    ruleCode: rec.RuleCode__c,
    domain: recommendationDomain(rec.RuleCode__c),
    jiraIssueKey: null,
    jiraIssueUrl: null,
    jiraExportedAt: rec.JiraExportedAt__c || null,
    assignedToId: null,
    // Responsable en texte libre (édition sans objet) : affiché et cherché comme une assignation
    assignedToName: rec.Owner__c || null,
    owner: rec.Owner__c || null,
    hasNotes: !!rec.Notes__c,
    dueDate: rec.DueDate__c || null,
    lastDetectedAt: rec.LastDetectedAt__c || null,
    stillDetected: rec.StillDetected__c !== false,
    occurrenceCount: rec.OccurrenceCount__c || 0,
    isOpen: isOpenStatus(status),
    statusChangedAt: rec.StatusChangedAt__c || null,
    createdDate: rec.CreatedDate || rec.FirstDetectedAt__c || null,
    lastModifiedDate:
      rec.DecidedAt || rec.LastDetectedAt__c || rec.CreatedDate || null,
    commentCount: 0
  };
}

/** Liste au format de listRecommendations (currentUserId absent : pas d'assignation en local). */
export async function listLocalRecommendations() {
  const byFingerprint = await loadLocalRecommendations();
  return {
    currentUserId: null,
    truncated: false,
    rows: Object.values(byFingerprint).map(toRow)
  };
}

/** Détail au format de OrgRecommendationService.Detail. */
export async function getLocalRecommendation(id) {
  const byFingerprint = await loadLocalRecommendations();
  const rec = findLocal(byFingerprint, id);
  if (!rec) {
    throw new Error(
      "This recommendation is not stored in this browser (it may have been cleared)."
    );
  }
  const row = toRow(rec);
  const related = Object.values(byFingerprint)
    .filter(
      (other) =>
        other !== rec &&
        rec.ComponentName__c &&
        other.ComponentName__c === rec.ComponentName__c
    )
    .slice(0, 20)
    .map(toRow);
  const history = [...(rec.History || [])].sort(
    (a, b) => new Date(b.changedAt) - new Date(a.changedAt)
  );
  if (rec.FirstDetectedAt__c || rec.CreatedDate) {
    history.push({
      field: "created",
      fieldLabel: "Created",
      changedAt: rec.FirstDetectedAt__c || rec.CreatedDate
    });
  }
  return {
    record: row,
    description: rec.Description__c,
    justification: rec.Justification__c || rec.Evidence__c || null,
    suggestedAction: rec.SuggestedAction__c,
    affectedComponents: splitLines(
      rec.AffectedComponents__c || rec.ComponentName__c
    ),
    decisionReason: rec.DecisionReason__c || null,
    owner: rec.Owner__c || null,
    notes: rec.Notes__c || null,
    fingerprint: rec.Fingerprint__c,
    firstDetectedAt: rec.FirstDetectedAt__c,
    lastDetectedScanName: rec.LastScanName__c || null,
    resolvedDate: rec.ResolvedDate__c || null,
    createdByName: null,
    rule: null,
    history,
    relatedRecommendations: related,
    comments: [],
    canEdit: true,
    isFollowing: false
  };
}

const HISTORY_LABELS = {
  Status__c: "Status",
  Severity__c: "Severity",
  AdjustedSeverity__c: "Severity",
  DecisionReason__c: "Decision reason",
  DueDate__c: "Due date",
  Owner__c: "Owner",
  Notes__c: "Notes"
};

/** Valeur gardée dans l'historique (les notes sont abrégées). */
function historyValue(field, value) {
  if (field === "Notes__c" && value && String(value).length > 80) {
    return `${String(value).slice(0, 79)}…`;
  }
  return value;
}

/**
 * Applique des changements (clés : status, decisionReason, dueDate, severity — gravité ajustée —,
 * owner, notes, appendNote — note ajoutée à la suite, actions groupées) à des recommandations
 * locales ; historise chaque champ modifié. Fonction pure (testable).
 */
export function applyChanges(byFingerprint, ids, changes, options = {}) {
  const status = changes.status;
  const reason = (changes.decisionReason || "").trim();
  if (!ids || !ids.length) {
    throw new Error("Select at least one recommendation.");
  }
  if (REASON_REQUIRED_STATUSES.includes(status) && !reason) {
    throw new Error(
      `Explain the decision: a reason is required to mark a recommendation ${status}.`
    );
  }
  const stamp = (options.now || new Date()).toISOString();
  const values = {};
  if ("status" in changes) {
    values.Status__c = status;
  }
  if ("decisionReason" in changes) {
    values.DecisionReason__c = reason ? reason.slice(0, 255) : null;
  }
  if ("dueDate" in changes) {
    values.DueDate__c = changes.dueDate || null;
  }
  if ("severity" in changes) {
    values.AdjustedSeverity__c = changes.severity || null;
  }
  if ("owner" in changes) {
    const owner = (changes.owner || "").trim();
    values.Owner__c = owner ? owner.slice(0, 80) : null;
  }
  if ("notes" in changes) {
    const notes = (changes.notes || "").trim();
    values.Notes__c = notes ? notes.slice(0, 4000) : null;
  }
  const appendNote = (changes.appendNote || "").trim();
  let count = 0;
  ids.forEach((id) => {
    const rec = findLocal(byFingerprint, id);
    if (!rec) {
      return;
    }
    normalize(rec);
    const history = rec.History ? [...rec.History] : [];
    let changed = false;
    const recValues = { ...values };
    if (appendNote) {
      const line = `${stamp.slice(0, 10)}${options.userName ? ` ${options.userName}` : ""}: ${appendNote}`;
      recValues.Notes__c = (
        rec.Notes__c ? `${rec.Notes__c}\n${line}` : line
      ).slice(-4000);
    }
    Object.entries(recValues).forEach(([field, value]) => {
      const before = rec[field] === undefined ? null : rec[field];
      if ((before || null) === (value || null)) {
        return;
      }
      history.push({
        field,
        fieldLabel: HISTORY_LABELS[field] || field,
        oldValue: historyValue(field, before),
        newValue: historyValue(field, value),
        changedAt: stamp,
        changedByName: options.userName || null
      });
      rec[field] = value;
      changed = true;
      if (field === "Status__c") {
        rec.StatusChangedAt__c = stamp;
        rec.ResolvedDate__c = value === "Resolved" ? stamp : null;
      }
    });
    if (changed) {
      rec.History = history.slice(-MAX_HISTORY);
      rec.DecidedAt = stamp;
      count++;
    }
  });
  return count;
}

/** Décisions prises dans le navigateur (édition sans objet). Renvoie le nombre de recommandations modifiées. */
export function applyLocalChanges(ids, changes, options = {}) {
  return updateLocalRecommendations((byFingerprint) =>
    applyChanges(byFingerprint, ids, changes || {}, options)
  );
}

/** Note la date du dernier export Jira (fichier CSV) des recommandations locales. */
export function markJiraExported(ids) {
  const stamp = new Date().toISOString();
  return updateLocalRecommendations((byFingerprint) => {
    (ids || []).forEach((id) => {
      const rec = findLocal(byFingerprint, id);
      if (rec) {
        rec.JiraExportedAt__c = stamp;
      }
    });
  });
}

/**
 * Efface des recommandations locales ; une pierre tombale par empreinte empêche un fichier plus
 * ancien de les faire revenir lors d'un import ; une nouvelle détection les recrée. Renvoie le nombre effacé.
 */
export function deleteLocalRecommendations(ids) {
  const stamp = new Date().toISOString();
  return updateLocalRecommendations((byFingerprint, tombstones) => {
    let count = 0;
    (ids || []).forEach((id) => {
      const rec = findLocal(byFingerprint, id);
      if (rec) {
        delete byFingerprint[rec.Fingerprint__c];
        tombstones[rec.Fingerprint__c] = stamp;
        count++;
      }
    });
    return count;
  });
}

/** Nombre de recommandations gardées dans ce navigateur. */
export async function countLocalRecommendations() {
  return Object.keys(await loadLocalRecommendations()).length;
}

/** Efface toutes les recommandations locales (après leur reprise dans l'édition collaborative). */
export function clearLocalRecommendations() {
  return enqueue(STORE_KEYS.RECOMMENDATIONS, async () => {
    await removeValue(STORE_KEYS.RECOMMENDATIONS);
    await removeValue(DELETED_KEY);
    notifyChange();
  });
}

// ---------- Partage entre administrateurs (fichier JSON) ----------

export const RECOMMENDATIONS_FILE_KIND = "recommendations";

/** Champs de décision d'un fichier : la décision la plus récente (DecidedAt) gagne. */
const DECISION_KEYS = [
  "Status__c",
  "EffortSize__c",
  "DecisionReason__c",
  "DueDate__c",
  "AdjustedSeverity__c",
  "Owner__c",
  "Notes__c",
  "StatusChangedAt__c",
  "ResolvedDate__c",
  "DecidedAt"
];

/** Pierres tombales d'un fichier : [{ fingerprint, deletedAt }] ou { empreinte: date }. */
function incomingTombstones(deleted) {
  if (Array.isArray(deleted)) {
    return deleted
      .filter((item) => item && item.fingerprint && item.deletedAt)
      .map((item) => [String(item.fingerprint), item.deletedAt]);
  }
  return isPlainObject(deleted) ? Object.entries(deleted) : [];
}

/**
 * Fusionne des recommandations importées (fichier d'un autre administrateur) par empreinte, avec
 * une règle unique : le plus récent gagne — contenu technique de la détection la plus récente,
 * décision la plus récente (DecidedAt), historiques réunis, effacements (pierres tombales) plus
 * récents que le dernier changement. Fonction pure. Renvoie { added, updated, removed }.
 * `options.tombstones` : pierres tombales locales (modifiées sur place) ; `options.deleted` :
 * celles du fichier.
 */
export function mergeImported(byFingerprint, incoming, options = {}) {
  const tombstones = options.tombstones || {};
  const names = namesOf(byFingerprint);
  let added = 0;
  let updated = 0;
  let removed = 0;
  incomingTombstones(options.deleted).forEach(([fingerprint, deletedAt]) => {
    const current = byFingerprint[fingerprint];
    if (current && lastChange(current) < time(deletedAt)) {
      delete byFingerprint[fingerprint];
      removed++;
    }
    if (!current || !byFingerprint[fingerprint]) {
      if (time(deletedAt) > time(tombstones[fingerprint])) {
        tombstones[fingerprint] = deletedAt;
      }
    }
  });
  (incoming || []).forEach((item) => {
    const fingerprint = item && item.Fingerprint__c;
    if (!fingerprint) {
      return;
    }
    const raw = normalize({ ...item });
    if (
      tombstones[fingerprint] &&
      time(tombstones[fingerprint]) >= lastChange(raw)
    ) {
      return; // effacée ici après le dernier changement connu du fichier
    }
    delete tombstones[fingerprint];
    const current = byFingerprint[fingerprint];
    if (!current) {
      const copy = { ...raw, Id: `${LOCAL_ID_PREFIX}${fingerprint}` };
      if (!copy.Name || names.has(copy.Name)) {
        copy.Name = recommendationName(fingerprint, names);
      }
      names.add(copy.Name);
      byFingerprint[fingerprint] = copy;
      added++;
      return;
    }
    normalize(current);
    const next =
      time(raw.LastDetectedAt__c) > time(current.LastDetectedAt__c)
        ? { ...current, ...raw, Id: current.Id, Name: current.Name }
        : { ...current };
    const decisionSource =
      time(raw.DecidedAt) > time(current.DecidedAt) ? raw : current;
    DECISION_KEYS.forEach((key) => {
      next[key] =
        decisionSource[key] === undefined ? null : decisionSource[key];
    });
    next.History = mergeHistory(current.History, raw.History);
    next.OccurrenceCount__c = Math.max(
      current.OccurrenceCount__c || 0,
      raw.OccurrenceCount__c || 0
    );
    const firsts = [current.FirstDetectedAt__c, raw.FirstDetectedAt__c].filter(
      Boolean
    );
    if (firsts.length) {
      next.FirstDetectedAt__c = firsts.sort()[0];
    }
    byFingerprint[fingerprint] = next;
    updated++;
  });
  return { added, updated, removed };
}

/** Toutes les recommandations, décisions et effacements locaux, à enregistrer dans un fichier. */
export async function exportLocalRecommendations() {
  await settled(STORE_KEYS.RECOMMENDATIONS);
  const byFingerprint = await readRecommendations();
  const tombstones = await readTombstones();
  return {
    recommendations: Object.values(byFingerprint),
    deleted: Object.entries(tombstones).map(([fingerprint, deletedAt]) => ({
      fingerprint,
      deletedAt
    }))
  };
}

/** Recommandations partagées (édition collaborative), au même format de fichier. */
export async function exportSharedRecommendations() {
  const list = await callModule(
    MODULES.RECOMMENDATIONS,
    "exportRecommendations",
    {}
  );
  return { recommendations: list || [], deleted: [] };
}

/** Liste de recommandations d'un fichier, contrôlée (objets avec une empreinte texte). */
function recommendationsOf(data) {
  const list = Array.isArray(data) ? data : data && data.recommendations;
  if (!Array.isArray(list)) {
    throw new StoreError("This file does not contain recommendations.");
  }
  const valid = list.filter(
    (item) =>
      isPlainObject(item) &&
      typeof item.Fingerprint__c === "string" &&
      item.Fingerprint__c.length > 0
  );
  if (list.length && !valid.length) {
    throw new StoreError(
      "This file does not contain recommendations (no fingerprint found)."
    );
  }
  return valid;
}

/** Importe le contenu d'un fichier exporté (data = { recommendations, deleted } ou liste). */
export async function importLocalRecommendations(data) {
  const list = recommendationsOf(data);
  return updateLocalRecommendations((byFingerprint, tombstones) => {
    const counts = mergeImported(byFingerprint, list, {
      tombstones,
      deleted: data && data.deleted
    });
    return { ...counts, total: Object.keys(byFingerprint).length };
  });
}

/** Contenu envoyé au module pour une reprise : sans identifiant local ni historique. */
function toImportSpec(rec) {
  const spec = { ...rec };
  delete spec.Id;
  delete spec.History;
  return spec;
}

/**
 * Reprend des recommandations et leurs décisions dans l'édition collaborative (action
 * « importDecisions » du module, administrateurs) : `data` = contenu d'un fichier, sinon les
 * recommandations de ce navigateur. Renvoie { created, updated, skipped, total }.
 */
export async function pushDecisionsToShared(data) {
  const list = data
    ? recommendationsOf(data)
    : Object.values(await loadLocalRecommendations());
  const totals = { created: 0, updated: 0, skipped: 0, total: list.length };
  for (const batch of chunks(list.map(toImportSpec), IMPORT_BATCH)) {
    // eslint-disable-next-line no-await-in-loop
    const counts = await callModule(
      MODULES.RECOMMENDATIONS,
      "importDecisions",
      {
        recommendations: batch
      }
    );
    totals.created += (counts && counts.created) || 0;
    totals.updated += (counts && counts.updated) || 0;
    totals.skipped += (counts && counts.skipped) || 0;
  }
  return totals;
}

// ---------- Jira par fichier CSV (édition sans objet) ----------

/** Priorité Jira par gravité (même correspondance que l'export par API du module). */
export const JIRA_PRIORITIES = {
  Critical: "Highest",
  High: "High",
  Medium: "Medium",
  Low: "Low",
  Info: "Lowest"
};

function jiraLabel(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Labels Jira (sans espace) : org-intelligence, domaine, gravité, catégorie. */
export function jiraLabels(row) {
  return [
    "org-intelligence",
    ...[
      row.domain || recommendationDomain(row.ruleCode),
      row.severity,
      row.category
    ]
      .filter(Boolean)
      .map(jiraLabel)
  ];
}

function jiraDescription(row, detail) {
  const parts = [];
  if (detail.description) {
    parts.push(`h3. What was found\n${detail.description}`);
  }
  if (detail.justification) {
    parts.push(`h3. Why it matters · evidence\n${detail.justification}`);
  }
  if (detail.suggestedAction) {
    parts.push(`h3. Suggested action\n${detail.suggestedAction}`);
  }
  const affected = detail.affectedComponents || [];
  if (affected.length) {
    parts.push(
      `h3. Affected components\n${affected.map((name) => `* ${name}`).join("\n")}`
    );
  }
  const component = [row.componentType, row.componentName]
    .filter(Boolean)
    .join(" ");
  parts.push(
    [`Rule ${row.ruleCode || "—"}`, component, `${row.name} (Org Intelligence)`]
      .filter(Boolean)
      .join(" · ")
  );
  return parts.join("\n\n");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Fichier CSV importable dans Jira (System › External system import › CSV) : Summary, Issue Type,
 * Priority, Description, une colonne « Labels » par label (Jira les cumule).
 * `records` : recommandations locales (noms de champs d'OrgRecommendation__c).
 */
export function buildJiraCsv(records, { issueType = "Task" } = {}) {
  const items = (records || []).map((rec) => {
    const row = toRow(rec);
    const detail = {
      description: rec.Description__c,
      justification: rec.Justification__c || rec.Evidence__c,
      suggestedAction: rec.SuggestedAction__c,
      affectedComponents: splitLines(rec.AffectedComponents__c)
    };
    return {
      summary: `[${row.name}] ${row.title || ""}`.slice(0, 250),
      priority: JIRA_PRIORITIES[row.severity] || "Medium",
      labels: jiraLabels(row),
      description: jiraDescription(row, detail)
    };
  });
  const labelColumns = Math.max(1, ...items.map((item) => item.labels.length));
  const header = [
    "Summary",
    "Issue Type",
    "Priority",
    "Description",
    ...Array(labelColumns).fill("Labels")
  ];
  const lines = [header.map(csvCell).join(",")];
  items.forEach((item) => {
    const labels = [...item.labels];
    while (labels.length < labelColumns) {
      labels.push("");
    }
    lines.push(
      [item.summary, issueType, item.priority, item.description, ...labels]
        .map(csvCell)
        .join(",")
    );
  });
  return lines.join("\r\n");
}

/** Recommandations locales correspondant à des identifiants de lignes. */
export async function loadLocalByIds(ids) {
  const byFingerprint = await loadLocalRecommendations();
  return (ids || []).map((id) => findLocal(byFingerprint, id)).filter(Boolean);
}
