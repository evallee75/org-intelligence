import { api } from "lwc";
import LightningModal from "lightning/modal";
import { downloadText, reduceErrors, todayIso } from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import {
  JIRA_PRIORITIES,
  LOCAL_MODE,
  buildJiraCsv,
  jiraLabels,
  loadLocalByIds,
  markJiraExported,
  toRow
} from "c/orgIntelRecommendationStore";

// Actions Apex du module (via le contrôleur générique du socle)
const previewJiraExport = moduleAction("recommendations", "previewJiraExport");
const exportToJira = moduleAction("recommendations", "exportToJira");

/**
 * Export de recommandations vers Jira : aperçu des tickets, création groupée, résultat avec liens.
 * Résultat renvoyé à la fermeture : { exported: nombre de tickets créés }.
 *
 * Édition sans objet (mode « local ») : pas d'appel à Jira, un fichier CSV importable dans Jira
 * (Summary, Issue Type, Priority, Description, Labels) est téléchargé.
 */
export default class OrgIntelJiraExportModal extends LightningModal {
  @api recordIds = [];
  /** « local » : fichier CSV ; sinon export par l'API Jira du module Recommendations. */
  @api mode;

  localRecords = [];
  issueType = "Task";
  downloadedCount = 0;

  get isLocal() {
    return this.mode === LOCAL_MODE;
  }

  preview;
  error;
  isLoading = true;
  isExporting = false;
  includeExported = false;
  showPayload = false;
  results;

  connectedCallback() {
    this.load();
  }

  async load() {
    try {
      if (this.isLocal) {
        this.localRecords = await loadLocalByIds(this.recordIds);
        return;
      }
      this.preview = await previewJiraExport({ recordIds: this.recordIds });
    } catch (error) {
      this.error = reduceErrors(error);
    } finally {
      this.isLoading = false;
    }
  }

  get status() {
    return this.preview?.status;
  }

  get notConfigured() {
    return this.status && !this.status.configured;
  }

  get destination() {
    if (!this.status) {
      return "";
    }
    return `${this.status.siteUrl} · project ${this.status.projectKey} · ${this.status.issueType}`;
  }

  get items() {
    return (this.preview?.items || []).map((item) => ({
      ...item,
      labelsText: (item.labels || []).join(", "),
      hasExisting: !!item.existingKey,
      willSkip: !!item.existingKey && !this.includeExported
    }));
  }

  get alreadyExportedCount() {
    return this.items.filter((item) => item.hasExisting).length;
  }

  get hasAlreadyExported() {
    return this.alreadyExportedCount > 0;
  }

  get toCreateCount() {
    return this.items.filter((item) => !item.willSkip).length;
  }

  get createLabel() {
    const count = this.toCreateCount;
    return this.isExporting
      ? "Creating…"
      : `Create ${count} Jira issue${count === 1 ? "" : "s"}`;
  }

  get showCreate() {
    return !this.results;
  }

  get createDisabled() {
    return (
      this.isExporting ||
      this.notConfigured ||
      this.toCreateCount === 0 ||
      !!this.results
    );
  }

  get payloadLabel() {
    return this.showPayload
      ? "Hide the Jira payload"
      : "Show the Jira payload of the first issue";
  }

  get resultRows() {
    return (this.results || []).map((result) => ({
      ...result,
      key: result.recommendationId,
      created: !!result.issueKey && !result.skipped,
      className: `result${result.error ? " result-error" : ""}`
    }));
  }

  get createdCount() {
    return (this.results || []).filter((r) => r.issueKey && !r.skipped).length;
  }

  get summaryText() {
    const failed = (this.results || []).filter((r) => r.error).length;
    const skipped = (this.results || []).filter((r) => r.skipped).length;
    return `${this.createdCount} created · ${skipped} already in Jira · ${failed} failed`;
  }

  handleInclude(event) {
    this.includeExported = event.target.checked;
  }

  handleTogglePayload() {
    this.showPayload = !this.showPayload;
  }

  async handleCreate() {
    this.isExporting = true;
    this.error = undefined;
    try {
      this.results = await exportToJira({
        recordIds: this.recordIds,
        includeExported: this.includeExported
      });
    } catch (error) {
      this.error = reduceErrors(error);
    } finally {
      this.isExporting = false;
    }
  }

  handleClose() {
    this.close({
      exported: this.isLocal ? this.downloadedCount : this.createdCount
    });
  }

  // ---------- Fichier CSV (édition sans objet) ----------

  get localItems() {
    return this.localRecords.map((rec) => {
      const row = toRow(rec);
      return {
        key: row.id,
        summary: `[${row.name}] ${row.title || ""}`,
        priority: JIRA_PRIORITIES[row.severity] || "Medium",
        labelsText: jiraLabels(row).join(", "),
        exportedAt: row.jiraExportedAt,
        willSkip: !!row.jiraExportedAt && !this.includeExported
      };
    });
  }

  get localPreviouslyExported() {
    return this.localItems.some((item) => item.exportedAt);
  }

  get localSelection() {
    return this.localRecords.filter(
      (rec) => this.includeExported || !rec.JiraExportedAt__c
    );
  }

  get downloadLabel() {
    const count = this.localSelection.length;
    return `Download CSV (${count} issue${count === 1 ? "" : "s"})`;
  }

  get downloadDisabled() {
    return !this.localSelection.length || !this.issueType.trim();
  }

  handleIssueType(event) {
    this.issueType = event.target.value || "";
  }

  async handleDownload() {
    const records = this.localSelection;
    try {
      downloadText(
        `jira-import-${todayIso()}.csv`,
        buildJiraCsv(records, { issueType: this.issueType.trim() }),
        "text/csv"
      );
      await markJiraExported(records.map((rec) => rec.Id));
      this.downloadedCount += records.length;
      this.localRecords = await loadLocalByIds(this.recordIds);
    } catch (error) {
      this.error = reduceErrors(error);
    }
  }
}
