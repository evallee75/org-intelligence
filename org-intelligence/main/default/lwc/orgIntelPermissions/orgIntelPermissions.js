import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import {
  exportRows,
  formatDate,
  formatDateTime,
  formatExportDate,
  formatNumber,
  formatRelative,
  reduceErrors
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import {
  clearAll,
  downloadJson,
  loadValue,
  saveValue,
  storageProtection
} from "c/orgIntelStore";

const BADGE_HELP =
  "The analysis is not saved in Salesforce: it stays in this browser. Use the Data menu to save it to a file and share it with another administrator.";
import { sendRecommendations } from "c/orgIntelRecommendationStore";
import {
  KIND_GROUP,
  KIND_LABELS,
  KIND_MUTING,
  KIND_PERMISSION_SET,
  KIND_PROFILE,
  OBJECT_FLAGS,
  SEVERITY_TONES,
  THRESHOLDS,
  computeFindings,
  containerIndex,
  groupIndex,
  isPackaged,
  objectFlags,
  objectMap,
  objectNames,
  permissionIndex,
  powerfulPermissions,
  recommendationSpec,
  strategyMetrics
} from "c/orgIntelPermissionsModel";

const loadOverview = moduleAction("security", "permissionOverview");
const loadUsers = moduleAction("security", "permissionUsers");
const loadObjectAccess = moduleAction("security", "permissionObjectAccess");
const loadFieldAccess = moduleAction("security", "permissionFieldAccess");
const comparePermissions = moduleAction("security", "comparePermissions");

/** Clés du stockage navigateur (orgIntelStore). */
const STORE_PREFIX = "security.permissions.";
const STORE_LATEST = `${STORE_PREFIX}latest`;
const STORE_FIELDS = `${STORE_PREFIX}fields.`;
const FILE_KIND = "security-permissions";
const DATA_VERSION = 1;

/** Conteneurs envoyés par appel de lecture des droits objet. */
const OBJECT_ACCESS_BATCH = 100;
/** Colonnes affichées au plus dans la matrice des champs (l'export contient tout). */
const FIELD_COLUMNS_MAX = 30;
/** Lignes affichées au plus par liste (l'export contient tout). */
const ROWS_MAX = 300;

const TABS = [
  { value: "findings", label: "Findings" },
  { value: "profiles", label: "Profiles" },
  { value: "permissionSets", label: "Permission sets" },
  { value: "objects", label: "Object access" },
  { value: "fields", label: "Field access" },
  { value: "compare", label: "Compare" },
  { value: "users", label: "Users" }
];

const KIND_FILTERS = [
  { value: "all", label: "All" },
  { value: KIND_PROFILE, label: "Profiles" },
  { value: KIND_PERMISSION_SET, label: "Permission sets" },
  { value: KIND_GROUP, label: "Groups" }
];

const COMPARE_AREAS = ["System", "Object", "Field"];

const FLS_LABELS = { RE: "Edit", R: "Read", E: "Edit", "": "" };

function plural(n, word) {
  return `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;
}

function matches(term, ...values) {
  if (!term) {
    return true;
  }
  return values.join(" ").toLowerCase().includes(term);
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
 * Section « Profiles & Permission Sets » (module Security) : profils, permission sets et groupes,
 * matrice des droits objet, FLS d'un objet, comparaison de deux conteneurs, assignations par
 * utilisateur et constats (stratégie « profil minimal + permission sets »).
 *
 * Édition sans objet : Apex en lecture seule, appelé en plusieurs actions (vue d'ensemble,
 * utilisateurs, droits objet par lots) ; le navigateur garde le résultat (clés security.permissions.*),
 * calcule constats et matrices (orgIntelPermissionsModel) et envoie les recommandations.
 */
export default class OrgIntelPermissions extends LightningElement {
  @api modules = [];

  analysis;
  fieldAccess;
  comparison;
  error;
  isLoading = true;
  isRunning = false;
  isSending = false;
  isLoadingFields = false;
  isComparing = false;
  isImported = false;
  progress = "";

  activeTab = "findings";
  search = "";
  severityFilter = "all";
  profileFilter = "all";
  setFilter = "all";
  kindFilter = "all";
  onlyWithAccess = true;
  onlyInUse = true;
  selectedObject = "";
  fieldObject = "";
  fieldSearch = "";
  compareLeft = "";
  compareRight = "";
  compareArea = "all";
  usersView = "top";
  openIds = [];
  selectedIds = [];

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
    if (this.hasAnalysis) {
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

  get badgeHelp() {
    return [BADGE_HELP, this.protectionMessage].filter(Boolean).join(" ");
  }

  async load() {
    this.isLoading = !this.analysis;
    try {
      const stored = await loadValue(STORE_LATEST, null);
      this.analysis = stored && stored.overview ? stored : null;
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

  // ---------- Analyse ----------

  async handleRun() {
    this.isRunning = true;
    try {
      this.progress = "Reading profiles and permission sets…";
      const overview = await loadOverview({});
      this.progress = "Reading user assignments…";
      const users = await loadUsers({});
      const objectAccess = {};
      let pending = (overview.containers || []).map((c) => c.id);
      const total = pending.length;
      while (pending.length) {
        this.progress = `Reading object access: ${total - pending.length} / ${total}`;
        const batch = pending.slice(0, OBJECT_ACCESS_BATCH);
        // eslint-disable-next-line no-await-in-loop
        const result = await loadObjectAccess({ containerIds: batch });
        Object.assign(objectAccess, result.entries || {});
        const retry = result.pending || [];
        if (retry.length >= batch.length) {
          throw new Error("The object access could not be read in batches.");
        }
        pending = [...retry, ...pending.slice(OBJECT_ACCESS_BATCH)];
      }
      const analysis = {
        version: DATA_VERSION,
        overview,
        users,
        objectAccess,
        objectAccessComplete: true
      };
      this.applyAnalysis(analysis, false);
      await this.store(analysis);
      this.toast(
        "Analysis completed",
        `${plural(this.profiles.length, "profile")}, ${plural(this.permissionSets.length, "permission set")}, ${plural(this.findings.length, "finding")}.`,
        "success"
      );
    } catch (error) {
      this.toast(
        "The profiles and permission sets could not be analyzed",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.isRunning = false;
      this.progress = "";
    }
  }

  applyAnalysis(analysis, imported) {
    this.analysis = analysis;
    this.isImported = imported;
    this.error = undefined;
    this.openIds = [];
    this.selectedIds = [];
    this.comparison = undefined;
    this.fieldAccess = undefined;
    const names = objectNames(analysis.objectAccess);
    if (!names.includes(this.selectedObject)) {
      this.selectedObject = names.includes("Account") ? "Account" : names[0];
    }
  }

  async store(analysis) {
    try {
      await saveValue(STORE_LATEST, analysis);
    } catch (error) {
      this.toast(
        "The analysis could not be kept in this browser",
        reduceErrors(error),
        "warning"
      );
    }
  }

  // ---------- Menu Data ----------

  handleSaveData() {
    const fields = {};
    if (this.fieldAccess) {
      fields[this.fieldAccess.objectName] = this.fieldAccess;
    }
    const stamp = (
      this.analysis?.overview?.generatedAt || new Date().toISOString()
    ).slice(0, 10);
    downloadJson(`permissions-${stamp}.json`, FILE_KIND, {
      analysis: this.analysis,
      fields
    });
  }

  async handleDataOpen(event) {
    if (!(await confirmOtherOrg(event.detail.envelope))) {
      return;
    }
    try {
      const data = event.detail.data || {};
      const analysis = data.analysis;
      if (!analysis || !analysis.overview) {
        throw new Error("This file does not contain a permissions analysis.");
      }
      this.applyAnalysis(analysis, true);
      await this.store(analysis);
      const fields = data.fields || {};
      for (const name of Object.keys(fields)) {
        // eslint-disable-next-line no-await-in-loop
        await saveValue(`${STORE_FIELDS}${name}`, fields[name]);
      }
      this.toast(
        "Analysis opened",
        `Analysis of ${formatDateTime(analysis.overview.generatedAt)}.`,
        "success"
      );
    } catch (error) {
      this.toast("The file could not be opened", reduceErrors(error), "error");
    }
  }

  handleDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  async handleClearData() {
    try {
      await clearAll(STORE_PREFIX);
      this.analysis = null;
      this.fieldAccess = undefined;
      this.comparison = undefined;
      this.isImported = false;
      this.selectedIds = [];
      this.toast(
        "Stored analysis cleared",
        "Nothing is kept in this browser anymore.",
        "success"
      );
    } catch (error) {
      this.toast(
        "The analysis could not be cleared",
        reduceErrors(error),
        "error"
      );
    }
  }

  // ---------- Données ----------

  get hasAnalysis() {
    return Boolean(this.analysis);
  }

  get noAnalysis() {
    return !this.hasAnalysis;
  }

  get runLabel() {
    return this.hasAnalysis ? "Run again" : "Run analysis";
  }

  get overview() {
    return this.analysis?.overview || {};
  }

  get subtitle() {
    if (!this.hasAnalysis) {
      return "Profiles, permission sets and groups: who has what, overlaps and cleanup.";
    }
    return [
      this.isImported
        ? `Analysis of ${formatDateTime(this.overview.generatedAt)} (from a file)`
        : `Analyzed ${formatRelative(this.overview.generatedAt)}`,
      this.overview.runBy ? `by ${this.overview.runBy}` : null,
      this.overview.isSandbox ? "sandbox" : null
    ]
      .filter(Boolean)
      .join(" · ");
  }

  get isTruncated() {
    return Boolean(this.overview.truncated || this.analysis?.users?.truncated);
  }

  get permissions() {
    return permissionIndex(this.overview);
  }

  get containersById() {
    return containerIndex(this.overview);
  }

  get groupsById() {
    return groupIndex(this.overview);
  }

  get findings() {
    return computeFindings(this.analysis);
  }

  /** Constats par conteneur (affichés dans le détail d'un profil ou d'un permission set). */
  get findingsByContainer() {
    const map = {};
    this.findings.forEach((f) => {
      f.containerIds.forEach((id) => {
        (map[id] = map[id] || []).push(f);
      });
    });
    return map;
  }

  get strategy() {
    return strategyMetrics(this.analysis);
  }

  // ---------- Indicateurs ----------

  get kpis() {
    const profiles = this.profiles;
    const custom = profiles.filter((p) => p.isCustom).length;
    const groups = this.permissionSets.filter((c) => c.kind === KIND_GROUP);
    const strategy = this.strategy;
    const high = this.findings.filter(
      (f) => f.severity === "Critical" || f.severity === "High"
    ).length;
    return [
      {
        key: "profiles",
        label: "Profiles",
        value: formatNumber(profiles.length),
        caption: `${custom} custom`
      },
      {
        key: "permissionSets",
        label: "Permission sets",
        value: formatNumber(
          this.permissionSets.filter((c) => c.kind === KIND_PERMISSION_SET)
            .length
        ),
        caption: `${groups.length} group(s)`
      },
      {
        key: "findings",
        label: "Findings",
        value: formatNumber(this.findings.length),
        caption: `${high} high`
      },
      {
        key: "users",
        label: "Profile-only users",
        value:
          strategy.profileOnlyShare === null
            ? "—"
            : `${Math.round(strategy.profileOnlyShare * 100)}%`,
        caption:
          strategy.profileShare === null
            ? "No assignment data"
            : `${Math.round(strategy.profileShare * 100)}% of object access from profiles`,
        help: "Internal users with no permission set: their access comes from the profile only. Salesforce recommends a minimal profile and access given by permission sets."
      }
    ].map((kpi) => ({
      ...kpi,
      className: `pm-kpi pm-kpi-link${this.activeTab === kpi.key ? " pm-kpi-active" : ""}`
    }));
  }

  handleKpi(event) {
    this.setTab(event.currentTarget.dataset.key);
  }

  // ---------- Onglets ----------

  get tabs() {
    const counts = {
      findings: this.findings.length,
      profiles: this.profiles.length,
      permissionSets: this.permissionSets.length
    };
    return TABS.map((tab) => ({
      ...tab,
      count: counts[tab.value],
      hasCount: counts[tab.value] !== undefined,
      className: `pm-tab${this.activeTab === tab.value ? " pm-tab-active" : ""}`,
      selected: this.activeTab === tab.value
    }));
  }

  handleTab(event) {
    this.setTab(event.currentTarget.dataset.value);
  }

  setTab(value) {
    this.activeTab = value;
    this.search = "";
    this.openIds = [];
    if (value === "fields" && !this.fieldObject) {
      this.fieldObject = this.selectedObject;
      this.restoreFieldAccess();
    }
  }

  get isFindings() {
    return this.activeTab === "findings";
  }
  get isProfiles() {
    return this.activeTab === "profiles";
  }
  get isPermissionSets() {
    return this.activeTab === "permissionSets";
  }
  get isObjects() {
    return this.activeTab === "objects";
  }
  get isFields() {
    return this.activeTab === "fields";
  }
  get isCompare() {
    return this.activeTab === "compare";
  }
  get isUsers() {
    return this.activeTab === "users";
  }

  handleSearch(event) {
    this.search = event.target.value || "";
  }

  get term() {
    return this.search.trim().toLowerCase();
  }

  handleToggle(event) {
    const id = event.currentTarget.dataset.id;
    this.openIds = this.openIds.includes(id)
      ? this.openIds.filter((k) => k !== id)
      : [...this.openIds, id];
  }

  toggleState(id) {
    const open = this.openIds.includes(id);
    return {
      expanded: open,
      toggleIcon: open ? "utility:chevrondown" : "utility:chevronright",
      toggleLabel: open ? "Hide details" : "Show details"
    };
  }

  // ---------- Conteneurs (lignes communes) ----------

  decorate(c) {
    const permissions = this.permissions;
    const powers = powerfulPermissions(c, permissions).map(
      (field) => permissions[field].label
    );
    const groupNames = (c.groups || [])
      .map((id) => this.groupsById[id]?.name)
      .filter(Boolean);
    const componentNames = (c.components || [])
      .map((id) => this.containersById[id])
      .filter(Boolean)
      .map((x) => (x.kind === KIND_MUTING ? `${x.name} (muting)` : x.name));
    const related = this.findingsByContainer[c.id] || [];
    const typeLabel =
      c.kind === KIND_PROFILE
        ? c.isCustom
          ? "Custom"
          : "Standard"
        : c.kind === KIND_GROUP
          ? "Group"
          : c.kind === KIND_MUTING
            ? "Muting"
            : c.type === "Session"
              ? "Session"
              : c.type === "Standard"
                ? "Salesforce"
                : "";
    return {
      ...c,
      ...this.toggleState(c.id),
      kindLabel: KIND_LABELS[c.kind] || c.kind,
      typeLabel,
      hasType: Boolean(typeLabel),
      powers,
      powerText: powers.join(", "),
      hasPowers: powers.length > 0,
      permissionLabels: (c.permissions || [])
        .map((field) => permissions[field]?.label || field)
        .join(", "),
      usersText:
        c.kind === KIND_PROFILE
          ? plural(c.activeUsers || 0, "user")
          : `${plural(c.activeUsers || 0, "assignment")}${c.inactiveUsers ? ` · ${c.inactiveUsers} inactive` : ""}`,
      objectsText: `${c.objectCount || 0} objects${c.modifyAllObjects ? ` · ${c.modifyAllObjects} Modify All` : ""}${c.viewAllObjects ? ` · ${c.viewAllObjects} View All` : ""}`,
      modifiedText: c.lastModified
        ? `${formatDate(c.lastModified)}${c.lastModifiedBy ? ` by ${c.lastModifiedBy}` : ""}`
        : "—",
      groupText: groupNames.join(", "),
      hasGroups: groupNames.length > 0,
      componentText: componentNames.join(", "),
      hasComponents: c.kind === KIND_GROUP,
      packaged: isPackaged(c),
      related: related.map((f) => ({
        id: f.id,
        title: f.title,
        tone: SEVERITY_TONES[f.severity] || "low",
        severity: f.severity
      })),
      hasRelated: related.length > 0,
      warn: related.length > 0
    };
  }

  // ---------- Profils ----------

  get profiles() {
    return (this.overview.containers || []).filter(
      (c) => c.kind === KIND_PROFILE
    );
  }

  profileMatches(c, filter) {
    switch (filter) {
      case "custom":
        return c.isCustom;
      case "standard":
        return !c.isCustom;
      case "unused":
        return c.isCustom && !c.activeUsers;
      case "powerful":
        return powerfulPermissions(c, this.permissions).length > 0;
      default:
        return true;
    }
  }

  get profileTiles() {
    return [
      { value: "all", label: "All" },
      { value: "custom", label: "Custom" },
      { value: "standard", label: "Standard" },
      { value: "unused", label: "Without users" },
      { value: "powerful", label: "Admin permissions" }
    ].map((tile) => ({
      ...tile,
      count: this.profiles.filter((c) => this.profileMatches(c, tile.value))
        .length,
      className: `pm-tile${this.profileFilter === tile.value ? " pm-tile-active" : ""}`
    }));
  }

  handleProfileTile(event) {
    this.profileFilter = event.currentTarget.dataset.value;
  }

  get visibleProfilesAll() {
    const term = this.term;
    return this.profiles
      .filter((c) => this.profileMatches(c, this.profileFilter))
      .filter((c) => matches(term, c.name, c.license))
      .sort(
        (a, b) =>
          (b.activeUsers || 0) - (a.activeUsers || 0) ||
          a.name.localeCompare(b.name)
      );
  }

  get visibleProfiles() {
    return this.visibleProfilesAll
      .slice(0, ROWS_MAX)
      .map((c) => this.decorate(c));
  }

  get profilesMore() {
    const more = this.visibleProfilesAll.length - ROWS_MAX;
    return more > 0 ? `${more} more in the Excel export` : "";
  }

  // ---------- Permission sets et groupes ----------

  get permissionSets() {
    return (this.overview.containers || []).filter(
      (c) =>
        c.kind === KIND_PERMISSION_SET ||
        c.kind === KIND_GROUP ||
        c.kind === KIND_MUTING
    );
  }

  setMatches(c, filter) {
    switch (filter) {
      case "sets":
        return c.kind === KIND_PERMISSION_SET;
      case "groups":
        return c.kind === KIND_GROUP;
      case "package":
        return isPackaged(c);
      case "unassigned":
        return (
          c.kind === KIND_PERMISSION_SET &&
          !c.activeUsers &&
          !c.inactiveUsers &&
          !(c.groups || []).length
        );
      case "inactiveOnly":
        return c.kind !== KIND_MUTING && !c.activeUsers && c.inactiveUsers > 0;
      case "powerful":
        return powerfulPermissions(c, this.permissions).length > 0;
      default:
        return true;
    }
  }

  get setTiles() {
    return [
      { value: "all", label: "All" },
      { value: "sets", label: "Permission sets" },
      { value: "groups", label: "Groups" },
      { value: "package", label: "From packages" },
      { value: "unassigned", label: "Never assigned" },
      { value: "inactiveOnly", label: "Inactive users only" },
      { value: "powerful", label: "Admin permissions" }
    ].map((tile) => ({
      ...tile,
      count: this.permissionSets.filter((c) => this.setMatches(c, tile.value))
        .length,
      className: `pm-tile${this.setFilter === tile.value ? " pm-tile-active" : ""}`
    }));
  }

  handleSetTile(event) {
    this.setFilter = event.currentTarget.dataset.value;
  }

  get visibleSetsAll() {
    const term = this.term;
    return this.permissionSets
      .filter((c) => this.setMatches(c, this.setFilter))
      .filter((c) => matches(term, c.name, c.apiName, c.namespace, c.license))
      .sort(
        (a, b) =>
          (b.activeUsers || 0) - (a.activeUsers || 0) ||
          a.name.localeCompare(b.name)
      );
  }

  get visibleSets() {
    return this.visibleSetsAll.slice(0, ROWS_MAX).map((c) => this.decorate(c));
  }

  get setsMore() {
    const more = this.visibleSetsAll.length - ROWS_MAX;
    return more > 0 ? `${more} more in the Excel export` : "";
  }

  // ---------- Constats ----------

  get severityTiles() {
    return ["Critical", "High", "Medium", "Low"].map((severity) => ({
      value: severity,
      label: severity,
      count: this.findings.filter((f) => f.severity === severity).length,
      className: `pm-tile pm-tile-${SEVERITY_TONES[severity]}${this.severityFilter === severity ? " pm-tile-active" : ""}`
    }));
  }

  handleSeverityTile(event) {
    const value = event.currentTarget.dataset.value;
    this.severityFilter = this.severityFilter === value ? "all" : value;
  }

  get visibleFindingsAll() {
    const term = this.term;
    return this.findings.filter(
      (f) =>
        (this.severityFilter === "all" || f.severity === this.severityFilter) &&
        matches(term, f.title, f.element, f.detail)
    );
  }

  get visibleFindings() {
    const selected = new Set(this.selectedIds);
    return this.visibleFindingsAll.map((f) => ({
      ...f,
      ...this.toggleState(f.id),
      tone: SEVERITY_TONES[f.severity] || "low",
      checked: selected.has(f.id),
      checkboxLabel: `Select ${f.title} — ${f.element}`,
      affectedItems: f.affected.map((label, index) => ({
        key: `${f.id}-${index}`,
        label
      })),
      hasAffected: f.affected.length > 0,
      canCompare: f.containerIds.length === 2
    }));
  }

  get hasFindings() {
    return this.visibleFindingsAll.length > 0;
  }

  get findingsNote() {
    return this.analysis?.objectAccessComplete
      ? ""
      : "Object access not read: overlap checks (similar profiles, duplicates) were skipped.";
  }

  handleSelect(event) {
    const id = event.target.dataset.id;
    const ids = new Set(this.selectedIds);
    if (event.target.checked) {
      ids.add(id);
    } else {
      ids.delete(id);
    }
    this.selectedIds = [...ids];
  }

  handleSelectAll() {
    this.selectedIds = this.visibleFindingsAll.map((f) => f.id);
  }

  handleClearSelection() {
    this.selectedIds = [];
  }

  get selectedCount() {
    return this.selectedIds.length;
  }

  get sendLabel() {
    return `Send to Recommendations (${this.selectedCount})`;
  }

  get sendDisabled() {
    return !this.selectedCount || this.isSending;
  }

  async handleSend() {
    this.isSending = true;
    try {
      const wanted = new Set(this.selectedIds);
      const detectedAt = this.overview.generatedAt || new Date().toISOString();
      const specs = this.findings
        .filter((f) => wanted.has(f.id))
        .map((f) => recommendationSpec(f, detectedAt));
      const result = await sendRecommendations(specs, {
        reopenReason:
          "Detected again by the permissions analysis after being resolved."
      });
      this.selectedIds = [];
      this.toast(
        "Sent to Recommendations",
        `${result.created} created, ${result.updated} updated.`,
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

  handleCompareFinding(event) {
    const finding = this.findings.find(
      (f) => f.id === event.currentTarget.dataset.id
    );
    if (finding && finding.containerIds.length === 2) {
      this.startCompare(finding.containerIds[0], finding.containerIds[1]);
    }
  }

  handleCompareWith(event) {
    this.compareLeft = event.currentTarget.dataset.id;
    this.compareRight = "";
    this.comparison = undefined;
    this.setTab("compare");
  }

  // ---------- Matrice des droits objet ----------

  get objectOptions() {
    return objectNames(this.analysis?.objectAccess).map((name) => ({
      label: name,
      value: name
    }));
  }

  get hasObjectAccess() {
    return this.objectOptions.length > 0;
  }

  handleObject(event) {
    this.selectedObject = event.detail.value;
  }

  get kindFilters() {
    return KIND_FILTERS;
  }

  handleKind(event) {
    this.kindFilter = event.detail.value;
  }

  handleOnlyWithAccess(event) {
    this.onlyWithAccess = event.target.checked;
  }

  handleOnlyInUse(event) {
    this.onlyInUse = event.target.checked;
  }

  /** Conteneurs retenus par le filtre de type (muting exclus : ils retirent des droits). */
  filteredContainers(term) {
    return (this.overview.containers || []).filter(
      (c) =>
        c.kind !== KIND_MUTING &&
        (this.kindFilter === "all" || c.kind === this.kindFilter) &&
        (!this.onlyInUse || c.activeUsers > 0) &&
        matches(term, c.name, c.apiName)
    );
  }

  get objectRowsAll() {
    const access = this.analysis?.objectAccess || {};
    const object = this.selectedObject;
    return this.filteredContainers(this.term)
      .map((c) => ({ c, flags: objectFlags(access, c.id, object) }))
      .filter((row) => !this.onlyWithAccess || row.flags)
      .sort(
        (a, b) =>
          b.flags.length - a.flags.length || a.c.name.localeCompare(b.c.name)
      );
  }

  get objectRows() {
    return this.objectRowsAll.slice(0, ROWS_MAX).map(({ c, flags }) => ({
      id: c.id,
      name: c.name,
      kindLabel: KIND_LABELS[c.kind],
      usersText: formatNumber(c.activeUsers || 0),
      cells: OBJECT_FLAGS.map((flag) => {
        const on = flags.includes(flag.letter);
        return {
          key: `${c.id}-${flag.letter}`,
          on,
          strong: on && (flag.letter === "M" || flag.letter === "V"),
          title: `${flag.label}: ${on ? "yes" : "no"}`,
          className: `pm-cell${on ? (flag.letter === "M" || flag.letter === "V" ? " pm-cell-strong" : " pm-cell-on") : ""}`
        };
      })
    }));
  }

  get objectFlagHeaders() {
    return OBJECT_FLAGS;
  }

  get hasObjectRows() {
    return this.objectRowsAll.length > 0;
  }

  get objectSummary() {
    const rows = this.objectRowsAll;
    const modifyAll = rows.filter((r) => r.flags.includes("M")).length;
    const editors = rows.filter((r) => r.flags.includes("E")).length;
    return `${plural(rows.length, "container")} · ${editors} can edit · ${modifyAll} Modify All`;
  }

  // ---------- FLS ----------

  handleFieldObject(event) {
    this.fieldObject = event.detail.value;
    this.restoreFieldAccess();
  }

  async restoreFieldAccess() {
    const name = this.fieldObject;
    if (!name) {
      this.fieldAccess = undefined;
      return;
    }
    try {
      const stored = await loadValue(`${STORE_FIELDS}${name}`, null);
      if (this.fieldObject === name) {
        this.fieldAccess = stored || undefined;
      }
    } catch {
      this.fieldAccess = undefined;
    }
  }

  async handleLoadFields() {
    if (!this.fieldObject) {
      return;
    }
    this.isLoadingFields = true;
    try {
      const result = await loadFieldAccess({ objectName: this.fieldObject });
      this.fieldAccess = result;
      try {
        await saveValue(`${STORE_FIELDS}${result.objectName}`, result);
      } catch (error) {
        this.toast(
          "The field access could not be kept in this browser",
          reduceErrors(error),
          "warning"
        );
      }
    } catch (error) {
      this.toast(
        "The field access could not be read",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.isLoadingFields = false;
    }
  }

  handleFieldSearch(event) {
    this.fieldSearch = event.target.value || "";
  }

  get noFieldAccessIdle() {
    return !this.isLoadingFields;
  }

  get hasFieldAccess() {
    return Boolean(this.fieldAccess);
  }

  get fieldLoadLabel() {
    return this.fieldAccess ? "Read again" : "Read field access";
  }

  get fieldSubtitle() {
    if (!this.fieldAccess) {
      return "";
    }
    return `${this.fieldAccess.objectLabel} · ${plural(this.fieldAccess.fields.length, "field")} · read ${formatRelative(this.fieldAccess.generatedAt)}${this.fieldAccess.truncated ? " · incomplete (too many rows)" : ""}`;
  }

  /** Conteneurs en colonnes : ceux du filtre ayant au moins un droit sur l'objet. */
  get fieldColumnsAll() {
    const entries = this.fieldAccess?.entries || {};
    return this.filteredContainers(this.term).filter(
      (c) => !this.onlyWithAccess || (entries[c.id] || []).length
    );
  }

  get fieldColumns() {
    return this.fieldColumnsAll.slice(0, FIELD_COLUMNS_MAX).map((c) => ({
      id: c.id,
      name: c.name,
      title: `${c.name} (${KIND_LABELS[c.kind]})`
    }));
  }

  get fieldColumnsNote() {
    const more = this.fieldColumnsAll.length - FIELD_COLUMNS_MAX;
    return more > 0
      ? `${more} more column(s): narrow the filters or use the Excel export.`
      : "";
  }

  fieldMaps(columns) {
    const entries = this.fieldAccess?.entries || {};
    const maps = {};
    columns.forEach((c) => {
      maps[c.id] = objectMap(entries[c.id]);
    });
    return maps;
  }

  get visibleFieldsAll() {
    const term = this.fieldSearch.trim().toLowerCase();
    return (this.fieldAccess?.fields || [])
      .filter((f) => matches(term, f.label, f.name))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  get fieldRows() {
    const columns = this.fieldColumns;
    const maps = this.fieldMaps(columns);
    return this.visibleFieldsAll.slice(0, ROWS_MAX).map((f) => {
      let editors = 0;
      const cells = columns.map((c) => {
        const flags = maps[c.id][f.name] || "";
        if (flags.includes("E")) {
          editors++;
        }
        const label = FLS_LABELS[flags] ?? flags;
        return {
          key: `${f.name}-${c.id}`,
          label: label ? label.charAt(0) : "",
          title: `${c.name}: ${label || "no access"}`,
          className: `pm-cell${flags.includes("E") ? " pm-cell-strong" : flags ? " pm-cell-on" : ""}`
        };
      });
      return {
        name: f.name,
        label: f.label,
        meta: `${f.name}${f.custom ? "" : " · standard"}`,
        editors,
        cells
      };
    });
  }

  get hasFieldRows() {
    return this.fieldRows.length > 0 && this.fieldColumns.length > 0;
  }

  // ---------- Comparaison ----------

  get compareOptions() {
    return (this.overview.containers || [])
      .filter((c) => c.kind !== KIND_MUTING)
      .map((c) => ({
        label: `${c.name} (${KIND_LABELS[c.kind]})`,
        value: c.id
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  handleCompareLeft(event) {
    this.compareLeft = event.detail.value;
  }

  handleCompareRight(event) {
    this.compareRight = event.detail.value;
  }

  get compareDisabled() {
    return (
      !this.compareLeft ||
      !this.compareRight ||
      this.compareLeft === this.compareRight ||
      this.isComparing
    );
  }

  handleCompare() {
    this.startCompare(this.compareLeft, this.compareRight);
  }

  handleSwap() {
    [this.compareLeft, this.compareRight] = [
      this.compareRight,
      this.compareLeft
    ];
    this.comparison = undefined;
  }

  async startCompare(leftId, rightId) {
    this.compareLeft = leftId;
    this.compareRight = rightId;
    this.activeTab = "compare";
    this.compareArea = "all";
    this.isComparing = true;
    try {
      this.comparison = await comparePermissions({ leftId, rightId });
    } catch (error) {
      this.toast(
        "The comparison could not be made",
        reduceErrors(error),
        "error"
      );
    } finally {
      this.isComparing = false;
    }
  }

  get hasComparison() {
    return Boolean(this.comparison);
  }

  get compareTiles() {
    const c = this.comparison || {};
    const counts = {
      System: c.systemDifferences || 0,
      Object: c.objectDifferences || 0,
      Field: c.fieldDifferences || 0
    };
    const labels = {
      System: "System permissions",
      Object: "Objects",
      Field: "Fields"
    };
    return COMPARE_AREAS.map((area) => ({
      value: area,
      label: labels[area],
      count: counts[area],
      className: `pm-tile${this.compareArea === area ? " pm-tile-active" : ""}`
    }));
  }

  handleCompareTile(event) {
    const value = event.currentTarget.dataset.value;
    this.compareArea = this.compareArea === value ? "all" : value;
  }

  get compareRowsAll() {
    const term = this.term;
    return (this.comparison?.differences || []).filter(
      (d) =>
        (this.compareArea === "all" || d.area === this.compareArea) &&
        matches(term, d.label, d.item)
    );
  }

  get compareRows() {
    return this.compareRowsAll.slice(0, ROWS_MAX).map((d, index) => ({
      key: `${d.area}-${d.item}-${index}`,
      area: d.area,
      label: d.label,
      item: d.item !== d.label ? d.item : "",
      left: this.describeFlags(d.area, d.left),
      right: this.describeFlags(d.area, d.right)
    }));
  }

  get hasCompareRows() {
    return this.compareRowsAll.length > 0;
  }

  get compareSummary() {
    const c = this.comparison;
    if (!c) {
      return "";
    }
    const total = (c.differences || []).length;
    return `${c.leftName} vs ${c.rightName} · ${plural(total, "difference")}${c.truncated ? " · incomplete (too many rows)" : ""}`;
  }

  get compareMore() {
    const more = this.compareRowsAll.length - ROWS_MAX;
    return more > 0 ? `${more} more in the Excel export` : "";
  }

  get leftName() {
    return this.comparison?.leftName || "Left";
  }

  get rightName() {
    return this.comparison?.rightName || "Right";
  }

  describeFlags(area, flags) {
    if (area === "System") {
      return flags ? "Yes" : "—";
    }
    if (!flags) {
      return "—";
    }
    if (area === "Field") {
      return flags.includes("E") ? "Read, Edit" : "Read";
    }
    return OBJECT_FLAGS.filter((f) => flags.includes(f.letter))
      .map((f) => f.label)
      .join(", ");
  }

  // ---------- Utilisateurs ----------

  get usersData() {
    return this.analysis?.users || {};
  }

  get userKpis() {
    const u = this.usersData;
    const many = (u.top || []).filter(
      (row) =>
        (row.permissionSets || 0) + (row.groups || 0) >
        THRESHOLDS.manyPermissionSets
    ).length;
    return [
      {
        key: "active",
        label: "Active users",
        value: formatNumber(u.activeUsers || 0)
      },
      {
        key: "profileOnly",
        label: "Profile only",
        value: formatNumber(u.profileOnlyUsers || 0),
        help: "Internal users without any permission set or group."
      },
      {
        key: "many",
        label: `More than ${THRESHOLDS.manyPermissionSets} sets`,
        value: formatNumber(many)
      }
    ];
  }

  get distribution() {
    const dist = this.usersData.distribution || {};
    const buckets = [
      { label: "1", min: 1, max: 1 },
      { label: "2-3", min: 2, max: 3 },
      { label: "4-5", min: 4, max: 5 },
      { label: "6-10", min: 6, max: 10 },
      { label: "11-15", min: 11, max: 15 },
      { label: "16+", min: 16, max: Infinity }
    ].map((b) => ({ ...b, count: 0 }));
    Object.keys(dist).forEach((key) => {
      const n = Number(key);
      const bucket = buckets.find((b) => n >= b.min && n <= b.max);
      if (bucket) {
        bucket.count += dist[key];
      }
    });
    const zero = this.usersData.profileOnlyUsers || 0;
    const all = [{ label: "0", count: zero }, ...buckets];
    const max = Math.max(1, ...all.map((b) => b.count));
    return all.map((b) => ({
      key: b.label,
      label: b.label,
      count: formatNumber(b.count),
      style: `height: ${Math.max(2, (b.count * 100) / max)}%`,
      title: `${b.count} user(s) with ${b.label} permission set(s) or group(s)`
    }));
  }

  get usersViews() {
    return [
      { value: "top", label: "Most permission sets" },
      { value: "profileOnly", label: "Profile only" }
    ].map((v) => ({
      ...v,
      className: `pm-tile${this.usersView === v.value ? " pm-tile-active" : ""}`
    }));
  }

  handleUsersView(event) {
    this.usersView = event.currentTarget.dataset.value;
  }

  get userRowsAll() {
    const term = this.term;
    const source =
      this.usersView === "profileOnly"
        ? this.usersData.profileOnly || []
        : this.usersData.top || [];
    return source.filter((u) => matches(term, u.name, u.username, u.profile));
  }

  get userRows() {
    return this.userRowsAll.slice(0, ROWS_MAX).map((u) => {
      const total = (u.permissionSets || 0) + (u.groups || 0);
      return {
        ...u,
        total,
        lastLoginText: u.lastLogin ? formatDate(u.lastLogin) : "Never",
        totalClass: `pm-num${total > THRESHOLDS.manyPermissionSets ? " pm-warn" : ""}`
      };
    });
  }

  get hasUserRows() {
    return this.userRowsAll.length > 0;
  }

  get usersNote() {
    const u = this.usersData;
    return u.profileOnlyUsers > (u.profileOnly || []).length &&
      this.usersView === "profileOnly"
      ? `First ${(u.profileOnly || []).length} of ${u.profileOnlyUsers} users.`
      : "";
  }

  // ---------- Exports Excel / CSV ----------

  containerColumns() {
    const permissions = this.permissions;
    return [
      { label: "Name", value: (c) => c.name },
      { label: "API name", value: (c) => c.apiName },
      { label: "Kind", value: (c) => KIND_LABELS[c.kind] || c.kind },
      { label: "Type", value: (c) => c.type },
      { label: "Custom", value: (c) => (c.isCustom ? "Yes" : "No") },
      { label: "Namespace", value: (c) => c.namespace },
      { label: "License", value: (c) => c.license },
      {
        label: "Active users / assignments",
        value: (c) => c.activeUsers || 0
      },
      { label: "Inactive assignments", value: (c) => c.inactiveUsers || 0 },
      { label: "Objects", value: (c) => c.objectCount || 0 },
      { label: "Modify All objects", value: (c) => c.modifyAllObjects || 0 },
      { label: "View All objects", value: (c) => c.viewAllObjects || 0 },
      {
        label: "Groups",
        value: (c) =>
          (c.groups || [])
            .map((id) => this.groupsById[id]?.name)
            .filter(Boolean)
            .join(", ")
      },
      {
        label: "Components",
        value: (c) =>
          (c.components || [])
            .map((id) => this.containersById[id]?.name)
            .filter(Boolean)
            .join(", ")
      },
      { label: "Status", value: (c) => c.status },
      {
        label: "Last modified",
        value: (c) => formatExportDate(c.lastModified)
      },
      { label: "Last modified by", value: (c) => c.lastModifiedBy },
      ...(this.overview.keyPermissions || []).map((p) => ({
        label: permissions[p.field]?.label || p.field,
        value: (c) => ((c.permissions || []).includes(p.field) ? "Yes" : "")
      }))
    ];
  }

  handleExportProfiles(event) {
    exportRows({
      name: "profiles",
      format: event.detail.format,
      rows: this.visibleProfilesAll,
      columns: this.containerColumns()
    });
  }

  handleExportSets(event) {
    exportRows({
      name: "permission-sets",
      format: event.detail.format,
      rows: this.visibleSetsAll,
      columns: this.containerColumns()
    });
  }

  handleExportFindings(event) {
    exportRows({
      name: "permission-findings",
      format: event.detail.format,
      rows: this.visibleFindingsAll,
      columns: [
        { label: "Severity", value: (f) => f.severity },
        { label: "Finding", value: (f) => f.title },
        { label: "Concerned", value: (f) => f.element },
        { label: "Detail", value: (f) => f.detail },
        { label: "What to do", value: (f) => f.advice },
        { label: "Items", value: (f) => f.affected.join("\n") },
        { label: "Rule", value: (f) => f.rule }
      ]
    });
  }

  handleExportObjects(event) {
    exportRows({
      name: `object-access-${this.selectedObject}`,
      format: event.detail.format,
      rows: this.objectRowsAll,
      columns: [
        { label: "Object", value: () => this.selectedObject },
        { label: "Name", value: (r) => r.c.name },
        { label: "Kind", value: (r) => KIND_LABELS[r.c.kind] },
        { label: "Active users", value: (r) => r.c.activeUsers || 0 },
        ...OBJECT_FLAGS.map((flag) => ({
          label: flag.label,
          value: (r) => (r.flags.includes(flag.letter) ? "Yes" : "")
        }))
      ]
    });
  }

  handleExportFields(event) {
    const columns = this.fieldColumnsAll;
    const maps = this.fieldMaps(columns);
    exportRows({
      name: `field-access-${this.fieldAccess?.objectName || ""}`,
      format: event.detail.format,
      rows: this.visibleFieldsAll,
      columns: [
        { label: "Field", value: (f) => f.label },
        { label: "API name", value: (f) => f.name },
        { label: "Type", value: (f) => f.type },
        ...columns.map((c) => ({
          label: c.name,
          value: (f) => FLS_LABELS[maps[c.id][f.name] || ""] ?? ""
        }))
      ]
    });
  }

  handleExportCompare(event) {
    exportRows({
      name: "permission-comparison",
      format: event.detail.format,
      rows: this.compareRowsAll,
      columns: [
        { label: "Area", value: (d) => d.area },
        { label: "Permission", value: (d) => d.label },
        { label: "API name", value: (d) => d.item },
        {
          label: this.leftName,
          value: (d) => this.describeFlags(d.area, d.left)
        },
        {
          label: this.rightName,
          value: (d) => this.describeFlags(d.area, d.right)
        }
      ]
    });
  }

  handleExportUsers(event) {
    exportRows({
      name:
        this.usersView === "profileOnly"
          ? "profile-only-users"
          : "user-permission-sets",
      format: event.detail.format,
      rows: this.userRowsAll,
      columns: [
        { label: "User", value: (u) => u.name },
        { label: "Username", value: (u) => u.username },
        { label: "Profile", value: (u) => u.profile },
        { label: "User type", value: (u) => u.userType },
        { label: "Permission sets", value: (u) => u.permissionSets || 0 },
        { label: "Groups", value: (u) => u.groups || 0 },
        {
          label: "Last login",
          value: (u) => formatExportDate(u.lastLogin)
        }
      ]
    });
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
