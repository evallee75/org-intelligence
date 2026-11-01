import { LightningElement, api } from "lwc";
import { EXPORT_FORMATS } from "c/orgIntelUtils";

/**
 * Menu « Export » commun à toutes les listes : Excel (.xlsx) ou CSV. Émet `export` avec
 * `detail.format` ; le parent construit les lignes (celles affichées, filtres compris) et appelle
 * exportRows de c/orgIntelUtils.
 */
export default class OrgIntelExportMenu extends LightningElement {
  @api label = "Export";
  @api disabled = false;
  @api compact = false;
  @api alternativeText = "Export the list";
  formats = EXPORT_FORMATS;

  get buttonLabel() {
    return this.compact ? null : this.label;
  }

  handleSelect(event) {
    this.dispatchEvent(
      new CustomEvent("export", { detail: { format: event.detail.value } })
    );
  }
}
