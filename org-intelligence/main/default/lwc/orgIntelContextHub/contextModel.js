/**
 * Modèle pur du Context Hub (sans appel Apex) : normalise une recommandation venue du module
 * collaboratif, du stockage local ou d'un constat du dernier scan, puis produit le Markdown.
 *
 * Le code source des composants n'est jamais inclus : seules les métadonnées (noms, dépendances,
 * constats) le sont. Les secrets sont masqués ensuite côté Apex (OrgApiLogger.redact).
 */

export const SOURCE_COLLABORATIVE = "collaborative";
export const SOURCE_LOCAL = "local";
export const SOURCE_SCAN = "scan";

/** Préfixes des identifiants hors module collaboratif. */
const LOCAL_PREFIX = "local:";
const SCAN_PREFIX = "finding:";

export function isCollaborativeId(id) {
  return !!id && !id.startsWith(LOCAL_PREFIX) && !id.startsWith(SCAN_PREFIX);
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item);
  }
  return [];
}

// ---------- Liste de choix ----------

/** Lignes du sélecteur à partir des recommandations locales et des constats du dernier scan. */
export function localOptions(localByFingerprint, latestScan) {
  const rows = [];
  const seen = new Set();
  Object.values(localByFingerprint || {}).forEach((rec) => {
    seen.add(rec.Fingerprint__c);
    rows.push({
      id: rec.Id || `${LOCAL_PREFIX}${rec.Fingerprint__c}`,
      name: rec.Name,
      title: rec.Title__c,
      severity: rec.Severity__c,
      status: rec.Status__c,
      componentName: rec.ComponentName__c
    });
  });
  (latestScan?.findings || []).forEach((finding) => {
    if (!finding.fingerprint || seen.has(finding.fingerprint)) {
      return;
    }
    seen.add(finding.fingerprint);
    rows.push({
      id: `${SCAN_PREFIX}${finding.fingerprint}`,
      name: "Finding",
      title: finding.title,
      severity: finding.severity,
      status: "Latest scan",
      componentName: finding.componentName
    });
  });
  return rows;
}

// ---------- Normalisation ----------

function flattenComments(comments) {
  const plain = (comment) =>
    (comment.segments || []).map((segment) => segment.text || "").join("");
  const result = [];
  (comments || []).forEach((comment) => {
    result.push({
      id: comment.id,
      authorName: comment.authorName,
      createdDate: comment.createdDate,
      text: plain(comment)
    });
    (comment.replies || []).forEach((reply) => {
      result.push({
        id: reply.id,
        authorName: reply.authorName,
        createdDate: reply.createdDate,
        text: `↳ ${plain(reply)}`
      });
    });
  });
  return result;
}

/** Détail du module collaboratif (action getRecommendation). */
export function fromCollaborative(detail) {
  const rec = detail?.record || {};
  const history = [];
  (detail?.history || []).forEach((entry) => {
    const change =
      entry.oldValue == null && entry.newValue == null
        ? ""
        : ` ${entry.oldValue ?? "—"} → ${entry.newValue ?? "—"}`;
    history.push({
      when: entry.changedAt,
      text: `${entry.changedByName || "—"}: ${entry.fieldLabel}${change}`
    });
  });
  (detail?.occurrences || []).forEach((occurrence) => {
    history.push({
      when: occurrence.detectedAt,
      text: `detected by ${occurrence.scanName || "—"}${occurrence.isNew ? " (new)" : ""}`
    });
  });
  return {
    source: SOURCE_COLLABORATIVE,
    id: rec.id,
    name: rec.name,
    title: rec.title,
    severity: rec.severity,
    category: rec.category,
    confidence: rec.confidence,
    status: rec.status,
    componentName: rec.componentName,
    componentType: rec.componentType,
    ruleCode: rec.ruleCode,
    ruleLabel: detail?.rule?.label,
    occurrenceCount: rec.occurrenceCount,
    firstDetectedAt: detail?.firstDetectedAt,
    lastDetectedAt: rec.lastDetectedAt,
    stillDetected: rec.stillDetected,
    description: detail?.description,
    suggestedAction: detail?.suggestedAction,
    decisionReason: detail?.decisionReason,
    justification: detail?.justification,
    affectedComponents: toList(detail?.affectedComponents),
    history,
    related: (detail?.relatedRecommendations || []).map((row) => ({
      name: row.name,
      severity: row.severity,
      status: row.status,
      title: row.title
    })),
    comments: flattenComments(detail?.comments)
  };
}

/** Recommandation du stockage local (noms de champs d'OrgRecommendation__c). */
export function fromLocal(rec, allLocal) {
  const history = [];
  if (rec.FirstDetectedAt__c) {
    history.push({ when: rec.FirstDetectedAt__c, text: "first detected" });
  }
  if (
    rec.LastDetectedAt__c &&
    rec.LastDetectedAt__c !== rec.FirstDetectedAt__c
  ) {
    history.push({ when: rec.LastDetectedAt__c, text: "last detected" });
  }
  if (rec.StatusChangedAt__c) {
    history.push({
      when: rec.StatusChangedAt__c,
      text: `Status: ${rec.Status__c || "—"}`
    });
  }
  const related = Object.values(allLocal || {})
    .filter(
      (other) =>
        other.Fingerprint__c !== rec.Fingerprint__c &&
        rec.ComponentName__c &&
        other.ComponentName__c === rec.ComponentName__c
    )
    .map((other) => ({
      name: other.Name,
      severity: other.Severity__c,
      status: other.Status__c,
      title: other.Title__c
    }));
  return {
    source: SOURCE_LOCAL,
    id: rec.Id || `${LOCAL_PREFIX}${rec.Fingerprint__c}`,
    name: rec.Name,
    title: rec.Title__c,
    severity: rec.Severity__c,
    category: rec.Category__c,
    confidence: rec.Confidence__c,
    status: rec.Status__c,
    componentName: rec.ComponentName__c,
    componentType: rec.ComponentType__c,
    ruleCode: rec.RuleCode__c,
    ruleLabel: null,
    occurrenceCount: rec.OccurrenceCount__c,
    firstDetectedAt: rec.FirstDetectedAt__c,
    lastDetectedAt: rec.LastDetectedAt__c,
    stillDetected: rec.StillDetected__c,
    description: rec.Description__c,
    suggestedAction: rec.SuggestedAction__c,
    decisionReason: rec.DecisionReason__c,
    justification: rec.Justification__c,
    affectedComponents: toList(rec.AffectedComponents__c),
    history,
    related,
    comments: []
  };
}

/** Constat du dernier scan sans recommandation correspondante. */
export function fromFinding(finding, latestScan) {
  const related = (latestScan?.findings || [])
    .filter(
      (other) =>
        other.fingerprint !== finding.fingerprint &&
        finding.componentName &&
        other.componentName === finding.componentName
    )
    .map((other) => ({
      name: other.ruleCode,
      severity: other.severity,
      status: "Latest scan",
      title: other.title
    }));
  const when = latestScan?.completedAt || latestScan?.startedAt;
  return {
    source: SOURCE_SCAN,
    id: `${SCAN_PREFIX}${finding.fingerprint}`,
    name: latestScan?.name || "Latest scan",
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    confidence: finding.confidence,
    status: "Detected",
    componentName: finding.componentName,
    componentType: finding.componentType,
    ruleCode: finding.ruleCode,
    ruleLabel: null,
    occurrenceCount: 1,
    firstDetectedAt: when,
    lastDetectedAt: when,
    stillDetected: true,
    description: finding.description,
    suggestedAction: null,
    decisionReason: null,
    justification: finding.evidence,
    affectedComponents: toList(finding.affectedComponents),
    history: when
      ? [{ when, text: `detected by ${latestScan?.name || "the latest scan"}` }]
      : [],
    related,
    comments: []
  };
}

/** Résout un identifiant de la liste en contexte normalisé (hors module collaboratif). */
export function resolveLocal(id, localByFingerprint, latestScan) {
  if (!id) {
    return null;
  }
  if (id.startsWith(SCAN_PREFIX)) {
    const fingerprint = id.substring(SCAN_PREFIX.length);
    const finding = (latestScan?.findings || []).find(
      (item) => item.fingerprint === fingerprint
    );
    return finding ? fromFinding(finding, latestScan) : null;
  }
  const rec = Object.values(localByFingerprint || {}).find(
    (item) => item.Id === id || `${LOCAL_PREFIX}${item.Fingerprint__c}` === id
  );
  return rec ? fromLocal(rec, localByFingerprint) : null;
}

/** Dépendances connues des composants concernés, lues dans le dernier scan du navigateur. */
export function dependenciesFor(context, latestScan) {
  const names = new Set(context?.affectedComponents || []);
  if (context?.componentName) {
    names.add(context.componentName);
  }
  const result = [];
  const seen = new Set();
  (latestScan?.components || []).forEach((component) => {
    const deps = component.dependencies;
    if (
      !names.has(component.apiName) ||
      !deps ||
      (!(deps.uses || []).length && !(deps.usedBy || []).length) ||
      seen.has(`${component.componentType}:${component.apiName}`)
    ) {
      return;
    }
    seen.add(`${component.componentType}:${component.apiName}`);
    result.push({
      component: component.apiName,
      uses: (deps.uses || []).map(String),
      usedBy: (deps.usedBy || []).map(String)
    });
  });
  return result;
}

// ---------- Markdown ----------

function cell(value) {
  return value === null || value === undefined || value === ""
    ? "—"
    : String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function day(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toISOString().substring(0, 10);
}

function stamp(value) {
  return value.toISOString().substring(0, 16).replace("T", " ");
}

/**
 * Markdown du contexte. `sections` : clés cochées ; `comments` : commentaires retenus ;
 * `dependencies` : résultat de dependenciesFor.
 */
export function buildMarkdown({
  context,
  sections,
  comments = [],
  dependencies = [],
  orgName,
  generatedAt = new Date()
}) {
  const selected = new Set(sections || []);
  const out = [];
  out.push(
    `# Salesforce Org Intelligence — ${context.name || "—"}: ${context.title || "—"}`
  );
  out.push("");
  out.push(
    `_Context exported${orgName ? ` from the org "${orgName}"` : ""} on ${stamp(generatedAt)} UTC. ` +
      "Facts come from metadata scans and explicit rules; secrets are masked and source code is not included._"
  );

  if (selected.has("prompt")) {
    out.push(
      "",
      "## Request to the assistant",
      "",
      "You are a senior Salesforce architect. Using only the facts below:",
      "1. Confirm or challenge the diagnosis, and say which facts are missing to be sure.",
      "2. Explain the concrete risks for the business and for the platform (limits, security, maintainability).",
      "3. Propose a step-by-step remediation plan, safe for production (tests, deployment order, rollback).",
      "4. Estimate the effort and list what must be checked in the org before changing anything.",
      "Do not assume a component is unused without evidence. Ask questions if the context is not enough."
    );
  }

  if (selected.has("problem")) {
    out.push(
      "",
      "## Problem",
      "",
      "| Attribute | Value |",
      "|---|---|",
      `| Severity | ${cell(context.severity)} |`,
      `| Category | ${cell(context.category)} |`,
      `| Confidence | ${cell(context.confidence)} |`,
      `| Status | ${cell(context.status)} |`,
      `| Component | ${cell(context.componentName)} (${cell(context.componentType)}) |`,
      `| Rule | ${context.ruleLabel ? `${cell(context.ruleLabel)} ` : ""}(\`${cell(context.ruleCode)}\`) |`,
      `| Detected | ${context.occurrenceCount || 1} time(s), first ${day(context.firstDetectedAt)}, last ${day(
        context.lastDetectedAt
      )}${context.stillDetected === false ? " — no longer detected by the latest scan" : ""} |`
    );
    if (context.description) {
      out.push("", context.description);
    }
    if (context.suggestedAction) {
      out.push("", `**Suggested action:** ${context.suggestedAction}`);
    }
    if (context.decisionReason) {
      out.push("", `**Latest decision:** ${context.decisionReason}`);
    }
  }

  if (selected.has("evidence") && context.justification) {
    out.push(
      "",
      "## Evidence and justification",
      "",
      "```text",
      context.justification,
      "```"
    );
  }

  if (selected.has("components") && context.affectedComponents.length) {
    out.push("", "## Affected components", "");
    context.affectedComponents.forEach((component) =>
      out.push(`- \`${component}\``)
    );
  }

  if (selected.has("dependencies")) {
    out.push("", "## Known dependencies", "");
    if (!dependencies.length) {
      out.push(
        "_No dependency data (requires a scan with the Tooling API in this browser; the dependency API is in beta and may be incomplete)._"
      );
    }
    dependencies.forEach((info) => {
      out.push(
        `**${info.component}**`,
        `- Uses: ${info.uses.length ? info.uses.join(", ") : "—"}`,
        `- Used by: ${info.usedBy.length ? info.usedBy.join(", ") : "—"}`
      );
    });
  }

  if (selected.has("history")) {
    out.push("", "## Decision history", "");
    if (!context.history.length) {
      out.push("_No change recorded._");
    }
    context.history.forEach((entry) =>
      out.push(`- ${day(entry.when)} — ${entry.text}`)
    );
  }

  if (selected.has("related") && context.related.length) {
    out.push("", "## Other recommendations on the same component", "");
    context.related.forEach((row) =>
      out.push(
        `- ${row.name || "—"} [${row.severity || "—"}, ${row.status || "—"}] ${row.title || ""}`
      )
    );
  }

  if (selected.has("comments") && comments.length) {
    out.push("", "## Team discussion (selected comments)", "");
    comments.forEach((comment) => {
      out.push(
        `> **${cell(comment.authorName)}**, ${day(comment.createdDate)}: ${(comment.text || "").replace(/\n/g, "\n> ")}`,
        ""
      );
    });
  }
  return `${out.join("\n").trim()}\n`;
}

/** Nom du fichier téléchargé. */
export function fileNameFor(context) {
  return `${context.name || "recommendation"}-context.md`.replace(
    /[^A-Za-z0-9._-]/g,
    "_"
  );
}
