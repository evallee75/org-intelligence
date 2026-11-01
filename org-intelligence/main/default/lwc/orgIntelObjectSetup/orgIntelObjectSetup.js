import { LightningElement } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import {
  exportRows,
  formatDate,
  formatDateTime,
  formatExportDate,
  formatRelative,
  reduceErrors,
  severityMeta
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import {
  clearAll,
  downloadJson,
  listKeys,
  loadValue,
  saveValue,
  STORE_KEYS
} from "c/orgIntelStore";
import { LOCAL_MODE, sendRecommendations } from "c/orgIntelRecommendationStore";

// Action Apex du module Field Usage (lecture seule)
const analyzeObjectSetup = moduleAction("fieldUsage", "analyzeObjectSetup");
const getObjects = moduleAction("fieldUsage", "getObjects");

/** Dernière analyse par objet, gardée dans ce navigateur. */
const SETUP_PREFIX = `${STORE_KEYS.FIELD_USAGE}.setup.`;
const FILE_KIND = "objectSetup";
/** Dernier objet ouvert (hors préfixe des analyses : ni exporté, ni compté). */
const LAST_OBJECT_KEY = `${STORE_KEYS.FIELD_USAGE}.setupLastObject`;
const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Info"];

/** Blocs dépliables, un par thème (le thème relie les tuiles, les constats et les blocs). */
const BLOCKS = [
  { key: "recordTypes", label: "Record types", theme: "Record types" },
  { key: "layouts", label: "Page layouts", theme: "Layouts" },
  { key: "assignments", label: "Layout assignments", theme: "Assignments" },
  { key: "pages", label: "Lightning record pages", theme: "Lightning pages" },
  { key: "compact", label: "Compact layouts", theme: "Compact layouts" }
];

const MASTER = "master";
/** Teintes des présentations dans la matrice (le nom reste écrit : la couleur n'est qu'un repère). */
const LAYOUT_TONES = 6;

const yesNo = (value) => {
  if (value === true) {
    return "Yes";
  }
  return value === false ? "No" : "—";
};
function dash(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

/**
 * Section « Object Setup » (menu Analysis, module Field Usage) : choix d'un objet, puis types
 * d'enregistrement, présentations et assignations, pages Lightning (Dynamic Forms), présentations
 * compactes et constats. Calculé à la demande (Apex en lecture seule) et gardé dans ce navigateur.
 */
export default class OrgIntelObjectSetup extends LightningElement {
  objects = [];
  objectsError;
  isLoadingObjects = true;
  objectSearch = "";
  objectFilter = "all";
  /** Objet → résumé de la dernière analyse gardée ({ score, analyzedAt, findings }). */
  analyzedObjects = {};

  _objectName;
  result = null;
  isLoading = false;
  isRunning = false;
  isSending = false;
  error;
  themeFilter = null;
  expandedFinding = null;
  openBlocks = new Set();
  activeProfilesOnly = true;

  connectedCallback() {
    this.loadObjects();
  }

  async loadObjects() {
    this.isLoadingObjects = true;
    this.objectsError = undefined;
    try {
      const [objects, last] = await Promise.all([
        getObjects(),
        loadValue(LAST_OBJECT_KEY, null),
        this.loadAnalyzedIndex()
      ]);
      this.objects = objects || [];
      const initial =
        last && this.objects.some((o) => o.apiName === last)
          ? last
          : Object.keys(this.analyzedObjects)[0] ||
            (this.objects.some((o) => o.apiName === "Account")
              ? "Account"
              : this.objects[0]?.apiName);
      if (initial) {
        this.selectObject(initial);
      }
    } catch (error) {
      this.objectsError = error;
    } finally {
      this.isLoadingObjects = false;
    }
  }

  /** Résumé des analyses gardées, pour marquer les objets déjà analysés dans la liste. */
  async loadAnalyzedIndex() {
    const index = {};
    try {
      const keys = await listKeys(SETUP_PREFIX);
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await loadValue(key, null);
        if (stored && stored.objectName) {
          index[stored.objectName] = summaryOf(stored);
        }
      }
    } catch {
      // index facultatif : la liste reste utilisable
    }
    this.analyzedObjects = index;
  }

  get objectName() {
    return this._objectName;
  }

  get objectFilters() {
    return [
      { value: "all", label: "All" },
      { value: "custom", label: "Custom" },
      { value: "analyzed", label: "Analyzed" }
    ].map((f) => ({
      ...f,
      pressed: f.value === this.objectFilter ? "true" : "false",
      className: `os-chip${f.value === this.objectFilter ? " os-chip-selected" : ""}`
    }));
  }

  get objectItems() {
    const term = this.objectSearch.trim().toLowerCase();
    return this.objects
      .filter(
        (o) =>
          (this.objectFilter !== "custom" || o.isCustom) &&
          (this.objectFilter !== "analyzed" ||
            this.analyzedObjects[o.apiName]) &&
          (!term ||
            o.apiName.toLowerCase().includes(term) ||
            (o.label || "").toLowerCase().includes(term))
      )
      .sort(
        (a, b) =>
          (this.analyzedObjects[b.apiName] ? 1 : 0) -
            (this.analyzedObjects[a.apiName] ? 1 : 0) ||
          (a.label || "").localeCompare(b.label || "")
      )
      .slice(0, 300)
      .map((o) => {
        const selected = o.apiName === this._objectName;
        const analyzed = this.analyzedObjects[o.apiName];
        const hasScore =
          !!analyzed && analyzed.score !== null && analyzed.score !== undefined;
        return {
          ...o,
          meta: analyzed
            ? `${formatRelative(analyzed.analyzedAt)} · ${analyzed.findings} finding(s)`
            : o.apiName,
          hasScore,
          score: hasScore ? analyzed.score : null,
          scoreClass: `os-score os-score-${scoreTone(hasScore ? analyzed.score : null) || "none"}`,
          className: `os-object${selected ? " os-object-selected" : ""}`,
          current: selected ? "true" : "false"
        };
      });
  }

  get hasObjectItems() {
    return this.objectItems.length > 0;
  }

  get hasObject() {
    return !!this._objectName;
  }

  get objectTitle() {
    const o = this.objects.find((item) => item.apiName === this._objectName);
    return o ? o.label : this._objectName;
  }

  handleObjectSearch(event) {
    this.objectSearch = event.target.value || "";
  }

  handleObjectFilter(event) {
    this.objectFilter = event.currentTarget.dataset.value;
  }

  handleSelectObject(event) {
    this.selectObject(event.currentTarget.dataset.name);
  }

  selectObject(name) {
    if (!name || name === this._objectName) {
      return;
    }
    this._objectName = name;
    this.themeFilter = null;
    this.expandedFinding = null;
    this.openBlocks = new Set();
    saveValue(LAST_OBJECT_KEY, name).catch(() => {});
    this.loadStored();
  }

  handleRefresh() {
    this.loadObjects();
  }

  async loadStored() {
    const objectName = this._objectName;
    this.result = null;
    this.error = undefined;
    if (!objectName) {
      return;
    }
    this.isLoading = true;
    try {
      const stored = await loadValue(SETUP_PREFIX + objectName, null);
      if (objectName === this._objectName) {
        this.result = stored;
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  // ---------- Analyse ----------

  async handleRun() {
    const objectName = this._objectName;
    this.isRunning = true;
    this.error = undefined;
    try {
      const result = await analyzeObjectSetup({ objectName });
      try {
        await saveValue(SETUP_PREFIX + objectName, result);
      } catch (storeError) {
        this.toast(
          "Not kept in this browser",
          reduceErrors(storeError),
          "warning"
        );
      }
      this.analyzedObjects = {
        ...this.analyzedObjects,
        [objectName]: summaryOf(result)
      };
      if (objectName === this._objectName) {
        this.result = result;
        this.themeFilter = null;
        this.expandedFinding = null;
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.isRunning = false;
    }
  }

  get hasResult() {
    return !!this.result;
  }

  get noResult() {
    return !this.isLoading && !this.result && !this.error;
  }

  get runLabel() {
    return this.result ? "Run again" : "Run analysis";
  }

  get analyzedText() {
    return this.result
      ? `Analyzed ${formatRelative(this.result.analyzedAt)}`
      : "";
  }

  get analyzedTitle() {
    return this.result ? formatDateTime(this.result.analyzedAt) : "";
  }

  get notes() {
    return (this.result?.notes || []).join(" ");
  }

  get summaryText() {
    const s = this.result?.summary || {};
    const parts = [
      `${dash(s.fieldCount)} fields (${dash(s.customFieldCount)} custom)`
    ];
    parts.push(
      s.validationRules === null || s.validationRules === undefined
        ? "validation rules not read"
        : `${s.activeValidationRules}/${s.validationRules} active validation rules`
    );
    if (s.triggers !== null && s.triggers !== undefined) {
      parts.push(`${s.activeTriggers}/${s.triggers} active triggers`);
    }
    if (
      s.recordTriggeredFlows !== null &&
      s.recordTriggeredFlows !== undefined
    ) {
      parts.push(`${s.recordTriggeredFlows} record-triggered flows`);
    }
    if (s.internalSharing) {
      parts.push(
        `sharing ${s.internalSharing} / external ${dash(s.externalSharing)}`
      );
    }
    return parts.join(" · ");
  }

  // ---------- Tuiles ----------

  get tiles() {
    const r = this.result;
    if (!r) {
      return [];
    }
    const findings = r.findings || [];
    const countFor = (theme) =>
      findings.filter((f) => f.theme === theme).length;
    const activeTypes = (r.recordTypes || []).filter((t) => t.isActive).length;
    const pagesRead = (r.pages || []).filter((p) => p.detailsRead);
    const dynamic = pagesRead.filter((p) => p.dynamicForms).length;
    const unassigned = (r.layouts || []).filter(
      (l) => l.assignmentCount === 0
    ).length;
    const tiles = [
      {
        key: "score",
        theme: null,
        label: "Score",
        value: r.score === null || r.score === undefined ? "—" : r.score,
        caption: `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
        tone: scoreTone(r.score),
        title:
          "100 minus 5 per Medium and 2 per Low finding. Click to show every finding."
      },
      {
        key: "recordTypes",
        theme: "Record types",
        label: "Record types",
        value: (r.recordTypes || []).length,
        caption: `${activeTypes} active`,
        tone: countFor("Record types") ? "warning" : "",
        title: "Show the record type findings"
      },
      {
        key: "layouts",
        theme: "Layouts",
        label: "Layouts",
        value: r.toolingAvailable ? (r.layouts || []).length : "—",
        caption: r.toolingAvailable
          ? `${unassigned} unassigned`
          : "Tooling API needed",
        tone: countFor("Layouts") ? "warning" : "",
        title: "Show the layout findings"
      },
      {
        key: "assignments",
        theme: "Assignments",
        label: "Profiles",
        value: r.assignmentsKnown
          ? (r.profiles || []).filter((p) => p.activeUsers > 0).length
          : "—",
        caption: "with active users",
        tone: countFor("Assignments") ? "warning" : "",
        title: "Show the assignment findings"
      },
      {
        key: "pages",
        theme: "Lightning pages",
        label: "Lightning pages",
        value: r.pagesKnown ? (r.pages || []).length : "—",
        caption: r.pagesKnown ? "record pages" : "not read",
        tone: countFor("Lightning pages") ? "warning" : "",
        title: "Show the Lightning page findings"
      },
      {
        key: "dynamic",
        theme: "Lightning pages",
        label: "Dynamic Forms",
        value: r.pagesKnown ? `${dynamic}/${pagesRead.length}` : "—",
        caption: "pages using it",
        tone: "",
        title: "Pages whose fields are placed one by one (Dynamic Forms)"
      }
    ];
    return tiles.map((tile) => {
      const active =
        tile.theme !== null &&
        this.themeFilter === tile.theme &&
        tile.key !== "dynamic";
      return {
        ...tile,
        pressed: active ? "true" : "false",
        className: `os-tile${tile.tone ? ` os-tile-${tile.tone}` : ""}${active ? " os-tile-active" : ""}`
      };
    });
  }

  handleTile(event) {
    const theme = event.currentTarget.dataset.theme || null;
    this.themeFilter = !theme || this.themeFilter === theme ? null : theme;
    const block = BLOCKS.find((b) => b.theme === theme);
    if (block && this.themeFilter) {
      const open = new Set(this.openBlocks);
      open.add(block.key);
      this.openBlocks = open;
    }
  }

  // ---------- Constats ----------

  get visibleFindings() {
    const all = this.result?.findings || [];
    return all
      .filter((f) => !this.themeFilter || f.theme === this.themeFilter)
      .slice()
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) -
            SEVERITY_ORDER.indexOf(b.severity) ||
          String(a.theme).localeCompare(String(b.theme))
      );
  }

  get findingRows() {
    return this.visibleFindings.map((f, index) => {
      const id = `${f.key}|${f.element}|${index}`;
      const expanded = this.expandedFinding === id;
      return {
        ...f,
        id,
        expanded,
        ariaExpanded: expanded ? "true" : "false",
        icon: expanded ? "utility:chevrondown" : "utility:chevronright",
        tone: severityMeta(f.severity).tone,
        setupUrl: this.setupUrlFor(f)
      };
    });
  }

  get hasFindings() {
    return this.visibleFindings.length > 0;
  }

  get findingsTitle() {
    return this.themeFilter ? `Findings · ${this.themeFilter}` : "Findings";
  }

  get hasThemeFilter() {
    return !!this.themeFilter;
  }

  handleClearTheme() {
    this.themeFilter = null;
  }

  handleToggleFinding(event) {
    const id = event.currentTarget.dataset.id;
    this.expandedFinding = this.expandedFinding === id ? null : id;
  }

  handleFindingKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleToggleFinding(event);
    }
  }

  setupUrlFor(finding) {
    const base = `/lightning/setup/ObjectManager/${this._objectName}`;
    const id = finding.elementId;
    switch (finding.theme) {
      case "Record types":
        return id
          ? `${base}/RecordTypes/${id}/view`
          : `${base}/RecordTypes/view`;
      case "Layouts":
        return id
          ? `${base}/PageLayouts/${id}/view`
          : `${base}/PageLayouts/view`;
      case "Assignments":
        return `${base}/PageLayouts/view`;
      case "Lightning pages":
        return id
          ? `/visualEditor/appBuilder.app?id=${id}`
          : `${base}/LightningPages/view`;
      case "Compact layouts":
        return id
          ? `${base}/CompactLayouts/${id}/view`
          : `${base}/CompactLayouts/view`;
      default:
        return `${base}/Details/view`;
    }
  }

  /** Constats envoyés : ceux affichés, hors « Info ». */
  get sendableFindings() {
    return this.visibleFindings.filter((f) => f.severity !== "Info");
  }

  get sendLabel() {
    return `Send to Recommendations (${this.sendableFindings.length})`;
  }

  get sendDisabled() {
    return this.isSending || this.sendableFindings.length === 0;
  }

  buildRecommendationSpecs(findings) {
    const r = this.result;
    const now = new Date().toISOString();
    return findings.map((f) => {
      const rule = `OBJECT_SETUP_${f.key}`;
      const element = f.element || r.objectName;
      const affected =
        element === r.objectName ? r.objectName : `${r.objectName}: ${element}`;
      return {
        Fingerprint__c:
          `${rule}|CustomObject:${r.objectName}|${element}`.substring(0, 255),
        RuleCode__c: rule,
        Title__c: `${f.title}: ${affected}`.substring(0, 255),
        Description__c: `${f.title} — ${affected} (${f.theme}). Object setup analysis of ${formatDateTime(r.analyzedAt)}.`,
        SuggestedAction__c: f.advice || null,
        Category__c: "Maintainability",
        Confidence__c: "Medium",
        ComponentType__c: "CustomObject",
        ComponentName__c: r.objectName,
        AffectedComponents__c: affected,
        LastDetectedAt__c: now,
        StillDetected__c: true,
        Severity__c: f.severity
      };
    });
  }

  async handleSend() {
    this.isSending = true;
    try {
      const specs = this.buildRecommendationSpecs(this.sendableFindings);
      const result = await sendRecommendations(specs, {
        reopenReason:
          "Detected again by an object setup analysis after being resolved."
      });
      const where =
        result.mode === LOCAL_MODE
          ? "They are stored in this browser (Data Model domain)."
          : "They appear in the Data Model domain.";
      this.toast(
        "Sent to Recommendations",
        `${result.created} created, ${result.updated} updated. ${where}`,
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

  handleExportFindings(event) {
    exportRows({
      name: `object-setup-findings-${this._objectName}`,
      format: event.detail.format,
      rows: this.visibleFindings,
      columns: [
        { label: "Severity", value: (f) => f.severity },
        { label: "Theme", value: (f) => f.theme },
        { label: "Finding", value: (f) => f.title },
        { label: "Element", value: (f) => f.element },
        { label: "Advice", value: (f) => f.advice }
      ]
    });
  }

  // ---------- Blocs dépliables ----------

  get blocks() {
    const r = this.result || {};
    const counts = {
      recordTypes: (r.recordTypes || []).length,
      layouts: r.toolingAvailable ? (r.layouts || []).length : null,
      assignments: r.assignmentsKnown ? (r.profiles || []).length : null,
      pages: r.pagesKnown ? (r.pages || []).length : null,
      compact:
        r.compactKnown || r.toolingAvailable
          ? (r.compactLayouts || []).length
          : null
    };
    return BLOCKS.map((block) => {
      const open = this.openBlocks.has(block.key);
      const count = counts[block.key];
      return {
        ...block,
        open,
        ariaExpanded: open ? "true" : "false",
        icon: open ? "utility:chevrondown" : "utility:chevronright",
        countText: count === null ? "not read" : String(count),
        isRecordTypes: block.key === "recordTypes",
        isLayouts: block.key === "layouts",
        isAssignments: block.key === "assignments",
        isPages: block.key === "pages",
        isCompact: block.key === "compact"
      };
    });
  }

  handleToggleBlock(event) {
    const key = event.currentTarget.dataset.key;
    const open = new Set(this.openBlocks);
    if (open.has(key)) {
      open.delete(key);
    } else {
      open.add(key);
    }
    this.openBlocks = open;
  }

  handleExportBlock(event) {
    const key = event.currentTarget.dataset.key;
    const definitions = {
      recordTypes: [this.recordTypeRows, this.recordTypeColumns],
      layouts: [this.layoutRows, this.layoutColumns],
      assignments: [this.matrixRows, this.matrixExportColumns],
      pages: [this.pageRows, this.pageColumns],
      compact: [this.compactRows, this.compactColumns]
    };
    const [rows, columns] = definitions[key] || [[], []];
    exportRows({
      name: `object-setup-${key}-${this._objectName}`,
      format: event.detail.format,
      rows,
      columns
    });
  }

  // Types d'enregistrement
  get recordTypeRows() {
    return (this.result?.recordTypes || []).map((t) => ({
      ...t,
      activeText: t.isActive ? "Active" : "Inactive",
      activeTone: t.isActive ? "good" : "neutral",
      recordsText: yesNo(t.hasRecords),
      layoutText: dash(t.layoutCount),
      mineText: t.defaultForMe
        ? "Default"
        : t.availableForMe
          ? "Available"
          : "—"
    }));
  }

  get recordTypeColumns() {
    return [
      { label: "Record type", value: (t) => t.name },
      { label: "API name", value: (t) => t.developerName },
      { label: "Active", value: (t) => !!t.isActive },
      { label: "Business process", value: (t) => t.businessProcess || "" },
      { label: "Has records", value: (t) => t.recordsText },
      { label: "Layouts assigned", value: (t) => t.layoutCount },
      { label: "For me", value: (t) => t.mineText },
      { label: "Description", value: (t) => t.description || "" }
    ];
  }

  get hasRecordTypes() {
    return this.recordTypeRows.length > 0;
  }

  // Présentations
  get layoutRows() {
    return (this.result?.layouts || []).map((l) => ({
      ...l,
      fieldsText: dash(l.fieldCount),
      sectionsText: dash(l.sectionCount),
      relatedText: dash(l.relatedListCount),
      profilesText:
        l.profileCount === null || l.profileCount === undefined
          ? "—"
          : `${l.profileCount} (${l.activeUserProfiles} with users)`,
      modifiedText: formatDate(l.lastModifiedDate),
      unassigned: l.assignmentCount === 0,
      url: `/lightning/setup/ObjectManager/${this._objectName}/PageLayouts/${l.id}/view`
    }));
  }

  get layoutColumns() {
    return [
      { label: "Layout", value: (l) => l.name },
      { label: "Namespace", value: (l) => l.namespacePrefix || "" },
      { label: "Fields", value: (l) => l.fieldCount },
      { label: "Sections", value: (l) => l.sectionCount },
      { label: "Related lists", value: (l) => l.relatedListCount },
      { label: "Assignments", value: (l) => l.assignmentCount },
      { label: "Profiles", value: (l) => l.profileCount },
      { label: "Profiles with users", value: (l) => l.activeUserProfiles },
      {
        label: "Last modified",
        value: (l) => formatExportDate(l.lastModifiedDate, false)
      },
      { label: "Modified by", value: (l) => l.lastModifiedBy || "" }
    ];
  }

  get hasLayouts() {
    return this.layoutRows.length > 0;
  }

  // Matrice profil × type d'enregistrement
  get matrixColumns() {
    const types = (this.result?.recordTypes || []).filter((t) => t.isActive);
    if (!types.length) {
      return [{ key: MASTER, label: "Master" }];
    }
    return types.map((t) => ({ key: t.id.substring(0, 15), label: t.name }));
  }

  get matrixRows() {
    const columns = this.matrixColumns;
    const tones = new Map();
    (this.result?.layouts || []).forEach((l, index) =>
      tones.set(l.name, index % LAYOUT_TONES)
    );
    return (this.result?.profiles || [])
      .filter((p) => !this.activeProfilesOnly || p.activeUsers > 0)
      .map((p) => ({
        ...p,
        cells: columns.map((c) => {
          const layout = (p.layoutByRecordType || {})[c.key];
          return {
            key: c.key,
            layout: layout || "—",
            className: layout
              ? `os-cell os-tone-${tones.get(layout) ?? 0}`
              : "os-cell"
          };
        })
      }));
  }

  get matrixExportColumns() {
    return [
      { label: "Profile", value: (p) => p.profileName },
      { label: "Active users", value: (p) => p.activeUsers },
      ...this.matrixColumns.map((c) => ({
        label: c.label,
        value: (p) => (p.layoutByRecordType || {})[c.key] || ""
      }))
    ];
  }

  get hasMatrix() {
    return this.matrixRows.length > 0;
  }

  get matrixCountText() {
    const all = (this.result?.profiles || []).length;
    return `${this.matrixRows.length} of ${all} profiles`;
  }

  handleActiveProfiles(event) {
    this.activeProfilesOnly = event.target.checked;
  }

  // Pages Lightning
  get pageRows() {
    return (this.result?.pages || []).map((p) => ({
      ...p,
      dynamicFormsText: p.detailsRead
        ? p.dynamicForms
          ? `Yes (${p.fieldCount} fields)`
          : p.usesRecordDetail
            ? "No (Record Detail)"
            : "No"
        : "Not read",
      dynamicFormsTone: p.dynamicForms ? "good" : "neutral",
      dynamicActionsText: p.detailsRead ? yesNo(p.dynamicActions) : "—",
      componentsText: p.detailsRead
        ? `${p.componentCount}${p.customComponentCount ? ` (${p.customComponentCount} custom)` : ""}`
        : "—",
      tabsText: p.detailsRead ? p.tabCount : "—",
      visibilityText: p.detailsRead ? p.visibilityRules : "—",
      modifiedText: formatDate(p.lastModifiedDate),
      url: `/visualEditor/appBuilder.app?id=${p.id}`
    }));
  }

  get pageColumns() {
    return [
      { label: "Lightning page", value: (p) => p.name },
      { label: "API name", value: (p) => p.developerName },
      { label: "Dynamic Forms", value: (p) => p.dynamicFormsText },
      { label: "Dynamic Actions", value: (p) => p.dynamicActionsText },
      { label: "Components", value: (p) => p.componentCount },
      { label: "Custom components", value: (p) => p.customComponentCount },
      { label: "Tabs", value: (p) => p.tabCount },
      { label: "Visibility rules", value: (p) => p.visibilityRules },
      { label: "Template", value: (p) => p.template || "" },
      {
        label: "Last modified",
        value: (p) => formatExportDate(p.lastModifiedDate, false)
      }
    ];
  }

  get hasPages() {
    return this.pageRows.length > 0;
  }

  // Présentations compactes
  get compactRows() {
    return (this.result?.compactLayouts || []).map((c) => ({
      ...c,
      defaultText: c.isDefault ? "Default" : "",
      recordTypesText: (c.recordTypes || []).join(", ") || "—",
      url: `/lightning/setup/ObjectManager/${this._objectName}/CompactLayouts/${c.id}/view`
    }));
  }

  get compactColumns() {
    return [
      { label: "Compact layout", value: (c) => c.name },
      { label: "API name", value: (c) => c.developerName },
      { label: "Default", value: (c) => !!c.isDefault },
      { label: "Record types", value: (c) => (c.recordTypes || []).join(", ") }
    ];
  }

  get hasCompact() {
    return this.compactRows.length > 0;
  }

  get defaultCompactText() {
    return this.result?.defaultCompactLayout
      ? `Default: ${this.result.defaultCompactLayout}`
      : "";
  }

  // ---------- Menu Data ----------

  async handleSaveFile() {
    try {
      const keys = await listKeys(SETUP_PREFIX);
      const objects = {};
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await loadValue(key, null);
        if (stored && stored.objectName) {
          objects[stored.objectName] = stored;
        }
      }
      if (!Object.keys(objects).length) {
        this.toast("Nothing to save", "No object setup analysis yet.", "info");
        return;
      }
      downloadJson(
        `org-intelligence-object-setup-${new Date().toISOString().substring(0, 10)}.json`,
        FILE_KIND,
        { objects }
      );
    } catch (error) {
      this.toast("The export failed", reduceErrors(error), "error");
    }
  }

  /** Fichier ouvert : pour chaque objet, la plus récente des deux analyses est gardée. */
  async handleOpenFile(event) {
    const envelope = event.detail.envelope;
    if (envelope && envelope.sameOrg === false) {
      const ok = await LightningConfirm.open({
        label: "File from another org",
        message: `This file was saved in ${envelope.orgName || "another org"}, not in this org. Open it anyway?`,
        theme: "warning"
      });
      if (!ok) {
        return;
      }
    }
    try {
      const objects = event.detail.data?.objects || {};
      let imported = 0;
      for (const name of Object.keys(objects)) {
        const incoming = objects[name];
        if (!incoming || !incoming.objectName || !incoming.analyzedAt) {
          continue;
        }
        const key = SETUP_PREFIX + incoming.objectName;
        // eslint-disable-next-line no-await-in-loop
        const stored = await loadValue(key, null);
        if (
          !stored ||
          new Date(incoming.analyzedAt) >= new Date(stored.analyzedAt)
        ) {
          // eslint-disable-next-line no-await-in-loop
          await saveValue(key, incoming);
          imported++;
        }
      }
      this.toast(
        "File opened",
        `${imported} object analysis(es) imported.`,
        "success"
      );
      await this.loadAnalyzedIndex();
      this.loadStored();
    } catch (error) {
      this.toast("The file could not be opened", reduceErrors(error), "error");
    }
  }

  async handleClearData() {
    try {
      const count = await clearAll(SETUP_PREFIX);
      this.toast("Analyses cleared", `${count} item(s) deleted.`, "success");
      this.result = null;
      this.analyzedObjects = {};
    } catch (error) {
      this.toast(
        "The analyses could not be cleared",
        reduceErrors(error),
        "error"
      );
    }
  }

  handleDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}

function summaryOf(result) {
  return {
    score: result.score,
    analyzedAt: result.analyzedAt,
    findings: (result.findings || []).length
  };
}

function scoreTone(score) {
  if (score === null || score === undefined) {
    return "";
  }
  if (score >= 85) {
    return "good";
  }
  return score >= 65 ? "warning" : "serious";
}
