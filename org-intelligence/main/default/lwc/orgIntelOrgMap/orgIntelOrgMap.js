import { LightningElement, api } from "lwc";
import {
  layoutOrgGraph,
  nodeLines,
  placeSegments,
  truncate
} from "c/orgIntelAutomationModel";

// Mise en page mémorisée hors des champs réactifs (une écriture pendant le rendu le relancerait)
const LAYOUTS = new WeakMap();

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/**
 * Carte des automatisations de l'org : un nœud par objet (et par flow lancé appelé), une flèche
 * par écriture d'un autre objet. Survol = voisins mis en évidence, clic = ordre d'exécution de
 * l'objet. Zoom, recherche et mode « problèmes seulement ».
 */
export default class OrgIntelOrgMap extends LightningElement {
  @api data;
  zoom = 1;
  search = "";
  focusIssues = false;
  hoverKey = null;
  fitted = false;

  // ---------- Mise en page ----------

  get focusKeys() {
    if (!this.focusIssues || !this.data) {
      return null;
    }
    const { nodes, edges } = this.data.graph;
    const flagged = new Set(
      nodes
        .filter((n) => n.conflictCount || n.inLoop || n.errors)
        .map((n) => n.key)
    );
    const keys = new Set(flagged);
    for (const edge of edges) {
      if (flagged.has(edge.from) || flagged.has(edge.to)) {
        keys.add(edge.from);
        keys.add(edge.to);
      }
    }
    return keys;
  }

  get layout() {
    if (!this.data) {
      return null;
    }
    const cached = LAYOUTS.get(this);
    if (
      cached &&
      cached.data === this.data &&
      cached.focus === this.focusIssues
    ) {
      return cached.value;
    }
    const value = layoutOrgGraph(this.data.graph, {
      onlyKeys: this.focusKeys
    });
    LAYOUTS.set(this, { data: this.data, focus: this.focusIssues, value });
    return value;
  }

  get hasNodes() {
    return (this.layout?.nodes || []).length > 0;
  }

  get neighbours() {
    if (!this.hoverKey) {
      return null;
    }
    const keys = new Set([this.hoverKey]);
    for (const edge of this.layout.edges) {
      if (edge.from === this.hoverKey) {
        keys.add(edge.to);
      }
      if (edge.to === this.hoverKey) {
        keys.add(edge.from);
      }
    }
    return keys;
  }

  get searchTerm() {
    return this.search.trim().toLowerCase();
  }

  matches(node) {
    const term = this.searchTerm;
    return (
      !term ||
      node.name.toLowerCase().includes(term) ||
      (node.apiName || "").toLowerCase().includes(term)
    );
  }

  get nodes() {
    const neighbours = this.neighbours;
    const term = this.searchTerm;
    return this.layout.nodes.map((node) => {
      const lines = nodeLines(node);
      const dim =
        (neighbours && !neighbours.has(node.key)) ||
        (term && !this.matches(node));
      const classes = ["node", `node-${node.type}`];
      if (!node.automated) {
        classes.push("node-passive");
      }
      if (node.inLoop) {
        classes.push("node-loop");
      }
      if (dim) {
        classes.push("is-dim");
      }
      if (node.key === this.hoverKey) {
        classes.push("is-hover");
      }
      if (term && this.matches(node)) {
        classes.push("is-match");
      }
      const { x, y, width: w, height: h } = node;
      const counts = placeSegments(lines.counts, x + 16, { dot: 10 }).map(
        (seg) => ({
          ...seg,
          hasDot: !!seg.color,
          dotX: seg.x + 3.5,
          textX: seg.color ? seg.textX : seg.x,
          dotStyle: seg.color ? `fill:${seg.color}` : ""
        })
      );
      const status = placeSegments(lines.status, x + 16, {
        charWidth: 5.9,
        gap: 14
      }).map((seg) => ({ ...seg, className: `status status-${seg.tone}` }));
      const description = [
        node.name,
        node.type === "flow"
          ? "autolaunched flow"
          : node.automated
            ? `${node.automationCount} active automations`
            : "no automation of its own",
        ...lines.status.map((s) => s.text)
      ].join(", ");
      return {
        key: node.key,
        dataKey: node.key,
        className: classes.join(" "),
        x,
        y,
        w,
        h,
        barX: x,
        barY: y + 12,
        barH: h - 24,
        nameX: x + 16,
        nameY: y + 24,
        name: truncate(node.name, 26),
        countY: y + 46,
        dotY: y + 42,
        statusY: y + 65,
        counts,
        status,
        clickable: node.type === "object" && node.automated,
        tabIndex: node.automated ? "0" : "-1",
        ariaLabel: description,
        title: node.automated
          ? `${description} — click to open its order of execution`
          : description
      };
    });
  }

  get edges() {
    const neighbours = this.neighbours;
    return this.layout.edges.map((edge) => {
      const dim =
        neighbours &&
        !(edge.from === this.hoverKey || edge.to === this.hoverKey);
      const classes = ["edge", `edge-${edge.operation}`];
      if (edge.loop) {
        classes.push("edge-loop");
      }
      if (edge.isBack) {
        classes.push("edge-back");
      }
      if (dim) {
        classes.push("is-dim");
      }
      if (neighbours && !dim) {
        classes.push("is-active");
      }
      const w = edge.labelWidth || edge.label.length * 5.8 + 12;
      return {
        key: edge.key,
        className: classes.join(" "),
        path: edge.path,
        head: edge.head,
        width: edge.width,
        label: edge.label,
        labelX: edge.labelX,
        labelY: edge.labelY + 3,
        pillX: edge.labelX - w / 2,
        pillY: edge.labelY - 9,
        pillW: w,
        title: `${edge.automations.map((a) => a.name).join(", ")} ${edge.label.replace(/ ×\d+$/, "")} ${this.nameOf(edge.to)}`
      };
    });
  }

  nameOf(key) {
    return this.layout.nodes.find((n) => n.key === key)?.name || key;
  }

  get showGridLabel() {
    return this.layout?.hasIsolated;
  }

  get gridLabelY() {
    return this.layout?.gridLabelY;
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

  get summaryText() {
    const l = this.layout;
    if (!l) {
      return "";
    }
    const writes = l.edges.length;
    return `${l.nodes.length} nodes · ${writes} cross-object link${writes === 1 ? "" : "s"}`;
  }

  get focusVariant() {
    return this.focusIssues ? "brand" : "neutral";
  }

  // ---------- Interactions ----------

  renderedCallback() {
    if (!this.fitted && this.hasNodes) {
      this.fitted = true;
      this.fit(true);
    }
  }

  fit(onlyShrink = false) {
    const scroll = this.template.querySelector(".map-scroll");
    if (!scroll || !this.layout) {
      return;
    }
    const available = scroll.clientWidth - 8;
    let zoom = available / this.layout.width;
    if (onlyShrink) {
      zoom = Math.min(1, zoom);
    }
    this.zoom = Math.max(0.35, Math.min(2, Math.round(zoom * 100) / 100));
  }

  handleZoomIn() {
    this.zoom = ZOOM_STEPS.find((step) => step > this.zoom + 0.001) || 2;
  }

  handleZoomOut() {
    this.zoom =
      [...ZOOM_STEPS].reverse().find((step) => step < this.zoom - 0.001) ||
      0.35;
  }

  handleZoomReset() {
    this.zoom = 1;
  }

  handleFit() {
    this.fit(false);
  }

  handleSearch(event) {
    this.search = event.target.value || "";
  }

  handleFocusIssues() {
    this.focusIssues = !this.focusIssues;
    this.hoverKey = null;
    this.fitted = false;
  }

  handleNodeEnter(event) {
    this.hoverKey = event.currentTarget.dataset.key;
  }

  handleNodeLeave() {
    this.hoverKey = null;
  }

  handleNodeClick(event) {
    this.open(event.currentTarget.dataset.key);
  }

  handleNodeKeydown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.open(event.currentTarget.dataset.key);
    }
  }

  open(key) {
    const node = this.layout.nodes.find((n) => n.key === key);
    if (!node || !node.automated) {
      return;
    }
    if (node.type === "flow") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("selectobject", { detail: { objectName: node.name } })
    );
  }
}
