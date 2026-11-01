import { LightningElement } from "lwc";
import getOverview from "@salesforce/apex/OrgIntelligenceController.getOverview";
import {
  SEVERITIES,
  exportRows,
  formatExportDate,
  formatDuration,
  formatNumber,
  formatRelative,
  isScanInProgress,
  pluralize,
  scanStatusTone,
  scoreBand,
  severityMeta
} from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";
import { subscribe } from "c/orgIntelScanEngine";
import {
  loadLatestScan,
  loadScanHistory,
  currentScore,
  isFinished,
  SEVERITY_ORDER
} from "c/orgIntelScanData";
import {
  loadLocalRecommendations,
  toRow,
  isOpenStatus
} from "c/orgIntelRecommendationStore";

// Actions Apex du module (via le contrôleur générique du socle)
const getRecentActivity = moduleAction("recommendations", "recentActivity");

const PRIORITY_COUNT = 5;
/** Scans affichés dans « Recent scans ». */
const RECENT_SCAN_COUNT = 5;
/** Recommandations locales gardées pour l'encart prioritaire (même plafond que le serveur). */
const PRIORITY_LIMIT = 200;

/**
 * Indicateurs de recommandations calculés depuis le stockage local (édition sans module
 * collaboratif) : ouvertes = New / To Review / Accepted, prioritaires triées par gravité.
 */
function localRecommendationIndicators(byFingerprint) {
  const rows = Object.values(byFingerprint || {}).map(toRow);
  const open = rows.filter((row) => isOpenStatus(row.status));
  const bySeverity = {};
  open.forEach((row) => {
    bySeverity[row.severity] = (bySeverity[row.severity] || 0) + 1;
  });
  const rank = (severity) => {
    const index = SEVERITY_ORDER.indexOf(severity);
    return index < 0 ? 99 : index;
  };
  return {
    openRecommendationCount: open.length,
    toReviewCount: open.filter(
      (row) => row.status === "New" || row.status === "To Review"
    ).length,
    acceptedCount: open.filter((row) => row.status === "Accepted").length,
    severityDistribution: SEVERITY_ORDER.map((severity) => ({
      severity,
      count: bySeverity[severity] || 0
    })),
    priorityRecommendations: [...open]
      .sort(
        (a, b) =>
          rank(a.severity) - rank(b.severity) ||
          Number(b.stillDetected) - Number(a.stillDetected) ||
          String(b.lastDetectedAt || "").localeCompare(
            String(a.lastDetectedAt || "")
          )
      )
      .slice(0, PRIORITY_LIMIT)
      .map((row) => ({
        id: row.id,
        name: row.name,
        title: row.title,
        severity: row.severity,
        category: row.category,
        status: row.status,
        componentName: row.componentName,
        componentType: row.componentType,
        assignedToName: null,
        // Pas d'assignation dans l'édition locale
        noAssignee: true,
        lastDetectedAt: row.lastDetectedAt,
        stillDetected: row.stillDetected
      }))
  };
}

/**
 * Vue d'ensemble : santé de l'org, dernier scan, recommandations prioritaires (filtrables par
 * gravité), activité de l'équipe et derniers scans. Les scans et, sans module collaboratif, les
 * recommandations sont lus dans le stockage du navigateur ; le serveur ne fournit que les droits,
 * les préférences du score et les indicateurs des recommandations partagées. Le score est recalculé
 * avec les préférences courantes. Sans scan, la page affiche son état vide.
 */
export default class OrgIntelOverview extends LightningElement {
  overview;
  activity = [];
  error;
  isLoading = true;
  severityFilter = null;
  searchTerm = "";
  unsubscribe;
  lastStatus;

  connectedCallback() {
    this.load();
    // Fin d'un scan (lancé ici ou ailleurs dans l'onglet) : les chiffres sont rechargés
    this.unsubscribe = subscribe((run) => {
      const wasRunning = this.lastStatus === "Running";
      this.lastStatus = run ? run.status : null;
      if (wasRunning && run && run.status !== "Running") {
        this.load();
      }
    });
  }

  disconnectedCallback() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async load() {
    this.isLoading = !this.overview;
    try {
      const [server, latestScan, history, local] = await Promise.all([
        getOverview(),
        loadLatestScan().catch(() => null),
        loadScanHistory().catch(() => []),
        loadLocalRecommendations().catch(() => ({}))
      ]);
      const collaborative = server.recommendationsEnabled === true;
      const activity = collaborative
        ? await getRecentActivity().catch(() => [])
        : [];
      this.overview = this.buildOverview(
        server,
        latestScan,
        history || [],
        local || {},
        collaborative
      );
      this.activity = activity || [];
      this.error = undefined;
    } catch (error) {
      this.error = error;
      this.overview = undefined;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Assemble la vue (ancienne forme Overview) : scans depuis le navigateur, recommandations du
   * serveur (module collaboratif) ou du stockage local.
   */
  buildOverview(server, latestScan, history, local, collaborative) {
    const scans = [...history];
    if (latestScan && !scans.some((scan) => scan.id === latestScan.id)) {
      scans.unshift({
        id: latestScan.id,
        name: latestScan.name,
        status: latestScan.status
      });
    }
    const completedSummary =
      scans.find((scan) => isFinished(scan.status)) || null;
    const latestCompletedScan = completedSummary
      ? { ...completedSummary }
      : null;
    // Score du moment (currentScore, même calcul que le détail et l'historique) : préférences
    // actuelles et, sans module collaboratif, recommandations ignorées dans ce navigateur
    const ignored = collaborative
      ? undefined
      : Object.values(local)
          .filter((rec) => rec.Status__c === "Ignored" && rec.Fingerprint__c)
          .map((rec) => rec.Fingerprint__c);
    if (latestCompletedScan) {
      const detailed =
        latestScan && latestScan.id === latestCompletedScan.id
          ? latestScan
          : latestCompletedScan;
      latestCompletedScan.healthScore = currentScore(
        detailed,
        server.scoreConfig,
        ignored
      );
    }
    const previousCompleted =
      scans.filter((scan) => isFinished(scan.status))[1] || null;
    scans.forEach((scan, index) => {
      if (latestCompletedScan && scan.id === latestCompletedScan.id) {
        scans[index] = {
          ...scan,
          healthScore: latestCompletedScan.healthScore
        };
      } else if (isFinished(scan.status)) {
        scans[index] = {
          ...scan,
          healthScore: currentScore(scan, server.scoreConfig)
        };
      }
    });
    const recommendations = collaborative
      ? {
          openRecommendationCount: server.openRecommendationCount,
          toReviewCount: server.toReviewCount,
          acceptedCount: server.acceptedCount,
          severityDistribution: server.severityDistribution,
          priorityRecommendations: server.priorityRecommendations
        }
      : localRecommendationIndicators(local);
    return {
      ...server,
      ...recommendations,
      collaborative,
      hasScans: scans.length > 0,
      latestScan: scans[0] || null,
      latestCompletedScan,
      previousCompleted,
      recentScans: scans.slice(0, RECENT_SCAN_COUNT)
    };
  }

  handleRefresh() {
    this.load();
  }

  /** Indicateur cliquable : ouvre la section correspondante (score → Reports, constats → scan). */
  handleKpi(event) {
    // L'aide contextuelle de l'indicateur ne doit pas déclencher la navigation
    if (event.target?.tagName === "LIGHTNING-HELPTEXT") {
      return;
    }
    const section = event.currentTarget.dataset.section;
    const detail =
      section === "scanner"
        ? { section, scanId: this.completed?.id || null }
        : { section };
    this.dispatchEvent(new CustomEvent("navigate", { detail }));
  }

  handleKpiKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.handleKpi(event);
    }
  }

  // ---------- États ----------

  get isEmpty() {
    return !!this.overview && !this.overview.hasScans;
  }

  get canRunScan() {
    return !!this.overview?.canRunScan;
  }

  get latest() {
    return this.overview?.latestScan;
  }

  get completed() {
    return this.overview?.latestCompletedScan;
  }

  get failedBanner() {
    const scan = this.latest;
    if (!scan || scan.status !== "Failed") {
      return null;
    }
    return `${scan.name} failed: open it to read the collection log.`;
  }

  // ---------- Score ----------

  get score() {
    return this.completed?.healthScore;
  }

  get hasScore() {
    return this.score !== null && this.score !== undefined;
  }

  get scoreLabel() {
    return this.hasScore ? formatNumber(this.score) : "—";
  }

  get band() {
    return scoreBand(this.hasScore ? this.score : null);
  }

  get meterStyle() {
    const value = this.hasScore ? Math.max(0, Math.min(100, this.score)) : 0;
    return `width: ${value}%`;
  }

  get meterClass() {
    return `meter-fill tone-${this.band.tone}`;
  }

  /** Méthode réellement appliquée (préférences de Settings). */
  get scoreMethodText() {
    const config = this.overview?.scoreConfig;
    if (!config) {
      return "";
    }
    const list = (values) =>
      SEVERITIES.filter((s) => values[s.value] !== undefined)
        .map((s) => `${s.label} ${values[s.value]}`)
        .join(", ");
    const domains = (config.domains || []).join(", ");
    return (
      `Preset: ${config.preset}. The score starts at 100. Each finding of the last completed scan removes points by severity (${list(config.points)}). ` +
      `A single rule removes at most its cap (${list(config.caps)}), so one noisy rule cannot hide everything else. ` +
      `Domains counted: ${domains}.${config.excludeIgnored ? " Ignored recommendations do not count." : ""} ` +
      "Administrators can change these preferences in Settings."
    );
  }

  // ---------- Indicateurs ----------

  get lastScanValue() {
    return formatRelative(
      this.latest?.completedAt ||
        this.latest?.startedAt ||
        this.latest?.createdDate
    );
  }

  get lastScanCaption() {
    const scan = this.latest;
    if (!scan) {
      return "";
    }
    const duration = formatDuration(scan.startedAt, scan.completedAt);
    return [pluralize(scan.componentCount, "component"), duration]
      .filter(Boolean)
      .join(" · ");
  }

  /** Pastille du dernier scan, affichée en petit sous le score. */
  get lastScanDotClass() {
    return `scan-dot scan-dot-${scanStatusTone(this.latest?.status) || "neutral"}`;
  }

  get lastScanTitle() {
    const scan = this.latest;
    if (!scan) {
      return "";
    }
    return [scan.name, scan.status, this.lastScanCaption]
      .filter(Boolean)
      .join(" · ");
  }

  get lastScanTone() {
    return scanStatusTone(this.latest?.status);
  }

  get findingValue() {
    return this.completed ? formatNumber(this.completed.findingCount) : "—";
  }

  get findingCaption() {
    const errors = this.completed?.collectionErrorCount;
    if (errors) {
      return `${pluralize(errors, "source")} not collected`;
    }
    return this.completed ? `in ${this.completed.name}` : "";
  }

  get hasCollectionErrors() {
    return !!this.completed?.collectionErrorCount;
  }

  /** Échec de la mise à jour des recommandations par le dernier scan. */
  get recommendationsError() {
    return this.completed?.recommendationsError || "";
  }

  /** Constats par domaine du dernier scan terminé, avec l'écart au scan terminé précédent. */
  get domainTrend() {
    const counts = this.completed?.domainCounts;
    if (!counts || !Object.keys(counts).length) {
      return [];
    }
    const previous = this.overview?.previousCompleted?.domainCounts || null;
    const domains = new Set([
      ...Object.keys(counts),
      ...Object.keys(previous || {})
    ]);
    return [...domains]
      .map((domain) => {
        const count = counts[domain] || 0;
        const delta = previous ? count - (previous[domain] || 0) : 0;
        let deltaText = "";
        let deltaClass = "ov-domain-delta";
        if (delta > 0) {
          deltaText = `+${delta}`;
          deltaClass += " ov-domain-up";
        } else if (delta < 0) {
          deltaText = `−${-delta}`;
          deltaClass += " ov-domain-down";
        }
        return {
          domain,
          count: formatNumber(count),
          sortKey: count,
          deltaText,
          deltaClass,
          title: previous
            ? `${domain}: ${count} findings (${delta >= 0 ? "+" : "−"}${Math.abs(delta)} since ${this.overview.previousCompleted.name})`
            : `${domain}: ${count} findings`
        };
      })
      .sort((a, b) => b.sortKey - a.sortKey);
  }

  get hasDomainTrend() {
    return this.domainTrend.length > 0;
  }

  /** Module collaboratif : activité de l'équipe (historique des décisions partagées). */
  get isCollaborative() {
    return this.overview?.collaborative === true;
  }


  get openValue() {
    return formatNumber(this.overview?.openRecommendationCount ?? 0);
  }

  get openCaption() {
    const toReview = this.overview?.toReviewCount ?? 0;
    const accepted = this.overview?.acceptedCount ?? 0;
    return `${formatNumber(toReview)} to decide · ${formatNumber(accepted)} accepted`;
  }

  // ---------- Gravités (filtre) ----------

  get distribution() {
    const rows = this.overview?.severityDistribution || [];
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const max = rows.reduce((top, row) => Math.max(top, row.count), 0);
    return rows.map((row) => {
      const meta = severityMeta(row.severity);
      const share = total ? Math.round((row.count / total) * 100) : 0;
      const selected = this.severityFilter === row.severity;
      const dimmed = !!this.severityFilter && !selected;
      return {
        key: row.severity,
        value: row.severity,
        label: meta.label,
        tone: meta.tone,
        count: formatNumber(row.count),
        share: `${share}%`,
        disabled: row.count === 0,
        pressed: selected ? "true" : "false",
        rowClass: `distribution-row${selected ? " distribution-selected" : ""}${dimmed ? " distribution-dimmed" : ""}`,
        barClass: `bar-fill tone-${meta.tone}`,
        barStyle: `width: ${row.count ? Math.max((row.count / max) * 100, 2) : 0}%`,
        title: row.count
          ? `Show the ${meta.label.toLowerCase()} recommendations`
          : `No ${meta.label.toLowerCase()} recommendation`
      };
    });
  }

  get hasOpenRecommendations() {
    return (this.overview?.openRecommendationCount ?? 0) > 0;
  }

  handleSeverity(event) {
    const value = event.currentTarget.dataset.value;
    this.severityFilter = this.severityFilter === value ? null : value;
  }

  handleClearSeverity() {
    this.severityFilter = null;
  }

  get filterLabel() {
    return this.severityFilter ? severityMeta(this.severityFilter).label : null;
  }

  get filterTone() {
    return this.severityFilter ? severityMeta(this.severityFilter).tone : null;
  }

  // ---------- Recommandations prioritaires ----------

  /** Recommandations ouvertes filtrées par gravité et par recherche. */
  get matchingPriorities() {
    const term = this.searchTerm.trim().toLowerCase();
    return (this.overview?.priorityRecommendations || []).filter(
      (rec) =>
        (!this.severityFilter || rec.severity === this.severityFilter) &&
        (!term ||
          `${rec.title} ${rec.componentName} ${rec.name} ${rec.assignedToName || ""} ${rec.status}`
            .toLowerCase()
            .includes(term))
    );
  }

  get priorities() {
    return this.matchingPriorities.slice(0, PRIORITY_COUNT).map((rec) => {
      const meta = severityMeta(rec.severity);
      return {
        ...rec,
        severityLabel: meta.label,
        severityTone: meta.tone,
        rowClass: `priority priority-${meta.tone}`,
        assignee: rec.noAssignee ? null : rec.assignedToName || "Unassigned",
        notDetected: rec.stillDetected === false,
        // Infobulle : ligne compacte tronquée, détail complet au survol
        metaTitle: [
          meta.label,
          rec.componentName,
          rec.status,
          rec.noAssignee ? null : rec.assignedToName || "Unassigned"
        ]
          .filter(Boolean)
          .join(" · ")
      };
    });
  }

  get priorityCountText() {
    const total = this.matchingPriorities.length;
    if (!total) {
      return "";
    }
    return total > PRIORITY_COUNT
      ? `Top ${PRIORITY_COUNT} of ${total}`
      : pluralize(total, "recommendation");
  }

  /** Pastilles de gravité de l'encart (compteurs selon la recherche). */
  get priorityChips() {
    const term = this.searchTerm.trim().toLowerCase();
    const rows = (this.overview?.priorityRecommendations || []).filter(
      (rec) =>
        !term ||
        `${rec.title} ${rec.componentName} ${rec.name} ${rec.assignedToName || ""} ${rec.status}`
          .toLowerCase()
          .includes(term)
    );
    const chip = (value, label, tone, count) => {
      const selected = (this.severityFilter || null) === value;
      return {
        key: value || "all",
        value: value || "",
        label,
        count,
        className: `ov-chip chip-${tone}${selected ? " chip-active" : ""}${count ? "" : " chip-empty"}`,
        pressed: selected ? "true" : "false"
      };
    };
    return [
      chip(null, "All", "all", rows.length),
      ...SEVERITIES.map((severity) =>
        chip(
          severity.value,
          severity.label,
          severity.tone,
          rows.filter((rec) => rec.severity === severity.value).length
        )
      )
    ];
  }

  handlePriorityChip(event) {
    this.severityFilter = event.currentTarget.dataset.value || null;
  }

  handlePrioritySearch(event) {
    this.searchTerm = event.target.value || "";
  }

  get hasPriorities() {
    return this.priorities.length > 0;
  }

  get priorityTitle() {
    const title = "Priority recommendations";
    return this.severityFilter ? `${title} · ${this.filterLabel}` : title;
  }

  get viewAllLabel() {
    return this.severityFilter ? `View all ${this.filterLabel}` : "View all";
  }

  handleViewAll(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: {
          section: "recommendations",
          severity: this.severityFilter,
          search: this.searchTerm.trim() || null
        }
      })
    );
  }

  handleOpenRecord(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: {
          section: "recommendations",
          recordId: event.currentTarget.dataset.id
        }
      })
    );
  }

  // ---------- Activité et scans ----------

  get activityItems() {
    return (this.activity || []).slice(0, 8).map((item, index) => ({
      ...item,
      key: `a-${index}`,
      when: formatRelative(item.changedAt),
      change:
        item.oldValue || item.newValue
          ? `${item.fieldLabel}: ${item.oldValue || "—"} → ${item.newValue || "—"}`
          : item.fieldLabel
    }));
  }

  get hasActivity() {
    return this.activityItems.length > 0;
  }

  get recentScans() {
    return (this.overview?.recentScans || []).map((scan) => ({
      ...scan,
      tone: scanStatusTone(scan.status),
      when: formatRelative(
        scan.completedAt || scan.startedAt || scan.createdDate
      ),
      findings: isScanInProgress(scan.status)
        ? "—"
        : formatNumber(scan.findingCount),
      scoreLabel:
        scan.healthScore === null || scan.healthScore === undefined
          ? "—"
          : formatNumber(scan.healthScore)
    }));
  }

  get noPriorities() {
    return this.matchingPriorities.length === 0;
  }

  get noActivity() {
    return !this.hasActivity;
  }

  /** Export de toutes les recommandations correspondant à la recherche et au filtre de gravité. */
  handleExportPriorities(event) {
    exportRows({
      name: "priority-recommendations",
      format: event.detail.format,
      rows: this.matchingPriorities,
      columns: [
        { label: "Number", value: (rec) => rec.name },
        { label: "Title", value: (rec) => rec.title },
        { label: "Severity", value: (rec) => rec.severity },
        { label: "Status", value: (rec) => rec.status },
        { label: "Component", value: (rec) => rec.componentName },
        {
          label: "Assigned to",
          value: (rec) => rec.assignedToName || "Unassigned"
        },
        {
          label: "Still detected",
          value: (rec) => rec.stillDetected !== false
        },
        { label: "Record Id", value: (rec) => rec.id }
      ]
    });
  }

  handleExportActivity(event) {
    exportRows({
      name: "team-activity",
      format: event.detail.format,
      rows: this.activity || [],
      columns: [
        { label: "When", value: (item) => formatExportDate(item.changedAt) },
        { label: "Changed by", value: (item) => item.changedByName },
        { label: "Recommendation", value: (item) => item.recordName },
        { label: "Field", value: (item) => item.fieldLabel },
        { label: "Old value", value: (item) => item.oldValue },
        { label: "New value", value: (item) => item.newValue },
        { label: "Record Id", value: (item) => item.recordId }
      ]
    });
  }

  handleExportScans(event) {
    exportRows({
      name: "recent-scans",
      format: event.detail.format,
      rows: this.overview?.recentScans || [],
      columns: [
        { label: "Scan", value: (scan) => scan.name },
        { label: "Status", value: (scan) => scan.status },
        { label: "Started", value: (scan) => formatExportDate(scan.startedAt) },
        {
          label: "Completed",
          value: (scan) => formatExportDate(scan.completedAt)
        },
        { label: "Findings", value: (scan) => scan.findingCount },
        { label: "Health score", value: (scan) => scan.healthScore },
        { label: "Scan Id", value: (scan) => scan.id }
      ]
    });
  }

  handleOpenScan(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "scanner", scanId: event.currentTarget.dataset.id }
      })
    );
  }

  /** Fin d'un scan lancé depuis la vue d'ensemble : les chiffres sont rechargés. */
  handleScanFinished() {
    this.handleRefresh();
  }

  /** Ouverture d'un scan ou de l'historique depuis le raccourci « Scans ». */
  handleScanNavigate(event) {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("navigate", { detail: event.detail }));
  }
}
