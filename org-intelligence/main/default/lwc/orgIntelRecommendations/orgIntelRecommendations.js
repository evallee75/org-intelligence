import { LightningElement, api, wire } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import hasAdminPermission from "@salesforce/customPermission/OrgIntelligence_Admin";
import { getRecord, getFieldValue } from "lightning/uiRecordApi";
import USER_ID from "@salesforce/user/Id";
import USER_NAME from "@salesforce/schema/User.Name";
import JiraExportModal from "c/orgIntelJiraExportModal";
import {
  COMPONENT_TYPES,
  REC_DOMAINS,
  REC_STATUSES,
  SEVERITIES,
  componentTypeLabel,
  exportRows,
  formatExportDate,
  formatDate,
  formatRelative,
  initials,
  recStatusTone,
  reduceErrors,
  severityMeta,
  todayIso
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import { downloadJson, readJsonEnvelope } from "c/orgIntelStore";
import {
  LOCAL_MODE,
  RECOMMENDATIONS_FILE_KIND,
  applyLocalChanges,
  clearLocalRecommendations,
  countLocalRecommendations,
  deleteLocalRecommendations,
  exportLocalRecommendations,
  exportSharedRecommendations,
  importLocalRecommendations,
  listLocalRecommendations,
  onLocalRecommendationsChange,
  pushDecisionsToShared,
  recommendationsMode
} from "c/orgIntelRecommendationStore";

// Actions Apex du module (via le contrôleur générique du socle)
const listRecommendations = moduleAction(
  "recommendations",
  "listRecommendations"
);
const updateRecommendations = moduleAction(
  "recommendations",
  "updateRecommendations"
);

const ALL = "";
const REASON_REQUIRED = ["Ignored", "Resolved"];
const PAGE_SIZE = 50;

/**
 * Vues rapides : prédicats sur une ligne (contexte : utilisateur courant, date du jour).
 * `collaborative` : vue liée à l'assignation, absente de l'édition sans objet.
 */
const VIEWS = [
  { name: "open", label: "Open", test: (row) => row.isOpen },
  {
    name: "mine",
    label: "Assigned to me",
    collaborative: true,
    test: (row, ctx) => row.isOpen && row.assignedToId === ctx.userId
  },
  {
    name: "unassigned",
    label: "Unassigned",
    collaborative: true,
    test: (row) => row.isOpen && !row.assignedToId
  },
  {
    name: "overdue",
    label: "Overdue",
    alert: true,
    test: (row, ctx) => row.isOpen && !!row.dueDate && row.dueDate < ctx.today
  },
  {
    name: "decision",
    label: "To decide",
    test: (row) => row.status === "New" || row.status === "To Review"
  },
  {
    name: "gone",
    label: "No longer detected",
    test: (row) => row.isOpen && row.stillDetected === false
  },
  { name: "closed", label: "Closed", test: (row) => !row.isOpen },
  { name: "all", label: "All", test: () => true }
];

const SEVERITY_RANK = Object.fromEntries(
  SEVERITIES.map((severity, index) => [severity.value, index])
);

const SORTS = [
  { value: "severity", label: "Severity" },
  { value: "due", label: "Due date" },
  { value: "detected", label: "Last detected" },
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title" },
  { value: "status", label: "Status" }
];

const STATUS_RANK = Object.fromEntries(
  REC_STATUSES.map((status, index) => [status.value, index])
);

const time = (value) => (value ? new Date(value).getTime() : 0);

const COMPARATORS = {
  severity: (a, b) =>
    (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) ||
    time(b.lastDetectedAt) - time(a.lastDetectedAt),
  due: (a, b) =>
    (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
    (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99),
  detected: (a, b) => time(b.lastDetectedAt) - time(a.lastDetectedAt),
  updated: (a, b) => time(b.lastModifiedDate) - time(a.lastModifiedDate),
  title: (a, b) => (a.title || "").localeCompare(b.title || ""),
  status: (a, b) =>
    (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99) ||
    (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99)
};

const DOMAIN_COLORS = Object.fromEntries(
  REC_DOMAINS.map((domain) => [domain.value, domain.color])
);

/**
 * Section « Recommendations » : liste filtrable par domaine, vue, gravité et texte ; actions
 * groupées ; détail collaboratif dans un panneau latéral.
 */
export default class OrgIntelRecommendations extends LightningElement {
  /** Modules installés (transmis au panneau : export vers le Context Hub). */
  @api modules = [];

  @api
  get recordId() {
    return this.selectedId;
  }
  set recordId(value) {
    if (value) {
      this.selectedId = value;
    }
  }

  /** Gravité présélectionnée (lien « View all High » de la vue d'ensemble). */
  @api
  get severity() {
    return this.severities[0];
  }
  set severity(value) {
    this.severities = value ? [value] : [];
  }

  /** Recherche présélectionnée (depuis la vue d'ensemble). */
  @api
  get searchTerm() {
    return this.search;
  }
  set searchTerm(value) {
    this.search = value || "";
  }

  data;
  error;
  isLoading = true;
  /** Édition : « local » (navigateur) ou « collaborative » (module Recommendations). */
  mode;
  selectedId = null;
  view = "open";
  domain = ALL;
  search = "";
  severities = [];
  category = ALL;
  componentType = ALL;
  sortBy = "severity";
  limit = PAGE_SIZE;
  selectedIds = [];
  showMoreFilters = false;

  bulkStatus = ALL;
  bulkReason = "";
  bulkAssignee = null;
  bulkDueDate = null;
  bulkSeverity = ALL;
  bulkOwner = "";
  bulkNote = "";
  isApplying = false;
  isImporting = false;
  isPushing = false;
  /** Recommandations encore gardées dans ce navigateur alors que le module est installé. */
  localCount = 0;
  isAdmin = !!hasAdminPermission;
  fileKind = RECOMMENDATIONS_FILE_KIND;

  @wire(getRecord, { recordId: USER_ID, fields: [USER_NAME] })
  currentUser;

  get userName() {
    return this.currentUser?.data
      ? getFieldValue(this.currentUser.data, USER_NAME)
      : null;
  }

  sortOptions = SORTS;
  userFilter = {
    criteria: [
      { fieldPath: "IsActive", operator: "eq", value: true },
      { fieldPath: "UserType", operator: "eq", value: "Standard" }
    ],
    filterLogic: "1 AND 2"
  };

  connectedCallback() {
    this.load();
    // Décisions prises dans un autre onglet (ou par un scan) : la liste locale est relue
    this.unsubscribe = onLocalRecommendationsChange(() => {
      if (this.isLocal) {
        this.load();
      } else if (this.isCollaborative) {
        this.refreshLocalCount();
      }
    });
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async load(refresh = false) {
    this.isLoading = !this.data;
    try {
      this.mode = await recommendationsMode({ refresh });
      this.data = this.isLocal
        ? await listLocalRecommendations()
        : await listRecommendations();
      this.error = undefined;
      await this.refreshLocalCount();
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  async refreshLocalCount() {
    if (!this.isCollaborative || !this.isAdmin) {
      this.localCount = 0;
      return;
    }
    try {
      this.localCount = await countLocalRecommendations();
    } catch {
      this.localCount = 0; // stockage illisible : rien à proposer
    }
  }

  get isLocal() {
    return this.mode === LOCAL_MODE;
  }

  get isCollaborative() {
    return !!this.mode && !this.isLocal;
  }

  get subtitle() {
    return this.isLocal
      ? "Decide and track."
      : "Assign, discuss with @mentions, decide and track.";
  }

  get titleHelp() {
    return "One recommendation per rule and component, created by the scanner and the analyses. Decisions are never overwritten by a new detection, and nothing is ever changed in the org automatically.";
  }

  get browserHelp() {
    return "Without the Recommendations module, recommendations and decisions stay in this browser. Use the Data menu to save them to a file and share it with another administrator, who opens it (the most recent change wins).";
  }

  get openLabel() {
    return this.isLocal
      ? "Open a file…"
      : "Push a file to shared recommendations…";
  }

  get canChangeSeverity() {
    return this.isLocal || this.isAdmin;
  }

  /** Export Jira par l'API (édition collaborative) : administrateurs ; fichier CSV en local. */
  get canExportJira() {
    return this.isLocal || this.isAdmin;
  }

  get showPushBanner() {
    return this.isCollaborative && this.isAdmin && this.localCount > 0;
  }

  get pushText() {
    const count = this.localCount;
    return `${count} recommendation${count === 1 ? " is" : "s are"} still stored in this browser, with their decisions.`;
  }

  get availableViews() {
    return VIEWS.filter((view) => !view.collaborative || !this.isLocal);
  }

  get context() {
    return { userId: this.data?.currentUserId, today: todayIso() };
  }

  get allRows() {
    return this.data?.rows || [];
  }

  get hasData() {
    return this.allRows.length > 0;
  }

  get currentView() {
    return (
      this.availableViews.find((item) => item.name === this.view) || VIEWS[0]
    );
  }

  // ---------- Filtres (chaque filtre peut être ignoré pour calculer ses propres compteurs) ----------

  matches(row, skip = {}) {
    const term = this.search.trim().toLowerCase();
    return (
      (skip.view || this.currentView.test(row, this.context)) &&
      (skip.domain ||
        !this.domain ||
        (row.domain || "Other") === this.domain) &&
      (skip.severity ||
        !this.severities.length ||
        this.severities.includes(row.severity)) &&
      (!this.category || row.category === this.category) &&
      (!this.componentType || row.componentType === this.componentType) &&
      (!term ||
        `${row.name} ${row.title} ${row.componentName} ${row.ruleCode} ${row.assignedToName || ""}`
          .toLowerCase()
          .includes(term))
    );
  }

  // ---------- Domaines ----------

  get domainTabs() {
    const rows = this.allRows.filter((row) =>
      this.matches(row, { domain: true })
    );
    const tab = (value, label, icon, color, description) => {
      const inDomain = value
        ? rows.filter((row) => (row.domain || "Other") === value)
        : rows;
      const urgent = inDomain.filter(
        (row) => row.severity === "Critical" || row.severity === "High"
      ).length;
      const selected = this.domain === value;
      return {
        key: value || "all",
        value,
        label,
        icon,
        description,
        count: inDomain.length,
        urgent,
        hasUrgent: urgent > 0,
        urgentTitle: `${urgent} critical or high`,
        className: `domain${selected ? " domain-selected" : ""}${inDomain.length ? "" : " domain-empty"}`,
        style: `--domain-color:${color}`,
        selected: selected ? "true" : "false"
      };
    };
    const tabs = [
      tab(ALL, "All domains", "utility:layers", "#3e4a59", "Every domain")
    ];
    for (const domain of REC_DOMAINS) {
      const total = this.allRows.filter(
        (row) => (row.domain || "Other") === domain.value
      ).length;
      if (domain.value !== "Other" || total) {
        tabs.push(
          tab(
            domain.value,
            domain.label,
            domain.icon,
            domain.color,
            domain.description
          )
        );
      }
    }
    return tabs;
  }

  handleDomain(event) {
    this.domain = event.currentTarget.dataset.value;
    this.resetPaging();
  }

  // ---------- Vues ----------

  get views() {
    return this.availableViews.map((view) => {
      const count = this.allRows.filter(
        (row) =>
          view.test(row, this.context) && this.matches(row, { view: true })
      ).length;
      const selected = view.name === this.view;
      return {
        name: view.name,
        label: view.label,
        count,
        className: `view${selected ? " view-selected" : ""}`,
        countClass: `view-count${view.alert && count ? " view-count-alert" : ""}`,
        selected: selected ? "true" : "false"
      };
    });
  }

  handleView(event) {
    this.view = event.currentTarget.dataset.name;
    this.resetPaging();
  }

  // ---------- Gravité (pastilles) ----------

  get severityChips() {
    const rows = this.allRows.filter((row) =>
      this.matches(row, { severity: true })
    );
    return SEVERITIES.map((severity) => {
      const count = rows.filter(
        (row) => row.severity === severity.value
      ).length;
      const active = this.severities.includes(severity.value);
      return {
        value: severity.value,
        label: severity.label,
        count,
        className: `chip chip-${severity.tone}${active ? " chip-active" : ""}${count ? "" : " chip-empty"}`,
        pressed: active ? "true" : "false"
      };
    });
  }

  handleSeverityChip(event) {
    const value = event.currentTarget.dataset.value;
    this.severities = this.severities.includes(value)
      ? this.severities.filter((item) => item !== value)
      : [...this.severities, value];
    this.resetPaging();
  }

  // ---------- Autres filtres ----------

  get categoryOptions() {
    const categories = [
      ...new Set(this.allRows.map((row) => row.category).filter(Boolean))
    ].sort();
    return [
      { label: "All categories", value: ALL },
      ...categories.map((value) => ({ label: value, value }))
    ];
  }

  get typeOptions() {
    return [
      { label: "All component types", value: ALL },
      ...COMPONENT_TYPES.map((t) => ({ label: t.label, value: t.value }))
    ];
  }

  get hasActiveFilters() {
    return (
      !!this.search ||
      this.severities.length > 0 ||
      !!this.category ||
      !!this.componentType
    );
  }

  get moreFiltersLabel() {
    const count = (this.category ? 1 : 0) + (this.componentType ? 1 : 0);
    return count ? `Filters (${count})` : "Filters";
  }

  handleToggleFilters() {
    this.showMoreFilters = !this.showMoreFilters;
  }

  handleSearch(event) {
    this.search = event.target.value || "";
    this.resetPaging();
  }

  handleCategory(event) {
    this.category = event.detail.value;
    this.resetPaging();
  }

  handleComponentType(event) {
    this.componentType = event.detail.value;
    this.resetPaging();
  }

  handleSort(event) {
    this.sortBy = event.detail.value;
  }

  handleReset() {
    this.search = "";
    this.severities = [];
    this.category = ALL;
    this.componentType = ALL;
    this.resetPaging();
  }

  resetPaging() {
    this.limit = PAGE_SIZE;
    this.selectedIds = [];
  }

  // ---------- Liste ----------

  get filteredRows() {
    return this.allRows
      .filter((row) => this.matches(row))
      .sort(COMPARATORS[this.sortBy] || COMPARATORS.severity);
  }

  get filteredCount() {
    return this.filteredRows.length;
  }

  get countText() {
    const count = this.filteredCount;
    return `${count} recommendation${count === 1 ? "" : "s"}`;
  }

  get hasRows() {
    return this.filteredCount > 0;
  }

  toView(row) {
    const today = todayIso();
    const meta = severityMeta(row.severity);
    const overdue = row.isOpen && !!row.dueDate && row.dueDate < today;
    const dueSoon =
      row.isOpen && !!row.dueDate && !overdue && row.dueDate <= this.inDays(7);
    const selected = this.selectedIds.includes(row.id);
    const active = row.id === this.selectedId;
    return {
      ...row,
      severityLabel: meta.label,
      severityTone: meta.tone,
      statusTone: recStatusTone(row.status),
      domainLabel: row.domain || "Other",
      domainStyle: `--domain-color:${DOMAIN_COLORS[row.domain || "Other"] || "#5c6470"}`,
      typeLabel: componentTypeLabel(row.componentType),
      detectedText: row.lastDetectedAt
        ? `detected ${formatRelative(row.lastDetectedAt)}`
        : null,
      gone: row.isOpen && row.stillDetected === false,
      assigneeInitials: initials(row.assignedToName),
      hasAssignee: !!row.assignedToId,
      dueText: row.dueDate ? formatDate(row.dueDate) : null,
      dueClass: `due${overdue ? " due-overdue" : dueSoon ? " due-soon" : ""}`,
      dueTitle: overdue
        ? "Overdue"
        : dueSoon
          ? "Due within 7 days"
          : "Due date",
      hasComments: row.commentCount > 0,
      showOwner: this.isLocal && !!row.owner,
      isSelected: selected,
      checkboxLabel: `Select ${row.name}`,
      rowClass: `row row-${meta.tone}${active ? " row-active" : ""}${selected ? " row-selected" : ""}`
    };
  }

  inDays(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return todayIso(date);
  }

  /** Lignes affichées, groupées par gravité quand on trie par gravité. */
  get groups() {
    const rows = this.filteredRows
      .slice(0, this.limit)
      .map((row) => this.toView(row));
    if (this.sortBy !== "severity") {
      return [{ key: "all", showHeader: false, rows }];
    }
    const groups = [];
    for (const row of rows) {
      let group = groups[groups.length - 1];
      if (!group || group.severity !== row.severity) {
        const total = this.filteredRows.filter(
          (item) => item.severity === row.severity
        ).length;
        group = {
          key: row.severity || "none",
          severity: row.severity,
          showHeader: true,
          label: row.severityLabel,
          tone: row.severityTone,
          headerClass: `group group-${row.severityTone}`,
          count: total,
          rows: []
        };
        groups.push(group);
      }
      group.rows.push(row);
    }
    return groups;
  }

  get hasMore() {
    return this.filteredCount > this.limit;
  }

  get moreLabel() {
    return `Show ${Math.min(PAGE_SIZE, this.filteredCount - this.limit)} more`;
  }

  handleShowMore() {
    this.limit += PAGE_SIZE;
  }

  get listClass() {
    return `list${this.selectedId ? " list-compact" : ""}`;
  }

  handleRowClick(event) {
    this.open(event.currentTarget.dataset.id);
  }

  handleRowKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.open(event.currentTarget.dataset.id);
    }
  }

  stop(event) {
    event.stopPropagation();
  }

  handleSelect(event) {
    event.stopPropagation();
    const id = event.target.dataset.id;
    this.selectedIds = event.target.checked
      ? [...this.selectedIds, id]
      : this.selectedIds.filter((item) => item !== id);
  }

  get visibleIds() {
    return this.filteredRows.slice(0, this.limit).map((row) => row.id);
  }

  get allVisibleSelected() {
    return (
      this.visibleIds.length > 0 &&
      this.visibleIds.every((id) => this.selectedIds.includes(id))
    );
  }

  handleSelectAll(event) {
    this.selectedIds = event.target.checked ? [...this.visibleIds] : [];
  }

  open(recordId) {
    this.selectedId = recordId;
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "recommendations", recordId }
      })
    );
  }

  // ---------- Panneau ----------

  get layoutClass() {
    return `layout${this.selectedId ? " layout-split" : ""}`;
  }

  handlePanelClose() {
    this.selectedId = null;
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "recommendations", recordId: null }
      })
    );
  }

  handlePanelChanged() {
    this.load();
  }

  handlePanelSelect(event) {
    this.open(event.detail.recordId);
  }

  handlePanelNavigate(event) {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("navigate", { detail: event.detail }));
  }

  // ---------- Actions groupées ----------

  get hasSelection() {
    return this.selectedIds.length > 0;
  }

  get selectionText() {
    return `${this.selectedIds.length} selected`;
  }

  get bulkStatusOptions() {
    return [
      { label: "Keep status", value: ALL },
      ...REC_STATUSES.map((s) => ({ label: s.label, value: s.value }))
    ];
  }

  get bulkReasonRequired() {
    return REASON_REQUIRED.includes(this.bulkStatus);
  }

  get bulkSeverityOptions() {
    return [
      { label: "Keep severity", value: ALL },
      ...SEVERITIES.map((s) => ({ label: s.label, value: s.value }))
    ];
  }

  get bulkApplyDisabled() {
    return (
      this.isApplying ||
      (!this.bulkStatus &&
        !this.bulkAssignee &&
        !this.bulkDueDate &&
        !this.bulkSeverity &&
        !this.bulkOwner.trim() &&
        !this.bulkNote.trim()) ||
      (this.bulkReasonRequired && !this.bulkReason.trim())
    );
  }

  handleBulkOwner(event) {
    this.bulkOwner = event.target.value || "";
  }

  handleBulkNote(event) {
    this.bulkNote = event.target.value || "";
  }

  handleBulkDueDate(event) {
    this.bulkDueDate = event.target.value || null;
  }

  handleBulkSeverity(event) {
    this.bulkSeverity = event.detail.value;
  }

  handleBulkStatus(event) {
    this.bulkStatus = event.detail.value;
  }

  handleBulkReason(event) {
    this.bulkReason = event.target.value || "";
  }

  handleBulkAssignee(event) {
    this.bulkAssignee = event.detail.recordId || null;
  }

  handleClearSelection() {
    this.selectedIds = [];
    this.bulkStatus = ALL;
    this.bulkReason = "";
    this.bulkAssignee = null;
    this.bulkDueDate = null;
    this.bulkSeverity = ALL;
    this.bulkOwner = "";
    this.bulkNote = "";
  }

  async handleBulkApply() {
    const changes = {};
    if (this.bulkStatus) {
      changes.status = this.bulkStatus;
      if (this.bulkReason.trim()) {
        changes.decisionReason = this.bulkReason.trim();
      }
    }
    if (this.bulkAssignee && !this.isLocal) {
      changes.assignedToId = this.bulkAssignee;
    }
    if (this.bulkDueDate) {
      changes.dueDate = this.bulkDueDate;
    }
    if (this.bulkSeverity) {
      changes.severity = this.bulkSeverity;
    }
    if (this.isLocal && this.bulkOwner.trim()) {
      changes.owner = this.bulkOwner.trim();
    }
    if (this.isLocal && this.bulkNote.trim()) {
      changes.appendNote = this.bulkNote.trim();
    }
    this.isApplying = true;
    try {
      const count = this.isLocal
        ? await applyLocalChanges(this.selectedIds, changes, {
            userName: this.userName
          })
        : await updateRecommendations({
            recordIds: this.selectedIds,
            changesJson: JSON.stringify(changes)
          });
      this.dispatchEvent(
        new ShowToastEvent({
          title: "Recommendations updated",
          message: `${count} recommendation(s) updated.${changes.assignedToId ? " The assignee is notified." : ""}`,
          variant: "success"
        })
      );
      this.handleClearSelection();
      await this.load();
      this.template
        .querySelector("c-org-intel-recommendation-panel")
        ?.refresh();
    } catch (error) {
      this.dispatchEvent(
        new ShowToastEvent({
          title: "Not updated",
          message: reduceErrors(error),
          variant: "error"
        })
      );
    } finally {
      this.isApplying = false;
    }
  }

  // ---------- Export ----------

  async handleExportJira() {
    const result = await JiraExportModal.open({
      size: "medium",
      label: this.isLocal ? "Jira import file" : "Export to Jira",
      recordIds: [...this.selectedIds],
      mode: this.mode
    });
    if (result?.exported > 0) {
      this.handleClearSelection();
      await this.load();
      this.template
        .querySelector("c-org-intel-recommendation-panel")
        ?.refresh();
    }
  }

  /** Export des recommandations affichées (filtres, onglet de domaine et tri compris). */
  handleExport(event) {
    exportRows({
      name: "recommendations",
      format: event.detail.format,
      rows: this.filteredRows,
      columns: [
        { label: "Number", value: (row) => row.name },
        { label: "Title", value: (row) => row.title },
        { label: "Severity", value: (row) => row.severity },
        { label: "Domain", value: (row) => row.domain || "Other" },
        { label: "Category", value: (row) => row.category },
        { label: "Confidence", value: (row) => row.confidence },
        { label: "Status", value: (row) => row.status },
        {
          label: "Component type",
          value: (row) => componentTypeLabel(row.componentType)
        },
        { label: "Component", value: (row) => row.componentName },
        { label: "Rule", value: (row) => row.ruleCode },
        { label: "Assigned to", value: (row) => row.assignedToName },
        {
          label: "Due date",
          value: (row) => formatExportDate(row.dueDate, false)
        },
        { label: "Still detected", value: (row) => !!row.stillDetected },
        {
          label: "Last detected",
          value: (row) => formatExportDate(row.lastDetectedAt)
        },
        { label: "Occurrences", value: (row) => row.occurrenceCount },
        { label: "Comments", value: (row) => row.commentCount },
        { label: "Record Id", value: (row) => row.id }
      ]
    });
  }

  handleRefresh() {
    this.load(true);
    this.template.querySelector("c-org-intel-recommendation-panel")?.refresh();
  }

  // ---------- Partage entre administrateurs (édition sans objet) ----------

  get exportJiraLabel() {
    return this.isLocal ? "Jira file" : "Export to Jira";
  }

  get exportJiraTitle() {
    return this.isLocal
      ? "Download a CSV file to import into Jira"
      : "Create Jira issues";
  }

  // ---------- Menu Data (fichier JSON) ----------

  async handleDataSave() {
    try {
      const data = this.isLocal
        ? await exportLocalRecommendations()
        : await exportSharedRecommendations();
      downloadJson(
        `org-intelligence-recommendations-${todayIso()}.json`,
        RECOMMENDATIONS_FILE_KIND,
        data
      );
    } catch (error) {
      this.toast("Not saved", reduceErrors(error), "error");
    }
  }

  handleDataOpen(event) {
    this.openEnvelope(event.detail.envelope || { data: event.detail.data });
  }

  /** Fichier d'une autre org (sameOrg = false) : confirmation avant de l'importer. */
  async openEnvelope(envelope) {
    if (envelope && envelope.sameOrg === false) {
      const ok = await LightningConfirm.open({
        label: "File from another org",
        message: `This file was saved in another org${envelope.orgName ? ` (${envelope.orgName})` : ""}. Import its recommendations here anyway?`,
        theme: "warning"
      });
      if (!ok) {
        return;
      }
    }
    await this.importData(envelope.data);
  }

  handleDataError(event) {
    this.toast("Not opened", event.detail.message, "error");
  }

  async handleDataClear() {
    try {
      await clearLocalRecommendations();
      this.selectedId = null;
      this.handleClearSelection();
      this.toast(
        "Recommendations cleared",
        "The recommendations stored in this browser were deleted.",
        "success"
      );
      await this.load();
    } catch (error) {
      this.toast("Not cleared", reduceErrors(error), "error");
    }
  }

  /** Bouton « Open a file » de l'état vide (même traitement que le menu Data). */
  handleImportClick() {
    const input = this.template.querySelector("input.import-file");
    if (input) {
      input.value = null;
      input.click();
    }
  }

  async handleImportFile(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) {
      return;
    }
    try {
      const envelope = await readJsonEnvelope(file, RECOMMENDATIONS_FILE_KIND);
      await this.openEnvelope(envelope);
    } catch (error) {
      this.toast("Not opened", reduceErrors(error), "error");
    } finally {
      input.value = "";
    }
  }

  /**
   * Fichier ouvert : fusion dans ce navigateur (le plus récent gagne), ou reprise dans les
   * recommandations partagées (édition collaborative, administrateurs).
   */
  async importData(data) {
    if (this.isCollaborative) {
      if (!this.isAdmin) {
        this.toast(
          "Not imported",
          "Only Org Intelligence administrators can push a file to the shared recommendations.",
          "error"
        );
        return;
      }
      await this.push(data);
      return;
    }
    this.isImporting = true;
    try {
      const counts = await importLocalRecommendations(data);
      this.toast(
        "Recommendations imported",
        `${counts.added} added, ${counts.updated} merged${counts.removed ? `, ${counts.removed} removed` : ""} (the most recent change wins).`,
        "success"
      );
      await this.load();
      this.template
        .querySelector("c-org-intel-recommendation-panel")
        ?.refresh();
    } catch (error) {
      this.toast("Not imported", reduceErrors(error), "error");
    } finally {
      this.isImporting = false;
    }
  }

  // ---------- Passage local → collaboratif ----------

  handlePushLocal() {
    this.push(null);
  }

  /** Reprise des décisions (fichier, ou recommandations de ce navigateur si `data` est vide). */
  async push(data) {
    const fromBrowser = !data;
    this.isPushing = true;
    try {
      const totals = await pushDecisionsToShared(data);
      this.toast(
        "Decisions pushed",
        `${totals.created} created, ${totals.updated} updated, ${totals.skipped} kept (a more recent shared decision exists).`,
        "success"
      );
      await this.load();
      if (fromBrowser) {
        const clear = await LightningConfirm.open({
          label: "Clear the local copies?",
          message:
            "The recommendations and decisions are now shared. Delete the copies stored in this browser?",
          theme: "info"
        });
        if (clear) {
          await clearLocalRecommendations();
          this.localCount = 0;
        }
      }
    } catch (error) {
      this.toast("Not pushed", reduceErrors(error), "error");
    } finally {
      this.isPushing = false;
    }
  }

  // ---------- Effacement local ----------

  async handleBulkDelete() {
    const count = this.selectedIds.length;
    const ok = await LightningConfirm.open({
      label: "Delete recommendations",
      message: `Delete ${count} recommendation${count === 1 ? "" : "s"} from this browser? A new detection creates them again; mark them Ignored to keep them out.`,
      theme: "warning"
    });
    if (!ok) {
      return;
    }
    this.isApplying = true;
    try {
      const deleted = await deleteLocalRecommendations(this.selectedIds);
      if (this.selectedIds.includes(this.selectedId)) {
        this.handlePanelClose();
      }
      this.handleClearSelection();
      this.toast(
        "Recommendations deleted",
        `${deleted} recommendation(s) deleted.`,
        "success"
      );
      await this.load();
    } catch (error) {
      this.toast("Not deleted", reduceErrors(error), "error");
    } finally {
      this.isApplying = false;
    }
  }

  // ---------- Navigation ----------

  handleOpenModules() {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: { section: "modules" } })
    );
  }

  handleNewScan() {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: { section: "overview" } })
    );
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
