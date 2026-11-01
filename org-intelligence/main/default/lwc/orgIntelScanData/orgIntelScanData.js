/**
 * Données des scans gardés dans le navigateur (édition sans objet personnalisé) : lecture du
 * stockage, et fonctions pures qui en dérivent les vues (résumé, score, constats, composants,
 * comparaison, Automation, Storage) et les recommandations.
 *
 * Forme d'un scan (renvoyé assemblé par loadLatestScan) :
 * { id, name, status, scope[], startedAt, completedAt, toolingAvailable, healthScore,
 *   log[{step, level, message, loggedAt}], components[{key, componentType, apiName, parentName,
 *   metadataId, namespacePrefix, apiVersion, isActive, description, lastModifiedDate,
 *   lastModifiedByName, details{}, dependencies{uses[], usedBy[]}}], findings[{fingerprint, ruleCode,
 *   componentType, componentName, componentKey, title, description, evidence, affectedComponents[],
 *   severity, category, confidence, domain, isNew}], evaluatedRules[], reliableRules[],
 *   failedSteps[], storage{dataUsedMb, dataMaxMb, fileUsedMb, fileMaxMb, snapshot},
 *   recommendationLinks{fingerprint: {id, name, status}}, ignoredFingerprints[], scoreConfig,
 *   recommendationsError, inventoryKept (true | false | "partial"), compacted (0 à 3),
 *   droppedComponentTypes[], componentTotal, storageWarnings[] }
 *
 * Stockage (format 2) : le scan est découpé pour tenir dans le quota du navigateur — en-tête
 * `scan.latest` (sans composants ni constats, avec `parts`), constats `scan.parts.<id>.findings`,
 * composants par type `scan.parts.<id>.components.<Type>`, logigrammes des flows
 * `scan.parts.<id>.flowModels`. Chaque partie trop grosse est allégée, puis abandonnée (le scan
 * l'indique par `inventoryKept` / `compacted` / `droppedComponentTypes` et un avertissement dans son
 * journal, ajouté avant l'écriture). L'ancien format (tout dans `scan.latest`) reste lisible.
 * Seul un scan terminé devient le dernier scan ; un scan en échec va dans `scan.lastFailed`.
 * Historique (STORE_KEYS.SCAN_HISTORY) : résumés (summarizeScan), du plus récent au plus ancien.
 * Empreintes des 10 derniers scans terminés : `scan.findingSnapshots`.
 *
 * Exports ajoutés (2026-11-02) :
 * - loadLatestScanHeader() : en-tête seul (léger : statut, score, compteurs, journal).
 * - saveLatestScan(scan) → { inventoryKept, compacted, droppedComponentTypes, warnings }.
 * - saveFailedScan(scan), loadLastFailedScan().
 * - loadFindingSnapshots() → [{ scanId, scanName, completedAt, scope, rules, findings:[{fingerprint,
 *   ruleCode, title, severity}] }], plus récent d'abord ; addFindingSnapshot(scan).
 * - compareFindings(currentFindings, otherFindings) → { added, removed, unchanged }.
 * - markNewFindings(findings, reference) : isNew contre un instantané, sur les règles évaluées
 *   dans les deux scans.
 * - currentScore(scan, scoreConfig, ignoredFingerprints) : score unique utilisé partout (scan
 *   complet, ou résumé d'historique grâce à `breakdown`).
 * - importScan(scan, { makeLatest }) → { madeLatest, summary } (makeLatest omis : le plus récent
 *   gagne ; false : seuls le résumé et l'empreinte rejoignent l'historique).
 * - summarizeScan : `domainCounts`, `breakdown`, `recommendationsError`, `inventoryKept`.
 */
import {
  loadValue,
  loadValueStrict,
  saveValue,
  removeValue,
  listKeys,
  STORE_KEYS,
  StoreError
} from "c/orgIntelStore";

export const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Info"];
export const FINISHED_STATUSES = ["Completed", "Completed with errors"];
export const PREVIOUS_FINDINGS_KEY = "scan.previousFindings";
export const PREVIOUS_STORAGE_KEY = "scan.previousStorage";
export const LAST_FAILED_KEY = "scan.lastFailed";
export const SNAPSHOTS_KEY = "scan.findingSnapshots";
export const SCAN_PARTS_PREFIX = "scan.parts.";
export const HISTORY_MAX = 30;
export const SNAPSHOT_MAX = 10;
const SCAN_STORAGE_FORMAT = 2;
const COMPONENT_PAGE = 500;
const SNAPSHOT_TITLE_MAX = 120;
const FINDING_TEXT_MAX = 2000;

// ---------- Lecture ----------

/** En-tête du dernier scan (sans composants ni constats pour le format 2). */
export async function loadLatestScanHeader() {
  return loadValue(STORE_KEYS.LATEST_SCAN, null);
}

/** Dernier scan terminé, assemblé (composants, constats, logigrammes). */
export async function loadLatestScan() {
  const header = await loadValue(STORE_KEYS.LATEST_SCAN, null);
  return assembleScan(header);
}

async function assembleScan(header) {
  if (
    !header ||
    header.storageFormat !== SCAN_STORAGE_FORMAT ||
    !header.parts
  ) {
    return header; // ancien format : tout est dans l'en-tête
  }
  const scan = { ...header };
  const parts = header.parts;
  delete scan.parts;
  const findings = parts.findings
    ? await loadValue(parts.findings, null)
    : null;
  scan.findings = Array.isArray(findings) ? findings : [];
  if (parts.findings && !Array.isArray(findings)) {
    scan.findingsMissing = true;
  }
  const components = [];
  let missing = false;
  const componentParts = Object.entries(parts.components || {});
  for (const [, key] of componentParts) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await loadValue(key, null);
    if (Array.isArray(rows)) {
      components.push(...rows);
    } else {
      missing = true;
    }
  }
  if (parts.flowModels) {
    const models = await loadValue(parts.flowModels, null);
    if (models && typeof models === "object") {
      components.forEach((component, index) => {
        const model = models[component.key];
        if (model) {
          components[index] = {
            ...component,
            details: { ...(component.details || {}), model }
          };
        }
      });
    } else {
      missing = true;
    }
  }
  scan.components = components;
  if (missing && scan.inventoryKept === true) {
    scan.inventoryKept = "partial";
  }
  return scan;
}

export async function loadScanHistory() {
  return (await loadValue(STORE_KEYS.SCAN_HISTORY, [])) || [];
}

/**
 * Constats du scan terminé qui précède le dernier scan (même forme que minimalFindings), tirés des
 * empreintes gardées ; repli sur l'ancienne clé.
 */
export async function loadPreviousFindings() {
  const [snapshots, header] = await Promise.all([
    loadFindingSnapshots(),
    loadLatestScanHeader()
  ]);
  if (header && snapshots.length) {
    const latestTime = String(header.completedAt || header.startedAt || "");
    const previous = snapshots.find(
      (snapshot) =>
        snapshot.scanId !== header.id &&
        (!latestTime || String(snapshot.completedAt || "") < latestTime)
    );
    if (previous) {
      return previous;
    }
  }
  return loadValue(PREVIOUS_FINDINGS_KEY, null);
}

export async function loadPreviousStorage() {
  return loadValue(PREVIOUS_STORAGE_KEY, null);
}

export async function loadLastFailedScan() {
  return loadValue(LAST_FAILED_KEY, null);
}

export function isFinished(status) {
  return FINISHED_STATUSES.includes(status);
}

// ---------- Écriture du dernier scan ----------

function partKey(scanId, suffix) {
  return `${SCAN_PARTS_PREFIX}${scanId}.${suffix}`;
}

function approximateSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function withoutModel(component) {
  if (!component.details || !component.details.model) {
    return component;
  }
  const details = { ...component.details };
  delete details.model;
  return { ...component, details };
}

function slimModel(model) {
  const copy = { ...model };
  delete copy.nodes;
  delete copy.edges;
  delete copy.inputs;
  delete copy.outputs;
  return copy;
}

function truncateText(value) {
  return typeof value === "string" && value.length > FINDING_TEXT_MAX
    ? `${value.substring(0, FINDING_TEXT_MAX)}…`
    : value;
}

/** Variantes de plus en plus légères d'une partie (la première qui tient est gardée). */
function componentVariants(rows) {
  return [
    () => rows,
    () =>
      rows.map((component) => {
        const { dependencies, ...rest } = component; // eslint-disable-line no-unused-vars
        return { ...rest, details: slimComponent(component).details };
      }),
    () =>
      rows.map((component) => {
        const { details, dependencies, ...rest } = component; // eslint-disable-line no-unused-vars
        return rest;
      })
  ];
}

async function deleteParts(predicate) {
  const keys = await listKeys(SCAN_PARTS_PREFIX);
  for (const key of keys) {
    if (predicate(key)) {
      // eslint-disable-next-line no-await-in-loop
      await removeValue(key);
    }
  }
}

/**
 * Garde le scan comme dernier scan, découpé en parties. Les constats doivent tenir (sinon
 * StoreError, l'ancien dernier scan reste en place) ; les composants et logigrammes sont allégés
 * puis abandonnés si le quota ne suffit pas. Les avertissements sont ajoutés au journal du scan
 * avant l'écriture de l'en-tête.
 */
export async function saveLatestScan(scan) {
  const id = scan.id;
  const all = scan.components || [];
  const warnings = [];
  const parts = {
    findings: partKey(id, "findings"),
    components: {},
    flowModels: null
  };
  let compacted = 0;
  const dropped = [];
  let freedOld = false;
  const isOldPart = (key) => !key.startsWith(`${SCAN_PARTS_PREFIX}${id}.`);

  // Libère les parties de l'ancien scan au premier manque de place (après les constats)
  const tryWrite = async (key, variants) => {
    for (let level = 0; level < variants.length; level++) {
      const value = variants[level]();
      try {
        // eslint-disable-next-line no-await-in-loop
        await saveValue(key, value);
        return level;
      } catch (error) {
        if (!(error instanceof StoreError) || error.reason !== "quota") {
          throw error;
        }
        if (!freedOld) {
          freedOld = true;
          // eslint-disable-next-line no-await-in-loop
          await deleteParts(isOldPart);
          level--; // même variante, une seconde fois
        }
      }
    }
    return -1;
  };

  // 1. Constats (indispensables)
  const findings = scan.findings || [];
  const findingsLevel = await tryWrite(parts.findings, [
    () => findings,
    () =>
      findings.map((finding) => ({
        ...finding,
        description: truncateText(finding.description),
        evidence: truncateText(finding.evidence)
      }))
  ]);
  if (findingsLevel < 0) {
    throw new StoreError(
      "Your browser storage is full: the findings of this scan could not be kept. Export your data, then clear older results in Settings.",
      "quota"
    );
  }
  if (findingsLevel > 0) {
    warnings.push(
      "Browser storage is almost full: long finding texts were shortened."
    );
  }

  // 2. Composants par type et logigrammes des flows, du plus petit au plus gros
  const byType = new Map();
  const models = {};
  all.forEach((component) => {
    if (component.details && component.details.model) {
      models[component.key] = component.details.model;
    }
    const rows = byType.get(component.componentType) || [];
    rows.push(withoutModel(component));
    byType.set(component.componentType, rows);
  });
  const tasks = [...byType.entries()].map(([type, rows]) => ({
    type,
    key: partKey(id, `components.${type}`),
    size: approximateSize(rows),
    variants: componentVariants(rows)
  }));
  if (Object.keys(models).length) {
    tasks.push({
      type: "flowModels",
      key: partKey(id, "flowModels"),
      size: approximateSize(models),
      variants: [
        () => models,
        () => {
          const slim = {};
          Object.entries(models).forEach(([key, model]) => {
            slim[key] = slimModel(model);
          });
          return slim;
        }
      ]
    });
  }
  tasks.sort((a, b) => a.size - b.size);
  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop
    const level = await tryWrite(task.key, task.variants);
    if (level < 0) {
      dropped.push(task.type);
      continue;
    }
    compacted = Math.max(compacted, level);
    if (task.type === "flowModels") {
      parts.flowModels = task.key;
    } else {
      parts.components[task.type] = task.key;
    }
  }
  const keptTypes = Object.keys(parts.components).length;
  let inventoryKept = true;
  if (dropped.length) {
    inventoryKept = keptTypes === 0 && byType.size > 0 ? false : "partial";
    compacted = keptTypes === 0 && byType.size > 0 ? 3 : Math.max(compacted, 2);
    warnings.push(
      inventoryKept === false
        ? "Browser storage is full: the component inventory of this scan was not kept."
        : `Browser storage is full: part of the inventory was not kept (${dropped.join(", ")}).`
    );
  } else if (compacted > 0) {
    warnings.push(
      "Browser storage is almost full: part of the component details was not kept."
    );
  }

  // 3. En-tête (journal avec les avertissements), puis nettoyage des anciennes parties
  const loggedAt = new Date().toISOString();
  const log = [
    ...(scan.log || []),
    ...warnings.map((message) => ({
      step: "Scan",
      level: "warning",
      message,
      loggedAt
    }))
  ];
  const header = { ...scan, log };
  delete header.components;
  delete header.findings;
  delete header.rules;
  Object.assign(header, {
    storageFormat: SCAN_STORAGE_FORMAT,
    parts,
    inventoryKept,
    compacted,
    droppedComponentTypes: dropped,
    storageWarnings: warnings,
    componentTotal: all.length,
    findingCount: findings.length,
    componentCounts: componentCounts(all)
  });
  await saveValue(STORE_KEYS.LATEST_SCAN, header);
  scan.log = log;
  scan.inventoryKept = inventoryKept;
  scan.compacted = compacted;
  scan.droppedComponentTypes = dropped;
  scan.storageWarnings = warnings;
  scan.componentTotal = all.length;
  await deleteParts(isOldPart).catch(() => {});
  return { inventoryKept, compacted, droppedComponentTypes: dropped, warnings };
}

/** Scan non terminé (échec, arrêt) : gardé à part, sans inventaire, sans toucher au dernier scan. */
export async function saveFailedScan(scan) {
  const header = { ...scan };
  delete header.components;
  delete header.rules;
  header.findingCount = (scan.findings || []).length;
  header.componentTotal = (scan.components || []).length;
  header.findings = [];
  await saveValue(LAST_FAILED_KEY, header);
}

// ---------- Empreintes des derniers scans ----------

/** Empreintes des derniers scans terminés, du plus récent au plus ancien. */
export async function loadFindingSnapshots() {
  const value = await loadValue(SNAPSHOTS_KEY, []);
  return Array.isArray(value) ? value : [];
}

export function findingSnapshot(scan) {
  return {
    scanId: scan.id,
    scanName: scan.name,
    completedAt: scan.completedAt,
    scope: scan.scope || [],
    rules: scan.reliableRules || scan.evaluatedRules || [],
    findings: (scan.findings || []).map((finding) => ({
      fingerprint: finding.fingerprint,
      ruleCode: finding.ruleCode,
      title:
        finding.title && finding.title.length > SNAPSHOT_TITLE_MAX
          ? `${finding.title.substring(0, SNAPSHOT_TITLE_MAX)}…`
          : finding.title,
      severity: finding.severity
    }))
  };
}

/**
 * Ajoute l'empreinte d'un scan terminé (remplace celle du même scan, tri par date de fin) ; retire
 * les plus anciennes si le stockage est plein. Lecture stricte : rien n'est écrasé après un échec.
 */
export async function addFindingSnapshot(scan) {
  const loaded = await loadValueStrict(SNAPSHOTS_KEY, []);
  let list = [
    findingSnapshot(scan),
    ...(Array.isArray(loaded) ? loaded : []).filter((s) => s.scanId !== scan.id)
  ]
    .sort((a, b) =>
      String(b.completedAt || "").localeCompare(String(a.completedAt || ""))
    )
    .slice(0, SNAPSHOT_MAX);
  while (list.length) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await saveValue(SNAPSHOTS_KEY, list);
      return list;
    } catch (error) {
      if (
        !(error instanceof StoreError) ||
        error.reason !== "quota" ||
        list.length === 1
      ) {
        throw error;
      }
      list = list.slice(0, list.length - 1);
    }
  }
  return list;
}

function findingsOf(value) {
  return Array.isArray(value) ? value : (value && value.findings) || [];
}

/** Comparaison par empreinte : constats ajoutés, disparus et inchangés. */
export function compareFindings(currentFindings, otherFindings) {
  const current = findingsOf(currentFindings);
  const other = findingsOf(otherFindings);
  const otherSet = new Set(other.map((f) => f.fingerprint));
  const currentSet = new Set(current.map((f) => f.fingerprint));
  return {
    added: current.filter((f) => !otherSet.has(f.fingerprint)),
    removed: other.filter((f) => !currentSet.has(f.fingerprint)),
    unchanged: current.filter((f) => otherSet.has(f.fingerprint))
  };
}

/**
 * Marque `isNew` par rapport à un scan de référence (instantané) : seulement pour les règles
 * évaluées dans les deux scans. Sans référence, rien n'est nouveau.
 */
export function markNewFindings(findings, reference) {
  const known = new Set(findingsOf(reference).map((f) => f.fingerprint));
  const rules =
    reference && Array.isArray(reference.rules) && reference.rules.length
      ? new Set(reference.rules)
      : null;
  (findings || []).forEach((finding) => {
    finding.isNew = Boolean(
      reference &&
      (!rules || rules.has(finding.ruleCode)) &&
      !known.has(finding.fingerprint)
    );
  });
  return findings;
}

// ---------- Score ----------

/** Domaine d'une règle d'après son préfixe (même convention qu'OrgHealthScore.domainOf). */
export function domainOf(ruleCode) {
  const code = ruleCode || "";
  if (code.startsWith("APEX_") || code.startsWith("TRIGGER_")) {
    return "Apex";
  }
  if (code.startsWith("FLOW_") || code.startsWith("AUTOMATION_")) {
    return "Flows & Automation";
  }
  if (code.startsWith("OBJECT_") || code.startsWith("FIELD_")) {
    return "Data Model";
  }
  if (code.startsWith("VR_")) {
    return "Data Quality";
  }
  if (code.startsWith("STORAGE_")) {
    return "Storage";
  }
  return "Other";
}

/** Constats regroupés par règle (aperçu des réglages du score). */
export function scoreBreakdown(findings, ignoredFingerprints = []) {
  const ignored = new Set(ignoredFingerprints || []);
  const byRule = new Map();
  (findings || []).forEach((finding) => {
    let rule = byRule.get(finding.ruleCode);
    if (!rule) {
      rule = {
        ruleCode: finding.ruleCode,
        severity: finding.severity,
        domain: finding.domain || domainOf(finding.ruleCode),
        count: 0,
        ignoredCount: 0
      };
      byRule.set(finding.ruleCode, rule);
    }
    rule.count++;
    if (ignored.has(finding.fingerprint)) {
      rule.ignoredCount++;
    }
  });
  return [...byRule.values()];
}

/**
 * 100 − Σ par règle de min(plafond de sa gravité, points × constats), plancher 0, arrondi au dixième.
 * Même calcul qu'auparavant côté serveur (OrgHealthScore).
 */
export function scoreFromBreakdown(rules, config) {
  if (!config) {
    return null;
  }
  const domains = new Set(config.domains || []);
  let total = 0;
  (rules || []).forEach((rule) => {
    if (!domains.has(rule.domain) && rule.domain !== "Other") {
      return;
    }
    const counted = config.excludeIgnored
      ? rule.count - rule.ignoredCount
      : rule.count;
    const points = config.points ? config.points[rule.severity] : null;
    const cap = config.caps ? config.caps[rule.severity] : null;
    if (points === null || points === undefined || counted <= 0) {
      return;
    }
    const penalty = points * counted;
    total +=
      cap === null || cap === undefined ? penalty : Math.min(penalty, cap);
  });
  return Math.round(Math.max(0, 100 - total) * 10) / 10;
}

export function computeHealthScore(findings, config, ignoredFingerprints = []) {
  return scoreFromBreakdown(
    scoreBreakdown(findings, ignoredFingerprints),
    config
  );
}

/**
 * Score d'un scan avec les réglages et les recommandations ignorées du moment : fonction unique
 * pour l'Overview, le détail d'un scan, l'historique et Reports.
 * - scan complet (constats) : recalcul avec `ignoredFingerprints` (à défaut, ceux du scan) ;
 * - résumé d'historique : recalcul depuis `breakdown` (ignorés comptés au moment du scan) ;
 * - sinon, ou sans réglages : score enregistré.
 */
export function currentScore(scan, scoreConfig, ignoredFingerprints) {
  if (!scan) {
    return null;
  }
  const config = scoreConfig || scan.scoreConfig;
  const stored = scan.healthScore === undefined ? null : scan.healthScore;
  if (!config) {
    return stored;
  }
  if (Array.isArray(scan.findings) && !scan.findingsMissing) {
    const ignored = Array.isArray(ignoredFingerprints)
      ? ignoredFingerprints
      : scan.ignoredFingerprints || [];
    return computeHealthScore(scan.findings, config, ignored);
  }
  if (Array.isArray(scan.breakdown)) {
    return scoreFromBreakdown(scan.breakdown, config);
  }
  return stored;
}

/** Nombre de constats par domaine. */
export function domainCounts(findings) {
  const counts = {};
  (findings || []).forEach((finding) => {
    const domain = finding.domain || domainOf(finding.ruleCode);
    counts[domain] = (counts[domain] || 0) + 1;
  });
  return counts;
}

// ---------- Résumés ----------

export function severityCounts(findings) {
  const counts = {};
  SEVERITY_ORDER.forEach((severity) => {
    counts[severity] = 0;
  });
  (findings || []).forEach((finding) => {
    if (counts[finding.severity] !== undefined) {
      counts[finding.severity]++;
    }
  });
  return counts;
}

/** Liste { severity, count } dans l'ordre d'affichage. */
export function severityCountList(findings) {
  const counts = severityCounts(findings);
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    count: counts[severity]
  }));
}

export function componentCounts(components) {
  const counts = new Map();
  (components || []).forEach((component) => {
    counts.set(
      component.componentType,
      (counts.get(component.componentType) || 0) + 1
    );
  });
  return [...counts.entries()]
    .map(([componentType, count]) => ({ componentType, count }))
    .sort((a, b) => a.componentType.localeCompare(b.componentType));
}

export function errorCount(log) {
  return (log || []).filter((entry) => entry.level === "error").length;
}

/** Résumé d'un scan : même forme que l'ancien ScanSummary (champs id, name, status…). */
export function summarizeScan(scan) {
  if (!scan) {
    return null;
  }
  const counts = severityCounts(scan.findings);
  const hasFindings = Array.isArray(scan.findings) && !scan.findingsMissing;
  const hasComponents =
    Array.isArray(scan.components) && scan.components.length > 0;
  return {
    id: scan.id,
    name: scan.name,
    status: scan.status,
    scope: scan.scope || [],
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    createdDate: scan.startedAt,
    componentCount:
      scan.componentTotal !== undefined && scan.componentTotal !== null
        ? scan.componentTotal
        : (scan.components || []).length,
    findingCount: hasFindings ? scan.findings.length : scan.findingCount || 0,
    collectionErrorCount: errorCount(scan.log),
    healthScore: scan.healthScore,
    toolingApiAvailable: scan.toolingAvailable === true,
    progress: scan.progress === undefined ? 100 : scan.progress,
    currentStep: scan.currentStep || null,
    critical: counts.Critical,
    high: counts.High,
    medium: counts.Medium,
    low: counts.Low,
    info: counts.Info,
    componentCounts:
      !hasComponents && Array.isArray(scan.componentCounts)
        ? scan.componentCounts
        : componentCounts(scan.components),
    domainCounts: hasFindings
      ? domainCounts(scan.findings)
      : scan.domainCounts || {},
    breakdown: hasFindings
      ? scoreBreakdown(scan.findings, scan.ignoredFingerprints)
      : scan.breakdown || null,
    recommendationsError: scan.recommendationsError || null,
    inventoryKept: scan.inventoryKept === undefined ? true : scan.inventoryKept,
    compacted: scan.compacted || 0,
    failedSteps: scan.failedSteps || [],
    storage: scan.storage
      ? {
          dataUsedMb: scan.storage.dataUsedMb,
          fileUsedMb: scan.storage.fileUsedMb,
          dataMaxMb: scan.storage.dataMaxMb,
          fileMaxMb: scan.storage.fileMaxMb
        }
      : null
  };
}

// ---------- Constats et composants ----------

/** Lignes de constats (même forme que l'ancien FindingRow ; id = empreinte). */
export function findingRows(scan) {
  const links = (scan && scan.recommendationLinks) || {};
  return ((scan && scan.findings) || []).map((finding, index) => {
    const link = links[finding.fingerprint];
    return {
      id: finding.fingerprint,
      name: `F-${String(index + 1).padStart(4, "0")}`,
      ruleCode: finding.ruleCode,
      title: finding.title,
      description: finding.description,
      evidence: finding.evidence,
      affectedComponents: (finding.affectedComponents || []).join("\n"),
      severity: finding.severity,
      category: finding.category,
      confidence: finding.confidence,
      domain: finding.domain || domainOf(finding.ruleCode),
      componentType: finding.componentType,
      componentName: finding.componentName,
      isNew: finding.isNew === true,
      recommendationId: link ? link.id : null,
      recommendationName: link ? link.name : null,
      recommendationStatus: link ? link.status : null
    };
  });
}

/** Constats dont la règle commence par un des préfixes. */
export function findingsWithPrefix(scan, prefixes) {
  return findingRows(scan).filter((row) =>
    prefixes.some((prefix) => (row.ruleCode || "").startsWith(prefix))
  );
}

/** Page de composants filtrée (même forme que l'ancien ComponentPage). */
export function filterComponents(
  scan,
  componentType,
  searchTerm,
  limit = COMPONENT_PAGE
) {
  const term = (searchTerm || "").trim().toLowerCase();
  const matches = ((scan && scan.components) || []).filter((component) => {
    if (componentType && component.componentType !== componentType) {
      return false;
    }
    if (!term) {
      return true;
    }
    return (
      (component.apiName || "").toLowerCase().includes(term) ||
      (component.parentName || "").toLowerCase().includes(term)
    );
  });
  matches.sort(
    (a, b) =>
      (a.componentType || "").localeCompare(b.componentType || "") ||
      (a.apiName || "").localeCompare(b.apiName || "")
  );
  return {
    total: matches.length,
    rows: matches.slice(0, limit).map((component) => ({
      id: component.key,
      apiName: component.apiName,
      componentType: component.componentType,
      parentName: component.parentName,
      apiVersion: component.apiVersion,
      isActive: component.isActive,
      lastModified: component.lastModifiedDate,
      lastModifiedBy: component.lastModifiedByName,
      description: component.description,
      dependencyCount:
        component.dependencies && component.dependencies.uses
          ? component.dependencies.uses.length
          : null
    }))
  };
}

/** Constats minimaux gardés pour comparer le scan suivant. */
export function minimalFindings(scan) {
  return {
    scanId: scan.id,
    scanName: scan.name,
    completedAt: scan.completedAt,
    findings: (scan.findings || []).map((finding) => ({
      fingerprint: finding.fingerprint,
      ruleCode: finding.ruleCode,
      title: finding.title,
      severity: finding.severity
    }))
  };
}

/** Évolution depuis le scan précédent : constats nouveaux et disparus. */
export function compareWithPrevious(scan, previous) {
  const result = {
    newFindingCount: ((scan && scan.findings) || []).filter((f) => f.isNew)
      .length,
    disappearedCount: 0,
    disappeared: [],
    previousScanId: null,
    previousScanName: null
  };
  if (!scan || !previous || previous.scanId === scan.id) {
    return result;
  }
  result.previousScanId = previous.scanId;
  result.previousScanName = previous.scanName;
  const current = new Set((scan.findings || []).map((f) => f.fingerprint));
  const gone = (previous.findings || [])
    .filter((f) => !current.has(f.fingerprint))
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );
  result.disappearedCount = gone.length;
  result.disappeared = gone
    .slice(0, 50)
    .map((f) => `[${f.severity}] ${f.title}`);
  return result;
}

// ---------- Automation ----------

function eventsOf(triggerEvent) {
  switch (triggerEvent) {
    case "Create":
      return ["Create"];
    case "Update":
      return ["Update"];
    case "CreateAndUpdate":
      return ["Create", "Update"];
    case "Delete":
      return ["Delete"];
    default:
      return [];
  }
}

/** Automatisations du scan (même forme que l'ancien OrgAutomationGraph.Automation). */
export function buildAutomations(components) {
  const result = [];
  (components || [])
    .filter((component) =>
      ["Flow", "ApexTrigger", "ValidationRule"].includes(
        component.componentType
      )
    )
    .sort((a, b) => (a.apiName || "").localeCompare(b.apiName || ""))
    .forEach((component) => {
      const details = component.details || {};
      const automation = {
        id: component.key,
        apiName: component.apiName,
        isActive: component.isActive,
        apiVersion: component.apiVersion,
        description: component.description,
        metadataId: component.metadataId,
        objectName: component.parentName,
        events: [],
        model: null,
        modelJson: null
      };
      if (component.componentType === "ApexTrigger") {
        automation.kind = "Apex trigger";
        automation.label = component.apiName;
        automation.events = Array.isArray(details.events)
          ? [...details.events]
          : [];
        automation.timing = "Trigger";
      } else if (component.componentType === "ValidationRule") {
        automation.kind = "Validation rule";
        automation.label = (component.apiName || "")
          .split(".")
          .slice(1)
          .join(".");
        automation.timing = "Validation";
        automation.events = ["Create", "Update"];
      } else {
        automation.label = details.label;
        automation.modelOmitted = details.modelOmitted === true;
        automation.versionId =
          details.analysedVersionId || details.activeVersionId;
        if (details.model) {
          automation.model = details.model;
          automation.modelJson = JSON.stringify(details.model);
          automation.objectName =
            details.model.triggerObject || automation.objectName;
          automation.timing = details.model.timing;
          automation.events = eventsOf(details.model.triggerEvent);
        } else {
          automation.timing =
            details.processType === "Workflow"
              ? "Process Builder"
              : details.triggerType;
        }
        automation.kind =
          details.processType === "Workflow" ? "Process Builder" : "Flow";
      }
      result.push(automation);
    });
  return result;
}

const MAX_CYCLE_LENGTH = 6;

/**
 * Cycles entre objets : arête A → B quand une automatisation active déclenchée sur A écrit B
 * (même calcul qu'OrgAutomationGraph.findCycles).
 */
export function findCycles(automations) {
  const edges = new Map();
  (automations || []).forEach((automation) => {
    if (
      !automation.model ||
      automation.isActive !== true ||
      !automation.objectName
    ) {
      return;
    }
    (automation.model.writes || []).forEach((access) => {
      if (!access.objectName || access.operation === "Delete") {
        return;
      }
      if (access.objectName === automation.objectName) {
        return;
      }
      if (!edges.has(automation.objectName)) {
        edges.set(automation.objectName, new Map());
      }
      const targets = edges.get(automation.objectName);
      if (!targets.has(access.objectName)) {
        targets.set(access.objectName, new Set());
      }
      targets.get(access.objectName).add(automation.apiName);
    });
  });
  const cycles = new Map();
  const visited = new Set();
  const walk = (origin, current, path, excluded) => {
    if (path.length > MAX_CYCLE_LENGTH || !edges.has(current)) {
      return;
    }
    edges.get(current).forEach((via, next) => {
      if (next === origin && path.length > 1) {
        const key = [...path].sort().join(">");
        if (!cycles.has(key)) {
          const automationsOnPath = new Set();
          path.forEach((fromObject, k) => {
            const toObject = k + 1 < path.length ? path[k + 1] : origin;
            edges
              .get(fromObject)
              .get(toObject)
              .forEach((name) => automationsOnPath.add(name));
          });
          cycles.set(key, {
            key,
            objects: [...path],
            automations: [...automationsOnPath].sort(),
            label: `${path.join(" → ")} → ${origin}`
          });
        }
      } else if (!path.includes(next) && !excluded.has(next)) {
        walk(origin, next, [...path, next], excluded);
      }
    });
  };
  [...edges.keys()].sort().forEach((node) => {
    walk(node, node, [node], new Set(visited));
    visited.add(node);
  });
  return [...cycles.values()];
}

/**
 * Vue Automation à partir du dernier scan ayant inventorié les flows (même forme que l'ancien
 * AutomationView, sans les erreurs d'exécution lues en direct par le serveur).
 */
export function buildAutomationView(scan) {
  const view = {
    scanId: null,
    scanName: null,
    scanCompletedAt: null,
    flowLogicAnalysed: false,
    automations: [],
    cycles: [],
    findings: []
  };
  if (!scan || !(scan.scope || []).includes("Flow")) {
    return view;
  }
  view.scanId = scan.id;
  view.scanName = scan.name;
  view.scanCompletedAt = scan.completedAt;
  view.automations = buildAutomations(scan.components).filter(
    (automation) => automation.kind !== "Validation rule"
  );
  view.flowLogicAnalysed = view.automations.some(
    (automation) => automation.model
  );
  view.cycles = findCycles(view.automations);
  view.findings = findingsWithPrefix(scan, [
    "FLOW_",
    "AUTOMATION_",
    "TRIGGER_"
  ]).sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
  return view;
}

// ---------- Storage ----------

/**
 * Vue Storage : photographie du dernier scan avec stockage, précédente photographie, tendance
 * (historique) et constats STORAGE_* (même forme que l'ancien StorageView, hors limites en direct).
 */
export function buildStorageView(scan, previousStorage, history) {
  const view = {
    scanId: null,
    scanName: null,
    scanCompletedAt: null,
    snapshotJson: null,
    previousScanName: null,
    previousSnapshotJson: null,
    trend: [],
    findings: []
  };
  view.trend = (history || [])
    .filter((entry) => entry.storage && entry.storage.dataUsedMb !== undefined)
    .slice(0, 12)
    .reverse()
    .map((entry) => ({
      scanId: entry.id,
      scanName: entry.name,
      completedAt: entry.completedAt,
      dataUsedMb: entry.storage.dataUsedMb,
      fileUsedMb: entry.storage.fileUsedMb
    }));
  if (scan && scan.storage && scan.storage.snapshot) {
    view.scanId = scan.id;
    view.scanName = scan.name;
    view.scanCompletedAt = scan.completedAt;
    view.snapshotJson = JSON.stringify(scan.storage.snapshot);
    view.findings = findingsWithPrefix(scan, ["STORAGE"]);
  }
  if (previousStorage && previousStorage.snapshot) {
    view.previousScanName = previousStorage.scanName;
    view.previousSnapshotJson = JSON.stringify(previousStorage.snapshot);
  }
  return view;
}

// ---------- Recommandations ----------

/** Recommandation (champs d'OrgRecommendation__c) issue d'un constat de scan. */
export function findingToRecommendation(finding, rule, scanName, detectedAt) {
  let justification = (rule && rule.rationale) || "";
  if (finding.evidence) {
    justification += `${justification ? "\n\n" : ""}Evidence:\n${finding.evidence}`;
  }
  const affected = (finding.affectedComponents || []).join("\n");
  return {
    Fingerprint__c: finding.fingerprint,
    RuleCode__c: finding.ruleCode,
    Title__c: finding.title,
    Description__c: finding.description,
    Justification__c: justification || null,
    SuggestedAction__c: (rule && rule.suggestedAction) || null,
    Category__c: finding.category,
    Confidence__c: finding.confidence,
    Severity__c: finding.severity,
    ComponentType__c: finding.componentType,
    ComponentName__c: finding.componentName,
    AffectedComponents__c: affected || finding.componentName,
    LastDetectedAt__c: detectedAt,
    LastScanName__c: scanName,
    StillDetected__c: true
  };
}

/** Composant allégé renvoyé au serveur pour les étapes qui ont besoin de l'inventaire. */
export function slimComponent(component) {
  const details = { ...(component.details || {}) };
  if (details.model) {
    const model = { ...details.model };
    delete model.nodes;
    delete model.edges;
    delete model.inputs;
    delete model.outputs;
    details.model = model;
  }
  return {
    componentType: component.componentType,
    apiName: component.apiName,
    parentName: component.parentName,
    metadataId: component.metadataId,
    namespacePrefix: component.namespacePrefix,
    apiVersion: component.apiVersion,
    isActive: component.isActive,
    description: component.description,
    details
  };
}

/** Scan allégé si le stockage du navigateur est plein (logigrammes, puis détails retirés). */
export function compactScan(scan, level) {
  const copy = { ...scan };
  copy.components = (scan.components || []).map((component) => {
    if (level >= 2) {
      const { details, dependencies, ...rest } = component; // eslint-disable-line no-unused-vars
      return rest;
    }
    const slim = slimComponent(component);
    return { ...component, details: slim.details };
  });
  copy.compacted = level;
  return copy;
}

// ---------- Import ----------

/**
 * Importe un scan (fichier) : `makeLatest` true le garde comme dernier scan (détail complet),
 * false n'ajoute que son résumé à l'historique et son empreinte (comparaisons) ; omis, le plus
 * récent gagne (il ne devient le dernier scan que s'il est plus récent que celui en place).
 */
export async function importScan(scan, { makeLatest } = {}) {
  if (!scan || typeof scan.id !== "string" || !Array.isArray(scan.findings)) {
    throw new Error("This file does not contain an Org Intelligence scan.");
  }
  const copy = { ...scan, components: scan.components || [] };
  if (!copy.status) {
    copy.status = "Completed";
  }
  const header = await loadLatestScanHeader();
  const time = (value) =>
    String((value && (value.completedAt || value.startedAt)) || "");
  let madeLatest = makeLatest;
  if (madeLatest === undefined || madeLatest === null) {
    madeLatest = !header || header.id === copy.id || time(copy) >= time(header);
  }
  if (madeLatest && !isFinished(copy.status)) {
    throw new Error("Only a finished scan can become the latest scan.");
  }
  if (madeLatest) {
    await saveLatestScan(copy);
  }
  const summary = summarizeScan(copy);
  const history = await loadValueStrict(STORE_KEYS.SCAN_HISTORY, []);
  const merged = [
    summary,
    ...(Array.isArray(history) ? history : []).filter(
      (row) => row.id !== copy.id
    )
  ]
    .sort((a, b) =>
      String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
    )
    .slice(0, HISTORY_MAX);
  await saveValue(STORE_KEYS.SCAN_HISTORY, merged);
  if (isFinished(copy.status)) {
    await addFindingSnapshot(copy).catch(() => {});
  }
  return { madeLatest: Boolean(madeLatest), summary };
}
