import { api } from "lwc";
import LightningModal from "lightning/modal";
import { formatDateTime, formatRelative, reduceErrors } from "c/orgIntelUtils";
import {
  CHANNELS,
  COMPARATORS,
  COOLDOWNS,
  METRICS,
  SEVERITY_OPTIONS,
  STATUS_SHORTCUTS,
  TEMPLATES,
  WINDOWS,
  describeRule,
  editableRule,
  formatMetricValue,
  formatThreshold,
  metricMeta,
  suggestName
} from "c/orgIntelApiAlertUtils";
import { moduleAction } from "c/orgIntelModuleApi";

// Actions Apex du module (via le contrôleur générique du socle)
const previewApiAlertRule = moduleAction(
  "apiMonitoring",
  "previewApiAlertRule"
);
const saveApiAlertRule = moduleAction("apiMonitoring", "saveApiAlertRule");

const PREVIEW_DELAY = 600;
const NOISY_FIRES = 20;

/**
 * Éditeur d'une règle d'alerte API : modèles, condition rédigée comme une phrase, filtres,
 * canaux, et aperçu en direct (simulation de la règle sur les 7 derniers jours).
 */
export default class OrgIntelApiAlertEditor extends LightningModal {
  /** Règle à modifier (RuleSpec), ou brouillon pré-rempli. */
  @api rule;
  /** Systèmes connus du journal. */
  @api systems = [];
  @api currentUser;

  draft;
  nameTouched = false;
  showFilters = false;
  preview;
  previewError;
  isPreviewing = false;
  isSaving = false;
  saveError;
  previewTimer;
  previewSequence = 0;

  metricOptions = METRICS.map((m) => ({ value: m.value, label: m.label }));
  comparatorOptions = COMPARATORS.map((c) => ({
    value: c.value,
    label: c.label
  }));
  windowOptions = WINDOWS;
  cooldownOptions = COOLDOWNS;
  severityOptions = SEVERITY_OPTIONS;

  connectedCallback() {
    this.draft = editableRule(this.rule, this.currentUser);
    this.nameTouched = !!this.draft.name;
    this.showFilters = !!(
      this.draft.operationContains ||
      this.draft.statusCodes ||
      this.draft.errorContains
    );
    this.refreshName();
    this.schedulePreview(0);
  }

  disconnectedCallback() {
    clearTimeout(this.previewTimer);
  }

  // ---------- En-tête ----------

  get isNew() {
    return !this.draft?.id;
  }

  get headerLabel() {
    return this.isNew ? "New alert rule" : "Edit alert rule";
  }

  get templates() {
    return TEMPLATES.map((template) => ({
      ...template,
      className: `template tone-${template.tone}`
    }));
  }

  handleTemplate(event) {
    const template = TEMPLATES.find(
      (t) => t.key === event.currentTarget.dataset.key
    );
    if (!template) {
      return;
    }
    this.draft = {
      ...this.draft,
      operationContains: "",
      statusCodes: "",
      errorContains: "",
      ...template.rule,
      systemName: this.draft.systemName
    };
    this.nameTouched = false;
    this.showFilters = !!this.draft.statusCodes;
    this.refreshName();
    this.schedulePreview();
  }

  // ---------- Condition ----------

  get systemOptions() {
    const names = new Set(this.systems || []);
    if (this.draft.systemName) {
      names.add(this.draft.systemName);
    }
    return [
      { value: "", label: "all systems" },
      ...[...names].sort().map((name) => ({ value: name, label: name }))
    ];
  }

  get windowValue() {
    return String(this.draft.windowMinutes);
  }

  get cooldownValue() {
    return String(this.draft.cooldownMinutes ?? 60);
  }

  get metricHelp() {
    return metricMeta(this.draft.metric).help;
  }

  get thresholdStep() {
    return this.draft.metric === "ErrorRate" ? "0.1" : "1";
  }

  get thresholdUnit() {
    const metric = this.draft.metric;
    if (metric === "ErrorRate") {
      return "%";
    }
    if (metric === "AvgDuration") {
      return "ms";
    }
    return metricMeta(metric).label;
  }

  get isSlowCalls() {
    return this.draft.metric === "SlowCalls";
  }

  get isErrorRate() {
    return this.draft.metric === "ErrorRate";
  }

  get isSilence() {
    return this.draft.metric === "Calls" && this.draft.comparator === "AtMost";
  }

  get sentence() {
    return `${describeRule(this.draft)}.`;
  }

  get filtersLabel() {
    return this.showFilters
      ? "Hide filters"
      : "Refine: status, operation, error text";
  }

  get filtersIcon() {
    return this.showFilters ? "utility:chevronup" : "utility:filterList";
  }

  get statusShortcuts() {
    const current = (this.draft.statusCodes || "").replace(/\s/g, "");
    return STATUS_SHORTCUTS.map((shortcut) => {
      const pressed = current === shortcut.value.replace(/\s/g, "");
      return {
        ...shortcut,
        pressed: pressed ? "true" : "false",
        className: `chip${pressed ? " chip-on" : ""}`
      };
    });
  }

  handleToggleFilters() {
    this.showFilters = !this.showFilters;
  }

  handleStatusShortcut(event) {
    const value = event.currentTarget.dataset.value;
    const current = (this.draft.statusCodes || "").replace(/\s/g, "");
    this.update(
      "statusCodes",
      current === value.replace(/\s/g, "") ? "" : value
    );
  }

  handleField(event) {
    const field = event.currentTarget.dataset.field;
    let value =
      event.detail && event.detail.value !== undefined
        ? event.detail.value
        : event.target.value;
    if (
      [
        "threshold",
        "windowMinutes",
        "cooldownMinutes",
        "slowThresholdMs",
        "minimumCalls"
      ].includes(field)
    ) {
      value = value === "" || value === null ? null : Number(value);
    }
    this.update(field, value);
  }

  handleName(event) {
    this.nameTouched = true;
    this.draft = { ...this.draft, name: event.target.value };
  }

  handleDescription(event) {
    this.draft = { ...this.draft, description: event.target.value };
  }

  handleActive(event) {
    this.draft = { ...this.draft, active: event.target.checked };
  }

  update(field, value) {
    this.draft = { ...this.draft, [field]: value };
    this.refreshName();
    if (
      ![
        "recipients",
        "taskOwnerId",
        "severity",
        "channels",
        "description"
      ].includes(field)
    ) {
      this.schedulePreview();
    }
  }

  refreshName() {
    if (!this.nameTouched) {
      this.draft = { ...this.draft, name: suggestName(this.draft) };
    }
  }

  // ---------- Notifications ----------

  get channels() {
    const selected = this.draft.channels || [];
    return CHANNELS.map((channel) => {
      const on = selected.includes(channel.value);
      return {
        ...channel,
        pressed: on ? "true" : "false",
        className: `channel${on ? " channel-on" : ""}`
      };
    });
  }

  get hasEmail() {
    return (this.draft.channels || []).includes("Email");
  }

  get needsOwner() {
    const channels = this.draft.channels || [];
    return channels.includes("Task") || channels.includes("Notification");
  }

  handleChannel(event) {
    const value = event.currentTarget.dataset.value;
    const channels = new Set(this.draft.channels || []);
    if (channels.has(value)) {
      channels.delete(value);
    } else {
      channels.add(value);
    }
    this.update(
      "channels",
      CHANNELS.map((c) => c.value).filter((c) => channels.has(c))
    );
  }

  handleAddMe() {
    const email = this.currentUser?.email;
    if (!email) {
      return;
    }
    const list = (this.draft.recipients || "").split(/[,;\s]+/).filter(Boolean);
    if (!list.includes(email)) {
      list.push(email);
    }
    this.update("recipients", list.join(", "));
  }

  handleOwner(event) {
    this.update("taskOwnerId", event.detail.recordId || null);
  }

  // ---------- Aperçu ----------

  schedulePreview(delay = PREVIEW_DELAY) {
    clearTimeout(this.previewTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.previewTimer = setTimeout(() => this.runPreview(), delay);
  }

  async runPreview() {
    if (this.draft.threshold === null || this.draft.threshold === undefined) {
      return;
    }
    const sequence = ++this.previewSequence;
    this.isPreviewing = true;
    try {
      const result = await previewApiAlertRule({
        ruleJson: JSON.stringify(this.payload())
      });
      if (sequence === this.previewSequence) {
        this.preview = result;
        this.previewError = undefined;
      }
    } catch (error) {
      if (sequence === this.previewSequence) {
        this.previewError = reduceErrors(error);
      }
    } finally {
      if (sequence === this.previewSequence) {
        this.isPreviewing = false;
      }
    }
  }

  get hasPreview() {
    return !!this.preview;
  }

  get previewHeadline() {
    const fires = this.preview?.fires || 0;
    if (!fires) {
      return "Would not have fired in the last 7 days";
    }
    return `Would have fired ${fires} time${fires === 1 ? "" : "s"} in the last 7 days`;
  }

  get previewTone() {
    const fires = this.preview?.fires || 0;
    if (fires >= NOISY_FIRES) {
      return "verdict verdict-noisy";
    }
    return fires ? "verdict verdict-fires" : "verdict verdict-quiet";
  }

  get previewDetail() {
    const preview = this.preview;
    if (!preview) {
      return "";
    }
    const parts = [];
    if (preview.lastFireAt) {
      parts.push(`last ${formatRelative(preview.lastFireAt)}`);
    }
    parts.push(
      `${preview.matchedCalls} matching call${preview.matchedCalls === 1 ? "" : "s"}, ${preview.matchedErrors} error${preview.matchedErrors === 1 ? "" : "s"}`
    );
    if (preview.maxValue !== null && preview.maxValue !== undefined) {
      parts.push(
        `peak ${formatMetricValue(this.draft.metric, preview.maxValue)}`
      );
    }
    return parts.join(" · ");
  }

  get nowText() {
    const preview = this.preview;
    if (!preview) {
      return "";
    }
    const value = formatMetricValue(this.draft.metric, preview.currentValue);
    return preview.breachingNow
      ? `Right now: ${value} — the threshold (${formatThreshold(this.draft)}) is reached.`
      : `Right now: ${value} (threshold ${formatThreshold(this.draft)}).`;
  }

  get nowClass() {
    return `now${this.preview?.breachingNow ? " now-hot" : ""}`;
  }

  /** Conseil selon la simulation : trop bruyante, jamais atteinte, données tronquées. */
  get advice() {
    const preview = this.preview;
    if (!preview) {
      return null;
    }
    if (preview.fires >= NOISY_FIRES) {
      return "This rule would be noisy: raise the threshold, widen the window or lengthen the cooldown.";
    }
    if (
      !preview.fires &&
      !this.isSilence &&
      preview.maxValue !== null &&
      preview.maxValue !== undefined &&
      Number(preview.maxValue) > 0
    ) {
      return `Never reached in 7 days: the highest value was ${formatMetricValue(this.draft.metric, preview.maxValue)}. Good for rare incidents.`;
    }
    if (preview.truncated) {
      return "High volume: the simulation used the 20,000 most recent calls only.";
    }
    return null;
  }

  get topErrors() {
    return (this.preview?.topErrors || []).map((type) => ({
      ...type,
      statusText: type.statusCode ? `HTTP ${type.statusCode}` : "No status",
      countText: `${type.count}×`,
      lastText: formatDateTime(type.lastAt)
    }));
  }

  get hasTopErrors() {
    return this.topErrors.length > 0;
  }

  handleUseHint(event) {
    const hint = event.currentTarget.dataset.hint;
    if (hint) {
      this.showFilters = true;
      this.update("errorContains", hint);
    }
  }

  // ---------- Enregistrement ----------

  payload() {
    const draft = this.draft;
    return {
      ...draft,
      systemName: draft.systemName || null,
      threshold:
        draft.threshold === null || draft.threshold === undefined
          ? null
          : Number(draft.threshold),
      windowMinutes: Number(draft.windowMinutes),
      cooldownMinutes: Number(draft.cooldownMinutes ?? 60),
      slowThresholdMs: draft.slowThresholdMs
        ? Number(draft.slowThresholdMs)
        : null,
      minimumCalls: draft.minimumCalls ? Number(draft.minimumCalls) : null
    };
  }

  get saveLabel() {
    return this.isNew ? "Create rule" : "Save";
  }

  handleCancel() {
    this.close(null);
  }

  async handleSave() {
    const inputs = [
      ...this.template.querySelectorAll(
        "lightning-input, lightning-textarea, lightning-combobox"
      )
    ];
    const valid = inputs.reduce(
      (ok, input) => input.reportValidity() && ok,
      true
    );
    if (!valid) {
      return;
    }
    this.isSaving = true;
    this.saveError = undefined;
    try {
      const id = await saveApiAlertRule({
        ruleJson: JSON.stringify(this.payload())
      });
      this.close({ id, name: this.draft.name, created: this.isNew });
    } catch (error) {
      this.saveError = reduceErrors(error);
    } finally {
      this.isSaving = false;
    }
  }
}
