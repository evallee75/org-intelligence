/**
 * Calcul de la roadmap des correctifs à partir des recommandations, sans dépendance à la plateforme
 * (testable sous Jest). Rien n'est enregistré dans l'org : les réglages et ajustements sont gardés
 * par l'écran dans le navigateur.
 *
 * Principe :
 * - effort estimé par recommandation (taille XS à XL, déduite de la règle, modifiable) ;
 * - valeur = gravité × poids de la catégorie × urgence (échéance dépassée, encore détectée) ;
 * - ordre selon la stratégie (risque d'abord, gains rapides, équilibré), avec option « par thème »
 *   qui regroupe les sujets d'un même domaine pour limiter les changements de contexte ;
 * - placement sur une ligne de temps continue en jours : capacité par période (semaine, sprint de
 *   2 semaines, mois) ; un gros sujet peut s'étaler sur plusieurs périodes.
 */

export const SIZES = [
  { value: "XS", days: 0.25, label: "XS · ¼ day" },
  { value: "S", days: 0.5, label: "S · ½ day" },
  { value: "M", days: 1, label: "M · 1 day" },
  { value: "L", days: 3, label: "L · 3 days" },
  { value: "XL", days: 5, label: "XL · 5 days" }
];

export const STRATEGIES = [
  {
    value: "balanced",
    label: "Balanced",
    description: "Critical topics first, then the best value for the effort."
  },
  {
    value: "risk",
    label: "Risk first",
    description: "Strictly by severity, whatever the effort."
  },
  {
    value: "quickWins",
    label: "Quick wins",
    description: "Most value per day of work first, to show progress fast."
  }
];

export const RHYTHMS = [
  { value: "week", label: "Weekly", short: "Week" },
  { value: "sprint", label: "2-week sprints", short: "Sprint" },
  { value: "month", label: "Monthly", short: "Month" }
];

const SEVERITY_POINTS = {
  Critical: 10,
  High: 6,
  Medium: 3,
  Low: 1,
  Info: 0.5
};

const CATEGORY_WEIGHTS = {
  Security: 1.5,
  Reliability: 1.3,
  Performance: 1.2,
  Adoption: 1.1,
  "Technical Debt": 1,
  Maintainability: 0.9,
  Documentation: 0.6
};

/** Taille par défaut selon la règle (premier motif trouvé dans le code de règle). */
const SIZE_RULES = [
  [/DESCRIPTION|DOCUMENT|UNDOCUMENTED/, "XS"],
  [/FIELD_USAGE|INACTIVE|UNUSED|NEVER/, "XS"],
  [/HARDCODED|OLD_API|API_VERSION/, "S"],
  [/ADOPTION_LICENSE|ADOPTION_ADDON|ADOPTION_CONTRACT/, "S"],
  [
    /PROCESS_BUILDER|WORKFLOW|RECURSION|MIXED_ON_OBJECT|MULTIPLE_PER_OBJECT/,
    "L"
  ],
  [/ADOPTION_FEATURE/, "L"],
  [/COVERAGE|TEST|SOQL_DML_IN_LOOP|DML_IN_LOOP|LOGIC_IN_BODY|FAULT_PATH/, "M"],
  [/SECURITY_(MFA|MODIFY_ALL_DATA|GUEST|CUSTOM_OBJECT_SHARING|ORG_WIDE)/, "L"],
  [/SECURITY_/, "M"],
  [/STORAGE_/, "M"]
];

export function sizeDays(size) {
  return (SIZES.find((s) => s.value === size) || SIZES[2]).days;
}

export function defaultSize(row) {
  const code = (row.ruleCode || "").toUpperCase();
  for (const [pattern, size] of SIZE_RULES) {
    if (pattern.test(code)) {
      return size;
    }
  }
  return row.category === "Documentation" ? "XS" : "M";
}

/** Valeur métier d'un sujet (plus elle est haute, plus il faut le traiter tôt). */
export function valueOf(row, today = new Date()) {
  let value =
    (SEVERITY_POINTS[row.severity] ?? 1) *
    (CATEGORY_WEIGHTS[row.category] ?? 1);
  if (row.dueDate && new Date(`${row.dueDate}T00:00:00`) < today) {
    value *= 1.3; // échéance dépassée
  }
  if (row.stillDetected === false) {
    value *= 0.5; // plus détectée par le dernier scan : peut-être déjà corrigée
  }
  return Math.round(value * 100) / 100;
}

/** Explication courte du rang (affichée au survol). */
export function reasonOf(item, strategy) {
  const parts = [
    `${item.severity || "No"} severity`,
    `${item.category || "uncategorised"}`,
    `${item.size} (${item.days} d)`,
    `value ${item.value}`
  ];
  if (item.boost > 0) {
    parts.push("moved up by you");
  } else if (item.boost < 0) {
    parts.push("moved down by you");
  }
  if (strategy === "quickWins") {
    parts.push(
      `${Math.round((item.value / item.days) * 10) / 10} value per day`
    );
  }
  return parts.join(" · ");
}

export const DEFAULT_FILTERS = {
  domains: [],
  severities: [],
  categories: [],
  assignee: "all",
  openOnly: true,
  search: ""
};

export const DEFAULT_SETTINGS = {
  strategy: "balanced",
  rhythm: "sprint",
  capacity: 5,
  startDate: null,
  byTheme: false,
  horizon: 12
};

/** Recommandations retenues par les filtres (hors exclusions manuelles). */
export function applyFilters(rows, filters, currentUserId) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const term = (f.search || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (f.openOnly && row.isOpen === false) {
      return false;
    }
    if (f.domains.length && !f.domains.includes(row.domain || "Other")) {
      return false;
    }
    if (f.severities.length && !f.severities.includes(row.severity)) {
      return false;
    }
    if (f.categories.length && !f.categories.includes(row.category)) {
      return false;
    }
    if (f.assignee === "me" && row.assignedToId !== currentUserId) {
      return false;
    }
    if (f.assignee === "unassigned" && row.assignedToId) {
      return false;
    }
    if (!term) {
      return true;
    }
    return [row.title, row.componentName, row.ruleCode, row.name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(term);
  });
}

function compare(strategy) {
  const severityRank = (item) => -(SEVERITY_POINTS[item.severity] ?? 1);
  return (a, b) => {
    if (a.boost !== b.boost) {
      return b.boost - a.boost;
    }
    if (strategy === "risk") {
      return (
        severityRank(a) - severityRank(b) ||
        b.value - a.value ||
        a.days - b.days
      );
    }
    if (strategy === "quickWins") {
      return b.value / b.days - a.value / a.days || b.value - a.value;
    }
    // Équilibré : critiques d'abord, puis valeur par jour
    const aCritical = a.severity === "Critical" ? 0 : 1;
    const bCritical = b.severity === "Critical" ? 0 : 1;
    return (
      aCritical - bCritical ||
      b.value / Math.sqrt(b.days) - a.value / Math.sqrt(a.days)
    );
  };
}

/** Début de la période n (dates locales, sans heure). */
export function periodStart(startDate, rhythm, index) {
  const date = new Date(startDate);
  if (rhythm === "month") {
    return new Date(date.getFullYear(), date.getMonth() + index, 1);
  }
  const days = rhythm === "week" ? 7 : 14;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + index * days
  );
}

/** Prochain lundi (ou le 1er du mois prochain pour un rythme mensuel). */
export function defaultStart(rhythm, today = new Date()) {
  if (rhythm === "month") {
    return new Date(today.getFullYear(), today.getMonth() + 1, 1);
  }
  const day = today.getDay();
  const offset = day === 1 ? 0 : (8 - day) % 7;
  return new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + offset
  );
}

/**
 * Roadmap : sujets ordonnés et placés dans des périodes.
 *
 * @param rows        recommandations (listRecommendations)
 * @param options     { filters, settings, overrides: { [id]: { size, boost, excluded } }, currentUserId, today }
 */
export function buildRoadmap(rows, options = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings || {}) };
  const overrides = options.overrides || {};
  const today = options.today || new Date();
  const capacity = Math.max(0.25, Number(settings.capacity) || 5);
  const start = settings.startDate
    ? new Date(`${settings.startDate}T00:00:00`)
    : defaultStart(settings.rhythm, today);

  const filtered = applyFilters(rows, options.filters, options.currentUserId);
  const excluded = [];
  let items = [];
  for (const row of filtered) {
    const override = overrides[row.id] || {};
    const size = override.size || defaultSize(row);
    const item = {
      ...row,
      domain: row.domain || "Other",
      size,
      sizeIsDefault: !override.size,
      days: sizeDays(size),
      boost: override.boost || 0,
      value: valueOf(row, today)
    };
    if (override.excluded) {
      excluded.push(item);
    } else {
      items.push(item);
    }
  }

  const ordered = [...items].sort(compare(settings.strategy));
  if (settings.byTheme) {
    // Thèmes classés par valeur totale ; ordre de la stratégie conservé dans chaque thème
    const totals = new Map();
    ordered.forEach((item) => {
      totals.set(item.domain, (totals.get(item.domain) || 0) + item.value);
    });
    const firstIndex = new Map();
    ordered.forEach((item, index) => {
      if (!firstIndex.has(item.domain)) {
        firstIndex.set(item.domain, index);
      }
    });
    items = ordered.sort(
      (a, b) =>
        (b.boost > 0) - (a.boost > 0) ||
        totals.get(b.domain) - totals.get(a.domain) ||
        firstIndex.get(a.domain) - firstIndex.get(b.domain)
    );
  } else {
    items = ordered;
  }

  // Placement sur une ligne de temps continue (en jours de travail)
  let cursor = 0;
  items.forEach((item, index) => {
    item.rank = index + 1;
    item.startDay = cursor;
    cursor += item.days;
    item.endDay = cursor;
    item.period = Math.floor(item.startDay / capacity + 1e-9);
    item.endPeriod = Math.floor((item.endDay - 1e-9) / capacity);
    item.span = item.endPeriod - item.period + 1;
    item.reason = reasonOf(item, settings.strategy);
  });

  const periodCount = items.length ? items[items.length - 1].endPeriod + 1 : 0;
  const visible = Math.min(
    periodCount,
    Math.max(1, Number(settings.horizon) || 12)
  );
  const rhythm = RHYTHMS.find((r) => r.value === settings.rhythm) || RHYTHMS[1];
  const periods = [];
  for (let index = 0; index < visible; index++) {
    const from = periodStart(start, settings.rhythm, index);
    const next = periodStart(start, settings.rhythm, index + 1);
    const to = new Date(
      next.getFullYear(),
      next.getMonth(),
      next.getDate() - 1
    );
    const periodItems = items.filter((item) => item.period === index);
    // Charge : part de chaque sujet qui tombe dans la période
    const lower = index * capacity;
    const upper = lower + capacity;
    const used = items.reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          Math.min(item.endDay, upper) - Math.max(item.startDay, lower)
        ),
      0
    );
    periods.push({
      index,
      label: `${rhythm.short} ${index + 1}`,
      start: from,
      end: to,
      items: periodItems,
      used: Math.round(used * 100) / 100,
      capacity
    });
  }
  const lastEnd = periodCount
    ? (() => {
        const next = periodStart(start, settings.rhythm, periodCount);
        return new Date(
          next.getFullYear(),
          next.getMonth(),
          next.getDate() - 1
        );
      })()
    : null;

  return {
    settings: { ...settings, capacity },
    start,
    items,
    excluded,
    periods,
    periodCount,
    beyondHorizon: items.filter((item) => item.period >= visible),
    totalDays: Math.round(cursor * 100) / 100,
    endDate: lastEnd
  };
}

/** Thèmes présents (pour les couloirs de la vue chronologique), dans l'ordre de première apparition. */
export function themesOf(items) {
  const seen = [];
  items.forEach((item) => {
    if (!seen.includes(item.domain)) {
      seen.push(item.domain);
    }
  });
  return seen;
}

/** Roadmap en Markdown (copier-coller dans un ticket, un wiki ou un e-mail). */
export function toMarkdown(roadmap, formatDate) {
  const lines = [
    "# Salesforce remediation roadmap",
    "",
    `${roadmap.items.length} topics · ${roadmap.totalDays} days of work · ${roadmap.settings.capacity} days per period`,
    ""
  ];
  roadmap.periods.forEach((period) => {
    lines.push(
      `## ${period.label} — ${formatDate(period.start)} to ${formatDate(period.end)} (${period.used} / ${period.capacity} days)`
    );
    if (!period.items.length) {
      lines.push("- (continuation of the previous topics)");
    }
    period.items.forEach((item) => {
      lines.push(
        `- [ ] **${item.severity || "—"}** · ${item.title} (${item.domain}, ${item.size})${item.assignedToName ? ` — ${item.assignedToName}` : ""}`
      );
    });
    lines.push("");
  });
  if (roadmap.beyondHorizon.length) {
    lines.push(`## Later (${roadmap.beyondHorizon.length} topics)`);
    roadmap.beyondHorizon.forEach((item) => {
      lines.push(`- [ ] ${item.title} (${item.domain}, ${item.size})`);
    });
  }
  return lines.join("\n");
}
