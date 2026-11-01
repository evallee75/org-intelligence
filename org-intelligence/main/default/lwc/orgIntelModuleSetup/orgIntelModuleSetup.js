import { LightningElement } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import getModuleCatalog from "@salesforce/apex/OrgIntelModuleController.getModuleCatalog";
import grantModuleAccess from "@salesforce/apex/OrgIntelModuleController.grantModuleAccess";
import getScannerState from "@salesforce/apex/OrgIntelligenceController.getScannerState";
import { loadScanHistory } from "c/orgIntelScanData";
import { visualforceUrl } from "c/orgIntelModuleApi";
import {
  INSTALL_GUIDE_URL,
  OPTIONAL_MODULES,
  reduceErrors
} from "c/orgIntelUtils";

/** Mémorise que l'écran a été vu : la coquille ne l'ouvre d'office qu'au premier lancement. */
export const MODULES_SEEN_KEY = "orgIntelligence.modulesSeen";

/**
 * Écran « Choose your modules » : premier écran après l'installation du socle.
 *
 * Pour chaque module optionnel : installer (page d'installation du package, dans cette org, nouvel
 * onglet), puis s'attribuer l'accès (permission set d'administration du module) en un clic. Au retour
 * sur l'onglet après une installation, l'état est relu automatiquement. Chaque changement est signalé
 * à la coquille (événement modulechange) pour afficher les nouvelles sections.
 */
export default class OrgIntelModuleSetup extends LightningElement {
  catalog;
  error;
  isLoading = true;
  busyKey = null;
  /** Une installation a été ouverte dans un autre onglet : relire l'état au retour. */
  awaitingInstall = false;
  installGuideUrl = INSTALL_GUIDE_URL;
  /** Avancement des étapes 3 (connexion Tooling) et 4 (premier scan). */
  toolingConnected = false;
  /** URL de l'assistant Tooling fournie par Apex (Page.getUrl : préfixe du namespace compris). */
  toolingSetupUrl = null;
  toolingAuthorizationUrl = null;
  hasScan = false;

  connectedCallback() {
    try {
      window.localStorage.setItem(MODULES_SEEN_KEY, "true");
    } catch {
      // stockage indisponible (navigation privée) : l'écran sera simplement reproposé
    }
    this.onVisibilityChange = () => {
      if (document.visibilityState === "visible" && this.awaitingInstall) {
        this.load(true);
      }
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.load(false);
    this.loadProgress();
  }

  /** Connexion Tooling et premier scan : lus à part, sans bloquer l'écran. */
  async loadProgress() {
    try {
      const state = await getScannerState();
      this.toolingConnected = Boolean(state?.tooling?.connected);
      this.toolingSetupUrl = state?.tooling?.setupUrl || null;
      // Connexion créée mais pas autorisée pour cet utilisateur : « Connect » mène à l'OAuth
      this.toolingAuthorizationUrl =
        state?.tooling?.configured && !state?.tooling?.connected
          ? state?.tooling?.authorizationUrl || null
          : null;
    } catch {
      this.toolingConnected = false;
    }
    try {
      this.hasScan = (await loadScanHistory()).length > 0;
    } catch {
      this.hasScan = false;
    }
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  async load(notify) {
    this.isLoading = !this.catalog;
    try {
      const previous = this.signature;
      this.catalog = await getModuleCatalog();
      this.error = undefined;
      if (notify && previous !== this.signature) {
        this.dispatchEvent(new CustomEvent("modulechange"));
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.isLoading = false;
    }
  }

  /** Empreinte de l'état (installé / accessible) pour ne prévenir la coquille qu'en cas de changement. */
  get signature() {
    return (this.catalog?.modules || [])
      .map((entry) => `${entry.key}:${entry.installed}:${entry.accessible}`)
      .join("|");
  }

  entry(key) {
    return (this.catalog?.modules || []).find((item) => item.key === key);
  }

  get canAssign() {
    return !!this.catalog?.canAssign;
  }

  // ---------- Socle ----------

  get core() {
    const entry = this.entry("core") || {};
    // Accès par permission set ou par profil (installation « admins seulement »)
    const admin = !!this.catalog?.isAdmin || !!entry.assigned;
    return {
      permissionSet: entry.permissionSet,
      statusLabel: admin ? "Admin access" : "No admin access",
      statusTone: admin ? "good" : "warning",
      canGrant: !admin && entry.permissionSetFound && this.canAssign,
      askAdmin: !admin && !this.canAssign,
      busy: this.busyKey === "core"
    };
  }

  /** Explication de l'étape 1, affichée en info-bulle. */
  get coreHelp() {
    return `Your own access to Org Intelligence. System administrators get it from their profile when the package is installed for admins; other users need the ${this.core.permissionSet || "Org Intelligence"} permission set.`;
  }

  // ---------- Modules ----------

  get modules() {
    return OPTIONAL_MODULES.map((module) => {
      const entry = this.entry(module.key) || {};
      const required = module.requiresKey
        ? this.entry(module.requiresKey)
        : null;
      const blocked = !entry.installed && required && !required.installed;
      // Accès manquant seulement : le profil peut déjà donner l'accès sans permission set
      const canGrant =
        entry.installed &&
        !entry.accessible &&
        entry.permissionSetFound &&
        this.canAssign;
      let statusLabel = "Not installed";
      let statusTone = "neutral";
      if (entry.installed && entry.accessible) {
        statusLabel = "Ready";
        statusTone = "good";
      } else if (entry.installed) {
        statusLabel = "Installed, no access";
        statusTone = "warning";
      }
      return {
        ...module,
        statusLabel,
        statusTone,
        cardClass: `module-card${entry.installed && entry.accessible ? " module-card-ready" : ""}`,
        objectsText: module.objects.length
          ? module.objects.join(", ")
          : "No custom object",
        objectsHelp: `Adds: ${module.objects.length ? module.objects.join(", ") : "no custom object"}.${module.requires ? ` Requires ${module.requires}.` : ""}`,
        blockedText: blocked ? `Install ${module.requires} first.` : "",
        canInstall: !entry.installed && !blocked,
        hasPackage: !!module.packageVersionId,
        canGrant,
        askAdmin: entry.installed && !entry.accessible && !this.canAssign,
        permissionSet: entry.permissionSet,
        canOpen: entry.installed && entry.accessible,
        busy: this.busyKey === module.key
      };
    });
  }

  get installedCount() {
    return (this.catalog?.modules || []).filter(
      (entry) => entry.key !== "core" && entry.installed
    ).length;
  }

  get summary() {
    const count = this.installedCount;
    return `${count} of ${OPTIONAL_MODULES.length} optional modules installed`;
  }

  // ---------- Avancement ----------

  get coreDone() {
    return this.core.statusTone === "good";
  }

  /** Étape 2 faite dès qu'un module optionnel est prêt (tous les modules restent facultatifs). */
  get modulesDone() {
    return (this.catalog?.modules || []).some(
      (entry) => entry.key !== "core" && entry.installed && entry.accessible
    );
  }

  get doneCount() {
    return [
      this.coreDone,
      this.modulesDone,
      this.toolingConnected,
      this.hasScan
    ].filter(Boolean).length;
  }

  get progressText() {
    return this.doneCount === 4
      ? "All set: every step is done."
      : `${this.doneCount} of 4 steps done`;
  }

  stepClass(done) {
    return `step-number${done ? " step-done" : ""}`;
  }

  get scanLaunchLabel() {
    return this.hasScan ? "New scan" : "Run your first scan";
  }

  get coreStepClass() {
    return this.stepClass(this.coreDone);
  }

  get modulesStepClass() {
    return this.stepClass(this.modulesDone);
  }

  get toolingStepClass() {
    return this.stepClass(this.toolingConnected);
  }

  get scanStepClass() {
    return this.stepClass(this.hasScan);
  }

  // ---------- Actions ----------

  handleInstall(event) {
    const module = OPTIONAL_MODULES.find(
      (item) => item.key === event.currentTarget.dataset.key
    );
    if (!module) {
      return;
    }
    const url = module.packageVersionId
      ? `${this.catalog.installBaseUrl}${module.packageVersionId}`
      : INSTALL_GUIDE_URL;
    window.open(url, "_blank", "noopener");
    if (module.packageVersionId) {
      this.awaitingInstall = true;
    }
  }

  async handleGrant(event) {
    const key = event.currentTarget.dataset.key;
    this.busyKey = key;
    try {
      await grantModuleAccess({ key });
      this.toast(
        "success",
        "Access granted",
        "The permission set is assigned to you."
      );
      await this.load(true);
      this.dispatchEvent(new CustomEvent("modulechange"));
    } catch (error) {
      this.toast("error", "Access not granted", reduceErrors(error));
    } finally {
      this.busyKey = null;
    }
  }

  handleRefresh() {
    this.load(true);
    this.loadProgress();
  }

  handleOpen(event) {
    this.navigate(event.currentTarget.dataset.section);
  }

  /** Connexion déjà créée mais pas autorisée : « Connect », sinon l'assistant. */
  get toolingButtonLabel() {
    return this.toolingAuthorizationUrl ? "Connect" : "Set up the connection";
  }

  async handleToolingSetup() {
    // URL d'Apex (Page.getUrl, préfixée en package géré), sinon calculée (/apex/orgintel__...).
    // Onglet ouvert d'abord,
    // pendant le geste de l'utilisateur (sinon bloqué comme fenêtre surgissante), puis dirigé.
    const tab = window.open("", "_blank");
    const url =
      this.toolingAuthorizationUrl ||
      this.toolingSetupUrl ||
      (await visualforceUrl("OrgIntelligenceToolingSetup"));
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  handleOpenSettings() {
    this.navigate("settings");
  }

  /** Premier scan terminé (lanceur commun) : l'étape 4 est faite. */
  handleScanFinished() {
    this.loadProgress();
  }

  /** Navigation demandée par le lanceur (scan ouvert depuis un fichier, liste des scans). */
  handleScanNavigate(event) {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("navigate", { detail: event.detail }));
  }

  navigate(section) {
    this.dispatchEvent(new CustomEvent("navigate", { detail: { section } }));
  }

  toast(variant, title, message) {
    this.dispatchEvent(new ShowToastEvent({ variant, title, message }));
  }
}
