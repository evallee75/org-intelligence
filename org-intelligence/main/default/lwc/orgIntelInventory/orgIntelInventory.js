import { LightningElement } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import userId from "@salesforce/user/Id";
import {
  exportRows,
  formatDate,
  formatExportDate,
  formatNumber,
  formatRelative,
  reduceErrors
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import { clearAll, downloadJson, loadValue, saveValue } from "c/orgIntelStore";

const getDataset = moduleAction("inventory", "getDataset");

/** Clés orgIntelStore : une par jeu de données (`inventory.<jeu>`). */
const STORE_PREFIX = "inventory.";
const storeKey = (name) => `${STORE_PREFIX}${name}`;
/** Anciennes clés localStorage directes (avant orgIntelStore), reprises au chargement. */
const LEGACY_PREFIX = "orgIntelligence.inventory.v1";
/** Type des fichiers du menu Data. */
const FILE_KIND = "inventory";

/** Familles et jeux de données (clés d'OrgInventoryService.DATASETS). */
const GROUPS = [
  {
    name: "User interface",
    datasets: [
      ["vfPages", "Visualforce pages"],
      ["vfComponents", "Visualforce components"],
      ["auraComponents", "Aura components"],
      ["lwc", "Lightning web components"],
      ["lightningPages", "Lightning pages"],
      ["customTabs", "Custom tabs"],
      ["webLinks", "Buttons and links"],
      ["staticResources", "Static resources"],
      ["customLabels", "Custom labels"],
      ["emailTemplates", "Email templates"],
      ["documents", "Documents"]
    ]
  },
  {
    name: "Data model and automation",
    datasets: [
      ["pageLayouts", "Page layouts"],
      ["recordTypes", "Record types"],
      ["workflowRules", "Workflow rules"]
    ]
  },
  {
    name: "Analytics",
    datasets: [
      ["reports", "Reports"],
      ["dashboards", "Dashboards"]
    ]
  },
  {
    name: "Access",
    datasets: [
      ["roles", "Role hierarchy"],
      ["groups", "Groups and queues"]
    ]
  },
  {
    name: "Org",
    datasets: [
      ["packages", "Installed packages"],
      ["browsers", "Browsers"]
    ]
  }
];

const ALL_DATASETS = GROUPS.flatMap((group) => group.datasets);

/** Lignes affichées avant « Show more ». */
const PAGE_SIZE = 100;

/** Lit les anciennes entrées localStorage (avant orgIntelStore), à reprendre une seule fois. */
function readLegacy(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function removeLegacy(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignoré
  }
}

const isEntry = (entry) => Boolean(entry && entry.savedAt && entry.data);

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
 * Section « Inventory » : inventaire des métadonnées à la manière d'Org Check. Aucun objet
 * personnalisé : chaque liste est calculée à la demande par le module Inventory et gardée dans le
 * navigateur par orgIntelStore (une clé par liste, par utilisateur). « Refresh » la recalcule.
 */
export default class OrgIntelInventory extends LightningElement {
  cache = {};
  selected = null;
  loadingName = null;
  error;
  search = "";
  onlyIssues = true;
  hideManaged = true;
  limit = PAGE_SIZE;
  openIds = [];
  isScanningAll = false;
  scanProgress = 0;

  connectedCallback() {
    this.loadCache();
  }

  /** Charge les listes gardées ; reprend au passage les anciennes clés localStorage. */
  async loadCache() {
    const cache = {};
    for (const [name] of ALL_DATASETS) {
      // eslint-disable-next-line no-await-in-loop
      let entry = await loadValue(storeKey(name), null);
      const legacyKey = this.legacyKey(name);
      const legacy = readLegacy(legacyKey);
      if (legacy) {
        if (!isEntry(entry) && isEntry(legacy)) {
          entry = legacy;
          try {
            // eslint-disable-next-line no-await-in-loop
            await saveValue(storeKey(name), legacy);
            removeLegacy(legacyKey);
          } catch {
            // Quota atteint : l'ancienne entrée reste où elle est
          }
        } else {
          removeLegacy(legacyKey);
        }
      }
      if (isEntry(entry)) {
        cache[name] = entry;
      }
    }
    this.cache = { ...cache, ...this.cache };
  }

  legacyKey(name) {
    return `${LEGACY_PREFIX}.${userId}.${name}`;
  }

  /** Garde une liste ; si le stockage est plein, le résultat reste affiché sans être gardé. */
  async keep(name, entry) {
    try {
      await saveValue(storeKey(name), entry);
    } catch (error) {
      this.dispatchEvent(
        new ShowToastEvent({
          title: "The list could not be kept in this browser",
          message: reduceErrors(error),
          variant: "warning"
        })
      );
    }
  }

  // ---------- Chargement ----------

  async fetch(name) {
    this.loadingName = name;
    try {
      const data = await getDataset({ name });
      const entry = { savedAt: new Date().toISOString(), data };
      await this.keep(name, entry);
      this.cache = { ...this.cache, [name]: entry };
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.loadingName = null;
    }
  }

  async handleSelect(event) {
    const name = event.currentTarget.dataset.name;
    this.selected = name;
    this.search = "";
    this.limit = PAGE_SIZE;
    this.openIds = [];
    this.error = undefined;
    if (!this.cache[name]) {
      await this.fetch(name);
    }
  }

  handleBack() {
    this.selected = null;
  }

  handleRefresh() {
    this.fetch(this.selected);
  }

  async handleScanAll() {
    this.isScanningAll = true;
    this.scanProgress = 0;
    for (const [name] of ALL_DATASETS) {
      // Appels successifs : un jeu de données par transaction Apex
      // eslint-disable-next-line no-await-in-loop
      await this.fetch(name);
      this.scanProgress += 1;
    }
    this.isScanningAll = false;
  }

  /** Menu Data › effacer (confirmé) : toutes les listes gardées. */
  async handleClearCache() {
    await clearAll(STORE_PREFIX);
    for (const [name] of ALL_DATASETS) {
      removeLegacy(this.legacyKey(name));
    }
    this.cache = {};
    this.selected = null;
  }

  handleSaveFile() {
    const day = new Date().toISOString().slice(0, 10);
    downloadJson(`org-intelligence-inventory-${day}.json`, FILE_KIND, {
      datasets: this.cache
    });
  }

  /** Fichier ouvert : par liste, la plus récente gagne (celle du fichier ou celle du navigateur). */
  async handleOpenFile(event) {
    if (!(await confirmOtherOrg(event.detail.envelope))) {
      return;
    }
    const datasets = event.detail.data?.datasets;
    if (!datasets || typeof datasets !== "object") {
      this.toastMessage(
        "The file could not be opened",
        "This file contains no inventory.",
        "error"
      );
      return;
    }
    const known = new Set(ALL_DATASETS.map(([name]) => name));
    const next = { ...this.cache };
    let added = 0;
    for (const [name, entry] of Object.entries(datasets)) {
      const current = next[name];
      if (
        known.has(name) &&
        isEntry(entry) &&
        (!current || new Date(entry.savedAt) > new Date(current.savedAt))
      ) {
        next[name] = entry;
        added++;
        // eslint-disable-next-line no-await-in-loop
        await this.keep(name, entry);
      }
    }
    this.cache = next;
    this.toastMessage(
      "File opened",
      `${added} list(s) updated (the most recent version of each list is kept).`,
      "success"
    );
  }

  handleDataError(event) {
    this.toastMessage(
      "The file could not be opened",
      event.detail.message,
      "error"
    );
  }

  toastMessage(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }

  // ---------- Vue d'ensemble ----------

  get groups() {
    return GROUPS.map((group) => ({
      name: group.name,
      datasets: group.datasets.map(([name, label]) => {
        const entry = this.cache[name];
        const data = entry?.data;
        const issues = data?.withIssues || 0;
        return {
          name,
          label,
          loaded: Boolean(data),
          isLoading: this.loadingName === name,
          totalText: data ? formatNumber(data.total) : "—",
          issuesText: data ? `${formatNumber(issues)} to review` : "Not loaded",
          tileClass: `tile${!data ? " tile-empty" : issues ? " tile-issues" : " tile-clean"}`,
          title: data
            ? `${label}: ${data.total} item(s), ${issues} with something to review. Loaded ${formatRelative(entry.savedAt)}.`
            : `${label}: click to load`
        };
      })
    }));
  }

  get loadedCount() {
    return Object.keys(this.cache).length;
  }

  get totalIssues() {
    return Object.values(this.cache).reduce(
      (sum, entry) => sum + (entry.data?.withIssues || 0),
      0
    );
  }

  get totalItems() {
    return Object.values(this.cache).reduce(
      (sum, entry) => sum + (entry.data?.total || 0),
      0
    );
  }

  get overviewCaption() {
    if (!this.loadedCount) {
      return "Nothing loaded yet. Click a list, or analyze everything at once.";
    }
    return `${formatNumber(this.totalItems)} items in ${this.loadedCount} of ${ALL_DATASETS.length} lists · ${formatNumber(this.totalIssues)} to review`;
  }

  get scanLabel() {
    return this.isScanningAll
      ? `Analyzing… ${this.scanProgress} / ${ALL_DATASETS.length}`
      : this.noCache
        ? "Run analysis"
        : "Run again";
  }

  get scanDisabled() {
    return this.isScanningAll || Boolean(this.loadingName);
  }

  get noCache() {
    return !this.loadedCount;
  }

  // ---------- Liste sélectionnée ----------

  get isOverview() {
    return !this.selected;
  }

  get current() {
    return this.selected ? this.cache[this.selected] : null;
  }

  get currentLabel() {
    return ALL_DATASETS.find(([name]) => name === this.selected)?.[1] || "";
  }

  get isLoadingCurrent() {
    return this.loadingName === this.selected && !this.current;
  }

  get isRefreshing() {
    return this.loadingName === this.selected;
  }

  get currentCaption() {
    const entry = this.current;
    if (!entry) {
      return "";
    }
    return `${formatNumber(entry.data.total)} item(s) · ${formatNumber(entry.data.withIssues)} to review · loaded ${formatRelative(entry.savedAt)}, kept in your browser`;
  }

  get warnings() {
    return (this.current?.data?.warnings || []).map((text, index) => ({
      key: `w${index}`,
      text
    }));
  }

  get hasWarnings() {
    return this.warnings.length > 0;
  }

  get warningSummary() {
    return this.warnings.length === 1
      ? this.warnings[0].text
      : `${this.warnings.length} remarks: ${this.warnings.map((w) => w.text).join(" · ")}`;
  }

  get isRoles() {
    return this.selected === "roles";
  }

  get filteredItems() {
    const term = this.search.trim().toLowerCase();
    return (this.current?.data?.items || []).filter((item) => {
      if (this.onlyIssues && !(item.issues || []).length && !this.isRoles) {
        return false;
      }
      if (this.hideManaged && item.namespace) {
        return false;
      }
      if (!term) {
        return true;
      }
      return [
        item.name,
        item.label,
        item.parent,
        item.detail,
        ...(item.issues || [])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }

  get rows() {
    const open = new Set(this.openIds);
    return this.filteredItems.slice(0, this.limit).map((item) => {
      const issues = item.issues || [];
      const isOpen = open.has(item.id);
      return {
        ...item,
        displayName:
          item.label && item.label !== item.name ? item.label : item.name,
        apiName: item.label && item.label !== item.name ? item.name : "",
        meta: [item.parent, item.detail].filter(Boolean).join(" · "),
        apiText: item.apiVersion ? Number(item.apiVersion).toFixed(1) : "",
        usedText:
          item.usedBy === null || item.usedBy === undefined
            ? ""
            : formatNumber(item.usedBy),
        modifiedText: item.lastModified ? formatDate(item.lastModified) : "",
        firstIssue: issues[0] || "",
        moreIssues: issues.length > 1 ? `+${issues.length - 1}` : "",
        hasIssues: issues.length > 0,
        issueList: issues.map((text, index) => ({
          key: `${item.id}-${index}`,
          text
        })),
        isOpen,
        cannotOpen: !(issues.length > 0 || Boolean(item.description)),
        toggleIcon: isOpen ? "utility:chevrondown" : "utility:chevronright",
        rowClass: `item${issues.length ? " item-issue" : ""}`,
        nameStyle: this.isRoles
          ? `padding-left: ${((item.level || 1) - 1) * 1.25}rem`
          : "",
        setupLink: item.setupUrl || "",
        hasSetupLink: Boolean(item.setupUrl)
      };
    });
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  get hasMore() {
    return this.filteredItems.length > this.limit;
  }

  get moreLabel() {
    return `Show more (${formatNumber(this.filteredItems.length - this.limit)} left)`;
  }

  get emptyText() {
    return this.onlyIssues
      ? "Nothing to review in this list."
      : "No item in this list.";
  }

  handleMore() {
    this.limit += PAGE_SIZE;
  }

  handleSearch(event) {
    this.search = event.target.value || "";
    this.limit = PAGE_SIZE;
  }

  handleOnlyIssues(event) {
    this.onlyIssues = event.target.checked;
    this.limit = PAGE_SIZE;
  }

  handleHideManaged(event) {
    this.hideManaged = event.target.checked;
    this.limit = PAGE_SIZE;
  }

  handleToggle(event) {
    const id = event.currentTarget.dataset.id;
    this.openIds = this.openIds.includes(id)
      ? this.openIds.filter((value) => value !== id)
      : [...this.openIds, id];
  }

  get errorText() {
    return this.error ? reduceErrors(this.error) : "";
  }

  // ---------- Export ----------

  handleExport(event) {
    exportRows({
      name: `inventory-${this.selected}`,
      format: event.detail.format,
      columns: [
        { label: "Name", value: (row) => row.name },
        { label: "Label", value: (row) => row.label },
        { label: "Type", value: (row) => row.kind },
        { label: "Namespace", value: (row) => row.namespace },
        { label: "Object / folder", value: (row) => row.parent },
        { label: "Detail", value: (row) => row.detail },
        { label: "API version", value: (row) => row.apiVersion },
        { label: "Used by", value: (row) => row.usedBy },
        { label: "Description", value: (row) => row.description },
        {
          label: "Last modified",
          value: (row) => formatExportDate(row.lastModified)
        },
        { label: "To review", value: (row) => (row.issues || []).join(" · ") }
      ],
      rows: this.filteredItems
    });
  }

  handleExportAll(event) {
    const sheets = ALL_DATASETS.filter(([name]) => this.cache[name]).map(
      ([name, label]) => ({
        name: label.slice(0, 31),
        rows: this.cache[name].data.items,
        columns: [
          { label: "Name", value: (row) => row.name },
          { label: "Label", value: (row) => row.label },
          { label: "Namespace", value: (row) => row.namespace },
          { label: "Object / folder", value: (row) => row.parent },
          { label: "Detail", value: (row) => row.detail },
          { label: "API version", value: (row) => row.apiVersion },
          { label: "Used by", value: (row) => row.usedBy },
          { label: "To review", value: (row) => (row.issues || []).join(" · ") }
        ]
      })
    );
    exportRows({ name: "inventory", format: event.detail.format, sheets });
  }
}
