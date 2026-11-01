import { LightningElement } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import userId from "@salesforce/user/Id";
import {
  REC_DOMAINS,
  SEVERITIES,
  copyText,
  downloadText,
  exportRows,
  formatDate,
  formatNumber,
  reduceErrors,
  severityMeta
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import { loadValue, saveValue } from "c/orgIntelStore";
import {
  LOCAL_MODE,
  listLocalRecommendations,
  onLocalRecommendationsChange,
  recommendationsMode
} from "c/orgIntelRecommendationStore";
import {
  DEFAULT_FILTERS,
  DEFAULT_SETTINGS,
  RHYTHMS,
  SIZES,
  STRATEGIES,
  buildRoadmap,
  themesOf,
  toMarkdown
} from "c/orgIntelRoadmapModel";

const listRecommendations = moduleAction(
  "recommendations",
  "listRecommendations"
);

/** Préférences de la roadmap (réglages, filtres, ajustements par sujet) dans le stockage commun. */
const PREFERENCES_KEY = "roadmap.preferences";
/** Ancienne clé localStorage (avant orgIntelStore), reprise une fois puis effacée. */
const LEGACY_KEY = `orgIntelligence.roadmap.v1.${userId}`;

async function readState() {
  const stored = await loadValue(PREFERENCES_KEY, null);
  if (stored) {
    return stored;
  }
  try {
    const legacy = JSON.parse(
      window.localStorage.getItem(LEGACY_KEY) || "null"
    );
    if (legacy) {
      await saveValue(PREFERENCES_KEY, legacy);
      window.localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch {
    // ancienne préférence illisible : valeurs par défaut
  }
  return {};
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shortRange(start, end) {
  const format = (d) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(
      d
    );
  return `${format(start)} – ${format(end)}`;
}

/**
 * Section « Roadmap » : ordre de traitement des recommandations, calculé dans le navigateur
 * (orgIntelRoadmapModel) à partir de la liste des recommandations — module collaboratif ou
 * stockage du navigateur (édition sans objet, responsable en texte libre). Aucun objet : réglages,
 * filtres et ajustements (taille, priorité, exclusion) sont gardés par orgIntelStore.
 */
export default class OrgIntelRoadmap extends LightningElement {
  rows = [];
  currentUserId;
  mode;
  error;
  isLoading = true;
  view = "timeline";
  selectedId = null;
  showSettings = false;
  showFilters = false;
  collapsedThemes = [];
  showExcluded = false;

  settings = { ...DEFAULT_SETTINGS };
  filters = { ...DEFAULT_FILTERS };
  overrides = {};

  strategies = STRATEGIES;
  rhythmOptions = RHYTHMS.map((r) => ({ value: r.value, label: r.label }));
  sizeOptions = SIZES.map((s) => ({ value: s.value, label: s.label }));
  assigneeOptions = [
    { value: "all", label: "Everyone" },
    { value: "me", label: "Assigned to me" },
    { value: "unassigned", label: "Unassigned" }
  ];

  connectedCallback() {
    this.init();
    this.unsubscribe = onLocalRecommendationsChange(() => {
      if (this.isLocal) {
        this.load();
      }
    });
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async init() {
    let state = {};
    try {
      state = (await readState()) || {};
    } catch {
      state = {}; // préférences illisibles : valeurs par défaut
    }
    this.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    this.filters = { ...DEFAULT_FILTERS, ...(state.filters || {}) };
    this.overrides = state.overrides || {};
    await this.load();
  }

  handleReload() {
    this.load(true);
  }

  async load(refresh = false) {
    this.isLoading = true;
    try {
      this.mode = await recommendationsMode({ refresh });
      const result = this.isLocal
        ? await listLocalRecommendations()
        : await listRecommendations({});
      this.rows = result?.rows || [];
      if (this.isLocal && this.filters.assignee !== "all") {
        // pas d'assignation à un utilisateur dans l'édition sans objet
        this.filters = { ...this.filters, assignee: "all" };
      }
      this.currentUserId = result?.currentUserId;
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  get isLocal() {
    return this.mode === LOCAL_MODE;
  }

  get isCollaborative() {
    return !!this.mode && !this.isLocal;
  }

  save() {
    saveValue(PREFERENCES_KEY, {
      settings: this.settings,
      filters: this.filters,
      overrides: this.overrides
    }).catch(() => {
      // préférences non gardées (stockage du navigateur plein ou indisponible)
    });
  }

  // ---------- Calcul ----------

  get roadmap() {
    return buildRoadmap(this.rows, {
      filters: this.filters,
      settings: this.settings,
      overrides: this.overrides,
      currentUserId: this.currentUserId
    });
  }

  get hasItems() {
    return this.roadmap.items.length > 0;
  }

  get subtitle() {
    const r = this.roadmap;
    if (!r.items.length) {
      return "Plan the order in which to fix the recommendations.";
    }
    const rhythm = RHYTHMS.find((x) => x.value === r.settings.rhythm);
    const urgent = r.items.filter(
      (item) => item.severity === "Critical" || item.severity === "High"
    );
    const lastUrgent = urgent.length
      ? r.periods[Math.max(...urgent.map((item) => item.endPeriod))]
      : null;
    return [
      `${formatNumber(r.items.length)} topics`,
      `${formatNumber(r.totalDays)} days of work`,
      `${r.periodCount} ${(rhythm?.short || "period").toLowerCase()}${r.periodCount === 1 ? "" : "s"}`,
      lastUrgent
        ? `critical & high done by ${formatDate(lastUrgent.end)}`
        : null,
      `until ${formatDate(r.endDate)}`
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // ---------- Filtres ----------

  get domainChips() {
    const counts = new Map();
    this.rows
      .filter((row) => !this.filters.openOnly || row.isOpen !== false)
      .forEach((row) => {
        const domain = row.domain || "Other";
        counts.set(domain, (counts.get(domain) || 0) + 1);
      });
    return REC_DOMAINS.filter((domain) => counts.has(domain.value)).map(
      (domain) => {
        const active = this.filters.domains.includes(domain.value);
        return {
          value: domain.value,
          label: `${domain.label} · ${counts.get(domain.value)}`,
          className: `chip${active ? " chip-on" : ""}`,
          pressed: active ? "true" : "false",
          style: `--chip-color: ${domain.color}`
        };
      }
    );
  }

  get severityChips() {
    return SEVERITIES.filter((s) => s.value !== "Info").map((severity) => {
      const active = this.filters.severities.includes(severity.value);
      return {
        value: severity.value,
        label: severity.label,
        className: `chip chip-sev tone-${severity.tone}${active ? " chip-on" : ""}`,
        pressed: active ? "true" : "false"
      };
    });
  }

  get hasActiveFilters() {
    const f = this.filters;
    return (
      f.domains.length ||
      f.severities.length ||
      f.assignee !== "all" ||
      !f.openOnly ||
      f.search
    );
  }

  toggleIn(listName, value) {
    const list = this.filters[listName];
    this.filters = {
      ...this.filters,
      [listName]: list.includes(value)
        ? list.filter((v) => v !== value)
        : [...list, value]
    };
    this.save();
  }

  handleDomainChip(event) {
    this.toggleIn("domains", event.currentTarget.dataset.value);
  }

  handleSeverityChip(event) {
    this.toggleIn("severities", event.currentTarget.dataset.value);
  }

  handleAssignee(event) {
    this.filters = { ...this.filters, assignee: event.detail.value };
    this.save();
  }

  handleSearch(event) {
    this.filters = { ...this.filters, search: event.target.value || "" };
    this.save();
  }

  handleOpenOnly(event) {
    this.filters = { ...this.filters, openOnly: event.target.checked };
    this.save();
  }

  handleClearFilters() {
    this.filters = { ...DEFAULT_FILTERS };
    this.save();
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  /** Recommandations présentes mais toutes masquées : filtres, statut fermé ou exclusions. */
  get filteredOutMessage() {
    const open = this.rows.filter((row) => row.isOpen !== false).length;
    if (this.filters.openOnly && !open) {
      return "Every recommendation is closed. Show the closed ones in Filters, or clear the filters.";
    }
    if (this.excludedCount && !this.hasActiveFilters) {
      return "Every matching topic is excluded from the plan: restore some below.";
    }
    return "No recommendation matches the current filters.";
  }

  /** « Clear filters » de l'état vide : filtres par défaut, et liste des exclus si rien n'apparaît. */
  handleClearAll() {
    this.handleClearFilters();
    if (!this.hasItems && this.excludedCount) {
      this.showExcluded = true;
    }
  }

  handleNewScan() {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: { section: "overview" } })
    );
  }

  // ---------- Réglages ----------

  get strategyButtons() {
    return STRATEGIES.map((strategy) => ({
      ...strategy,
      className: `segment${strategy.value === this.settings.strategy ? " segment-on" : ""}`,
      pressed: strategy.value === this.settings.strategy ? "true" : "false"
    }));
  }

  get startDateValue() {
    return this.settings.startDate || isoDate(this.roadmap.start);
  }

  get settingsLabel() {
    return this.showSettings ? "Hide settings" : "Capacity and rhythm";
  }

  get settingsSummary() {
    const rhythm = RHYTHMS.find((r) => r.value === this.settings.rhythm);
    return `${this.settings.capacity} days per ${rhythm?.short.toLowerCase() || "period"} · from ${formatDate(this.roadmap.start)}${this.settings.byTheme ? " · grouped by theme" : ""}`;
  }

  handleStrategy(event) {
    this.updateSettings({ strategy: event.currentTarget.dataset.value });
  }

  handleToggleSettings() {
    this.showSettings = !this.showSettings;
  }

  handleRhythm(event) {
    this.updateSettings({ rhythm: event.detail.value, startDate: null });
  }

  handleCapacity(event) {
    const value = Number(event.target.value);
    if (value > 0) {
      this.updateSettings({ capacity: value });
    }
  }

  handleStartDate(event) {
    this.updateSettings({ startDate: event.target.value || null });
  }

  handleHorizon(event) {
    const value = Number(event.target.value);
    if (value > 0) {
      this.updateSettings({ horizon: value });
    }
  }

  handleByTheme(event) {
    this.updateSettings({ byTheme: event.target.checked });
  }

  updateSettings(changes) {
    this.settings = { ...this.settings, ...changes };
    this.save();
  }

  // ---------- Vues ----------

  get isTimeline() {
    return this.view === "timeline";
  }

  get viewButtons() {
    return [
      { value: "timeline", label: "Timeline", icon: "utility:graph" },
      { value: "plan", label: "Plan", icon: "utility:list" }
    ].map((v) => ({
      ...v,
      className: `segment${v.value === this.view ? " segment-on" : ""}`,
      pressed: v.value === this.view ? "true" : "false"
    }));
  }

  handleView(event) {
    this.view = event.currentTarget.dataset.value;
  }

  decorate(item) {
    const meta = severityMeta(item.severity);
    const domain = REC_DOMAINS.find((d) => d.value === item.domain);
    return {
      ...item,
      severityTone: meta.tone,
      chipClass: `task tone-border-${meta.tone}${item.id === this.selectedId ? " task-selected" : ""}`,
      chipStyle: `--task-color: ${domain?.color || "#5c6470"}`,
      spanText: item.span > 1 ? `→ ${item.span} periods` : "",
      sizeLabel: item.size,
      tooltip: `${item.title} — ${item.reason}`
    };
  }

  // ---------- Gantt : une ligne par sujet, groupée par thème ----------

  get visibleDays() {
    const r = this.roadmap;
    return Math.max(1, r.periods.length * r.settings.capacity);
  }

  get trackStyle() {
    const count = Math.max(1, this.roadmap.periods.length);
    return `--period-width: ${100 / count}%`;
  }

  get ganttGroups() {
    const r = this.roadmap;
    const total = this.visibleDays;
    const collapsed = new Set(this.collapsedThemes);
    const inHorizon = r.items.filter((item) => item.period < r.periods.length);
    return themesOf(inHorizon).map((theme) => {
      const domain = REC_DOMAINS.find((d) => d.value === theme);
      const color = domain?.color || "#5c6470";
      const items = inHorizon.filter((item) => item.domain === theme);
      const days = items.reduce((sum, item) => sum + item.days, 0);
      const first = Math.min(...items.map((item) => item.startDay));
      const last = Math.max(
        ...items.map((item) => Math.min(item.endDay, total))
      );
      const isCollapsed = collapsed.has(theme);
      return {
        theme,
        label: domain?.label || theme,
        summary: `${items.length} · ${formatNumber(Math.round(days * 100) / 100)} d`,
        style: `--theme-color: ${color}`,
        isCollapsed,
        toggleIcon: isCollapsed
          ? "utility:chevronright"
          : "utility:chevrondown",
        summaryBarStyle: `left: ${(first / total) * 100}%; width: ${Math.max(0.8, ((last - first) / total) * 100)}%`,
        rows: isCollapsed
          ? []
          : items.map((item) => {
              const decorated = this.decorate(item);
              const end = Math.min(item.endDay, total);
              return {
                ...decorated,
                rowClass: `g-row${item.id === this.selectedId ? " g-row-selected" : ""}`,
                barStyle: `left: ${(item.startDay / total) * 100}%; width: ${Math.max(0.8, ((end - item.startDay) / total) * 100)}%`,
                barClass: `bar bar-${decorated.severityTone}`,
                dotClass: `dot dot-${decorated.severityTone}`
              };
            })
      };
    });
  }

  handleToggleTheme(event) {
    const theme = event.currentTarget.dataset.theme;
    this.collapsedThemes = this.collapsedThemes.includes(theme)
      ? this.collapsedThemes.filter((t) => t !== theme)
      : [...this.collapsedThemes, theme];
  }

  get allCollapsed() {
    const themes = themesOf(this.roadmap.items);
    return (
      themes.length > 0 && themes.every((t) => this.collapsedThemes.includes(t))
    );
  }

  get collapseAllLabel() {
    return this.allCollapsed ? "Expand all" : "Collapse all";
  }

  handleCollapseAll() {
    this.collapsedThemes = this.allCollapsed
      ? []
      : themesOf(this.roadmap.items);
  }

  // ---------- Filtres repliables ----------

  get filterCount() {
    const f = this.filters;
    return (
      f.domains.length +
      f.severities.length +
      (f.assignee !== "all" ? 1 : 0) +
      (f.openOnly ? 0 : 1)
    );
  }

  get filtersLabel() {
    return this.filterCount ? `Filters (${this.filterCount})` : "Filters";
  }

  get filtersVariant() {
    return this.filterCount ? "brand-outline" : "neutral";
  }

  handleToggleFilters() {
    this.showFilters = !this.showFilters;
  }

  get activeFilterPills() {
    const pills = [];
    this.filters.domains.forEach((value) =>
      pills.push({ key: `d-${value}`, label: value, list: "domains", value })
    );
    this.filters.severities.forEach((value) =>
      pills.push({ key: `s-${value}`, label: value, list: "severities", value })
    );
    return pills;
  }

  get hasActiveFilterPills() {
    return this.activeFilterPills.length > 0;
  }

  handleRemovePill(event) {
    const { list, value } = event.currentTarget.dataset;
    this.toggleIn(list, value);
  }

  get periodHeaders() {
    return this.roadmap.periods.map((period) => {
      const load = Math.min(100, (period.used / period.capacity) * 100);
      return {
        key: period.index,
        label: period.label,
        range: shortRange(period.start, period.end),
        loadText: `${formatNumber(period.used)} / ${formatNumber(period.capacity)} d`,
        loadStyle: `width: ${load}%`
      };
    });
  }

  get planPeriods() {
    return this.roadmap.periods.map((period) => ({
      key: period.index,
      label: period.label,
      range: shortRange(period.start, period.end),
      loadText: `${formatNumber(period.used)} / ${formatNumber(period.capacity)} days`,
      loadStyle: `width: ${Math.min(100, (period.used / period.capacity) * 100)}%`,
      items: period.items.map((item) => this.decorate(item)),
      empty: !period.items.length
    }));
  }

  get beyondCount() {
    return this.roadmap.beyondHorizon.length;
  }

  get hasBeyond() {
    return this.beyondCount > 0;
  }

  get beyondText() {
    return `${this.beyondCount} more topic(s) after the horizon of ${this.settings.horizon} periods.`;
  }

  // ---------- Sujet sélectionné ----------

  get selected() {
    if (!this.selectedId) {
      return null;
    }
    const item = this.roadmap.items.find((i) => i.id === this.selectedId);
    if (!item) {
      return null;
    }
    const period = this.roadmap.periods[item.period];
    return {
      ...this.decorate(item),
      whenText: period
        ? `${period.label} (${shortRange(period.start, period.end)})${item.span > 1 ? `, over ${item.span} periods` : ""}`
        : "After the horizon",
      assignedText: item.assignedToName || (this.isLocal ? "" : "Unassigned"),
      boostUp: item.boost > 0,
      boostDown: item.boost < 0
    };
  }

  handleSelectTask(event) {
    const id = event.currentTarget.dataset.id;
    this.selectedId = this.selectedId === id ? null : id;
  }

  handleCloseDetail() {
    this.selectedId = null;
  }

  setOverride(id, changes) {
    const current = { ...(this.overrides[id] || {}), ...changes };
    Object.keys(current).forEach((key) => {
      if (
        current[key] === null ||
        current[key] === 0 ||
        current[key] === false
      ) {
        delete current[key];
      }
    });
    const next = { ...this.overrides };
    if (Object.keys(current).length) {
      next[id] = current;
    } else {
      delete next[id];
    }
    this.overrides = next;
    this.save();
  }

  handleSize(event) {
    this.setOverride(event.target.dataset.id, { size: event.detail.value });
  }

  handleBoost(event) {
    const { id, delta } = event.currentTarget.dataset;
    const current = this.overrides[id]?.boost || 0;
    this.setOverride(id, {
      boost: Math.max(-1, Math.min(1, current + Number(delta)))
    });
  }

  handleExclude(event) {
    const id = event.currentTarget.dataset.id;
    this.setOverride(id, { excluded: true });
    if (this.selectedId === id) {
      this.selectedId = null;
    }
  }

  handleRestore(event) {
    this.setOverride(event.currentTarget.dataset.id, { excluded: false });
  }

  handleResetAdjustments() {
    this.overrides = {};
    this.save();
  }

  get hasAdjustments() {
    return Object.keys(this.overrides).length > 0;
  }

  get excludedItems() {
    return this.roadmap.excluded.map((item) => ({
      ...item,
      label: `${item.title} (${item.domain})`
    }));
  }

  get excludedCount() {
    return this.roadmap.excluded.length;
  }

  get hasExcluded() {
    return this.excludedCount > 0;
  }

  get excludedLabel() {
    return `${this.showExcluded ? "Hide" : "Show"} excluded topics (${this.excludedCount})`;
  }

  handleToggleExcluded() {
    this.showExcluded = !this.showExcluded;
  }

  handleOpenRecommendation(event) {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: {
          section: "recommendations",
          recordId: event.currentTarget.dataset.id
        }
      })
    );
  }

  // ---------- Exports ----------

  handleExport(event) {
    const r = this.roadmap;
    const periodOf = (item) => r.periods[item.period];
    exportRows({
      name: "remediation-roadmap",
      format: event.detail.format,
      columns: [
        { label: "Rank", value: (item) => item.rank },
        {
          label: "Period",
          value: (item) => periodOf(item)?.label || "Later"
        },
        {
          label: "Start",
          value: (item) => (periodOf(item) ? isoDate(periodOf(item).start) : "")
        },
        {
          label: "End",
          value: (item) => {
            const end = r.periods[item.endPeriod];
            return end ? isoDate(end.end) : "";
          }
        },
        { label: "Theme", value: (item) => item.domain },
        { label: "Severity", value: (item) => item.severity },
        { label: "Topic", value: (item) => item.title },
        { label: "Component", value: (item) => item.componentName },
        { label: "Size", value: (item) => item.size },
        { label: "Days", value: (item) => item.days },
        { label: "Assigned to", value: (item) => item.assignedToName },
        { label: "Status", value: (item) => item.status },
        { label: "Why this rank", value: (item) => item.reason },
        { label: "Recommendation", value: (item) => item.name }
      ],
      rows: r.items
    });
  }

  handleShare(event) {
    if (event.detail.value === "copy") {
      this.handleCopyMarkdown();
    } else {
      this.handleDownloadMarkdown();
    }
  }

  async handleCopyMarkdown() {
    try {
      await copyText(toMarkdown(this.roadmap, formatDate));
      this.toast(
        "Roadmap copied",
        "Paste it in a ticket, a wiki page or an email.",
        "success"
      );
    } catch (error) {
      this.toast(
        "The roadmap could not be copied",
        reduceErrors(error),
        "error"
      );
    }
  }

  handleDownloadMarkdown() {
    downloadText(
      "remediation-roadmap.md",
      toMarkdown(this.roadmap, formatDate),
      "text/markdown"
    );
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
