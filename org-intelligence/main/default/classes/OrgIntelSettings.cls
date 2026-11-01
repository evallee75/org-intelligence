/**
 * Lecture et écriture centralisées des paramètres d'Org Intelligence, sans déploiement de
 * métadonnées (compatible package géré) :
 * - paramètres globaux : custom setting hiérarchique OrgIntelSettings__c (valeurs par défaut de
 *   l'organisation). Si elles n'existent pas encore (installation antérieure à ce mécanisme), les
 *   valeurs sont reprises de l'ancien enregistrement CMDT OrgIntelligenceSetting__mdt.Default,
 *   puis des valeurs par défaut du produit ;
 * - règles du scanner : catalogue OrgScanRule__mdt livré avec l'application (valeurs par défaut,
 *   mises à jour à chaque version) fusionné avec les surcharges saisies dans Settings
 *   (custom setting de liste OrgIntelRuleOverride__c, nom = code de la règle).
 *
 * Les écritures sont réservées aux administrateurs Org Intelligence (contrôle fait par l'appelant,
 * OrgAdminController / module) et passent en mode système : un custom setting n'est pas une donnée
 * métier, et l'administrateur Org Intelligence n'a pas forcément « Customize Application ».
 */
@NamespaceAccessible
public inherited sharing class OrgIntelSettings {
  public static final String DEFAULT_NAMED_CREDENTIAL = 'OrgIntelligenceTooling';
  public static final Integer DEFAULT_API_LOG_RETENTION_DAYS = 30;
  public static final String DEFAULT_JIRA_ISSUE_TYPE = 'Task';
  public static final String DEFAULT_SCORE_PRESET = 'Balanced';
  /** Longueur maximale du nom d'un enregistrement de custom setting. */
  public static final Integer MAX_RULE_CODE_LENGTH = 38;

  private static final List<String> SEVERITY_NAMES = new List<String>{
    'Critical',
    'High',
    'Medium',
    'Low',
    'Info'
  };

  private static OrgIntelSettings__c cachedSettings;
  private static Map<String, OrgScanRule__mdt> cachedRules;

  // ---------- Paramètres globaux ----------

  /**
   * Paramètres effectifs : custom setting de l'organisation, chaque champ vide étant complété par
   * la valeur de repli (ancien CMDT, puis défaut du produit). Copie en mémoire : à ne pas insérer.
   */
  public static OrgIntelSettings__c getOrgDefaults() {
    if (cachedSettings == null) {
      OrgIntelSettings__c stored = OrgIntelSettings__c.getOrgDefaults();
      cachedSettings = stored?.Id == null
        ? defaultValues()
        : completeWithDefaults(stored.clone(false, true));
    }
    return cachedSettings;
  }

  public static Integer apiLogRetentionDays() {
    return getOrgDefaults().ApiLogRetentionDays__c.intValue();
  }

  @NamespaceAccessible
  public static Boolean logApiPayloads() {
    return getOrgDefaults().LogApiPayloads__c == true;
  }

  public static String toolingNamedCredential() {
    return getOrgDefaults().ToolingNamedCredential__c;
  }

  @NamespaceAccessible
  public static String jiraProjectKey() {
    return getOrgDefaults().JiraProjectKey__c;
  }

  @NamespaceAccessible
  public static String jiraIssueType() {
    return getOrgDefaults().JiraIssueType__c;
  }

  /**
   * Valeurs par défaut d'une nouvelle installation, ou reprise de l'ancien enregistrement CMDT
   * Default pour une organisation déjà installée (migration à la montée de version).
   */
  public static OrgIntelSettings__c defaultValues() {
    OrgIntelSettings__c values = new OrgIntelSettings__c();
    OrgIntelligenceSetting__mdt legacy = legacySetting();
    if (legacy != null) {
      values.ApiLogRetentionDays__c = legacy.ApiLogRetentionDays__c;
      values.LogApiPayloads__c = legacy.LogApiPayloads__c;
      values.ToolingNamedCredential__c = legacy.ToolingNamedCredential__c;
      values.JiraProjectKey__c = legacy.JiraProjectKey__c;
      values.JiraIssueType__c = legacy.JiraIssueType__c;
      values.ScorePreset__c = legacy.ScorePreset__c;
      values.ScoreDomains__c = legacy.ScoreDomains__c;
      values.ScoreExcludeIgnored__c = legacy.ScoreExcludeIgnored__c;
      for (String severity : SEVERITY_NAMES) {
        values.put(
          pointsField(severity),
          legacy.get('ScorePoints' + severity + '__c')
        );
        values.put(
          capField(severity),
          legacy.get('ScoreCap' + severity + '__c')
        );
      }
    } else {
      values.LogApiPayloads__c = false;
      values.ScoreExcludeIgnored__c = true;
    }
    return completeWithDefaults(values);
  }

  /**
   * Crée les valeurs par défaut de l'organisation si elles n'existent pas (post-installation,
   * idempotent). Vrai si un enregistrement a été créé.
   */
  public static Boolean ensureOrgDefaults() {
    if (OrgIntelSettings__c.getOrgDefaults()?.Id != null) {
      return false;
    }
    OrgIntelSettings__c values = defaultValues();
    values.SetupOwnerId = UserInfo.getOrganizationId();
    insert as system values;
    cachedSettings = null;
    return true;
  }

  /**
   * Enregistre des paramètres (seuls les champs fournis dans changes sont modifiés). Le contrôle
   * des droits est fait par l'appelant.
   */
  public static OrgIntelSettings__c save(Map<String, Object> changes) {
    OrgIntelSettings__c stored = OrgIntelSettings__c.getOrgDefaults();
    OrgIntelSettings__c record = stored?.Id == null ? defaultValues() : stored;
    for (String field : changes.keySet()) {
      record.put(field, changes.get(field));
    }
    if (record.Id == null) {
      record.SetupOwnerId = UserInfo.getOrganizationId();
      insert as system record;
    } else {
      update as system record;
    }
    cachedSettings = null;
    return getOrgDefaults();
  }

  public static String pointsField(String severity) {
    return 'ScorePoints' + severity + '__c';
  }

  public static String capField(String severity) {
    return 'ScoreCap' + severity + '__c';
  }

  private static OrgIntelSettings__c completeWithDefaults(
    OrgIntelSettings__c values
  ) {
    if (values.ApiLogRetentionDays__c == null) {
      values.ApiLogRetentionDays__c = DEFAULT_API_LOG_RETENTION_DAYS;
    }
    if (values.LogApiPayloads__c == null) {
      values.LogApiPayloads__c = false;
    }
    if (values.ScoreExcludeIgnored__c == null) {
      values.ScoreExcludeIgnored__c = true;
    }
    if (String.isBlank(values.ToolingNamedCredential__c)) {
      values.ToolingNamedCredential__c = DEFAULT_NAMED_CREDENTIAL;
    }
    if (String.isBlank(values.JiraIssueType__c)) {
      values.JiraIssueType__c = DEFAULT_JIRA_ISSUE_TYPE;
    }
    if (String.isBlank(values.ScorePreset__c)) {
      values.ScorePreset__c = DEFAULT_SCORE_PRESET;
    }
    Map<String, List<Decimal>> balanced = OrgHealthScore.PRESETS.get(
      DEFAULT_SCORE_PRESET
    );
    for (String severity : SEVERITY_NAMES) {
      if (values.get(pointsField(severity)) == null) {
        values.put(pointsField(severity), balanced.get(severity)[0]);
      }
      if (values.get(capField(severity)) == null) {
        values.put(capField(severity), balanced.get(severity)[1]);
      }
    }
    return values;
  }

  /** Ancien enregistrement CMDT (installations antérieures) ; null s'il n'existe plus. */
  private static OrgIntelligenceSetting__mdt legacySetting() {
    return OrgIntelligenceSetting__mdt.getInstance('Default');
  }

  // ---------- Règles du scanner ----------

  /**
   * Catalogue des règles (code → définition), surcharges de Settings appliquées. Lu par SOQL
   * (getAll tronque les champs texte long) ; copies en mémoire, jamais enregistrées.
   */
  @NamespaceAccessible
  public static Map<String, OrgScanRule__mdt> rules() {
    if (cachedRules == null) {
      Map<String, OrgIntelRuleOverride__c> overrides = OrgIntelRuleOverride__c.getAll();
      cachedRules = new Map<String, OrgScanRule__mdt>();
      for (OrgScanRule__mdt rule : [
        SELECT
          DeveloperName,
          MasterLabel,
          Domain__c,
          IsEnabled__c,
          Severity__c,
          Category__c,
          Confidence__c,
          Threshold__c,
          Description__c,
          Rationale__c,
          SuggestedAction__c
        FROM OrgScanRule__mdt
        ORDER BY DeveloperName
      ]) {
        cachedRules.put(
          rule.DeveloperName,
          applyOverride(rule, overrides.get(rule.DeveloperName))
        );
      }
    }
    return cachedRules;
  }

  @NamespaceAccessible
  public static OrgScanRule__mdt rule(String code) {
    return code == null ? null : rules().get(code);
  }

  /** Vrai si la règle a une surcharge enregistrée dans Settings. */
  public static Boolean isOverridden(String code) {
    return code != null && OrgIntelRuleOverride__c.getInstance(code) != null;
  }

  /**
   * Enregistre l'activation, la gravité et le seuil d'une règle. Une surcharge identique aux
   * valeurs du catalogue est supprimée (la règle suit alors les mises à jour de l'application).
   */
  public static OrgScanRule__mdt saveRuleOverride(
    String code,
    Boolean enabled,
    String severity,
    Decimal threshold
  ) {
    OrgScanRule__mdt catalog = catalogRule(code);
    if (catalog == null) {
      throw new IllegalArgumentException('Unknown rule ' + code);
    }
    if (!SEVERITY_NAMES.contains(severity)) {
      throw new IllegalArgumentException('Unknown severity ' + severity);
    }
    if (threshold != null && threshold < 0) {
      throw new IllegalArgumentException('The threshold cannot be negative.');
    }
    if (code.length() > MAX_RULE_CODE_LENGTH) {
      throw new IllegalArgumentException(
        'The rule code is too long to be overridden: ' + code
      );
    }
    OrgIntelRuleOverride__c existing = OrgIntelRuleOverride__c.getInstance(
      code
    );
    Boolean sameAsCatalog =
      (enabled == true) == catalog.IsEnabled__c &&
      severity == catalog.Severity__c &&
      threshold == catalog.Threshold__c;
    if (sameAsCatalog) {
      if (existing != null) {
        delete as system new OrgIntelRuleOverride__c(Id = existing.Id);
      }
    } else {
      OrgIntelRuleOverride__c record = existing == null
        ? new OrgIntelRuleOverride__c(Name = code)
        : new OrgIntelRuleOverride__c(Id = existing.Id);
      record.IsEnabled__c = enabled == true;
      record.Severity__c = severity;
      record.Threshold__c = threshold;
      upsert as system record;
    }
    cachedRules = null;
    return rule(code);
  }

  private static OrgScanRule__mdt catalogRule(String code) {
    if (String.isBlank(code)) {
      return null;
    }
    List<OrgScanRule__mdt> rows = [
      SELECT DeveloperName, IsEnabled__c, Severity__c, Threshold__c
      FROM OrgScanRule__mdt
      WHERE DeveloperName = :code
      LIMIT 1
    ];
    return rows.isEmpty() ? null : rows[0];
  }

  private static OrgScanRule__mdt applyOverride(
    OrgScanRule__mdt rule,
    OrgIntelRuleOverride__c overrideRow
  ) {
    if (overrideRow == null) {
      return rule;
    }
    OrgScanRule__mdt merged = rule.clone(true, true, true, true);
    merged.IsEnabled__c = overrideRow.IsEnabled__c == true;
    if (SEVERITY_NAMES.contains(overrideRow.Severity__c)) {
      merged.Severity__c = overrideRow.Severity__c;
    }
    merged.Threshold__c = overrideRow.Threshold__c;
    return merged;
  }

  /** Vide les caches de la transaction (tests, après une écriture). */
  @TestVisible
  private static void resetCache() {
    cachedSettings = null;
    cachedRules = null;
  }
}
