import { LightningElement, api } from "lwc";

const WIDTH = 640;
const HEIGHT = 230;
const MARGIN = { top: 12, right: 12, bottom: 34, left: 40 };
const GAP = 2;

const TONE_COLORS = {
  critical: "#d03b3b",
  serious: "#ec835a",
  warning: "#fab219",
  low: "#3b7dd8",
  neutral: "#9aa1ab",
  good: "#2e7d32",
  info: "#0b5cab",
  accent: "#0b5cab"
};

function niceMax(value) {
  if (value <= 5) {
    return 5;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.find((s) => s * magnitude >= value / 4) * magnitude;
  return Math.ceil(value / step) * step;
}

/**
 * Petit graphique SVG sans dépendance : barres empilées (« stacked »), barres groupées
 * (« grouped ») ou courbe (« line »). Légende, infobulle au survol et table de données
 * accessible (lecteurs d'écran) inclus.
 *
 * points : [{ key, label, sublabel, values: { serieKey: number } }]
 * series : [{ key, label, tone }]
 */
export default class OrgIntelTrendChart extends LightningElement {
  @api points = [];
  @api series = [];
  @api mode = "stacked";
  @api title;
  @api yMax;
  @api valueSuffix = "";

  hoverIndex = null;

  viewBox = `0 0 ${WIDTH} ${HEIGHT}`;

  get plotWidth() {
    return WIDTH - MARGIN.left - MARGIN.right;
  }

  get plotHeight() {
    return HEIGHT - MARGIN.top - MARGIN.bottom;
  }

  get hasData() {
    return (this.points || []).length > 0;
  }

  get maxValue() {
    if (this.yMax) {
      return this.yMax;
    }
    const total = (point) => {
      const values = this.series.map((serie) => point.values[serie.key] || 0);
      if (this.mode === "stacked") {
        return values.reduce((sum, value) => sum + value, 0);
      }
      return Math.max(0, ...values);
    };
    const totals = this.points.map(total);
    return niceMax(Math.max(1, ...totals));
  }

  y(value) {
    return (
      MARGIN.top + this.plotHeight - (value / this.maxValue) * this.plotHeight
    );
  }

  get band() {
    return this.plotWidth / Math.max(1, this.points.length);
  }

  get gridLines() {
    const max = this.maxValue;
    return [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const value = Math.round(max * ratio * 10) / 10;
      const y = this.y(value);
      return {
        key: `g-${ratio}`,
        y,
        x1: MARGIN.left,
        x2: WIDTH - MARGIN.right,
        label: `${value}${this.valueSuffix}`,
        labelX: MARGIN.left - 6,
        labelY: y + 4
      };
    });
  }

  get xLabels() {
    const step = Math.ceil(this.points.length / 10);
    return this.points
      .map((point, index) => ({
        key: `x-${point.key}`,
        text: point.label,
        x: MARGIN.left + this.band * index + this.band / 2,
        y: HEIGHT - MARGIN.bottom + 16,
        show: index % step === 0 || index === this.points.length - 1
      }))
      .filter((label) => label.show);
  }

  get bars() {
    if (this.mode === "line") {
      return [];
    }
    const band = this.band;
    const result = [];
    this.points.forEach((point, index) => {
      if (this.mode === "stacked") {
        const width = Math.min(36, band * 0.6);
        const x = MARGIN.left + band * index + (band - width) / 2;
        let base = 0;
        for (const serie of this.series) {
          const value = point.values[serie.key] || 0;
          if (!value) {
            continue;
          }
          const top = this.y(base + value);
          const bottom = this.y(base);
          const height = Math.max(1, bottom - top - (base > 0 ? GAP : 0));
          result.push({
            key: `${point.key}-${serie.key}`,
            x,
            y: top,
            width,
            height,
            fill: TONE_COLORS[serie.tone] || TONE_COLORS.accent
          });
          base += value;
        }
      } else {
        const groupWidth = Math.min(48, band * 0.7);
        const width =
          (groupWidth - GAP * (this.series.length - 1)) / this.series.length;
        const start = MARGIN.left + band * index + (band - groupWidth) / 2;
        this.series.forEach((serie, serieIndex) => {
          const value = point.values[serie.key] || 0;
          const top = this.y(value);
          result.push({
            key: `${point.key}-${serie.key}`,
            x: start + serieIndex * (width + GAP),
            y: top,
            width,
            height: Math.max(value ? 1 : 0, this.y(0) - top),
            fill: TONE_COLORS[serie.tone] || TONE_COLORS.accent
          });
        });
      }
    });
    return result;
  }

  get lines() {
    if (this.mode !== "line") {
      return [];
    }
    return this.series.map((serie) => {
      const coordinates = this.points
        .map((point, index) => {
          const value = point.values[serie.key];
          if (value === null || value === undefined) {
            return null;
          }
          return {
            key: `${point.key}-${serie.key}`,
            cx: MARGIN.left + this.band * index + this.band / 2,
            cy: this.y(value)
          };
        })
        .filter(Boolean);
      return {
        key: serie.key,
        path: coordinates.map((c) => `${c.cx},${c.cy}`).join(" "),
        stroke: TONE_COLORS[serie.tone] || TONE_COLORS.accent,
        dots: coordinates.map((c) => ({
          ...c,
          fill: TONE_COLORS[serie.tone] || TONE_COLORS.accent
        }))
      };
    });
  }

  get hitAreas() {
    return this.points.map((point, index) => ({
      key: `hit-${point.key}`,
      index,
      x: MARGIN.left + this.band * index,
      y: MARGIN.top,
      width: this.band,
      height: this.plotHeight,
      className: index === this.hoverIndex ? "hit hit-active" : "hit"
    }));
  }

  get legend() {
    return this.series.map((serie) => ({
      ...serie,
      swatch: `background:${TONE_COLORS[serie.tone] || TONE_COLORS.accent}`
    }));
  }

  get showLegend() {
    return this.series.length > 1;
  }

  get tooltip() {
    if (this.hoverIndex === null || !this.points[this.hoverIndex]) {
      return null;
    }
    const point = this.points[this.hoverIndex];
    const leftPercent =
      ((MARGIN.left + this.band * this.hoverIndex + this.band / 2) / WIDTH) *
      100;
    const flip = leftPercent > 65;
    return {
      title: point.label,
      sublabel: point.sublabel,
      rows: this.series.map((serie) => ({
        key: serie.key,
        label: serie.label,
        value:
          point.values[serie.key] === null ||
          point.values[serie.key] === undefined
            ? "—"
            : `${point.values[serie.key]}${this.valueSuffix}`,
        swatch: `background:${TONE_COLORS[serie.tone] || TONE_COLORS.accent}`
      })),
      style: flip
        ? `right:${100 - leftPercent + 2}%`
        : `left:${leftPercent + 2}%`
    };
  }

  get tableRows() {
    return this.points.map((point) => ({
      key: point.key,
      label: point.label,
      cells: this.series.map((serie) => ({
        key: `${point.key}-${serie.key}`,
        value: point.values[serie.key] ?? "—"
      }))
    }));
  }

  handleEnter(event) {
    this.hoverIndex = Number(event.target.dataset.index);
  }

  handleLeave() {
    this.hoverIndex = null;
  }
}
