/**
 * Rapport de l'audit de sécurité : document HTML autonome, imprimable en PDF depuis le navigateur
 * (Fichier › Imprimer › Enregistrer au format PDF). Construit en chaînes JS à partir de l'audit
 * gardé en cache (jamais depuis le DOM), téléchargé par downloadText.
 *
 * Contenu : page de garde (note, score, compteurs, Health Check, chiffres clés), synthèse et plan
 * d'action priorisé (12 lignes), résultats par famille (barres), détail des contrôles à corriger
 * (20 éléments au plus), contrôles réussis en tableau compact, annexes (Health Check, méthode).
 *
 * Module JS pur, sans dépendance au DOM : testable et réutilisable.
 */

export const CATEGORY_ORDER = [
  "Privileged access",
  "Users & authentication",
  "Profiles & permission sets",
  "Sharing & data exposure",
  "Integrations",
  "Monitoring"
];

const SEVERITIES = ["Critical", "High", "Medium", "Low"];

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

const STATUS_RANK = {
  Fail: 0,
  Warning: 1,
  Info: 2,
  "Not evaluated": 3,
  Pass: 4
};

const SEVERITY_COLORS = {
  Critical: "#a4231a",
  High: "#c2410c",
  Medium: "#a8730f",
  Low: "#2f6fb3"
};

/** Statut → fond, texte, libellé. */
const STATUS_STYLES = {
  Pass: { background: "#e3f3e6", color: "#1e6b2b", label: "PASSED" },
  Warning: { background: "#fff1cc", color: "#7a4f00", label: "WARNING" },
  Fail: { background: "#fde4e2", color: "#a4231a", label: "FAILED" },
  "Not evaluated": {
    background: "#eceff3",
    color: "#4b5563",
    label: "NOT EVALUATED"
  },
  Info: { background: "#e6eefb", color: "#1d4f91", label: "FOR REVIEW" }
};

const GRADE_COLORS = {
  A: "#1e7b34",
  B: "#4d8f2a",
  C: "#a8730f",
  D: "#c2410c",
  E: "#a4231a"
};

export const GRADE_LABELS = {
  A: "Strong security posture",
  B: "Good, with a few gaps",
  C: "Several gaps to fix",
  D: "Significant exposure",
  E: "Critical exposure"
};

const ACTION_LIMIT = 12;
const ITEM_LIMIT = 20;
const SETUP_ITEM_LIMIT = 15;
const INACTIVE_DAYS = 90;

/** Échappement HTML de toute valeur issue de l'org. */
export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statusStyle(status) {
  return STATUS_STYLES[status] || STATUS_STYLES["Not evaluated"];
}

function rank(ranks, value) {
  return value in ranks ? ranks[value] : 9;
}

/** Tri : échecs, avertissements, à revoir, non évalués, réussis ; puis gravité. */
export function sortChecks(checks) {
  return [...checks].sort(
    (a, b) =>
      rank(STATUS_RANK, a.status) - rank(STATUS_RANK, b.status) ||
      rank(SEVERITY_RANK, a.severity) - rank(SEVERITY_RANK, b.severity)
  );
}

function percent(part, total) {
  return total ? Math.round((part * 100) / total) : 0;
}

function formatLongDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Nom de fichier : Security-audit-<org>-<aaaa-mm-jj>.html */
export function reportFileName(audit) {
  const org = String(audit?.orgName || "org")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const date = audit?.generatedAt ? new Date(audit.generatedAt) : new Date();
  const stamp = Number.isNaN(date.getTime())
    ? ""
    : date.toISOString().slice(0, 10);
  return `Security-audit-${org || "org"}-${stamp}.html`;
}

// ---------- Blocs ----------

function chip(status) {
  const style = statusStyle(status);
  return `<span class="chip" style="background:${style.background};color:${style.color}">${style.label}</span>`;
}

function severityChip(severity) {
  const color = SEVERITY_COLORS[severity] || "#4b5563";
  return `<span class="sev-chip" style="background:${color}">${escapeHtml(severity)}</span>`;
}

function figure(check, label, caption) {
  if (
    !check ||
    check.status === "Not evaluated" ||
    check.count === null ||
    check.count === undefined
  ) {
    return {
      label,
      value: "—",
      caption: "not evaluated",
      color: "#6b7280",
      background: "#f4f5f7"
    };
  }
  const style = statusStyle(check.status);
  return {
    label,
    value: String(check.count),
    caption,
    color: style.color,
    background: style.background
  };
}

function figureCell(tile) {
  return `<td class="figure" style="background:${tile.background}">
    <div class="figure-value" style="color:${tile.color}">${escapeHtml(tile.value)}</div>
    <div class="figure-label">${escapeHtml(tile.label)}</div>
    <div class="figure-caption">${escapeHtml(tile.caption)}</div>
  </td>`;
}

function coverPage(audit, byKey) {
  const grade = audit.grade || "?";
  const gradeColor = GRADE_COLORS[grade] || "#4b5563";
  const failed = audit.failedBySeverity || {};
  const environment = `${audit.edition || ""} · ${audit.isSandbox ? "Sandbox" : "Production"}`;
  const hc = audit.healthCheckScore;
  const hasHc = hc !== null && hc !== undefined;
  const hcValue = hasHc ? Math.trunc(hc) : null;
  const hcText = hasHc ? `${hcValue} / 100` : "Not available";
  const hcColor = !hasHc
    ? "#6b7280"
    : hcValue >= 80
      ? "#1e7b34"
      : hcValue >= 60
        ? "#a8730f"
        : "#a4231a";

  const tiles = [
    ...SEVERITIES.map((severity) => ({
      label: severity,
      value: failed[severity] || 0,
      caption: "failed",
      color: SEVERITY_COLORS[severity]
    })),
    {
      label: "Warnings",
      value: audit.warnings || 0,
      caption: "to review",
      color: "#7a4f00"
    },
    {
      label: "Passed",
      value: audit.passed || 0,
      caption: "checks",
      color: "#1e6b2b"
    }
  ];
  const tileCells = tiles
    .map(
      (tile) => `<td>
        <div class="sev-value" style="color:${tile.color}">${escapeHtml(tile.value)}</div>
        <div class="sev-label" style="color:${tile.color}">${escapeHtml(tile.label)}</div>
        <div class="sev-caption">${escapeHtml(tile.caption)}</div>
      </td>`
    )
    .join("");

  const figures = [
    figure(
      byKey.MODIFY_ALL_DATA,
      'Users with "Modify All Data"',
      "full administrators"
    ),
    figure(byKey.MFA, "Users without MFA", "no authenticator or key"),
    figure(
      byKey.INACTIVE_USERS,
      "Dormant accounts",
      `no login for ${INACTIVE_DAYS} days`
    ),
    figure(byKey.GUEST_ACCESS, "Risky guest permissions", "on public sites"),
    figure(
      byKey.ORG_WIDE_DEFAULTS,
      "Objects open to everyone",
      "Public Read/Write"
    ),
    figure(
      byKey.PUBLIC_LINKS,
      "Public links without expiry",
      "files shared by URL"
    )
  ];

  return `<section class="cover">
  <table class="cover-band"><tr><td>
    <div class="brand">ORG INTELLIGENCE</div>
    <div class="cover-title">Salesforce Security Audit</div>
    <div class="cover-subtitle">${escapeHtml(audit.orgName)}</div>
  </td></tr></table>
  <table class="meta">
    <tr><td class="meta-label">Organization</td><td class="meta-value">${escapeHtml(audit.orgName)} (${escapeHtml(audit.orgId)})</td></tr>
    <tr><td class="meta-label">Environment</td><td class="meta-value">${escapeHtml(environment)}</td></tr>
    <tr><td class="meta-label">Audit date</td><td class="meta-value">${escapeHtml(formatLongDate(audit.generatedAt))}</td></tr>
    <tr><td class="meta-label">Run by</td><td class="meta-value">${escapeHtml(audit.runBy)}</td></tr>
    <tr><td class="meta-label">Scope</td><td class="meta-value">${(audit.checks || []).length} checks · ${escapeHtml(audit.activeUsers ?? "—")} active internal users</td></tr>
  </table>
  <table class="grade-row"><tr>
    <td class="grade-cell" style="background:${gradeColor}">
      <div class="grade-letter">${escapeHtml(grade)}</div>
      <div class="grade-score">Score ${escapeHtml(audit.score)} / 100</div>
      <div class="grade-label">${escapeHtml(GRADE_LABELS[grade] || "")}</div>
    </td>
    <td class="summary-cell">
      <div class="section-label">Checks by result</div>
      <table class="sev-table"><tr>${tileCells}</tr></table>
      <table class="hc-box"><tr>
        <td style="width:60%">
          <div class="section-label" style="margin:0">Salesforce Health Check</div>
          <div class="small-muted">Session, password and network settings against the Salesforce baseline</div>
        </td>
        <td class="hc-value" style="color:${hcColor}">${escapeHtml(hcText)}</td>
      </tr></table>
    </td>
  </tr></table>
  <div class="section-label" style="margin-top:18pt">Key figures</div>
  <table class="figures">
    <tr>${figures.slice(0, 3).map(figureCell).join("")}</tr>
    <tr>${figures.slice(3).map(figureCell).join("")}</tr>
  </table>
  <div class="disclaimer">
    This report was produced automatically by Org Intelligence from the configuration and the
    activity of the org at the audit date, in read-only mode. It gives a prioritized view of common
    Salesforce security risks; it does not replace a penetration test or a review of your code. It
    contains user names and security settings: share it only with the people in charge of the org.
  </div>
</section>`;
}

function summaryPage(audit, categories) {
  const grade = audit.grade || "?";
  const open = sortChecks(
    (audit.checks || []).filter(
      (check) => check.status === "Fail" || check.status === "Warning"
    )
  );
  const actions = open.slice(0, ACTION_LIMIT);
  const hidden = open.length - actions.length;

  const actionRows = actions
    .map(
      (check, index) => `<tr class="avoid-break">
      <td class="action-index">${index + 1}</td>
      <td><div class="action-title">${escapeHtml(check.title)}</div>
        <div class="action-metric">${escapeHtml(check.metric)}</div></td>
      <td>${severityChip(check.severity)}<div style="margin-top:5pt">${chip(check.status)}</div></td>
      <td class="action-reco">${escapeHtml(check.recommendation)}</td>
    </tr>`
    )
    .join("");

  const actionBlock = actions.length
    ? `<table class="actions">
        <thead><tr><th>#</th><th style="width:40%">Finding</th><th style="width:15%">Severity</th><th>What to do</th></tr></thead>
        <tbody>${actionRows}</tbody>
      </table>
      ${hidden > 0 ? `<div class="more">+ ${escapeHtml(hidden)} more finding(s) in the detailed results.</div>` : ""}`
    : `<div class="lead">No failed check: well done.</div>`;

  const overviewRows = categories
    .map((cat) => {
      const segments = [
        { width: cat.failWidth, color: "#c0392b" },
        { width: cat.warnWidth, color: "#e8a317" },
        { width: cat.passWidth, color: "#3c9a4e" },
        { width: cat.otherWidth, color: "#c9ced6" }
      ]
        .filter((segment) => segment.width > 0)
        .map(
          (segment) =>
            `<td style="width:${segment.width}%;background:${segment.color}"></td>`
        )
        .join("");
      return `<tr>
        <td style="font-weight:bold">${escapeHtml(cat.code)}. ${escapeHtml(cat.name)}</td>
        <td class="num">${cat.total}</td>
        <td class="num" style="color:#1e6b2b">${cat.passed}</td>
        <td class="num" style="color:#7a4f00">${cat.warnings}</td>
        <td class="num" style="color:#a4231a;font-weight:bold">${cat.failed}</td>
        <td style="vertical-align:middle"><table class="bar"><tr>${segments}</tr></table></td>
      </tr>`;
    })
    .join("");

  return `<section class="page-break">
  <h1>Executive summary</h1>
  <div class="lead">Overall score ${escapeHtml(audit.score)} / 100 (grade ${escapeHtml(grade)}):
    ${escapeHtml(GRADE_LABELS[grade] || "")}. ${open.length} check(s) need action; they are listed
    below from the most to the least critical.</div>
  <h2>Priority action plan</h2>
  ${actionBlock}
  <h2>Results by area</h2>
  <table class="overview avoid-break">
    <thead><tr><th>Area</th><th class="num">Checks</th><th class="num">Passed</th><th class="num">Warnings</th><th class="num">Failed</th><th style="width:34%">Breakdown</th></tr></thead>
    <tbody>${overviewRows}</tbody>
  </table>
  <div class="legend">
    <span style="color:#c0392b">■</span> Failed
    <span style="color:#e8a317;margin-left:8pt">■</span> Warning
    <span style="color:#3c9a4e;margin-left:8pt">■</span> Passed
    <span style="color:#c9ced6;margin-left:8pt">■</span> For review or not evaluated
  </div>
</section>`;
}

/** Éléments concernés d'un contrôle : 20 au plus (15 pour le journal d'audit). */
function checkItems(check) {
  const all = check.items || [];
  if (check.key === "HEALTH_CHECK" || check.status === "Pass") {
    return { items: [], hidden: 0 };
  }
  const limit = check.key === "SETUP_CHANGES" ? SETUP_ITEM_LIMIT : ITEM_LIMIT;
  const items = all.slice(0, limit);
  return {
    items,
    hidden: (check.moreItems || 0) + Math.max(0, all.length - limit)
  };
}

function issueBlock(code, check) {
  const style = statusStyle(check.status);
  const showAdvice = ["Fail", "Warning", "Info"].includes(check.status);
  const { items, hidden } = checkItems(check);
  const advice = showAdvice
    ? `<table class="advice">
        <tr><td class="advice-label">Why it matters</td><td>${escapeHtml(check.risk)}</td></tr>
        <tr><td class="advice-label">Recommendation</td><td>${escapeHtml(check.recommendation)}</td></tr>
      </table>`
    : "";
  const itemTable = items.length
    ? `<table class="items">
        <thead><tr><th>Concerned</th><th>Detail</th></tr></thead>
        <tbody>${items
          .map(
            (item) =>
              `<tr><td class="item-label">${escapeHtml(item.label)}</td><td>${escapeHtml(item.detail)}</td></tr>`
          )
          .join("")}</tbody>
      </table>
      ${hidden > 0 ? `<div class="more">+ ${escapeHtml(hidden)} more — full list in the Excel export of Org Intelligence.</div>` : ""}`
    : "";
  return `<table class="check"><tr>
    <td class="check-stripe" style="background:${style.color}"></td>
    <td class="check-body">
      <table class="check-head"><tr>
        <td><span class="check-number">${escapeHtml(code)}</span>&nbsp; <span class="check-title">${escapeHtml(check.title)}</span></td>
        <td style="text-align:right;width:34%">${severityChip(check.severity)}&nbsp; ${chip(check.status)}</td>
      </tr></table>
      <div class="check-metric">${escapeHtml(check.metric)}</div>
      ${advice}
      ${itemTable}
    </td>
  </tr></table>`;
}

function detailPages(categories) {
  const blocks = categories
    .map((cat) => {
      const issues = cat.checks
        .filter((entry) => entry.check.status !== "Pass")
        .map((entry) => issueBlock(entry.code, entry.check))
        .join("");
      const passed = cat.checks.filter(
        (entry) => entry.check.status === "Pass"
      );
      const passedTable = passed.length
        ? `<table class="passed avoid-break">
            <thead><tr><th>Passed check</th><th>Result</th></tr></thead>
            <tbody>${passed
              .map(
                (entry) =>
                  `<tr><td class="passed-title">${escapeHtml(entry.code)} ${escapeHtml(entry.check.title)}</td><td>${escapeHtml(entry.check.metric)}</td></tr>`
              )
              .join("")}</tbody>
          </table>`
        : "";
      return `<h2 class="category-title">${escapeHtml(cat.code)}. ${escapeHtml(cat.name)}</h2>
        <div class="lead">${cat.total} check(s): ${cat.failed} failed, ${cat.warnings} warning(s), ${cat.passed} passed.</div>
        ${issues}
        ${passedTable}`;
    })
    .join("");
  return `<section class="page-break">
  <h1>Detailed results</h1>
  <div class="lead">Checks needing action come first in each area, with the accounts, profiles or
    settings concerned. Passed checks are summarised at the end of each area.</div>
  ${blocks}
</section>`;
}

function appendix(byKey) {
  const risks = byKey.HEALTH_CHECK?.items || [];
  const healthCheck = risks.length
    ? `<h2>A. Salesforce Health Check: settings below the baseline</h2>
      <table class="annex">
        <thead><tr><th style="width:50%">Setting</th><th>Your value and the Salesforce baseline</th></tr></thead>
        <tbody>${risks
          .map(
            (risk) =>
              `<tr class="avoid-break"><td style="font-weight:bold">${escapeHtml(risk.label)}</td><td>${escapeHtml(risk.detail)}</td></tr>`
          )
          .join("")}</tbody>
      </table>`
    : "";
  return `<section class="page-break">
  <h1>Appendix</h1>
  ${healthCheck}
  <h2>Method and limits</h2>
  <div class="method">
    <p><b>How the score is computed.</b> The score starts at 100. Each failed check removes points
      according to its severity (Critical 20, High 10, Medium 5, Low 2); a warning removes half.
      Checks that could not be evaluated do not count. Grades: A from 90, B from 75, C from 60,
      D from 40, E below.</p>
    <p><b>What is read.</b> Users and their last login, profiles, permission sets and their
      assignments, object permissions, sharing defaults, public file links, connected app tokens,
      login history (latest 5,000 logins of the last 7 days), Setup Audit Trail (30 days) and, when
      the Tooling API connection is set up, the Salesforce Health Check. Nothing is changed in the
      org.</p>
    <p><b>Limits.</b> Users signing in through single sign-on are excluded from the multi-factor
      check (their identity provider handles it). Integration users are recognised by their
      "API Only User" permission or their name. Sandboxes copy the production configuration but not
      its activity: run the audit in production for logins and dormant accounts. Lists are
      shortened in this report; the full lists are available in the Excel export of Org
      Intelligence.</p>
  </div>
</section>`;
}

/** Familles dans l'ordre, contrôles triés et numérotés (1.1, 1.2…), compteurs et largeurs de barres. */
export function buildCategories(checks) {
  const categories = [];
  CATEGORY_ORDER.forEach((name) => {
    const list = sortChecks((checks || []).filter((c) => c.category === name));
    if (!list.length) {
      return;
    }
    const index = categories.length + 1;
    const count = (status) => list.filter((c) => c.status === status).length;
    const total = list.length;
    const failed = count("Fail");
    const warnings = count("Warning");
    const passed = count("Pass");
    const failWidth = percent(failed, total);
    const warnWidth = percent(warnings, total);
    const passWidth = percent(passed, total);
    categories.push({
      code: String(index),
      name,
      total,
      failed,
      warnings,
      passed,
      failWidth,
      warnWidth,
      passWidth,
      otherWidth: Math.max(0, 100 - failWidth - warnWidth - passWidth),
      checks: list.map((check, i) => ({ code: `${index}.${i + 1}`, check }))
    });
  });
  return categories;
}

const STYLES = `
@page { size: A4; margin: 16mm 14mm 18mm 14mm;
  @bottom-left { content: "Org Intelligence · Salesforce security audit · Confidential"; font-size: 7.5pt; color: #8a94a3; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 7.5pt; color: #8a94a3; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; line-height: 1.4; color: #1f2937; margin: 0; background: #e5e7eb; }
.paper { max-width: 210mm; margin: 16px auto; padding: 14mm; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.15); }
.print-bar { max-width: 210mm; margin: 16px auto 0; display: flex; justify-content: space-between; align-items: center; color: #374151; }
.print-bar button { font: inherit; font-weight: bold; padding: 6px 14px; border: 0; border-radius: 4px; background: #0f2a4a; color: #fff; cursor: pointer; }
@media print { body { background: #fff; } .paper { margin: 0; padding: 0; max-width: none; box-shadow: none; } .print-bar { display: none; } }
table { border-collapse: collapse; width: 100%; }
td, th { vertical-align: top; }
.page-break { break-before: page; page-break-before: always; }
@media screen { .page-break { margin-top: 28pt; padding-top: 18pt; border-top: 2px dashed #d1d5db; } }
.avoid-break { break-inside: avoid; page-break-inside: avoid; }
.cover-band { background: #0f2a4a; color: #fff; }
.cover-band td { padding: 26pt 24pt 22pt; }
.brand { font-size: 8pt; letter-spacing: 2pt; color: #9cc3ff; }
.cover-title { font-size: 26pt; font-weight: bold; margin-top: 6pt; }
.cover-subtitle { font-size: 11pt; color: #d6e4f5; margin-top: 4pt; }
.meta { margin-top: 14pt; }
.meta td { padding: 3pt 0; font-size: 9pt; }
.meta-label { width: 30%; color: #6b7280; }
.meta-value { font-weight: bold; color: #111827; }
.grade-row { margin-top: 16pt; }
.grade-cell { width: 34%; text-align: center; color: #fff; padding: 18pt 10pt; vertical-align: middle; }
.grade-letter { font-size: 64pt; font-weight: bold; line-height: 1; }
.grade-score { font-size: 13pt; font-weight: bold; margin-top: 6pt; }
.grade-label { font-size: 9pt; margin-top: 4pt; }
.summary-cell { padding: 14pt 0 0 18pt; }
.section-label { font-size: 7.5pt; font-weight: bold; letter-spacing: 1pt; color: #6b7280; text-transform: uppercase; margin-bottom: 6pt; }
.small-muted { font-size: 7.5pt; color: #6b7280; }
.sev-table td { text-align: center; padding: 7pt 2pt; border: 1pt solid #e5e7eb; }
.sev-value { font-size: 18pt; font-weight: bold; }
.sev-label { font-size: 7.5pt; font-weight: bold; text-transform: uppercase; }
.sev-caption { font-size: 7pt; color: #6b7280; }
.hc-box { margin-top: 10pt; border: 1pt solid #e5e7eb; }
.hc-box td { padding: 7pt 10pt; }
.hc-value { text-align: right; font-size: 15pt; font-weight: bold; vertical-align: middle; }
.figures { margin-top: 6pt; }
.figures td.figure { width: 33.3%; padding: 10pt 10pt 9pt; border: 3pt solid #fff; }
.figure-value { font-size: 20pt; font-weight: bold; line-height: 1.1; }
.figure-label { font-size: 8.5pt; font-weight: bold; color: #111827; margin-top: 2pt; }
.figure-caption { font-size: 7.5pt; color: #4b5563; }
.disclaimer { margin-top: 16pt; padding: 9pt 11pt; background: #f4f6f9; font-size: 7.5pt; color: #4b5563; }
h1 { font-size: 17pt; color: #0f2a4a; margin: 0 0 4pt; }
h2 { font-size: 13pt; color: #0f2a4a; margin: 16pt 0 6pt; padding-bottom: 4pt; border-bottom: 1.5pt solid #0f2a4a; break-after: avoid; page-break-after: avoid; }
.category-title { margin-top: 18pt; }
.lead { font-size: 9.5pt; color: #4b5563; margin-bottom: 10pt; }
.actions th { background: #0f2a4a; color: #fff; font-size: 7.5pt; text-align: left; padding: 6pt 7pt; text-transform: uppercase; }
.actions td { padding: 7pt; border-bottom: .75pt solid #e5e7eb; }
.action-index { width: 5%; font-size: 12pt; font-weight: bold; color: #0f2a4a; }
.action-title { font-weight: bold; color: #111827; }
.action-metric { font-size: 8pt; color: #4b5563; margin-top: 2pt; }
.action-reco { font-size: 8.5pt; }
.chip, .sev-chip { font-size: 7pt; font-weight: bold; padding: 2pt 5pt; white-space: nowrap; }
.sev-chip { color: #fff; }
.overview th { font-size: 7.5pt; text-transform: uppercase; color: #6b7280; text-align: left; padding: 5pt 6pt; border-bottom: 1pt solid #d1d5db; }
.overview td { padding: 7pt 6pt; border-bottom: .75pt solid #e5e7eb; }
.num { text-align: right; white-space: nowrap; }
.overview th.num { text-align: right; }
.bar td { padding: 0; height: 9pt; border: 0; }
.legend { font-size: 7pt; color: #6b7280; margin-top: 4pt; }
.check { margin: 0 0 10pt; border: .75pt solid #e5e7eb; break-inside: avoid; page-break-inside: avoid; }
.check-stripe { width: 4pt; }
.check-body { padding: 9pt 11pt; }
.check-head td { vertical-align: middle; }
.check-number { font-size: 8pt; color: #6b7280; font-weight: bold; }
.check-title { font-size: 10.5pt; font-weight: bold; color: #111827; }
.check-metric { margin-top: 5pt; font-size: 9pt; font-weight: bold; color: #1f2937; }
.advice td { padding: 5pt 0 0; font-size: 8.5pt; }
.advice-label { width: 22%; font-size: 7.5pt; font-weight: bold; text-transform: uppercase; color: #6b7280; padding-top: 6pt; }
.items { margin-top: 7pt; }
.items th, .annex th { background: #f4f6f9; font-size: 7pt; text-transform: uppercase; color: #6b7280; text-align: left; padding: 4pt 6pt; }
.items td { font-size: 7.5pt; padding: 3pt 6pt; border-bottom: .5pt solid #eceff3; }
.item-label { width: 32%; font-weight: bold; color: #111827; }
.more { font-size: 7.5pt; color: #6b7280; padding-top: 4pt; font-style: italic; }
.passed th { font-size: 7pt; text-transform: uppercase; color: #1e6b2b; text-align: left; padding: 4pt 6pt; background: #e3f3e6; }
.passed td { font-size: 8pt; padding: 4pt 6pt; border-bottom: .5pt solid #e5efe7; }
.passed-title { width: 40%; font-weight: bold; color: #111827; }
.annex td { font-size: 8pt; padding: 4pt 6pt; border-bottom: .5pt solid #eceff3; }
.method p { margin: 0 0 6pt; font-size: 8.5pt; }
`;

/** Document HTML complet du rapport (chaîne). */
export function buildSecurityReport(audit) {
  const checks = audit?.checks || [];
  const byKey = {};
  checks.forEach((check) => {
    byKey[check.key] = check;
  });
  const categories = buildCategories(checks);
  const title = `Security audit · ${audit?.orgName || "Salesforce org"}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="print-bar"><span>Org Intelligence · security audit report</span>
<button type="button" onclick="window.print()">Print / Save as PDF</button></div>
<main class="paper">
${coverPage(audit || {}, byKey)}
${summaryPage(audit || {}, categories)}
${detailPages(categories)}
${appendix(byKey)}
</main>
</body>
</html>`;
}
