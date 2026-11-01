import { LightningElement } from "lwc";
import getStorageView from "@salesforce/apex/OrgIntelligenceController.getStorageView";
import {
  buildStorageView,
  loadLatestScan,
  loadPreviousStorage,
  loadScanHistory
} from "c/orgIntelScanData";
import { subscribe } from "c/orgIntelScanEngine";
import {
  exportRows,
  formatDate,
  formatExportDate,
  formatNumber,
  formatRelative,
  severityMeta
} from "c/orgIntelUtils";

const OBJECT_FILTERS = [
  { value: "all", label: "All objects" },
  { value: "custom", label: "Custom" },
  { value: "standard", label: "Standard" },
  { value: "growing", label: "Growing" }
];

const SORTS = [
  { value: "size", label: "Size" },
  { value: "growth", label: "Growth" },
  { value: "name", label: "Name" }
];

function meterTone(percent) {
  if (percent >= 90) {
    return "critical";
  }
  if (percent >= 75) {
    return "warning";
  }
  return "good";
}

/**
 * Section « Storage » : stockage données et fichiers, enregistrements par objet (taille estimée,
 * évolution depuis le scan précédent), fichiers et recommandations de stockage. Photographie et
 * tendance lues dans le stockage du navigateur (dernier scan), limites lues en direct dans l'org.
 */
export default class OrgIntelStorage extends LightningElement {
  view;
  error;
  isLoading = true;
  objectFilter = "all";
  objectSearch = "";
  sortBy = "size";
  showAll = false;

  objectFilters = OBJECT_FILTERS;
  sortOptions = SORTS;
  trendSeries = [
    { key: "data", label: "Data storage (MB)", tone: "accent" },
    { key: "file", label: "File storage (MB)", tone: "warning" }
  ];

  scanRunning = false;

  connectedCallback() {
    this.load();
    // Recharge à la fin d'un scan lancé depuis une autre section
    this.unsubscribe = subscribe((run) => {
      const running = run?.status === "Running";
      if (this.scanRunning && !running) {
        this.load();
      }
      this.scanRunning = running;
    });
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }

  async load() {
    this.isLoading = !this.view;
    try {
      const [limits, scan, previousStorage, history] = await Promise.all([
        getStorageView(),
        loadLatestScan(),
        loadPreviousStorage(),
        loadScanHistory()
      ]);
      const stored = buildStorageView(scan, previousStorage, history);
      // Limites en direct ; à défaut, celles relevées par le dernier scan
      const fallback = (scan && scan.storage) || {};
      this.view = {
        ...stored,
        dataUsedMb: limits?.dataUsedMb ?? fallback.dataUsedMb,
        dataMaxMb: limits?.dataMaxMb ?? fallback.dataMaxMb,
        fileUsedMb: limits?.fileUsedMb ?? fallback.fileUsedMb,
        fileMaxMb: limits?.fileMaxMb ?? fallback.fileMaxMb
      };
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  handleRefresh() {
    this.load();
  }

  parse(json) {
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  }

  get snapshot() {
    return this.parse(this.view?.snapshotJson);
  }

  get previous() {
    return this.parse(this.view?.previousSnapshotJson);
  }

  get hasSnapshot() {
    return !!this.snapshot;
  }

  get scanText() {
    if (!this.view?.scanName) {
      return "No Storage scan yet.";
    }
    const previous = this.view.previousScanName
      ? ` · vs ${this.view.previousScanName}`
      : "";
    return `${this.view.scanName}, ${formatRelative(this.view.scanCompletedAt)}${previous}`;
  }

  /** Aide de la page : ce que mesure la section (déplacée hors de l'écran). */
  get pageHelp() {
    return "Data and file storage, records per object with estimated size and growth since the previous scan, files and storage recommendations. Run a scan including Storage to refresh.";
  }

  /** Aide de la carte des objets : source des comptes et limites de l'estimation. */
  get objectsHelp() {
    const growth = this.showGrowthNote
      ? " Growth appears from the second scan including Storage."
      : "";
    return `${this.estimatedText} · counts from ${this.countSource}. Exact use per object: Setup › Storage Usage.${growth}`;
  }

  /** Indicateur cliquable : affiche la carte correspondante (objets ou fichiers). */
  handleKpi(event) {
    const { target, filter, sort } = event.currentTarget.dataset;
    if (filter) {
      this.objectFilter = filter;
      this.objectSearch = "";
    }
    if (sort) {
      this.sortBy = sort;
    }
    const card = this.template.querySelector(`[data-anchor="${target}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  handleKpiKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleKpi(event);
    }
  }

  // ---------- Limites ----------

  meter(used, max, label) {
    const percent = max ? Math.round((100 * used) / max) : 0;
    return {
      label,
      value: `${formatNumber(used)} MB`,
      caption: `of ${formatNumber(max)} MB · ${percent}%`,
      percent,
      fillClass: `meter-fill tone-${meterTone(percent)}`,
      fillStyle: `width:${Math.min(100, Math.max(percent, used ? 1 : 0))}%`
    };
  }

  get dataMeter() {
    return this.meter(
      this.view?.dataUsedMb || 0,
      this.view?.dataMaxMb || 0,
      "Data storage"
    );
  }

  get fileMeter() {
    return this.meter(
      this.view?.fileUsedMb || 0,
      this.view?.fileMaxMb || 0,
      "File storage"
    );
  }

  get recordTotal() {
    const total = (this.snapshot?.objects || []).reduce(
      (sum, o) => sum + o.count,
      0
    );
    return formatNumber(total);
  }

  get objectCount() {
    return `${formatNumber((this.snapshot?.objects || []).length)} objects with records`;
  }

  get fileTotal() {
    const files = this.snapshot?.files;
    return files ? formatNumber(files.fileCount || 0) : "—";
  }

  get fileCaption() {
    const files = this.snapshot?.files;
    if (!files) {
      return "";
    }
    return `${formatNumber(files.fileSizeMb || 0)} MB · ${formatNumber(files.attachmentCount || 0)} attachments`;
  }

  // ---------- Objets ----------

  get objectRows() {
    const previous = new Map(
      (this.previous?.objects || []).map((o) => [o.name, o.count])
    );
    const objects = this.snapshot?.objects || [];
    const max = Math.max(1, ...objects.map((o) => o.sizeMb));
    const total = objects.reduce((sum, o) => sum + o.sizeMb, 0) || 1;
    const term = this.objectSearch.trim().toLowerCase();
    let rows = objects.map((o) => {
      const before = previous.get(o.name);
      const growth = before === undefined ? null : o.count - before;
      const growthPercent = before ? Math.round((100 * growth) / before) : null;
      return {
        ...o,
        countText: formatNumber(o.count),
        sizeText: `${formatNumber(o.sizeMb)} MB`,
        share: `${Math.round((100 * o.sizeMb) / total)}%`,
        shareTitle: `${Math.round((100 * o.sizeMb) / total)}% of the estimated data storage`,
        barStyle: `width:${Math.max(1, (o.sizeMb / max) * 100)}%`,
        growth,
        growthText:
          growth === null
            ? "—"
            : `${growth > 0 ? "+" : ""}${formatNumber(growth)}${growthPercent !== null && growth ? ` (${growthPercent > 0 ? "+" : ""}${growthPercent}%)` : ""}`,
        growthClass: `num growth${growth > 0 ? " growth-up" : growth < 0 ? " growth-down" : ""}`,
        typeLabel: o.custom ? (o.managed ? "Managed" : "Custom") : "Standard"
      };
    });
    rows = rows.filter(
      (row) =>
        (this.objectFilter === "all" ||
          (this.objectFilter === "custom" && row.custom) ||
          (this.objectFilter === "standard" && !row.custom) ||
          (this.objectFilter === "growing" && row.growth > 0)) &&
        (!term || `${row.name} ${row.label}`.toLowerCase().includes(term))
    );
    const sorters = {
      size: (a, b) => b.sizeMb - a.sizeMb,
      growth: (a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity),
      name: (a, b) => a.name.localeCompare(b.name)
    };
    return rows.sort(sorters[this.sortBy] || sorters.size);
  }

  get visibleRows() {
    return this.showAll ? this.objectRows : this.objectRows.slice(0, 15);
  }

  get hasMoreRows() {
    return !this.showAll && this.objectRows.length > 15;
  }

  get moreLabel() {
    return `Show all ${this.objectRows.length} objects`;
  }

  get hasRows() {
    return this.objectRows.length > 0;
  }

  get countSource() {
    return this.snapshot?.countSource || "";
  }

  get estimatedText() {
    return `${formatNumber(this.snapshot?.estimatedDataMb || 0)} MB estimated for these objects`;
  }

  get showGrowthNote() {
    return !this.previous;
  }

  handleObjectFilter(event) {
    this.objectFilter = event.detail.value;
  }

  handleObjectSearch(event) {
    this.objectSearch = event.target.value || "";
  }

  handleSort(event) {
    this.sortBy = event.detail.value;
  }

  handleShowAll() {
    this.showAll = true;
  }

  // ---------- Exports ----------

  get noSnapshot() {
    return this.isLoading || !this.hasSnapshot;
  }

  get noRows() {
    return !this.hasRows;
  }

  get noFindings() {
    return !this.hasFindings;
  }

  get noFileTypes() {
    return !this.hasFileTypes;
  }

  get noLargestFiles() {
    return !this.hasLargestFiles;
  }

  /** Feuilles exportables : objets affichés (recherche, filtre, tri), fichiers, recommandations. */
  get exportSheets() {
    return {
      objects: {
        name: "Objects",
        rows: this.objectRows,
        columns: [
          { label: "Object", value: (row) => row.name },
          { label: "Label", value: (row) => row.label },
          { label: "Type", value: (row) => row.typeLabel },
          { label: "Records", value: (row) => row.count },
          { label: "Estimated size (MB)", value: (row) => row.sizeMb },
          { label: "Growth since previous scan", value: (row) => row.growth }
        ]
      },
      fileTypes: {
        name: "Files by type",
        rows: this.fileTypes,
        columns: [
          { label: "Type", value: (row) => row.type },
          { label: "Files", value: (row) => row.count },
          { label: "Size (MB)", value: (row) => row.sizeMb }
        ]
      },
      largestFiles: {
        name: "Largest files",
        rows: this.largestFiles,
        columns: [
          { label: "File", value: (row) => row.name },
          { label: "Size (MB)", value: (row) => row.sizeMb },
          { label: "Owner", value: (row) => row.owner },
          {
            label: "Created",
            value: (row) => formatExportDate(row.createdDate)
          },
          { label: "Document Id", value: (row) => row.documentId }
        ]
      },
      findings: {
        name: "Recommendations",
        rows: this.findings,
        columns: [
          { label: "Severity", value: (row) => row.severity },
          { label: "Finding", value: (row) => row.title },
          { label: "Component", value: (row) => row.componentName },
          { label: "Rule", value: (row) => row.ruleCode },
          {
            label: "Recommendation status",
            value: (row) => row.recommendationStatus
          },
          { label: "Recommendation Id", value: (row) => row.recommendationId }
        ]
      }
    };
  }

  handleExport(event) {
    const sheets = this.exportSheets;
    exportRows({
      name: "storage",
      format: event.detail.format,
      sheets: [
        sheets.objects,
        sheets.fileTypes,
        sheets.largestFiles,
        sheets.findings
      ]
    });
  }

  handleExportSheet(event) {
    const key = event.currentTarget.dataset.sheet;
    const sheet = this.exportSheets[key];
    exportRows({
      name: `storage-${sheet.name}`,
      format: event.detail.format,
      sheets: [sheet]
    });
  }

  // ---------- Fichiers ----------

  get fileTypes() {
    const types = this.snapshot?.files?.byType || [];
    const max = Math.max(1, ...types.map((t) => t.sizeMb));
    return types.map((t) => ({
      ...t,
      key: t.type,
      sizeText: `${formatNumber(t.sizeMb)} MB`,
      countText: formatNumber(t.count),
      barStyle: `width:${Math.max(1, (t.sizeMb / max) * 100)}%`
    }));
  }

  get hasFileTypes() {
    return this.fileTypes.length > 0;
  }

  get largestFiles() {
    return (this.snapshot?.files?.largest || []).map((file) => ({
      ...file,
      key: file.documentId,
      sizeText: `${formatNumber(file.sizeMb)} MB`,
      when: formatDate(file.createdDate),
      url: `/lightning/r/ContentDocument/${file.documentId}/view`,
      metaTitle: `${file.owner || ""} · ${formatDate(file.createdDate)}`,
      name: file.extension ? `${file.title}.${file.extension}` : file.title
    }));
  }

  get hasLargestFiles() {
    return this.largestFiles.length > 0;
  }

  get oldVersionsText() {
    const files = this.snapshot?.files;
    if (!files) {
      return "";
    }
    return `${formatNumber(files.oldVersionCount || 0)} previous versions · ${formatNumber(files.oldVersionSizeMb || 0)} MB`;
  }

  /** Pied de la carte des fichiers : anciennes versions et pièces jointes, sur une ligne. */
  get filesFooter() {
    return [this.oldVersionsText, this.attachmentsText]
      .filter(Boolean)
      .join(" · ");
  }

  get attachmentsText() {
    const files = this.snapshot?.files;
    if (
      !files ||
      files.attachmentCount === null ||
      files.attachmentCount === undefined
    ) {
      return "";
    }
    return `${formatNumber(files.attachmentCount)} attachments (legacy) · ${formatNumber(files.attachmentSizeMb || 0)} MB`;
  }

  // ---------- Tendance et recommandations ----------

  get trendPoints() {
    return (this.view?.trend || []).map((point) => ({
      key: point.scanId,
      label: (point.scanName || "").replace("SCAN-", "#"),
      sublabel: formatDate(point.completedAt),
      values: { data: point.dataUsedMb, file: point.fileUsedMb }
    }));
  }

  get hasTrend() {
    return this.trendPoints.length > 1;
  }

  get findings() {
    return (this.view?.findings || [])
      .map((finding) => {
        const meta = severityMeta(finding.severity);
        return {
          ...finding,
          severityLabel: meta.label,
          severityTone: meta.tone,
          points: meta.points
        };
      })
      .sort((a, b) => b.points - a.points);
  }

  get hasFindings() {
    return this.findings.length > 0;
  }

  handleOpenRecommendation(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: {
          section: "recommendations",
          recordId: event.currentTarget.dataset.id
        }
      })
    );
  }

  get hasScan() {
    return Boolean(this.view?.scanName);
  }

  /**
   * Premier clic sur « Run a scan » : le panneau du lanceur s'ouvre avec le périmètre Storage
   * prérempli (le lanceur a déjà basculé le panneau, openPanel le garde ouvert).
   */
  handleScanClick() {
    if (this.scanPrefilled) {
      return;
    }
    this.scanPrefilled = true;
    const control = this.template.querySelector("c-org-intel-scan-control");
    if (control) {
      control.openPanel(["Storage"]);
    }
  }

  handleScanNavigate(event) {
    this.dispatchEvent(new CustomEvent("navigate", { detail: event.detail }));
  }
}
