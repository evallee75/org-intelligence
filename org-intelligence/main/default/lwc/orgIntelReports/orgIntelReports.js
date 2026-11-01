import { LightningElement } from "lwc";
import { NavigationMixin } from "lightning/navigation";
import getReportsView from "@salesforce/apex/OrgIntelligenceController.getReportsView";
import { loadScanHistory, isFinished } from "c/orgIntelScanData";
import { subscribe } from "c/orgIntelScanEngine";
import {
  loadLocalRecommendations,
  isOpenStatus
} from "c/orgIntelRecommendationStore";
import {
  SEVERITIES,
  exportRows,
  formatExportDate,
  formatDate,
  formatNumber,
  formatRelative
} from "c/orgIntelUtils";

const TREND_SCANS = 20;
const DAY_MS = 86400000;

/** Mois « AAAA-MM » d'une date ISO (fuseau du navigateur). */
function monthOf(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Indicateurs de résolution calculés depuis les recommandations gardées dans le navigateur (même
 * calcul qu'OrgRecommendationInsights.fillReports du module collaboratif).
 */
function localInsights(byFingerprint) {
  const records = Object.values(byFingerprint || {});
  const since = Date.now() - 90 * DAY_MS;
  const months = new Map();
  const first = new Date();
  first.setDate(1);
  first.setMonth(first.getMonth() - 5);
  for (let i = 0; i < 6; i++) {
    const month = new Date(first.getFullYear(), first.getMonth() + i, 1);
    const key = monthOf(month);
    months.set(key, { month: key, created: 0, resolved: 0 });
  }
  const categories = new Map();
  let open = 0;
  let created90 = 0;
  let resolved90 = 0;
  let resolvedDays = 0;
  let resolvedCount = 0;
  records.forEach((rec) => {
    const createdAt = rec.CreatedDate || rec.FirstDetectedAt__c;
    const resolvedAt =
      rec.Status__c === "Resolved" ? rec.ResolvedDate__c : null;
    if (createdAt) {
      if (new Date(createdAt).getTime() >= since) {
        created90++;
      }
      const point = months.get(monthOf(createdAt));
      if (point) {
        point.created++;
      }
    }
    if (resolvedAt) {
      if (new Date(resolvedAt).getTime() >= since) {
        resolved90++;
      }
      const point = months.get(monthOf(resolvedAt));
      if (point) {
        point.resolved++;
      }
      if (createdAt) {
        resolvedDays +=
          (new Date(resolvedAt).getTime() - new Date(createdAt).getTime()) /
          DAY_MS;
        resolvedCount++;
      }
    }
    if (isOpenStatus(rec.Status__c)) {
      open++;
      const category = rec.Category__c || null;
      categories.set(category, (categories.get(category) || 0) + 1);
    }
  });
  return {
    recordCount: records.length,
    openCount: open,
    createdLast90Days: created90,
    resolvedLast90Days: resolved90,
    averageDaysToResolve: resolvedCount
      ? Math.round((resolvedDays / resolvedCount) * 10) / 10
      : null,
    resolutionTrend: [...months.values()],
    openByCategory: [...categories.entries()]
      .map(([componentType, count]) => ({ componentType, count }))
      .sort((a, b) => b.count - a.count)
  };
}

const SEVERITY_SERIES = SEVERITIES.map((s) => ({
  key: s.value.toLowerCase(),
  label: s.label,
  tone: s.tone
}));

/**
 * Section « Reports » : tendances calculées sur l'historique des scans gardé dans le navigateur,
 * tendances de résolution (module collaboratif, sinon recommandations locales), et accès aux
 * rapports et au tableau de bord natifs Salesforce.
 */
export default class OrgIntelReports extends NavigationMixin(LightningElement) {
  view;
  error;
  isLoading = true;

  severitySeries = SEVERITY_SERIES;
  scoreSeries = [{ key: "score", label: "Health score", tone: "accent" }];
  resolutionSeries = [
    { key: "created", label: "Created", tone: "warning" },
    { key: "resolved", label: "Resolved", tone: "good" }
  ];

  scanRunning = false;

  connectedCallback() {
    this.load();
    // Recharge à la fin d'un scan lancé depuis une autre section
    this.unsubscribe = subscribe((run) => {
      const running = run?.status === "Running";
      if (this.scanRunning && !running) {
        this.load();
      }
      this.scanRunning = running;
    });
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }

  async load() {
    this.isLoading = !this.view;
    try {
      const [serverView, history] = await Promise.all([
        getReportsView(),
        loadScanHistory()
      ]);
      // Tendance des scans : 20 derniers terminés, du plus ancien au plus récent
      const scanTrend = history
        .filter((entry) => isFinished(entry.status))
        .slice(0, TREND_SCANS)
        .reverse()
        .map((entry) => ({
          scanId: entry.id,
          scanName: entry.name || "",
          completedAt: entry.completedAt,
          healthScore: entry.healthScore,
          componentCount: entry.componentCount,
          critical: entry.critical || 0,
          high: entry.high || 0,
          medium: entry.medium || 0,
          low: entry.low || 0,
          info: entry.info || 0
        }));
      let view = { ...serverView, scanTrend, historyCount: history.length };
      if (!serverView.recommendationsEnabled) {
        const insights = localInsights(await loadLocalRecommendations());
        if (insights.recordCount) {
          view = { ...view, ...insights, localRecommendations: true };
        }
      }
      this.view = view;
      this.error = undefined;
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Indicateurs de recommandations : module collaboratif installé, ou recommandations gardées
   * dans le navigateur ; sinon indicateurs et courbes portent sur les scans seuls.
   */
  get recommendationsEnabled() {
    return (
      this.view?.recommendationsEnabled === true ||
      this.view?.localRecommendations === true
    );
  }

  /** Rapports natifs : livrés par le module Recommendations collaboratif seulement. */
  get hasNativeReports() {
    return this.view?.recommendationsEnabled === true;
  }

  get pageHelp() {
    return this.hasNativeReports
      ? "Trends of the scans kept in this browser, resolution of the recommendations, and the native Salesforce reports of the Recommendations module."
      : "Trends of the scans kept in this browser and resolution of the recommendations.";
  }

  get isLocalRecommendations() {
    return this.view?.localRecommendations === true;
  }

  /** Indicateurs sans le module Recommendations : dernier scan terminé. */
  get scanKpis() {
    const trend = this.view?.scanTrend || [];
    const latest = trend.reduce((last, point) => {
      const isNewer =
        !last || new Date(point.completedAt) > new Date(last.completedAt);
      return isNewer ? point : last;
    }, null);
    const findings = latest
      ? latest.critical + latest.high + latest.medium + latest.low + latest.info
      : null;
    return [
      {
        key: "scans",
        label: "Completed scans",
        value: formatNumber(trend.length),
        help: "Completed scans kept in this browser's history. Charts show the last 20."
      },
      {
        key: "score",
        label: "Latest health score",
        value:
          latest?.healthScore === null || latest?.healthScore === undefined
            ? "—"
            : formatNumber(latest.healthScore),
        unit:
          latest?.healthScore === null || latest?.healthScore === undefined
            ? null
            : "/ 100",
        caption: latest ? latest.scanName : "No completed scan yet"
      },
      {
        key: "findings",
        label: "Findings (latest scan)",
        value: findings === null ? "—" : formatNumber(findings),
        caption: latest
          ? `${formatNumber(latest.critical + latest.high)} critical or high`
          : ""
      },
      {
        key: "components",
        label: "Components (latest scan)",
        value: latest ? formatNumber(latest.componentCount) : "—",
        help: "Apex, flows, objects, fields and rules inventoried by the latest scan."
      }
    ];
  }

  get kpis() {
    if (!this.recommendationsEnabled) {
      return this.scanKpis;
    }
    const v = this.view;
    return [
      {
        key: "open",
        label: "Open recommendations",
        value: formatNumber(v?.openCount),
        help: "Recommendations neither resolved nor ignored."
      },
      {
        key: "created",
        label: "Created (90 days)",
        value: formatNumber(v?.createdLast90Days),
        help: this.isLocalRecommendations
          ? "New recommendations created over the last 90 days (stored in this browser)."
          : "New recommendations created by scans over the last 90 days."
      },
      {
        key: "resolved",
        label: "Resolved (90 days)",
        value: formatNumber(v?.resolvedLast90Days),
        help: "Recommendations marked Resolved by the team over the last 90 days."
      },
      {
        key: "days",
        label: "Average time to resolve",
        value:
          v?.averageDaysToResolve === null ||
          v?.averageDaysToResolve === undefined
            ? "—"
            : formatNumber(v.averageDaysToResolve),
        unit:
          v?.averageDaysToResolve === null ||
          v?.averageDaysToResolve === undefined
            ? null
            : "days",
        help: "Average number of days from creation to resolution."
      }
    ];
  }

  get findingPoints() {
    return (this.view?.scanTrend || []).map((point) => ({
      key: point.scanId,
      label: (point.scanName || "").replace("SCAN-", "#"),
      sublabel: formatDate(point.completedAt),
      values: {
        critical: point.critical,
        high: point.high,
        medium: point.medium,
        low: point.low,
        info: point.info
      }
    }));
  }

  get scorePoints() {
    return (this.view?.scanTrend || []).map((point) => ({
      key: point.scanId,
      label: (point.scanName || "").replace("SCAN-", "#"),
      sublabel: formatDate(point.completedAt),
      values: { score: point.healthScore }
    }));
  }

  get resolutionPoints() {
    return (this.view?.resolutionTrend || []).map((point) => ({
      key: point.month,
      label: new Intl.DateTimeFormat("en-GB", {
        month: "short",
        year: "2-digit"
      }).format(new Date(`${point.month}-01T00:00:00`)),
      values: { created: point.created, resolved: point.resolved }
    }));
  }

  get categories() {
    const rows = this.view?.openByCategory || [];
    const max = Math.max(1, ...rows.map((row) => row.count));
    return rows.map((row) => ({
      key: row.componentType || "none",
      label: row.componentType || "Uncategorized",
      count: formatNumber(row.count),
      barStyle: `width:${Math.max(2, (row.count / max) * 100)}%`
    }));
  }

  get hasCategories() {
    return this.categories.length > 0;
  }

  get reports() {
    return (this.view?.reports || []).map((report) => {
      const lastRun = report.lastRunDate
        ? formatRelative(report.lastRunDate)
        : "Never run";
      return {
        ...report,
        lastRun,
        // Description masquée de la ligne compacte : affichée au survol
        tooltip: [
          report.name,
          report.description,
          report.lastRunDate ? `Last run ${lastRun}` : lastRun
        ]
          .filter(Boolean)
          .join(" — ")
      };
    });
  }

  /**
   * Données des graphiques et liste des rapports : un onglet Excel chacun ; le CSV reprend les
   * tendances par scan.
   */
  handleExport(event) {
    const view = this.view || {};
    exportRows({
      name: "reports",
      format: event.detail.format,
      sheets: [
        {
          name: "Scans",
          rows: view.scanTrend || [],
          columns: [
            { label: "Scan", value: (p) => p.scanName },
            {
              label: "Completed",
              value: (p) => formatExportDate(p.completedAt)
            },
            { label: "Health score", value: (p) => p.healthScore },
            { label: "Critical", value: (p) => p.critical },
            { label: "High", value: (p) => p.high },
            { label: "Medium", value: (p) => p.medium },
            { label: "Low", value: (p) => p.low },
            { label: "Info", value: (p) => p.info }
          ]
        },
        {
          name: "Recommendations per month",
          rows: view.resolutionTrend || [],
          columns: [
            { label: "Month", value: (p) => p.month },
            { label: "Created", value: (p) => p.created },
            { label: "Resolved", value: (p) => p.resolved }
          ]
        },
        {
          name: "Open by category",
          rows: view.openByCategory || [],
          columns: [
            {
              label: "Category",
              value: (row) => row.componentType || "Uncategorized"
            },
            { label: "Open recommendations", value: (row) => row.count }
          ]
        },
        {
          name: "Native reports",
          rows: view.reports || [],
          columns: [
            { label: "Report", value: (r) => r.name },
            { label: "Description", value: (r) => r.description },
            {
              label: "Last run",
              value: (r) => formatExportDate(r.lastRunDate)
            },
            { label: "Report Id", value: (r) => r.id }
          ]
        }
      ]
    });
  }

  get hasReports() {
    return this.reports.length > 0;
  }

  get hasDashboard() {
    return !!this.view?.dashboardId;
  }

  handleOpenReport(event) {
    this[NavigationMixin.Navigate]({
      type: "standard__recordPage",
      attributes: {
        recordId: event.currentTarget.dataset.id,
        objectApiName: "Report",
        actionName: "view"
      }
    });
  }

  handleOpenDashboard() {
    this[NavigationMixin.Navigate]({
      type: "standard__recordPage",
      attributes: {
        recordId: this.view.dashboardId,
        objectApiName: "Dashboard",
        actionName: "view"
      }
    });
  }

  handleAllReports() {
    this[NavigationMixin.Navigate]({
      type: "standard__objectPage",
      attributes: { objectApiName: "Report", actionName: "home" }
    });
  }

  handleRefresh() {
    this.load();
  }
}
