import { LightningElement, api } from "lwc";

/**
 * État vide ou section non disponible. Les actions éventuelles passent par le slot.
 * variant = 'empty' (rien à afficher) | 'unavailable' (fonctionnalité pas encore livrée).
 */
export default class OrgIntelEmptyState extends LightningElement {
  @api title;
  @api message;
  @api iconName = "utility:search";
  @api variant = "empty";

  get isUnavailable() {
    return this.variant === "unavailable";
  }

  get containerClass() {
    return `empty ${this.isUnavailable ? "empty-unavailable" : ""}`;
  }
}
