/**
 * Contexte d'une étape de scan : état transmis par le navigateur, catalogue des règles, accès
 * Tooling, tampons des composants et constats découverts, et mises à jour à renvoyer.
 *
 * Rien n'est écrit dans l'org : le navigateur cumule les résultats de chaque étape (édition sans
 * objet personnalisé).
 */
public inherited sharing class OrgScanContext {
  public OrgScanState state;
  public OrgToolingGateway tooling;

  private List<OrgScanModels.Component> pendingComponents = new List<OrgScanModels.Component>();
  @TestVisible
  private List<OrgScanModels.Finding> pendingFindings = new List<OrgScanModels.Finding>();

  public OrgScanContext(OrgScanState state) {
    this.state = state;
    this.tooling = OrgToolingGateway.getInstance();
  }

  // ---------- Règles ----------

  /** Définition de la règle, surcharges de Settings appliquées (OrgIntelSettings). */
  public OrgScanRule__mdt rule(String code) {
    return OrgIntelSettings.rule(code);
  }

  /**
   * À appeler avant d'évaluer une règle. Faux si elle est absente ou désactivée ; sinon elle est
   * marquée « évaluée », ce qui permettra de signaler les recommandations plus détectées.
   */
  public Boolean beginRule(String code) {
    OrgScanRule__mdt definition = rule(code);
    if (definition == null || !definition.IsEnabled__c) {
      return false;
    }
    state.evaluatedRules.add(code);
    state.ruleSteps.put(code, state.currentStep());
    return true;
  }

  public Decimal threshold(String code, Decimal fallback) {
    OrgScanRule__mdt definition = rule(code);
    return definition?.Threshold__c == null
      ? fallback
      : definition.Threshold__c;
  }

  public OrgScanModels.Finding newFinding(
    String code,
    OrgScanModels.Component component,
    String title
  ) {
    OrgScanModels.Finding finding = newFinding(
      code,
      component.componentType,
      component.apiName,
      title
    );
    finding.componentKey = component.key();
    return finding;
  }

  public OrgScanModels.Finding newFinding(
    String code,
    String componentType,
    String componentName,
    String title
  ) {
    OrgScanModels.Finding finding = new OrgScanModels.Finding();
    finding.ruleCode = code;
    finding.componentType = componentType;
    finding.componentName = componentName;
    finding.componentKey = OrgScanModels.buildKey(componentType, componentName);
    finding.title = title;
    finding.description = rule(code)?.Description__c;
    return finding;
  }

  // ---------- Journal ----------

  public void info(String message) {
    state.addLog(OrgScanModels.LEVEL_INFO, message);
  }

  public void warning(String message) {
    state.addLog(OrgScanModels.LEVEL_WARNING, message);
  }

  public void error(String message) {
    state.addLog(OrgScanModels.LEVEL_ERROR, message);
  }

  // ---------- Tampons ----------

  public void addComponents(List<OrgScanModels.Component> components) {
    pendingComponents.addAll(components);
  }

  public void addFinding(OrgScanModels.Finding finding) {
    pendingFindings.add(finding);
  }

  public void addFindings(List<OrgScanModels.Finding> findings) {
    pendingFindings.addAll(findings);
  }

  /** Composants découverts par l'étape (renvoyés au navigateur). */
  public List<OrgScanModels.Component> discoveredComponents() {
    return pendingComponents;
  }

  public List<OrgScanModels.Finding> discoveredFindings() {
    return pendingFindings;
  }

  // ---------- Inventaire transmis par le navigateur ----------

  /**
   * Composants déjà inventoriés par les étapes précédentes, renvoyés par le navigateur pour les
   * étapes qui en ont besoin (couverture, logique des flows, règles croisées).
   */
  public List<OrgScanModels.Component> inventory = new List<OrgScanModels.Component>();

  public List<OrgScanModels.Component> inventoryOf(Set<String> types) {
    List<OrgScanModels.Component> result = new List<OrgScanModels.Component>();
    for (OrgScanModels.Component component : inventory) {
      if (types.contains(component.componentType)) {
        result.add(component);
      }
    }
    return result;
  }

  public List<OrgScanModels.Component> inventoryOf(String type) {
    return inventoryOf(new Set<String>{ type });
  }

  // ---------- Mises à jour renvoyées au navigateur ----------

  /** Détails remplacés d'un composant déjà inventorié (clé du composant → détails complets). */
  public Map<String, Map<String, Object>> detailUpdates = new Map<String, Map<String, Object>>();
  /** Dépendances par clé de composant ({ uses, usedBy }). */
  public Map<String, Map<String, Object>> dependencyUpdates = new Map<String, Map<String, Object>>();
  /** Valeurs propres au scan (ex. photographie du stockage). */
  public Map<String, Object> scanValues = new Map<String, Object>();

  public void updateDetails(String componentKey, Map<String, Object> details) {
    detailUpdates.put(componentKey, details);
  }

  public void setDependencies(String componentKey, Map<String, Object> deps) {
    dependencyUpdates.put(componentKey, deps);
  }

  public void setScanValue(String name, Object value) {
    scanValues.put(name, value);
  }
}
