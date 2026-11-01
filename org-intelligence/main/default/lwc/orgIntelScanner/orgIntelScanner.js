import { LightningElement, api } from "lwc";
import getScannerState from "@salesforce/apex/OrgIntelligenceController.getScannerState";
import { subscribe } from "c/orgIntelScanEngine";
import { loadScanHistory, currentScore } from "c/orgIntelScanData";
import { loadScoreContext } from "c/orgIntelScanControl";
import {
  exportRows,
  formatExportDate,
  formatDuration,
  formatNumber,
  isScanInProgress
} from "c/orgIntelUtils";

const HISTORY_COLUMNS = [
  {
    label: "Scan",
    fieldName: "name",
    type: "button",
    typeAttributes: {
      label: { fieldName: "name" },
      name: "view",
      variant: "base"
    },
    initialWidth: 130
  },
  {
    label: "Started",
    fieldName: "started",
    type: "date",
    typeAttributes: {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }
  },
  { label: "Duration", fieldName: "duration", initialWidth: 100 },
  {
    // Le nombre d'erreurs de collecte est affiché avec le statut (colonne dédiée retirée)
    label: "Status",
    fieldName: "statusText",
    cellAttributes: {
      iconName: { fieldName: "statusIcon" },
      iconAlternativeText: { fieldName: "status" }
    }
  },
  {
    label: "Components",
    fieldName: "componentCount",
    type: "number",
    cellAttributes: { alignment: "right" },
    initialWidth: 120
  },
  {
    label: "Findings",
    fieldName: "findingCount",
    type: "number",
    cellAttributes: { alignment: "right" },
    initialWidth: 100
  },
  {
    label: "Score",
    fieldName: "healthScore",
    type: "number",
    typeAttributes: { maximumFractionDigits: 1 },
    cellAttributes: { alignment: "right" },
    initialWidth: 90
  }
];

const STATUS_ICONS = {
  Completed: "utility:success",
  "Completed with errors": "utility:warning",
  Failed: "utility:error",
  Running: "utility:spinner",
  Queued: "utility:clock"
};

/**
 * Section « Org Scanner » : historique des scans du navigateur et détail d'un scan. Le lancement
 * passe par le lanceur commun (c-org-intel-scan-control), la progression par la coquille. Le droit
 * de lancer reste contrôlé côté serveur (permission Admin, vérifiée par chaque étape).
 */
export default class OrgIntelScanner extends LightningElement {
  /** Scan à ouvrir directement (paramètre d'URL c__scanId). */
  @api
  get scanId() {
    return this.selectedScanId;
  }
  set scanId(value) {
    this.selectedScanId = value || null;
  }

  selectedScanId = null;
  state;
  error;
  isLoading = true;
  historyColumns = HISTORY_COLUMNS;
  history = [];
  unsubscribe;
  lastStatus;

  connectedCallback() {
    this.load();
    this.unsubscribe = subscribe((run) => this.handleProgress(run));
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async load() {
    this.isLoading = !this.state;
    try {
      const [state, history, scoreContext] = await Promise.all([
        getScannerState(),
        loadScanHistory(),
        loadScoreContext()
      ]);
      this.state = state;
      // Score du moment (préférences actuelles), comme l'Overview et le détail
      this.history = (history || []).map((scan) => ({
        ...scan,
        healthScore: currentScore(scan, scoreContext.scoreConfig)
      }));
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  // ---------- Connexion Tooling ----------

  get tooling() {
    return this.state?.tooling;
  }

  get toolingTone() {
    if (!this.tooling) {
      return "neutral";
    }
    return this.tooling.connected ? "good" : "warning";
  }

  get toolingLabel() {
    if (!this.tooling) {
      return "Unknown";
    }
    if (this.tooling.connected) {
      return "Tooling API connected";
    }
    return this.tooling.configured
      ? "Tooling API not authorized"
      : "Tooling API not configured";
  }

  get showToolingNotice() {
    return !!this.tooling && !this.tooling.connected;
  }

  /** Fin d'un scan (moteur du navigateur) : l'historique est relu. */
  handleProgress(run) {
    const wasRunning = this.lastStatus === "Running";
    this.lastStatus = run ? run.status : null;
    if (wasRunning && run && run.status !== "Running") {
      this.load();
    }
  }

  // ---------- Historique ----------

  get hasScans() {
    return (this.history || []).length > 0;
  }

  get historyRows() {
    return (this.history || []).map((scan) => ({
      ...scan,
      started: scan.startedAt || scan.createdDate,
      duration: formatDuration(scan.startedAt, scan.completedAt) || "—",
      statusIcon: STATUS_ICONS[scan.status] || "utility:info",
      statusText: scan.collectionErrorCount
        ? `${scan.status} (${scan.collectionErrorCount} collection error${scan.collectionErrorCount === 1 ? "" : "s"})`
        : scan.status,
      findingCount: isScanInProgress(scan.status) ? null : scan.findingCount
    }));
  }

  get scanCountText() {
    const count = (this.history || []).length;
    return `${formatNumber(count)} scan${count === 1 ? "" : "s"}`;
  }

  get noScans() {
    return !this.hasScans;
  }

  handleExportHistory(event) {
    exportRows({
      name: "scan-history",
      format: event.detail.format,
      rows: this.history || [],
      columns: [
        { label: "Scan", value: (scan) => scan.name },
        { label: "Status", value: (scan) => scan.status },
        {
          label: "Started",
          value: (scan) => formatExportDate(scan.startedAt || scan.createdDate)
        },
        {
          label: "Completed",
          value: (scan) => formatExportDate(scan.completedAt)
        },
        {
          label: "Duration",
          value: (scan) => formatDuration(scan.startedAt, scan.completedAt)
        },
        { label: "Components", value: (scan) => scan.componentCount },
        {
          label: "Findings",
          value: (scan) => {
            return isScanInProgress(scan.status) ? null : scan.findingCount;
          }
        },
        { label: "Health score", value: (scan) => scan.healthScore },
        {
          label: "Collection errors",
          value: (scan) => scan.collectionErrorCount
        },
        {
          label: "Scope",
          value: (scan) => {
            return Array.isArray(scan.scope)
              ? scan.scope.join("; ")
              : scan.scope;
          }
        },
        { label: "Scan Id", value: (scan) => scan.id }
      ]
    });
  }

  handleRowAction(event) {
    this.openScan(event.detail.row.id);
  }

  openScan(scanId) {
    this.selectedScanId = scanId;
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "scanner", scanId }
      })
    );
  }

  /** Navigation demandée par le détail (recommandation, scan importé) : relayée à la coquille. */
  handleDetailNavigate(event) {
    event.stopPropagation();
    const detail = { ...event.detail };
    if (detail.section === "scanner" && detail.scanId) {
      this.selectedScanId = detail.scanId;
    }
    this.dispatchEvent(new CustomEvent("navigate", { detail }));
  }

  handleBack() {
    this.selectedScanId = null;
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "scanner", scanId: null }
      })
    );
    this.load();
  }

  handleRefresh() {
    this.load();
  }

  /** Navigation demandée par le lanceur (scan ouvert depuis un fichier, liste). */
  handleControlNavigate(event) {
    event.stopPropagation();
    const detail = event.detail || {};
    if (detail.section === "scanner" && detail.scanId) {
      this.openScan(detail.scanId);
      return;
    }
    this.dispatchEvent(new CustomEvent("navigate", { detail }));
  }
}
