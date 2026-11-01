import { LightningElement, api } from "lwc";
import {
  loadLatestScan,
  loadScanHistory,
  loadFindingSnapshots,
  summarizeScan,
  severityCountList,
  findingRows,
  filterComponents,
  compareFindings,
  currentScore,
  SEVERITY_ORDER as SEVERITY_RANK
} from "c/orgIntelScanData";
import { viewedScan, loadScoreContext } from "c/orgIntelScanControl";
import {
  COMPONENT_TYPES,
  SCAN_SCOPES,
  SEVERITIES,
  componentTypeLabel,
  exportRows,
  formatExportDate,
  formatDuration,
  formatNumber,
  formatRelative,
  scanStatusTone,
  scoreBand,
  severityIcon,
  severityMeta
} from "c/orgIntelUtils";

const SEARCH_DELAY_MS = 300;
/** Au-delà de cette longueur, un message du journal est tronqué sur une ligne et dépliable. */
const LOG_CLAMP_LENGTH = 140;
const ALL = "";

const FINDING_COLUMNS = [
  {
    label: "Severity",
    fieldName: "severity",
    sortable: true,
    initialWidth: 110,
    cellAttributes: {
      iconName: { fieldName: "severityIcon" },
      iconAlternativeText: { fieldName: "severity" }
    }
  },
  {
    // Clic : détail du constat (description, preuve, catégorie, règle) sous la liste
    label: "Finding",
    fieldName: "title",
    type: "button",
    sortable: true,
    wrapText: true,
    typeAttributes: {
      label: { fieldName: "title" },
      title: { fieldName: "findingTooltip" },
      name: "finding",
      variant: "base"
    }
  },
  { label: "Component", fieldName: "componentName", sortable: true },
  {
    label: "Type",
    fieldName: "typeLabel",
    sortable: true,
    initialWidth: 120
  },
  {
    label: "New",
    fieldName: "isNew",
    type: "boolean",
    sortable: true,
    initialWidth: 70
  },
  {
    label: "Recommendation",
    fieldName: "recommendationLabel",
    type: "button",
    initialWidth: 170,
    typeAttributes: {
      label: { fieldName: "recommendationLabel" },
      name: "recommendation",
      variant: "base",
      disabled: { fieldName: "noRecommendation" }
    }
  }
];

const COMPONENT_COLUMNS = [
  { label: "Component", fieldName: "apiName", sortable: true, wrapText: true },
  { label: "Type", fieldName: "typeLabel", sortable: true, initialWidth: 130 },
  { label: "Parent", fieldName: "parentName", sortable: true },
  {
    label: "API",
    fieldName: "apiVersion",
    type: "number",
    sortable: true,
    initialWidth: 80
  },
  {
    label: "Active",
    fieldName: "isActive",
    type: "boolean",
    sortable: true,
    initialWidth: 80
  },
  {
    label: "Last modified",
    fieldName: "lastModified",
    type: "date",
    sortable: true,
    typeAttributes: { year: "numeric", month: "short", day: "numeric" },
    initialWidth: 130
  },
  {
    label: "Uses",
    fieldName: "dependencyCount",
    type: "number",
    sortable: true,
    initialWidth: 80
  }
];

const LOG_ICONS = {
  error: { icon: "utility:error", variant: "error", label: "Error" },
  warning: { icon: "utility:warning", variant: "warning", label: "Warning" },
  info: { icon: "utility:info", variant: "", label: "Info" }
};

const SEVERITY_ORDER = Object.fromEntries(
  SEVERITIES.map((severity, index) => [severity.value, index])
);

/** Tri générique d'une liste d'objets ; la gravité suit son ordre métier, pas l'alphabet. */
function sortRows(rows, fieldName, direction) {
  const factor = direction === "asc" ? 1 : -1;
  const key = (row) => {
    if (fieldName === "severity") {
      return SEVERITY_ORDER[row.severity] ?? 99;
    }
    const value = row[fieldName];
    return typeof value === "string" ? value.toLowerCase() : value;
  };
  return [...rows].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) {
      return 0;
    }
    if (left === null || left === undefined) {
      return 1;
    }
    if (right === null || right === undefined) {
      return -1;
    }
    return left > right ? factor : -factor;
  });
}

/**
 * Détail d'un scan gardé dans le navigateur : indicateurs, comparaison, constats (filtres et tri),
 * inventaire des composants et journal de collecte. Seul le dernier scan garde son détail ; un scan
 * plus ancien n'affiche que son résumé (historique). Un fichier de scan peut être ouvert en
 * consultation seule (gardé en mémoire de l'onglet, cf. orgIntelScanControl) ou remplacer le
 * dernier scan (menu Data).
 */
export default class OrgIntelScanDetail extends LightningElement {
  @api
  get scanId() {
    return this.wantedScanId;
  }
  set scanId(value) {
    const changed = (value || null) !== this.wantedScanId;
    this.wantedScanId = value || null;
    if (changed && this.isConnected) {
      this.resetView();
      this.load();
    }
  }

  wantedScanId = null;
  isConnected = false;
  detail;
  error;
  isLoading = true;
  /** Scan ancien : seul son résumé est gardé. */
  summaryOnly = false;
  /** Scan inconnu de ce navigateur (lien d'un autre poste, historique effacé). */
  notFound = false;
  /** Scan ouvert depuis un fichier en consultation seule (rien n'est stocké). */
  viewOnly = false;
  scan;
  selectedFindingId = null;
  /** Empreintes des derniers scans (comparaison) et scan de comparaison choisi. */
  snapshots = [];
  compareScanId = null;
  scoreContext = { scoreConfig: null, ignoredFingerprints: undefined };

  findings = [];
  findingsLoaded = false;
  findingsError;
  findingSearch = "";
  severityFilter = ALL;
  categoryFilter = ALL;
  typeFilter = ALL;
  newOnly = false;
  findingSort = { fieldName: "severity", direction: "asc" };

  components;
  componentsError;
  componentsLoading = false;
  componentType = ALL;
  componentSearch = "";
  componentSort = { fieldName: "typeLabel", direction: "asc" };
  searchTimer;

  activeTab = "findings";
  disappearedExpanded = false;
  logIssuesOnly = false;
  expandedLogKeys = new Set();

  findingColumns = FINDING_COLUMNS;
  componentColumns = COMPONENT_COLUMNS;

  connectedCallback() {
    this.isConnected = true;
    this.load();
  }

  disconnectedCallback() {
    this.isConnected = false;
    clearTimeout(this.searchTimer);
  }

  resetView() {
    this.findingsLoaded = false;
    this.components = undefined;
    this.newOnly = false;
  }

  async load() {
    this.isLoading = true;
    this.selectedFindingId = null;
    this.notFound = false;
    try {
      const wanted = this.wantedScanId;
      const viewed = viewedScan(wanted);
      const [latest, history, snapshots, scoreContext] = await Promise.all([
        loadLatestScan(),
        loadScanHistory(),
        loadFindingSnapshots().catch(() => []),
        loadScoreContext()
      ]);
      this.snapshots = snapshots || [];
      this.scoreContext = scoreContext;
      this.error = undefined;
      this.viewOnly = false;
      if (viewed && !(latest && latest.id === viewed.id)) {
        // Fichier ouvert en consultation seule : comparé au dernier scan du navigateur s'il est plus ancien
        this.scan = viewed;
        this.summaryOnly = false;
        this.viewOnly = true;
        this.detail = this.buildDetail(viewed);
      } else if (latest && (!wanted || latest.id === wanted)) {
        this.scan = latest;
        this.summaryOnly = false;
        this.detail = this.buildDetail(latest);
      } else {
        const summary = (history || []).find((row) => row.id === wanted);
        this.scan = null;
        if (!summary) {
          this.notFound = true;
          this.detail = undefined;
          return;
        }
        this.summaryOnly = true;
        this.detail = {
          summary,
          scope: summary.scope || [],
          severityCounts: [
            { severity: "Critical", count: summary.critical || 0 },
            { severity: "High", count: summary.high || 0 },
            { severity: "Medium", count: summary.medium || 0 },
            { severity: "Low", count: summary.low || 0 },
            { severity: "Info", count: summary.info || 0 }
          ],
          logEntries: []
        };
      }
    } catch (error) {
      this.detail = undefined;
      this.error = error;
    } finally {
      this.isLoading = false;
    }
    if (this.scan) {
      this.loadFindings();
      if (this.activeTab === "components") {
        this.loadComponents();
      }
    }
  }

  /** Vue d'un scan détaillé (ancienne forme ScanDetail, calculée dans le navigateur). */
  buildDetail(scan) {
    // Comparaison par défaut : le scan précédent (plus ancien) parmi les empreintes gardées
    const started = String(scan.completedAt || scan.startedAt || "");
    const previous = this.snapshots.find(
      (snapshot) =>
        snapshot.scanId !== scan.id &&
        String(snapshot.completedAt || "") < started
    );
    this.compareScanId = previous ? previous.scanId : null;
    return {
      summary: summarizeScan(scan),
      scope: scan.scope || [],
      severityCounts: severityCountList(scan.findings),
      logEntries: scan.log || [],
      componentsPurged:
        scan.inventoryKept === false ||
        scan.compacted === 3 ||
        (!(scan.components || []).length && (scan.findings || []).length > 0)
    };
  }

  // ---------- Comparaison avec un des derniers scans ----------

  get compareOptions() {
    const currentId = this.scan?.id;
    return this.snapshots
      .filter((snapshot) => snapshot.scanId !== currentId)
      .map((snapshot) => ({
        value: snapshot.scanId,
        label: `${snapshot.scanName || snapshot.scanId} · ${formatRelative(snapshot.completedAt)}`
      }));
  }

  get hasCompareOptions() {
    return Boolean(this.scan) && this.compareOptions.length > 0;
  }

  get compareSnapshot() {
    return this.snapshots.find(
      (snapshot) => snapshot.scanId === this.compareScanId
    );
  }

  /** Constats ajoutés / disparus par rapport au scan choisi. */
  get comparison() {
    const snapshot = this.compareSnapshot;
    if (!this.scan || !snapshot) {
      return null;
    }
    const diff = compareFindings(this.scan.findings || [], snapshot);
    const rank = (severity) => {
      const index = SEVERITY_RANK.indexOf(severity);
      return index < 0 ? 99 : index;
    };
    const removed = [...diff.removed].sort(
      (a, b) => rank(a.severity) - rank(b.severity)
    );
    return {
      addedKeys: new Set(diff.added.map((f) => f.fingerprint)),
      newFindingCount: diff.added.length,
      disappearedCount: removed.length,
      disappeared: removed
        .slice(0, 50)
        .map((f, index) => ({
          key: `${f.fingerprint}-${index}`,
          label: `[${f.severity}] ${f.title}`
        }))
    };
  }

  handleCompareChange(event) {
    this.compareScanId = event.detail.value;
    this.disappearedExpanded = false;
  }

  // ---------- En-tête ----------

  get summary() {
    return this.detail?.summary;
  }

  get statusTone() {
    return scanStatusTone(this.summary?.status);
  }

  get scopeLabels() {
    return (this.detail?.scope || []).map(
      (value) =>
        SCAN_SCOPES.find((scope) => scope.value === value)?.label || value
    );
  }

  get scopeText() {
    return this.scopeLabels.join(" · ");
  }

  get scopeHelp() {
    return `Scope: ${this.scopeText || "—"}`;
  }

  get durationText() {
    return (
      formatDuration(this.summary?.startedAt, this.summary?.completedAt) || "—"
    );
  }

  /** Score du moment (préférences et recommandations ignorées actuelles), comme partout. */
  get score() {
    const source = this.scan || this.summary;
    const score = currentScore(
      source,
      this.scoreContext.scoreConfig,
      this.scoreContext.ignoredFingerprints
    );
    return score === undefined ? null : score;
  }

  get scoreValue() {
    return formatNumber(this.score);
  }

  get band() {
    return scoreBand(this.score);
  }

  /** Inventaire des composants non gardé (stockage du navigateur plein). */
  get inventoryBanner() {
    const scan = this.scan;
    if (!scan) {
      return "";
    }
    if (scan.inventoryKept === false || scan.compacted === 3) {
      return "The component inventory of this scan was not kept: browser storage was full.";
    }
    if (scan.inventoryKept === "partial" || scan.compacted > 0) {
      const dropped = (scan.droppedComponentTypes || [])
        .map((type) => componentTypeLabel(type))
        .join(", ");
      return `Part of the component inventory was not kept: browser storage was almost full${dropped ? ` (${dropped})` : ""}.`;
    }
    return "";
  }

  /** Échec de la mise à jour des recommandations à la fin du scan. */
  get recommendationsError() {
    return this.scan?.recommendationsError || this.summary?.recommendationsError || "";
  }

  get componentValue() {
    return formatNumber(this.summary?.componentCount);
  }

  get findingValue() {
    return formatNumber(this.summary?.findingCount);
  }

  get findingCaption() {
    return (this.detail?.severityCounts || [])
      .filter((row) => row.count > 0)
      .map((row) => `${row.count} ${severityMeta(row.severity).label}`)
      .join(" · ");
  }

  get issueCount() {
    if (this.summaryOnly) {
      return this.summary?.collectionErrorCount || 0;
    }
    return this.logRows.filter((row) => row.level !== "info").length;
  }

  get issueValue() {
    return formatNumber(this.issueCount);
  }

  get issueCaption() {
    const errors = this.summary?.collectionErrorCount || 0;
    if (this.summaryOnly) {
      return `${errors} error${errors === 1 ? "" : "s"}`;
    }
    const warnings = Math.max(0, this.issueCount - errors);
    return `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
  }

  get isDegraded() {
    return this.summary && this.summary.toolingApiAvailable === false;
  }

  get isPurged() {
    return !!this.detail?.componentsPurged;
  }

  get hasComparison() {
    return Boolean(this.comparison);
  }

  get hasDisappeared() {
    return (this.comparison?.disappearedCount || 0) > 0;
  }

  get disappearedIcon() {
    return this.disappearedExpanded
      ? "utility:chevrondown"
      : "utility:chevronright";
  }

  get disappearedToggleLabel() {
    return this.disappearedExpanded ? "Hide" : "Show";
  }

  handleToggleDisappeared() {
    this.disappearedExpanded = !this.disappearedExpanded;
  }

  /** « +N new » : constats nouveaux uniquement, dans l'onglet Findings. */
  handleShowNew() {
    this.newOnly = true;
    this.activeTab = "findings";
  }

  // ---------- Navigation (indicateurs, onglets) ----------

  /** Indicateurs cliquables seulement quand le détail du scan est disponible. */
  get kpiLinkClass() {
    return this.scan ? "kpi kpi-link" : "kpi";
  }

  get kpiRole() {
    return this.scan ? "button" : null;
  }

  get kpiTabIndex() {
    return this.scan ? "0" : null;
  }

  handleKpi(event) {
    if (!this.scan) {
      return;
    }
    const { tab, filter } = event.currentTarget.dataset;
    if (tab === "log") {
      this.logIssuesOnly = filter === "issues";
    }
    this.activeTab = tab;
    if (tab === "components") {
      this.handleComponentsActive();
    }
  }

  handleKpiKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleKpi(event);
    }
  }

  handleTabActive(event) {
    this.activeTab = event.target.value;
  }

  handleBack() {
    this.dispatchEvent(new CustomEvent("back"));
  }

  handleRefresh() {
    this.resetView();
    this.load();
  }

  // ---------- Fichier de scan (menu Data du lanceur commun) ----------

  /** Scan enregistré par « Save to file » : celui affiché (dernier scan ou fichier consulté). */
  get scanToSave() {
    return this.scan || null;
  }

  /** Un fichier a remplacé le dernier scan : relecture (le lien de navigation suit). */
  handleScanReplaced() {
    this.resetView();
    this.load();
  }

  /** Navigation demandée par le lanceur (scan ouvert, liste des scans). */
  handleControlNavigate(event) {
    event.stopPropagation();
    const detail = event.detail || {};
    if (detail.section === "scanner" && !detail.scanId) {
      this.handleBack();
      return;
    }
    if (detail.scanId === this.wantedScanId) {
      this.resetView();
      this.load();
      return;
    }
    this.dispatchEvent(new CustomEvent("navigate", { detail }));
  }

  // ---------- Constats ----------

  loadFindings() {
    try {
      this.findings = findingRows(this.scan).map((row) => ({
        ...row,
        severityIcon: severityIcon(row.severity),
        typeLabel: componentTypeLabel(row.componentType),
        findingTooltip: [
          row.category,
          row.confidence ? `Confidence: ${row.confidence}` : null,
          row.ruleCode ? `Rule: ${row.ruleCode}` : null
        ]
          .filter(Boolean)
          .join(" · "),
        noRecommendation: !row.recommendationId,
        recommendationLabel: row.recommendationId
          ? [row.recommendationName || "Open", row.recommendationStatus]
              .filter(Boolean)
              .join(" · ")
          : null
      }));
      this.findingsError = undefined;
    } catch (error) {
      this.findingsError = error;
    } finally {
      this.findingsLoaded = true;
    }
  }

  /** Clic dans la liste : détail du constat, ou ouverture de sa recommandation. */
  handleFindingAction(event) {
    const { action, row } = event.detail;
    if (action.name === "recommendation" && row.recommendationId) {
      // Id local (local:<empreinte>) ou Id Salesforce du module collaboratif
      this.dispatchEvent(
        new CustomEvent("navigate", {
          detail: { section: "recommendations", recordId: row.recommendationId }
        })
      );
      return;
    }
    this.selectedFindingId = this.selectedFindingId === row.id ? null : row.id;
  }

  get selectedFinding() {
    return this.selectedFindingId
      ? this.findings.find((row) => row.id === this.selectedFindingId)
      : null;
  }

  handleCloseFinding() {
    this.selectedFindingId = null;
  }

  get findingTabLabel() {
    return `Findings (${formatNumber(this.summary?.findingCount ?? 0)})`;
  }

  get severityOptions() {
    return [
      { label: "All severities", value: ALL },
      ...SEVERITIES.map((s) => ({ label: s.label, value: s.value }))
    ];
  }

  get categoryOptions() {
    const categories = [
      ...new Set(this.findings.map((row) => row.category).filter(Boolean))
    ].sort();
    return [
      { label: "All categories", value: ALL },
      ...categories.map((value) => ({ label: value, value }))
    ];
  }

  get typeOptions() {
    return [
      { label: "All types", value: ALL },
      ...COMPONENT_TYPES.map((t) => ({ label: t.label, value: t.value }))
    ];
  }

  /** Nouveau par rapport au scan comparé (à défaut : nouveau au moment du scan). */
  isAdded(row) {
    const comparison = this.comparison;
    return comparison ? comparison.addedKeys.has(row.id) : row.isNew;
  }

  get filteredFindings() {
    const search = this.findingSearch.trim().toLowerCase();
    const rows = this.findings.filter(
      (row) =>
        (!this.severityFilter || row.severity === this.severityFilter) &&
        (!this.categoryFilter || row.category === this.categoryFilter) &&
        (!this.typeFilter || row.componentType === this.typeFilter) &&
        (!this.newOnly || this.isAdded(row)) &&
        (!search ||
          `${row.title} ${row.componentName} ${row.ruleCode}`
            .toLowerCase()
            .includes(search))
    );
    return sortRows(
      rows,
      this.findingSort.fieldName,
      this.findingSort.direction
    );
  }

  get hasFindings() {
    return this.findings.length > 0;
  }

  get hasFilteredFindings() {
    return this.filteredFindings.length > 0;
  }

  get hasFindingFilters() {
    return !!(
      this.findingSearch ||
      this.severityFilter ||
      this.categoryFilter ||
      this.typeFilter ||
      this.newOnly
    );
  }

  get findingCountText() {
    return `${this.filteredFindings.length} of ${this.findings.length} findings`;
  }

  handleFindingSearch(event) {
    this.findingSearch = event.target.value || "";
  }

  handleSeverityFilter(event) {
    this.severityFilter = event.detail.value;
  }

  handleCategoryFilter(event) {
    this.categoryFilter = event.detail.value;
  }

  handleTypeFilter(event) {
    this.typeFilter = event.detail.value;
  }

  handleNewOnly(event) {
    this.newOnly = event.target.checked;
  }

  handleResetFilters() {
    this.findingSearch = "";
    this.severityFilter = ALL;
    this.categoryFilter = ALL;
    this.typeFilter = ALL;
    this.newOnly = false;
  }

  handleFindingSort(event) {
    this.findingSort = {
      fieldName: event.detail.fieldName,
      direction: event.detail.sortDirection
    };
  }

  // ---------- Composants ----------

  handleComponentsActive() {
    this.activeTab = "components";
    if (this.scan && !this.components && !this.componentsLoading) {
      this.loadComponents();
    }
  }

  loadComponents() {
    this.componentsLoading = true;
    try {
      const page = filterComponents(
        this.scan,
        this.componentType || null,
        this.componentSearch || null
      );
      this.components = {
        total: page.total,
        rows: page.rows.map((row) => ({
          ...row,
          typeLabel: componentTypeLabel(row.componentType)
        }))
      };
      this.componentsError = undefined;
    } catch (error) {
      this.componentsError = error;
    } finally {
      this.componentsLoading = false;
    }
  }

  get componentRows() {
    return sortRows(
      this.components?.rows || [],
      this.componentSort.fieldName,
      this.componentSort.direction
    );
  }

  get hasComponents() {
    return this.componentRows.length > 0;
  }

  get componentCountText() {
    if (!this.components) {
      return "";
    }
    const shown = this.components.rows.length;
    return shown < this.components.total
      ? `${formatNumber(shown)} of ${formatNumber(this.components.total)} shown`
      : `${formatNumber(this.components.total)} components`;
  }

  get isComponentListTruncated() {
    return (
      !!this.components && this.components.rows.length < this.components.total
    );
  }

  get componentTabLabel() {
    return `Components (${formatNumber(this.summary?.componentCount ?? 0)})`;
  }

  handleComponentType(event) {
    this.componentType = event.detail.value;
    this.loadComponents();
  }

  handleComponentSearch(event) {
    this.componentSearch = event.target.value || "";
    clearTimeout(this.searchTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.searchTimer = setTimeout(() => this.loadComponents(), SEARCH_DELAY_MS);
  }

  handleComponentSort(event) {
    this.componentSort = {
      fieldName: event.detail.fieldName,
      direction: event.detail.sortDirection
    };
  }

  // ---------- Journal ----------

  get visibleLogRows() {
    return this.logRows
      .filter((row) => !this.logIssuesOnly || row.level !== "info")
      .map((row) => {
        const isLong = (row.message || "").length > LOG_CLAMP_LENGTH;
        const expanded = isLong && this.expandedLogKeys.has(row.key);
        return {
          ...row,
          isLong,
          expanded,
          messageClass:
            isLong && !expanded ? "log-message log-clamp" : "log-message",
          toggleIcon: expanded ? "utility:chevrondown" : "utility:chevronright",
          toggleLabel: expanded
            ? "Collapse the message"
            : "Show the full message"
        };
      });
  }

  get hasVisibleLog() {
    return this.visibleLogRows.length > 0;
  }

  get logCountText() {
    return this.logIssuesOnly
      ? `${this.visibleLogRows.length} of ${this.logRows.length} entries`
      : `${this.logRows.length} entries`;
  }

  handleLogIssuesOnly(event) {
    this.logIssuesOnly = event.target.checked;
  }

  handleLogToggle(event) {
    const key = event.currentTarget.dataset.key;
    const keys = new Set(this.expandedLogKeys);
    if (keys.has(key)) {
      keys.delete(key);
    } else {
      keys.add(key);
    }
    this.expandedLogKeys = keys;
  }

  // ---------- Exports ----------

  get noFilteredFindings() {
    return !this.hasFilteredFindings;
  }

  get noComponents() {
    return !this.hasComponents;
  }

  get exportPrefix() {
    return this.summary?.name || "scan";
  }

  handleExportFindings(event) {
    exportRows({
      name: `${this.exportPrefix}-findings`,
      format: event.detail.format,
      rows: this.filteredFindings,
      columns: [
        { label: "Severity", value: (row) => row.severity },
        { label: "Finding", value: (row) => row.title },
        { label: "Component", value: (row) => row.componentName },
        { label: "Component type", value: (row) => row.typeLabel },
        { label: "Category", value: (row) => row.category },
        { label: "Confidence", value: (row) => row.confidence },
        { label: "Rule", value: (row) => row.ruleCode },
        { label: "New in this scan", value: (row) => !!row.isNew },
        { label: "Recommendation", value: (row) => row.recommendationLabel },
        { label: "Finding Id", value: (row) => row.id }
      ]
    });
  }

  handleExportComponents(event) {
    exportRows({
      name: `${this.exportPrefix}-components`,
      format: event.detail.format,
      rows: this.componentRows,
      columns: [
        { label: "API name", value: (row) => row.apiName },
        { label: "Type", value: (row) => row.typeLabel },
        { label: "Parent", value: (row) => row.parentName },
        { label: "API version", value: (row) => row.apiVersion },
        { label: "Active", value: (row) => row.isActive },
        {
          label: "Last modified",
          value: (row) => formatExportDate(row.lastModified)
        },
        { label: "Modified by", value: (row) => row.lastModifiedBy },
        { label: "Dependencies", value: (row) => row.dependencyCount },
        { label: "Description", value: (row) => row.description }
      ]
    });
  }

  handleExportLog(event) {
    exportRows({
      name: `${this.exportPrefix}-log`,
      format: event.detail.format,
      rows: this.detail?.logEntries || [],
      columns: [
        { label: "When", value: (row) => formatExportDate(row.loggedAt) },
        { label: "Level", value: (row) => row.level },
        { label: "Step", value: (row) => row.step },
        { label: "Message", value: (row) => row.message }
      ]
    });
  }

  get logRows() {
    return (this.detail?.logEntries || []).map((entry, index) => {
      const meta = LOG_ICONS[entry.level] || LOG_ICONS.info;
      return {
        ...entry,
        key: `log-${index}`,
        icon: meta.icon,
        variant: meta.variant,
        levelLabel: meta.label,
        rowClass: `log-row log-${entry.level}`
      };
    });
  }

  get hasLog() {
    return this.logRows.length > 0;
  }

  get logTabLabel() {
    return `Collection log (${this.logRows.length})`;
  }
}
