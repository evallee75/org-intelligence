import { LightningElement, api } from "lwc";

const SIZES = {
  spark: { width: 160, height: 36, top: 4, bottom: 4, left: 0, right: 0 },
  full: { width: 1000, height: 190, top: 18, bottom: 24, left: 34, right: 8 }
};
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

/**
 * Courbe d'une métrique d'alerte : valeurs par pas de temps, ligne de seuil en pointillé, zones
 * au-delà du seuil en rouge et repères des déclenchements simulés. Deux formats : « spark »
 * (cartes des règles) et « full » (aperçu de l'éditeur, avec axes).
 */
export default class OrgIntelApiAlertChart extends LightningElement {
  @api values = [];
  @api times = [];
  @api fireTimes = [];
  @api threshold;
  @api comparator = "AtLeast";
  @api variant = "spark";
  @api label = "Metric over time";

  get size() {
    return SIZES[this.variant] || SIZES.spark;
  }

  get isFull() {
    return this.variant === "full";
  }

  get viewBox() {
    return `0 0 ${this.size.width} ${this.size.height}`;
  }

  /** La courbe compacte s'étire ; le format complet garde ses proportions (textes lisibles). */
  get aspect() {
    return this.isFull ? "xMidYMid meet" : "none";
  }

  get svgClass() {
    return `chart chart-${this.variant}`;
  }

  get geometry() {
    const size = this.size;
    const values = (this.values || []).map((v) => Number(v) || 0);
    const threshold =
      this.threshold === null || this.threshold === undefined
        ? null
        : Number(this.threshold);
    const max = Math.max(
      1,
      threshold === null ? 0 : threshold * 1.25,
      ...values
    );
    const plotWidth = size.width - size.left - size.right;
    const plotHeight = size.height - size.top - size.bottom;
    const count = Math.max(values.length, 2);
    const x = (i) => size.left + (plotWidth * i) / (count - 1);
    const y = (v) => size.top + plotHeight - (plotHeight * v) / max;
    const breaches = (v) =>
      threshold !== null &&
      (this.comparator === "AtMost" ? v <= threshold : v >= threshold);

    let line = "";
    values.forEach((v, i) => {
      line += `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    });
    const baseY = (size.top + plotHeight).toFixed(1);
    const area = values.length
      ? `${line}L ${x(values.length - 1).toFixed(1)} ${baseY} L ${x(0).toFixed(1)} ${baseY} Z`
      : "";

    // Segments au-delà du seuil (barres verticales fines)
    const barWidth = Math.max(1.5, plotWidth / count);
    const hot = [];
    values.forEach((v, i) => {
      if (breaches(v)) {
        hot.push({
          key: `h-${i}`,
          x: (x(i) - barWidth / 2).toFixed(1),
          y: size.top,
          width: barWidth.toFixed(1),
          height: plotHeight
        });
      }
    });

    // Repères de déclenchement, placés par date sur l'axe
    const times = (this.times || []).map((t) => new Date(t).getTime());
    const start = times[0];
    const end = times[times.length - 1];
    const fires = (this.fireTimes || [])
      .map((t) => new Date(t).getTime())
      .filter((t) => start !== undefined && end > start && t >= start - 1)
      .map((t, i) => {
        const fx = size.left + (plotWidth * (t - start)) / (end - start);
        return {
          key: `f-${i}`,
          points: `${(fx - 4).toFixed(1)},${size.top - 9} ${(fx + 4).toFixed(1)},${size.top - 9} ${fx.toFixed(1)},${size.top - 2}`
        };
      });

    // Graduations de l'axe des temps : un repère par jour (format complet)
    const ticks = [];
    if (this.isFull && times.length > 1) {
      let lastDay = null;
      times.forEach((t, i) => {
        const date = new Date(t);
        const day = date.getDate();
        if (lastDay !== null && day !== lastDay) {
          ticks.push({
            key: `t-${i}`,
            x: x(i).toFixed(1),
            labelX: (x(i) + 3).toFixed(1),
            y1: size.top,
            y2: size.top + plotHeight,
            labelY: size.height - 6,
            label: DAY.format(date)
          });
        }
        lastDay = day;
      });
    }

    return {
      line,
      area,
      hot,
      fires,
      ticks,
      hasThreshold: threshold !== null,
      thresholdY: threshold === null ? 0 : y(threshold).toFixed(1),
      x1: size.left,
      x2: size.width - size.right,
      maxLabel: Math.round(max * 10) / 10,
      maxY: size.top + 4,
      baseY,
      zeroLabelY: size.top + plotHeight,
      thresholdLabel:
        threshold === null
          ? ""
          : `threshold ${Math.round(threshold * 10) / 10}`,
      thresholdLabelX: size.width - size.right - 4,
      thresholdLabelY: threshold === null ? 0 : (y(threshold) - 4).toFixed(1)
    };
  }
}
