import { LightningElement, wire } from "lwc";
import { CurrentPageReference, NavigationMixin } from "lightning/navigation";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import {
  DEFAULT_SECTION,
  OPTIONAL_MODULES,
  findSection,
  formatNumber,
  sectionsFor
} from "c/orgIntelUtils";
import { loadInstalledModules } from "c/orgIntelModuleApi";
import { MODULES_SEEN_KEY } from "c/orgIntelModuleSetup";
import { subscribe, cancelScan } from "c/orgIntelScanEngine";
import { loadValue, saveValue } from "c/orgIntelStore";

/**
 * Coquille de l'application Org Intelligence : en-tête, navigation et section active.
 *
 * La section courante est portée par l'URL (paramètres c__section et c__scanId) : lien direct
 * possible vers une section ou un scan, et le bouton « précédent » du navigateur fonctionne.
 *
 * Les sections des modules optionnels ne sont affichées que si le module est installé et
 * accessible (OrgIntelModuleController.getModules) : le contenu attend cette réponse. Un lien vers
 * la section d'un module absent affiche « module not installed » avec un lien vers Modules.
 *
 * La coquille suit aussi le scan en cours (moteur du navigateur) : progression et arrêt dans
 * l'en-tête quelle que soit la section, et notification de fin.
 */
const THEME_KEY = "orgIntelligence.theme";

/** Sections masquées du menu par l'utilisateur (stockage commun du navigateur, par utilisateur). */
const HIDDEN_SECTIONS_STORE_KEY = "app.hiddenSections";
/** Menu épinglé (ouvert en permanence) ; sinon bandeau d'icônes qui s'ouvre au survol. */
const NAV_PINNED_STORE_KEY = "app.navPinned";
/** Ancienne clé localStorage (avant le stockage commun), reprise une fois. */
const LEGACY_HIDDEN_SECTIONS_KEY = "orgIntelligence.hiddenSections";

/** Sections toujours affichées (point d'entrée, choix des modules, paramètres). */
const LOCKED_SECTIONS = ["overview", "modules", "settings"];

function readLegacyHiddenSections() {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(LEGACY_HIDDEN_SECTIONS_KEY) || "null"
    );
    return Array.isArray(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Premier lancement dans ce navigateur : l'écran « Choose your modules » n'a jamais été affiché. */
function isFirstLaunch() {
  try {
    return !window.localStorage.getItem(MODULES_SEEN_KEY);
  } catch {
    return false;
  }
}
const THEMES = [
  { value: "light", label: "Light", title: "Light theme" },
  { value: "dark", label: "Dark", title: "Dark theme" },
  { value: "system", label: "Auto", title: "Follow the system setting" }
];

/** Préférence de thème mémorisée par navigateur (simple confort : absente = « Auto »). */
function readTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return THEMES.some((theme) => theme.value === stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export default class OrgIntelApp extends NavigationMixin(LightningElement) {
  theme = readTheme();
  hiddenSections = readLegacyHiddenSections() || [];
  isCustomizingNav = false;
  navPinned = false;
  systemDark = false;
  mediaQuery;
  section = DEFAULT_SECTION;
  scanId = null;
  recordId = null;
  severity = null;
  search = null;
  pageRef;
  /** Clés des modules installés et accessibles (recommendations, contextHub...). */
  installedModules = [];
  modulesLoaded = false;
  /** Premier lancement sans section demandée (décidé au chargement des modules). */
  firstLaunch = false;
  /** Scan en cours (moteur du navigateur), affiché dans l'en-tête. */
  runningScan = null;
  isStoppingScan = false;
  lastScanStatus = null;

  @wire(CurrentPageReference)
  setPageReference(pageRef) {
    this.pageRef = pageRef;
    const requested = pageRef?.state?.c__section;
    this.section = findSection(requested) ? requested : DEFAULT_SECTION;
    this.firstLaunch = !requested && isFirstLaunch();
    this.scanId = pageRef?.state?.c__scanId || null;
    this.recordId = pageRef?.state?.c__recordId || null;
    this.severity = pageRef?.state?.c__severity || null;
    this.search = pageRef?.state?.c__search || null;
  }

  connectedCallback() {
    this.loadNavPinned();
    this.reloadModules();
    this.loadHiddenSections();
    // L'alerte avant de fermer l'onglet pendant un scan est posée par le moteur (beforeunload)
    this.unsubscribeScan = subscribe((run) => this.handleScanProgress(run));
    try {
      this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      this.systemDark = this.mediaQuery.matches;
      this.onSystemThemeChange = (event) => {
        this.systemDark = event.matches;
      };
      this.mediaQuery.addEventListener("change", this.onSystemThemeChange);
    } catch {
      this.systemDark = false;
    }
  }

  reloadModules() {
    return loadInstalledModules().then((modules) => {
      this.installedModules = modules;
      // Installation neuve (aucun module encore accessible) : ouvrir le choix des modules, une fois
      if (this.firstLaunch && !modules.length) {
        this.section = "modules";
      }
      this.firstLaunch = false;
      this.modulesLoaded = true;
    });
  }

  /** Un module a été installé ou un accès attribué (écran Modules) : sections à jour. */
  handleModuleChange() {
    this.reloadModules();
  }

  disconnectedCallback() {
    this.mediaQuery?.removeEventListener("change", this.onSystemThemeChange);
    if (this.unsubscribeScan) {
      this.unsubscribeScan();
      this.unsubscribeScan = null;
    }
  }

  // ---------- Scan en cours (en-tête) ----------

  /** Progression publiée par le moteur ; la fin est annoncée ici, quelle que soit la section. */
  handleScanProgress(run) {
    const wasRunning = this.lastScanStatus === "Running";
    this.lastScanStatus = run ? run.status : null;
    if (run && run.status === "Running") {
      this.runningScan = run;
      return;
    }
    this.runningScan = null;
    this.isStoppingScan = false;
    if (!wasRunning || !run) {
      return;
    }
    let message;
    if (run.error) {
      message = run.resumable
        ? `${run.error} You can resume it from Overview or the scanner.`
        : run.error;
    } else {
      message = `${run.status}: ${formatNumber(run.findingCount)} findings, health score ${formatNumber(run.healthScore)}.`;
      if (run.recommendationsError) {
        message += ` Recommendations were not updated: ${run.recommendationsError}`;
      }
    }
    let variant = "warning";
    if (run.status === "Completed" && !run.recommendationsError) {
      variant = "success";
    } else if (run.status === "Failed" && !run.cancelled) {
      variant = "error";
    }
    this.dispatchEvent(
      new ShowToastEvent({
        title: run.error ? `${run.name} stopped` : `${run.name} finished`,
        message,
        variant
      })
    );
  }

  get scanProgressValue() {
    return Math.round(Number(this.runningScan?.progress || 0));
  }

  get scanProgressStyle() {
    return `width: ${this.scanProgressValue}%`;
  }

  get scanProgressText() {
    const step = this.runningScan?.currentStep || "Preparing";
    return `${this.runningScan?.name || "Scan"} · ${this.scanProgressValue}% · ${step}`;
  }

  get scanProgressTitle() {
    return `${this.scanProgressText}. Keep this tab open: closing or reloading it stops the scan. Click to open the scanner.`;
  }

  get stopScanLabel() {
    if (this.runningScan?.canCancel === false) {
      return "Finishing…";
    }
    return this.isStoppingScan ? "Stopping…" : "Stop";
  }

  /** Arrêt impossible pendant la phase finale (recommandations, score, enregistrement). */
  get stopScanDisabled() {
    return this.isStoppingScan || this.runningScan?.canCancel === false;
  }

  handleStopScan() {
    this.isStoppingScan = true;
    cancelScan();
  }

  handleOpenRunningScan() {
    this.goTo("scanner");
  }

  get isDark() {
    return (
      this.theme === "dark" || (this.theme === "system" && this.systemDark)
    );
  }

  get appClass() {
    return `oi-app ${this.isDark ? "theme-dark" : "theme-light"}`;
  }

  get themeOptions() {
    return THEMES.map((theme) => ({
      ...theme,
      checked: theme.value === this.theme ? "true" : "false",
      className: `theme-option${theme.value === this.theme ? " theme-option-selected" : ""}`
    }));
  }

  handleTheme(event) {
    this.theme = event.currentTarget.dataset.value;
    try {
      window.localStorage.setItem(THEME_KEY, this.theme);
    } catch {
      // stockage indisponible (navigation privée) : le choix vaut pour la session
    }
  }

  /**
   * Section affichée : celle demandée si elle est visible ; celle d'un module absent reste
   * « active » pour afficher l'état « module not installed » ; sinon la vue d'ensemble.
   */
  get activeSection() {
    if (this.isVisible(this.section) || this.isMissingModule(this.section)) {
      return this.section;
    }
    return DEFAULT_SECTION;
  }

  /** Section fournie par un module optionnel non installé ou inaccessible. */
  isMissingModule(name) {
    const section = findSection(name);
    return Boolean(
      section && section.module && this.modulesLoaded && !this.isVisible(name)
    );
  }

  get isModuleMissing() {
    return this.isMissingModule(this.activeSection);
  }

  get missingModuleLabel() {
    const section = this.current;
    const module = OPTIONAL_MODULES.find(
      (item) => item.key === section?.module
    );
    return module ? module.label : section?.label;
  }

  get missingModuleMessage() {
    return `${this.current?.description || ""} Install the ${this.missingModuleLabel} module, or ask for access to it, from the Modules screen.`;
  }

  handleOpenModules() {
    this.goTo("modules");
  }

  isVisible(name) {
    return sectionsFor(this.installedModules).some(
      (section) => section.name === name
    );
  }

  get navItems() {
    const hidden = new Set(this.hiddenSections);
    return sectionsFor(this.installedModules)
      .filter(
        (item) =>
          !item.hidden &&
          (this.isCustomizingNav ||
            !hidden.has(item.name) ||
            item.name === this.activeSection)
      )
      .map((item, index, list) => {
        const selected = item.name === this.activeSection;
        const previous = list[index - 1];
        const locked = LOCKED_SECTIONS.includes(item.name);
        const isHidden = hidden.has(item.name);
        return {
          ...item,
          soon: !item.available,
          admin: !!item.adminOnly,
          ariaCurrent: selected ? "page" : null,
          className: `nav-link${selected ? " nav-link-selected" : ""}${
            this.isCustomizingNav && isHidden ? " nav-link-hidden" : ""
          }`,
          locked,
          // Titre de groupe affiché avant le premier élément du groupe
          groupLabel:
            item.group && item.group !== previous?.group ? item.group : null,
          visibilityIcon: isHidden ? "utility:hide" : "utility:preview",
          visibilityLabel: isHidden
            ? `Show ${item.label} in the menu`
            : `Hide ${item.label} from the menu`
        };
      });
  }

  get customizeLabel() {
    return this.isCustomizingNav ? "Done" : "Customize menu";
  }

  get customizeIcon() {
    return this.isCustomizingNav ? "utility:check" : "utility:custom_apps";
  }

  get hiddenCount() {
    return this.hiddenSections.length;
  }

  get canResetNav() {
    return this.isCustomizingNav && this.hiddenSections.length > 0;
  }

  handleCustomizeNav() {
    this.isCustomizingNav = !this.isCustomizingNav;
  }

  handleToggleSection(event) {
    event.preventDefault();
    event.stopPropagation();
    const name = event.currentTarget.dataset.section;
    if (LOCKED_SECTIONS.includes(name)) {
      return;
    }
    this.hiddenSections = this.hiddenSections.includes(name)
      ? this.hiddenSections.filter((section) => section !== name)
      : [...this.hiddenSections, name];
    this.saveHiddenSections();
  }

  handleResetNav() {
    this.hiddenSections = [];
    this.saveHiddenSections();
  }

  // ---------- Menu replié / épinglé ----------

  get layoutClass() {
    return this.navPinned || this.isCustomizingNav
      ? "oi-layout oi-layout-pinned"
      : "oi-layout oi-layout-rail";
  }

  get navClass() {
    return this.navPinned || this.isCustomizingNav
      ? "oi-nav oi-nav-pinned"
      : "oi-nav oi-nav-rail";
  }

  get pinIcon() {
    return this.navPinned ? "utility:pinned" : "utility:pin";
  }

  get pinLabel() {
    return this.navPinned
      ? "Unpin the menu (open it on hover)"
      : "Pin the menu open";
  }

  handleTogglePin() {
    this.navPinned = !this.navPinned;
    saveValue(NAV_PINNED_STORE_KEY, this.navPinned).catch(() => {
      // préférence non gardée
    });
  }

  async loadNavPinned() {
    try {
      this.navPinned = (await loadValue(NAV_PINNED_STORE_KEY, false)) === true;
    } catch {
      this.navPinned = false;
    }
  }

  /** Préférence du menu : stockage commun ; l'ancienne clé localStorage est reprise une fois. */
  async loadHiddenSections() {
    try {
      const stored = await loadValue(HIDDEN_SECTIONS_STORE_KEY, null);
      if (Array.isArray(stored)) {
        this.hiddenSections = stored;
      } else if (this.hiddenSections.length) {
        await saveValue(HIDDEN_SECTIONS_STORE_KEY, this.hiddenSections);
      }
      window.localStorage.removeItem(LEGACY_HIDDEN_SECTIONS_KEY);
    } catch {
      // préférence illisible : menu complet
    }
  }

  saveHiddenSections() {
    saveValue(HIDDEN_SECTIONS_STORE_KEY, this.hiddenSections).catch(() => {
      // préférence non gardée (stockage du navigateur indisponible)
    });
  }

  get current() {
    return findSection(this.activeSection);
  }

  get isOverview() {
    return this.modulesLoaded && this.activeSection === "overview";
  }

  get isScanner() {
    return this.modulesLoaded && this.activeSection === "scanner";
  }

  get isRecommendations() {
    return this.modulesLoaded && this.activeSection === "recommendations";
  }

  get isAutomation() {
    return this.modulesLoaded && this.activeSection === "automation";
  }

  get isStorage() {
    return this.modulesLoaded && this.activeSection === "storage";
  }

  get isFieldUsage() {
    return this.modulesLoaded && this.activeSection === "fieldUsage";
  }

  get isObjectSetup() {
    return this.modulesLoaded && this.activeSection === "objectSetup";
  }

  get isAdoption() {
    return this.modulesLoaded && this.activeSection === "adoption";
  }

  get isRoadmap() {
    return this.modulesLoaded && this.activeSection === "roadmap";
  }

  get isInventory() {
    return this.modulesLoaded && this.activeSection === "inventory";
  }

  get isSecurity() {
    return this.modulesLoaded && this.activeSection === "security";
  }

  get isPermissions() {
    return this.modulesLoaded && this.activeSection === "permissions";
  }

  get isContextHub() {
    return this.modulesLoaded && this.activeSection === "contextHub";
  }

  get isApiMonitoring() {
    return this.modulesLoaded && this.activeSection === "apiMonitoring";
  }

  get isReports() {
    return this.modulesLoaded && this.activeSection === "reports";
  }

  get isModules() {
    return this.modulesLoaded && this.activeSection === "modules";
  }

  get isSettings() {
    return this.modulesLoaded && this.activeSection === "settings";
  }

  handleNavClick(event) {
    event.preventDefault();
    this.goTo(event.currentTarget.dataset.section);
  }

  handleChildNavigate(event) {
    const detail = event.detail || {};
    this.goTo(detail.section, {
      scanId: detail.scanId || null,
      recordId: detail.recordId || null,
      severity: detail.severity || null,
      search: detail.search || null
    });
  }

  /** Change de section (et de scan ou recommandation ouverts) et le reflète dans l'URL. */
  goTo(
    name,
    { scanId = null, recordId = null, severity = null, search = null } = {}
  ) {
    if (
      !findSection(name) ||
      (this.modulesLoaded &&
        !this.isVisible(name) &&
        !this.isMissingModule(name)) ||
      (name === this.section &&
        scanId === this.scanId &&
        recordId === this.recordId &&
        severity === this.severity &&
        search === this.search)
    ) {
      return;
    }
    this.section = name;
    this.scanId = scanId;
    this.recordId = recordId;
    this.severity = severity;
    this.search = search;
    if (this.pageRef) {
      const state = { ...this.pageRef.state, c__section: name };
      delete state.c__scanId;
      delete state.c__recordId;
      delete state.c__severity;
      delete state.c__search;
      if (search) {
        state.c__search = search;
      }
      if (severity) {
        state.c__severity = severity;
      }
      if (scanId) {
        state.c__scanId = scanId;
      }
      if (recordId) {
        state.c__recordId = recordId;
      }
      this[NavigationMixin.Navigate]({ ...this.pageRef, state });
    }
  }
}
