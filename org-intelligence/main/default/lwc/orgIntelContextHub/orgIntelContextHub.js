import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import {
  copyText,
  downloadText,
  exportRows as exportTable,
  formatExportDate,
  formatDateTime,
  formatNumber,
  reduceErrors,
  severityMeta
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import {
  downloadJson,
  loadValue,
  pushHistory,
  removeValue,
  saveValue,
  STORE_KEYS
} from "c/orgIntelStore";
import {
  COLLABORATIVE_MODE,
  loadLocalRecommendations,
  recommendationsMode
} from "c/orgIntelRecommendationStore";
import {
  buildMarkdown,
  dependenciesFor,
  fileNameFor,
  fromCollaborative,
  isCollaborativeId,
  localOptions,
  resolveLocal
} from "./contextModel";

// Actions Apex des modules (via le contrôleur générique du socle)
const listRecommendations = moduleAction(
  "recommendations",
  "listRecommendations"
);
const getRecommendation = moduleAction("recommendations", "getRecommendation");
const prepareContext = moduleAction("contextHub", "prepareContext");

/** Historique local des exports (résumés, sans contenu). */
const HISTORY_KEY = `${STORE_KEYS.CONTEXT_HUB}.exports`;
const HISTORY_SIZE = 30;

const PREVIEW_DELAY_MS = 250;

const SECTION_OPTIONS = [
  {
    value: "prompt",
    label: "Request to the assistant",
    help: "Structured prompt asking for a diagnosis and a safe remediation plan."
  },
  {
    value: "problem",
    label: "Problem",
    help: "Severity, category, component, rule, detection dates, suggested action."
  },
  {
    value: "evidence",
    label: "Evidence and justification",
    help: "Facts measured by the rule (lines, values, thresholds)."
  },
  {
    value: "components",
    label: "Affected components",
    help: "List of the components concerned."
  },
  {
    value: "dependencies",
    label: "Known dependencies",
    help: "What the components use and what uses them (Tooling API scans)."
  },
  {
    value: "history",
    label: "Decision history",
    help: "Status, assignment and detection timeline."
  },
  {
    value: "related",
    label: "Other recommendations on the component",
    help: "Open and closed recommendations on the same component."
  },
  {
    value: "comments",
    label: "Selected comments",
    help: "Only the comments you tick below."
  }
];
const DEFAULT_SECTIONS = [
  "prompt",
  "problem",
  "evidence",
  "components",
  "dependencies",
  "history"
];

/** Fichier d'une autre org (enveloppe du menu Data) : demande confirmation avant de l'ouvrir. */
async function confirmOtherOrg(envelope) {
  if (!envelope || envelope.sameOrg !== false) {
    return true;
  }
  return LightningConfirm.open({
    label: "File from another org",
    message: `This file was saved in ${envelope.orgName || "another org"}${envelope.isSandbox ? " (sandbox)" : ""}, not in this org. Open it anyway?`,
    theme: "warning"
  });
}

/**
 * Section « Context Hub » : préparation, aperçu et export Markdown du contexte d'une
 * recommandation pour une IA externe. L'utilisateur garde la main : rien n'est envoyé.
 *
 * Édition sans objet : les recommandations viennent du module collaboratif s'il est installé,
 * sinon du stockage local et du dernier scan gardé dans le navigateur. Le Markdown est produit
 * ici (contextModel) ; Apex masque les secrets et calcule l'empreinte. L'historique des exports
 * (résumés sans contenu) reste dans ce navigateur.
 */
export default class OrgIntelContextHub extends LightningElement {
  @api
  get recordId() {
    return this.selectedId;
  }
  set recordId(value) {
    if (value && value !== this.selectedId) {
      this.selectedId = value;
      if (this.ready) {
        this.loadSources();
      }
    }
  }

  ready = false;
  mode;
  recommendations = [];
  localRecommendations = {};
  latestScan;
  listError;
  selectedId = null;
  context;
  dependencies = [];
  sourcesError;
  isLoadingSources = false;
  sections = [...DEFAULT_SECTIONS];
  commentIds = [];
  result;
  previewError;
  isBuilding = false;
  exports = [];
  previewTimer;

  connectedCallback() {
    this.init();
  }

  disconnectedCallback() {
    clearTimeout(this.previewTimer);
  }

  async init() {
    await this.loadRecommendations();
    this.loadExports();
    this.ready = true;
    if (this.selectedId) {
      this.loadSources();
    }
  }

  get isCollaborative() {
    return this.mode === COLLABORATIVE_MODE;
  }

  async loadRecommendations() {
    try {
      const [mode, local, latestScan] = await Promise.all([
        recommendationsMode(),
        loadLocalRecommendations(),
        loadValue(STORE_KEYS.LATEST_SCAN)
      ]);
      this.mode = mode;
      this.localRecommendations = local || {};
      this.latestScan = latestScan;
      if (mode === COLLABORATIVE_MODE) {
        const data = await listRecommendations();
        this.recommendations = data?.rows || [];
      } else {
        this.recommendations = localOptions(
          this.localRecommendations,
          latestScan
        );
      }
      this.listError = undefined;
    } catch (error) {
      this.listError = error;
    }
  }

  async loadExports() {
    try {
      this.exports = (await loadValue(HISTORY_KEY, [])) || [];
    } catch {
      this.exports = [];
    }
  }

  get recommendationOptions() {
    return (this.recommendations || []).map((rec) => ({
      label: `${rec.name} · [${severityMeta(rec.severity).label}] ${rec.title}`,
      value: rec.id,
      description: `${rec.status || ""}${rec.componentName ? ` · ${rec.componentName}` : ""}`
    }));
  }

  get noRecommendation() {
    return this.ready && !this.listError && !this.recommendations.length;
  }

  handleRecommendation(event) {
    this.selectedId = event.detail.value;
    this.commentIds = [];
    this.loadSources();
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "contextHub", recordId: this.selectedId }
      })
    );
  }

  async loadSources() {
    this.isLoadingSources = true;
    this.result = undefined;
    try {
      let context;
      if (this.isCollaborative && isCollaborativeId(this.selectedId)) {
        context = fromCollaborative(
          await getRecommendation({ recordId: this.selectedId })
        );
      } else {
        context = resolveLocal(
          this.selectedId,
          this.localRecommendations,
          this.latestScan
        );
      }
      if (!context) {
        throw new Error(
          "This recommendation is not available in this browser any more."
        );
      }
      this.context = context;
      this.dependencies = dependenciesFor(context, this.latestScan);
      this.sourcesError = undefined;
      this.schedulePreview(0);
    } catch (error) {
      this.sourcesError = error;
      this.context = undefined;
    } finally {
      this.isLoadingSources = false;
    }
  }

  // ---------- Sélection ----------

  get sectionOptions() {
    return SECTION_OPTIONS.map((option) => ({
      ...option,
      checked: this.sections.includes(option.value)
    }));
  }

  get comments() {
    return (this.context?.comments || []).map((comment) => ({
      ...comment,
      checked: this.commentIds.includes(comment.id),
      when: formatDateTime(comment.createdDate)
    }));
  }

  get hasComments() {
    return this.comments.length > 0;
  }

  get commentsHelp() {
    return this.isCollaborative
      ? "Comments are only exported when you tick them."
      : "Comments require the Recommendations module (collaborative edition).";
  }

  handleSectionToggle(event) {
    const value = event.target.dataset.value;
    this.sections = event.target.checked
      ? [...this.sections, value]
      : this.sections.filter((item) => item !== value);
    this.schedulePreview();
  }

  handleCommentToggle(event) {
    const id = event.target.dataset.id;
    this.commentIds = event.target.checked
      ? [...this.commentIds, id]
      : this.commentIds.filter((item) => item !== id);
    if (event.target.checked && !this.sections.includes("comments")) {
      this.sections = [...this.sections, "comments"];
    }
    this.schedulePreview();
  }

  handleSelectAllComments() {
    this.commentIds = (this.context?.comments || []).map(
      (comment) => comment.id
    );
    if (!this.sections.includes("comments")) {
      this.sections = [...this.sections, "comments"];
    }
    this.schedulePreview();
  }

  // ---------- Aperçu ----------

  schedulePreview(delay = PREVIEW_DELAY_MS) {
    clearTimeout(this.previewTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.previewTimer = setTimeout(() => this.buildPreview(), delay);
  }

  async buildPreview() {
    if (!this.context) {
      return;
    }
    this.isBuilding = true;
    try {
      const selectedComments = this.context.comments.filter((comment) =>
        this.commentIds.includes(comment.id)
      );
      const raw = buildMarkdown({
        context: this.context,
        sections: this.orderedSections,
        comments: selectedComments,
        dependencies: this.dependencies
      });
      const prepared = await prepareContext({ content: raw });
      this.result = { ...prepared, fileName: fileNameFor(this.context) };
      this.previewError = undefined;
    } catch (error) {
      this.previewError = error;
    } finally {
      this.isBuilding = false;
    }
  }

  get orderedSections() {
    return SECTION_OPTIONS.map((option) => option.value).filter((value) =>
      this.sections.includes(value)
    );
  }

  get hasPreview() {
    return !!this.result?.content;
  }

  get previewStats() {
    if (!this.result) {
      return "";
    }
    const tokens = Math.ceil(this.result.characterCount / 4);
    return `${formatNumber(this.result.characterCount)} chars · ≈ ${formatNumber(tokens)} tokens`;
  }

  get redactionText() {
    const count = this.result?.redactionCount || 0;
    return count
      ? `${count} secret value(s) masked.`
      : "No secret detected (passwords, tokens and session ids are always masked).";
  }

  get actionsDisabled() {
    return !this.hasPreview || this.isBuilding;
  }

  async handleCopy() {
    const copied = await copyText(this.result.content);
    if (!copied) {
      this.toast(
        "Copy blocked by the browser",
        "Select the preview text and copy it manually.",
        "warning"
      );
      return;
    }
    await this.record("Copy");
    this.toast(
      "Context copied",
      "Paste it into Claude, ChatGPT or another assistant.",
      "success"
    );
  }

  async handleDownload() {
    downloadText(this.result.fileName, this.result.content, "text/markdown");
    await this.record("Download");
    this.toast("Context downloaded", this.result.fileName, "success");
  }

  async record(action) {
    try {
      this.exports = await pushHistory(
        HISTORY_KEY,
        {
          id: `${Date.now()}`,
          exportedAt: new Date().toISOString(),
          recommendationId: this.selectedId,
          recommendationName: this.context?.name,
          recommendationTitle: this.context?.title,
          action,
          sections: this.orderedSections.join(", "),
          characterCount: this.result.characterCount,
          contentHash: this.result.contentHash
        },
        HISTORY_SIZE
      );
    } catch (error) {
      this.toast("Export not recorded", reduceErrors(error), "warning");
    }
  }

  // ---------- Historique des exports ----------

  get exportRows() {
    return (this.exports || []).map((row) => ({
      ...row,
      when: formatDateTime(row.exportedAt),
      size: formatNumber(row.characterCount),
      // le détail des sections passe en infobulle : seul le nombre reste affiché
      sectionCount: row.sections
        ? row.sections.split(",").filter((item) => item.trim()).length
        : 0
    }));
  }

  get hasExports() {
    return (this.exports || []).length > 0;
  }

  get noExports() {
    return !this.hasExports;
  }

  handleExportHistory(event) {
    exportTable({
      name: "context-export-history",
      format: event.detail.format,
      rows: this.exports || [],
      columns: [
        { label: "When", value: (row) => formatExportDate(row.exportedAt) },
        { label: "Recommendation", value: (row) => row.recommendationName },
        { label: "Title", value: (row) => row.recommendationTitle },
        { label: "Action", value: (row) => row.action },
        { label: "Sections", value: (row) => row.sections },
        { label: "Characters", value: (row) => row.characterCount },
        { label: "SHA-256", value: (row) => row.contentHash },
        { label: "Recommendation Id", value: (row) => row.recommendationId }
      ]
    });
  }

  async handleClearHistory() {
    try {
      await removeValue(HISTORY_KEY);
      this.exports = [];
    } catch (error) {
      this.toast("History not cleared", reduceErrors(error), "warning");
    }
  }

  handleSaveHistory() {
    const day = new Date().toISOString().slice(0, 10);
    downloadJson(
      `org-intelligence-context-exports-${day}.json`,
      "context-exports",
      {
        exports: this.exports || []
      }
    );
  }

  /** Fichier ouvert : les historiques sont réunis (dédoublonnés), le plus récent d'abord. */
  async handleOpenHistory(event) {
    if (!(await confirmOtherOrg(event.detail.envelope))) {
      return;
    }
    const incoming = event.detail.data?.exports;
    if (!Array.isArray(incoming)) {
      this.toast(
        "The file could not be opened",
        "This file contains no export history.",
        "error"
      );
      return;
    }
    const byKey = new Map();
    [...(this.exports || []), ...incoming].forEach((row) => {
      if (row && row.exportedAt) {
        byKey.set(`${row.exportedAt}|${row.contentHash || row.id}`, row);
      }
    });
    const merged = [...byKey.values()]
      .sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)))
      .slice(0, HISTORY_SIZE);
    try {
      await saveValue(HISTORY_KEY, merged);
      this.exports = merged;
      this.toast(
        "Export history merged",
        `${merged.length} export(s).`,
        "success"
      );
    } catch (error) {
      this.toast("History not saved", reduceErrors(error), "warning");
    }
  }

  handleDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  handleOpenExported(event) {
    event.preventDefault();
    this.selectedId = event.currentTarget.dataset.id;
    this.commentIds = [];
    this.loadSources();
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
