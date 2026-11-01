import { LightningElement, api } from "lwc";
import { formatDateTime, formatRelative, severityMeta } from "c/orgIntelUtils";
import { conflictsFor, kindMeta, stagesFor } from "c/orgIntelAutomationModel";

const EVENTS = [
  { value: "", label: "Create or update" },
  { value: "Create", label: "Create" },
  { value: "Update", label: "Update" },
  { value: "Delete", label: "Delete" }
];

/**
 * Vue d'un objet : ordre d'exécution à la sauvegarde (timeline numérotée, cartes
 * d'automatisation, liens vers les autres objets mis à jour), automatisation sélectionnée et son
 * logigramme, conflits, échecs d'exécution et constats de l'objet.
 */
export default class OrgIntelAutomationObject extends LightningElement {
  @api data;
  objectSearch = "";
  event = "";
  selectedAutomationId = null;
  currentObject = null;
  links = [];
  overlayBox = "0 0 0 0";
  resizeObserver;
  observed = null;
  linksSignature = "";
  // Lignes dépliées (conflits et échecs) : clés préfixées par le type de ligne
  expandedKeys = new Set();

  @api
  get objectName() {
    return this.currentObject;
  }
  set objectName(value) {
    if (value !== this.currentObject) {
      this.currentObject = value;
    }
  }

  @api
  get automationId() {
    return this.selectedAutomationId;
  }
  set automationId(value) {
    this.selectedAutomationId = value || null;
  }

  get eventOptions() {
    return EVENTS;
  }

  get automations() {
    return this.data?.automations || [];
  }

  get errorDays() {
    return this.data?.errorDays || 30;
  }

  // ---------- Liste des objets ----------

  get objects() {
    const term = this.objectSearch.trim().toLowerCase();
    return (this.data?.objects || [])
      .filter((o) => !term || o.name.toLowerCase().includes(term))
      .map((o) => {
        const selected = o.name === this.currentObject;
        return {
          name: o.name,
          summary: `${o.automationCount} automation${o.automationCount === 1 ? "" : "s"}`,
          dots: ["flow", "pb", "apex"]
            .filter((k) => o.counts[k])
            .map((k) => ({
              key: k,
              text: o.counts[k],
              className: `mini mini-${k}`
            })),
          conflicts: o.conflictCount,
          hasConflicts: o.conflictCount > 0,
          errors: o.errors,
          hasErrors: o.errors > 0,
          errorsTitle: `${o.errors} failed run(s) in the last ${this.errorDays} days`,
          conflictsTitle: `${o.conflictCount} conflict(s)`,
          className: `object${selected ? " object-selected" : ""}`,
          current: selected ? "true" : "false",
          automationCount: o.automationCount
        };
      })
      .sort(
        (a, b) =>
          b.automationCount - a.automationCount || a.name.localeCompare(b.name)
      );
  }

  get hasObjects() {
    return this.objects.length > 0;
  }

  handleObjectSearch(event) {
    this.objectSearch = event.target.value || "";
  }

  handleSelectObject(event) {
    this.selectObject(event.currentTarget.dataset.name);
  }

  selectObject(name) {
    this.currentObject = name;
    this.selectedAutomationId = null;
    this.dispatchEvent(
      new CustomEvent("selectobject", { detail: { objectName: name } })
    );
  }

  handleEvent(event) {
    this.event = event.detail.value;
  }

  // ---------- Timeline ----------

  get rawStages() {
    return stagesFor(this.automations, this.currentObject, this.event);
  }

  get conflicts() {
    return conflictsFor(
      this.automations,
      this.currentObject,
      this.event,
      this.data?.cycles
    ).map((conflict) => ({
      ...conflict,
      ...this.toggleState(`conflict:${conflict.key}`),
      hasAutomations: conflict.automations.length > 0,
      automations: conflict.automations.map((a, index) => ({
        ...a,
        key: `${conflict.key}-${a.id}`,
        separator: index > 0 ? (conflict.chain ? "→" : "·") : ""
      }))
    }));
  }

  get conflictIds() {
    return new Set(
      this.conflicts
        .filter((c) => c.type !== "mixed")
        .flatMap((c) => c.automations.map((a) => a.id))
    );
  }

  get startLabel() {
    const verb =
      this.event === "Create"
        ? "created"
        : this.event === "Update"
          ? "updated"
          : this.event === "Delete"
            ? "deleted"
            : "created or updated";
    return `${this.currentObject} record ${verb}`;
  }

  get stages() {
    const conflictIds = this.conflictIds;
    let step = 0;
    return this.rawStages.map((stage) => {
      if (stage.system) {
        return {
          key: stage.key,
          isSystem: true,
          title:
            this.event === "Delete"
              ? "Salesforce deletes the record"
              : stage.title,
          subtitle:
            this.event === "Delete"
              ? "The record is removed (not committed yet)."
              : stage.subtitle,
          className: "tl-stage tl-stage-system",
          cards: []
        };
      }
      step++;
      return {
        key: stage.key,
        isSystem: false,
        step,
        title: stage.title,
        subtitle: stage.subtitle,
        countText: `${stage.items.length}`,
        className: `tl-stage tl-stage-${stage.key}`,
        cards: stage.items.map((automation) =>
          this.card(automation, conflictIds.has(automation.id))
        )
      };
    });
  }

  card(automation, conflicted) {
    const meta = kindMeta(automation.kind);
    const findings = automation.findings || [];
    const worst = findings
      .map((f) => severityMeta(f.severity))
      .sort((a, b) => b.points - a.points)[0];
    const selected = automation.id === this.selectedAutomationId;
    const events =
      automation.kind === "Apex trigger"
        ? (automation.events || []).join(", ")
        : (automation.events || []).join(" / ");
    const badges = [];
    if (automation.model?.triggerOrder != null) {
      badges.push({
        key: "order",
        text: `#${automation.model.triggerOrder}`,
        className: "pill pill-neutral",
        title: `Trigger Order ${automation.model.triggerOrder}`
      });
    }
    if (automation.resaves) {
      badges.push({
        key: "resave",
        text: "↻ saves again",
        className: "pill pill-warning",
        title: "Updates the same record again after the save"
      });
    }
    if (conflicted) {
      badges.push({
        key: "conflict",
        text: "conflict",
        className: "pill pill-serious",
        title: "In conflict with another automation: see Conflicts"
      });
    }
    if (findings.length) {
      badges.push({
        key: "issues",
        text: `${findings.length} issue${findings.length > 1 ? "s" : ""}`,
        className: `pill pill-${worst?.tone || "neutral"}`,
        title: findings.map((f) => f.title).join("\n")
      });
    }
    if (automation.errors) {
      badges.push({
        key: "errors",
        text: `${automation.errors.count} failed`,
        className: "pill pill-critical",
        title: `${automation.errors.count} failed run(s) in the last ${this.errorDays} days`
      });
    }
    const targets = [
      ...new Set(
        (automation.model?.writes || [])
          .filter((w) => w.objectName && w.objectName !== this.currentObject)
          .map((w) => w.objectName)
      )
    ];
    return {
      key: automation.id,
      id: automation.id,
      name: automation.name,
      subtitle: [meta.label, events].filter(Boolean).join(" · "),
      iconName: meta.icon,
      iconStyle: `background:${meta.color}`,
      className: `auto-card kind-${automation.kindKey}${selected ? " is-selected" : ""}${conflicted ? " is-conflict" : ""}`,
      pressed: selected ? "true" : "false",
      badges,
      hasBadges: badges.length > 0,
      targetsText: targets.length ? `→ ${targets.join(", ")}` : "",
      title: `${automation.apiName} (${meta.label})`
    };
  }

  get isEmpty() {
    return this.rawStages.length === 0;
  }

  /** Autres objets écrits par les automatisations affichées. */
  get targets() {
    const byObject = new Map();
    for (const stage of this.rawStages) {
      for (const automation of stage.items) {
        for (const write of automation.model?.writes || []) {
          if (!write.objectName || write.objectName === this.currentObject) {
            continue;
          }
          const entry = byObject.get(write.objectName) || {
            name: write.objectName,
            operations: new Set(),
            sources: new Set()
          };
          entry.operations.add(write.operation);
          entry.sources.add(automation.id);
          byObject.set(write.objectName, entry);
        }
      }
    }
    const automated = new Set((this.data?.objects || []).map((o) => o.name));
    return [...byObject.values()].map((entry) => ({
      key: entry.name,
      name: entry.name,
      operations: [...entry.operations].join(" · ").toLowerCase(),
      sources: [...entry.sources].join(","),
      clickable: automated.has(entry.name),
      className: `target${automated.has(entry.name) ? "" : " target-passive"}${[...entry.operations].includes("Create") ? " target-create" : ""}`,
      title: automated.has(entry.name)
        ? `Open the automation of ${entry.name}`
        : `${entry.name} has no automation of its own`
    }));
  }

  get hasTargets() {
    return this.targets.length > 0;
  }

  get flowAreaClass() {
    return `flow-area${this.hasTargets ? " flow-area-targets" : ""}`;
  }

  handleTargetClick(event) {
    const name = event.currentTarget.dataset.name;
    if ((this.data?.objects || []).some((o) => o.name === name)) {
      this.selectObject(name);
    }
  }

  handleCardClick(event) {
    const id = event.currentTarget.dataset.id;
    this.selectedAutomationId = this.selectedAutomationId === id ? null : id;
  }

  // ---------- Liens cartes → objets (mesurés après rendu) ----------

  connectedCallback() {
    try {
      this.resizeObserver = new ResizeObserver(() => this.measureLinks());
    } catch {
      this.resizeObserver = null;
    }
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
  }

  renderedCallback() {
    const area = this.template.querySelector(".flow-area");
    if (area && this.resizeObserver && !this.observed) {
      this.resizeObserver.observe(area);
      this.observed = area;
    }
    this.measureLinks();
  }

  measureLinks() {
    const area = this.template.querySelector(".flow-area");
    if (!area) {
      return;
    }
    const box = area.getBoundingClientRect();
    const links = [];
    for (const target of this.template.querySelectorAll(".target")) {
      const sources = (target.dataset.sources || "").split(",").filter(Boolean);
      const t = target.getBoundingClientRect();
      const tx = t.left - box.left - 2;
      const ty = t.top - box.top + t.height / 2;
      for (const id of sources) {
        const card = this.template.querySelector(`.auto-card[data-id="${id}"]`);
        if (!card) {
          continue;
        }
        const c = card.getBoundingClientRect();
        const sx = c.right - box.left;
        const sy = c.top - box.top + c.height / 2;
        const bend = Math.max(30, (tx - sx) * 0.5);
        const r = (n) => Math.round(n);
        links.push({
          key: `${id}-${target.dataset.name}`,
          path: `M ${r(sx)} ${r(sy)} C ${r(sx + bend)} ${r(sy)}, ${r(tx - bend)} ${r(ty)}, ${r(tx)} ${r(ty)}`,
          head: `${r(tx + 2)},${r(ty)} ${r(tx - 7)},${r(ty - 4.5)} ${r(tx - 7)},${r(ty + 4.5)}`,
          startX: r(sx),
          startY: r(sy),
          className: `link${id === this.selectedAutomationId ? " link-active" : ""}${target.classList.contains("target-create") ? " link-create" : ""}`
        });
      }
    }
    const signature = `${Math.round(box.width)}x${Math.round(box.height)}|${links.map((l) => l.path + l.className).join(";")}`;
    if (signature !== this.linksSignature) {
      this.linksSignature = signature;
      this.overlayBox = `0 0 ${Math.round(box.width)} ${Math.round(box.height)}`;
      this.links = links;
    }
  }

  get overlayStyle() {
    const [, , w, h] = this.overlayBox.split(" ");
    return `width:${w}px;height:${h}px`;
  }

  // ---------- Automatisation sélectionnée ----------

  get selected() {
    const automation = this.automations.find(
      (a) => a.id === this.selectedAutomationId
    );
    if (!automation) {
      return null;
    }
    const model = automation.model || {};
    const meta = kindMeta(automation.kind);
    const domain = this.data?.orgDomainUrl || "";
    const isFlow =
      automation.kind === "Flow" || automation.kind === "Process Builder";
    let link = null;
    if (isFlow && automation.versionId) {
      link = `${domain}/builder_platform_interaction/flowBuilder.app?flowId=${automation.versionId}`;
    } else if (automation.kind === "Apex trigger" && automation.metadataId) {
      link = `${domain}/lightning/setup/ApexTriggers/page?address=%2F${automation.metadataId}`;
    }
    const writes = [
      ...new Set(
        (model.writes || []).map(
          (w) =>
            `${w.operation} ${w.sameRecord ? "same record" : w.objectName || "records"}${(w.fields || []).length ? ` (${w.fields.join(", ")})` : ""}`
        )
      )
    ];
    const errors = automation.errors;
    return {
      name: automation.name,
      apiName: automation.apiName,
      iconName: meta.icon,
      iconStyle: `background:${meta.color}`,
      subtitle: [
        meta.label,
        automation.timing,
        (automation.events || []).join(", "),
        automation.apiName !== automation.name ? automation.apiName : null
      ]
        .filter(Boolean)
        .join(" · "),
      criteria: model.entryCriteria,
      writes: writes.map((text) => ({ key: text, text })),
      hasWrites: writes.length > 0,
      calls: [
        ...(model.subflows || []).map((s) => `Subflow ${s}`),
        ...(model.apexActions || []).map((a) => `Apex ${a}`),
        ...(model.otherActions || [])
      ].join(" · "),
      elementText: model.elementCount ? `${model.elementCount} elements` : null,
      // Modèle réduit par le scan (flow trop grand) : écritures et appels peut-être incomplets
      modelOmitted: Boolean(automation.modelOmitted || model.modelOmitted),
      truncatedText:
        model.truncated || automation.modelOmitted
          ? "Flow too large: some details (diagram, written fields) were not kept by the scan."
          : null,
      link,
      linkLabel: isFlow ? "Open in Flow Builder" : "Open in Setup",
      isFlow,
      model,
      errorSummary: errors
        ? `${errors.count} failed run(s) in the last ${this.errorDays} days`
        : null,
      errorSamples: this.errorSamples(errors),
      findings: (automation.findings || []).map((finding) => {
        const severity = severityMeta(finding.severity);
        return {
          ...finding,
          severityLabel: severity.label,
          severityTone: severity.tone
        };
      }),
      isApex: automation.kind === "Apex trigger"
    };
  }

  get hasSelectedFindings() {
    return (this.selected?.findings || []).length > 0;
  }

  errorSamples(summary) {
    return (summary?.samples || []).map((sample, index) => ({
      ...sample,
      key: sample.interviewId || `${summary.flowApiName}-${index}`,
      when: formatDateTime(sample.occurredAt),
      context: [
        sample.versionNumber ? `v${sample.versionNumber}` : null,
        sample.element ? `at ${sample.element}` : null,
        sample.userName ? `by ${sample.userName}` : null
      ]
        .filter(Boolean)
        .join(" · "),
      message: sample.message || "No error message kept for this run."
    }));
  }

  handleCloseSelected() {
    this.selectedAutomationId = null;
  }

  handleSelectAutomation(event) {
    event.preventDefault();
    this.selectedAutomationId = event.currentTarget.dataset.id;
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    requestAnimationFrame(() => {
      this.template
        .querySelector(".ao-selected")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  // ---------- Conflits, échecs, constats ----------

  get hasConflicts() {
    return this.conflicts.length > 0;
  }

  get conflictCountText() {
    return `${this.conflicts.length}`;
  }

  get objectErrors() {
    return this.automations
      .filter(
        (a) => a.objectName === this.currentObject && a.isActive && a.errors
      )
      .sort((a, b) => b.errors.count - a.errors.count)
      .map((automation) => ({
        key: automation.id,
        id: automation.id,
        name: automation.name,
        countText: `${automation.errors.count} failed run${automation.errors.count === 1 ? "" : "s"}`,
        lastText: `last ${formatRelative(automation.errors.lastAt)}`,
        ...this.toggleState(`error:${automation.id}`),
        samples: this.errorSamples(automation.errors).slice(0, 2)
      }));
  }

  /** État d'une ligne repliable (icône, libellé, aria-expanded). */
  toggleState(toggleKey) {
    const expanded = this.expandedKeys.has(toggleKey);
    return {
      toggleKey,
      expanded,
      expandedText: expanded ? "true" : "false",
      toggleIcon: expanded ? "utility:chevrondown" : "utility:chevronright",
      toggleLabel: expanded ? "Hide details" : "Show details"
    };
  }

  handleToggleRow(event) {
    const key = event.currentTarget.dataset.key;
    const next = new Set(this.expandedKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.expandedKeys = next;
  }

  get hasObjectErrors() {
    return this.objectErrors.length > 0;
  }

  get orgErrorText() {
    const total = this.data?.kpis?.failedRuns || 0;
    if (!total) {
      return `No failed flow run recorded in the last ${this.errorDays} days.`;
    }
    return `${total} failed flow run(s) in the org over ${this.errorDays} days, none on ${this.currentObject}.`;
  }

  get flowErrorsMessage() {
    return this.data?.flowErrorsMessage;
  }

  get objectFindings() {
    const names = new Set(
      this.automations
        .filter((a) => a.objectName === this.currentObject)
        .map((a) => a.apiName)
    );
    const object = this.currentObject || "";
    return (this.data?.findings || [])
      .filter(
        (f) =>
          names.has(f.componentName) ||
          f.componentName === object ||
          (f.componentName || "").startsWith(`${object} (`) ||
          (f.componentName || "").split(" / ").includes(object)
      )
      .map((f) => {
        const meta = severityMeta(f.severity);
        return {
          ...f,
          severityLabel: meta.label,
          severityTone: meta.tone,
          points: meta.points
        };
      })
      .sort((a, b) => b.points - a.points);
  }

  get hasObjectFindings() {
    return this.objectFindings.length > 0;
  }

  handleOpenRecommendation(event) {
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
}
