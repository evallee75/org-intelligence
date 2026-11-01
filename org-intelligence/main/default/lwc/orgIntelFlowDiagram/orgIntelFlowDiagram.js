import { LightningElement, api } from "lwc";

const NODE_WIDTH = 184;
const NODE_HEIGHT = 48;
const H_GAP = 30;
const V_GAP = 50;
const MARGIN = 24;
const ICON = 26;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/** Pictogramme de chaque type d'élément (texte, rendu dans la pastille colorée). */
const TYPE_GLYPHS = {
  start: "▶",
  decisions: "◆",
  loops: "↻",
  assignments: "=",
  recordLookups: "↓",
  recordCreates: "+",
  recordUpdates: "✎",
  recordDeletes: "✕",
  actionCalls: "ƒ",
  subflows: "⇢",
  screens: "▢",
  waits: "‖",
  customErrors: "!",
  collectionProcessors: "∑",
  transforms: "⇄",
  recordRollbacks: "↶"
};

function arrow(from, tip, size = 7) {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const r = (n) => Math.round(n * 10) / 10;
  return `${r(tip.x)},${r(tip.y)} ${r(bx - uy * size * 0.55)},${r(by + ux * size * 0.55)} ${r(bx + uy * size * 0.55)},${r(by - ux * size * 0.55)}`;
}

const TYPE_LABELS = {
  start: "Start",
  decisions: "Decision",
  loops: "Loop",
  assignments: "Assignment",
  recordLookups: "Get Records",
  recordCreates: "Create Records",
  recordUpdates: "Update Records",
  recordDeletes: "Delete Records",
  actionCalls: "Action",
  subflows: "Subflow",
  screens: "Screen",
  waits: "Wait",
  customErrors: "Custom Error",
  collectionProcessors: "Collection",
  transforms: "Transform",
  recordRollbacks: "Roll Back"
};

const TYPE_TONES = {
  start: "start",
  decisions: "decision",
  loops: "loop",
  recordLookups: "data",
  recordCreates: "data",
  recordUpdates: "data",
  recordDeletes: "data",
  recordRollbacks: "data",
  actionCalls: "action",
  subflows: "action",
  screens: "action",
  waits: "action",
  assignments: "logic",
  collectionProcessors: "logic",
  transforms: "logic",
  customErrors: "error"
};

function truncate(text, max) {
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Logigramme d'un flow, à la manière de Flow Builder : Start puis les éléments par niveaux, en
 * suivant les connecteurs. Décisions en losange, boucles, éléments de données ; chemins d'erreur
 * en pointillé rouge ; retours en arrière (boucles) sur le côté. Les éléments qui interrogent ou
 * écrivent dans une boucle sont entourés de rouge.
 */
export default class OrgIntelFlowDiagram extends LightningElement {
  zoom = 1;
  fitted = false;
  currentModel;

  @api
  get model() {
    return this.currentModel;
  }
  set model(value) {
    if (value !== this.currentModel) {
      this.currentModel = value;
      this.fitted = false;
      this.zoom = 1;
    }
  }

  get layout() {
    const model = this.model || {};
    const nodes = (model.nodes || []).map((node) => ({ ...node }));
    const edges = model.edges || [];
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // Niveaux : plus court chemin depuis Start (parcours en largeur)
    const level = new Map([["START", 0]]);
    const queue = ["START"];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of edges) {
        if (
          edge.source === current &&
          byId.has(edge.target) &&
          !level.has(edge.target)
        ) {
          level.set(edge.target, level.get(current) + 1);
          queue.push(edge.target);
        }
      }
    }
    let maxLevel = Math.max(0, ...level.values());
    for (const node of nodes) {
      if (!level.has(node.id)) {
        maxLevel += 1;
        level.set(node.id, maxLevel); // élément non relié : en bas
      }
    }

    const rows = [];
    for (const node of nodes) {
      const index = level.get(node.id);
      rows[index] = rows[index] || [];
      rows[index].push(node);
    }
    const widest = Math.max(
      1,
      ...rows.filter(Boolean).map((row) => row.length)
    );
    const width = MARGIN * 2 + widest * NODE_WIDTH + (widest - 1) * H_GAP + 60;
    const positions = new Map();
    rows.forEach((row, rowIndex) => {
      if (!row) {
        return;
      }
      const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * H_GAP;
      const left = (width - 60 - rowWidth) / 2;
      row.forEach((node, index) => {
        positions.set(node.id, {
          x: left + index * (NODE_WIDTH + H_GAP),
          y: MARGIN + rowIndex * (NODE_HEIGHT + V_GAP)
        });
      });
    });
    const height = MARGIN * 2 + rows.length * (NODE_HEIGHT + V_GAP);

    const inLoop = (label) =>
      (model.costlyInLoop || []).some((line) => line.startsWith(`${label} (`));

    const drawnNodes = nodes.map((node) => {
      const position = positions.get(node.id);
      const tone = TYPE_TONES[node.type] || "default";
      const flagged = inLoop(node.label);
      const isStart = node.type === "start";
      const iconX = position.x + 10;
      const iconY = position.y + (NODE_HEIGHT - ICON) / 2;
      const iconCx = iconX + ICON / 2;
      const iconCy = iconY + ICON / 2;
      const textX = iconX + ICON + 9;
      return {
        ...node,
        key: `n-${node.id}`,
        x: position.x,
        y: position.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        rx: isStart ? NODE_HEIGHT / 2 : 10,
        className: `node node-${tone}${flagged ? " node-flagged" : ""}`,
        isDiamond: node.type === "decisions",
        isCircle: node.type === "loops" || isStart,
        isSquare:
          node.type !== "decisions" && node.type !== "loops" && !isStart,
        iconX,
        iconY,
        iconCx,
        iconCy,
        iconR: ICON / 2,
        iconSize: ICON,
        diamond: `${iconCx},${iconY - 1} ${iconX + ICON + 1},${iconCy} ${iconCx},${iconY + ICON + 1} ${iconX - 1},${iconCy}`,
        glyph: TYPE_GLYPHS[node.type] || "•",
        glyphY: iconCy + 4.5,
        labelX: textX,
        labelY: position.y + NODE_HEIGHT / 2 - 2,
        typeY: position.y + NODE_HEIGHT / 2 + 12,
        label: truncate(node.label, 20),
        typeLabel: flagged
          ? "In a loop ⚠"
          : TYPE_LABELS[node.type] || node.type,
        title: `${node.label} — ${TYPE_LABELS[node.type] || node.type}${flagged ? " — queries or writes inside a loop" : ""}`
      };
    });

    const drawnEdges = [];
    edges.forEach((edge, index) => {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) {
        return;
      }
      const x1 = from.x + NODE_WIDTH / 2;
      const y1 = from.y + NODE_HEIGHT;
      const x2 = to.x + NODE_WIDTH / 2;
      const y2 = to.y;
      let path;
      let labelX;
      let labelY;
      let head;
      if (to.y > from.y) {
        const middle = (y1 + y2) / 2;
        path = `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2 - 2}`;
        head = arrow({ x: x2, y: middle }, { x: x2, y: y2 });
        labelX = (x1 + x2) / 2;
        labelY = middle - 3;
      } else {
        // retour vers un niveau supérieur (boucle) : par la droite
        const side = width - 30;
        const fromY = from.y + NODE_HEIGHT / 2;
        const toY = to.y + NODE_HEIGHT / 2;
        path = `M ${from.x + NODE_WIDTH} ${fromY} C ${side} ${fromY}, ${side} ${toY}, ${to.x + NODE_WIDTH + 2} ${toY}`;
        head = arrow({ x: side, y: toY }, { x: to.x + NODE_WIDTH, y: toY });
        labelX = side - 6;
        labelY = (fromY + toY) / 2;
      }
      drawnEdges.push({
        key: `e-${index}`,
        path,
        head,
        className: `edge${edge.fault ? " edge-fault" : ""}${to.y <= from.y ? " edge-back" : ""}`,
        hasLabel: !!edge.label,
        label: truncate(edge.label, 18),
        labelX,
        labelY,
        labelClass: `edge-label${edge.fault ? " edge-label-fault" : ""}`
      });
    });

    return { width, height, nodes: drawnNodes, edges: drawnEdges };
  }

  /** Le flow a été analysé mais son modèle a été réduit (flow trop grand pour être gardé). */
  @api omitted = false;

  get hasDiagram() {
    return (this.model?.nodes || []).length > 1;
  }

  /** Logigramme retiré du modèle réduit (`truncated`, `nodesCount`) ou modèle entier retiré. */
  get tooLarge() {
    const model = this.model;
    return Boolean(
      this.omitted ||
      (model &&
        (model.modelOmitted ||
          (model.truncated && !Array.isArray(model.nodes))))
    );
  }

  get viewBox() {
    return `0 0 ${this.layout.width} ${this.layout.height}`;
  }

  get svgStyle() {
    return `width:${Math.round(this.layout.width * this.zoom)}px`;
  }

  get zoomText() {
    return `${Math.round(this.zoom * 100)}%`;
  }

  get stats() {
    const counts = this.model?.elementCounts || {};
    return Object.keys(counts)
      .filter((type) => counts[type])
      .map((type) => ({
        key: type,
        text: `${counts[type]} ${TYPE_LABELS[type] || type}`
      }));
  }

  renderedCallback() {
    if (!this.fitted && this.hasDiagram) {
      this.fitted = true;
      const scroll = this.template.querySelector(".scroll");
      if (
        scroll &&
        scroll.clientWidth &&
        this.layout.width > scroll.clientWidth
      ) {
        this.zoom = Math.max(
          0.4,
          Math.round((scroll.clientWidth / this.layout.width) * 100) / 100
        );
      }
    }
  }

  handleZoomIn() {
    this.zoom = ZOOM_STEPS.find((step) => step > this.zoom + 0.001) || 2;
  }

  handleZoomOut() {
    this.zoom =
      [...ZOOM_STEPS].reverse().find((step) => step < this.zoom - 0.001) || 0.4;
  }

  handleZoomReset() {
    this.zoom = 1;
  }

  handleFit() {
    const scroll = this.template.querySelector(".scroll");
    if (scroll?.clientWidth) {
      this.zoom = Math.max(
        0.4,
        Math.min(
          2,
          Math.round(((scroll.clientWidth - 8) / this.layout.width) * 100) / 100
        )
      );
    }
  }
}
