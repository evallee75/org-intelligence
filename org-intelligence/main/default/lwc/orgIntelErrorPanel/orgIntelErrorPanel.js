import { LightningElement, api } from "lwc";
import { reduceErrors } from "c/orgIntelUtils";

/** Affichage explicite d'une erreur, avec bouton « Try again » optionnel (événement retry). */
export default class OrgIntelErrorPanel extends LightningElement {
  @api title = "Something went wrong";
  @api error;
  @api showRetry = false;

  get message() {
    return reduceErrors(this.error);
  }

  handleRetry() {
    this.dispatchEvent(new CustomEvent("retry"));
  }
}
