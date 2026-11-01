import { LightningElement } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import ApiLogModal from "c/orgIntelApiLogModal";
import AlertEditor from "c/orgIntelApiAlertEditor";
import {
  exportRows,
  formatExportDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  reduceErrors
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";

// Actions Apex du module (via le contrôleur générique du socle)
const getApiLogs = moduleAction("apiMonitoring", "getApiLogs");
const getOrgApiUsage = moduleAction("apiMonitoring", "getOrgApiUsage");
const suggestApiAlertFromLog = moduleAction(
  "apiMonitoring",
  "suggestApiAlertFromLog"
);

const ALL = "";
const SYSTEM_COLORS = [
  "#0b5cab",
  "#7f56d9",
  "#0e9384",
  "#dd6b20",
  "#c11574",
  "#2e90fa",
  "#3b7c0f",
  "#b54708",
  "#5c6470"
];

const PERIODS = [
  { label: "Last 24 hours", value: "1" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" }
];

const STATUS_OPTIONS = [
  { label: "All statuses", value: ALL },
  { label: "Success", value: "success" },
  { label: "Errors", value: "error" }
];

const COLUMNS = [
  {
    type: "button-icon",
    initialWidth: 40,
    typeAttributes: {
      iconName: "utility:preview",
      name: "view",
      alternativeText: "View the call",
      title: "View request and response",
      variant: "bare"
    }
  },
  {
    type: "button-icon",
    initialWidth: 40,
    typeAttributes: {
      iconName: "utility:notification",
      name: "alert",
      alternativeText: "Alert on similar errors",
      title: "Create an alert on similar errors",
      variant: "bare",
      disabled: { fieldName: "success" }
    }
  },
  {
    label: "Call",
    fieldName: "calledAt",
    type: "date",
    sortable: true,
    initialWidth: 150,
    typeAttributes: {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  },
  {
    label: "Status",
    fieldName: "statusLabel",
    sortable: true,
    initialWidth: 100,
    cellAttributes: {
      iconName: { fieldName: "statusIcon" },
      iconAlternativeText: { fieldName: "statusLabel" }
    }
  },
  {
    label: "System",
    fieldName: "systemName",
    sortable: true,
    initialWidth: 140
  },
  {
    label: "HTTP",
    fieldName: "statusCode",
    type: "number",
    sortable: true,
    initialWidth: 70,
    cellAttributes: { alignment: "left" }
  },
  {
    label: "Operation",
    fieldName: "operation",
    sortable: true,
    wrapText: true
  },
  {
    label: "ms",
    fieldName: "durationMs",
    type: "number",
    sortable: true,
    initialWidth: 80
  },
  { label: "Error", fieldName: "errorMessage", wrapText: true }
];

/**
 * Section « API Monitoring » : journal des appels API (par système, statut et période), et
 * consommation API de l'org (limites, connexions API par application et par utilisateur).
 */
export default class OrgIntelApiMonitor extends LightningElement {
  period = "7";
  system = ALL;
  status = ALL;
  search = "";
  sortBy = "calledAt";
  sortDirection = "desc";

  logs;
  logsError;
  isLoadingLogs = true;
  usage;
  usageError;
  isLoadingUsage = false;

  periods = PERIODS;
  statusOptions = STATUS_OPTIONS;
  columns = COLUMNS;

  connectedCallback() {
    this.loadLogs();
  }

  async loadLogs() {
    this.isLoadingLogs = !this.logs;
    try {
      this.logs = await getApiLogs({ days: Number(this.period) });
      this.logsError = undefined;
    } catch (error) {
      this.logsError = error;
    } finally {
      this.isLoadingLogs = false;
    }
  }

  async loadUsage() {
    this.isLoadingUsage = true;
    try {
      this.usage = await getOrgApiUsage({ days: Number(this.period) });
      this.usageError = undefined;
    } catch (error) {
      this.usageError = error;
    } finally {
      this.isLoadingUsage = false;
    }
  }

  handleUsageTab() {
    if (!this.usage) {
      this.loadUsage();
    }
  }

  handleRefresh() {
    this.loadLogs();
    if (this.usage) {
      this.loadUsage();
    }
    this.template.querySelector("c-org-intel-api-alerts")?.refresh();
  }

  handlePeriod(event) {
    this.period = event.detail.value;
    // l'onglet Alerts recharge ses types d'erreurs en recevant la nouvelle période
    this.loadLogs();
    if (this.usage) {
      this.loadUsage();
    }
  }

  // ---------- Indicateurs ----------

  get kpis() {
    const logs = this.logs;
    if (!logs) {
      return [];
    }
    const rate = logs.total
      ? Math.round((100 * logs.successCount) / logs.total)
      : 0;
    const kpis = [
      {
        key: "total",
        value: formatNumber(logs.total),
        label: "Calls",
        tone: "kpi-blue",
        hint: "Show all calls",
        active: !this.status && !this.system
      },
      {
        key: "success",
        value: formatNumber(logs.successCount),
        label: `Success · ${rate}%`,
        tone: "kpi-green",
        hint: "Show successful calls only",
        active: this.status === "success"
      },
      {
        key: "errors",
        value: formatNumber(logs.errorCount),
        label: "Errors",
        tone: logs.errorCount ? "kpi-red" : "kpi-grey",
        hint: "Show errors only",
        active: this.status === "error"
      },
      {
        key: "day",
        value: formatNumber(logs.last24hCount),
        label: "Last 24 h",
        tone: "kpi-orange",
        hint: "Switch the period to the last 24 hours",
        active: this.period === "1"
      },
      {
        key: "duration",
        value: `${formatNumber(logs.averageDurationMs)} ms`,
        label: "Avg duration",
        tone: "kpi-grey",
        hint: "Sort by duration, slowest first",
        active: this.sortBy === "durationMs"
      }
    ];
    return kpis.map((kpi) => ({
      ...kpi,
      pressed: kpi.active ? "true" : "false",
      className: `kpi ${kpi.tone}${kpi.active ? " kpi-active" : ""}`
    }));
  }

  /** Clic sur un indicateur : applique le filtre, la période ou le tri correspondant. */
  handleKpi(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "total") {
      this.status = ALL;
      this.system = ALL;
      this.search = "";
    } else if (key === "success" || key === "errors") {
      const value = key === "success" ? "success" : "error";
      this.status = this.status === value ? ALL : value;
    } else if (key === "day" && this.period !== "1") {
      this.handlePeriod({ detail: { value: "1" } });
    } else if (key === "duration") {
      this.sortBy = "durationMs";
      this.sortDirection = "desc";
    }
  }

  handleKpiKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleKpi(event);
    }
  }

  get systemTabs() {
    const systems = this.logs?.systems || [];
    const tabs = [
      {
        key: "all",
        name: ALL,
        label: "All",
        total: this.logs?.total || 0,
        errors: this.logs?.errorCount || 0,
        color: "#0b5cab"
      },
      ...systems.map((system, index) => ({
        key: system.name,
        name: system.name,
        label: system.name,
        total: system.total,
        errors: system.errors,
        color: SYSTEM_COLORS[index % SYSTEM_COLORS.length]
      }))
    ];
    return tabs.map((tab) => ({
      ...tab,
      hasErrors: tab.errors > 0,
      dotStyle: `background:${tab.color}`,
      className: `system${tab.name === this.system ? " system-selected" : ""}`,
      pressed: tab.name === this.system ? "true" : "false"
    }));
  }

  handleSystem(event) {
    this.system = event.currentTarget.dataset.name;
  }

  handleStatus(event) {
    this.status = event.detail.value;
  }

  handleSearch(event) {
    this.search = event.target.value || "";
  }

  // ---------- Table ----------

  get rows() {
    const term = this.search.trim().toLowerCase();
    const rows = (this.logs?.rows || [])
      .filter(
        (row) =>
          (!this.system || row.systemName === this.system) &&
          (!this.status || (this.status === "success") === row.success) &&
          (!term ||
            `${row.operation} ${row.endpoint} ${row.errorMessage} ${row.statusCode} ${row.systemName} ${row.relatedRecordId} ${row.name}`
              .toLowerCase()
              .includes(term))
      )
      .map((row) => ({
        ...row,
        statusLabel: row.success ? "Success" : "Error",
        statusIcon: row.success ? "utility:success" : "utility:error",
        contextUrl: row.relatedRecordId
          ? `/lightning/r/${row.relatedRecordId}/view`
          : null,
        contextLabel: row.relatedRecordId || null
      }));
    const factor = this.sortDirection === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      const left = a[this.sortBy] ?? "";
      const right = b[this.sortBy] ?? "";
      if (left === right) {
        return 0;
      }
      return left > right ? factor : -factor;
    });
  }

  get hasLogs() {
    return (this.logs?.total || 0) > 0;
  }

  get hasRows() {
    return this.rows.length > 0;
  }

  get listTitle() {
    return `${formatNumber(this.rows.length)} shown`;
  }

  get truncatedText() {
    return this.logs?.truncated
      ? `Only the ${this.logs.rows.length} most recent calls are listed; counters cover the whole period.`
      : null;
  }

  handleSort(event) {
    this.sortBy = event.detail.fieldName;
    this.sortDirection = event.detail.sortDirection;
  }

  async handleRowAction(event) {
    const { action, row } = event.detail;
    if (action.name === "alert") {
      await this.alertOnSimilar(row.id);
      return;
    }
    await ApiLogModal.open({
      size: "large",
      logId: row.id,
      label: "API call detail"
    });
  }

  /** « Alert on similar errors » : règle pré-remplie depuis l'appel en erreur, puis éditeur. */
  async alertOnSimilar(logId) {
    try {
      const rule = await suggestApiAlertFromLog({ logId });
      const result = await AlertEditor.open({
        size: "large",
        label: "New alert rule",
        rule,
        systems: (this.logs?.systems || [])
          .map((system) => system.name)
          .filter((name) => name !== "Other"),
        currentUser: null
      });
      if (result?.id) {
        this.dispatchEvent(
          new ShowToastEvent({
            title: "Alert rule created",
            message: `${result.name} — see the Alerts tab.`,
            variant: "success"
          })
        );
        this.template.querySelector("c-org-intel-api-alerts")?.refresh();
      }
    } catch (error) {
      this.dispatchEvent(
        new ShowToastEvent({
          title: "The alert could not be prepared",
          message: reduceErrors(error),
          variant: "error"
        })
      );
    }
  }

  get noRows() {
    return !this.hasRows;
  }

  /** Export des appels affichés (système, statut, recherche et tri en cours). */
  handleExportLogs(event) {
    exportRows({
      name: "api-log",
      format: event.detail.format,
      rows: this.rows,
      columns: [
        { label: "Log", value: (row) => row.name },
        { label: "Called at", value: (row) => formatExportDate(row.calledAt) },
        { label: "Status", value: (row) => row.statusLabel },
        { label: "System", value: (row) => row.systemName },
        { label: "Direction", value: (row) => row.direction },
        { label: "Method", value: (row) => row.method },
        { label: "HTTP", value: (row) => row.statusCode },
        { label: "Operation", value: (row) => row.operation },
        { label: "Endpoint", value: (row) => row.endpoint },
        { label: "Duration (ms)", value: (row) => row.durationMs },
        { label: "Related record", value: (row) => row.relatedRecordId },
        { label: "User", value: (row) => row.userName },
        { label: "Error", value: (row) => row.errorMessage },
        { label: "Log Id", value: (row) => row.id }
      ]
    });
  }

  // ---------- Consommation de l'org ----------

  get limits() {
    return (this.usage?.limits || []).map((item) => {
      const tone =
        item.percent >= 90
          ? "critical"
          : item.percent >= 70
            ? "warning"
            : "good";
      return {
        ...item,
        text: `${formatNumber(item.used)} / ${formatNumber(item.max)}`,
        percentText: `${item.percent}%`,
        barStyle: `width:${Math.min(100, Math.max(item.percent, item.used ? 1 : 0))}%`,
        barClass: `meter-fill tone-${tone}`
      };
    });
  }

  get applications() {
    return (this.usage?.applications || []).map((item, index) => ({
      ...item,
      key: `app-${index}`,
      count: formatNumber(item.total),
      last: formatRelative(item.lastLogin),
      isFailure: item.status !== "Success"
    }));
  }

  get users() {
    return (this.usage?.users || []).map((item) => ({
      ...item,
      count: formatNumber(item.total),
      last: formatRelative(item.lastLogin)
    }));
  }

  get failures() {
    return (this.usage?.failures || []).map((item, index) => ({
      ...item,
      key: `fail-${index}`,
      when: formatDateTime(item.loginTime)
    }));
  }

  get noLimits() {
    return !(this.usage?.limits || []).length;
  }

  get noApplications() {
    return !(this.usage?.applications || []).length;
  }

  get noUsers() {
    return !(this.usage?.users || []).length;
  }

  get noFailures() {
    return !this.hasFailures;
  }

  /** Export d'un tableau de l'onglet « Org API usage ». */
  handleExportUsage(event) {
    const usage = this.usage || {};
    const sheets = {
      limits: {
        name: "Org limits",
        rows: usage.limits || [],
        columns: [
          { label: "Limit", value: (row) => row.label },
          { label: "API name", value: (row) => row.name },
          { label: "Used", value: (row) => row.used },
          { label: "Max", value: (row) => row.max },
          { label: "Used (%)", value: (row) => row.percent }
        ]
      },
      applications: {
        name: "API logins by application",
        rows: usage.applications || [],
        columns: [
          { label: "Application", value: (row) => row.name },
          { label: "Login type", value: (row) => row.loginType },
          { label: "Status", value: (row) => row.status },
          { label: "Logins", value: (row) => row.total },
          { label: "Last", value: (row) => formatExportDate(row.lastLogin) }
        ]
      },
      users: {
        name: "Top API users",
        rows: usage.users || [],
        columns: [
          { label: "User", value: (row) => row.name },
          { label: "Detail", value: (row) => row.detail },
          { label: "Logins", value: (row) => row.total },
          { label: "Last", value: (row) => formatExportDate(row.lastLogin) },
          { label: "User Id", value: (row) => row.userId }
        ]
      },
      failures: {
        name: "Failed logins",
        rows: usage.failures || [],
        columns: [
          { label: "When", value: (row) => formatExportDate(row.loginTime) },
          { label: "User", value: (row) => row.userName },
          { label: "Application", value: (row) => row.application },
          { label: "Type", value: (row) => row.loginType },
          { label: "Status", value: (row) => row.status },
          { label: "Source IP", value: (row) => row.sourceIp }
        ]
      }
    };
    const sheet = sheets[event.currentTarget.dataset.sheet];
    exportRows({
      name: `api-usage-${sheet.name}`,
      format: event.detail.format,
      sheets: [sheet]
    });
  }

  get hasFailures() {
    return this.failures.length > 0;
  }

  get loginKpis() {
    if (!this.usage) {
      return [];
    }
    return [
      {
        key: "logins",
        value: formatNumber(this.usage.apiLoginCount),
        label: "API logins",
        className: "kpi kpi-blue",
        target: "applications",
        hint: "Go to API logins by application"
      },
      {
        key: "failed",
        value: formatNumber(this.usage.failedLoginCount),
        label: "Failed API logins",
        className: `kpi ${this.usage.failedLoginCount ? "kpi-red" : "kpi-grey"}`,
        target: "failures",
        hint: "Go to failed logins"
      },
      {
        key: "apps",
        value: formatNumber(
          new Set((this.usage.applications || []).map((a) => a.name)).size
        ),
        label: "Applications",
        className: "kpi kpi-grey",
        target: "applications",
        hint: "Go to API logins by application"
      }
    ];
  }

  /** Clic sur un indicateur de connexions : fait défiler jusqu'au tableau associé. */
  handleLoginKpi(event) {
    const target = event.currentTarget.dataset.target;
    this.template
      .querySelector(`[data-anchor="${target}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  handleLoginKpiKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleLoginKpi(event);
    }
  }
}
