/**
 * Exécution d'un scan pilotée par le navigateur (édition sans objet personnalisé).
 *
 * Le navigateur appelle `start`, puis `runStep` en boucle : chaque appel traite une page d'une étape
 * dans sa propre transaction synchrone (limites de gouvernance remises à zéro à chaque appel) et
 * renvoie les composants, constats et mises à jour découverts. Rien n'est écrit dans l'org : le
 * navigateur cumule les résultats, calcule le score et garde le scan.
 *
 * Robustesse : une erreur interceptée dans une étape est journalisée, l'étape marquée en échec et
 * le scan continue ; une erreur non interceptable (limite) fait échouer l'appel, et le navigateur
 * marque lui-même l'étape en échec avant de passer à la suivante.
 */
public inherited sharing class OrgScanRunner {
  public static final List<String> SCOPES = new List<String>{
    'ApexClass',
    'ApexTrigger',
    'Flow',
    'CustomObject',
    'ValidationRule',
    'Dependency',
    'Storage'
  };

  /** Types de composants déjà inventoriés dont une étape a besoin (renvoyés par le navigateur). */
  public static final Map<String, List<String>> INVENTORY_NEEDS = new Map<String, List<String>>{
    OrgScanState.STEP_APEX_COVERAGE => new List<String>{ 'ApexClass' },
    OrgScanState.STEP_FLOW_ANALYSIS => new List<String>{ 'Flow' },
    OrgScanState.STEP_CROSS_RULES => new List<String>{
      'ApexTrigger',
      'Flow',
      'ValidationRule'
    }
  };

  public class ScanException extends Exception {
  }

  // ---------- Démarrage ----------

  /** État initial et référentiels nécessaires au navigateur (étapes, besoins, score, règles). */
  public static Map<String, Object> start(List<String> requestedScope) {
    Set<String> requested = new Set<String>(
      requestedScope == null ? new List<String>() : requestedScope
    );
    Set<String> scope = new Set<String>();
    List<String> ordered = new List<String>();
    for (String value : SCOPES) {
      if (requested.contains(value)) {
        scope.add(value);
        ordered.add(value);
      }
    }
    if (scope.isEmpty()) {
      throw new ScanException('Select at least one area to scan.');
    }
    OrgScanState state = new OrgScanState();
    state.steps = OrgScanState.stepsFor(scope);

    Map<String, String> labels = new Map<String, String>();
    for (String step : state.steps) {
      labels.put(step, OrgScanState.STEP_LABELS.get(step));
    }
    return new Map<String, Object>{
      'state' => state,
      'scope' => ordered,
      'stepLabels' => labels,
      'inventoryNeeds' => INVENTORY_NEEDS,
      'scoreConfig' => OrgHealthScore.config(),
      'rules' => ruleCatalog()
    };
  }

  /**
   * Règles et leurs métadonnées (gravité, catégorie, confiance, justification, action conseillée),
   * surcharges de Settings appliquées.
   */
  public static List<Map<String, Object>> ruleCatalog() {
    List<Map<String, Object>> result = new List<Map<String, Object>>();
    for (OrgScanRule__mdt rule : OrgIntelSettings.rules().values()) {
      result.add(
        new Map<String, Object>{
          'code' => rule.DeveloperName,
          'label' => rule.MasterLabel,
          'severity' => rule.Severity__c,
          'category' => rule.Category__c,
          'confidence' => rule.Confidence__c,
          'enabled' => rule.IsEnabled__c,
          'rationale' => rule.Rationale__c,
          'suggestedAction' => rule.SuggestedAction__c,
          'domain' => OrgHealthScore.domainOf(rule.DeveloperName)
        }
      );
    }
    return result;
  }

  // ---------- Étape ----------

  /**
   * Exécute la page courante de l'étape courante.
   * @param stateJson état renvoyé par l'appel précédent (journal vidé)
   * @param inventoryJson composants des étapes précédentes demandés par INVENTORY_NEEDS (ou null)
   */
  public static Map<String, Object> runStep(
    String stateJson,
    String inventoryJson
  ) {
    OrgScanState state = (OrgScanState) JSON.deserialize(
      stateJson,
      OrgScanState.class
    );
    state.log = new List<OrgScanModels.LogEntry>();
    if (state.isFinished()) {
      throw new ScanException('This scan is already finished.');
    }
    String step = state.currentStep();
    String stepLabel = state.currentStepLabel();
    OrgScanContext ctx = new OrgScanContext(state);
    if (String.isNotBlank(inventoryJson)) {
      ctx.inventory = parseInventory(inventoryJson);
    }
    try {
      String next = stepFor(step).run(ctx, state.cursor);
      if (next == null) {
        state.advance();
      } else {
        state.cursor = next;
      }
    } catch (Exception e) {
      state.addLog(
        OrgScanModels.LEVEL_ERROR,
        'Step failed: ' +
          describe(e) +
          ' Its results are incomplete and its rules are ignored for this scan.'
      );
      state.failedSteps.add(step);
      state.advance();
      ctx.discoveredComponents().clear();
      ctx.discoveredFindings().clear();
    }
    OrgApiLogger.flush(); // journal API (module API Monitoring), après les callouts

    List<Map<String, Object>> components = new List<Map<String, Object>>();
    for (OrgScanModels.Component component : ctx.discoveredComponents()) {
      Map<String, Object> row = (Map<String, Object>) JSON.deserializeUntyped(
        JSON.serialize(component)
      );
      row.put('key', component.key());
      components.add(row);
    }
    List<Map<String, Object>> findings = new List<Map<String, Object>>();
    for (OrgScanModels.Finding finding : ctx.discoveredFindings()) {
      findings.add(toRow(finding, ctx));
    }
    List<OrgScanModels.LogEntry> log = state.log;
    state.log = new List<OrgScanModels.LogEntry>();
    return new Map<String, Object>{
      'state' => state,
      'step' => step,
      'stepLabel' => stepLabel,
      'finished' => state.isFinished(),
      'progress' => state.progressPercent(),
      'nextStepLabel' => state.currentStepLabel(),
      'components' => components,
      'findings' => findings,
      'detailUpdates' => ctx.detailUpdates,
      'dependencyUpdates' => ctx.dependencyUpdates,
      'scanValues' => ctx.scanValues,
      'log' => log,
      'reliableRules' => state.reliablyEvaluatedRules()
    };
  }

  /**
   * Composants renvoyés par le navigateur. Lecture non typée : JSON.deserialize ne sait pas remplir
   * un champ Map<String, Object> (les détails), il lève « Apex Type unsupported in JSON: Object ».
   */
  @TestVisible
  private static List<OrgScanModels.Component> parseInventory(
    String inventoryJson
  ) {
    List<OrgScanModels.Component> result = new List<OrgScanModels.Component>();
    for (Object item : (List<Object>) JSON.deserializeUntyped(inventoryJson)) {
      Map<String, Object> row = (Map<String, Object>) item;
      OrgScanModels.Component component = new OrgScanModels.Component(
        (String) row.get('componentType'),
        (String) row.get('apiName')
      );
      component.parentName = (String) row.get('parentName');
      component.metadataId = (String) row.get('metadataId');
      component.namespacePrefix = (String) row.get('namespacePrefix');
      component.apiVersion = row.get('apiVersion') == null
        ? null
        : Decimal.valueOf(String.valueOf(row.get('apiVersion')));
      component.isActive = row.get('isActive') != false;
      component.description = (String) row.get('description');
      if (row.get('details') instanceof Map<String, Object>) {
        component.details = (Map<String, Object>) row.get('details');
      }
      result.add(component);
    }
    return result;
  }

  private static Map<String, Object> toRow(
    OrgScanModels.Finding finding,
    OrgScanContext ctx
  ) {
    OrgScanRule__mdt definition = ctx.rule(finding.ruleCode);
    return new Map<String, Object>{
      'fingerprint' => finding.fingerprint(),
      'ruleCode' => finding.ruleCode,
      'componentType' => finding.componentType,
      'componentName' => finding.componentName,
      'componentKey' => finding.componentKey,
      'title' => finding.title?.abbreviate(255),
      'description' => finding.description?.abbreviate(32768),
      'evidence' => finding.evidence?.abbreviate(32768),
      'affectedComponents' => finding.affectedComponents,
      'severity' => definition?.Severity__c,
      'category' => definition?.Category__c,
      'confidence' => definition?.Confidence__c,
      'domain' => OrgHealthScore.domainOf(finding.ruleCode)
    };
  }

  private static OrgScanStep stepFor(String step) {
    switch on step {
      when 'PREPARE' {
        return new OrgScanPrepareStep();
      }
      when 'APEX_CLASSES' {
        return new OrgApexClassCollector();
      }
      when 'APEX_COVERAGE' {
        return new OrgApexCoverageCollector();
      }
      when 'APEX_TRIGGERS' {
        return new OrgApexTriggerCollector();
      }
      when 'FLOWS' {
        return new OrgFlowCollector();
      }
      when 'FLOW_ANALYSIS' {
        return new OrgFlowAnalysisStep();
      }
      when 'STORAGE' {
        return new OrgStorageStep();
      }
      when 'OBJECTS_FIELDS' {
        return new OrgObjectFieldCollector();
      }
      when 'VALIDATION_RULES' {
        return new OrgValidationRuleCollector();
      }
      when 'DEPENDENCIES' {
        return new OrgDependencyCollector();
      }
      when 'CROSS_RULES' {
        return new OrgCrossRulesStep();
      }
    }
    throw new IllegalArgumentException('Unknown scan step ' + step);
  }

  /** Message d'erreur sans pile d'appels (rien de sensible dans le journal). */
  public static String describe(Exception e) {
    String message = e.getMessage() == null ? '' : e.getMessage();
    return (e.getTypeName() + ': ' + message).abbreviate(500);
  }
}
