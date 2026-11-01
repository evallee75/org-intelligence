import { LightningElement, api } from "lwc";
import { CONFLICT_TYPES, CONFLICT_TYPE_KEYS } from "c/orgIntelAutomationModel";
import { CONFLICT_CSV_COLUMNS } from "c/orgIntelAutomationExport";
import { exportRows } from "c/orgIntelUtils";

const ALL = "";

/**
 * Synthèse des conflits de toute l'org : compteurs par type (filtres), recherche, objet ; chaque
 * conflit renvoie vers l'objet ou l'automatisation dans la vue objet.
 */
export default class OrgIntelAutomationConflicts extends LightningElement {
  @api data;
  type = ALL;
  objectFilter = ALL;
  search = "";
  // Lignes dépliées (détail et conseil de correction)
  expandedKeys = new Set();

  @api
  get initialType() {
    return this.type;
  }
  set initialType(value) {
    this.type = value || ALL;
  }

  get conflicts() {
    return this.data?.allConflicts || [];
  }

  get typeChips() {
    const counts = new Map(CONFLICT_TYPE_KEYS.map((key) => [key, 0]));
    this.conflicts.forEach((c) => counts.set(c.type, counts.get(c.type) + 1));
    return [
      {
        key: ALL,
        value: ALL,
        label: "All",
        count: this.conflicts.length,
        description: "Every conflict",
        tone: "all"
      },
      ...CONFLICT_TYPE_KEYS.map((key) => ({
        key,
        value: key,
        label: CONFLICT_TYPES[key].label,
        count: counts.get(key),
        description: CONFLICT_TYPES[key].severity,
        tone: CONFLICT_TYPES[key].tone
      }))
    ].map((chip) => ({
      ...chip,
      pressed: chip.value === this.type ? "true" : "false",
      className: `chip chip-${chip.tone}${chip.value === this.type ? " chip-selected" : ""}${chip.count ? "" : " chip-empty"}`
    }));
  }

  get objectOptions() {
    const names = [...new Set(this.conflicts.map((c) => c.objectName))].sort(
      (a, b) => a.localeCompare(b)
    );
    return [
      { label: "All objects", value: ALL },
      ...names.map((name) => ({ label: name, value: name }))
    ];
  }

  get rows() {
    const term = this.search.trim().toLowerCase();
    return this.conflicts
      .filter((c) => !this.type || c.type === this.type)
      .filter((c) => !this.objectFilter || c.objectName === this.objectFilter)
      .filter(
        (c) =>
          !term ||
          [c.title, c.detail, c.objectName, ...c.automations.map((a) => a.name)]
            .join(" ")
            .toLowerCase()
            .includes(term)
      )
      .map((c) => {
        const expanded = this.expandedKeys.has(c.key);
        return {
          ...c,
          expanded,
          expandedText: expanded ? "true" : "false",
          toggleIcon: expanded ? "utility:chevrondown" : "utility:chevronright",
          toggleLabel: expanded
            ? "Hide details"
            : "Show details and how to fix",
          objectsText: (c.objects || [c.objectName]).join(" → "),
          isLoop: c.type === "loop",
          hasAutomations: c.automations.length > 0,
          className: `row row-${c.tone}`,
          automations: c.automations.map((a, index) => ({
            ...a,
            key: `${c.key}-${a.id}`,
            separator: index > 0 ? (c.chain ? "→" : "·") : ""
          }))
        };
      });
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

  get hasRows() {
    return this.rows.length > 0;
  }

  get noRows() {
    return !this.hasRows;
  }

  /** Export des conflits affichés (type, objet et recherche en cours). */
  handleExport(event) {
    const shown = new Set(this.rows.map((row) => row.key));
    exportRows({
      name: "automation-conflicts",
      format: event.detail.format,
      rows: this.conflicts.filter((c) => shown.has(c.key)),
      columns: CONFLICT_CSV_COLUMNS
    });
  }

  get hasConflicts() {
    return this.conflicts.length > 0;
  }

  get resultText() {
    const count = this.rows.length;
    return `${count} conflict${count === 1 ? "" : "s"}`;
  }

  get currentAdvice() {
    return this.type ? CONFLICT_TYPES[this.type]?.advice : null;
  }

  handleType(event) {
    this.type = event.currentTarget.dataset.value;
  }

  handleObject(event) {
    this.objectFilter = event.detail.value;
  }

  handleSearch(event) {
    this.search = event.target.value || "";
  }

  handleOpenObject(event) {
    this.dispatchEvent(
      new CustomEvent("selectobject", {
        detail: { objectName: event.currentTarget.dataset.object }
      })
    );
  }

  handleOpenAutomation(event) {
    const { id, object } = event.currentTarget.dataset;
    const automation = (this.data?.automations || []).find((a) => a.id === id);
    this.dispatchEvent(
      new CustomEvent("selectobject", {
        detail: {
          objectName: automation?.objectName || object,
          automationId: id
        }
      })
    );
  }
}
