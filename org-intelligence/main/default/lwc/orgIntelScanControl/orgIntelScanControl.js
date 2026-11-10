import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import getScannerState from "@salesforce/apex/OrgIntelligenceController.getScannerState";
import getRuleCatalog from "@salesforce/apex/OrgIntelligenceController.getRuleCatalog";
import {
  startScan,
  subscribe,
  isScanRunning,
  resumableScan,
  resumeScan,
  discardResumableScan
} from "c/orgIntelScanEngine";
import {
  importScan,
  loadLatestScan,
  loadLatestScanHeader,
  loadScanHistory
} from "c/orgIntelScanData";
import {
  recommendationsMode,
  loadLocalRecommendations,
  COLLABORATIVE_MODE
} from "c/orgIntelRecommendationStore";
import { downloadJson, loadValue, saveValue } from "c/orgIntelStore";
import {
  SCAN_SCOPES,
  formatNumber,
  formatRelative,
  reduceErrors
} from "c/orgIntelUtils";

/** Périmètre choisi, gardé dans le stockage commun du navigateur (par utilisateur). */
const SCOPE_STORE_KEY = "scan.scope";

/** Type de fichier des scans enregistrés (downloadJson / readJsonFile). */
export const SCAN_FILE_KIND = "scan";

/** Scans proposés dans le raccourci « Scans ». */
const RECENT_SCANS = 8;

const STATUS_ICONS = {
  Completed: "utility:success",
  "Completed with errors": "utility:warning",
  Failed: "utility:error",
  Running: "utility:spinner",
  Queued: "utility:clock"
};

const ALL_SCOPES = SCAN_SCOPES.map((scope) => scope.value);

function validScope(values) {
  const valid = Array.isArray(values)
    ? values.filter((value) => ALL_SCOPES.includes(value))
    : [];
  return valid.length ? valid : [...ALL_SCOPES];
}

// ---------- Scan ouvert en consultation seule (rien n'est stocké) ----------

let viewedScanInMemory = null;

/** Scan ouvert depuis un fichier en consultation seule (gardé en mémoire de l'onglet). */
export function viewedScan(scanId) {
  return viewedScanInMemory && (!scanId || viewedScanInMemory.id === scanId)
    ? viewedScanInMemory
    : null;
}

/** Contrôle minimal d'un fichier de scan. */
export function isScanFile(scan) {
  return Boolean(scan && scan.id && Array.isArray(scan.findings));
}

/**
 * Remplace le dernier scan du navigateur par celui d'un fichier (son résumé et son empreinte
 * rejoignent l'historique et les comparaisons).
 */
export async function replaceLatestScan(scan) {
  await importScan(scan, { makeLatest: true });
  if (viewedScanInMemory && viewedScanInMemory.id === scan.id) {
    viewedScanInMemory = null;
  }
}

/**
 * Contexte du score « du moment » (currentScore) : préférences actuelles du score et, sans module
 * collaboratif, recommandations ignorées dans ce navigateur (sinon : celles gardées par le scan).
 */
export async function loadScoreContext() {
  const context = { scoreConfig: null, ignoredFingerprints: undefined };
  try {
    context.scoreConfig =
      JSON.parse(await getRuleCatalog()).scoreConfig || null;
  } catch {
    // préférences indisponibles : score enregistré par le scan
  }
  try {
    if ((await recommendationsMode()) !== COLLABORATIVE_MODE) {
      const local = await loadLocalRecommendations();
      context.ignoredFingerprints = Object.values(local || {})
        .filter((rec) => rec.Status__c === "Ignored" && rec.Fingerprint__c)
        .map((rec) => rec.Fingerprint__c);
    }
  } catch {
    // recommandations illisibles : ignorés du scan
  }
  return context;
}

/**
 * Lanceur de scan commun (Overview, Scanner, écran Modules) : bouton « New scan » avec choix du
 * périmètre (mémorisé), raccourci vers les scans gardés, menu Data (enregistrer le dernier scan,
 * ouvrir un fichier de scan : remplacer le dernier scan ou consulter sans rien stocker).
 * La progression et la fin du scan sont affichées par la coquille (orgIntelApp).
 * Émet « scanstarted », « scanfinished » (fin d'un scan ou scan remplacé) et « navigate ».
 */
export default class OrgIntelScanControl extends LightningElement {
  /** Masque le raccourci « Scans » (le Scanner affiche déjà l'historique). */
  @api hideHistory = false;
  /** Masque le bouton « New scan » (détail d'un scan). */
  @api hideLauncher = false;
  /** Affiche le menu Data (enregistrer / ouvrir un fichier de scan). */
  @api showData = false;
  /** Scan à enregistrer par « Save to file » (par défaut : le dernier scan du navigateur). */
  @api scanToSave;
  /** Libellé du bouton de lancement. */
  @api launchLabel = "New scan";

  state;
  history = [];
  hasLatest = false;
  isOpen = false;
  isStarting = false;
  selectedScope = [...ALL_SCOPES];
  runningScan;
  unsubscribe;
  lastStatus;
  /** Fichier de scan ouvert, en attente du choix de l'utilisateur. */
  pendingFile;
  /** Scan interrompu (rechargement, coupure, session expirée) qui peut reprendre. */
  resumable = null;
  isResuming = false;
  /** Position des panneaux fixes (jamais coupés par un conteneur parent). */
  panelStyle = "visibility: hidden;";
  choiceStyle = "visibility: hidden;";

  connectedCallback() {
    this.load();
    this.loadScope();
    this.unsubscribe = subscribe((run) => this.handleProgress(run));
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.stopFollowing();
  }

  renderedCallback() {
    const open = this.isOpen || Boolean(this.pendingFile);
    if (open && !this.following) {
      this.following = () => this.placePanels();
      window.addEventListener("resize", this.following);
      window.addEventListener("scroll", this.following, true);
      this.placePanels();
    } else if (!open && this.following) {
      this.stopFollowing();
    }
  }

  stopFollowing() {
    if (this.following) {
      window.removeEventListener("resize", this.following);
      window.removeEventListener("scroll", this.following, true);
      this.following = null;
    }
    this.panelStyle = "visibility: hidden;";
    this.choiceStyle = "visibility: hidden;";
  }

  placePanels() {
    const panel =
      this.place('[data-id="new-scan"]', ".sc-launch") ||
      this.place(".sc-control", ".sc-launch");
    if (panel && panel !== this.panelStyle) {
      this.panelStyle = panel;
    }
    const choice =
      this.place('[data-id="data-menu"]', ".sc-choice") ||
      this.place(".sc-control", ".sc-choice");
    if (choice && choice !== this.choiceStyle) {
      this.choiceStyle = choice;
    }
  }

  /** Style de position d'un panneau fixe, aligné à droite de son ancre et gardé dans la fenêtre. */
  place(anchorSelector, panelSelector) {
    const anchorElement = this.template.querySelector(anchorSelector);
    const panel = this.template.querySelector(panelSelector);
    if (!anchorElement || !panel) {
      return null;
    }
    const anchor = anchorElement.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = Math.min(anchor.right - width, viewportWidth - width - margin);
    left = Math.max(margin, left);
    // Sous l'ancre s'il y a la place, sinon au-dessus
    let top = anchor.bottom + 6;
    if (
      top + height > viewportHeight - margin &&
      anchor.top - height - 6 > margin
    ) {
      top = anchor.top - height - 6;
    }
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    return `top: ${Math.round(top)}px; left: ${Math.round(left)}px;`;
  }

  /**
   * Ouvre le panneau de lancement, avec un périmètre prérempli si `scope` est donné (valeurs de
   * SCAN_SCOPES, ex. ["Flow"] depuis Automation, ["Storage"] depuis Storage).
   */
  @api
  openPanel(scope) {
    if (Array.isArray(scope) && scope.length) {
      this.selectedScope = validScope(scope);
      this.scopePrefilled = true;
    }
    this.isOpen = true;
  }

  async load() {
    try {
      // Sans lanceur (détail d'un scan) : pas besoin des droits ni du test de connexion Tooling
      this.state = this.hideLauncher
        ? { canRunScan: false }
        : await getScannerState();
    } catch {
      // Sans droit de lecture ou en cas d'erreur : rien à proposer
      this.state = { canRunScan: false };
    }
    try {
      const [history, latest] = await Promise.all([
        loadScanHistory(),
        loadLatestScanHeader()
      ]);
      this.history = history || [];
      this.hasLatest = Boolean(latest);
    } catch {
      this.history = [];
    }
    await this.loadResumable();
  }

  async loadResumable() {
    try {
      this.resumable = isScanRunning() ? null : await resumableScan();
    } catch {
      this.resumable = null;
    }
  }

  // ---------- Reprise d'un scan interrompu ----------

  get showResume() {
    return Boolean(this.resumable) && this.showLauncher && !this.isRunning;
  }

  get resumeText() {
    const run = this.resumable;
    if (!run) {
      return "";
    }
    if (run.lockedByOtherTab) {
      return `${run.name} is running in another tab`;
    }
    return `${run.name} stopped at ${Math.round(Number(run.progress || 0))}%`;
  }

  get resumeTitle() {
    const run = this.resumable;
    if (!run) {
      return "";
    }
    return run.lockedByOtherTab
      ? "This scan is running in another tab."
      : `Interrupted ${formatRelative(run.savedAt || run.startedAt)}${run.currentStep ? ` during "${run.currentStep}"` : ""}. Resume it where it stopped, or discard it.`;
  }

  /** Verrouillé par un autre onglet : message seul, sans Resume ni Discard. */
  get resumeActions() {
    return Boolean(this.resumable) && !this.resumable.lockedByOtherTab;
  }

  async handleResume() {
    this.isResuming = true;
    try {
      const promise = resumeScan();
      this.resumable = null;
      this.dispatchEvent(new CustomEvent("scanstarted"));
      this.isResuming = false;
      await promise;
    } catch (error) {
      if (!this.lastStatus || this.lastStatus === "Running") {
        this.toast("The scan could not resume", reduceErrors(error), "error");
      }
      this.loadResumable();
    } finally {
      this.isResuming = false;
    }
  }

  async handleDiscard() {
    try {
      await discardResumableScan();
    } catch (error) {
      this.toast(
        "The scan could not be discarded",
        reduceErrors(error),
        "error"
      );
    }
    this.resumable = null;
  }

  async loadScope() {
    try {
      const stored = await loadValue(SCOPE_STORE_KEY, null);
      if (!this.scopePrefilled) {
        this.selectedScope = validScope(stored);
      }
    } catch {
      // préférence illisible : tout le périmètre
    }
  }

  // ---------- Lancement ----------

  get canRunScan() {
    return Boolean(this.state?.canRunScan);
  }

  get showLauncher() {
    return this.canRunScan && !this.hideLauncher;
  }

  get toolingConnected() {
    return Boolean(this.state?.tooling?.connected);
  }

  get scopeOptions() {
    return SCAN_SCOPES.map((scope) => ({
      value: scope.value,
      label: scope.label,
      checked: this.selectedScope.includes(scope.value),
      needsTooling: Boolean(scope.tooling && !this.toolingConnected)
    }));
  }

  get allSelected() {
    return this.selectedScope.length === SCAN_SCOPES.length;
  }

  get toggleAllLabel() {
    return this.allSelected ? "None" : "All";
  }

  get toolingHint() {
    return this.state?.tooling && !this.toolingConnected
      ? "Tooling API not connected: validation rules, dependencies and coverage will be skipped (Settings › Tooling API)."
      : "";
  }

  get isRunning() {
    return Boolean(this.runningScan) || isScanRunning();
  }

  get startDisabled() {
    return (
      this.isStarting ||
      this.isRunning ||
      !this.canRunScan ||
      !this.selectedScope.length
    );
  }

  /** Panneau ouvert par openPanel sans le droit de lancer un scan. */
  get adminHint() {
    return this.state && !this.canRunScan
      ? 'Running a scan requires "Org Intelligence - Admin". Ask an administrator for a scan file instead.'
      : "";
  }

  get startLabel() {
    return this.isStarting ? "Starting…" : "Start scan";
  }

  get scopeSummary() {
    const count = this.selectedScope.length;
    return count === SCAN_SCOPES.length
      ? "Everything"
      : `${count} of ${SCAN_SCOPES.length} areas`;
  }

  handleTogglePanel() {
    this.isOpen = !this.isOpen;
  }

  handleClosePanel() {
    this.isOpen = false;
  }

  setScope(values) {
    this.selectedScope = values;
    saveValue(SCOPE_STORE_KEY, values).catch(() => {
      // préférence non gardée
    });
  }

  handleScopeToggle(event) {
    const value = event.target.dataset.value;
    const selected = new Set(this.selectedScope);
    if (event.target.checked) {
      selected.add(value);
    } else {
      selected.delete(value);
    }
    // Ordre stable, celui de SCAN_SCOPES
    this.setScope(ALL_SCOPES.filter((v) => selected.has(v)));
  }

  handleSelectAll() {
    this.setScope(this.allSelected ? [] : [...ALL_SCOPES]);
  }

  async handleStart() {
    this.isStarting = true;
    this.isOpen = false;
    try {
      const promise = startScan(this.selectedScope);
      this.dispatchEvent(new CustomEvent("scanstarted"));
      this.isStarting = false;
      await promise;
    } catch (error) {
      // La fin (réussie ou en échec) est annoncée par la coquille ; ici, refus de démarrer
      if (!this.lastStatus || this.lastStatus === "Running") {
        this.toast(
          "The scan could not be started",
          reduceErrors(error),
          "error"
        );
      }
    } finally {
      this.isStarting = false;
    }
  }

  // ---------- Suivi (la coquille affiche la progression et la fin) ----------

  handleProgress(run) {
    const wasRunning = this.lastStatus === "Running";
    this.lastStatus = run ? run.status : null;
    if (run && run.status === "Running") {
      this.runningScan = run;
      return;
    }
    this.runningScan = null;
    if (!wasRunning || !run) {
      return;
    }
    this.load();
    this.dispatchEvent(
      new CustomEvent("scanfinished", { detail: { scanId: run.id } })
    );
  }

  // ---------- Scans précédents ----------

  get recentScans() {
    return (this.history || []).slice(0, RECENT_SCANS).map((scan) => ({
      id: scan.id,
      label: `${scan.name} · ${scan.status} · ${formatRelative(scan.startedAt || scan.createdDate)}${scan.findingCount != null ? ` · ${formatNumber(scan.findingCount)} findings` : ""}`,
      icon: STATUS_ICONS[scan.status] || "utility:record"
    }));
  }

  get showHistory() {
    return !this.hideHistory && this.recentScans.length > 0;
  }

  handleScanSelect(event) {
    const value = event.detail.value;
    this.navigate(value === "all" ? null : value);
  }

  navigate(scanId) {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "scanner", scanId: scanId || null }
      })
    );
  }

  // ---------- Fichiers de scan (menu Data) ----------

  get saveDisabled() {
    return !this.scanToSave && !this.hasLatest;
  }

  async handleSave() {
    try {
      const scan = this.scanToSave || (await loadLatestScan());
      if (!scan) {
        return;
      }
      downloadJson(`${scan.name || "scan"}.json`, SCAN_FILE_KIND, scan);
    } catch (error) {
      this.toast("The scan could not be saved", reduceErrors(error), "error");
    }
  }

  /** Fichier ouvert : on demande « Replace the latest scan » ou « View only ». */
  handleOpenFile(event) {
    const { data, fileName, envelope } = event.detail || {};
    if (!isScanFile(data)) {
      this.toast(
        "The file could not be opened",
        "This file does not contain an Org Intelligence scan.",
        "error"
      );
      return;
    }
    this.isOpen = false;
    this.pendingFile = { scan: data, fileName, envelope: envelope || null };
  }

  handleDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  get pendingTitle() {
    const scan = this.pendingFile?.scan;
    return scan
      ? `${scan.name || "Scan"} · ${formatRelative(scan.completedAt || scan.startedAt)} · ${formatNumber((scan.findings || []).length)} findings`
      : "";
  }

  /** Fichier d'une autre org (enveloppe du fichier). */
  get otherOrgWarning() {
    const envelope = this.pendingFile?.envelope;
    if (!envelope || envelope.sameOrg !== false) {
      return "";
    }
    const org = envelope.orgName || envelope.orgId || "another org";
    return `This file comes from ${org}${envelope.isSandbox ? " (sandbox)" : ""}, not from this org.`;
  }

  get olderWarning() {
    const latest = this.history?.[0];
    const scan = this.pendingFile?.scan;
    return latest &&
      scan &&
      latest.id !== scan.id &&
      String(scan.startedAt || "") < String(latest.startedAt || "")
      ? "It is older than your latest scan."
      : "";
  }

  handleViewOnly() {
    const scan = this.pendingFile.scan;
    viewedScanInMemory = scan;
    this.pendingFile = null;
    this.navigate(scan.id);
  }

  async handleReplace() {
    const scan = this.pendingFile.scan;
    this.pendingFile = null;
    try {
      await replaceLatestScan(scan);
      this.toast(
        "Scan opened",
        `${scan.name} is now the latest scan in this browser.`,
        "success"
      );
      await this.load();
      this.dispatchEvent(
        new CustomEvent("scanfinished", { detail: { scanId: scan.id } })
      );
      this.navigate(scan.id);
    } catch (error) {
      this.toast("The scan could not be kept", reduceErrors(error), "error");
    }
  }

  handleCancelFile() {
    this.pendingFile = null;
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
