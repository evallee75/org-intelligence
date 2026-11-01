/**
 * Exports de la section Automation, construits en chaînes (jamais depuis le DOM) pour s'ouvrir
 * hors de Salesforce : carte de l'org en SVG autonome, rapport HTML imprimable (carte, synthèse
 * des conflits, ordre d'exécution par objet), diagramme Mermaid et CSV des conflits.
 */
import {
  CONFLICT_TYPES,
  CONFLICT_TYPE_KEYS,
  EXPORT_PALETTE,
  KINDS,
  kindMeta,
  layoutOrgGraph,
  nodeLines,
  placeSegments,
  stagesFor,
  truncate
} from "c/orgIntelAutomationModel";

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TONE_COLORS = {
  critical: EXPORT_PALETTE.critical,
  serious: EXPORT_PALETTE.serious,
  warning: EXPORT_PALETTE.warning,
  low: EXPORT_PALETTE.low,
  good: EXPORT_PALETTE.good
};

function edgeColor(edge) {
  if (edge.loop) {
    return EXPORT_PALETTE.loop;
  }
  return EXPORT_PALETTE[edge.operation] || EXPORT_PALETTE.update;
}

/** Carte de l'org en SVG autonome (couleurs en dur, police système). */
export function buildOrgMapSvg(data, { title = true } = {}) {
  const layout = layoutOrgGraph(data.graph);
  const p = EXPORT_PALETTE;
  const top = title ? 54 : 0;
  const width = Math.max(layout.width, 640);
  const height = layout.height + top + 40;
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">`
  );
  out.push(
    `<defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${p.dot}"/></pattern></defs>`
  );
  out.push(`<rect width="100%" height="100%" fill="${p.background}"/>`);
  out.push(`<rect width="100%" height="100%" fill="url(#dots)"/>`);
  if (title) {
    out.push(
      `<text x="28" y="32" font-size="18" font-weight="700" fill="${p.text}">Automation map</text>`,
      `<text x="28" y="48" font-size="11.5" fill="${p.muted}">${escapeXml(
        [
          data.scanName ? `Scan ${data.scanName}` : null,
          `${data.kpis.objects} automated objects`,
          `${data.kpis.active} active automations`,
          `${data.kpis.conflicts} conflicts`
        ]
          .filter(Boolean)
          .join(" · ")
      )}</text>`
    );
  }
  out.push(`<g transform="translate(0 ${top})">`);
  if (layout.hasIsolated) {
    out.push(
      `<text x="28" y="${layout.gridLabelY}" font-size="11" font-weight="700" letter-spacing="0.06em" fill="${p.muted}">OBJECTS WITHOUT CROSS-OBJECT WRITES</text>`
    );
  }
  for (const edge of layout.edges) {
    const color = edgeColor(edge);
    out.push(
      `<path d="${edge.path}" fill="none" stroke="${color}" stroke-width="${edge.width}" stroke-opacity="0.85"${edge.operation === "calls" || edge.isBack ? ' stroke-dasharray="6 4"' : ""}/>`,
      `<polygon points="${edge.head}" fill="${color}"/>`
    );
  }
  for (const edge of layout.edges) {
    const w = edge.label.length * 5.8 + 12;
    out.push(
      `<rect x="${edge.labelX - w / 2}" y="${edge.labelY - 9}" width="${w}" height="16" rx="8" fill="${p.surface}" stroke="${edgeColor(edge)}" stroke-width="1"/>`,
      `<text x="${edge.labelX}" y="${edge.labelY + 3}" text-anchor="middle" font-size="10" font-weight="600" fill="${edgeColor(edge)}">${escapeXml(edge.label)}</text>`
    );
  }
  for (const node of layout.nodes) {
    out.push(nodeSvg(node));
  }
  out.push("</g>");
  out.push(legendSvg(28, layout.height + top + 18));
  out.push("</svg>");
  return out.join("\n");
}

function nodeSvg(node) {
  const p = EXPORT_PALETTE;
  const { x, y, width: w, height: h } = node;
  const stroke = node.inLoop
    ? p.loop
    : node.type === "flow"
      ? KINDS.Flow.color
      : p.border;
  const fill = node.automated ? p.surface : "#f1f3f7";
  const lines = nodeLines(node);
  const parts = [
    `<g>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="${node.inLoop ? 2 : 1.25}"${node.type === "flow" || !node.automated ? ' stroke-dasharray="5 3"' : ""}/>`,
    `<rect x="${x}" y="${y + 12}" width="4" height="${h - 24}" rx="2" fill="${node.type === "flow" ? KINDS.Flow.color : node.automated ? p.accent : p.border}"/>`,
    `<text x="${x + 16}" y="${y + 24}" font-size="13" font-weight="700" fill="${p.text}">${escapeXml(truncate(node.name, 26))}</text>`
  ];
  for (const seg of placeSegments(lines.counts, x + 16, { dot: 10 })) {
    if (seg.color) {
      parts.push(
        `<circle cx="${seg.x + 3.5}" cy="${y + 42}" r="3.5" fill="${seg.color}"/>`
      );
    }
    parts.push(
      `<text x="${seg.color ? seg.textX : seg.x}" y="${y + 46}" font-size="11" fill="${p.muted}">${escapeXml(seg.text)}</text>`
    );
  }
  for (const seg of placeSegments(lines.status, x + 16, {
    charWidth: 5.9,
    gap: 14
  })) {
    parts.push(
      `<text x="${seg.x}" y="${y + 65}" font-size="10.5" font-weight="700" fill="${TONE_COLORS[seg.tone] || p.muted}">${escapeXml(seg.text)}</text>`
    );
  }
  parts.push("</g>");
  return parts.join("");
}

function legendSvg(x, y) {
  const p = EXPORT_PALETTE;
  const items = [
    { color: p.update, text: "updates records" },
    { color: p.create, text: "creates records" },
    { color: p.calls, text: "calls a flow", dashed: true },
    { color: p.loop, text: "loop between objects" }
  ];
  let cx = x;
  const parts = [];
  for (const item of items) {
    parts.push(
      `<line x1="${cx}" y1="${y}" x2="${cx + 22}" y2="${y}" stroke="${item.color}" stroke-width="2.5"${item.dashed ? ' stroke-dasharray="5 3"' : ""}/>`,
      `<text x="${cx + 28}" y="${y + 4}" font-size="11" fill="${p.muted}">${escapeXml(item.text)}</text>`
    );
    cx += 40 + item.text.length * 6;
  }
  parts.push(
    `<text x="${cx + 8}" y="${y + 4}" font-size="11" fill="${p.muted}">Apex trigger writes are not analyzed.</text>`
  );
  return parts.join("");
}

// ---------- Mermaid ----------

function mermaidId(text) {
  return String(text).replace(/[^A-Za-z0-9_]/g, "_");
}

/** Libellé Mermaid : guillemets et chevrons neutralisés (codes d'entité Mermaid), aucun HTML transmis. */
function mermaidLabel(text) {
  return String(text ?? "")
    .replace(/"/g, "'")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;");
}

/** Diagramme Mermaid : un sous-graphe par objet avec ses automatisations, flèches vers les objets écrits. */
export function buildMermaid(data) {
  const lines = ["flowchart LR"];
  lines.push(
    "  classDef flow fill:#efeafd,stroke:#7c5cdb,color:#2b1a66",
    "  classDef pb fill:#fdf0e3,stroke:#d9822b,color:#5a3000",
    "  classDef apex fill:#e8f0fb,stroke:#2f6fd1,color:#0b2a5c",
    "  classDef object fill:#ffffff,stroke:#5c6470,color:#181818,font-weight:bold",
    "  classDef loop stroke:#d03b3b,stroke-width:3px"
  );
  const objectNode = (name) => `obj_${mermaidId(name)}`;
  const declared = new Set();
  const active = data.automations.filter((a) => a.isActive);
  // index des liens dans l'ordre de déclaration (linkStyle les désigne par position)
  let edgeIndex = 0;
  for (const object of data.objects) {
    const objectId = objectNode(object.name);
    lines.push(
      `  subgraph sg_${mermaidId(object.name)}["${mermaidLabel(object.name)}"]`
    );
    lines.push(`    direction TB`);
    lines.push(
      `    ${objectId}(["${mermaidLabel(object.name)} saved"]):::object`
    );
    let previous = objectId;
    for (const stage of stagesFor(active, object.name, "")) {
      if (stage.system) {
        continue;
      }
      for (const automation of stage.items) {
        const id = `a_${mermaidId(automation.apiName)}`;
        lines.push(
          `    ${id}["${mermaidLabel(automation.name)}<br/><small>${mermaidLabel(kindMeta(automation.kind).label)} · ${mermaidLabel(stage.title)}</small>"]:::${mermaidId(automation.kindKey)}`
        );
        lines.push(`    ${previous} --> ${id}`);
        edgeIndex++;
        previous = id;
      }
    }
    lines.push("  end");
  }
  const launched = active.filter((a) => !a.objectName && a.kind === "Flow");
  for (const automation of launched) {
    lines.push(
      `  a_${mermaidId(automation.apiName)}[["${mermaidLabel(automation.name)}<br/><small>Autolaunched flow</small>"]]:::flow`
    );
  }
  const loopEdges = [];
  for (const automation of active) {
    const source = `a_${mermaidId(automation.apiName)}`;
    for (const write of automation.model?.writes || []) {
      if (!write.objectName || write.objectName === automation.objectName) {
        continue;
      }
      const target = objectNode(write.objectName);
      if (
        !data.objects.some((o) => o.name === write.objectName) &&
        !declared.has(target)
      ) {
        declared.add(target);
        lines.push(
          `  ${target}(["${mermaidLabel(write.objectName)}"]):::object`
        );
      }
      lines.push(
        `  ${source} -. ${mermaidId(write.operation).toLowerCase()} .-> ${target}`
      );
      const isLoop = data.cycles.some(
        (c) =>
          c.objects.includes(write.objectName) &&
          c.automations.includes(automation.apiName)
      );
      if (isLoop) {
        loopEdges.push(edgeIndex);
      }
      edgeIndex++;
    }
    for (const name of automation.calls || []) {
      if (launched.some((a) => a.apiName === name)) {
        lines.push(`  ${source} == calls ==> a_${mermaidId(name)}`);
        edgeIndex++;
      }
    }
  }
  if (loopEdges.length) {
    lines.push(
      `  linkStyle ${loopEdges.join(",")} stroke:#d03b3b,stroke-width:3px`
    );
  }
  return lines.join("\n");
}

// ---------- CSV ----------

export const CONFLICT_CSV_COLUMNS = [
  { label: "Type", value: (c) => c.label },
  { label: "Severity", value: (c) => c.severity },
  { label: "Object", value: (c) => c.objectName },
  { label: "Conflict", value: (c) => c.title },
  {
    label: "Automations",
    value: (c) => c.automations.map((a) => a.apiName || a.name).join(", ")
  },
  { label: "Detail", value: (c) => c.detail },
  { label: "Recommendation", value: (c) => c.advice }
];

// ---------- Rapport HTML ----------

const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#181818;background:#f4f6f9;line-height:1.45}
.page{max-width:1200px;margin:0 auto;padding:32px 28px 64px}
.hero{padding:28px 32px;border-radius:18px;color:#fff;background:linear-gradient(120deg,#032d60 0%,#0b5cab 70%,#1b96ff 100%)}
.hero h1{margin:0 0 4px;font-size:26px}
.hero p{margin:0;opacity:.88;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:20px 0}
.kpi{padding:14px 16px;border-radius:14px;background:#fff;border:1px solid #e3e8ef}
.kpi b{display:block;font-size:26px;line-height:1.1}
.kpi span{font-size:12px;color:#5c6470}
.kpi.alert b{color:#d03b3b}
h2{margin:36px 0 12px;font-size:19px}
h3{margin:0 0 4px;font-size:16px}
.card{padding:18px 20px;margin-bottom:14px;border-radius:14px;background:#fff;border:1px solid #e3e8ef;page-break-inside:avoid}
.map{overflow:auto;border-radius:14px;border:1px solid #e3e8ef;background:#fff}
.map svg{display:block;max-width:100%;height:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#5c6470;padding:8px 10px;border-bottom:2px solid #e3e8ef}
td{padding:9px 10px;border-bottom:1px solid #eef1f5;vertical-align:top}
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}
.badge i{width:8px;height:8px;border-radius:50%;display:inline-block}
.t-critical{background:#fbe9e9;color:#a12a2a}.t-critical i{background:#d03b3b}
.t-serious{background:#fdeee7;color:#9a3b12}.t-serious i{background:#e0703f}
.t-warning{background:#fef5de;color:#8c5a00}.t-warning i{background:#fab219}
.t-low{background:#e8f0fb;color:#1d4f91}.t-low i{background:#3b7dd8}
.muted{color:#5c6470;font-size:12.5px}
.advice{font-size:12.5px;color:#2e4a6b;background:#f2f6fb;border-radius:8px;padding:6px 10px;margin-top:6px}
.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:14px}
.summary div{padding:12px;border-radius:12px;background:#fff;border:1px solid #e3e8ef}
.summary b{font-size:20px;display:block}
.timeline{list-style:none;margin:12px 0 0;padding:0 0 0 18px;border-left:2px solid #e3e8ef}
.timeline li{position:relative;margin:0 0 12px;padding-left:16px}
.timeline li:before{content:attr(data-step);position:absolute;left:-31px;top:0;width:24px;height:24px;border-radius:50%;background:#0b5cab;color:#fff;font-size:12px;font-weight:700;text-align:center;line-height:24px}
.timeline li.system:before{background:#8a919c;content:"✓"}
.stage{font-weight:700;font-size:13.5px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:8px;font-size:12.5px;font-weight:600;border:1.5px solid}
.chip small{font-weight:400;opacity:.8}
.k-flow{background:#efeafd;border-color:#7c5cdb;color:#2b1a66}
.k-pb{background:#fdf0e3;border-color:#d9822b;color:#5a3000}
.k-apex{background:#e8f0fb;border-color:#2f6fd1;color:#0b2a5c}
.obj-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.footer{margin-top:40px;font-size:12px;color:#5c6470;text-align:center}
@media print{body{background:#fff}.page{padding:0}.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}.card,.kpi,.summary div{break-inside:avoid}.badge,.chip,.timeline li:before{-webkit-print-color-adjust:exact;print-color-adjust:exact}h2{break-after:avoid}.object{break-before:page}}
`;

function badge(tone, label) {
  return `<span class="badge t-${escapeXml(tone)}"><i></i>${escapeXml(label)}</span>`;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

/** Rapport HTML autonome et imprimable : carte, synthèse des conflits, détail par objet. */
export function buildHtmlReport(data, { orgName = "", now = new Date() } = {}) {
  const k = data.kpis;
  const html = [];
  html.push(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Automation report${orgName ? ` — ${escapeXml(orgName)}` : ""}</title><style>${REPORT_CSS}</style></head><body><div class="page">`
  );
  html.push(
    `<header class="hero"><h1>Automation report</h1><p>${escapeXml(
      [
        orgName,
        data.scanName
          ? `Scan ${data.scanName} (${formatDate(data.scanCompletedAt)})`
          : null,
        `Generated ${formatDate(now)}`
      ]
        .filter(Boolean)
        .join(" · ")
    )}</p></header>`
  );
  const kpi = (value, label, alert) =>
    `<div class="kpi${alert && value ? " alert" : ""}"><b>${escapeXml(value)}</b><span>${escapeXml(label)}</span></div>`;
  html.push(
    `<section class="kpis">${kpi(k.objects, "Automated objects")}${kpi(k.active, `Active automations (${k.flowCount} flows, ${k.pbCount} PB, ${k.apexCount} Apex)`)}${kpi(k.conflicts, "Conflicts", true)}${kpi(k.loops, "Loops between objects", true)}${kpi(k.failedRuns, `Failed flow runs (${data.errorDays} days)`, true)}</section>`
  );

  html.push(`<h2>Org automation map</h2>`);
  html.push(`<div class="map">${buildOrgMapSvg(data, { title: false })}</div>`);
  html.push(
    `<p class="muted">Each card is an object; arrows are records created or updated by its flows and processes on other objects. What Apex triggers write is not analyzed.</p>`
  );

  // Synthèse des conflits
  html.push(`<h2>Conflict summary</h2>`);
  const byType = new Map(CONFLICT_TYPE_KEYS.map((t) => [t, 0]));
  data.allConflicts.forEach((c) => byType.set(c.type, byType.get(c.type) + 1));
  html.push(
    `<div class="summary">${CONFLICT_TYPE_KEYS.map(
      (t) =>
        `<div>${badge(CONFLICT_TYPES[t].tone, CONFLICT_TYPES[t].label)}<b>${escapeXml(byType.get(t))}</b><span class="muted">${escapeXml(CONFLICT_TYPES[t].advice)}</span></div>`
    ).join("")}</div>`
  );
  if (data.allConflicts.length) {
    html.push(
      `<div class="card"><table><thead><tr><th>Type</th><th>Object</th><th>Conflict</th><th>Automations</th></tr></thead><tbody>`
    );
    for (const c of data.allConflicts) {
      html.push(
        `<tr><td>${badge(c.tone, c.label)}</td><td><b>${escapeXml(c.objectName)}</b></td><td>${escapeXml(c.title)}<div class="muted">${escapeXml(c.detail)}</div></td><td>${c.automations.map((a) => escapeXml(a.name)).join(c.chain ? " → " : "<br>") || "—"}</td></tr>`
      );
    }
    html.push(`</tbody></table></div>`);
  } else {
    html.push(`<div class="card muted">No conflict detected.</div>`);
  }

  // Détail par objet
  html.push(`<h2>Order of execution by object</h2>`);
  const active = data.automations.filter((a) => a.isActive);
  for (const object of data.objects) {
    const conflicts = data.conflictsByObject[object.name] || [];
    html.push(
      `<section class="card object"><div class="obj-head"><h3>${escapeXml(object.name)}</h3><span class="muted">${escapeXml(object.automationCount)} active automation${object.automationCount > 1 ? "s" : ""}${conflicts.length ? ` · ${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}` : ""}</span></div>`
    );
    html.push(`<ol class="timeline">`);
    let step = 0;
    for (const stage of stagesFor(active, object.name, "")) {
      if (stage.system) {
        html.push(
          `<li class="system"><div class="stage">${escapeXml(stage.title)}</div><div class="muted">${escapeXml(stage.subtitle)}</div></li>`
        );
        continue;
      }
      step++;
      html.push(
        `<li data-step="${step}"><div class="stage">${escapeXml(stage.title)}</div><div class="muted">${escapeXml(stage.subtitle)}</div><div class="chips">${stage.items
          .map((a) => {
            const meta = [
              a.model?.triggerOrder != null
                ? `order ${a.model.triggerOrder}`
                : null,
              a.kind === "Apex trigger"
                ? (a.events || []).join(", ")
                : (a.events || []).join(" / "),
              a.resaves ? "↻ saves again" : null,
              a.errors ? `${a.errors.count} failed` : null
            ]
              .filter(Boolean)
              .join(" · ");
            return `<span class="chip k-${escapeXml(a.kindKey)}">${escapeXml(a.name)}${meta ? ` <small>${escapeXml(meta)}</small>` : ""}</span>`;
          })
          .join("")}</div></li>`
      );
    }
    html.push(`</ol>`);
    const writes = [
      ...new Set(
        object.automations.flatMap((a) =>
          (a.model?.writes || [])
            .filter((w) => w.objectName && w.objectName !== object.name)
            .map((w) => `${w.operation} ${w.objectName}`)
        )
      )
    ];
    if (writes.length) {
      html.push(
        `<p class="muted"><b>Other objects written:</b> ${escapeXml(writes.join(" · "))}</p>`
      );
    }
    if (conflicts.length) {
      html.push(`<table><tbody>`);
      for (const c of conflicts) {
        html.push(
          `<tr><td style="width:120px">${badge(c.tone, c.label)}</td><td><b>${escapeXml(c.title)}</b><div class="muted">${escapeXml(c.detail)}</div><div class="advice">${escapeXml(c.advice)}</div></td></tr>`
        );
      }
      html.push(`</tbody></table>`);
    }
    html.push(`</section>`);
  }
  html.push(
    `<p class="footer">Generated by Org Intelligence. Validation rules are not shown. Fields written by Apex code are not analyzed.</p></div></body></html>`
  );
  return html.join("\n");
}
