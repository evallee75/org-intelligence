/**
 * Pastille commune « Stored in this browser » avec son aide : rappelle que les résultats ne sont
 * pas dans l'org (édition sans objet). `help` remplace le texte d'aide par défaut.
 */
import { LightningElement, api } from "lwc";

const DEFAULT_HELP =
  "Nothing is stored in the org: these results stay in this browser only. Use the Data menu to save them to a file and share them with another administrator.";

export default class OrgIntelBrowserBadge extends LightningElement {
  @api label = "Stored in this browser";
  @api help;

  get helpText() {
    return this.help || DEFAULT_HELP;
  }
}
