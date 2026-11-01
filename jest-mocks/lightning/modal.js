// Bouchon de lightning/modal (absent de sfdx-lwc-jest) : une classe de base
// LightningElement avec une méthode statique open() simulée.
import { LightningElement, api } from "lwc";

export default class LightningModal extends LightningElement {
  @api label;
  @api size;
  @api description;
  @api disableClose;

  static open = jest.fn(() => Promise.resolve());

  close(result) {
    this.closeValue = result;
  }
}
