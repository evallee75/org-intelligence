/**
 * État d'un scan, gardé par le navigateur et renvoyé à chaque étape : étape courante, curseur de
 * pagination, règles évaluées et journal de collecte. Le journal de l'étape est renvoyé puis vidé
 * (le navigateur garde le journal complet).
 */
public inherited sharing class OrgScanState {
  public static final String STEP_PREPARE = 'PREPARE';
  public static final String STEP_APEX_CLASSES = 'APEX_CLASSES';
  public static final String STEP_APEX_COVERAGE = 'APEX_COVERAGE';
  public static final String STEP_APEX_TRIGGERS = 'APEX_TRIGGERS';
  public static final String STEP_FLOWS = 'FLOWS';
  public static final String STEP_FLOW_ANALYSIS = 'FLOW_ANALYSIS';
  public static final String STEP_STORAGE = 'STORAGE';
  public static final String STEP_OBJECTS_FIELDS = 'OBJECTS_FIELDS';
  public static final String STEP_VALIDATION_RULES = 'VALIDATION_RULES';
  public static final String STEP_DEPENDENCIES = 'DEPENDENCIES';
  public static final String STEP_CROSS_RULES = 'CROSS_RULES';

  /** Libellés des étapes affichés par le navigateur pendant le scan. */
  public static final Map<String, String> STEP_LABELS = new Map<String, String>{
    STEP_PREPARE => 'Preparing',
    STEP_APEX_CLASSES => 'Apex classes',
    STEP_APEX_COVERAGE => 'Apex code coverage',
    STEP_APEX_TRIGGERS => 'Apex triggers',
    STEP_FLOWS => 'Flows',
    STEP_FLOW_ANALYSIS => 'Flow logic',
    STEP_STORAGE => 'Storage',
    STEP_OBJECTS_FIELDS => 'Objects and fields',
    STEP_VALIDATION_RULES => 'Validation rules',
    STEP_DEPENDENCIES => 'Dependencies',
    STEP_CROSS_RULES => 'Cross-component rules'
  };

  public List<String> steps = new List<String>();
  public Integer stepIndex = 0;
  public String cursor;
  public Boolean toolingAvailable = false;
  public Decimal referenceApiVersion;
  public Set<String> evaluatedRules = new Set<String>();
  /** Étape ayant évalué chaque règle : une étape en échec invalide ses règles. */
  public Map<String, String> ruleSteps = new Map<String, String>();
  public Set<String> failedSteps = new Set<String>();
  public List<OrgScanModels.LogEntry> log = new List<OrgScanModels.LogEntry>();

  /** Étapes à enchaîner pour un périmètre donné (SCAN_SCOPES de l'interface). */
  public static List<String> stepsFor(Set<String> scope) {
    List<String> result = new List<String>{ STEP_PREPARE };
    if (scope.contains('ApexClass')) {
      result.add(STEP_APEX_CLASSES);
      result.add(STEP_APEX_COVERAGE);
    }
    if (scope.contains('ApexTrigger')) {
      result.add(STEP_APEX_TRIGGERS);
    }
    if (scope.contains('Flow')) {
      result.add(STEP_FLOWS);
      result.add(STEP_FLOW_ANALYSIS);
    }
    if (scope.contains('CustomObject')) {
      result.add(STEP_OBJECTS_FIELDS);
    }
    if (scope.contains('ValidationRule')) {
      result.add(STEP_VALIDATION_RULES);
    }
    if (scope.contains('Storage')) {
      result.add(STEP_STORAGE);
    }
    if (scope.contains('Dependency')) {
      result.add(STEP_DEPENDENCIES);
    }
    result.add(STEP_CROSS_RULES);
    return result;
  }

  public Boolean isFinished() {
    return stepIndex >= steps.size();
  }

  public String currentStep() {
    return isFinished() ? null : steps[stepIndex];
  }

  public String currentStepLabel() {
    String step = currentStep();
    return step == null ? null : STEP_LABELS.get(step);
  }

  public Boolean hasStep(String step) {
    return steps.contains(step);
  }

  /** L'étape a été exécutée sans erreur (ou est encore à venir). */
  public Boolean isStepSuccessful(String step) {
    return steps.contains(step) && !failedSteps.contains(step);
  }

  public void advance() {
    stepIndex++;
    cursor = null;
  }

  public Integer progressPercent() {
    if (steps.isEmpty()) {
      return 0;
    }
    return Math.min(100, Math.round(100.0 * stepIndex / steps.size()));
  }

  public void addLog(String level, String message) {
    String stepLabel = currentStepLabel();
    log.add(
      new OrgScanModels.LogEntry(
        stepLabel == null ? 'Scan' : stepLabel,
        level,
        message
      )
    );
  }

  /** Règles évaluées par une étape sans échec : seules à pouvoir conclure à une absence. */
  public Set<String> reliablyEvaluatedRules() {
    Set<String> result = new Set<String>();
    for (String code : evaluatedRules) {
      if (!failedSteps.contains(ruleSteps.get(code))) {
        result.add(code);
      }
    }
    return result;
  }
}
