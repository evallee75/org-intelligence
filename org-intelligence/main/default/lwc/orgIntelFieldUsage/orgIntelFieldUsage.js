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
  listKeys,
  loadValue,
  removeValue,
  saveValue,
  STORE_KEYS
} from "c/orgIntelStore";
import { LOCAL_MODE, sendRecommendations } from "c/orgIntelRecommendationStore";

// Actions Apex du module (via le contrôleur générique du socle) : lecture seule, aucune écriture
const getObjects = moduleAction("fieldUsage", "getObjects");
const prepareAnalysis = moduleAction("fieldUsage", "prepareAnalysis");
const scanChunk = moduleAction("fieldUsage", "scanChunk");
const finalizeAnalysis = moduleAction("fieldUsage", "finalizeAnalysis");

/** Stockage navigateur : index léger des analyses, analyses par objet, analyses interrompues. */
const INDEX_KEY = `${STORE_KEYS.FIELD_USAGE}.index`;
const OBJECT_PREFIX = `${STORE_KEYS.FIELD_USAGE}.object.`;
const PENDING_PREFIX = `${STORE_KEYS.FIELD_USAGE}.pending.`;
const FILE_KIND = "fieldUsage";
/** Analyses gardées par objet (une seule si elles deviennent lourdes). */
const KEEP_ANALYSES = 3;
const MAX_KEPT_SIZE = 400000;
/** Plafond des valeurs distinctes suivies par champ (aligné sur OrgFieldUsageService.DISTINCT_CAP). */
const DISTINCT_CAP = 25;
const MIN_CHUNK = 25;
const MAX_RETRIES = 4;
/** Sauvegarde de l'analyse en cours toutes les N tranches (reprise après fermeture de l'onglet). */
const SAVE_EVERY = 5;

/** Envoi vers les recommandations (alignés sur les règles FIELD_USAGE_* historiques). */
const RULE_BY_STATUS = {
  Unused: "FIELD_USAGE_UNUSED",
  "Empty on layout": "FIELD_USAGE_EMPTY_ON_LAYOUT",
  "Never filled": "FIELD_USAGE_NEVER_FILLED",
  Abandoned: "FIELD_USAGE_ABANDONED",
  "Low fill": "FIELD_USAGE_LOW_FILL",
  Constant: "FIELD_USAGE_CONSTANT",
  "Hidden but filled": "FIELD_USAGE_UNDOCUMENTED",
  Undocumented: "FIELD_USAGE_UNDOCUMENTED"
};
const SEVERITY_BY_STATUS = {
  Unused: "Medium",
  "Empty on layout": "Medium",
  "Never filled": "High",
  Abandoned: "Medium",
  "Low fill": "Low",
  Constant: "Low",
  "Hidden but filled": "Info",
  Undocumented: "Info"
};
const TITLE_BY_STATUS = {
  Unused: "Unused field",
  "Empty on layout": "Field shown on layouts but never filled",
  "Never filled": "Referenced field never filled",
  Abandoned: "Field no longer filled",
  "Low fill": "Field rarely filled",
  Constant: "Field always holding the same value",
  "Hidden but filled": "Field filled outside layouts, undocumented",
  Undocumented: "Field without description"
};

/**
 * Statuts d'utilisation d'un champ, du plus préoccupant au plus sain. À tenir alignés sur
 * OrgFieldUsageService (constantes STATUS_*). `issue` : à nettoyer, envoyable aux recommandations.
 */
const STATUSES = [
  {
    value: "Unused",
    tone: "critical",
    color: "var(--oi-critical)",
    issue: true,
    hint: "Never filled, on no layout, referenced nowhere."
  },
  {
    value: "Never filled",
    tone: "serious",
    color: "var(--oi-critical-strong)",
    issue: true,
    hint: "Referenced by automation or code but never filled."
  },
  {
    value: "Empty on layout",
    tone: "serious",
    color: "var(--oi-serious)",
    issue: true,
    hint: "Shown to users but never filled."
  },
  {
    value: "Abandoned",
    tone: "serious",
    color: "#c4501f",
    issue: true,
    hint: "Filled in the past, not on recent records."
  },
  {
    value: "Low fill",
    tone: "warning",
    color: "var(--oi-warning)",
    issue: true,
    hint: "Filled on less than 5% of records."
  },
  {
    value: "Constant",
    tone: "warning",
    color: "#d9a514",
    issue: true,
    hint: "Always the same value."
  },
  {
    value: "Hidden but filled",
    tone: "low",
    color: "var(--oi-low)",
    issue: true,
    hint: "Filled but on no layout: automation or integration."
  },
  {
    value: "Undocumented",
    tone: "low",
    color: "#7f9fd0",
    issue: true,
    hint: "Custom field used but without description."
  },
  {
    value: "New",
    tone: "info",
    color: "#7f56d9",
    hint: "Created recently: not judged."
  },
  {
    value: "Healthy",
    tone: "good",
    color: "var(--oi-good)",
    hint: "Filled and shown on layouts."
  },
  {
    value: "Calculated",
    tone: "neutral",
    color: "var(--oi-neutral)",
    hint: "Formula, roll-up, auto-number or system field."
  },
  {
    value: "No data",
    tone: "neutral",
    color: "var(--oi-border-strong)",
    hint: "The object has no record."
  }
];
const STATUS_BY_VALUE = new Map(
  STATUSES.map((s, i) => [s.value, { ...s, rank: i }])
);
const ATTENTION = "attention";

const TYPE_LABELS = {
  STRING: "Text",
  TEXTAREA: "Text area",
  PICKLIST: "Picklist",
  MULTIPICKLIST: "Multi-picklist",
  BOOLEAN: "Checkbox",
  REFERENCE: "Lookup",
  DATE: "Date",
  DATETIME: "Date/time",
  TIME: "Time",
  DOUBLE: "Number",
  INTEGER: "Number",
  LONG: "Number",
  CURRENCY: "Currency",
  PERCENT: "Percent",
  PHONE: "Phone",
  EMAIL: "Email",
  URL: "URL",
  COMBOBOX: "Combobox"
};

const RECENT_OPTIONS = [
  { label: "Recent = last 30 days", value: "30" },
  { label: "Recent = last 90 days", value: "90" },
  { label: "Recent = last 180 days", value: "180" },
  { label: "Recent = last 365 days", value: "365" }
];

const OBJECT_FILTERS = [
  { value: "all", label: "All" },
  { value: "analysed", label: "Analyzed" },
  { value: "custom", label: "Custom" }
];

function statusMeta(value) {
  return (
    STATUS_BY_VALUE.get(value) || {
      value,
      tone: "neutral",
      color: "var(--oi-neutral)",
      rank: 99
    }
  );
}

function percent(part, total) {
  if (!total) {
    return 0;
  }
  return Math.round((1000 * part) / total) / 10;
}

function parseDetails(json) {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

function scoreTone(score) {
  if (score === null || score === undefined) {
    return "neutral";
  }
  if (score >= 80) {
    return "good";
  }
  if (score >= 60) {
    return "warning";
  }
  if (score >= 40) {
    return "serious";
  }
  return "critical";
}

/** Ajoute les agrégats d'une tranche au cumul (mêmes règles que le comptage Apex). */
function mergeStats(total, chunk) {
  Object.keys(chunk || {}).forEach((name) => {
    const part = chunk[name] || {};
    const stat = total[name] || {
      filled: 0,
      recentFilled: 0,
      falseCount: 0,
      lastFilledAt: null,
      values: {},
      overflow: false
    };
    stat.filled += part.filled || 0;
    stat.recentFilled += part.recentFilled || 0;
    stat.falseCount += part.falseCount || 0;
    if (
      part.lastFilledAt &&
      (!stat.lastFilledAt ||
        new Date(part.lastFilledAt) > new Date(stat.lastFilledAt))
    ) {
      stat.lastFilledAt = part.lastFilledAt;
    }
    Object.keys(part.values || {}).forEach((key) => {
      if (stat.values[key] !== undefined) {
        stat.values[key] += part.values[key];
      } else if (Object.keys(stat.values).length <= DISTINCT_CAP) {
        stat.values[key] = part.values[key];
      } else {
        stat.overflow = true;
      }
    });
    stat.overflow = stat.overflow || !!part.overflow;
    total[name] = stat;
  });
  return total;
}

function isManagedField(apiName) {
  return /__c$/.test(apiName) && apiName.replace(/__c$/, "").includes("__");
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
 * Section « Objects & Fields » : choix d'un objet, analyse de ses champs (remplissage sur tous les
 * enregistrements, lus par tranches depuis le navigateur ; présentations, dépendances) et tableau
 * des champs avec statut et recommandation. Résultats gardés dans ce navigateur uniquement.
 */
export default class OrgIntelFieldUsage extends LightningElement {
  /** Modules installés (fournis par la coquille). */
  @api modules = [];
  objects = [];
  objectsError;
  isLoadingObjects = true;
  objectSearch = "";
  objectFilter = "all";
  selectedObject = null;

  /** Index léger des analyses gardées : objet → { completedAt, score, recordCount… }. */
  index = {};
  /** Analyses gardées de l'objet choisi (la plus récente d'abord) et analyse affichée. */
  analyses = [];
  view;
  viewError;
  isLoadingView = false;
  /** Analyse en cours (un seul objet à la fois) et analyse interrompue de l'objet choisi. */
  run = null;
  pending = null;
  stopRequested = false;
  isSending = false;
  recentDays = "90";

  search = "";
  statusFilter = ATTENTION;
  customOnly = false;
  hideCalculated = true;
  sortBy = "status";
  sortDirection = "asc";
  expandedId = null;
  selectedIds = new Set();

  recentOptions = RECENT_OPTIONS;

  /** Toujours possible : module Recommendations s'il est installé, sinon recommandations locales. */
  get canSendToRecommendations() {
    return true;
  }

  connectedCallback() {
    this.loadObjects();
  }

  disconnectedCallback() {
    // L'analyse en cours s'arrête proprement ; elle reste reprenable
    this.stopRequested = true;
  }

  // ---------- Objets ----------

  async loadObjects() {
    try {
      const [objects, index] = await Promise.all([
        getObjects(),
        loadValue(INDEX_KEY, {})
      ]);
      this.objects = objects || [];
      this.index = index || {};
      this.objectsError = undefined;
      if (!this.selectedObject) {
        const latest = Object.values(this.index).sort(
          (a, b) => new Date(b.completedAt) - new Date(a.completedAt)
        )[0];
        const first =
          (latest &&
            this.objects.find((o) => o.apiName === latest.objectName)) ||
          this.objects.find((o) => o.apiName === "Account") ||
          this.objects[0];
        if (first) {
          this.selectObject(first.apiName);
        }
      }
    } catch (error) {
      this.objectsError = error;
    } finally {
      this.isLoadingObjects = false;
    }
  }

  get objectFilters() {
    return OBJECT_FILTERS.map((filter) => ({
      ...filter,
      pressed: filter.value === this.objectFilter ? "true" : "false",
      className: `chip${filter.value === this.objectFilter ? " chip-selected" : ""}`
    }));
  }

  /** Objets de l'org, complétés par l'index des analyses gardées dans le navigateur. */
  get objectSummaries() {
    return this.objects.map((o) => {
      const entry = this.index[o.apiName];
      return {
        ...o,
        analysed: !!entry,
        analysedAt: entry?.completedAt,
        recordCount: entry?.recordCount,
        fieldCount: entry?.fieldCount,
        issueCount: entry?.issueCount,
        unusedCount: entry?.unusedCount,
        score: entry?.score
      };
    });
  }

  get objectItems() {
    const term = this.objectSearch.trim().toLowerCase();
    const runningObject = this.isAnyRunning ? this.run.objectName : null;
    return this.objectSummaries
      .filter(
        (o) =>
          (this.objectFilter !== "analysed" || o.analysed) &&
          (this.objectFilter !== "custom" || o.isCustom) &&
          (!term ||
            o.apiName.toLowerCase().includes(term) ||
            (o.label || "").toLowerCase().includes(term))
      )
      .sort(
        (a, b) =>
          (b.analysed ? 1 : 0) - (a.analysed ? 1 : 0) ||
          (b.recordCount || 0) - (a.recordCount || 0) ||
          (a.label || "").localeCompare(b.label || "")
      )
      .slice(0, 300)
      .map((o) => {
        const selected = o.apiName === this.selectedObject;
        const parts = [];
        if (o.recordCount !== null && o.recordCount !== undefined) {
          parts.push(`${formatNumber(o.recordCount)} records`);
        }
        if (o.apiName === runningObject) {
          parts.push("analyzing…");
        } else if (o.analysed) {
          parts.push(formatRelative(o.analysedAt));
        }
        const hasScore = o.score !== null && o.score !== undefined;
        return {
          ...o,
          meta: parts.join(" · ") || "Not analyzed",
          hasScore,
          scoreClass: `score-pill tone-${scoreTone(o.score)}`,
          scoreTitle: `Usage score ${o.score}/100 — ${o.issueCount || 0} field(s) to clean up`,
          className: `object${selected ? " object-selected" : ""}`,
          current: selected ? "true" : "false"
        };
      });
  }

  get hasObjectItems() {
    return this.objectItems.length > 0;
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
    this.selectedObject = name;
    this.analyses = [];
    this.view = undefined;
    this.viewError = undefined;
    this.pending = null;
    this.expandedId = null;
    this.selectedIds = new Set();
    this.statusFilter = ATTENTION;
    this.loadView();
  }

  get selectedSummary() {
    return this.objectSummaries.find((o) => o.apiName === this.selectedObject);
  }

  // ---------- Analyses gardées ----------

  async loadView(analysisId = null) {
    if (!this.selectedObject) {
      return;
    }
    const objectName = this.selectedObject;
    this.isLoadingView = !this.view;
    try {
      const [stored, pending] = await Promise.all([
        loadValue(OBJECT_PREFIX + objectName, null),
        loadValue(PENDING_PREFIX + objectName, null)
      ]);
      if (objectName !== this.selectedObject) {
        return;
      }
      this.analyses = (stored && stored.analyses) || [];
      this.view =
        this.analyses.find((a) => a.id === analysisId) || this.analyses[0];
      this.pending = pending;
      this.viewError = undefined;
    } catch (error) {
      this.viewError = error;
    } finally {
      this.isLoadingView = false;
    }
  }

  handleRecentDays(event) {
    this.recentDays = event.detail.value;
  }

  handleRefresh() {
    this.loadObjects();
    this.loadView(this.view?.id);
  }

  handleHistory(event) {
    this.expandedId = null;
    this.selectedIds = new Set();
    this.view = this.analyses.find((a) => a.id === event.detail.value);
  }

  // ---------- Analyse pilotée par le navigateur ----------

  async handleAnalyze() {
    if (this.isAnyRunning) {
      return;
    }
    const objectName = this.selectedObject;
    this.stopRequested = false;
    this.run = { objectName, state: "preparing", recordCount: 0 };
    try {
      const prepared = await prepareAnalysis({
        objectName,
        recentDays: Number(this.recentDays)
      });
      this.run = {
        objectName,
        state: "running",
        prepared,
        lastId: null,
        recordCount: 0,
        recentCount: 0,
        stats: {},
        chunkSize: prepared.chunkSize,
        chunks: 0
      };
      await removeValue(PENDING_PREFIX + objectName);
      if (objectName === this.selectedObject) {
        this.pending = null;
      }
      await this.runLoop();
    } catch (error) {
      this.run = null;
      this.toast(
        "The analysis could not be started",
        reduceErrors(error),
        "error"
      );
    }
  }

  async handleResume() {
    if (this.isAnyRunning || !this.pending) {
      return;
    }
    this.stopRequested = false;
    this.run = { ...this.pending, state: "running" };
    this.pending = null;
    await this.runLoop();
  }

  async handleDiscardPending() {
    await removeValue(PENDING_PREFIX + this.selectedObject);
    this.pending = null;
  }

  handleStop() {
    this.stopRequested = true;
  }

  /** Lit les tranches une à une, cumule les agrégats, puis calcule les statuts. */
  async runLoop() {
    const objectName = this.run.objectName;
    let retries = 0;
    let done = false;
    while (!this.stopRequested && !done) {
      const run = this.run;
      let chunk;
      try {
        // eslint-disable-next-line no-await-in-loop
        chunk = await scanChunk({
          objectName,
          fields: run.prepared.fields,
          lastId: run.lastId,
          chunkSize: run.chunkSize,
          recentSince: run.prepared.recentSince
        });
        retries = 0;
      } catch (error) {
        // Limites (tas, CPU) : tranche plus petite, puis abandon reprenable
        if (retries < MAX_RETRIES && run.chunkSize > MIN_CHUNK) {
          retries++;
          this.run = {
            ...run,
            chunkSize: Math.max(MIN_CHUNK, Math.floor(run.chunkSize / 2))
          };
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await this.savePending({ ...run, error: reduceErrors(error) });
        this.run = null;
        this.toast(
          "The analysis stopped",
          `${reduceErrors(error)} You can resume it later.`,
          "error"
        );
        return;
      }
      const next = {
        ...run,
        stats: mergeStats(run.stats, chunk.stats),
        recordCount: run.recordCount + (chunk.records || 0),
        recentCount: run.recentCount + (chunk.recent || 0),
        lastId: chunk.lastId || run.lastId,
        chunks: (run.chunks || 0) + 1
      };
      this.run = next;
      done = !!chunk.done;
      if (!done && next.chunks % SAVE_EVERY === 0) {
        // eslint-disable-next-line no-await-in-loop
        await this.savePending(next);
      }
    }
    if (!done) {
      await this.savePending(this.run);
      this.run = null;
      return;
    }
    await this.completeRun();
  }

  async savePending(run) {
    const pending = {
      objectName: run.objectName,
      prepared: run.prepared,
      lastId: run.lastId,
      recordCount: run.recordCount,
      recentCount: run.recentCount,
      stats: run.stats,
      chunkSize: run.chunkSize,
      chunks: run.chunks,
      savedAt: new Date().toISOString(),
      error: run.error
    };
    try {
      await saveValue(PENDING_PREFIX + run.objectName, pending);
    } catch {
      // stockage plein : l'analyse ne pourra pas être reprise après fermeture de l'onglet
    }
    if (run.objectName === this.selectedObject) {
      this.pending = pending;
    }
  }

  async completeRun() {
    const run = this.run;
    const prepared = run.prepared;
    this.run = { ...run, state: "finalizing" };
    try {
      const result = await finalizeAnalysis({
        objectName: run.objectName,
        recentDays: prepared.recentDays,
        recordCount: run.recordCount,
        recentCount: run.recentCount,
        stats: run.stats,
        meta: prepared.meta
      });
      const meta = prepared.meta || {};
      const completedAt = new Date().toISOString();
      const analysis = {
        id: String(Date.now()),
        name: formatDateTime(completedAt),
        objectName: run.objectName,
        objectLabel: prepared.objectLabel,
        status: "Completed",
        recordCount: run.recordCount,
        recentRecordCount: run.recentCount,
        recentDays: prepared.recentDays,
        fieldCount: (result.fields || []).length,
        layoutCount: meta.layoutsKnown ? meta.layoutCount : null,
        startedAt: prepared.startedAt,
        completedAt,
        toolingAvailable: !!meta.toolingAvailable,
        message: (meta.notes || []).join("\n") || null,
        orgDomainUrl: prepared.orgDomainUrl,
        score: result.score,
        issueCount: result.issueCount,
        unusedCount: result.unusedCount,
        statusCounts: result.statusCounts,
        fields: result.fields || []
      };
      await this.storeAnalysis(analysis);
      await removeValue(PENDING_PREFIX + run.objectName);
      this.run = null;
      if (run.objectName === this.selectedObject) {
        this.expandedId = null;
        this.selectedIds = new Set();
        this.pending = null;
        await this.loadView(analysis.id);
      }
      this.toast(
        "Analysis completed",
        `${prepared.objectLabel}: ${formatNumber(run.recordCount)} records, ${analysis.fieldCount} fields.`,
        "success"
      );
    } catch (error) {
      await this.savePending(run);
      this.run = null;
      this.toast(
        "The analysis could not be completed",
        reduceErrors(error),
        "error"
      );
    }
  }

  /** Garde l'analyse (3 par objet si léger, sinon 1) et met à jour l'index. */
  async storeAnalysis(analysis) {
    const key = OBJECT_PREFIX + analysis.objectName;
    const stored = (await loadValue(key, null)) || { analyses: [] };
    let analyses = [analysis, ...(stored.analyses || [])].slice(
      0,
      KEEP_ANALYSES
    );
    if (JSON.stringify(analyses).length > MAX_KEPT_SIZE) {
      analyses = [analysis];
    }
    try {
      await saveValue(key, { analyses });
    } catch (error) {
      if (analyses.length === 1) {
        throw error;
      }
      await saveValue(key, { analyses: [analysis] });
    }
    await this.updateIndex(analysis);
  }

  async updateIndex(analysis) {
    const index = (await loadValue(INDEX_KEY, {})) || {};
    index[analysis.objectName] = {
      objectName: analysis.objectName,
      objectLabel: analysis.objectLabel,
      completedAt: analysis.completedAt,
      score: analysis.score,
      fieldCount: analysis.fieldCount,
      recordCount: analysis.recordCount,
      issueCount: analysis.issueCount,
      unusedCount: analysis.unusedCount
    };
    await saveValue(INDEX_KEY, index);
    this.index = index;
  }

  get hasView() {
    return !!this.selectedObject;
  }

  get hasAnalysis() {
    return !!this.view;
  }

  get noAnalysis() {
    return !this.view && !this.isRunning && !this.hasPending;
  }

  get isAnyRunning() {
    return !!this.run;
  }

  /** Analyse en cours sur l'objet affiché. */
  get isRunning() {
    return !!this.run && this.run.objectName === this.selectedObject;
  }

  get runningElsewhere() {
    return this.isAnyRunning && !this.isRunning;
  }

  get hasPending() {
    return !!this.pending && !this.isRunning;
  }

  get pendingText() {
    const p = this.pending;
    if (!p) {
      return "";
    }
    return `Analysis interrupted after ${formatNumber(p.recordCount)} records (${formatRelative(p.savedAt)}).${p.error ? ` ${p.error}` : ""}`;
  }

  get isFailed() {
    return false;
  }

  get isCompleted() {
    return !!this.view;
  }

  get analyzeLabel() {
    return this.hasAnalysis ? "Run again" : "Run analysis";
  }

  get analyzeDisabled() {
    return this.isAnyRunning;
  }

  get analyzeTitle() {
    return this.runningElsewhere
      ? `An analysis of ${this.run.objectName} is running`
      : "";
  }

  get stopDisabled() {
    return this.stopRequested || this.run?.state !== "running";
  }

  get objectTitle() {
    return (
      this.view?.objectLabel ||
      this.selectedSummary?.label ||
      this.selectedObject
    );
  }

  get objectSubtitle() {
    const parts = [this.selectedObject];
    if (this.isCompleted) {
      parts.push(
        `analyzed ${formatRelative(this.view.completedAt)}`,
        `recent = last ${this.view.recentDays} days`
      );
    }
    return parts.join(" · ");
  }

  get runPercent() {
    const run = this.run;
    const total = run?.prepared?.estimatedCount;
    if (!run || run.state === "preparing") {
      return 2;
    }
    if (run.state === "finalizing") {
      return 100;
    }
    if (!total || run.prepared.countCapped) {
      return null;
    }
    return Math.min(99, Math.round((100 * run.recordCount) / total));
  }

  get progressStyle() {
    const value = this.runPercent;
    return `width:${value === null ? 50 : value}%`;
  }

  get progressClass() {
    return `progress-value${this.runPercent === null ? " progress-indeterminate" : ""}`;
  }

  get progressText() {
    const run = this.run;
    if (!run) {
      return "";
    }
    if (run.state === "preparing") {
      return "Reading layouts, field definitions and dependencies…";
    }
    if (run.state === "finalizing") {
      return "Computing field statuses…";
    }
    const total = run.prepared?.estimatedCount;
    const of =
      total !== null && total !== undefined
        ? ` of ${formatNumber(total)}${run.prepared.countCapped ? "+" : ""}`
        : "";
    const value = this.runPercent;
    return `${value === null ? "" : `${value}% — `}${formatNumber(run.recordCount)}${of} records read${this.stopRequested ? " · stopping…" : ""}`;
  }

  get historyOptions() {
    return this.analyses.map((item) => ({
      label: `${formatDateTime(item.completedAt)}${item.score !== null && item.score !== undefined ? ` · score ${item.score}` : ""}`,
      value: item.id
    }));
  }

  get hasHistory() {
    return this.historyOptions.length > 1;
  }

  get currentAnalysisId() {
    return this.view?.id;
  }

  get notes() {
    return this.view?.message;
  }

  get toolingMissing() {
    return this.isCompleted && !this.view.toolingAvailable;
  }

  // ---------- Export / import des analyses (partage entre administrateurs) ----------

  async handleExportJson() {
    try {
      const keys = await listKeys(OBJECT_PREFIX);
      const objects = {};
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await loadValue(key, null);
        if (stored && stored.analyses) {
          objects[key.substring(OBJECT_PREFIX.length)] = stored;
        }
      }
      if (!Object.keys(objects).length) {
        this.toast("Nothing to save", "No analysis is stored yet.", "info");
        return;
      }
      downloadJson(
        `org-intelligence-objects-fields-${new Date().toISOString().substring(0, 10)}.json`,
        FILE_KIND,
        { objects }
      );
    } catch (error) {
      this.toast("The export failed", reduceErrors(error), "error");
    }
  }

  handleDataError(event) {
    this.toast("The file could not be opened", event.detail.message, "error");
  }

  /** Efface toutes les analyses d'objets gardées dans ce navigateur (confirmé par le menu Data). */
  async handleClearData() {
    try {
      // Analyses de champs seulement : Object Setup (fieldUsage.setup*) a son propre menu Data
      const counts = await Promise.all([
        clearAll(OBJECT_PREFIX),
        clearAll(PENDING_PREFIX),
        clearAll(INDEX_KEY)
      ]);
      const count = counts.reduce((sum, n) => sum + (n || 0), 0);
      this.toast("Analyses cleared", `${count} item(s) deleted.`, "success");
      this.handleRefresh();
    } catch (error) {
      this.toast(
        "The analyses could not be cleared",
        reduceErrors(error),
        "error"
      );
    }
  }

  /**
   * Fichier ouvert par le menu Data : les analyses sont réunies par objet (dédoublonnées par
   * identifiant), les plus récentes d'abord ; la plus récente devient celle affichée.
   */
  async handleDataOpen(event) {
    if (!(await confirmOtherOrg(event.detail.envelope))) {
      return;
    }
    try {
      const data = event.detail.data;
      const objects = (data && data.objects) || {};
      let imported = 0;
      for (const objectName of Object.keys(objects)) {
        const incoming = (objects[objectName].analyses || []).filter(
          (a) => a && a.id && a.completedAt && Array.isArray(a.fields)
        );
        if (!incoming.length) {
          continue;
        }
        const key = OBJECT_PREFIX + objectName;
        // eslint-disable-next-line no-await-in-loop
        const stored = (await loadValue(key, null)) || { analyses: [] };
        const byId = new Map();
        [...(stored.analyses || []), ...incoming].forEach((a) =>
          byId.set(a.id, a)
        );
        let analyses = [...byId.values()]
          .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
          .slice(0, KEEP_ANALYSES);
        if (JSON.stringify(analyses).length > MAX_KEPT_SIZE) {
          analyses = analyses.slice(0, 1);
        }
        // eslint-disable-next-line no-await-in-loop
        await saveValue(key, { analyses });
        // eslint-disable-next-line no-await-in-loop
        await this.updateIndex(analyses[0]);
        imported += incoming.length;
      }
      this.toast("File opened", `${imported} analysis(es) added.`, "success");
      await this.loadView(this.view?.id);
    } catch (error) {
      this.toast("The file could not be opened", reduceErrors(error), "error");
    }
  }

  // ---------- Champs ----------

  get fields() {
    const total = this.view?.recordCount || 0;
    const recentTotal = this.view?.recentRecordCount || 0;
    return (this.view?.fields || []).map((field) => {
      const details = field.details || parseDetails(field.detailsJson);
      const meta = statusMeta(field.status);
      const fill = percent(field.filled, total);
      const recentFill = percent(field.recentFilled, recentTotal);
      const olderFill = details.olderFillPercent;
      return { ...field, details, meta, fill, recentFill, olderFill };
    });
  }

  get relevantFields() {
    return this.fields.filter(
      (f) => !this.hideCalculated || f.status !== "Calculated"
    );
  }

  get kpis() {
    const fields = this.fields;
    const judged = fields.filter(
      (f) => !f.isCalculated && f.status !== "No data"
    );
    const average = judged.length
      ? Math.round(judged.reduce((sum, f) => sum + f.fill, 0) / judged.length)
      : 0;
    const count = (status) => fields.filter((f) => f.status === status).length;
    const hidden = this.view?.layoutCount
      ? judged.filter((f) => !f.onLayout).length
      : null;
    return [
      {
        key: "records",
        label: "Records",
        value: formatNumber(this.view?.recordCount),
        caption: `${formatNumber(this.view?.recentRecordCount)} in ${this.view?.recentDays} d`,
        title: `${formatNumber(this.view?.recentRecordCount)} records created in the last ${this.view?.recentDays} days`
      },
      {
        key: "fields",
        label: "Fields analyzed",
        value: formatNumber(fields.length),
        caption: `${fields.filter((f) => f.isCustom).length} custom · ${fields.length - judged.length} calculated`,
        title: "Show all fields",
        filter: ""
      },
      {
        key: "fill",
        label: "Average completeness",
        value: `${average}%`,
        caption: "fillable fields",
        title: "Average fill rate of the fields users or automation can fill"
      },
      {
        key: "unused",
        label: "Unused",
        value: formatNumber(count("Unused")),
        caption: "to delete",
        title:
          "Never filled, on no layout, referenced nowhere: candidates for deletion",
        tone: "critical",
        filter: "Unused"
      },
      {
        key: "empty",
        label: "Empty on layout",
        value: formatNumber(count("Empty on layout")),
        caption: "never filled",
        title: "Shown on a layout but never filled",
        tone: "serious",
        filter: "Empty on layout"
      },
      {
        key: "low",
        label: "Low fill",
        value: formatNumber(count("Low fill")),
        caption: "< 5% filled",
        title: "Filled on less than 5% of records",
        tone: "warning",
        filter: "Low fill"
      },
      {
        key: "abandoned",
        label: "Abandoned",
        value: formatNumber(count("Abandoned")),
        caption: `none in ${this.view?.recentDays} d`,
        title: `Filled in the past, not on records created in the last ${this.view?.recentDays} days`,
        tone: "serious",
        filter: "Abandoned"
      },
      {
        key: "nolayout",
        label: "On no layout",
        value: hidden === null ? "—" : formatNumber(hidden),
        caption: hidden === null ? "layouts not read" : `of ${judged.length}`,
        title:
          hidden === null
            ? "Layouts were not read (Tooling API)"
            : `Fields on no layout, out of ${judged.length} fillable fields`,
        tone: "low"
      }
    ].map((kpi) => {
      // Un filtre vide ("") est valide : il affiche tous les champs
      const isFilter = kpi.filter !== undefined;
      const active = isFilter && kpi.filter === this.statusFilter;
      return {
        ...kpi,
        isFilter,
        title: kpi.title || (isFilter ? "Show these fields" : ""),
        pressed: active ? "true" : "false",
        className: `kpi${kpi.tone ? ` kpi-${kpi.tone}` : ""}${active ? " kpi-active" : ""}`
      };
    });
  }

  get score() {
    return this.view?.score;
  }

  get hasScore() {
    return this.score !== null && this.score !== undefined;
  }

  /** Anneau du score (SVG) : circonférence 2πr avec r = 26. */
  get scoreRing() {
    const circumference = 2 * Math.PI * 26;
    const value = Math.max(0, Math.min(100, this.score || 0));
    return {
      dash: `${(circumference * value) / 100} ${circumference}`,
      className: `ring-value ring-${scoreTone(this.score)}`
    };
  }

  get scoreLabel() {
    const tone = scoreTone(this.score);
    return {
      good: "Fields well used",
      warning: "Some clean-up to do",
      serious: "Many unused fields",
      critical: "Heavy clean-up needed",
      neutral: "Not scored"
    }[tone];
  }

  /** Répartition des champs par statut : barre empilée et légende cliquables. */
  get distribution() {
    const fields = this.relevantFields;
    const total = fields.length || 1;
    return STATUSES.map((status) => {
      const count = fields.filter((f) => f.status === status.value).length;
      const selected = this.statusFilter === status.value;
      return {
        ...status,
        count,
        width: `width:${(100 * count) / total}%;background:${status.color}`,
        dot: `background:${status.color}`,
        title: `${status.value}: ${count} field(s) — ${status.hint}`,
        segmentClass: `segment${selected ? " segment-selected" : ""}`,
        legendClass: `legend-item${selected ? " legend-selected" : ""}`,
        pressed: selected ? "true" : "false"
      };
    }).filter((item) => item.count > 0);
  }

  handleStatusPick(event) {
    const value = event.currentTarget.dataset.value;
    this.statusFilter = this.statusFilter === value ? "" : value;
    this.expandedId = null;
  }

  get statusOptions() {
    return [
      { label: "Needs attention", value: ATTENTION },
      { label: "All fields", value: "" },
      ...STATUSES.map((s) => ({ label: s.value, value: s.value }))
    ];
  }

  handleStatusFilter(event) {
    this.statusFilter = event.detail.value;
    this.expandedId = null;
  }

  handleSearch(event) {
    this.search = event.target.value || "";
  }

  handleCustomOnly(event) {
    this.customOnly = event.target.checked;
  }

  handleHideCalculated(event) {
    this.hideCalculated = event.target.checked;
  }

  get filteredFields() {
    const term = this.search.trim().toLowerCase();
    const filter = this.statusFilter;
    return this.relevantFields.filter(
      (f) =>
        (!this.customOnly || f.isCustom) &&
        (!filter ||
          (filter === ATTENTION
            ? f.meta.issue && f.meta.tone !== "low"
            : f.status === filter)) &&
        (!term ||
          f.apiName.toLowerCase().includes(term) ||
          (f.label || "").toLowerCase().includes(term))
    );
  }

  get sortedFields() {
    const direction = this.sortDirection === "asc" ? 1 : -1;
    const value = {
      label: (f) => (f.label || "").toLowerCase(),
      type: (f) => f.dataType || "",
      fill: (f) => f.fill,
      recent: (f) => f.recentFill,
      layouts: (f) => f.layoutCount ?? -1,
      dependencies: (f) => f.dependencyCount ?? -1,
      lastFilled: (f) => {
        return f.lastFilledAt ? new Date(f.lastFilledAt).getTime() : 0;
      },
      status: (f) => f.meta.rank
    }[this.sortBy];
    return [...this.filteredFields].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x < y) {
        return -direction;
      }
      if (x > y) {
        return direction;
      }
      return (a.label || "").localeCompare(b.label || "");
    });
  }

  get rows() {
    const recentDays = this.view?.recentDays;
    return this.sortedFields.map((f) => {
      const expanded = f.id === this.expandedId;
      const fillTone =
        f.isCalculated || f.status === "No data"
          ? "neutral"
          : f.fill >= 60
            ? "good"
            : f.fill >= 20
              ? "warning"
              : f.fill > 0
                ? "serious"
                : "critical";
      let trend = { text: "—", className: "trend", title: "" };
      if (!f.isCalculated && this.view?.recentRecordCount > 0) {
        const older = f.olderFill;
        const delta =
          older === null || older === undefined ? 0 : f.recentFill - older;
        if (f.status === "Abandoned") {
          trend = {
            text: "Stopped",
            className: "trend trend-down",
            title: `0% of records created in the last ${recentDays} days (was ${older}%)`
          };
        } else {
          trend = {
            text: `${delta > 5 ? "↑" : delta < -5 ? "↓" : "→"} ${f.recentFill}%`,
            className: `trend${delta > 5 ? " trend-up" : delta < -5 ? " trend-down" : ""}`,
            title: `${f.recentFill}% of records created in the last ${recentDays} days${older !== null && older !== undefined ? ` (older records: ${older}%)` : ""}`
          };
        }
      }
      const layouts = f.details.layouts || [];
      const dependencies = f.details.dependencies || [];
      const selectable = f.meta.issue && f.isCustom && !f.details.managed;
      return {
        ...f,
        key: f.id,
        detailKey: `${f.id}-detail`,
        expanded,
        rowClass: `row${expanded ? " row-expanded" : ""}`,
        ariaExpanded: expanded ? "true" : "false",
        toggleIcon: expanded ? "utility:chevrondown" : "utility:chevronright",
        toggleLabel: expanded ? "Collapse" : "Expand",
        fieldTitle: `${f.label} · ${f.apiName} · ${TYPE_LABELS[f.dataType] || f.dataType}`,
        typeLabel: TYPE_LABELS[f.dataType] || f.dataType,
        originLabel: f.details.managed
          ? "Package"
          : f.isCustom
            ? "Custom"
            : "Standard",
        originClass: `origin${f.details.managed ? " origin-package" : f.isCustom ? " origin-custom" : ""}`,
        fillText: f.isCalculated ? "—" : `${f.fill}%`,
        fillStyle: `width:${f.isCalculated ? 0 : Math.max(f.fill, f.fill > 0 ? 2 : 0)}%`,
        fillClass: `bar-value bar-${fillTone}`,
        fillTitle: `${formatNumber(f.filled)} of ${formatNumber(this.view?.recordCount)} records${f.details.falseCount !== null && f.details.falseCount !== undefined ? ` checked (${formatNumber(f.details.falseCount)} unchecked)` : " filled"}`,
        trend,
        layoutText:
          f.layoutCount === null || f.layoutCount === undefined
            ? "?"
            : String(f.layoutCount),
        layoutClass: `count${f.layoutCount ? " count-on" : f.layoutCount === 0 ? " count-off" : ""}`,
        layoutTitle: layouts.length
          ? layouts.join("\n")
          : f.layoutCount === 0
            ? "On no layout"
            : "Layouts not read",
        dependencyText:
          f.dependencyCount === null || f.dependencyCount === undefined
            ? "—"
            : String(f.dependencyCount),
        dependencyTitle: dependencies.length
          ? dependencies.map((d) => `${d.type}: ${d.name}`).join("\n")
          : f.isCustom
            ? "Referenced nowhere"
            : "Dependencies are only read for custom fields",
        lastFilledText: f.lastFilledAt
          ? formatRelative(f.lastFilledAt)
          : "Never",
        lastFilledTitle: f.lastFilledAt
          ? `Last record modified with a value: ${formatDateTime(f.lastFilledAt)}`
          : "",
        recommendation: f.details.recommendation,
        selectable,
        checked: this.selectedIds.has(f.id),
        checkLabel: `Select ${f.label}`
      };
    });
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  /** Aide du tableau (remplace la ligne d'explication affichée auparavant). */
  get tableHelp() {
    return this.canSendToRecommendations
      ? "Click a row for details. Tick custom fields to clean up, then send them to Recommendations (Data Model domain)."
      : "Click a row for details.";
  }

  get rowCountText() {
    const shown = this.rows.length;
    const total = this.relevantFields.length;
    return shown === total
      ? `${shown} field${shown === 1 ? "" : "s"}`
      : `${shown} of ${total} fields`;
  }

  get columns() {
    return [
      { key: "label", label: "Field", hint: "Sort by label" },
      {
        key: "fill",
        label: "Fill rate",
        hint: "Share of all records where the field is filled"
      },
      {
        key: "recent",
        label: "Recent",
        hint: "Fill rate on the records created in the recent period, with the trend"
      },
      {
        key: "layouts",
        label: "Layouts",
        hint: "Number of page layouts showing the field"
      },
      {
        key: "dependencies",
        label: "Used by",
        hint: "Flows, Apex, validation rules and reports referencing the field"
      },
      {
        key: "lastFilled",
        label: "Last filled",
        hint: "Last record modified with a value"
      },
      {
        key: "status",
        label: "Status",
        hint: "Hover a status to read the recommendation"
      }
    ].map((column) => {
      const sorted = column.key === this.sortBy;
      return {
        ...column,
        ariaSort: sorted
          ? this.sortDirection === "asc"
            ? "ascending"
            : "descending"
          : "none",
        arrow: sorted ? (this.sortDirection === "asc" ? "▲" : "▼") : "",
        className: `th-button${sorted ? " th-sorted" : ""}`
      };
    });
  }

  handleSort(event) {
    const key = event.currentTarget.dataset.key;
    if (this.sortBy === key) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortBy = key;
      this.sortDirection = [
        "fill",
        "recent",
        "layouts",
        "dependencies",
        "lastFilled"
      ].includes(key)
        ? "desc"
        : "asc";
    }
  }

  handleToggleRow(event) {
    const id = event.currentTarget.dataset.id;
    this.expandedId = this.expandedId === id ? null : id;
  }

  handleRowKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleToggleRow(event);
    }
  }

  stopPropagation(event) {
    event.stopPropagation();
  }

  // ---------- Détail d'un champ ----------

  get expanded() {
    const field = this.fields.find((f) => f.id === this.expandedId);
    if (!field) {
      return null;
    }
    const details = field.details;
    const values = details.topValues || [];
    const max = Math.max(1, ...values.map((v) => v.count));
    const base =
      field.dataType === "BOOLEAN" ? this.view?.recordCount : field.filled;
    const facts = [
      { key: "api", label: "API name", value: field.apiName },
      {
        key: "type",
        label: "Type",
        value: TYPE_LABELS[field.dataType] || field.dataType
      },
      details.length
        ? { key: "length", label: "Length", value: details.length }
        : null,
      details.referenceTo
        ? { key: "ref", label: "Points to", value: details.referenceTo }
        : null,
      details.picklistValueCount
        ? {
            key: "pick",
            label: "Picklist values",
            value: `${details.picklistValueCount} defined`
          }
        : null,
      {
        key: "distinct",
        label: "Distinct values",
        value: details.distinctOverflow ? "More than 25" : field.distinctCount
      },
      field.fieldCreatedDate
        ? {
            key: "created",
            label: "Field created",
            value: formatDate(field.fieldCreatedDate)
          }
        : null,
      {
        key: "required",
        label: "Required",
        value: field.isRequired ? "Yes" : "No"
      }
    ]
      .filter(Boolean)
      .map((fact) => ({ ...fact, valueKey: `${fact.key}-value` }));
    return {
      ...field,
      facts,
      description: details.description,
      helpText: details.helpText,
      hasDescription: !!details.description,
      hasHelpText: !!details.helpText,
      recommendation: details.recommendation,
      values: values.map((v) => ({
        key: v.value,
        label:
          v.value === "true"
            ? "Checked"
            : v.value === "false"
              ? "Unchecked"
              : v.value,
        count: formatNumber(v.count),
        share: `${percent(v.count, base)}%`,
        style: `width:${(100 * v.count) / max}%`
      })),
      hasValues: values.length > 0,
      layouts: (details.layouts || []).map((name) => ({ key: name, name })),
      hasLayouts: (details.layouts || []).length > 0,
      layoutsText: details.layoutsKnown
        ? "On no layout."
        : "Layouts were not read (Tooling API).",
      dependencies: (details.dependencies || []).map((d, i) => ({
        key: `${d.type}-${d.name}-${i}`,
        ...d
      })),
      hasDependencies: (details.dependencies || []).length > 0,
      dependenciesText: details.dependenciesKnown
        ? "Referenced by no flow, Apex, validation rule or report."
        : "Dependencies are only read for custom fields, with the Tooling API.",
      setupLink: field.isCustom
        ? `${this.view.orgDomainUrl}/lightning/setup/ObjectManager/${this.selectedObject}/FieldsAndRelationships/view`
        : null,
      statusClass: `detail-status tone-${field.meta.tone}`
    };
  }

  handleCloseDetail() {
    this.expandedId = null;
  }

  // ---------- Sélection et recommandations ----------

  handleCheck(event) {
    event.stopPropagation();
    const id = event.target.dataset.id;
    const next = new Set(this.selectedIds);
    if (event.target.checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.selectedIds = next;
  }

  get selectableRows() {
    return this.rows.filter((r) => r.selectable);
  }

  get allChecked() {
    const rows = this.selectableRows;
    return rows.length > 0 && rows.every((r) => this.selectedIds.has(r.id));
  }

  get noneSelectable() {
    return this.selectableRows.length === 0;
  }

  handleCheckAll(event) {
    const next = new Set(this.selectedIds);
    for (const row of this.selectableRows) {
      if (event.target.checked) {
        next.add(row.id);
      } else {
        next.delete(row.id);
      }
    }
    this.selectedIds = next;
  }

  get selectedCount() {
    return this.selectedIds.size;
  }

  get sendLabel() {
    return this.selectedCount
      ? `Send to Recommendations (${this.selectedCount})`
      : "Send to Recommendations";
  }

  get sendDisabled() {
    return this.isSending || this.selectedCount === 0;
  }

  /**
   * Une recommandation par champ (empreinte = règle + champ) ; seuls les champs personnalisés en
   * anomalie, jamais ceux d'un package géré. Les décisions déjà prises ne sont jamais écrasées.
   */
  buildRecommendationSpecs(fields) {
    const analysis = this.view;
    const now = new Date().toISOString();
    const specs = [];
    let skipped = 0;
    fields.forEach((field) => {
      const rule = RULE_BY_STATUS[field.status];
      if (!rule || !field.isCustom || isManagedField(field.apiName)) {
        skipped++;
        return;
      }
      const component = `${analysis.objectName}.${field.apiName}`;
      const fingerprint = `${rule}|CustomField:${component}`.substring(0, 255);
      specs.push({
        Fingerprint__c: fingerprint,
        RuleCode__c: rule,
        Title__c: `${TITLE_BY_STATUS[field.status]}: ${component}`.substring(
          0,
          255
        ),
        Description__c: `${field.label} (${component}) — ${field.status}. Filled on ${field.filled} of ${analysis.recordCount} records (field usage analysis of ${formatDateTime(analysis.completedAt)}).`,
        SuggestedAction__c: field.details?.recommendation || null,
        Category__c:
          field.status === "Undocumented" ||
          field.status === "Hidden but filled"
            ? "Documentation"
            : "Technical Debt",
        Confidence__c: "Medium",
        ComponentType__c: "CustomField",
        ComponentName__c: component,
        AffectedComponents__c: component,
        LastDetectedAt__c: now,
        StillDetected__c: true,
        Severity__c: SEVERITY_BY_STATUS[field.status]
      });
    });
    return { specs, skipped };
  }

  async handleSend() {
    this.isSending = true;
    try {
      const chosen = this.fields.filter((f) => this.selectedIds.has(f.id));
      const { specs, skipped } = this.buildRecommendationSpecs(chosen);
      const result = await sendRecommendations(specs, {
        reopenReason:
          "Detected again by a field usage analysis after being resolved."
      });
      const where =
        result.mode === LOCAL_MODE
          ? "They are stored in this browser (Data Model domain)."
          : "They appear in the Data Model domain.";
      this.toast(
        "Sent to Recommendations",
        `${result.created} created, ${result.updated} updated${skipped ? `, ${skipped} skipped` : ""}. ${where}`,
        "success"
      );
      this.selectedIds = new Set();
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

  handleOpenRecommendations(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "recommendations", search: this.selectedObject }
      })
    );
  }

  // ---------- Export ----------

  get noFields() {
    return !(this.view?.fields || []).length;
  }

  /** Colonnes d'export d'un champ (valeurs brutes : pourcentages et comptes en nombres). */
  get fieldColumns() {
    const recordCount = this.view?.recordCount;
    return [
      { label: "Field label", value: (f) => f.label },
      { label: "API name", value: (f) => f.apiName },
      { label: "Type", value: (f) => TYPE_LABELS[f.dataType] || f.dataType },
      { label: "Custom", value: (f) => !!f.isCustom },
      { label: "Managed package", value: (f) => !!f.details.managed },
      { label: "Calculated", value: (f) => !!f.isCalculated },
      { label: "Required", value: (f) => !!f.isRequired },
      { label: "Filled records", value: (f) => f.filled },
      { label: "Records", value: () => recordCount },
      { label: "Fill rate %", value: (f) => f.fill },
      { label: "Recent fill rate %", value: (f) => f.recentFill },
      { label: "Distinct values", value: (f) => f.distinctCount },
      { label: "Layouts", value: (f) => f.layoutCount },
      {
        label: "Layout names",
        value: (f) => (f.details.layouts || []).join(", ")
      },
      { label: "Dependencies", value: (f) => f.dependencyCount },
      {
        label: "Used by",
        value: (f) =>
          (f.details.dependencies || [])
            .map((d) => `${d.type}: ${d.name}`)
            .join("\n")
      },
      {
        label: "Last filled",
        value: (f) => formatExportDate(f.lastFilledAt)
      },
      {
        label: "Field created",
        value: (f) => formatExportDate(f.fieldCreatedDate, false)
      },
      { label: "Status", value: (f) => f.status },
      { label: "Recommendation", value: (f) => f.details.recommendation },
      { label: "Description", value: (f) => f.details.description },
      { label: "Help text", value: (f) => f.details.helpText }
    ];
  }

  /**
   * CSV : champs affichés (filtres, recherche, tri). Excel : deux onglets, champs affichés et
   * tous les champs de l'analyse.
   */
  handleExport(event) {
    const columns = this.fieldColumns;
    exportRows({
      name: `field-usage-${this.selectedObject}`,
      format: event.detail.format,
      sheets: [
        { name: "Fields shown", columns, rows: this.sortedFields },
        { name: "All fields", columns, rows: this.fields }
      ]
    });
  }

  handleExportObjects(event) {
    exportRows({
      name: "field-usage-objects",
      format: event.detail.format,
      rows: this.objectItems,
      columns: [
        { label: "Object", value: (o) => o.apiName },
        { label: "Label", value: (o) => o.label },
        { label: "Custom", value: (o) => !!o.isCustom },
        { label: "Records", value: (o) => o.recordCount },
        { label: "Analyzed", value: (o) => !!o.analysed },
        { label: "Analyzed at", value: (o) => formatExportDate(o.analysedAt) },
        { label: "Fields analyzed", value: (o) => o.fieldCount },
        { label: "Fields to review", value: (o) => o.issueCount },
        { label: "Unused fields", value: (o) => o.unusedCount },
        { label: "Usage score", value: (o) => o.score }
      ]
    });
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
