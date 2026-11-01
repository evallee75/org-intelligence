/**
 * Référentiels et fonctions pures partagés par les composants Org Intelligence.
 * Aucune dépendance à la plateforme : testable directement sous Jest.
 */

/**
 * Sections de la navigation, dans l'ordre d'une démarche d'analyse et regroupées (`group` :
 * Analysis, Plan & track, Technical, Administration ; la vue d'ensemble n'a pas de groupe).
 * `hidden` : section joignable par lien (détail d'un scan) mais absente du menu. `adminOnly` : contenu réservé aux administrateurs Org Intelligence
 * (contrôlé côté serveur ; l'interface l'annonce simplement). `module` : section fournie par un
 * module optionnel, masquée quand il n'est pas installé (cf. sectionsFor).
 */
export const SECTIONS = [
  {
    name: "overview",
    label: "Overview",
    icon: "utility:home",
    available: true,
    description: "Health of the org, latest scan and priority recommendations."
  },
  {
    hidden: true,
    group: "Analysis",
    name: "scanner",
    label: "Org Scanner",
    icon: "utility:search",
    available: true,
    description:
      "Inventories Apex classes, triggers, flows, objects, fields and validation rules, then applies explicit rules to produce findings."
  },
  {
    group: "Analysis",
    name: "fieldUsage",
    module: "fieldUsage",
    label: "Objects & Fields",
    icon: "utility:table",
    available: true,
    adminOnly: true,
    description:
      "Fill rate, layouts and dependencies of the fields of an object, with clean-up recommendations."
  },
  {
    group: "Analysis",
    name: "objectSetup",
    module: "fieldUsage",
    label: "Object Setup",
    icon: "utility:layout",
    available: true,
    adminOnly: true,
    description:
      "Record types, page layouts and their assignments, Lightning record pages (Dynamic Forms) and compact layouts of an object, with simplification findings."
  },
  {
    group: "Analysis",
    name: "security",
    module: "security",
    label: "Security",
    icon: "utility:shield",
    available: true,
    adminOnly: true,
    description:
      "Security audit of the org: privileged access, MFA, profiles and permission sets, guest and sharing exposure, with a printable report."
  },
  {
    group: "Analysis",
    name: "permissions",
    module: "security",
    label: "Profiles & Permission Sets",
    icon: "utility:user_role",
    available: true,
    adminOnly: true,
    description:
      "Profiles, permission sets and groups: object and field access, comparisons, user assignments and clean-up findings."
  },
  {
    group: "Analysis",
    name: "automation",
    label: "Automation",
    icon: "utility:flow",
    available: true,
    description:
      "Org-wide automation map, order of execution per object, conflicts, loops and exports."
  },
  {
    group: "Analysis",
    name: "inventory",
    module: "inventory",
    label: "Inventory",
    icon: "utility:list",
    available: true,
    adminOnly: true,
    description:
      "Every Visualforce page, component, label, resource, template, layout, report, role and group, with what to clean up. Nothing is stored in the org."
  },
  {
    group: "Analysis",
    name: "adoption",
    module: "adoption",
    label: "Adoption",
    icon: "utility:trending",
    available: true,
    adminOnly: true,
    description:
      "Licenses paid versus used, inactive users, and the native Salesforce features your org uses or ignores."
  },
  {
    group: "Analysis",
    name: "storage",
    label: "Storage",
    icon: "utility:archive",
    available: true,
    description:
      "Data and file storage, records per object and their growth, largest files."
  },
  {
    group: "Plan & track",
    name: "recommendations",
    // Socle : recommandations gardées dans le navigateur, ou partagées avec le module collaboratif
    label: "Recommendations",
    icon: "utility:task",
    available: true,
    description:
      "Review, decide and track the recommendations generated from findings (assignment and comments with the collaborative module)."
  },
  {
    group: "Plan & track",
    name: "roadmap",
    // Socle : recommandations gardées dans le navigateur, ou partagées avec le module collaboratif
    label: "Roadmap",
    icon: "utility:date_time",
    available: true,
    description:
      "In which order to fix the recommendations: filter by theme, set your capacity and get a timeline. Computed in your browser."
  },
  {
    group: "Plan & track",
    name: "reports",
    label: "Reports",
    icon: "utility:chart",
    available: true,
    description:
      "Trends over time, and native Salesforce reports with the collaborative Recommendations module."
  },
  {
    group: "Plan & track",
    name: "contextHub",
    module: "contextHub",
    label: "Context Hub",
    icon: "utility:share",
    available: true,
    description:
      "Select a recommendation, preview a Markdown context and export it to an external AI tool. Nothing is ever sent automatically."
  },
  {
    group: "Technical",
    name: "apiMonitoring",
    module: "apiMonitoring",
    label: "API Monitoring",
    icon: "utility:connected_apps",
    available: true,
    adminOnly: true,
    description:
      "Log of API calls, consumption of the org limits and API logins."
  },
  {
    group: "Administration",
    name: "modules",
    label: "Modules",
    icon: "utility:apps",
    available: true,
    adminOnly: true,
    description:
      "Choose the optional modules to install and get access to them."
  },
  {
    group: "Administration",
    name: "settings",
    label: "Settings",
    icon: "utility:settings",
    available: true,
    adminOnly: true,
    description:
      "Tooling API connection, rule catalog, health score and browser data."
  }
];

export const DEFAULT_SECTION = "overview";

export function findSection(name) {
  return SECTIONS.find((section) => section.name === name);
}

/** Sections visibles : celles du socle et celles des modules installés (clés de modules). */
export function sectionsFor(installedModules = []) {
  return SECTIONS.filter(
    (section) => !section.module || installedModules.includes(section.module)
  );
}

/** Guide d'installation (dépôt public du projet). */
export const INSTALL_GUIDE_URL =
  "https://github.com/evallee75/org-intelligence/blob/main/docs/INSTALL.md";

/**
 * Modules optionnels. `packageVersionId` : version de package (04t...) proposée par l'écran Modules,
 * à mettre à jour à chaque publication (docs/PACKAGING.md) ; vide = renvoi vers le guide
 * d'installation. `objects` : objets ajoutés par le module (libellés affichés). Le dossier du dépôt
 * est modules/<folder>.
 */
export const OPTIONAL_MODULES = [
  {
    key: "recommendations",
    label: "Recommendations (collaborative)",
    folder: "recommendations",
    section: "recommendations",
    packageVersionId: "",
    objects: ["Recommendation"],
    description:
      "Share recommendations in the org: assignment, Chatter comments and mentions, Jira API export, native reports and dashboard. Without it, recommendations stay in each browser."
  },
  {
    key: "contextHub",
    label: "Context Hub",
    folder: "context-hub",
    section: "contextHub",
    packageVersionId: "",
    objects: [],
    description:
      "Export the context of findings and recommendations (Markdown, secrets masked) to an external AI assistant."
  },
  {
    key: "apiMonitoring",
    label: "API Monitoring",
    folder: "api-monitoring",
    section: "apiMonitoring",
    packageVersionId: "",
    objects: ["API Log", "API Alert Rule", "API Alert Event"],
    description:
      "Log of API calls (Tooling API, integrations), org API usage and alerts by email, task or notification."
  },
  {
    key: "fieldUsage",
    label: "Objects & Fields",
    folder: "field-usage",
    section: "fieldUsage",
    packageVersionId: "",
    objects: [],
    description:
      "Fill rate, layouts and dependencies of the fields of an object, with clean-up suggestions."
  },
  {
    key: "adoption",
    label: "Adoption",
    folder: "adoption",
    section: "adoption",
    packageVersionId: "",
    objects: [],
    description:
      "Are you using all of Salesforce? Licenses paid versus used, inactive users, unused add-ons, and adoption of native Sales Cloud, Service Cloud and platform features."
  },
  {
    key: "security",
    label: "Security",
    folder: "security",
    section: "security",
    packageVersionId: "",
    objects: [],
    description:
      "Security audit: administrators, MFA, dormant accounts, risky profiles and permission sets, guest access, sharing defaults, public links, Health Check; printable report."
  },
  {
    key: "inventory",
    label: "Inventory",
    folder: "inventory",
    section: "inventory",
    packageVersionId: "",
    objects: [],
    description:
      "Inventory of Visualforce, Aura and LWC components, labels, static resources, templates, layouts, record types, workflows, reports, dashboards, roles, groups, packages and browsers, with clean-up hints."
  }
];

/** Gravités, de la plus forte à la plus faible. `tone` pilote la couleur, jamais seule porteuse de sens. */
export const SEVERITIES = [
  { value: "Critical", label: "Critical", tone: "critical", points: 10 },
  { value: "High", label: "High", tone: "serious", points: 5 },
  { value: "Medium", label: "Medium", tone: "warning", points: 2 },
  { value: "Low", label: "Low", tone: "low", points: 0.5 },
  { value: "Info", label: "Info", tone: "neutral", points: 0 }
];

export function severityMeta(value) {
  return (
    SEVERITIES.find((severity) => severity.value === value) || {
      value,
      label: value || "Unknown",
      tone: "neutral",
      points: 0
    }
  );
}

export const SCAN_STATUS_TONES = {
  Queued: "info",
  Running: "info",
  Completed: "good",
  "Completed with errors": "warning",
  Failed: "critical"
};

export function scanStatusTone(status) {
  return SCAN_STATUS_TONES[status] || "neutral";
}

/** Libellés des types de composants (valeurs du value set OrgIntelComponentType). */
export const COMPONENT_TYPES = [
  { value: "ApexClass", label: "Apex class" },
  { value: "ApexTrigger", label: "Apex trigger" },
  { value: "Flow", label: "Flow" },
  { value: "CustomObject", label: "Object" },
  { value: "CustomField", label: "Custom field" },
  { value: "ValidationRule", label: "Validation rule" }
];

export function componentTypeLabel(value) {
  return (
    COMPONENT_TYPES.find((type) => type.value === value)?.label || value || ""
  );
}

/** Périmètres de scan (valeurs acceptées par OrgScanRunner.start). */
export const SCAN_SCOPES = [
  { value: "ApexClass", label: "Apex classes", tooling: false },
  { value: "ApexTrigger", label: "Apex triggers", tooling: false },
  { value: "Flow", label: "Flows and Process Builder", tooling: false },
  { value: "CustomObject", label: "Objects and fields", tooling: false },
  { value: "ValidationRule", label: "Validation rules", tooling: true },
  { value: "Dependency", label: "Dependencies", tooling: true },
  { value: "Storage", label: "Storage (records and files)", tooling: false }
];

/** Icône de datatable par gravité (la couleur ne traverse pas la datatable, l'icône si). */
export function severityIcon(value) {
  switch (value) {
    case "Critical":
    case "High":
      return "utility:error";
    case "Medium":
      return "utility:warning";
    default:
      return "utility:info";
  }
}

export function isScanInProgress(status) {
  return status === "Queued" || status === "Running";
}

/**
 * Méthode du score de santé, affichée telle quelle dans l'application.
 * À tenir alignée sur le calcul Apex (HealthScoreService).
 */
export const SCORE_METHOD = {
  start: 100,
  ruleCap: 15,
  weights: SEVERITIES.map(({ label, points }) => ({ label, points }))
};

/** Bandes de lecture du score. */
export function scoreBand(score) {
  if (score === null || score === undefined) {
    return { label: "Not available", tone: "neutral" };
  }
  if (score >= 85) {
    return { label: "Healthy", tone: "good" };
  }
  if (score >= 70) {
    return { label: "Fair", tone: "warning" };
  }
  if (score >= 50) {
    return { label: "Needs attention", tone: "serious" };
  }
  return { label: "At risk", tone: "critical" };
}

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});
const PLAIN = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const number = Number(value);
  return Math.abs(number) >= 10000
    ? COMPACT.format(number)
    : PLAIN.format(number);
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const RELATIVE_STEPS = [
  { unit: "year", seconds: 31536000 },
  { unit: "month", seconds: 2592000 },
  { unit: "week", seconds: 604800 },
  { unit: "day", seconds: 86400 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 }
];

/** « 3 hours ago », « yesterday »… ; « just now » sous la minute. */
export function formatRelative(value, now = new Date()) {
  if (!value) {
    return "—";
  }
  const elapsed = (new Date(value).getTime() - now.getTime()) / 1000;
  const step = RELATIVE_STEPS.find(
    ({ seconds }) => Math.abs(elapsed) >= seconds
  );
  if (!step) {
    return "just now";
  }
  return RELATIVE.format(Math.round(elapsed / step.seconds), step.unit);
}

/** Durée lisible entre deux instants : « 2 min 14 s », « 45 s ». */
export function formatDuration(start, end) {
  if (!start || !end) {
    return null;
  }
  const total = Math.max(
    0,
    Math.round((new Date(end) - new Date(start)) / 1000)
  );
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) {
    return `${hours} h ${minutes} min`;
  }
  return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

/** Message lisible à partir d'une erreur Apex, LDS ou JavaScript. */
export function reduceErrors(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  const messages = list
    .filter((error) => !!error)
    .flatMap((error) => {
      if (typeof error === "string") {
        return [error];
      }
      if (Array.isArray(error.body)) {
        return error.body.map((entry) => entry.message);
      }
      if (error.body?.pageErrors?.length) {
        return error.body.pageErrors.map((entry) => entry.message);
      }
      if (error.body?.message) {
        return [error.body.message];
      }
      if (error.message) {
        return [error.message];
      }
      return [error.statusText || "Unknown error"];
    })
    .filter((message) => !!message);
  return messages.length ? [...new Set(messages)].join(" ") : "Unknown error";
}

/** Statuts d'une recommandation et leur teinte. */
export const REC_STATUSES = [
  { value: "New", label: "New", tone: "info" },
  { value: "To Review", label: "To Review", tone: "warning" },
  { value: "Accepted", label: "Accepted", tone: "low" },
  { value: "Ignored", label: "Ignored", tone: "neutral" },
  { value: "Resolved", label: "Resolved", tone: "good" }
];

export function recStatusTone(value) {
  return (
    REC_STATUSES.find((status) => status.value === value)?.tone || "neutral"
  );
}

export const OPEN_STATUSES = ["New", "To Review", "Accepted"];

/** Date courte (« 15 Oct 2026 »), ou tiret. */
export function formatDate(value) {
  if (!value) {
    return "—";
  }
  const date =
    typeof value === "string" && value.length === 10
      ? new Date(`${value}T00:00:00`)
      : new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(date);
}

export function formatDateTime(value) {
  if (!value) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

/** Date du jour au format AAAA-MM-JJ (fuseau du navigateur). */
export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

/** CSV (séparateur « ; », compatible Excel FR) à partir de colonnes {label, value(row)}. */
export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((column) => escape(column.label)).join(";");
  const lines = rows.map((row) =>
    columns.map((column) => escape(column.value(row))).join(";")
  );
  return [header, ...lines].join("\r\n");
}

/**
 * Téléchargement d'un fichier texte. Locker / LWS refuse certains blobs : on passe par une URL
 * « data: » encodée, acceptée partout.
 */
export function downloadText(fileName, content, mimeType = "text/plain") {
  const link = document.createElement("a");
  link.href = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Copie dans le presse-papiers ; repli sur une zone de texte temporaire si l'API est refusée. */
export async function copyText(content) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch {
    // repli ci-dessous
  }
  const area = document.createElement("textarea");
  area.value = content;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
}

/**
 * Domaines des recommandations (champ formule OrgRecommendation__c.Domain__c, déduit du préfixe de
 * la règle). « Other » n'apparaît que s'il contient des recommandations.
 */
export const REC_DOMAINS = [
  {
    value: "Apex",
    label: "Apex",
    icon: "utility:apex",
    color: "#0b5cab",
    description:
      "Classes and triggers: security, performance, tests, API versions."
  },
  {
    value: "Flows & Automation",
    label: "Flows & Automation",
    icon: "utility:flow",
    color: "#7f56d9",
    description: "Flows, Process Builder and automation mixed on objects."
  },
  {
    value: "Data Model",
    label: "Data Model",
    icon: "utility:database",
    color: "#0e9384",
    description: "Objects and custom fields: limits and documentation."
  },
  {
    value: "Data Quality",
    label: "Data Quality",
    icon: "utility:approval",
    color: "#dd6b20",
    description: "Validation rules that guard data quality."
  },
  {
    value: "Storage",
    label: "Storage",
    icon: "utility:archive",
    color: "#b54708",
    description: "Data and file storage: volumes, growth, retention."
  },
  {
    value: "Adoption",
    label: "Adoption",
    icon: "utility:trending",
    color: "#2e7d32",
    description:
      "Licenses to reclaim, unused add-ons and native features not used yet."
  },
  {
    value: "Security",
    label: "Security",
    icon: "utility:shield",
    color: "#a4231a",
    description:
      "Privileged access, MFA, profiles, permission sets and data exposure."
  },
  {
    value: "Other",
    label: "Other",
    icon: "utility:apps",
    color: "#5c6470",
    description: "Recommendations outside the domains above."
  }
];

// ---------- Export Excel / CSV ----------

/** Formats d'export proposés partout dans l'application. */
export const EXPORT_FORMATS = [
  { value: "xlsx", label: "Excel (.xlsx)", icon: "doctype:excel" },
  { value: "csv", label: "CSV (.csv)", icon: "doctype:csv" }
];

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let crcTable;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Archive zip sans compression (méthode « stored ») : suffisant pour un classeur Excel. */
function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data =
      typeof file.content === "string"
        ? encoder.encode(file.content)
        : file.content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

function xmlText(value) {
  return (
    String(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

function columnLetter(index) {
  let letters = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellValue(column, row) {
  const value = column.value(row);
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return value;
}

function sheetXml(columns, rows) {
  const widths = columns.map((column) =>
    Math.min(60, Math.max(8, String(column.label).length + 2))
  );
  const lines = [];
  const header = columns
    .map(
      (column, c) =>
        `<c r="${columnLetter(c)}1" t="inlineStr" s="1"><is><t>${xmlText(column.label)}</t></is></c>`
    )
    .join("");
  lines.push(`<row r="1">${header}</row>`);
  rows.forEach((row, r) => {
    const cells = columns
      .map((column, c) => {
        const value = cellValue(column, row);
        const ref = `${columnLetter(c)}${r + 2}`;
        if (typeof value === "number" && Number.isFinite(value)) {
          widths[c] = Math.max(
            widths[c],
            Math.min(60, String(value).length + 2)
          );
          return `<c r="${ref}"><v>${value}</v></c>`;
        }
        const text = String(value);
        if (!text) {
          return "";
        }
        const longest = Math.max(
          ...text.split("\n").map((part) => part.length)
        );
        widths[c] = Math.max(widths[c], Math.min(60, longest + 2));
        return `<c r="${ref}" t="inlineStr" s="2"><is><t xml:space="preserve">${xmlText(text.slice(0, 32000))}</t></is></c>`;
      })
      .join("");
    lines.push(`<row r="${r + 2}">${cells}</row>`);
  });
  const lastRef = `${columnLetter(Math.max(columns.length - 1, 0))}${rows.length + 1}`;
  const cols = widths
    .map(
      (width, c) =>
        `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${lines.join("")}</sheetData>` +
    `<autoFilter ref="A1:${lastRef}"/>` +
    "</worksheet>"
  );
}

function sheetName(name, index) {
  const clean = String(name || `Sheet${index + 1}`)
    .replace(/[[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31);
  return clean || `Sheet${index + 1}`;
}

/**
 * Classeur Excel (.xlsx) : une feuille par entrée {name, columns: [{label, value(row)}], rows}.
 * En-tête gras figé avec filtre automatique, largeurs de colonnes ajustées, nombres en nombres.
 */
export function buildXlsx(sheets) {
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index));
  const files = [
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        names
          .map(
            (n, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join("") +
        "</Types>"
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>"
    },
    {
      name: "xl/workbook.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names
          .map(
            (n, i) =>
              `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
          )
          .join("") +
        "</sheets>" +
        "<definedNames>" +
        names
          .map(
            (n, i) =>
              `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(n.replace(/'/g, "''"))}'!$A$1:$${columnLetter(Math.max(sheets[i].columns.length - 1, 0))}$${sheets[i].rows.length + 1}</definedName>`
          )
          .join("") +
        "</definedNames>" +
        "</workbook>"
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        names
          .map(
            (n, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join("") +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>"
    },
    {
      name: "xl/styles.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B5CAB"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>"
    },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      content: sheetXml(sheet.columns, sheet.rows)
    }))
  ];
  return buildZip(files);
}

/** Téléchargement d'un fichier binaire par URL « data: » en base64 (compatible Locker / LWS). */
export function downloadBinary(fileName, bytes, mimeType) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  const link = document.createElement("a");
  link.href = `data:${mimeType};base64,${btoa(binary)}`;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Nom de fichier d'export : « org-intelligence-<base>-AAAA-MM-JJ.<ext> ». */
export function exportFileName(base, extension) {
  const slug = String(base || "export")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `org-intelligence-${slug}-${todayIso()}.${extension}`;
}

/**
 * Export d'une liste affichée, au format Excel ou CSV.
 * `columns` : [{label, value(row)}] — mêmes colonnes que toCsv. `sheets` (optionnel) remplace
 * rows/columns pour un classeur à plusieurs onglets (le CSV ne reprend alors que le premier).
 */
export function exportRows({ name, format = "xlsx", columns, rows, sheets }) {
  const list = sheets?.length
    ? sheets
    : [{ name, columns: columns || [], rows: rows || [] }];
  if (format === "csv") {
    downloadText(
      exportFileName(name, "csv"),
      `${String.fromCharCode(0xfeff)}${toCsv(list[0].rows, list[0].columns)}`,
      "text/csv"
    );
    return;
  }
  downloadBinary(exportFileName(name, "xlsx"), buildXlsx(list), XLSX_MIME);
}

/** Date pour un export : « AAAA-MM-JJ HH:mm » en heure locale (vide si absente). */
export function formatExportDate(value, withTime = true) {
  if (!value) {
    return "";
  }
  const date =
    typeof value === "string" && value.length === 10
      ? new Date(`${value}T00:00:00`)
      : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime
    ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : day;
}
