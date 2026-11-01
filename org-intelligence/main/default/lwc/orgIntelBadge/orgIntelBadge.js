import { LightningElement, api } from "lwc";

/**
 * Pastille de statut ou de gravité : point coloré + libellé. La couleur n'est jamais seule
 * porteuse de sens, le libellé est toujours affiché.
 */
export default class OrgIntelBadge extends LightningElement {
  @api label;
  @api tone = "neutral";

  get badgeClass() {
    return `oi-pill tone-${this.tone || "neutral"}`;
  }
}
