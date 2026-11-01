/**
 * Moteur de scan de l'édition sans objet : le navigateur enchaîne les étapes (une page d'étape par
 * appel Apex synchrone, OrgIntelligenceController.runScanStep), cumule composants et constats,
 * synchronise les recommandations, calcule le score et garde le scan dans le stockage du
 * navigateur. Rien n'est écrit dans l'org (sauf les recommandations partagées si le module
 * collaboratif est installé).
 *
 * Module unique pour toute l'application : un scan continue quand l'utilisateur change de section
 * (les écrans s'abonnent par subscribe).
 *
 * Fiabilité :
 * - un scan non terminé (arrêt, échec) ne remplace jamais le dernier bon scan : il est gardé à part
 *   (`scan.lastFailed`) et son résumé rejoint l'historique ;
 * - verrou `scan.lock` (onglet, battement toutes les 20 s, expiration 2 min) : un seul scan à la
 *   fois pour l'utilisateur, tous onglets confondus ;
 * - progression gardée régulièrement (`scan.resume*`) : après un rechargement, une coupure réseau
 *   ou une session expirée, le scan peut reprendre (resumeScan) ; fermer l'onglet pendant un scan
 *   demande confirmation (beforeunload) ;
 * - arrêt après 2 appels en échec consécutifs ou sur une erreur réseau / session (reprise possible) ;
 * - les constats des règles d'une étape en échec sont retirés ;
 * - recommandations partagées envoyées par lots de 500 (même nom de scan, règles fiables au
 *   dernier lot) ; un échec est compté comme une erreur et exposé (`recommendationsError`).
 *
 * Exports : subscribe(listener), currentRun(), isScanRunning(), startScan(scope), cancelScan(),
 * resumableScan() → { id, name, scope, startedAt, savedAt, progress, currentStep,
 * lockedByOtherTab } | null, resumeScan(), discardResumableScan().
 * État publié (subscribe / currentRun) : id, name, status, progress, currentStep, stepPage,
 * startedAt, componentCount, findingCount, collectionErrorCount, toolingApiAvailable, canCancel
 * (false pendant la phase finale), resumed, puis à la fin le résumé du scan (summarizeScan) avec
 * error, cancelled, resumable, recommendationsError, inventoryKept.
 */
import startScanApex from "@salesforce/apex/OrgIntelligenceController.startScan";
import runScanStepApex from "@salesforce/apex/OrgIntelligenceController.runScanStep";
import {
  saveValue,
  pushHistory,
  loadValue,
  removeValue,
  STORE_KEYS
} from "c/orgIntelStore";
import {
  updateLocalRecommendations,
  mergeRecommendations,
  markNotDetected
} from "c/orgIntelRecommendationStore";
import {
  callModule,
  loadInstalledModulesStrict,
  MODULES
} from "c/orgIntelModuleApi";
import {
  computeHealthScore,
  summarizeScan,
  findingToRecommendation,
  slimComponent,
  errorCount,
  saveLatestScan,
  saveFailedScan,
  loadLatestScan,
  loadLatestScanHeader,
  loadFindingSnapshots,
  addFindingSnapshot,
  findingSnapshot,
  markNewFindings,
  isFinished,
  HISTORY_MAX,
  PREVIOUS_FINDINGS_KEY,
  PREVIOUS_STORAGE_KEY
} from "c/orgIntelScanData";
import { reduceErrors } from "c/orgIntelUtils";

/** Part de la barre de progression réservée aux étapes serveur (le reste : recommandations, score). */
const STEP_PROGRESS_SHARE = 90;
const MAX_CALLS = 400;
const MAX_CONSECUTIVE_FAILURES = 2;

const LOCK_KEY = "scan.lock";
const LOCK_TTL_MS = 120000;
const HEARTBEAT_MS = 20000;

const RESUME_KEY = "scan.resume";
const RESUME_FINDINGS_KEY = "scan.resume.findings";
const RESUME_COMPONENTS_KEY = "scan.resume.components";
const CHECKPOINT_EVERY_CALLS = 10;
const CHECKPOINT_MIN_INTERVAL_MS = 15000;

const SYNC_BATCH_SIZE = 500;
const SYNC_BATCH_CHARS = 2000000;

const STEP_APEX_COVERAGE = "APEX_COVERAGE";
const STEP_FLOW_ANALYSIS = "FLOW_ANALYSIS";

let current = null;
let cancelRequested = false;
const listeners = new Set();

/** Identifiant de l'onglet, conservé au rechargement (sessionStorage) pour reprendre son verrou. */
const TAB_ID = (() => {
  const key = "orgIntelligence.scanTabId";
  try {
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
})();

class ScanInterruptedError extends Error {
  constructor(message, resumable) {
    super(message);
    this.name = "ScanInterruptedError";
    this.resumable = resumable;
  }
}

function cancelledError() {
  const error = new ScanInterruptedError("Scan cancelled by the user.", false);
  error.cancelled = true;
  return error;
}

function notify() {
  const snapshot = current ? { ...current } : null;
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // un écran détruit ne doit pas arrêter le scan
    }
  });
}

/** Abonnement à la progression (appelé tout de suite avec l'état courant). Renvoie le désabonnement. */
export function subscribe(listener) {
  listeners.add(listener);
  try {
    listener(current ? { ...current } : null);
  } catch {
    // un écran en erreur ne doit pas casser l'abonnement
  }
  return () => listeners.delete(listener);
}

export function currentRun() {
  return current ? { ...current } : null;
}

export function isScanRunning() {
  return Boolean(current && current.status === "Running");
}

/** Demande l'arrêt après l'appel en cours (ignoré pendant la phase finale, cf. canCancel). */
export function cancelScan() {
  if (current && current.canCancel === false) {
    return;
  }
  cancelRequested = true;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function scanName(date) {
  return `SCAN-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`;
}

function logEntry(step, level, message) {
  return { step, level, message, loggedAt: new Date().toISOString() };
}

// ---------- Verrou multi-onglets ----------

let heartbeatTimer = null;

async function acquireLock(scanId) {
  try {
    const lock = await loadValue(LOCK_KEY, null);
    if (
      lock &&
      lock.tabId !== TAB_ID &&
      Date.now() - new Date(lock.heartbeat).getTime() < LOCK_TTL_MS
    ) {
      throw new ScanInterruptedError(
        "A scan is already running in another tab or window. Wait for it to finish, or close that tab and try again in two minutes.",
        false
      );
    }
    const mine = { tabId: TAB_ID, scanId, heartbeat: new Date().toISOString() };
    await saveValue(LOCK_KEY, mine);
    // Deux onglets lancés au même instant : le dernier écrit gagne, l'autre renonce
    await new Promise((resolve) => {
      // eslint-disable-next-line @lwc/lwc/no-async-operation
      setTimeout(resolve, 200);
    });
    const check = await loadValue(LOCK_KEY, null);
    if (check && check.tabId !== TAB_ID) {
      throw new ScanInterruptedError(
        "A scan was started in another tab at the same time.",
        false
      );
    }
  } catch (error) {
    if (error instanceof ScanInterruptedError) {
      throw error;
    }
    // stockage indisponible : le scan reste possible, sans protection multi-onglets
  }
  stopHeartbeat();
  // eslint-disable-next-line @lwc/lwc/no-async-operation
  heartbeatTimer = setInterval(() => {
    saveValue(LOCK_KEY, {
      tabId: TAB_ID,
      scanId,
      heartbeat: new Date().toISOString()
    }).catch(() => {});
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function releaseLock() {
  stopHeartbeat();
  try {
    const lock = await loadValue(LOCK_KEY, null);
    if (!lock || lock.tabId === TAB_ID) {
      await removeValue(LOCK_KEY);
    }
  } catch {
    // le verrou expire de lui-même
  }
}

// ---------- Garde de fermeture ----------

function beforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
  return "";
}

function setUnloadGuard(active) {
  try {
    if (active) {
      window.addEventListener("beforeunload", beforeUnload);
    } else {
      window.removeEventListener("beforeunload", beforeUnload);
    }
  } catch {
    // garde facultative
  }
}

// ---------- Erreurs ----------

/** Coupure réseau ou session expirée : inutile de continuer, le scan pourra reprendre. */
function isConnectionError(error) {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return true;
    }
  } catch {
    // ignoré
  }
  const status = error && error.status;
  if (status === 0 || status === 401 || status === 403) {
    return true;
  }
  const message = reduceErrors(error);
  return /disconnected|network|failed to fetch|offline|invalid_session|session (has )?expired|session is no longer valid|log ?in again|timed out/i.test(
    message
  );
}

// ---------- Lancement et reprise ----------

/**
 * Lance un scan sur le périmètre donné (valeurs de SCAN_SCOPES). Résout avec le scan terminé.
 * Un seul scan à la fois (tous onglets de l'utilisateur).
 */
export async function startScan(scope) {
  if (isScanRunning()) {
    throw new Error("A scan is already running in this tab.");
  }
  cancelRequested = false;
  const startedAt = new Date();
  const scan = {
    id: `scan-${startedAt.getTime()}`,
    name: scanName(startedAt),
    status: "Running",
    scope: [...(scope || [])],
    startedAt: startedAt.toISOString(),
    completedAt: null,
    toolingAvailable: false,
    healthScore: null,
    log: [],
    components: [],
    findings: [],
    evaluatedRules: [],
    reliableRules: [],
    failedSteps: [],
    storage: null,
    recommendationLinks: {},
    ignoredFingerprints: [],
    recommendationsError: null
  };
  publishStart(scan, false);
  try {
    await acquireLock(scan.id);
  } catch (error) {
    current = null;
    notify();
    throw error;
  }
  const ctx = { scan, byKey: new Map(), calls: 0 };
  try {
    const started = JSON.parse(await startScanApex({ scope: scan.scope }));
    scan.scope = started.scope || scan.scope;
    scan.scoreConfig = started.scoreConfig;
    scan.rules = started.rules || [];
    ctx.needs = started.inventoryNeeds || {};
    ctx.labels = started.stepLabels || {};
    ctx.state = started.state;
  } catch (error) {
    await releaseLock();
    current = {
      ...current,
      status: "Failed",
      progress: 100,
      currentStep: null,
      error: reduceErrors(error),
      canCancel: false
    };
    notify();
    throw error;
  }
  // Une reprise en attente n'a plus lieu d'être
  await discardResumableScan();
  return execute(ctx);
}

/** Scan interrompu qui peut reprendre (rechargement, coupure, session expirée), ou null. */
export async function resumableScan() {
  const saved = await loadValue(RESUME_KEY, null);
  if (!saved || !saved.scan || !saved.state) {
    return null;
  }
  let lockedByOtherTab = false;
  const lock = await loadValue(LOCK_KEY, null);
  if (
    lock &&
    lock.tabId !== TAB_ID &&
    Date.now() - new Date(lock.heartbeat).getTime() < LOCK_TTL_MS
  ) {
    lockedByOtherTab = true;
  }
  return {
    id: saved.scan.id,
    name: saved.scan.name,
    scope: saved.scan.scope || [],
    startedAt: saved.scan.startedAt,
    savedAt: saved.savedAt,
    progress: saved.progress || 0,
    currentStep: saved.currentStep || null,
    lockedByOtherTab:
      lockedByOtherTab || (isScanRunning() && current.id !== saved.scan.id)
  };
}

/** Reprend le scan interrompu là où sa progression a été gardée. */
export async function resumeScan() {
  if (isScanRunning()) {
    throw new Error("A scan is already running in this tab.");
  }
  const saved = await loadValue(RESUME_KEY, null);
  if (!saved || !saved.scan || !saved.state) {
    throw new Error("There is no interrupted scan to resume.");
  }
  const [findings, components] = await Promise.all([
    loadValue(RESUME_FINDINGS_KEY, null),
    loadValue(RESUME_COMPONENTS_KEY, null)
  ]);
  if (!Array.isArray(findings) || !Array.isArray(components)) {
    await discardResumableScan();
    throw new Error(
      "The progress of the interrupted scan could not be read: start a new scan."
    );
  }
  cancelRequested = false;
  const scan = { ...saved.scan, status: "Running", findings, components: [] };
  scan.log = [
    ...(scan.log || []),
    logEntry("Scan", "info", "Scan resumed after an interruption.")
  ];
  publishStart(scan, true);
  try {
    await acquireLock(scan.id);
  } catch (error) {
    current = null;
    notify();
    throw error;
  }
  const byKey = new Map();
  components.forEach((component) => byKey.set(component.key, component));
  const ctx = {
    scan,
    byKey,
    calls: saved.calls || 0,
    needs: saved.needs || {},
    labels: saved.labels || {},
    state: saved.state
  };
  updateProgress(ctx);
  return execute(ctx);
}

/** Abandonne le scan interrompu (sa progression gardée est supprimée). */
export async function discardResumableScan() {
  await Promise.all([
    removeValue(RESUME_KEY),
    removeValue(RESUME_FINDINGS_KEY),
    removeValue(RESUME_COMPONENTS_KEY)
  ]);
}

function publishStart(scan, resumed) {
  current = {
    id: scan.id,
    name: scan.name,
    status: "Running",
    progress: 0,
    currentStep: resumed ? "Resuming" : "Preparing",
    stepPage: null,
    startedAt: scan.startedAt,
    componentCount: 0,
    findingCount: scan.findings.length,
    collectionErrorCount: errorCount(scan.log),
    canCancel: true,
    resumed
  };
  notify();
}

async function execute(ctx) {
  const scan = ctx.scan;
  setUnloadGuard(true);
  try {
    await runSteps(ctx);
    await finalize(ctx);
    current = {
      ...summarizeScan(scan),
      progress: 100,
      currentStep: null,
      canCancel: false
    };
    notify();
    return scan;
  } catch (error) {
    const resumable = error instanceof ScanInterruptedError && error.resumable;
    const message = reduceErrors(error);
    scan.components = [...ctx.byKey.values()];
    if (resumable) {
      await saveCheckpoint(ctx, true);
    } else {
      await discardResumableScan().catch(() => {});
    }
    scan.status = "Failed";
    scan.completedAt = new Date().toISOString();
    scan.log.push(
      logEntry(
        "Scan",
        "error",
        `The scan stopped: ${message}${resumable && !ctx.checkpointDisabled ? " It can be resumed." : ""}`
      )
    );
    // Le dernier bon scan reste en place : l'échec est gardé à part
    await saveFailedScan(scan).catch(() => {});
    await pushHistory(
      STORE_KEYS.SCAN_HISTORY,
      summarizeScan(scan),
      HISTORY_MAX
    ).catch(() => {});
    current = {
      ...summarizeScan(scan),
      progress: 100,
      currentStep: null,
      canCancel: false,
      error: message,
      cancelled: Boolean(error && error.cancelled),
      resumable: Boolean(resumable && !ctx.checkpointDisabled)
    };
    notify();
    throw error;
  } finally {
    setUnloadGuard(false);
    await releaseLock();
  }
}

// ---------- Étapes ----------

/** Composants envoyés au serveur : seulement ce dont l'étape a besoin. */
function inventoryFor(step, needed, byKey) {
  const matching = [...byKey.values()].filter((component) =>
    needed.includes(component.componentType)
  );
  if (step === STEP_APEX_COVERAGE) {
    return matching.map((component) => ({
      componentType: component.componentType,
      apiName: component.apiName,
      details: {
        isTest: Boolean(component.details && component.details.isTest)
      }
    }));
  }
  if (step === STEP_FLOW_ANALYSIS) {
    // Le serveur trie tous les flows par nom et analyse une page de 30 : chaque flow garde sa
    // place dans la liste, mais seules les versions à lire sont envoyées (pas les modèles déjà
    // calculés aux pages précédentes).
    return matching.map((component) => {
      const details = component.details || {};
      return {
        componentType: component.componentType,
        apiName: component.apiName,
        parentName: component.parentName,
        isActive: component.isActive,
        details: {
          activeVersionId: details.activeVersionId || null,
          latestVersionId: details.latestVersionId || null
        }
      };
    });
  }
  return matching.map(slimComponent);
}

async function runSteps(ctx) {
  const { scan, byKey } = ctx;
  const fingerprints = new Set(
    scan.findings.map((finding) => finding.fingerprint)
  );
  let consecutiveFailures = 0;
  let lastCheckpointCall = ctx.calls;
  let lastCheckpointAt = Date.now();

  while (ctx.state.stepIndex < ctx.state.steps.length) {
    if (cancelRequested) {
      throw cancelledError();
    }
    if (ctx.calls >= MAX_CALLS) {
      throw new ScanInterruptedError(
        "Too many scan steps: the scan was stopped.",
        false
      );
    }
    const state = ctx.state;
    const step = state.steps[state.stepIndex];
    const needed = ctx.needs[step];
    const inventory = needed ? inventoryFor(step, needed, byKey) : null;
    ctx.calls++;
    let result;
    try {
      result = JSON.parse(
        // eslint-disable-next-line no-await-in-loop
        await runScanStepApex({
          stateJson: JSON.stringify(state),
          inventoryJson: inventory ? JSON.stringify(inventory) : null
        })
      );
    } catch (error) {
      const message = reduceErrors(error);
      if (isConnectionError(error)) {
        ctx.calls--;
        throw new ScanInterruptedError(
          `The connection to Salesforce was lost or your session expired (${message}).`,
          true
        );
      }
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new ScanInterruptedError(
          `${MAX_CONSECUTIVE_FAILURES} scan calls failed in a row (${message}).`,
          true
        );
      }
      // Erreur non interceptable côté serveur (limite) : l'étape est marquée en échec
      scan.log.push(
        logEntry(
          ctx.labels[step] || step,
          "error",
          `Step stopped by the platform: ${message} Its results are incomplete and its rules are ignored for this scan.`
        )
      );
      state.failedSteps = [...new Set([...(state.failedSteps || []), step])];
      state.stepIndex++;
      state.cursor = null;
      ctx.stepPage = 0;
      updateProgress(ctx);
      continue;
    }
    consecutiveFailures = 0;
    (result.components || []).forEach((component) => {
      byKey.set(component.key, component);
    });
    (result.findings || []).forEach((finding) => {
      if (!fingerprints.has(finding.fingerprint)) {
        fingerprints.add(finding.fingerprint);
        scan.findings.push(finding);
      }
    });
    Object.entries(result.detailUpdates || {}).forEach(([key, details]) => {
      const component = byKey.get(key);
      if (component) {
        // Fusion : le serveur ne renvoie que les clés qu'il a reçues ou calculées
        component.details = {
          ...(component.details || {}),
          ...(details || {})
        };
      }
    });
    Object.entries(result.dependencyUpdates || {}).forEach(([key, deps]) => {
      const component = byKey.get(key);
      if (component) {
        component.dependencies = deps;
      }
    });
    if (result.scanValues && result.scanValues.storage) {
      scan.storage = result.scanValues.storage;
    }
    scan.log.push(...(result.log || []));
    scan.reliableRules = result.reliableRules || scan.reliableRules;
    const stepChanged = result.state.stepIndex !== state.stepIndex;
    ctx.stepPage = stepChanged ? 0 : (ctx.stepPage || 0) + 1;
    ctx.stepTotal =
      result.total !== undefined && result.total !== null
        ? Number(result.total)
        : null;
    ctx.state = result.state;
    scan.toolingAvailable = ctx.state.toolingAvailable === true;
    updateProgress(ctx);

    const due =
      stepChanged ||
      (ctx.calls - lastCheckpointCall >= CHECKPOINT_EVERY_CALLS &&
        Date.now() - lastCheckpointAt >= CHECKPOINT_MIN_INTERVAL_MS);
    if (due && ctx.state.stepIndex < ctx.state.steps.length) {
      lastCheckpointCall = ctx.calls;
      lastCheckpointAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await saveCheckpoint(ctx, false);
    }
  }

  const state = ctx.state;
  scan.components = [...byKey.values()];
  scan.evaluatedRules = state.evaluatedRules || [];
  scan.failedSteps = state.failedSteps || [];
  scan.ruleSteps = state.ruleSteps || {};

  // Étape en échec (même après plusieurs pages réussies) : ses règles sont ignorées
  const failed = new Set(scan.failedSteps);
  if (failed.size) {
    const before = scan.findings.length;
    scan.findings = scan.findings.filter(
      (finding) => !failed.has(scan.ruleSteps[finding.ruleCode])
    );
    scan.reliableRules = scan.evaluatedRules.filter(
      (code) => !failed.has(scan.ruleSteps[code])
    );
    const removed = before - scan.findings.length;
    if (removed > 0) {
      scan.log.push(
        logEntry(
          "Scan",
          "warning",
          `${removed} findings from failed steps were removed: their rules are ignored for this scan.`
        )
      );
    }
  }
}

function updateProgress(ctx) {
  const { state, labels, byKey, scan } = ctx;
  const total = state.steps.length || 1;
  const step = state.steps[state.stepIndex];
  let fraction = 0;
  const cursor =
    state.cursor === null || state.cursor === undefined
      ? NaN
      : Number(state.cursor);
  if (step && !Number.isNaN(cursor) && cursor > 0) {
    let stepTotal = ctx.stepTotal;
    if (!stepTotal && step === STEP_FLOW_ANALYSIS) {
      stepTotal = [...byKey.values()].filter(
        (c) => c.componentType === "Flow"
      ).length;
    }
    fraction = stepTotal
      ? Math.min(cursor / stepTotal, 0.99)
      : Math.min(0.9, 1 - 1 / (1 + (ctx.stepPage || 0) / 4));
  } else if (step && ctx.stepPage) {
    fraction = Math.min(0.9, 1 - 1 / (1 + ctx.stepPage / 4));
  }
  current = {
    ...current,
    progress: Math.round(
      (STEP_PROGRESS_SHARE * (state.stepIndex + fraction)) / total
    ),
    currentStep: step
      ? labels[step] || step
      : "Recommendations and health score",
    stepPage: step && ctx.stepPage ? ctx.stepPage + 1 : null,
    componentCount: byKey.size,
    findingCount: scan.findings.length,
    collectionErrorCount: errorCount(scan.log),
    toolingApiAvailable: scan.toolingAvailable
  };
  notify();
}

// ---------- Reprise : progression gardée ----------

async function saveCheckpoint(ctx, final) {
  if (ctx.checkpointDisabled || !ctx.state) {
    return;
  }
  const scan = ctx.scan;
  const header = { ...scan };
  delete header.components;
  delete header.findings;
  try {
    await saveValue(RESUME_FINDINGS_KEY, scan.findings);
    await saveValue(RESUME_COMPONENTS_KEY, [...ctx.byKey.values()]);
    await saveValue(RESUME_KEY, {
      scan: header,
      state: ctx.state,
      needs: ctx.needs,
      labels: ctx.labels,
      calls: ctx.calls,
      progress: current ? current.progress : 0,
      currentStep: current ? current.currentStep : null,
      savedAt: new Date().toISOString(),
      final
    });
  } catch (error) {
    ctx.checkpointDisabled = true;
    scan.log.push(
      logEntry(
        "Scan",
        "warning",
        `The progress of this scan cannot be saved in the browser (${reduceErrors(
          error
        )}): it cannot be resumed if the page is reloaded.`
      )
    );
    await discardResumableScan().catch(() => {});
  }
}

// ---------- Fin du scan ----------

async function finalize(ctx) {
  const scan = ctx.scan;
  const completedAt = new Date().toISOString();
  current = {
    ...current,
    progress: STEP_PROGRESS_SHARE,
    currentStep: "Recommendations"
  };
  notify();

  // Constats nouveaux : comparés au dernier scan terminé, sur les règles évaluées dans les deux
  let reference = null;
  try {
    const snapshots = await loadFindingSnapshots();
    reference = snapshots[0] || null;
    if (!reference) {
      const latest = await loadLatestScan();
      if (
        latest &&
        Array.isArray(latest.findings) &&
        isFinished(latest.status)
      ) {
        reference = findingSnapshot(latest);
      } else {
        reference = await loadValue(PREVIOUS_FINDINGS_KEY, null);
      }
    }
  } catch {
    reference = null;
  }
  markNewFindings(scan.findings, reference);

  if (cancelRequested) {
    throw cancelledError();
  }
  // Phase finale : plus d'arrêt possible (recommandations déjà en cours d'écriture)
  current = { ...current, canCancel: false };
  notify();

  await syncRecommendations(scan, completedAt);

  current = { ...current, progress: 95, currentStep: "Health score" };
  notify();
  scan.healthScore = computeHealthScore(
    scan.findings,
    scan.scoreConfig,
    scan.ignoredFingerprints
  );
  scan.completedAt = completedAt;
  scan.status =
    errorCount(scan.log) > 0 ? "Completed with errors" : "Completed";
  scan.progress = 100;

  // Photographie du stockage remplacée : devient la référence de comparaison
  try {
    const header = await loadLatestScanHeader();
    if (scan.storage && header && header.storage && header.storage.snapshot) {
      await saveValue(PREVIOUS_STORAGE_KEY, {
        scanId: header.id,
        scanName: header.name,
        completedAt: header.completedAt,
        snapshot: header.storage.snapshot
      });
    }
  } catch (error) {
    scan.log.push(
      logEntry(
        "Scan",
        "warning",
        `The previous storage snapshot was not kept: ${reduceErrors(error)}`
      )
    );
  }

  try {
    await addFindingSnapshot(scan);
  } catch (error) {
    scan.log.push(
      logEntry(
        "Scan",
        "warning",
        `The findings of this scan were not added to the comparison history: ${reduceErrors(error)}`
      )
    );
  }

  // La progression gardée libère sa place avant l'écriture du scan
  await discardResumableScan().catch(() => {});
  await saveLatestScan(scan);

  // Historique non bloquant : le scan est déjà gardé
  try {
    await pushHistory(
      STORE_KEYS.SCAN_HISTORY,
      summarizeScan(scan),
      HISTORY_MAX
    );
  } catch (error) {
    scan.log.push(
      logEntry(
        "Scan",
        "warning",
        `The scan history was not updated: ${reduceErrors(error)}`
      )
    );
  }
}

/** Lots de constats pour syncScan : 500 au plus et environ 2 Mo de JSON. */
function syncBatches(findings) {
  const batches = [];
  let batch = [];
  let chars = 0;
  findings.forEach((finding) => {
    const size = JSON.stringify(finding).length;
    if (
      batch.length &&
      (batch.length >= SYNC_BATCH_SIZE || chars + size > SYNC_BATCH_CHARS)
    ) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(finding);
    chars += size;
  });
  batches.push(batch); // au moins un appel, même sans constat (règles fiables)
  return batches;
}

/** Recommandations : module collaboratif s'il est installé, sinon stockage local. */
async function syncRecommendations(scan, completedAt) {
  try {
    // Liste stricte : une coupure réseau ne doit pas faire basculer une org collaborative en local
    const modules = await loadInstalledModulesStrict();
    const reopenReason = `Detected again by ${scan.name} after being resolved.`;
    if (modules.includes(MODULES.RECOMMENDATIONS)) {
      const batches = syncBatches(scan.findings);
      const totals = { created: 0, updated: 0, notDetected: 0 };
      const links = {};
      for (let i = 0; i < batches.length; i++) {
        const last = i === batches.length - 1;
        // eslint-disable-next-line no-await-in-loop
        const result = await callModule(MODULES.RECOMMENDATIONS, "syncScan", {
          findings: batches[i],
          reliableRules: last ? scan.reliableRules : [],
          scanName: scan.name,
          completedAt
        });
        totals.created += (result && result.created) || 0;
        totals.updated += (result && result.updated) || 0;
        totals.notDetected += (result && result.notDetected) || 0;
        Object.assign(links, (result && result.links) || {});
      }
      scan.recommendationLinks = links;
      scan.log.push(
        logEntry(
          "Recommendations",
          "info",
          `Shared recommendations: ${totals.created} created, ${totals.updated} updated, ${totals.notDetected} no longer detected${
            batches.length > 1 ? ` (${batches.length} batches)` : ""
          }.`
        )
      );
    } else {
      const rules = new Map(
        (scan.rules || []).map((rule) => [rule.code, rule])
      );
      const specs = scan.findings.map((finding) =>
        findingToRecommendation(
          finding,
          rules.get(finding.ruleCode),
          scan.name,
          completedAt
        )
      );
      // File d'écriture du stockage : relecture juste avant la fusion, aucune décision écrasée
      const { counts, notDetected, links } = await updateLocalRecommendations(
        (byFingerprint) => {
          const merged = mergeRecommendations(
            byFingerprint,
            specs,
            reopenReason
          );
          const missing = markNotDetected(
            byFingerprint,
            scan.reliableRules,
            scan.findings.map((finding) => finding.fingerprint)
          );
          const found = {};
          scan.findings.forEach((finding) => {
            const rec = byFingerprint[finding.fingerprint];
            if (rec) {
              found[finding.fingerprint] = {
                id: rec.Id,
                name: rec.Name,
                status: rec.Status__c
              };
            }
          });
          return { counts: merged, notDetected: missing, links: found };
        }
      );
      scan.recommendationLinks = links;
      scan.log.push(
        logEntry(
          "Recommendations",
          "info",
          `Recommendations kept in this browser: ${counts.created} created, ${counts.updated} updated, ${notDetected} no longer detected.`
        )
      );
    }
    scan.ignoredFingerprints = Object.entries(scan.recommendationLinks)
      .filter(([, link]) => link && link.status === "Ignored")
      .map(([fingerprint]) => fingerprint);
  } catch (error) {
    scan.recommendationsError = reduceErrors(error);
    scan.log.push(
      logEntry(
        "Recommendations",
        "error",
        `Recommendations not updated: ${scan.recommendationsError} Ignored recommendations are not excluded from this score.`
      )
    );
  }
}
