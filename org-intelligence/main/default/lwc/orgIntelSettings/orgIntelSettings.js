import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import getSettings from "@salesforce/apex/OrgAdminController.getSettings";
import updateRule from "@salesforce/apex/OrgAdminController.updateRule";
import updateRetention from "@salesforce/apex/OrgAdminController.updateRetention";
import updateScoreSettings from "@salesforce/apex/OrgAdminController.updateScoreSettings";
import runMaintenance from "@salesforce/apex/OrgAdminController.runMaintenance";
import {
  INSTALL_GUIDE_URL,
  OPTIONAL_MODULES,
  SEVERITIES,
  componentTypeLabel,
  exportRows,
  formatNumber,
  todayIso,
  reduceErrors,
  scoreBand,
  severityMeta
} from "c/orgIntelUtils";
import {
  TOOLS,
  loadTools,
  moduleAction,
  visualforceUrl
} from "c/orgIntelModuleApi";

// Désinstallation complète : outil présent seulement après une installation depuis les sources
// (source-tools/, OrgIntelUninstallTool). Une installation par packages se désinstalle dans Setup.
const getUninstallStatus = moduleAction(TOOLS.UNINSTALL, "getStatus");
const prepareUninstall = moduleAction(TOOLS.UNINSTALL, "prepare");
const uninstallOrgIntelligence = moduleAction(TOOLS.UNINSTALL, "uninstall");
const getUninstallProgress = moduleAction(TOOLS.UNINSTALL, "getDeployStatus");
import {
  STORE_KEYS,
  clearAll,
  downloadJson,
  listKeys,
  loadValue,
  removeValue,
  saveValue,
  storageBackend,
  storageEstimate,
  storageProtection,
  storageStatus,
  storageUsage
} from "c/orgIntelStore";
import { scoreBreakdown, scoreFromBreakdown } from "c/orgIntelScanData";
import { importLocalRecommendations } from "c/orgIntelRecommendationStore";

/** Type des fichiers « toutes les données du navigateur » (export / import). */
const BROWSER_DATA_KIND = "browserData";
/** Anciennes clés localStorage d'Inventory, écrites hors orgIntelStore. */
const LEGACY_INVENTORY_PREFIX = "orgIntelligence.inventory.v1.";
/** Âge maximal d'une analyse Objects & Fields interrompue avant nettoyage. */
const PENDING_MAX_AGE_MS = 7 * 86400000;

const timeOf = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(time) ? 0 : time;
};

function backendName(backend) {
  return backend === "indexedDB" ? "IndexedDB" : "Local storage (about 5 MB)";
}

/** Date d'une analyse interrompue (champ selon la version du format). */
function pendingTime(pending) {
  if (!pending || typeof pending !== "object") {
    return 0;
  }
  return (
    timeOf(pending.savedAt) ||
    timeOf(pending.updatedAt) ||
    timeOf(pending.startedAt) ||
    timeOf(pending.run && pending.run.startedAt)
  );
}

/** Date d'un résultat gardé (scan, audit, analyse), 0 si inconnue. */
function resultTime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  return (
    timeOf(value.completedAt) ||
    timeOf(value.generatedAt) ||
    timeOf(value.savedAt) ||
    timeOf(value.startedAt) ||
    timeOf(value.exportedAt)
  );
}

/** Clé d'identité d'une entrée d'historique (id, sinon date). */
function historyId(entry) {
  if (!entry || typeof entry !== "object") {
    return JSON.stringify(entry);
  }
  return String(
    entry.id ||
      entry.completedAt ||
      entry.generatedAt ||
      entry.exportedAt ||
      entry.startedAt ||
      JSON.stringify(entry)
  );
}

function mergeLists(current, incoming) {
  const byId = new Map();
  [...current, ...incoming].forEach((entry) =>
    byId.set(historyId(entry), entry)
  );
  return [...byId.values()].sort((a, b) => resultTime(b) - resultTime(a));
}

/**
 * Règle commune d'import : listes (historiques) réunies et dédoublonnées, le plus récent d'abord ;
 * objets datés : le plus récent gagne ; objet `{ analyses: [...] }` (Objects & Fields) : analyses
 * réunies ; sinon la valeur du navigateur est gardée. Renvoie `current` si rien ne change.
 */
function mergeStored(current, incoming) {
  if (Array.isArray(current) && Array.isArray(incoming)) {
    if (![...current, ...incoming].every(isPlainObject)) {
      // Préférence (ex. périmètre de scan) : celle du navigateur est gardée
      return current;
    }
    return mergeLists(current, incoming).slice(
      0,
      Math.max(current.length, incoming.length, 24)
    );
  }
  if (
    current &&
    incoming &&
    Array.isArray(current.analyses) &&
    Array.isArray(incoming.analyses)
  ) {
    return {
      ...current,
      analyses: mergeLists(current.analyses, incoming.analyses).slice(0, 3)
    };
  }
  const incomingTime = resultTime(incoming);
  if (incomingTime || resultTime(current)) {
    return incomingTime > resultTime(current) ? incoming : current;
  }
  if (isPlainObject(current) && isPlainObject(incoming)) {
    // Index par clé (ex. index des analyses Objects & Fields) : entrée par entrée, la plus récente
    let changed = false;
    const next = { ...current };
    Object.entries(incoming).forEach(([key, value]) => {
      if (!(key in next) || resultTime(value) > resultTime(next[key])) {
        next[key] = value;
        changed = true;
      }
    });
    return changed ? next : current;
  }
  return current;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Actions Apex du module (via le contrôleur générique du socle)
const getJiraSettings = moduleAction("recommendations", "getJiraSettings");
const saveJiraSettings = moduleAction("recommendations", "saveJiraSettings");
const testJiraConnection = moduleAction(
  "recommendations",
  "testJiraConnection"
);
const getFieldUsageObjects = moduleAction("fieldUsage", "getObjects");

/** Assistant de connexion Tooling (page Visualforce, nom qualifié par visualforceUrl). */
export const TOOLING_SETUP_PAGE = "OrgIntelligenceToolingSetup";

const PRESET_NAMES = ["Strict", "Balanced", "Lenient", "Custom"];

/** Sections repliables : ouvertes par défaut, sauf Jira et Accès (consultés rarement). */
const SECTION_DEFAULTS = {
  tooling: true,
  modules: true,
  jira: false,
  score: true,
  rules: true,
  retention: true,
  data: true,
  access: false
};

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
 * Section « Settings » (administrateurs) : connexion Tooling API, catalogue des règles, score,
 * journal API (si le module est installé), données (volumes des modules à objets et données gardées
 * dans le navigateur), accès. Les paramètres sont des métadonnées personnalisées, enregistrées par
 * un déploiement asynchrone de quelques secondes. Aperçu du score calculé dans le navigateur sur le
 * dernier scan gardé.
 */

export default class OrgIntelSettings extends LightningElement {
  /** Modules installés et accessibles (clés), transmis par la coquille. */
  @api modules = [];
  installGuideUrl = INSTALL_GUIDE_URL;
  installedPackagesUrl = "/lightning/setup/ImportedPackage/home";
  deploymentStatusUrl = "/lightning/setup/DeployStatus/home";
  uninstallStatus;
  uninstallLoading = false;
  uninstallConfirmText = "";
  removeToolingConnection = true;
  uninstallResult;
  uninstallProgress;
  uninstallLostAccess = false;
  uninstallTimer;
  /** Outil de désinstallation complète présent (installation depuis les sources). */
  hasUninstallTool = false;
  settings;
  error;
  isLoading = true;
  ruleDrafts = {};
  savingRule = null;
  retentionDraft;
  isSavingRetention = false;
  isRunningMaintenance = false;
  scoreDraft;
  isSavingScore = false;
  maintenanceResult;
  ruleFilter = "";
  jiraStatus;
  jiraDraft = {};
  isSavingJira = false;
  isTestingJira = false;
  openSections = { ...SECTION_DEFAULTS };
  /** Dernier scan gardé dans le navigateur (aperçu du score). */
  latestScan;
  scoreRules;
  browserUsage = [];
  browserBackend;
  /** Anciennes clés localStorage (Inventory avant orgIntelStore) et estimation du navigateur. */
  legacyKeys = [];
  storageEstimate;
  storageStatusInfo;
  /** Protection des données sensibles : { mode, message } (chiffrées ou session seulement). */
  storageProtectionInfo;
  isBrowserBusy = false;

  severityOptions = SEVERITIES.map((s) => ({ label: s.label, value: s.value }));

  connectedCallback() {
    this.load();
    loadTools().then((tools) => {
      this.hasUninstallTool = tools.includes(TOOLS.UNINSTALL);
    });
  }

  async load() {
    this.isLoading = !this.settings;
    try {
      this.settings = await getSettings();
      this.loadBrowserState();
      this.retentionDraft = { ...this.settings.retention };
      this.scoreDraft = JSON.parse(JSON.stringify(this.settings.score));
      this.ruleDrafts = {};
      this.error = undefined;
      if (this.hasRecommendations) {
        this.loadJira();
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  handleRefresh() {
    this.load();
  }

  /** Dernier scan (aperçu du score) et occupation du stockage du navigateur. */
  async loadBrowserState() {
    try {
      const [scan, usage, backend] = await Promise.all([
        loadValue(STORE_KEYS.LATEST_SCAN, null),
        storageUsage(),
        storageBackend()
      ]);
      this.latestScan = scan;
      this.scoreRules = scan
        ? scoreBreakdown(scan.findings, scan.ignoredFingerprints)
        : null;
      this.browserUsage = usage;
      this.browserBackend = backend;
    } catch {
      this.browserUsage = [];
    }
    this.legacyKeys = this.readLegacyKeys();
    try {
      const [estimate, status, protection] = await Promise.all([
        storageEstimate(),
        storageStatus(),
        storageProtection()
      ]);
      this.storageEstimate = estimate;
      this.storageStatusInfo = status;
      this.storageProtectionInfo = protection;
    } catch {
      this.storageEstimate = null;
      this.storageStatusInfo = null;
      this.storageProtectionInfo = null;
    }
  }

  disconnectedCallback() {
    clearTimeout(this.uninstallTimer);
  }

  // ---------- Navigation et sections repliables ----------

  /** État d'affichage par section : ouverte, icône du chevron, aria-expanded. */
  get section() {
    const state = {};
    for (const key of Object.keys(SECTION_DEFAULTS)) {
      const open = !!this.openSections[key];
      state[key] = {
        open,
        expanded: open ? "true" : "false",
        icon: open ? "utility:chevrondown" : "utility:chevronright"
      };
    }
    return state;
  }

  get navItems() {
    const rules = this.settings?.rules || [];
    const items = [
      { key: "tooling", label: "Tooling API", tone: this.toolingTone },
      { key: "modules", label: "Modules" }
    ];
    if (this.hasRecommendations) {
      items.push({ key: "jira", label: "Jira", tone: this.jiraTone });
    }
    items.push(
      { key: "score", label: "Health score" },
      {
        key: "rules",
        label: "Rules",
        count: rules.length ? `${this.enabledRuleCount}/${rules.length}` : ""
      },
      ...(this.hasApiMonitoring
        ? [{ key: "retention", label: "API log" }]
        : []),
      { key: "data", label: "Data" },
      {
        key: "access",
        label: "Access",
        count: String((this.settings?.access || []).length)
      },
      { key: "uninstall", label: "Uninstall", danger: true }
    );
    return items.map((item) => ({
      ...item,
      className: `nav-chip${item.danger ? " nav-chip-danger" : ""}`,
      dotClass: item.tone ? `nav-dot dot-${item.tone}` : ""
    }));
  }

  get allSectionsOpen() {
    return Object.keys(SECTION_DEFAULTS).every((key) => this.openSections[key]);
  }

  get toggleAllIcon() {
    return this.allSectionsOpen ? "utility:collapse_all" : "utility:expand_all";
  }

  get toggleAllLabel() {
    return this.allSectionsOpen
      ? "Collapse all sections"
      : "Expand all sections";
  }

  handleToggleAll() {
    const open = !this.allSectionsOpen;
    const next = {};
    for (const key of Object.keys(SECTION_DEFAULTS)) {
      next[key] = open;
    }
    this.openSections = next;
  }

  handleToggleSection(event) {
    const key = event.currentTarget.dataset.section;
    this.openSections = {
      ...this.openSections,
      [key]: !this.openSections[key]
    };
  }

  /**
   * Ouvre la section demandée puis la fait défiler à l'écran. La carte existe toujours (seul son
   * contenu est replié) : le haut de la carte ne bouge pas, on peut défiler tout de suite.
   */
  handleNavClick(event) {
    const key = event.currentTarget.dataset.section;
    if (key in SECTION_DEFAULTS && !this.openSections[key]) {
      this.openSections = { ...this.openSections, [key]: true };
    }
    const target = this.template.querySelector(`[data-section-id="${key}"]`);
    if (target?.scrollIntoView) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---------- Désinstallation ----------

  get showUninstallStart() {
    return (
      this.hasUninstallTool && !this.uninstallStatus && !this.uninstallLoading
    );
  }

  get uninstallIsPackage() {
    return this.uninstallStatus?.mode === "package";
  }

  get uninstallPackagesText() {
    return (this.uninstallStatus?.packages || []).join(", ");
  }

  get uninstallNotStarted() {
    return !this.uninstallResult;
  }

  get uninstallConfirmLabel() {
    return `Type ${this.uninstallStatus?.confirmation || "DELETE"} to confirm`;
  }

  get uninstallDisabled() {
    return (
      this.uninstallLoading ||
      this.uninstallConfirmText !== this.uninstallStatus?.confirmation
    );
  }

  get uninstallProblems() {
    return this.uninstallProgress?.problems || [];
  }

  get uninstallProgressText() {
    const progress = this.uninstallProgress;
    if (this.uninstallLostAccess) {
      return "Uninstall in progress: your access to Org Intelligence has been removed, the app will disappear in a moment.";
    }
    if (!progress) {
      return "Uninstall submitted, waiting for Salesforce to start the deletion...";
    }
    if (progress.done && progress.status === "Succeeded") {
      return "Org Intelligence has been removed from this org.";
    }
    if (progress.done) {
      return `The uninstall failed (${progress.status})${progress.errorMessage ? `: ${progress.errorMessage}` : ""}. Nothing was deleted.`;
    }
    const total = progress.componentsTotal || 0;
    return `Uninstall ${progress.status === "InProgress" ? "in progress" : (progress.status || "").toLowerCase()}: ${progress.componentsDeployed || 0} of ${total} components deleted...`;
  }

  async handleUninstallCheck() {
    this.uninstallLoading = true;
    try {
      this.uninstallStatus = await getUninstallStatus();
    } catch (error) {
      this.toast(
        "The uninstall options could not be loaded",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.uninstallLoading = false;
    }
  }

  handleUninstallCancel() {
    this.uninstallStatus = undefined;
    this.uninstallConfirmText = "";
  }

  handleRemoveToolingChange(event) {
    this.removeToolingConnection = event.target.checked;
  }

  handleUninstallConfirmChange(event) {
    this.uninstallConfirmText = (event.target.value || "").trim();
  }

  async handleUninstall() {
    this.uninstallLoading = true;
    try {
      // 1. Rapports et tableau de bord (API Analytics + corbeille), 2. déploiement destructif
      await prepareUninstall({ confirmation: this.uninstallConfirmText });
      this.uninstallResult = await uninstallOrgIntelligence({
        confirmation: this.uninstallConfirmText,
        removeToolingConnection: this.removeToolingConnection
      });
      this.pollUninstall();
    } catch (error) {
      this.toast("The uninstall could not start", reduceErrors(error), "error");
    } finally {
      this.uninstallLoading = false;
    }
  }

  /** Suit le déploiement destructif tant que l'utilisateur a encore accès aux classes Apex. */
  pollUninstall() {
    clearTimeout(this.uninstallTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.uninstallTimer = setTimeout(async () => {
      try {
        this.uninstallProgress = await getUninstallProgress({
          deployId: this.uninstallResult.deployId
        });
        if (!this.uninstallProgress.done) {
          this.pollUninstall();
        }
      } catch {
        // Permission sets retirés ou classes déjà supprimées : la désinstallation suit son cours
        this.uninstallLostAccess = true;
      }
    }, 5000);
  }

  // ---------- Modules ----------

  handleManageModules() {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: { section: "modules" } })
    );
  }

  hasModule(key) {
    return (this.modules || []).includes(key);
  }

  get hasRecommendations() {
    return this.hasModule("recommendations");
  }

  get hasContextHub() {
    return this.hasModule("contextHub");
  }

  get hasApiMonitoring() {
    return this.hasModule("apiMonitoring");
  }

  get moduleRows() {
    return OPTIONAL_MODULES.map((module) => {
      const installed = this.hasModule(module.key);
      return {
        ...module,
        installed,
        statusLabel: installed ? "Installed" : "Not installed",
        statusTone: installed ? "good" : "neutral",
        requiresText: module.requires ? `Requires ${module.requires}.` : "",
        helpText: `${module.description}${module.requires ? ` Requires ${module.requires}.` : ""}`
      };
    });
  }

  // ---------- Jira ----------

  async loadJira() {
    try {
      this.applyJiraStatus(await getJiraSettings());
    } catch (error) {
      this.jiraStatus = { configured: false, message: reduceErrors(error) };
    }
  }

  applyJiraStatus(status) {
    this.jiraStatus = status;
    const placeholder = status.siteUrl === "https://your-site.atlassian.net";
    this.jiraDraft = {
      siteUrl: placeholder ? "" : status.siteUrl || "",
      projectKey: status.projectKey || "",
      issueType: status.issueType || "Task",
      email: "",
      apiToken: ""
    };
  }

  get jiraLabel() {
    if (this.jiraStatus?.connected === true) {
      return "Connected";
    }
    if (this.jiraStatus?.connected === false) {
      return "Error";
    }
    return this.jiraStatus?.configured ? "Configured" : "Not configured";
  }

  get jiraTone() {
    if (this.jiraStatus?.connected === true) {
      return "good";
    }
    if (this.jiraStatus?.connected === false) {
      return "critical";
    }
    return this.jiraStatus?.configured ? "info" : "neutral";
  }

  get jiraEmailPlaceholder() {
    return this.jiraStatus?.configured
      ? "Unchanged — enter to replace"
      : "you@company.com";
  }

  get jiraTokenPlaceholder() {
    return this.jiraStatus?.configured
      ? "Unchanged — enter to replace"
      : "Atlassian API token";
  }

  get jiraSaveLabel() {
    return this.isSavingJira ? "Saving…" : "Save";
  }

  get jiraTestLabel() {
    return this.isTestingJira ? "Testing…" : "Test the connection";
  }

  get jiraTestDisabled() {
    return this.isTestingJira || !this.jiraStatus?.configured;
  }

  handleJiraField(event) {
    this.jiraDraft = {
      ...this.jiraDraft,
      [event.target.dataset.field]: event.target.value
    };
  }

  async handleSaveJira() {
    this.isSavingJira = true;
    try {
      await saveJiraSettings({ ...this.jiraDraft });
      this.toast(
        "Jira settings saved",
        "You can test the connection now.",
        "success"
      );
      // Enregistrement immédiat (custom setting) : relecture directe
      await this.loadJira();
    } catch (error) {
      this.toast("Not saved", reduceErrors(error), "error");
    } finally {
      this.isSavingJira = false;
    }
  }

  async handleTestJira() {
    this.isTestingJira = true;
    try {
      this.jiraStatus = await testJiraConnection();
    } catch (error) {
      this.jiraStatus = {
        ...this.jiraStatus,
        connected: false,
        message: reduceErrors(error)
      };
    } finally {
      this.isTestingJira = false;
    }
  }

  // ---------- Tooling ----------

  get toolingNotConfigured() {
    return !!this.tooling && !this.tooling.configured;
  }

  get toolingNeedsAccess() {
    return !!this.tooling?.configured && !this.tooling.connected;
  }

  /**
   * Ouvre une URL calculée de façon asynchrone dans un nouvel onglet : l'onglet est ouvert pendant
   * le geste de l'utilisateur (sinon bloqué comme fenêtre surgissante), puis dirigé.
   */
  async openInNewTab(resolveUrl) {
    const tab = window.open("", "_blank");
    const url = await resolveUrl();
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  /** URL de l'assistant : fournie par Apex (Page.getUrl, namespace compris), sinon calculée. */
  toolingSetupUrl() {
    return this.tooling?.setupUrl
      ? Promise.resolve(this.tooling.setupUrl)
      : visualforceUrl(TOOLING_SETUP_PAGE);
  }

  /** Assistant de connexion (page Visualforce : sa session peut appeler l'API Metadata). */
  handleToolingSetup() {
    this.openInNewTab(() => this.toolingSetupUrl());
  }

  /** « Connect » : autorisation OAuth de l'utilisateur courant, sinon l'assistant. */
  handleAllowAccess() {
    this.openInNewTab(
      async () => this.tooling?.authorizationUrl || this.toolingSetupUrl()
    );
  }

  get tooling() {
    return this.settings?.tooling;
  }

  get toolingTone() {
    if (this.tooling?.connected) {
      return "good";
    }
    return this.tooling?.configured ? "warning" : "critical";
  }

  get toolingLabel() {
    if (this.tooling?.connected) {
      return "Connected";
    }
    return this.tooling?.configured
      ? "Not authorized for you"
      : "Not configured";
  }

  get callbackUrl() {
    return `${this.settings?.orgDomainUrl}/services/authcallback/${this.settings?.retention?.namedCredential}`;
  }

  /** Mise en place manuelle : seulement tant que la connexion n'existe pas. */
  get showGuide() {
    return !!this.tooling && !this.tooling.configured;
  }

  // ---------- Score de santé ----------

  get presetOptions() {
    return PRESET_NAMES.map((name) => ({
      value: name,
      label: name,
      className: `preset${this.scoreDraft?.preset === name ? " preset-selected" : ""}`,
      checked: this.scoreDraft?.preset === name ? "true" : "false"
    }));
  }

  get scoreRows() {
    const draft = this.scoreDraft;
    if (!draft) {
      return [];
    }
    return SEVERITIES.map((severity) => {
      const meta = severityMeta(severity.value);
      return {
        value: severity.value,
        label: meta.label,
        tone: meta.tone,
        points: draft.points[severity.value],
        cap: draft.caps[severity.value]
      };
    });
  }

  get domainOptions() {
    const selected = this.scoreDraft?.domains || [];
    return (this.settings?.scoreDomains || []).map((domain) => ({
      value: domain,
      label: domain,
      checked: selected.includes(domain)
    }));
  }

  handlePreset(event) {
    const name = event.currentTarget.dataset.value;
    const draft = { ...this.scoreDraft, preset: name };
    const preset = this.settings?.scorePresets?.[name];
    if (preset) {
      draft.points = {};
      draft.caps = {};
      for (const severity of Object.keys(preset)) {
        draft.points[severity] = preset[severity][0];
        draft.caps[severity] = preset[severity][1];
      }
    }
    this.scoreDraft = draft;
  }

  handleScoreValue(event) {
    const { severity, kind } = event.target.dataset;
    const value = event.target.value === "" ? 0 : Number(event.target.value);
    const draft = JSON.parse(JSON.stringify(this.scoreDraft));
    draft[kind][severity] = value;
    draft.preset = "Custom";
    this.scoreDraft = draft;
  }

  handleScoreDomain(event) {
    const domain = event.target.dataset.value;
    const domains = new Set(this.scoreDraft.domains);
    if (event.target.checked) {
      domains.add(domain);
    } else {
      domains.delete(domain);
    }
    this.scoreDraft = { ...this.scoreDraft, domains: [...domains] };
  }

  handleExcludeIgnored(event) {
    this.scoreDraft = {
      ...this.scoreDraft,
      excludeIgnored: event.target.checked
    };
  }

  /**
   * Score du dernier scan gardé dans le navigateur avec les réglages saisis (même calcul que le
   * moteur de scan : scoreFromBreakdown).
   */
  get previewScore() {
    const draft = this.scoreDraft;
    if (!draft || !this.scoreRules) {
      return null;
    }
    return scoreFromBreakdown(this.scoreRules, this.numericScoreConfig(draft));
  }

  /** Réglages du score avec des valeurs numériques (saisies vides = 0). */
  numericScoreConfig(draft) {
    const toNumbers = (values) => {
      const result = {};
      Object.keys(values || {}).forEach((severity) => {
        result[severity] = Number(values[severity] ?? 0);
      });
      return result;
    };
    return {
      ...draft,
      points: toNumbers(draft.points),
      caps: toNumbers(draft.caps)
    };
  }

  get hasPreview() {
    return this.previewScore !== null;
  }

  get previewBand() {
    return scoreBand(this.previewScore);
  }

  get previewScanName() {
    return this.latestScan?.name || "the latest scan";
  }

  get currentScoreLabel() {
    const score = this.latestScan?.healthScore;
    return score === null || score === undefined ? "—" : formatNumber(score);
  }

  get scoreDirty() {
    return (
      !!this.scoreDraft &&
      JSON.stringify(this.scoreDraft) !== JSON.stringify(this.settings?.score)
    );
  }

  get scoreSaveDisabled() {
    return (
      !this.scoreDirty ||
      this.isSavingScore ||
      !(this.scoreDraft?.domains || []).length
    );
  }

  handleResetScore() {
    this.scoreDraft = JSON.parse(JSON.stringify(this.settings.score));
  }

  async handleSaveScore() {
    this.isSavingScore = true;
    try {
      await updateScoreSettings({ scoreJson: JSON.stringify(this.scoreDraft) });
      await this.applyScoreToLatestScan();
      this.toast(
        "Score preferences saved",
        "Applied to the next scans; the latest scan stored in this browser is recalculated.",
        "success"
      );
      await this.load();
    } catch (error) {
      this.toast("Not saved", reduceErrors(error), "error");
    } finally {
      this.isSavingScore = false;
    }
  }

  /** Recalcule le score du dernier scan gardé (et de son résumé dans l'historique). */
  async applyScoreToLatestScan() {
    const scan = this.latestScan;
    if (!scan || !this.scoreRules) {
      return;
    }
    const score = scoreFromBreakdown(
      this.scoreRules,
      this.numericScoreConfig(this.scoreDraft)
    );
    try {
      await saveValue(STORE_KEYS.LATEST_SCAN, { ...scan, healthScore: score });
      const history = (await loadValue(STORE_KEYS.SCAN_HISTORY, [])) || [];
      await saveValue(
        STORE_KEYS.SCAN_HISTORY,
        history.map((entry) => {
          return entry.id === scan.id
            ? { ...entry, healthScore: score }
            : entry;
        })
      );
      this.latestScan = { ...scan, healthScore: score };
    } catch (error) {
      this.toast("Score not recalculated", reduceErrors(error), "warning");
    }
  }

  // ---------- Règles ----------

  get rules() {
    const term = this.ruleFilter.trim().toLowerCase();
    return (this.settings?.rules || [])
      .filter(
        (rule) =>
          !term ||
          `${rule.label} ${rule.code} ${rule.domain} ${rule.category}`
            .toLowerCase()
            .includes(term)
      )
      .map((rule) => {
        const draft = this.ruleDrafts[rule.code] || {};
        const enabled = draft.enabled ?? rule.enabled;
        const severity = draft.severity ?? rule.severity;
        const threshold =
          draft.threshold !== undefined ? draft.threshold : rule.threshold;
        const dirty =
          enabled !== rule.enabled ||
          severity !== rule.severity ||
          String(threshold ?? "") !== String(rule.threshold ?? "");
        return {
          ...rule,
          enabled,
          severity,
          threshold,
          dirty,
          hasThreshold: rule.threshold !== null && rule.threshold !== undefined,
          domainLabel: componentTypeLabel(rule.domain),
          saving: this.savingRule === rule.code,
          saveDisabled: !dirty || this.savingRule !== null,
          rowClass: `rule${enabled ? "" : " rule-disabled"}${dirty ? " rule-dirty" : ""}`
        };
      });
  }

  get enabledRuleCount() {
    return (this.settings?.rules || []).filter((rule) => rule.enabled).length;
  }

  get ruleSummary() {
    return `${this.enabledRuleCount} of ${(this.settings?.rules || []).length} rules enabled`;
  }

  handleRuleFilter(event) {
    this.ruleFilter = event.target.value || "";
  }

  draft(code, changes) {
    this.ruleDrafts = {
      ...this.ruleDrafts,
      [code]: { ...(this.ruleDrafts[code] || {}), ...changes }
    };
  }

  handleRuleEnabled(event) {
    this.draft(event.target.dataset.code, { enabled: event.target.checked });
  }

  handleRuleSeverity(event) {
    this.draft(event.target.dataset.code, { severity: event.detail.value });
  }

  handleRuleThreshold(event) {
    const value = event.target.value;
    this.draft(event.target.dataset.code, {
      threshold: value === "" ? null : Number(value)
    });
  }

  async handleSaveRule(event) {
    const code = event.target.dataset.code;
    const rule = this.rules.find((item) => item.code === code);
    this.savingRule = code;
    try {
      await updateRule({
        code,
        enabled: rule.enabled,
        severity: rule.severity,
        threshold: rule.threshold
      });
      this.toast(
        "Rule saved",
        `${rule.label}: applied from the next scan. Existing recommendations keep their severity.`,
        "success"
      );
      await this.load();
    } catch (error) {
      this.toast("Rule not saved", reduceErrors(error), "error");
    } finally {
      this.savingRule = null;
    }
  }

  // ---------- Conservation ----------

  get retentionDirty() {
    const saved = this.settings?.retention;
    const draft = this.retentionDraft;
    return (
      !!saved &&
      !!draft &&
      (saved.apiLogRetentionDays !== draft.apiLogRetentionDays ||
        saved.logApiPayloads !== draft.logApiPayloads)
    );
  }

  get retentionSaveDisabled() {
    return !this.retentionDirty || this.isSavingRetention;
  }

  handleRetentionChange(event) {
    const field = event.target.dataset.field;
    const value =
      event.target.type === "toggle" || event.target.type === "checkbox"
        ? event.target.checked
        : Number(event.target.value);
    this.retentionDraft = { ...this.retentionDraft, [field]: value };
  }

  async handleSaveRetention() {
    this.isSavingRetention = true;
    try {
      const draft = this.retentionDraft;
      await updateRetention({
        apiLogDays: draft.apiLogRetentionDays,
        logPayloads: draft.logApiPayloads
      });
      this.toast("Retention saved", "Applied immediately.", "success");
      await this.load();
    } catch (error) {
      this.toast("Retention not saved", reduceErrors(error), "error");
    } finally {
      this.isSavingRetention = false;
    }
  }

  // ---------- Données : journal API et navigateur ----------

  /** Purge du journal API selon la rétention (module API Monitoring seulement). */
  async handleRunMaintenance() {
    this.isRunningMaintenance = true;
    try {
      const result = await runMaintenance();
      this.maintenanceResult = `${formatNumber(result.apiLogsDeleted)} API log entries older than ${result.apiLogRetentionDays} days deleted.`;
      this.load();
    } catch (error) {
      this.toast("Maintenance failed", reduceErrors(error), "error");
    } finally {
      this.isRunningMaintenance = false;
    }
  }

  get hasVolumes() {
    return (this.settings?.volumes || []).length > 0;
  }

  get browserBackendLabel() {
    const label = backendName(this.browserBackend);
    const status = this.storageStatusInfo;
    return status && status.switched && status.previousBackend
      ? `${label} (switched from ${backendName(status.previousBackend)})`
      : label;
  }

  /** Mention discrète de la protection des données sensibles (Security, Permissions, contrat). */
  get storageProtectionMessage() {
    return this.storageProtectionInfo?.message || "";
  }

  get browserBadgeHelp() {
    return `Scans, audits, analyses and local recommendations are stored in this browser only, per user (support: ${this.browserBackendLabel}). Use the Data menu to save everything to a file, to keep a history or share it with another admin.`;
  }

  /** Taille lisible d'un nombre d'octets. */
  sizeText(size) {
    if (size >= 1048576) {
      return `${formatNumber(Math.round((size / 1048576) * 10) / 10)} MB`;
    }
    return `${formatNumber(Math.max(1, Math.round(size / 1024)))} KB`;
  }

  /** Octets d'une entrée (storageUsage les donne déjà en octets, chaînes UTF-16). */
  entryBytes(row) {
    return row.size || 0;
  }

  get browserRows() {
    return [
      ...(this.browserUsage || []).map((row) => ({
        key: row.key,
        label: row.key,
        value: this.sizeText(this.entryBytes(row))
      })),
      ...(this.legacyKeys || []).map((row) => ({
        key: `legacy:${row.key}`,
        label: `${row.key} (old format)`,
        value: this.sizeText(row.bytes)
      }))
    ];
  }

  get hasBrowserData() {
    return this.browserRows.length > 0;
  }

  get browserTotalText() {
    const total =
      (this.browserUsage || []).reduce(
        (sum, row) => sum + this.entryBytes(row),
        0
      ) + (this.legacyKeys || []).reduce((sum, row) => sum + row.bytes, 0);
    const parts = [
      `${this.sizeText(total)} in ${formatNumber(this.browserRows.length)} entries`
    ];
    const estimate = this.storageEstimate;
    if (estimate && estimate.quota && estimate.usage !== null) {
      parts.push(
        `${this.sizeText(estimate.usage || 0)} of about ${this.sizeText(estimate.quota)} used`
      );
    }
    return parts.join(" · ");
  }

  /** Clés localStorage écrites directement par d'anciennes versions (hors orgIntelStore). */
  readLegacyKeys() {
    const rows = [];
    try {
      const storage = window.localStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(LEGACY_INVENTORY_PREFIX)) {
          rows.push({
            key,
            bytes: (key.length + (storage.getItem(key) || "").length) * 2
          });
        }
      }
    } catch {
      // localStorage indisponible
    }
    return rows;
  }

  /** Enregistre toutes les données Org Intelligence du navigateur dans un fichier JSON. */
  async handleExportBrowserData() {
    this.isBrowserBusy = true;
    try {
      const data = {};
      for (const key of await listKeys("")) {
        // eslint-disable-next-line no-await-in-loop
        data[key] = await loadValue(key);
      }
      downloadJson(
        `org-intelligence-browser-data-${todayIso()}.json`,
        BROWSER_DATA_KIND,
        data
      );
    } catch (error) {
      this.toast("The file could not be saved", reduceErrors(error), "error");
    } finally {
      this.isBrowserBusy = false;
    }
  }

  handleBrowserDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  /**
   * Ouvre un fichier « toutes les données » : même règle que les écrans (le plus récent gagne,
   * historiques réunis) ; les recommandations sont fusionnées par empreinte (importLocalRecommendations).
   */
  async handleImportBrowserData(event) {
    const data = event.detail.data;
    if (!(await confirmOtherOrg(event.detail.envelope))) {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      this.toast(
        "The file could not be opened",
        "This file does not contain Org Intelligence browser data.",
        "error"
      );
      return;
    }
    const confirmed = await LightningConfirm.open({
      label: "Open browser data",
      message: `Merge ${formatNumber(Object.keys(data).length)} entries into the data of this browser? For each result the most recent wins, histories and recommendations are merged.`,
      theme: "warning"
    });
    if (!confirmed) {
      return;
    }
    this.isBrowserBusy = true;
    try {
      let merged = 0;
      for (const [key, value] of Object.entries(data)) {
        // eslint-disable-next-line no-await-in-loop
        if (await this.mergeEntry(key, value)) {
          merged++;
        }
      }
      this.toast(
        "Browser data opened",
        `${formatNumber(merged)} entries merged. Reopen the other sections to see them.`,
        "success"
      );
      await this.loadBrowserState();
    } catch (error) {
      this.toast("The file could not be opened", reduceErrors(error), "error");
    } finally {
      this.isBrowserBusy = false;
    }
  }

  /** Fusionne une entrée du fichier avec celle du navigateur. Renvoie true si quelque chose a changé. */
  async mergeEntry(key, incoming) {
    if (incoming === null || incoming === undefined) {
      return false;
    }
    if (key === STORE_KEYS.RECOMMENDATIONS) {
      // Fusion par empreinte dans la file d'écriture (le plus récent gagne, effacements respectés)
      await importLocalRecommendations(
        Array.isArray(incoming)
          ? incoming
          : { recommendations: Object.values(incoming || {}) }
      );
      return true;
    }
    const current = await loadValue(key, null);
    if (current === null || current === undefined) {
      await saveValue(key, incoming);
      return true;
    }
    const next = mergeStored(current, incoming);
    if (next === current) {
      return false;
    }
    await saveValue(key, next);
    return true;
  }

  async handleClearBrowserData() {
    this.isBrowserBusy = true;
    try {
      const count = await clearAll();
      (this.legacyKeys || []).forEach((row) => {
        try {
          window.localStorage.removeItem(row.key);
        } catch {
          // ignoré
        }
      });
      this.toast(
        "Browser data cleared",
        `${formatNumber(count)} entries deleted.`,
        "success"
      );
      await this.loadBrowserState();
    } catch (error) {
      this.toast("Not cleared", reduceErrors(error), "error");
    } finally {
      this.isBrowserBusy = false;
    }
  }

  /**
   * Nettoyage : analyses Objects & Fields d'objets qui n'existent plus dans l'org, analyses
   * interrompues de plus de 7 jours, anciennes clés localStorage d'Inventory.
   */
  async handleCleanBrowserData() {
    this.isBrowserBusy = true;
    try {
      let removed = 0;
      const objectPrefix = `${STORE_KEYS.FIELD_USAGE}.object.`;
      const pendingPrefix = `${STORE_KEYS.FIELD_USAGE}.pending.`;
      const objectKeys = await listKeys(objectPrefix);
      if (objectKeys.length) {
        let known = null;
        try {
          const objects = await getFieldUsageObjects({});
          const list = Array.isArray(objects) ? objects : objects?.objects;
          if (Array.isArray(list) && list.length) {
            known = new Set(
              list.map((o) => (typeof o === "string" ? o : o.apiName || o.name))
            );
          }
        } catch {
          // module absent ou inaccessible : on ne touche pas aux analyses d'objets
        }
        if (known) {
          for (const key of objectKeys) {
            if (!known.has(key.substring(objectPrefix.length))) {
              // eslint-disable-next-line no-await-in-loop
              await removeValue(key);
              removed++;
            }
          }
          const indexKey = `${STORE_KEYS.FIELD_USAGE}.index`;
          const index = await loadValue(indexKey, null);
          if (isPlainObject(index)) {
            const kept = Object.fromEntries(
              Object.entries(index).filter(([name]) => known.has(name))
            );
            if (Object.keys(kept).length !== Object.keys(index).length) {
              await saveValue(indexKey, kept);
            }
          }
        }
      }
      const limit = Date.now() - PENDING_MAX_AGE_MS;
      for (const key of await listKeys(pendingPrefix)) {
        // eslint-disable-next-line no-await-in-loop
        const pending = await loadValue(key, null);
        const at = pendingTime(pending);
        if (!at || at < limit) {
          // eslint-disable-next-line no-await-in-loop
          await removeValue(key);
          removed++;
        }
      }
      (this.legacyKeys || []).forEach((row) => {
        try {
          window.localStorage.removeItem(row.key);
          removed++;
        } catch {
          // ignoré
        }
      });
      this.toast(
        "Browser data cleaned up",
        removed
          ? `${formatNumber(removed)} outdated entries deleted.`
          : "Nothing outdated to delete.",
        "success"
      );
      await this.loadBrowserState();
    } catch (error) {
      this.toast("Not cleaned up", reduceErrors(error), "error");
    } finally {
      this.isBrowserBusy = false;
    }
  }

  // ---------- Accès et volumes ----------

  get accessRows() {
    return (this.settings?.access || []).map((row, index) => ({
      ...row,
      key: `${row.userId}-${index}`,
      statusLabel: row.isActive ? "Active" : "Inactive"
    }));
  }

  get adminCount() {
    return (this.settings?.access || []).filter((row) =>
      row.permissionSet.endsWith("Admin")
    ).length;
  }

  get userCount() {
    return (this.settings?.access || []).filter(
      (row) => !row.permissionSet.endsWith("Admin")
    ).length;
  }

  get volumes() {
    return (this.settings?.volumes || []).map((row) => ({
      ...row,
      value: formatNumber(row.count)
    }));
  }

  // ---------- Exports ----------

  /** Catalogue filtré, avec les valeurs en cours de saisie non enregistrées. */
  handleExportRules(event) {
    exportRows({
      name: "rule-catalog",
      format: event.detail.format,
      rows: this.rules,
      columns: [
        { label: "Code", value: (rule) => rule.code },
        { label: "Rule", value: (rule) => rule.label },
        { label: "Enabled", value: (rule) => !!rule.enabled },
        { label: "Area", value: (rule) => rule.domainLabel },
        { label: "Category", value: (rule) => rule.category },
        { label: "Severity", value: (rule) => rule.severity },
        { label: "Confidence", value: (rule) => rule.confidence },
        { label: "Threshold", value: (rule) => rule.threshold },
        { label: "Needs Tooling API", value: (rule) => !!rule.needsTooling },
        {
          label: "Open recommendations",
          value: (rule) => rule.openRecommendations
        },
        { label: "Unsaved changes", value: (rule) => !!rule.dirty },
        { label: "Description", value: (rule) => rule.description }
      ]
    });
  }

  handleExportAccess(event) {
    exportRows({
      name: "access",
      format: event.detail.format,
      rows: this.settings?.access || [],
      columns: [
        { label: "User", value: (row) => row.userName },
        { label: "Permission set", value: (row) => row.permissionSet },
        { label: "Active", value: (row) => !!row.isActive },
        { label: "User Id", value: (row) => row.userId }
      ]
    });
  }

  handleExportVolumes(event) {
    exportRows({
      name: "data-volume",
      format: event.detail.format,
      rows: this.settings?.volumes || [],
      columns: [
        { label: "Data", value: (row) => row.label },
        { label: "Records", value: (row) => row.count }
      ]
    });
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
