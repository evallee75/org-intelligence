import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import {
  exportRows,
  formatDate,
  formatExportDate,
  formatNumber,
  formatRelative,
  reduceErrors
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import {
  downloadJson,
  loadValue,
  pushHistory,
  removeValue,
  saveValue,
  storageProtection,
  STORE_KEYS
} from "c/orgIntelStore";
import { sendRecommendations } from "c/orgIntelRecommendationStore";

const runAnalysis = moduleAction("adoption", "runAnalysis");
const CONTRACT_HELP =
  "Enter the lines of your order form and link each one to a license of the org: Org Intelligence compares them with what is actually used. Prices stay in this browser.";
const compareContract = moduleAction("adoption", "compareContract");
const prefillContract = moduleAction("adoption", "prefillContract");
const buildRecommendations = moduleAction("adoption", "buildRecommendations");

/** Analyses résumées gardées dans le navigateur (le détail : dernière analyse seulement). */
const HISTORY_MAX = 24;
/** Type des fichiers d'export et d'import, pour le partage entre administrateurs. */
const FILE_KIND = "adoption";

/** Champs saisis d'une ligne de contrat (gardés dans le navigateur). */
const LINE_FIELDS = [
  "id",
  "product",
  "lineType",
  "cloud",
  "quantity",
  "unitPrice",
  "pricePeriod",
  "startDate",
  "endDate",
  "matchedKey",
  "matchedLabel",
  "notes"
];

function newLineId() {
  return `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Ligne de contrat réduite aux champs saisis, avec un id local. */
function cleanLine(line) {
  const clean = {};
  LINE_FIELDS.forEach((field) => {
    const value = line[field];
    clean[field] = value === undefined || value === "" ? null : value;
  });
  ["quantity", "unitPrice"].forEach((field) => {
    const number = clean[field] === null ? NaN : Number(clean[field]);
    clean[field] = Number.isFinite(number) ? number : null;
  });
  clean.id = clean.id || newLineId();
  return clean;
}

/** Résumé d'une analyse pour l'historique (petit : date, score, clouds, taux, coût inutilisé). */
function historyEntry(analysis, contract) {
  const licenses = analysis.licenses || {};
  const paid = licenses.paidSeats || 0;
  const active = Math.max(
    (licenses.usedPaidSeats || 0) - (licenses.inactiveUsers || 0),
    0
  );
  return {
    id: `A${Date.now().toString(36)}`,
    generatedAt: analysis.generatedAt,
    generatedBy: analysis.generatedBy,
    score: analysis.score,
    clouds: analysis.selectedClouds || [],
    activeSeatUtilization: paid
      ? Math.round((active * 1000) / paid) / 10
      : null,
    annualWaste: contract && contract.priced ? contract.annualWaste : null
  };
}

const CONTRACT_VERDICTS = {
  "Unused licenses": { tone: "serious", actionable: true, order: 0 },
  "Check quantity": { tone: "warning", actionable: true, order: 1 },
  "Over limit": { tone: "critical", actionable: false, order: 2 },
  "Not matched": { tone: "neutral", actionable: false, order: 3 },
  "No quantity": { tone: "neutral", actionable: false, order: 4 },
  "Fully used": { tone: "good", actionable: false, order: 5 }
};

const LINE_TYPES = [
  { value: "User license", label: "User license" },
  { value: "Add-on", label: "Add-on" },
  { value: "Usage entitlement", label: "Usage entitlement" },
  { value: "Other", label: "Other" }
];

const PRICE_PERIODS = [
  { value: "Per month", label: "Per month" },
  { value: "Per year", label: "Per year" }
];

const CONTRACT_CLOUDS = [
  { value: "", label: "None" },
  { value: "Sales Cloud", label: "Sales Cloud" },
  { value: "Service Cloud", label: "Service Cloud" },
  { value: "Platform", label: "Platform" },
  { value: "Experience Cloud", label: "Experience Cloud" },
  { value: "Field Service", label: "Field Service" }
];

const EMPTY_LINE = {
  id: null,
  product: "",
  lineType: "User license",
  cloud: "",
  quantity: null,
  unitPrice: null,
  pricePeriod: "Per month",
  startDate: null,
  endDate: null,
  matchedKey: "",
  notes: ""
};

/** Statuts des fonctionnalités : ordre d'affichage, couleur et sélection possible. */
const FEATURE_STATUSES = {
  "Not used": { tone: "serious", order: 0, actionable: true },
  "Not enabled": { tone: "neutral", order: 1, actionable: true },
  Partial: { tone: "warning", order: 2, actionable: true },
  Adopted: { tone: "good", order: 3, actionable: false },
  Unknown: { tone: "neutral", order: 4, actionable: false }
};

const LICENSE_VERDICTS = {
  "Seats to reclaim": { tone: "serious", actionable: true },
  "Over-allocated": { tone: "critical", actionable: false },
  OK: { tone: "good", actionable: false },
  Included: { tone: "neutral", actionable: false },
  Inactive: { tone: "neutral", actionable: false }
};

const ADDON_VERDICTS = {
  "Never assigned": { tone: "warning", actionable: true },
  "Low use": { tone: "warning", actionable: true },
  "In use": { tone: "good", actionable: false },
  "Near limit": { tone: "warning", actionable: false },
  "Over limit": { tone: "critical", actionable: false },
  "Expiring soon": { tone: "warning", actionable: false },
  Expired: { tone: "critical", actionable: false },
  "Site-wide": { tone: "neutral", actionable: false },
  Inactive: { tone: "neutral", actionable: false }
};

const STATUS_FILTERS = [
  { value: "gaps", label: "Not used, not enabled or partial" },
  { value: "all", label: "All features" },
  { value: "Not used", label: "Not used" },
  { value: "Not enabled", label: "Not enabled" },
  { value: "Partial", label: "Partial" },
  { value: "Adopted", label: "Adopted" }
];

const ADDON_FILTERS = [
  { value: "all", label: "All add-ons" },
  { value: "Permission set license", label: "Permission set licenses" },
  { value: "Managed package", label: "Managed packages" },
  { value: "Usage entitlement", label: "Usage entitlements" }
];

function meterTone(percent, { invert = false } = {}) {
  if (percent === null || percent === undefined) {
    return "neutral";
  }
  // invert : un taux élevé est une bonne nouvelle (adoption, licences utilisées)
  const value = invert ? 100 - percent : percent;
  if (value >= 50) {
    return "critical";
  }
  if (value >= 25) {
    return "warning";
  }
  return "good";
}

function fillStyle(percent) {
  const width = Math.max(0, Math.min(100, Number(percent) || 0));
  return `width: ${width}%`;
}

function displayPercent(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value)} %`;
}

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
 * Section « Adoption » : utilisons-nous pleinement Salesforce ? Licences payées face aux licences
 * attribuées et utilisées, add-ons jamais attribués, et usage des fonctionnalités natives des clouds
 * de l'org. Les écarts peuvent être envoyés au module Recommendations.
 */
export default class OrgIntelAdoption extends LightningElement {
  @api modules = [];

  /** Dernière analyse (gardée dans le navigateur). */
  analysis = null;
  /** Comparaison du contrat avec l'analyse, calculée par Apex. */
  contract = {};
  /** Lignes du contrat saisies (gardées dans le navigateur). */
  contractRecords = [];
  /** Résumés des analyses précédentes, la plus récente en tête. */
  history = [];
  error;
  isLoading = true;
  isRunning = false;
  isSending = false;
  activeTab = "features";
  statusFilter = "gaps";
  cloudScope = "selected";
  addOnFilter = "all";
  search = "";
  selectedKeys = [];
  expandedKeys = [];
  showCloudPicker = false;
  cloudDraft = [];

  statusFilters = STATUS_FILTERS;
  addOnFilters = ADDON_FILTERS;
  trendSeries = [
    { key: "score", label: "Adoption score", tone: "accent" },
    { key: "seats", label: "Seats actively used (%)", tone: "good" }
  ];

  connectedCallback() {
    this.load();
    this.loadProtection();
  }

  /** Protection des données sensibles dans ce navigateur (C12) : chiffrées, ou onglet seulement. */
  protection = null;
  unloadGuarded = false;

  async loadProtection() {
    try {
      this.protection = await storageProtection();
    } catch {
      this.protection = null;
    }
    this.toggleUnloadGuard(this.isSessionOnly);
  }

  disconnectedCallback() {
    this.toggleUnloadGuard(false);
  }

  get protectionMessage() {
    return this.protection?.message || "";
  }

  /** Sans chiffrement possible : données gardées pour cet onglet seulement. */
  get isSessionOnly() {
    return this.protection?.mode === "session";
  }

  get showSessionNote() {
    return this.isSessionOnly && Boolean(this.protectionMessage);
  }

  /** Mode « session » : le navigateur demande confirmation avant de fermer l'onglet. */
  handleBeforeUnload = (event) => {
    if (this.contractRecords.length > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  };

  toggleUnloadGuard(enabled) {
    if (enabled && !this.unloadGuarded) {
      window.addEventListener("beforeunload", this.handleBeforeUnload);
      this.unloadGuarded = true;
    } else if (!enabled && this.unloadGuarded) {
      window.removeEventListener("beforeunload", this.handleBeforeUnload);
      this.unloadGuarded = false;
    }
  }

  get contractHelp() {
    return [CONTRACT_HELP, this.protectionMessage].filter(Boolean).join(" ");
  }

  async load() {
    this.isLoading = !this.analysis;
    try {
      const [analysis, records, history] = await Promise.all([
        loadValue(STORE_KEYS.ADOPTION, null),
        loadValue(STORE_KEYS.ADOPTION_CONTRACT, []),
        loadValue(STORE_KEYS.ADOPTION_HISTORY, [])
      ]);
      this.analysis = analysis;
      this.contractRecords = Array.isArray(records) ? records : [];
      this.history = Array.isArray(history) ? history : [];
      await this.refreshContract();
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  /** Recalcule la comparaison du contrat avec la dernière analyse (Apex, sans écriture). */
  async refreshContract() {
    if (!this.analysis && !this.contractRecords.length) {
      this.contract = {};
      return;
    }
    this.contract =
      (await compareContract({
        analysis: this.analysis,
        contractLines: this.contractRecords
      })) || {};
  }

  handleRefresh() {
    this.load();
  }

  async handleRun() {
    await this.run(this.analysis?.selectedClouds || []);
  }

  async run(clouds) {
    this.isRunning = true;
    try {
      const view = await runAnalysis({
        clouds,
        contractLines: this.contractRecords
      });
      this.analysis = view.analysis;
      this.contract = view.contract || {};
      this.error = undefined;
      this.selectedKeys = [];
      await this.persistAnalysis();
      this.toast(
        "Adoption analysis completed",
        `Adoption score ${this.scoreValue}.`,
        "success"
      );
    } catch (error) {
      this.toast(
        "The adoption analysis could not be run",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.isRunning = false;
    }
  }

  /** Garde la dernière analyse et ajoute son résumé à l'historique. */
  async persistAnalysis() {
    try {
      await saveValue(STORE_KEYS.ADOPTION, this.analysis);
      this.history = await pushHistory(
        STORE_KEYS.ADOPTION_HISTORY,
        historyEntry(this.analysis, this.contract),
        HISTORY_MAX
      );
    } catch (error) {
      this.toast(
        "The analysis could not be kept in this browser",
        reduceErrors(error),
        "warning"
      );
    }
  }

  /** Enregistre les lignes du contrat dans le navigateur puis recalcule la comparaison. */
  async saveContract(records) {
    const clean = records.map(cleanLine);
    await saveValue(STORE_KEYS.ADOPTION_CONTRACT, clean);
    this.contractRecords = clean;
    await this.refreshContract();
  }

  // ---------- Données ----------

  get hasAnalysis() {
    return Boolean(this.analysis);
  }

  get licenses() {
    return this.analysis?.licenses || {};
  }

  get subtitle() {
    if (!this.hasAnalysis) {
      return "Licenses paid versus used, and the native features your org uses or ignores.";
    }
    const parts = [
      `Analyzed ${formatRelative(this.analysis.generatedAt)}`,
      this.analysis.generatedBy ? `by ${this.analysis.generatedBy}` : null,
      this.analysis.edition,
      this.analysis.isSandbox ? "sandbox" : null
    ].filter(Boolean);
    return parts.join(" · ");
  }

  get isSandboxAnalysis() {
    return Boolean(this.analysis?.isSandbox);
  }

  get runLabel() {
    return this.hasAnalysis ? "Run again" : "Run analysis";
  }

  get warnings() {
    return (this.licenses.warnings || []).map((text, index) => ({
      key: `w${index}`,
      text
    }));
  }

  get hasWarnings() {
    return this.warnings.length > 0;
  }

  // ---------- Indicateurs ----------

  get scoreValue() {
    const score = this.analysis?.score;
    return score === null || score === undefined ? "—" : `${score} / 100`;
  }

  get scoreMeter() {
    const score = this.analysis?.score ?? 0;
    return {
      style: fillStyle(score),
      className: `meter-fill tone-${meterTone(score, { invert: true })}`,
      percent: score
    };
  }

  get scoreCaption() {
    const clouds = this.analysis?.selectedClouds || [];
    return clouds.length ? `On ${clouds.join(", ")}` : "No cloud in scope";
  }

  get paidSeats() {
    return this.licenses.paidSeats || 0;
  }

  get activeSeatPercent() {
    if (!this.paidSeats) {
      return null;
    }
    const active = Math.max(
      (this.licenses.usedPaidSeats || 0) - (this.licenses.inactiveUsers || 0),
      0
    );
    return (active * 100) / this.paidSeats;
  }

  get seatValue() {
    return displayPercent(this.activeSeatPercent);
  }

  get seatMeter() {
    const percent = this.activeSeatPercent ?? 0;
    return {
      style: fillStyle(percent),
      className: `meter-fill tone-${meterTone(percent, { invert: true })}`,
      percent: Math.round(percent)
    };
  }

  get seatCaption() {
    const used = this.licenses.usedPaidSeats || 0;
    const active = Math.max(used - (this.licenses.inactiveUsers || 0), 0);
    return `${formatNumber(active)} of ${formatNumber(this.paidSeats)} paid seats`;
  }

  get reclaimableSeats() {
    return (
      (this.licenses.unusedSeats || 0) + (this.licenses.inactiveUsers || 0)
    );
  }

  get reclaimValue() {
    return formatNumber(this.reclaimableSeats);
  }

  get reclaimCaption() {
    return `${formatNumber(this.licenses.inactiveUsers || 0)} inactive · ${formatNumber(this.licenses.unusedSeats || 0)} unassigned`;
  }

  get hasReclaimCost() {
    return Boolean(this.contract.priced && this.contract.annualWaste);
  }

  get reclaimCost() {
    return `≈ ${this.formatMoney(this.contract.annualWaste)} / year`;
  }

  get seatHelp() {
    return `Paid user licenses held by users who logged in during the last ${this.analysis?.inactiveDays || 90} days. Free licenses (guest, Chatter, Identity, integration) are excluded.`;
  }

  get reclaimHelp() {
    return `Licenses you pay for but nobody uses: unassigned seats, plus seats held by users without login for ${this.analysis?.inactiveDays || 90} days. The yearly cost comes from the prices entered in the Contract tab.`;
  }

  get scoreHelp() {
    return "Share of the native features of your clouds that are actually used (adopted = 1, partial = 0.5). Click to see the features.";
  }

  /** Clic sur un indicateur : ouvre l'onglet correspondant. */
  handleKpi(event) {
    const { tab, filter } = event.currentTarget.dataset;
    this.activeTab = tab;
    if (filter) {
      this.statusFilter = filter;
      this.cloudScope = "selected";
    }
  }

  handleKpiKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleKpi(event);
    }
  }

  /** Dépliage d'une ligne (fonctionnalité, ligne de contrat). */
  handleToggle(event) {
    const key = event.currentTarget.dataset.key;
    const keys = new Set(this.expandedKeys);
    if (keys.has(key)) {
      keys.delete(key);
    } else {
      keys.add(key);
    }
    this.expandedKeys = [...keys];
  }

  toggleState(key) {
    const expanded = this.expandedKeys.includes(key);
    return {
      expanded,
      toggleIcon: expanded ? "utility:chevrondown" : "utility:chevronright",
      toggleLabel: expanded ? "Hide details" : "Show details"
    };
  }

  get unusedFeatureCount() {
    return this.features.filter(
      (f) =>
        f.inScope && (f.status === "Not used" || f.status === "Not enabled")
    ).length;
  }

  get unusedFeatureValue() {
    return formatNumber(this.unusedFeatureCount);
  }

  get unusedFeatureCaption() {
    const inScope = this.features.filter(
      (f) => f.inScope && f.status !== "Unknown"
    ).length;
    return `of ${inScope} features in scope`;
  }

  get activeUsersCaption() {
    const active = this.licenses.activeInternalUsers || 0;
    const recent = this.licenses.loggedInLast30 || 0;
    return `${formatNumber(recent)} of ${formatNumber(active)} active internal users logged in during the last 30 days`;
  }

  // ---------- Onglets ----------

  get tabs() {
    return [
      { name: "features", label: "Features", count: this.features.length },
      {
        name: "licenses",
        label: "User licenses",
        count: this.userLicenses.length
      },
      { name: "addons", label: "Add-ons", count: this.allAddOns.length },
      {
        name: "contract",
        label: "Contract",
        count: this.contractRecords.length
      }
    ].map((tab) => ({
      ...tab,
      selected: tab.name === this.activeTab,
      className: `ad-tab${tab.name === this.activeTab ? " tab-active" : ""}`
    }));
  }

  handleTab(event) {
    this.activeTab = event.currentTarget.dataset.name;
  }

  get isFeaturesTab() {
    return this.activeTab === "features";
  }

  get isLicensesTab() {
    return this.activeTab === "licenses";
  }

  get isContractTab() {
    return this.activeTab === "contract";
  }

  get isAddOnsTab() {
    return this.activeTab === "addons";
  }

  // ---------- Clouds ----------

  get clouds() {
    return (this.analysis?.clouds || []).map((cloud) => {
      const score = cloud.score;
      return {
        ...cloud,
        detectedLabel: cloud.detected ? "Detected" : "Not detected",
        detectedTone: cloud.detected ? "info" : "neutral",
        scopeLabel: cloud.selected ? "In scope" : "Out of scope",
        scoreText: score === null || score === undefined ? "—" : `${score}`,
        meterStyle: fillStyle(score),
        meterClass: `meter-fill tone-${meterTone(score, { invert: true })}`,
        countsText: `${cloud.adopted || 0} adopted · ${cloud.partial || 0} partial · ${(cloud.unused || 0) + (cloud.notEnabled || 0)} not used`,
        signalText: cloud.signal || "No license or usage found for this cloud",
        tooltip: `${cloud.name}: ${cloud.adopted || 0} adopted, ${cloud.partial || 0} partial, ${(cloud.unused || 0) + (cloud.notEnabled || 0)} not used. ${cloud.detected ? "Detected" : "Not detected"}: ${cloud.signal || "no license or usage found"}. Click to see its features.`,
        gapText: `${(cloud.unused || 0) + (cloud.notEnabled || 0)} not used`,
        className: `cloud${cloud.selected ? "" : " cloud-out"}${this.cloudScope === cloud.name && this.isFeaturesTab ? " cloud-active" : ""}`
      };
    });
  }

  get selectedCloudNames() {
    return new Set(this.analysis?.selectedClouds || []);
  }

  get cloudScopeOptions() {
    return [
      { value: "selected", label: "Clouds in scope" },
      { value: "all", label: "All clouds" },
      ...(this.analysis?.clouds || []).map((cloud) => ({
        value: cloud.name,
        label: cloud.name
      }))
    ];
  }

  handleCloudClick(event) {
    const name = event.currentTarget.dataset.name;
    const same = this.cloudScope === name && this.isFeaturesTab;
    this.activeTab = "features";
    this.cloudScope = same ? "selected" : name;
    this.statusFilter = same ? "gaps" : "all";
  }

  get scopeSourceText() {
    return this.analysis?.cloudSource === "Contract"
      ? "Clouds in scope come from your contract."
      : "Clouds in scope are detected from licenses and usage.";
  }

  handleCloudScope(event) {
    this.cloudScope = event.detail.value;
  }

  handleEditClouds() {
    this.cloudDraft = [...(this.analysis?.selectedClouds || [])];
    this.showCloudPicker = true;
  }

  handleCancelClouds() {
    this.showCloudPicker = false;
  }

  get cloudPickerOptions() {
    return (this.analysis?.clouds || []).map((cloud) => ({
      value: cloud.name,
      label: cloud.detected ? `${cloud.name} (detected)` : cloud.name
    }));
  }

  handleCloudDraft(event) {
    this.cloudDraft = event.detail.value;
  }

  get noCloudDraft() {
    return !this.cloudDraft.length || this.isRunning;
  }

  async handleApplyClouds() {
    this.showCloudPicker = false;
    await this.run(this.cloudDraft);
  }

  // ---------- Fonctionnalités ----------

  get features() {
    const selected = this.selectedCloudNames;
    const keys = new Set(this.selectedKeys);
    return (this.analysis?.features || []).map((feature) => {
      const meta = FEATURE_STATUSES[feature.status] || FEATURE_STATUSES.Unknown;
      const key = `FEATURE:${feature.key}`;
      return {
        ...feature,
        selectKey: key,
        tone: meta.tone,
        order: meta.order,
        actionable: meta.actionable && this.canSend,
        checked: keys.has(key),
        inScope: selected.has(feature.cloud),
        showAdvice:
          feature.status !== "Adopted" && feature.status !== "Unknown",
        checkboxLabel: `Select ${feature.label}`,
        ...this.toggleState(key)
      };
    });
  }

  get visibleFeatures() {
    const term = this.search.trim().toLowerCase();
    return this.features
      .filter((feature) => {
        if (this.cloudScope === "selected" && !feature.inScope) {
          return false;
        }
        if (
          !["selected", "all"].includes(this.cloudScope) &&
          feature.cloud !== this.cloudScope
        ) {
          return false;
        }
        if (this.statusFilter === "gaps") {
          if (
            !["Not used", "Not enabled", "Partial"].includes(feature.status)
          ) {
            return false;
          }
        } else if (
          this.statusFilter !== "all" &&
          feature.status !== this.statusFilter
        ) {
          return false;
        }
        return (
          !term ||
          `${feature.label} ${feature.description} ${feature.metric}`
            .toLowerCase()
            .includes(term)
        );
      })
      .sort((a, b) => a.order - b.order || b.weight - a.weight);
  }

  get featureGroups() {
    const groups = [];
    for (const cloud of this.clouds) {
      const features = this.visibleFeatures.filter(
        (feature) => feature.cloud === cloud.name
      );
      if (features.length) {
        groups.push({ ...cloud, features });
      }
    }
    return groups;
  }

  get hasVisibleFeatures() {
    return this.featureGroups.length > 0;
  }

  handleStatusFilter(event) {
    this.statusFilter = event.detail.value;
  }

  handleSearch(event) {
    this.search = event.target.value || "";
  }

  // ---------- Licences utilisateur ----------

  get userLicenses() {
    const keys = new Set(this.selectedKeys);
    return (this.licenses.userLicenses || [])
      .map((license) => {
        const meta = LICENSE_VERDICTS[license.verdict] || LICENSE_VERDICTS.OK;
        const key = `LICENSE:${license.name}`;
        const percent = license.utilization ?? 0;
        return {
          ...license,
          selectKey: key,
          tone: meta.tone,
          actionable: meta.actionable && this.canSend,
          checked: keys.has(key),
          usedText: `${formatNumber(license.used)} / ${formatNumber(license.total)}`,
          unusedText: formatNumber(license.unused),
          inactiveText: license.included ? "—" : formatNumber(license.inactive),
          frozenText: license.frozen ? formatNumber(license.frozen) : "—",
          utilizationText: displayPercent(license.utilization),
          meterStyle: fillStyle(percent),
          meterClass: `bar-fill${license.included ? " bar-muted" : ""}`,
          checkboxLabel: `Select ${license.name}`,
          rank: license.included ? 1 : 0
        };
      })
      .sort((a, b) => a.rank - b.rank || b.total - a.total);
  }

  get featureLicenses() {
    return (this.licenses.featureLicenses || []).map((row) => ({
      ...row,
      assignedText: formatNumber(row.assigned),
      inactiveText: formatNumber(row.inactive),
      inactiveClass: row.inactive > 0 ? "num warn-text" : "num"
    }));
  }

  get hasFeatureLicenses() {
    return this.featureLicenses.length > 0;
  }

  get neverLoggedInText() {
    return formatNumber(this.licenses.neverLoggedIn || 0);
  }

  // ---------- Add-ons ----------

  get allAddOns() {
    const keys = new Set(this.selectedKeys);
    return (this.licenses.addOns || []).map((addOn) => {
      const meta = ADDON_VERDICTS[addOn.verdict] || ADDON_VERDICTS["In use"];
      const key = `ADDON:${addOn.key}`;
      const hasTotal = addOn.total !== null && addOn.total !== undefined;
      return {
        ...addOn,
        selectKey: key,
        tone: meta.tone,
        actionable: meta.actionable && this.canSend,
        checked: keys.has(key),
        usedText: hasTotal
          ? `${formatNumber(addOn.used)} / ${formatNumber(addOn.total)}`
          : formatNumber(addOn.used),
        utilizationText: displayPercent(addOn.utilization),
        meterStyle: fillStyle(addOn.utilization),
        hasMeter: hasTotal,
        expirationText: addOn.expirationDate
          ? formatDate(addOn.expirationDate)
          : "—",
        unitText: addOn.unit || "",
        checkboxLabel: `Select ${addOn.name}`
      };
    });
  }

  get addOns() {
    const order = (row) => (ADDON_VERDICTS[row.verdict]?.actionable ? 0 : 1);
    return this.allAddOns
      .filter(
        (addOn) => this.addOnFilter === "all" || addOn.kind === this.addOnFilter
      )
      .sort(
        (a, b) =>
          order(a) - order(b) ||
          a.kind.localeCompare(b.kind) ||
          String(a.name).localeCompare(String(b.name))
      );
  }

  get hasAddOns() {
    return this.addOns.length > 0;
  }

  handleAddOnFilter(event) {
    this.addOnFilter = event.detail.value;
  }

  // ---------- Contrat ----------

  editingLine = null;
  isSavingLine = false;

  lineTypes = LINE_TYPES;
  pricePeriods = PRICE_PERIODS;
  contractCloudOptions = CONTRACT_CLOUDS;

  get currencyCode() {
    return this.contract.currencyCode || "EUR";
  }

  formatMoney(value) {
    if (value === null || value === undefined) {
      return "—";
    }
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: this.currencyCode,
        maximumFractionDigits: 0
      }).format(value);
    } catch {
      return `${formatNumber(Math.round(value))} ${this.currencyCode}`;
    }
  }

  get hasContract() {
    return this.contractLines.length > 0;
  }

  get contractFromContract() {
    return this.analysis?.cloudSource === "Contract";
  }

  get contractLines() {
    const keys = new Set(this.selectedKeys);
    return (this.contract.lines || [])
      .map((line) => {
        const meta =
          CONTRACT_VERDICTS[line.verdict] || CONTRACT_VERDICTS["Not matched"];
        const key = `CONTRACT:${line.id}`;
        const count = (value) => {
          return value === null || value === undefined
            ? "—"
            : formatNumber(value);
        };
        return {
          ...line,
          selectKey: key,
          tone: meta.tone,
          order: meta.order,
          actionable: meta.actionable && this.canSend,
          checked: keys.has(key),
          quantityText: count(line.quantity),
          orgTotalText: count(line.orgTotal),
          assignedText: count(line.assigned),
          activeText: count(line.active),
          unusedText: count(line.unused),
          unusedClass: line.unused > 0 ? "num warn-text" : "num",
          priceText:
            line.unitPrice === null || line.unitPrice === undefined
              ? "—"
              : `${this.formatMoney(line.unitPrice)} ${line.pricePeriod === "Per year" ? "/ year" : "/ month"}`,
          annualCostText: this.formatMoney(line.annualCost),
          annualWasteText: this.formatMoney(line.annualWaste),
          renewalText: line.endDate
            ? `${formatDate(line.endDate)}${line.renewalDays >= 0 && line.renewalDays <= 120 ? ` (in ${line.renewalDays} d)` : ""}`
            : "—",
          renewalClass:
            line.renewalDays >= 0 && line.renewalDays <= 120 ? "warn-text" : "",
          cloudText: line.cloud
            ? `${line.cloud}${line.cloudScore !== null && line.cloudScore !== undefined ? ` · ${line.cloudScore}/100` : ""}`
            : "—",
          linkedText: line.matchedLabel || "Not linked to a license",
          checkboxLabel: `Select ${line.product}`,
          editLabel: `Edit ${line.product}`,
          deleteLabel: `Delete ${line.product}`,
          usageText:
            line.active === null || line.active === undefined
              ? "—"
              : `${formatNumber(line.active)} / ${count(line.quantity)}`,
          usageStyle: fillStyle(
            line.quantity ? ((line.active || 0) * 100) / line.quantity : 0
          ),
          hasUsage: line.active !== null && line.active !== undefined,
          ...this.toggleState(key)
        };
      })
      .sort(
        (a, b) =>
          a.order - b.order || (b.annualWaste || 0) - (a.annualWaste || 0)
      );
  }

  get contractValueText() {
    return this.contract.priced
      ? this.formatMoney(this.contract.annualValue)
      : "—";
  }

  get contractWasteText() {
    return this.contract.priced
      ? this.formatMoney(this.contract.annualWaste)
      : "—";
  }

  get contractWasteCaption() {
    if (!this.contract.priced) {
      return "Enter unit prices to compute the cost";
    }
    const share = this.contract.annualValue
      ? Math.round(
          (this.contract.annualWaste * 100) / this.contract.annualValue
        )
      : 0;
    return `${share} % of the priced contract lines`;
  }

  get contractUnusedText() {
    return formatNumber(this.contract.unusedLicenses || 0);
  }

  get renewalText() {
    return this.contract.nextRenewal
      ? formatDate(this.contract.nextRenewal)
      : "—";
  }

  get renewalCaption() {
    return this.contract.nextRenewal
      ? `In ${this.contract.nextRenewalDays} days: the time to adjust quantities`
      : "Enter renewal dates on the lines";
  }

  get licenseOptions() {
    return [
      { value: "", label: "Not linked" },
      ...(this.contract.licenseOptions || [])
        .map((option) => ({ value: option.value, label: option.label }))
        .sort((a, b) => a.label.localeCompare(b.label))
    ];
  }

  handleAddLine() {
    this.editingLine = { ...EMPTY_LINE };
  }

  handleEditLine(event) {
    const line = this.contractRecords.find(
      (row) => row.id === event.currentTarget.dataset.id
    );
    if (line) {
      this.editingLine = {
        ...EMPTY_LINE,
        ...line,
        cloud: line.cloud || "",
        matchedKey: line.matchedKey || "",
        notes: line.notes || ""
      };
    }
  }

  handleCancelLine() {
    this.editingLine = null;
  }

  get noContract() {
    return !this.hasContract;
  }

  get noEditor() {
    return !this.editingLine;
  }

  get isEditingLine() {
    return Boolean(this.editingLine);
  }

  get lineEditorTitle() {
    return this.editingLine?.id
      ? "Edit the contract line"
      : "New contract line";
  }

  handleLineField(event) {
    const field = event.target.dataset.field;
    const value =
      event.detail && event.detail.value !== undefined
        ? event.detail.value
        : event.target.value;
    this.editingLine = { ...this.editingLine, [field]: value };
  }

  async handleSaveLine() {
    const inputs = [
      ...this.template.querySelectorAll(".line-editor [data-field]")
    ];
    const valid = inputs.every((input) => {
      return typeof input.reportValidity === "function"
        ? input.reportValidity()
        : true;
    });
    if (!valid) {
      return;
    }
    const line = { ...this.editingLine };
    line.product = String(line.product || "").trim();
    if (!line.product) {
      this.toast("The product name is required", "", "error");
      return;
    }
    const negative = ["quantity", "unitPrice"].some(
      (field) =>
        line[field] !== null && line[field] !== "" && Number(line[field]) < 0
    );
    if (negative) {
      this.toast(
        "The quantity and the unit price cannot be negative",
        "",
        "error"
      );
      return;
    }
    const option = (this.contract.licenseOptions || []).find(
      (row) => row.value === line.matchedKey
    );
    // Licence absente de l'analyse : on garde le libellé déjà connu
    line.matchedLabel = line.matchedKey
      ? option
        ? option.label
        : line.matchedLabel || line.matchedKey
      : null;
    this.isSavingLine = true;
    try {
      const records = line.id
        ? this.contractRecords.map((row) => (row.id === line.id ? line : row))
        : [...this.contractRecords, line];
      await this.saveContract(records);
      this.editingLine = null;
      this.toast("Contract line saved", line.product, "success");
    } catch (error) {
      this.toast(
        "The contract line could not be saved",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.isSavingLine = false;
    }
  }

  async handleDeleteLine(event) {
    const { id, product } = event.currentTarget.dataset;
    const confirmed = await LightningConfirm.open({
      message: `Delete the contract line "${product}"?`,
      label: "Delete the contract line",
      theme: "warning"
    });
    if (!confirmed) {
      return;
    }
    try {
      await this.saveContract(
        this.contractRecords.filter((row) => row.id !== id)
      );
      this.selectedKeys = this.selectedKeys.filter(
        (key) => key !== `CONTRACT:${id}`
      );
    } catch (error) {
      this.toast(
        "The contract line could not be deleted",
        reduceErrors(error),
        "error"
      );
    }
  }

  async handlePrefill() {
    try {
      const proposed =
        (await prefillContract({
          analysis: this.analysis,
          contractLines: this.contractRecords
        })) || [];
      if (proposed.length) {
        await this.saveContract([...this.contractRecords, ...proposed]);
      }
      this.toast(
        proposed.length ? "Contract prefilled" : "Nothing to prefill",
        proposed.length
          ? `${proposed.length} line(s) created from the user licenses of the org. Enter the prices and renewal dates.`
          : "Every paid user license is already linked to a contract line.",
        proposed.length ? "success" : "info"
      );
    } catch (error) {
      this.toast(
        "The contract could not be prefilled",
        reduceErrors(error),
        "error"
      );
    }
  }

  get contractRunHint() {
    return "Changes to the contract are compared with the latest analysis. Run the analysis again to apply new clouds to the score.";
  }

  // ---------- Historique ----------

  get trendPoints() {
    return [...this.history].reverse().map((point, index) => ({
      key: point.id || `h${index}`,
      label: `#${index + 1}`,
      sublabel: formatDate(point.generatedAt),
      values: {
        score: point.score ?? 0,
        seats: point.activeSeatUtilization ?? 0
      }
    }));
  }

  get hasTrend() {
    return this.trendPoints.length > 1;
  }

  // ---------- Partage par fichier ----------

  get noStoredData() {
    return (
      !this.analysis && !this.contractRecords.length && !this.history.length
    );
  }

  /** Fichier JSON : contrat, dernière analyse et historique, pour un autre navigateur ou admin. */
  handleExportData() {
    const day = new Date().toISOString().slice(0, 10);
    downloadJson(`org-intelligence-adoption-${day}.json`, FILE_KIND, {
      contract: this.contractRecords,
      analysis: this.analysis,
      history: this.history
    });
  }

  handleDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  /** Fichier ouvert par le menu Data (déjà vérifié : type « adoption »). */
  async handleDataOpen(event) {
    const { data, fileName } = event.detail;
    if (!(await confirmOtherOrg(event.detail.envelope))) {
      return;
    }
    try {
      // Fichier brut : tableau = lignes de contrat seules
      const content = Array.isArray(data) ? { contract: data } : data || {};
      const contract = Array.isArray(content.contract)
        ? content.contract.filter((line) => line && line.product)
        : null;
      const history = Array.isArray(content.history) ? content.history : [];
      const analysis =
        content.analysis && content.analysis.generatedAt
          ? content.analysis
          : null;
      if (!contract && !analysis && !history.length) {
        throw new Error("This file contains no adoption data.");
      }
      const confirmed = await LightningConfirm.open({
        message: `Open ${contract ? `${contract.length} contract line(s)` : "no contract"}${analysis ? ", an analysis" : ""}${history.length ? ` and ${history.length} history point(s)` : ""}? The most recent analysis wins and histories are merged; the contract lines of the file replace yours.`,
        label: "Open adoption data",
        theme: "warning"
      });
      if (!confirmed) {
        return;
      }
      await this.importData({ contract, analysis, history });
      this.toast("Adoption data opened", fileName, "success");
    } catch (error) {
      this.toast("The file could not be opened", reduceErrors(error), "error");
    }
  }

  /** Efface l'analyse, l'historique et le contrat gardés dans ce navigateur (confirmé par le menu). */
  async handleClearData() {
    try {
      await Promise.all([
        removeValue(STORE_KEYS.ADOPTION),
        removeValue(STORE_KEYS.ADOPTION_HISTORY),
        removeValue(STORE_KEYS.ADOPTION_CONTRACT)
      ]);
      this.analysis = null;
      this.history = [];
      this.contractRecords = [];
      this.contract = {};
      this.selectedKeys = [];
      this.toast("Adoption data cleared", "", "success");
    } catch (error) {
      this.toast("The data could not be cleared", reduceErrors(error), "error");
    }
  }

  async importData({ contract, analysis, history }) {
    const current = this.analysis?.generatedAt;
    if (
      analysis &&
      (!current || new Date(analysis.generatedAt) > new Date(current))
    ) {
      this.analysis = analysis;
      await saveValue(STORE_KEYS.ADOPTION, analysis);
    }
    if (history.length) {
      // Fusion par date d'analyse, la plus récente en tête
      const byDate = new Map();
      [...this.history, ...history].forEach((point) => {
        if (point && point.generatedAt) {
          byDate.set(point.generatedAt, point);
        }
      });
      this.history = [...byDate.values()]
        .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt))
        .slice(0, HISTORY_MAX);
      await saveValue(STORE_KEYS.ADOPTION_HISTORY, this.history);
    }
    if (contract) {
      this.selectedKeys = [];
      await this.saveContract(contract);
    } else {
      await this.refreshContract();
    }
  }

  // ---------- Recommandations ----------

  get canSend() {
    return this.hasAnalysis;
  }

  get selectedCount() {
    return this.selectedKeys.length;
  }

  get sendLabel() {
    return this.selectedCount
      ? `Send to Recommendations (${this.selectedCount})`
      : "Send to Recommendations";
  }

  get sendDisabled() {
    return !this.selectedCount || this.isSending;
  }

  handleSelect(event) {
    const key = event.target.dataset.key;
    const keys = new Set(this.selectedKeys);
    if (event.target.checked) {
      keys.add(key);
    } else {
      keys.delete(key);
    }
    this.selectedKeys = [...keys];
  }

  handleSelectGaps() {
    const keys = new Set(this.selectedKeys);
    const rows = this.isFeaturesTab
      ? this.visibleFeatures
      : this.isLicensesTab
        ? this.userLicenses
        : this.isContractTab
          ? this.contractLines
          : this.addOns;
    rows
      .filter((row) => row.actionable)
      .forEach((row) => keys.add(row.selectKey));
    this.selectedKeys = [...keys];
  }

  handleClearSelection() {
    this.selectedKeys = [];
  }

  async handleSend() {
    this.isSending = true;
    try {
      const batch = await buildRecommendations({
        analysis: this.analysis,
        contractLines: this.contractRecords,
        keys: this.selectedKeys
      });
      const result = await sendRecommendations(batch.specs || [], {
        reopenReason: batch.reopenReason
      });
      this.selectedKeys = [];
      this.toast(
        "Sent to Recommendations",
        `${result.created} created, ${result.updated} updated${batch.skipped ? `, ${batch.skipped} skipped` : ""}${result.mode === "local" ? " (kept in this browser)" : ""}.`,
        "success"
      );
    } catch (error) {
      this.toast(
        "The recommendations could not be created",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.isSending = false;
    }
  }

  handleOpenRecommendations() {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "recommendations", search: "Adoption" }
      })
    );
  }

  // ---------- Export ----------

  get exportSheets() {
    return {
      contract: {
        name: "Contract",
        rows: this.contractLines,
        columns: [
          { label: "Product", value: (row) => row.product },
          { label: "Type", value: (row) => row.lineType },
          { label: "Cloud", value: (row) => row.cloud },
          { label: "Linked license", value: (row) => row.matchedLabel },
          { label: "Bought", value: (row) => row.quantity },
          { label: "Shown in Salesforce", value: (row) => row.orgTotal },
          { label: "Assigned", value: (row) => row.assigned },
          { label: "Actively used", value: (row) => row.active },
          { label: "Unused", value: (row) => row.unused },
          { label: "Unit price", value: (row) => row.unitPrice },
          { label: "Price period", value: (row) => row.pricePeriod },
          {
            label: `Annual cost (${this.currencyCode})`,
            value: (row) => row.annualCost
          },
          {
            label: `Annual cost unused (${this.currencyCode})`,
            value: (row) => row.annualWaste
          },
          {
            label: "Renewal",
            value: (row) => formatExportDate(row.endDate, false)
          },
          { label: "Verdict", value: (row) => row.verdict },
          { label: "Detail", value: (row) => row.detail }
        ]
      },
      features: {
        name: "Features",
        rows: this.visibleFeatures,
        columns: [
          { label: "Cloud", value: (row) => row.cloud },
          { label: "Feature", value: (row) => row.label },
          { label: "Status", value: (row) => row.status },
          { label: "Measured", value: (row) => row.metric },
          { label: "In scope", value: (row) => (row.inScope ? "Yes" : "No") },
          { label: "What it is", value: (row) => row.description },
          { label: "Why it matters", value: (row) => row.benefit },
          { label: "Next step", value: (row) => row.nextStep },
          { label: "Learn more", value: (row) => row.learnUrl }
        ]
      },
      licenses: {
        name: "User licenses",
        rows: this.userLicenses,
        columns: [
          { label: "License", value: (row) => row.name },
          { label: "Status", value: (row) => row.status },
          { label: "Purchased", value: (row) => row.total },
          { label: "Assigned", value: (row) => row.used },
          { label: "Unassigned", value: (row) => row.unused },
          {
            label: "Inactive users",
            value: (row) => (row.included ? "" : row.inactive)
          },
          { label: "Frozen users", value: (row) => row.frozen },
          { label: "Utilization (%)", value: (row) => row.utilization },
          { label: "Verdict", value: (row) => row.verdict }
        ]
      },
      featureLicenses: {
        name: "Feature licenses",
        rows: this.featureLicenses,
        columns: [
          { label: "Feature license", value: (row) => row.name },
          { label: "Assigned", value: (row) => row.assigned },
          { label: "Inactive users", value: (row) => row.inactive }
        ]
      },
      addOns: {
        name: "Add-ons",
        rows: this.addOns,
        columns: [
          { label: "Type", value: (row) => row.kind },
          { label: "Name", value: (row) => row.name },
          { label: "Status", value: (row) => row.status },
          { label: "Allowed", value: (row) => row.total },
          { label: "Used", value: (row) => row.used },
          { label: "Utilization (%)", value: (row) => row.utilization },
          { label: "Unit", value: (row) => row.unit },
          {
            label: "Expiration",
            value: (row) => formatExportDate(row.expirationDate, false)
          },
          { label: "Verdict", value: (row) => row.verdict }
        ]
      }
    };
  }

  handleExport(event) {
    const sheets = this.exportSheets;
    exportRows({
      name: "salesforce-adoption",
      format: event.detail.format,
      sheets: [
        sheets.features,
        sheets.licenses,
        sheets.featureLicenses,
        sheets.addOns,
        sheets.contract
      ]
    });
  }

  handleExportSheet(event) {
    const sheet = this.exportSheets[event.currentTarget.dataset.sheet];
    exportRows({
      name: `adoption-${sheet.name}`,
      format: event.detail.format,
      sheets: [sheet]
    });
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
