import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import LightningConfirm from "lightning/confirm";
import AlertEditor from "c/orgIntelApiAlertEditor";
import {
  exportRows,
  formatDateTime,
  formatExportDate,
  formatNumber,
  formatRelative,
  reduceErrors
} from "c/orgIntelUtils";
import {
  SEVERITY_TONES,
  TEMPLATES,
  channelIcons,
  describeRule,
  formatMetricValue,
  formatThreshold
} from "c/orgIntelApiAlertUtils";
import { moduleAction } from "c/orgIntelModuleApi";

// Actions Apex du module (via le contrôleur générique du socle)
const getApiAlerts = moduleAction("apiMonitoring", "getApiAlerts");
const getApiErrorTypes = moduleAction("apiMonitoring", "getApiErrorTypes");
const setApiAlertRuleActive = moduleAction(
  "apiMonitoring",
  "setApiAlertRuleActive"
);
const deleteApiAlertRule = moduleAction("apiMonitoring", "deleteApiAlertRule");
const checkApiAlerts = moduleAction("apiMonitoring", "checkApiAlerts");
const sendApiAlertTest = moduleAction("apiMonitoring", "sendApiAlertTest");
const setApiAlertStatus = moduleAction("apiMonitoring", "setApiAlertStatus");
const scheduleApiAlerts = moduleAction("apiMonitoring", "scheduleApiAlerts");

const FREQUENCIES = [
  { value: 0, label: "Off" },
  { value: 60, label: "Hourly" },
  { value: 15, label: "Every 15 min" }
];

const EVENT_FILTERS = [
  { value: "Open", label: "Open" },
  { value: "all", label: "All" }
];

const STATUS_TONES = {
  Open: "critical",
  Acknowledged: "warning",
  Resolved: "good"
};

/**
 * Onglet « Alerts » de l'API Monitoring : planification des contrôles, règles d'alerte en cartes
 * (phrase, valeur courante, courbe 24 h), historique des alertes et types d'erreurs du journal,
 * chacun transformable en règle en un clic.
 */
export default class OrgIntelApiAlerts extends LightningElement {
  /** Période du journal choisie dans l'API Monitoring (jours), pour les types d'erreurs. */
  @api
  get period() {
    return this._period;
  }
  set period(value) {
    const changed = this._period !== undefined && this._period !== value;
    this._period = value;
    if (changed && this.connected) {
      this.loadErrorTypes();
    }
  }
  _period = "7";

  view;
  error;
  isLoading = true;
  errorTypes;
  errorTypesError;
  isLoadingTypes = true;
  isChecking = false;
  isScheduling = false;
  eventFilter = "Open";
  busyRuleId = null;
  connected = false;

  eventFilters = EVENT_FILTERS;

  connectedCallback() {
    this.connected = true;
    this.load();
    this.loadErrorTypes();
  }

  disconnectedCallback() {
    this.connected = false;
  }

  /** Rechargement demandé par la page (période, règle créée depuis le journal). */
  @api
  refresh() {
    this.load();
    this.loadErrorTypes();
  }

  /** Ouvre l'éditeur avec un brouillon (règle suggérée depuis un appel du journal). */
  @api
  async openEditor(rule) {
    await this.edit(rule || null);
  }

  async load() {
    this.isLoading = !this.view;
    try {
      this.view = await getApiAlerts();
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  async loadErrorTypes() {
    this.isLoadingTypes = !this.errorTypes;
    try {
      this.errorTypes = await getApiErrorTypes({ days: Number(this._period) });
      this.errorTypesError = undefined;
    } catch (error) {
      this.errorTypesError = error;
    } finally {
      this.isLoadingTypes = false;
    }
  }

  toast(title, message, variant = "success") {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }

  get currentUser() {
    return this.view
      ? {
          id: this.view.currentUserId,
          name: this.view.currentUserName,
          email: this.view.currentUserEmail
        }
      : null;
  }

  get systems() {
    return this.view?.systems || [];
  }

  // ---------- Bandeau ----------

  get schedule() {
    return this.view?.schedule || { scheduled: false };
  }

  get frequencies() {
    const current = this.schedule.scheduled
      ? this.schedule.frequencyMinutes
      : 0;
    return FREQUENCIES.map((option) => ({
      ...option,
      key: String(option.value),
      checked: option.value === current ? "true" : "false",
      className: `segment${option.value === current ? " segment-on" : ""}`
    }));
  }

  get scheduleTitle() {
    if (!this.schedule.scheduled) {
      return "Automatic checks are off";
    }
    return this.schedule.frequencyMinutes === 15
      ? "Checking every 15 minutes"
      : "Checking every hour";
  }

  get scheduleDetail() {
    if (!this.schedule.scheduled) {
      return "Rules are only evaluated when you click “Check now”.";
    }
    const parts = [`next run ${formatDateTime(this.schedule.nextRunAt)}`];
    if (this.schedule.previousRunAt) {
      parts.push(`last ${formatRelative(this.schedule.previousRunAt)}`);
    }
    return parts.join(" · ");
  }

  get columnsClass() {
    return `columns${this.hasEvents || this.hasRules ? "" : " columns-quiet"}${!this.hasEvents ? " columns-no-events" : ""}`;
  }

  get statusClass() {
    return `status-card${this.schedule.scheduled ? " status-on" : " status-off"}`;
  }

  get pulseClass() {
    return `pulse${this.schedule.scheduled ? " pulse-on" : ""}`;
  }

  get kpis() {
    const rules = this.view?.rules || [];
    const active = rules.filter((rule) => rule.active).length;
    const breaching = rules.filter(
      (rule) => rule.active && rule.breachingNow
    ).length;
    return [
      {
        key: "active",
        value: `${active}/${rules.length}`,
        label: "Active rules",
        className: "mini-kpi"
      },
      {
        key: "breaching",
        value: formatNumber(breaching),
        label: "Over threshold now",
        className: `mini-kpi${breaching ? " mini-kpi-hot" : ""}`
      },
      {
        key: "open",
        value: formatNumber(this.view?.openCount || 0),
        label: "Open alerts",
        className: `mini-kpi${this.view?.openCount ? " mini-kpi-hot" : ""}`
      },
      {
        key: "day",
        value: formatNumber(this.view?.firedLast24h || 0),
        label: "Fired in 24 h",
        className: "mini-kpi"
      }
    ];
  }

  async handleFrequency(event) {
    const value = Number(event.currentTarget.dataset.value);
    this.isScheduling = true;
    try {
      const schedule = await scheduleApiAlerts({ frequencyMinutes: value });
      this.view = { ...this.view, schedule };
      this.toast(
        value ? "Automatic checks on" : "Automatic checks off",
        value
          ? `Active rules are checked ${value === 15 ? "every 15 minutes" : "every hour"}.`
          : "Rules will only be checked on demand."
      );
    } catch (error) {
      this.toast("Schedule not changed", reduceErrors(error), "error");
    } finally {
      this.isScheduling = false;
    }
  }

  async handleCheckAll() {
    await this.check(null);
  }

  async check(ruleId) {
    this.isChecking = true;
    this.busyRuleId = ruleId;
    try {
      const result = await checkApiAlerts({ ruleId });
      const title = result.fired
        ? `${result.fired} alert${result.fired === 1 ? "" : "s"} sent`
        : "No alert";
      const message = result.messages.length
        ? result.messages.join(" ")
        : `${result.evaluated} rule${result.evaluated === 1 ? "" : "s"} checked: every value is below its threshold.`;
      this.toast(title, message, result.fired ? "warning" : "success");
      await this.load();
    } catch (error) {
      this.toast("Check failed", reduceErrors(error), "error");
    } finally {
      this.isChecking = false;
      this.busyRuleId = null;
    }
  }

  // ---------- Règles ----------

  get hasRules() {
    return (this.view?.rules || []).length > 0;
  }

  // ---------- Exports ----------

  get noRules() {
    return !(this.view?.rules || []).length;
  }

  get noEvents() {
    return !this.hasEvents;
  }

  get noErrorTypes() {
    return !this.hasErrorTypes;
  }

  handleExportRules(event) {
    exportRows({
      name: "api-alert-rules",
      format: event.detail.format,
      rows: this.view?.rules || [],
      columns: [
        { label: "Rule", value: (rule) => rule.name },
        { label: "Condition", value: (rule) => describeRule(rule) },
        { label: "Active", value: (rule) => !!rule.active },
        { label: "Severity", value: (rule) => rule.severity },
        { label: "Metric", value: (rule) => rule.metric },
        { label: "Comparator", value: (rule) => rule.comparator },
        { label: "Threshold", value: (rule) => rule.threshold },
        { label: "Window (min)", value: (rule) => rule.windowMinutes },
        { label: "System", value: (rule) => rule.systemName || "All" },
        {
          label: "Operation contains",
          value: (rule) => rule.operationContains
        },
        { label: "Status codes", value: (rule) => rule.statusCodes },
        { label: "Error contains", value: (rule) => rule.errorContains },
        {
          label: "Channels",
          value: (rule) => (rule.channels || []).join("; ")
        },
        { label: "Email recipients", value: (rule) => rule.recipients },
        { label: "Task owner", value: (rule) => rule.taskOwnerName },
        { label: "Cooldown (min)", value: (rule) => rule.cooldownMinutes },
        { label: "Current value", value: (rule) => rule.currentValue },
        { label: "Over threshold now", value: (rule) => !!rule.breachingNow },
        { label: "Open alerts", value: (rule) => rule.openAlerts },
        { label: "Fired (total)", value: (rule) => rule.triggerCount },
        {
          label: "Last alert",
          value: (rule) => formatExportDate(rule.lastTriggeredAt)
        },
        {
          label: "Last checked",
          value: (rule) => formatExportDate(rule.lastEvaluatedAt)
        },
        { label: "Rule Id", value: (rule) => rule.id }
      ]
    });
  }

  /** Alertes du filtre en cours (ouvertes ou toutes), sans la limite d'affichage. */
  handleExportEvents(event) {
    exportRows({
      name: "api-alerts",
      format: event.detail.format,
      rows: (this.view?.events || []).filter(
        (item) => this.eventFilter === "all" || item.status === "Open"
      ),
      columns: [
        { label: "Alert", value: (item) => item.name },
        { label: "Fired at", value: (item) => formatExportDate(item.firedAt) },
        { label: "Rule", value: (item) => item.ruleName },
        { label: "Severity", value: (item) => item.severity },
        { label: "Status", value: (item) => item.status },
        { label: "Metric", value: (item) => item.metric },
        { label: "Value", value: (item) => item.value },
        { label: "Threshold", value: (item) => item.threshold },
        {
          label: "Window start",
          value: (item) => formatExportDate(item.windowStart)
        },
        {
          label: "Window end",
          value: (item) => formatExportDate(item.windowEnd)
        },
        { label: "Channels", value: (item) => item.channels },
        { label: "Delivery errors", value: (item) => item.deliveryErrors },
        { label: "Acknowledged by", value: (item) => item.acknowledgedBy },
        {
          label: "Acknowledged at",
          value: (item) => formatExportDate(item.acknowledgedAt)
        },
        { label: "Summary", value: (item) => item.summary },
        { label: "Task Id", value: (item) => item.taskId },
        { label: "Alert Id", value: (item) => item.id }
      ]
    });
  }

  handleExportErrorTypes(event) {
    exportRows({
      name: "api-error-types",
      format: event.detail.format,
      rows: this.errorTypes?.types || [],
      columns: [
        { label: "System", value: (type) => type.systemName },
        { label: "HTTP", value: (type) => type.statusCode },
        { label: "Error type", value: (type) => type.pattern },
        { label: "Sample message", value: (type) => type.sampleMessage },
        { label: "Operation", value: (type) => type.operation },
        { label: "Count", value: (type) => type.count },
        { label: "Last 24 h", value: (type) => type.last24h },
        { label: "Previous 24 h", value: (type) => type.previous24h },
        { label: "Peak per hour", value: (type) => type.peakPerHour },
        {
          label: "First seen",
          value: (type) => formatExportDate(type.firstAt)
        },
        { label: "Last seen", value: (type) => formatExportDate(type.lastAt) },
        { label: "Sample log Id", value: (type) => type.sampleLogId }
      ]
    });
  }

  get rules() {
    return (this.view?.rules || []).map((rule) => {
      const tone = SEVERITY_TONES[rule.severity] || "neutral";
      const state = !rule.active
        ? { label: "Paused", tone: "neutral" }
        : rule.breachingNow
          ? { label: "Over threshold", tone: "critical" }
          : { label: "OK", tone: "good" };
      const lastAlert = rule.lastTriggeredAt
        ? `Last alert ${formatRelative(rule.lastTriggeredAt)}`
        : "Never fired";
      return {
        ...rule,
        sentence: `${describeRule(rule)}.`,
        currentText: formatMetricValue(rule.metric, rule.currentValue),
        thresholdText: formatThreshold(rule),
        stateLabel: state.label,
        stateTone: state.tone,
        severityTone: tone,
        className: `rule-card severity-${tone}${rule.active ? "" : " rule-paused"}${rule.breachingNow && rule.active ? " rule-hot" : ""}`,
        valueClass: `rule-value${rule.breachingNow ? " rule-value-hot" : ""}`,
        channelList: channelIcons(rule.channels),
        footer: `${lastAlert} · ${rule.triggerCount || 0} in total`,
        hasOpenAlerts: rule.openAlerts > 0,
        openAlertsText: `${rule.openAlerts} open`,
        checkedText: rule.lastEvaluatedAt
          ? `checked ${formatRelative(rule.lastEvaluatedAt)}`
          : "not checked yet",
        isBusy: this.busyRuleId === rule.id,
        hasSparkline: (rule.sparkline || []).length > 1
      };
    });
  }

  get templates() {
    return TEMPLATES.map((template) => ({
      ...template,
      className: `template tone-${template.tone}`
    }));
  }

  findRule(id) {
    return (this.view?.rules || []).find((rule) => rule.id === id);
  }

  async edit(rule) {
    const result = await AlertEditor.open({
      size: "large",
      label: rule?.id ? "Edit alert rule" : "New alert rule",
      rule,
      systems: this.systems,
      currentUser: this.currentUser
    });
    if (result?.id) {
      this.toast(
        result.created ? "Alert rule created" : "Alert rule saved",
        result.name
      );
      await this.load();
    }
  }

  handleNewRule() {
    this.edit(null);
  }

  handleTemplate(event) {
    const template = TEMPLATES.find(
      (t) => t.key === event.currentTarget.dataset.key
    );
    this.edit(template ? { ...template.rule } : null);
  }

  async handleToggle(event) {
    const id = event.target.dataset.id;
    const active = event.target.checked;
    try {
      await setApiAlertRuleActive({ ruleId: id, active });
      this.view = {
        ...this.view,
        rules: this.view.rules.map((rule) => {
          return rule.id === id ? { ...rule, active } : rule;
        })
      };
    } catch (error) {
      event.target.checked = !active;
      this.toast("Rule not changed", reduceErrors(error), "error");
    }
  }

  async handleRuleAction(event) {
    const id = event.currentTarget.dataset.id;
    const action = event.detail.value;
    const rule = this.findRule(id);
    if (!rule) {
      return;
    }
    switch (action) {
      case "edit":
        await this.edit(rule);
        break;
      case "duplicate":
        await this.edit({
          ...rule,
          id: null,
          name: `${rule.name} (copy)`.slice(0, 80)
        });
        break;
      case "check":
        await this.check(id);
        break;
      case "test":
        await this.sendTest(rule);
        break;
      case "delete":
        await this.remove(rule);
        break;
      default:
        break;
    }
  }

  handleEditClick(event) {
    const rule = this.findRule(event.currentTarget.dataset.id);
    if (rule) {
      this.edit(rule);
    }
  }

  async sendTest(rule) {
    try {
      const sent = await sendApiAlertTest({ ruleId: rule.id });
      this.toast(
        "Test notification sent",
        sent.length
          ? `Delivered by ${sent.join(", ").toLowerCase()}. No alert was recorded.`
          : "No channel delivered the test."
      );
    } catch (error) {
      this.toast("Test failed", reduceErrors(error), "error");
    }
  }

  async remove(rule) {
    const confirmed = await LightningConfirm.open({
      message: `Delete the rule “${rule.name}” and its alert history?`,
      variant: "header",
      theme: "error",
      label: "Delete alert rule"
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteApiAlertRule({ ruleId: rule.id });
      this.toast("Alert rule deleted", rule.name);
      await this.load();
    } catch (error) {
      this.toast("Rule not deleted", reduceErrors(error), "error");
    }
  }

  // ---------- Historique des alertes ----------

  get eventFilterOptions() {
    return EVENT_FILTERS.map((option) => ({
      ...option,
      pressed: option.value === this.eventFilter ? "true" : "false",
      className: `filter${option.value === this.eventFilter ? " filter-on" : ""}`
    }));
  }

  handleEventFilter(event) {
    this.eventFilter = event.currentTarget.dataset.value;
  }

  get events() {
    return (this.view?.events || [])
      .filter((event) => this.eventFilter === "all" || event.status === "Open")
      .slice(0, 40)
      .map((event) => {
        const severityTone = SEVERITY_TONES[event.severity] || "neutral";
        return {
          ...event,
          when: formatRelative(event.firedAt),
          whenTitle: formatDateTime(event.firedAt),
          valueText: formatMetricValue(event.metric, event.value),
          thresholdText: formatThreshold(event),
          headline: (event.summary || "").split("\n")[0],
          statusTone: STATUS_TONES[event.status] || "neutral",
          className: `event event-${severityTone}${event.status === "Open" ? "" : " event-closed"}`,
          channelList: channelIcons(event.channels),
          taskUrl: event.taskId
            ? `/lightning/r/Task/${event.taskId}/view`
            : null,
          isOpen: event.status === "Open",
          isAcknowledged: event.status === "Acknowledged",
          isClosed: event.status === "Resolved",
          handledText:
            event.acknowledgedBy && event.status !== "Open"
              ? `${event.status} by ${event.acknowledgedBy} ${formatRelative(event.acknowledgedAt)}`
              : null
        };
      });
  }

  get hasEvents() {
    return this.events.length > 0;
  }

  get noEventText() {
    return this.eventFilter === "Open"
      ? "No open alert. All quiet."
      : "No alert has been fired yet.";
  }

  get hasOpenEvents() {
    return (this.view?.events || []).some((event) => event.status === "Open");
  }

  async changeStatus(ids, status) {
    try {
      await setApiAlertStatus({ alertIds: ids, status });
      await this.load();
    } catch (error) {
      this.toast("Alert not updated", reduceErrors(error), "error");
    }
  }

  handleAcknowledge(event) {
    this.changeStatus([event.currentTarget.dataset.id], "Acknowledged");
  }

  handleResolve(event) {
    this.changeStatus([event.currentTarget.dataset.id], "Resolved");
  }

  handleReopen(event) {
    this.changeStatus([event.currentTarget.dataset.id], "Open");
  }

  handleAcknowledgeAll() {
    const ids = (this.view?.events || [])
      .filter((event) => event.status === "Open")
      .map((event) => event.id);
    if (ids.length) {
      this.changeStatus(ids, "Acknowledged");
    }
  }

  // ---------- Types d'erreurs ----------

  get errorTypeRows() {
    const types = this.errorTypes?.types || [];
    const maxDaily = Math.max(1, ...types.flatMap((type) => type.daily || []));
    return types.map((type) => {
      const delta = type.last24h - type.previous24h;
      let trend = { label: "stable", className: "trend trend-flat", icon: "→" };
      if (type.last24h && !type.previous24h) {
        trend = { label: "new", className: "trend trend-up", icon: "●" };
      } else if (delta > 0) {
        trend = { label: `+${delta}`, className: "trend trend-up", icon: "↑" };
      } else if (delta < 0) {
        trend = { label: `${delta}`, className: "trend trend-down", icon: "↓" };
      }
      return {
        ...type,
        statusText: type.statusCode ? `${type.statusCode}` : "—",
        statusClass: `http http-${type.statusCode ? String(type.statusCode).charAt(0) : "0"}`,
        lastText: formatRelative(type.lastAt),
        lastTitle: formatDateTime(type.lastAt),
        trendText: `${trend.icon} ${trend.label}`,
        trendClass: trend.className,
        trendTitle: `${type.last24h} in the last 24 h, ${type.previous24h} the day before`,
        bars: (type.daily || []).map((count, index) => ({
          key: `${type.key}-${index}`,
          style: `height:${Math.max(count ? 12 : 4, Math.round((100 * count) / maxDaily))}%`,
          className: `bar${count ? " bar-on" : ""}`,
          title: `${count} error${count === 1 ? "" : "s"}`
        })),
        peakText: `peak ${type.peakPerHour}/h`
      };
    });
  }

  get hasErrorTypes() {
    return this.errorTypeRows.length > 0;
  }

  get errorTypesCaption() {
    const view = this.errorTypes;
    if (!view) {
      return "";
    }
    const text = `${formatNumber(view.errorCount)} error${view.errorCount === 1 ? "" : "s"} in the last ${view.periodDays} day${view.periodDays === 1 ? "" : "s"}`;
    return view.truncated ? `${text} (latest 2,000 grouped)` : text;
  }

  handleCreateFromType(event) {
    const type = (this.errorTypes?.types || []).find(
      (t) => t.key === event.currentTarget.dataset.key
    );
    if (!type) {
      return;
    }
    // Seuil suggéré : au-dessus du pic horaire observé, au moins 5
    const threshold = Math.max(5, (type.peakPerHour || 0) + 1);
    this.edit({
      name: `${type.systemName} — ${type.statusCode ? `HTTP ${type.statusCode} ` : ""}${type.containsHint || "errors"}`.slice(
        0,
        80
      ),
      systemName: type.systemName === "Other" ? "" : type.systemName,
      metric: "Errors",
      comparator: "AtLeast",
      threshold,
      windowMinutes: 60,
      statusCodes: type.statusCode ? String(type.statusCode) : "",
      errorContains: type.containsHint || "",
      severity:
        type.statusCode >= 500 || type.statusCode === 401 ? "High" : "Medium",
      cooldownMinutes: 60
    });
  }
}
