import { LightningElement } from "lwc";
import getAutomationView from "@salesforce/apex/OrgIntelligenceController.getAutomationView";
import {
  downloadText,
  exportRows,
  formatExportDate,
  formatRelative,
  toCsv,
  todayIso
} from "c/orgIntelUtils";
import { KINDS, buildAutomationData } from "c/orgIntelAutomationModel";
import { buildAutomationView, loadLatestScan } from "c/orgIntelScanData";
import { subscribe } from "c/orgIntelScanEngine";
import {
  CONFLICT_CSV_COLUMNS,
  buildHtmlReport,
  buildMermaid,
  buildOrgMapSvg
} from "c/orgIntelAutomationExport";

// Marque d'ordre des octets : Excel reconnaît l'UTF-8 (accents)
const BOM = String.fromCharCode(0xfeff);

const TABS = [
  { value: "map", label: "Org map", icon: "utility:hierarchy" },
  { value: "object", label: "Object view", icon: "utility:layers" },
  { value: "conflicts", label: "Conflicts", icon: "utility:warning" }
];

/**
 * Section « Automation » : carte des automatisations de l'org (objets et écritures croisées),
 * ordre d'exécution d'un objet, synthèse des conflits de toute l'org et exports (rapport HTML,
 * SVG, Mermaid, CSV). Les calculs sont dans c/orgIntelAutomationModel, faits une fois au chargement.
 * Automatisations lues dans le dernier scan gardé dans le navigateur (id = clé du composant,
 * ex. « Flow:Mon_Flow ») ; erreurs d'exécution des flows et domaine de l'org lus en direct.
 */
export default class OrgIntelAutomation extends LightningElement {
  view;
  data;
  error;
  isLoading = true;
  tab = "map";
  selectedObject = null;
  selectedAutomationId = null;
  conflictType = "";

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
      const [live, scan] = await Promise.all([
        getAutomationView(),
        loadLatestScan()
      ]);
      this.view = { ...buildAutomationView(scan), ...(live || {}) };
      this.data = buildAutomationData(this.view);
      this.error = undefined;
      if (
        !this.selectedObject ||
        !this.data.objects.some((o) => o.name === this.selectedObject)
      ) {
        this.selectedObject =
          [...this.data.objects].sort(
            (a, b) => b.automationCount - a.automationCount
          )[0]?.name || null;
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

  get hasScan() {
    return !!this.view?.scanId;
  }

  get scanText() {
    return this.view?.scanName
      ? `Based on ${this.view.scanName}, ${formatRelative(this.view.scanCompletedAt)}.`
      : "";
  }

  get flowLogicMissing() {
    return this.hasScan && !this.view.flowLogicAnalysed;
  }

  // ---------- Indicateurs ----------

  get kpis() {
    const k = this.data?.kpis;
    if (!k) {
      return [];
    }
    return [
      {
        key: "objects",
        value: k.objects,
        label: "Automated objects",
        caption: "Click to see the map",
        icon: "utility:hierarchy",
        tone: "accent",
        target: "map"
      },
      {
        key: "active",
        value: k.active,
        label: "Active automations",
        caption: `${k.inactive} inactive not shown`,
        icon: "utility:flow",
        tone: "violet",
        target: "object",
        split: [
          {
            key: "flow",
            text: `${k.flowCount} flows`,
            style: `background:${KINDS.Flow.color}`
          },
          {
            key: "pb",
            text: `${k.pbCount} PB`,
            style: `background:${KINDS["Process Builder"].color}`
          },
          {
            key: "apex",
            text: `${k.apexCount} Apex`,
            style: `background:${KINDS["Apex trigger"].color}`
          }
        ]
      },
      {
        key: "conflicts",
        value: k.conflicts,
        label: "Conflicts",
        caption: k.mixedNotes
          ? `+ ${k.mixedNotes} low "mixed tools" note${k.mixedNotes === 1 ? "" : "s"}`
          : k.conflicts
            ? "Review them by type"
            : "Nothing to fix",
        icon: "utility:warning",
        tone: k.conflicts ? "serious" : "good",
        target: "conflicts"
      },
      {
        key: "loops",
        value: k.loops,
        label: "Loops between objects",
        caption: k.loops ? "Risk of recursion" : "No cycle detected",
        icon: "utility:rotate",
        tone: k.loops ? "critical" : "good",
        target: "conflicts",
        conflictType: "loop"
      },
      this.data.flowErrorsMessage
        ? {
            // Erreurs de flows lues pour les administrateurs seulement
            key: "failed",
            value: "—",
            label: `Failed runs · ${this.data.errorDays} days`,
            caption: this.data.flowErrorsMessage,
            icon: "utility:error",
            tone: "neutral",
            target: "object"
          }
        : {
            key: "failed",
            value: k.failedRuns,
            label: `Failed runs · ${this.data.errorDays} days`,
            caption: k.failedRuns
              ? "Flow interviews in error"
              : "No failed flow run",
            icon: "utility:error",
            tone: k.failedRuns ? "critical" : "good",
            target: "object"
          }
    ].map((kpi) => ({
      ...kpi,
      hasSplit: !!kpi.split,
      className: `kpi kpi-${kpi.tone}`,
      ariaLabel: `${kpi.value} ${kpi.label}. ${kpi.caption}`
    }));
  }

  handleKpi(event) {
    const { target, type } = event.currentTarget.dataset;
    this.conflictType = type || "";
    this.tab = target;
  }

  // ---------- Onglets ----------

  get tabs() {
    return TABS.map((tab) => {
      const selected = tab.value === this.tab;
      let badge = null;
      if (tab.value === "object" && this.selectedObject) {
        badge = this.selectedObject;
      } else if (tab.value === "conflicts" && this.data?.kpis.conflicts) {
        badge = String(this.data.kpis.conflicts);
      }
      return {
        ...tab,
        badge,
        selected: selected ? "true" : "false",
        tabIndex: selected ? "0" : "-1",
        className: `au-tab${selected ? " tab-selected" : ""}`,
        badgeClass: `tab-badge${tab.value === "conflicts" ? " tab-badge-alert" : ""}`
      };
    });
  }

  get isMap() {
    return this.tab === "map";
  }

  get isObject() {
    return this.tab === "object";
  }

  get isConflicts() {
    return this.tab === "conflicts";
  }

  handleTab(event) {
    this.tab = event.currentTarget.dataset.value;
    this.conflictType = "";
  }

  handleTabKeydown(event) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    const index = TABS.findIndex((tab) => tab.value === this.tab);
    const next =
      (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) %
      TABS.length;
    this.tab = TABS[next].value;
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    requestAnimationFrame(() => {
      this.template.querySelector(`[data-value="${this.tab}"]`)?.focus();
    });
  }

  handleSelectObject(event) {
    const { objectName, automationId } = event.detail || {};
    if (objectName) {
      this.selectedObject = objectName;
    }
    this.selectedAutomationId = automationId || null;
    this.tab = "object";
  }

  handleChildNavigate(event) {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("navigate", { detail: event.detail }));
  }

  /**
   * Premier clic sur le lanceur de scan : le panneau s'ouvre avec le périmètre Flows prérempli
   * (le lanceur a déjà basculé le panneau, openPanel le garde ouvert).
   */
  handleScanClick() {
    if (this.scanPrefilled) {
      return;
    }
    this.scanPrefilled = true;
    const control = this.template.querySelector("c-org-intel-scan-control");
    if (control) {
      control.openPanel(["Flow"]);
    }
  }

  // ---------- Exports ----------

  get orgName() {
    try {
      const host = new URL(this.data?.orgDomainUrl || "").hostname;
      return host.split(".my.salesforce")[0];
    } catch {
      return "";
    }
  }

  /** Classeur Excel : objets, automatisations, conflits et échecs d'exécution de toute l'org. */
  exportWorkbook() {
    const data = this.data;
    const writesOf = (a) =>
      [
        ...new Set(
          (a.model?.writes || []).map(
            (w) =>
              `${w.operation} ${w.sameRecord ? "same record" : w.objectName || "records"}${(w.fields || []).length ? ` (${w.fields.join(", ")})` : ""}`
          )
        )
      ].join("; ");
    const failedRows = (this.view?.flowErrors || []).flatMap((summary) => {
      return (summary.samples || []).length
        ? summary.samples.map((sample) => ({ ...sample, summary }))
        : [{ summary }];
    });
    exportRows({
      name: `automation${this.orgName ? `-${this.orgName}` : ""}`,
      format: "xlsx",
      sheets: [
        {
          name: "Objects",
          rows: data.objects,
          columns: [
            { label: "Object", value: (o) => o.name },
            { label: "Active automations", value: (o) => o.automationCount },
            { label: "Flows", value: (o) => o.counts.flow || 0 },
            { label: "Process Builder", value: (o) => o.counts.pb || 0 },
            { label: "Apex triggers", value: (o) => o.counts.apex || 0 },
            { label: "Conflicts", value: (o) => o.conflictCount },
            { label: "Saves the record again", value: (o) => o.resaves },
            { label: "Scanner issues", value: (o) => o.issues },
            {
              label: `Failed runs (${data.errorDays} days)`,
              value: (o) => o.errors
            },
            { label: "In a loop", value: (o) => !!o.inLoop }
          ]
        },
        {
          name: "Automations",
          rows: data.automations,
          columns: [
            { label: "Automation", value: (a) => a.label || a.apiName },
            { label: "API name", value: (a) => a.apiName },
            { label: "Type", value: (a) => a.kind },
            { label: "Object", value: (a) => a.objectName },
            { label: "Timing", value: (a) => a.timing },
            { label: "Events", value: (a) => (a.events || []).join(", ") },
            { label: "Trigger order", value: (a) => a.model?.triggerOrder },
            { label: "Active", value: (a) => !!a.isActive },
            { label: "API version", value: (a) => a.apiVersion },
            { label: "Entry criteria", value: (a) => a.model?.entryCriteria },
            { label: "Writes", value: (a) => writesOf(a) },
            {
              label: "Calls",
              value: (a) =>
                [
                  ...(a.model?.subflows || []).map((s) => `Subflow ${s}`),
                  ...(a.model?.apexActions || []).map((s) => `Apex ${s}`)
                ].join("; ")
            },
            {
              label: "Scanner issues",
              value: (a) => (a.findings || []).length
            },
            { label: "Failed runs", value: (a) => a.errors?.count || 0 },
            { label: "Description", value: (a) => a.description }
          ]
        },
        {
          name: "Conflicts",
          rows: data.allConflicts,
          columns: CONFLICT_CSV_COLUMNS
        },
        {
          name: "Failed runs",
          rows: failedRows,
          columns: [
            { label: "Flow", value: (r) => r.summary.flowApiName },
            { label: "Failed runs (period)", value: (r) => r.summary.count },
            { label: "When", value: (r) => formatExportDate(r.occurredAt) },
            { label: "Version", value: (r) => r.versionNumber },
            { label: "Element", value: (r) => r.element },
            { label: "User", value: (r) => r.userName },
            { label: "Error", value: (r) => r.message }
          ]
        }
      ]
    });
  }

  handleExport(event) {
    const kind = event.detail.value;
    const stamp = todayIso();
    const prefix = `automation${this.orgName ? `-${this.orgName}` : ""}`;
    switch (kind) {
      case "xlsx":
        this.exportWorkbook();
        break;
      case "html":
        downloadText(
          `${prefix}-report-${stamp}.html`,
          buildHtmlReport(this.data, { orgName: this.orgName }),
          "text/html"
        );
        break;
      case "svg":
        downloadText(
          `${prefix}-map-${stamp}.svg`,
          buildOrgMapSvg(this.data),
          "image/svg+xml"
        );
        break;
      case "mermaid":
        downloadText(
          `${prefix}-map-${stamp}.mmd`,
          buildMermaid(this.data),
          "text/plain"
        );
        break;
      case "csv":
        downloadText(
          `${prefix}-conflicts-${stamp}.csv`,
          `${BOM}${toCsv(this.data.allConflicts, CONFLICT_CSV_COLUMNS)}`,
          "text/csv"
        );
        break;
      default:
        break;
    }
  }
}
