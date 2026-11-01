/**
 * Référentiels et fonctions pures des alertes API (règles OrgApiAlertRule__c).
 * Aucune dépendance à la plateforme : testable directement sous Jest.
 */

export const METRICS = [
  {
    value: "Errors",
    label: "errors",
    noun: "error",
    unit: "",
    icon: "utility:error",
    help: "Number of failed calls in the window."
  },
  {
    value: "Calls",
    label: "calls",
    noun: "call",
    unit: "",
    icon: "utility:sync",
    help: "Number of calls in the window — with “at most”, detects an integration that went silent."
  },
  {
    value: "ErrorRate",
    label: "error rate",
    noun: "%",
    unit: "%",
    icon: "utility:percent",
    help: "Share of failed calls, evaluated only above a minimum number of calls."
  },
  {
    value: "AvgDuration",
    label: "average duration",
    noun: "ms",
    unit: " ms",
    icon: "utility:clock",
    help: "Average response time of the calls in the window."
  },
  {
    value: "SlowCalls",
    label: "slow calls",
    noun: "slow call",
    unit: "",
    icon: "utility:clock",
    help: "Calls slower than a duration you choose."
  }
];

export const COMPARATORS = [
  { value: "AtLeast", label: "at least", symbol: "≥" },
  { value: "AtMost", label: "at most", symbol: "≤" }
];

export const WINDOWS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "720", label: "12 hours" },
  { value: "1440", label: "24 hours" },
  { value: "10080", label: "7 days" }
];

export const COOLDOWNS = [
  { value: "0", label: "Every check" },
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "24 hours" }
];

export const SEVERITY_OPTIONS = [
  { value: "Critical", label: "Critical" },
  { value: "High", label: "High" },
  { value: "Medium", label: "Medium" },
  { value: "Low", label: "Low" }
];

export const SEVERITY_TONES = {
  Critical: "critical",
  High: "serious",
  Medium: "warning",
  Low: "low",
  Info: "neutral"
};

export const CHANNELS = [
  {
    value: "Email",
    label: "Email",
    icon: "utility:email",
    help: "Sends a summary with sample errors to the recipients."
  },
  {
    value: "Task",
    label: "Task",
    icon: "utility:task",
    help: "Creates a Salesforce task, related to the rule, for its owner."
  },
  {
    value: "Notification",
    label: "Bell",
    icon: "utility:notification",
    help: "Salesforce notification (bell and mobile) to the task owner."
  }
];

/** Raccourcis de codes HTTP proposés dans l'éditeur. */
export const STATUS_SHORTCUTS = [
  { value: "401, 403", label: "Auth 401/403" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
  { value: "429", label: "Rate limit 429" },
  { value: "0", label: "No response" }
];

/** Modèles prêts à l'emploi. */
export const TEMPLATES = [
  {
    key: "repeated",
    title: "Repeated errors",
    description: "7 errors or more on a system within 1 hour.",
    icon: "utility:error",
    tone: "serious",
    rule: {
      name: "Repeated errors",
      metric: "Errors",
      comparator: "AtLeast",
      threshold: 7,
      windowMinutes: 60,
      severity: "High",
      cooldownMinutes: 60
    }
  },
  {
    key: "auth",
    title: "Authentication failures",
    description: "Expired token or revoked access: 3 × 401/403 in 30 minutes.",
    icon: "utility:lock",
    tone: "critical",
    rule: {
      name: "Authentication failures",
      metric: "Errors",
      comparator: "AtLeast",
      threshold: 3,
      windowMinutes: 30,
      statusCodes: "401, 403",
      severity: "Critical",
      cooldownMinutes: 240
    }
  },
  {
    key: "server",
    title: "Server errors spike",
    description: "5 server errors (5xx) or more within 15 minutes.",
    icon: "utility:database",
    tone: "serious",
    rule: {
      name: "Server errors spike",
      metric: "Errors",
      comparator: "AtLeast",
      threshold: 5,
      windowMinutes: 15,
      statusCodes: "5xx",
      severity: "High",
      cooldownMinutes: 60
    }
  },
  {
    key: "slow",
    title: "Slow calls",
    description: "10 calls slower than 5 s within 1 hour.",
    icon: "utility:clock",
    tone: "warning",
    rule: {
      name: "Slow calls",
      metric: "SlowCalls",
      comparator: "AtLeast",
      threshold: 10,
      windowMinutes: 60,
      slowThresholdMs: 5000,
      severity: "Medium",
      cooldownMinutes: 240
    }
  },
  {
    key: "rate",
    title: "Error rate",
    description: "More than 20% of calls fail over 1 hour (at least 20 calls).",
    icon: "utility:percent",
    tone: "warning",
    rule: {
      name: "High error rate",
      metric: "ErrorRate",
      comparator: "AtLeast",
      threshold: 20,
      windowMinutes: 60,
      minimumCalls: 20,
      severity: "High",
      cooldownMinutes: 120
    }
  },
  {
    key: "silent",
    title: "Integration went silent",
    description: "No call at all from a system for 12 hours.",
    icon: "utility:hide",
    tone: "low",
    rule: {
      name: "Integration silent",
      metric: "Calls",
      comparator: "AtMost",
      threshold: 0,
      windowMinutes: 720,
      severity: "High",
      cooldownMinutes: 1440
    }
  }
];

export function metricMeta(value) {
  return METRICS.find((metric) => metric.value === value) || METRICS[0];
}

export function windowLabel(minutes) {
  const value = Number(minutes) || 0;
  const known = WINDOWS.find((item) => Number(item.value) === value);
  if (known) {
    return known.label;
  }
  if (value >= 1440 && value % 1440 === 0) {
    return `${value / 1440} days`;
  }
  if (value >= 60 && value % 60 === 0) {
    return `${value / 60} hours`;
  }
  return `${value} minutes`;
}

function plainNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "?";
  }
  return String(Number(value));
}

/** Valeur mesurée lisible : « 9 errors », « 23.5% », « 840 ms ». */
export function formatMetricValue(metric, value) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  const number = Number(value);
  switch (metric) {
    case "ErrorRate":
      return `${Math.round(number * 10) / 10}%`;
    case "AvgDuration":
      return `${Math.round(number)} ms`;
    case "SlowCalls":
      return `${number} slow call${number === 1 ? "" : "s"}`;
    case "Calls":
      return `${number} call${number === 1 ? "" : "s"}`;
    default:
      return `${number} error${number === 1 ? "" : "s"}`;
  }
}

/** Seuil lisible : « ≥ 7 », « ≤ 0 », « ≥ 20% ». */
export function formatThreshold(rule) {
  const symbol =
    COMPARATORS.find((c) => c.value === rule.comparator)?.symbol || "≥";
  return `${symbol} ${plainNumber(rule.threshold)}${metricMeta(rule.metric).unit}`;
}

/** Règle en une phrase, comme dans le constructeur. */
export function describeRule(rule) {
  const metric = metricMeta(rule.metric);
  const comparator =
    COMPARATORS.find((c) => c.value === rule.comparator)?.label || "at least";
  const filters = [];
  if (rule.operationContains) {
    filters.push(`operation contains “${rule.operationContains}”`);
  }
  if (rule.statusCodes) {
    filters.push(`status ${rule.statusCodes}`);
  }
  if (rule.errorContains) {
    filters.push(`error contains “${rule.errorContains}”`);
  }
  if (rule.metric === "SlowCalls") {
    filters.push(`slower than ${plainNumber(rule.slowThresholdMs || 5000)} ms`);
  }
  if (rule.metric === "ErrorRate") {
    filters.push(`min. ${plainNumber(rule.minimumCalls || 10)} calls`);
  }
  const scope = rule.systemName || "all systems";
  return `When ${metric.label} on ${scope}${filters.length ? ` (${filters.join(", ")})` : ""} is ${comparator} ${plainNumber(rule.threshold)}${metric.unit} within ${windowLabel(rule.windowMinutes)}`;
}

/** Nom proposé tant que l'utilisateur n'a pas saisi le sien. */
export function suggestName(rule) {
  const metric = metricMeta(rule.metric);
  const scope = rule.systemName || "all systems";
  const what =
    rule.metric === "Calls" && rule.comparator === "AtMost"
      ? "No traffic"
      : `${metric.label.charAt(0).toUpperCase()}${metric.label.slice(1)}`;
  const status = rule.statusCodes ? ` ${rule.statusCodes}` : "";
  return `${what}${status} on ${scope}`.slice(0, 80);
}

export function emptyRule(user) {
  return {
    id: null,
    name: "",
    active: true,
    description: "",
    systemName: "",
    operationContains: "",
    metric: "Errors",
    comparator: "AtLeast",
    threshold: 7,
    windowMinutes: 60,
    statusCodes: "",
    errorContains: "",
    slowThresholdMs: 5000,
    minimumCalls: 10,
    severity: "High",
    channels: ["Email", "Task"],
    recipients: user?.email || "",
    taskOwnerId: user?.id || null,
    cooldownMinutes: 60
  };
}

/** Copie éditable d'une règle (RuleSpec Apex) ; les champs calculés sont écartés. */
export function editableRule(rule, user) {
  const base = emptyRule(user);
  const result = { ...base };
  Object.keys(base).forEach((key) => {
    if (rule && rule[key] !== undefined && rule[key] !== null) {
      result[key] = Array.isArray(rule[key]) ? [...rule[key]] : rule[key];
    }
  });
  return result;
}

/** Icônes des canaux notifiés (liste ou valeur multi-sélection « Email;Task »). */
export function channelIcons(channels) {
  const list = Array.isArray(channels)
    ? channels
    : (channels || "").split(";").filter(Boolean);
  return CHANNELS.filter((channel) => list.includes(channel.value)).map(
    (channel) => ({
      key: channel.value,
      icon: channel.icon,
      label: channel.label
    })
  );
}
