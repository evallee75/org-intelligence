import { LightningElement, api } from "lwc";

/** Tuile d'indicateur : libellé, valeur, unité et légende optionnelles. */
export default class OrgIntelStatTile extends LightningElement {
  @api label;
  @api value;
  @api unit;
  @api caption;
  @api iconName;
}
