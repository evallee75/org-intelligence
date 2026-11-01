import { api } from "lwc";
import LightningModal from "lightning/modal";
import { copyText, formatDateTime, reduceErrors } from "c/orgIntelUtils";
import { moduleAction } from "c/orgIntelModuleApi";

// Actions Apex du module (via le contrôleur générique du socle)
const getApiLog = moduleAction("apiMonitoring", "getApiLog");

/** Détail d'un appel API : requête et réponse (extraits masqués). */
export default class OrgIntelApiLogModal extends LightningModal {
  @api logId;

  detail;
  error;
  isLoading = true;
  copied = "";

  connectedCallback() {
    this.load();
  }

  async load() {
    try {
      this.detail = await getApiLog({ logId: this.logId });
    } catch (error) {
      this.error = reduceErrors(error);
    } finally {
      this.isLoading = false;
    }
  }

  get row() {
    return this.detail?.row;
  }

  get when() {
    return formatDateTime(this.row?.calledAt);
  }

  /** Lien vers l'enregistrement ou le scan rattaché (colonne retirée du journal). */
  get contextUrl() {
    const id = this.row?.relatedRecordId;
    return id ? `/lightning/r/${id}/view` : null;
  }

  get contextLabel() {
    return this.row?.relatedRecordId || null;
  }

  get statusLabel() {
    return this.row?.success ? "Success" : "Error";
  }

  get statusTone() {
    return this.row?.success ? "good" : "critical";
  }

  get request() {
    return this.prettify(this.detail?.requestBody) || "—";
  }

  get response() {
    return this.prettify(this.detail?.responseBody) || "—";
  }

  prettify(value) {
    if (!value) {
      return value;
    }
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  async handleCopyRequest() {
    this.copied = (await copyText(this.request)) ? "Request copied" : "";
  }

  async handleCopyResponse() {
    this.copied = (await copyText(this.response)) ? "Response copied" : "";
  }

  handleClose() {
    this.close();
  }
}
