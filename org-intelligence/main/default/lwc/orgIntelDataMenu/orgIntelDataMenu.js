/**
 * Menu « Data » commun : enregistrer dans un fichier JSON, ouvrir un fichier, effacer les données
 * gardées dans le navigateur. Le parent fait le travail sur les événements :
 * - `save`  : appeler downloadJson(...) ;
 * - `open`  : detail.data = contenu du fichier (vérifié pour `kind`), detail.envelope = enveloppe
 *             (orgId, orgName, exportedAt, version, sameOrg : false = fichier d'une autre org) ;
 * - `clear` : l'utilisateur a confirmé ;
 * - `error` : detail.message (fichier illisible ou d'un autre type).
 *
 * <c-org-intel-data-menu kind="scan" allow-clear onsave={…} onopen={…} onclear={…}></c-org-intel-data-menu>
 */
import { LightningElement, api } from "lwc";
import LightningConfirm from "lightning/confirm";
import { readJsonEnvelope } from "c/orgIntelStore";

export default class OrgIntelDataMenu extends LightningElement {
  /** Type de fichier attendu à l'ouverture (kind de downloadJson). */
  @api kind;
  @api allowClear = false;
  @api disableSave = false;
  @api saveLabel = "Save to file (JSON)";
  @api openLabel = "Open a file…";
  @api clearLabel = "Clear stored data";
  @api clearMessage =
    "Delete the data stored in this browser for this screen? Save it to a file first if you need it.";
  @api label = "Data";

  handleSelect(event) {
    const value = event.detail.value;
    if (value === "save") {
      this.dispatchEvent(new CustomEvent("save"));
    } else if (value === "open") {
      const input = this.template.querySelector("input[type=file]");
      if (input) {
        input.value = null;
        input.click();
      }
    } else if (value === "clear") {
      this.confirmClear();
    }
  }

  async confirmClear() {
    const ok = await LightningConfirm.open({
      message: this.clearMessage,
      label: this.clearLabel,
      theme: "warning"
    });
    if (ok) {
      this.dispatchEvent(new CustomEvent("clear"));
    }
  }

  async handleFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    try {
      const envelope = await readJsonEnvelope(file, this.kind);
      this.dispatchEvent(
        new CustomEvent("open", {
          detail: { data: envelope.data, envelope, fileName: file.name }
        })
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: {
            message: error && error.message ? error.message : String(error)
          }
        })
      );
    }
  }
}
