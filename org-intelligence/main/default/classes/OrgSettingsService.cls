/**
 * Settings : connexion Tooling, catalogue des règles, conservation des données, accès.
 * Les scans et leur score sont gardés dans le navigateur (édition sans objet) : l'aperçu du score
 * est calculé par l'interface à partir du dernier scan.
 *
 * Les paramètres sont des custom settings (OrgIntelSettings__c, surcharges des règles
 * OrgIntelRuleOverride__c) lus et écrits par OrgIntelSettings : enregistrement immédiat, sans
 * déploiement de métadonnées. Réservé aux administrateurs Org Intelligence (contrôle dans
 * OrgAdminController et dans la classe d'entrée du module Recommendations pour Jira).
 */
@NamespaceAccessible
public inherited sharing class OrgSettingsService {
  /** Permission sets du socle et des modules (OrgIntelligence_Admin, OrgIntelligence_FieldUsage_Admin...). */
  private static final String PERMISSION_SET_PATTERN = 'OrgIntelligence%';

  public class SettingsView {
    @AuraEnabled
    public OrgToolingGateway.Status tooling;
    @AuraEnabled
    public String orgDomainUrl;
    @AuraEnabled
    public List<RuleRow> rules;
    @AuraEnabled
    public Retention retention;
    @AuraEnabled
    public List<AccessRow> access;
    @AuraEnabled
    public List<VolumeRow> volumes;
    @AuraEnabled
    public OrgHealthScore.Config score;
    @AuraEnabled
    public Map<String, Map<String, List<Decimal>>> scorePresets;
    @AuraEnabled
    public List<String> scoreDomains;
  }

  public class RuleRow {
    @AuraEnabled
    public String code;
    @AuraEnabled
    public String label;
    @AuraEnabled
    public String domain;
    @AuraEnabled
    public Boolean enabled;
    @AuraEnabled
    public String severity;
    @AuraEnabled
    public String category;
    @AuraEnabled
    public String confidence;
    @AuraEnabled
    public Decimal threshold;
    @AuraEnabled
    public String description;
    @AuraEnabled
    public Boolean needsTooling;
    @AuraEnabled
    public Integer openRecommendations = 0;
    /** Valeurs modifiées dans Settings (différentes du catalogue livré). */
    @AuraEnabled
    public Boolean overridden = false;
  }

  /** Tri d'affichage : domaine, puis libellé (comme l'ancienne requête). */
  private class RuleOrder implements System.Comparator<OrgScanRule__mdt> {
    public Integer compare(OrgScanRule__mdt left, OrgScanRule__mdt right) {
      String leftKey =
        (left.Domain__c == null ? '' : left.Domain__c) +
        '|' +
        left.MasterLabel;
      String rightKey =
        (right.Domain__c == null ? '' : right.Domain__c) +
        '|' +
        right.MasterLabel;
      return leftKey.compareTo(rightKey);
    }
  }

  public class Retention {
    @AuraEnabled
    public Integer apiLogRetentionDays;
    @AuraEnabled
    public Boolean logApiPayloads;
    @AuraEnabled
    public String namedCredential;
  }

  public class AccessRow {
    @AuraEnabled
    public Id userId;
    @AuraEnabled
    public String userName;
    @AuraEnabled
    public String permissionSet;
    @AuraEnabled
    public Boolean isActive;
  }

  public class VolumeRow {
    @AuraEnabled
    public String label;
    @AuraEnabled
    public Integer count;
  }

  private static final Set<String> TOOLING_RULES = new Set<String>{
    'APEX_LOW_COVERAGE',
    'VR_INACTIVE',
    'VR_HARDCODED_ID',
    'VR_WITHOUT_BYPASS',
    'FLOW_DML_IN_LOOP',
    'FLOW_AFTER_SAVE_SAME_RECORD',
    'FLOW_NO_ENTRY_CRITERIA',
    'FLOW_MISSING_FAULT_PATH',
    'FLOW_HARDCODED_ID',
    'FLOW_SAME_TIMING_NO_ORDER',
    'AUTOMATION_RECURSION_RISK'
  };

  public static SettingsView getSettings() {
    SettingsView view = new SettingsView();
    view.tooling = OrgToolingGateway.getInstance().checkConnection();
    OrgApiLogger.flush();
    view.orgDomainUrl = Url.getOrgDomainUrl().toExternalForm();
    view.rules = loadRules();
    view.retention = loadRetention();
    view.access = loadAccess();
    view.volumes = loadVolumes();
    view.score = OrgHealthScore.config();
    view.scorePresets = OrgHealthScore.PRESETS;
    view.scoreDomains = OrgHealthScore.DOMAINS;
    return view;
  }

  private static List<RuleRow> loadRules() {
    OrgIntelRecommendationSource recommendations = OrgIntelModules.recommendations();
    Map<String, Integer> openByRule = new Map<String, Integer>();
    try {
      if (recommendations != null) {
        openByRule = recommendations.openCountByRule();
      }
    } catch (Exception e) {
      // Compteurs indicatifs : droits de champ incomplets sur les recommandations → sans compteur
      System.debug(
        LoggingLevel.WARN,
        'Open recommendations: ' + e.getMessage()
      );
    }
    List<RuleRow> rows = new List<RuleRow>();
    List<OrgScanRule__mdt> ordered = OrgIntelSettings.rules().values();
    ordered.sort(new RuleOrder());
    for (OrgScanRule__mdt rule : ordered) {
      RuleRow row = new RuleRow();
      row.code = rule.DeveloperName;
      row.label = rule.MasterLabel;
      row.domain = rule.Domain__c;
      row.enabled = rule.IsEnabled__c;
      row.severity = rule.Severity__c;
      row.category = rule.Category__c;
      row.confidence = rule.Confidence__c;
      row.threshold = rule.Threshold__c;
      row.description = rule.Description__c;
      row.needsTooling = TOOLING_RULES.contains(rule.DeveloperName);
      row.overridden = OrgIntelSettings.isOverridden(rule.DeveloperName);
      row.openRecommendations = openByRule.containsKey(rule.DeveloperName)
        ? openByRule.get(rule.DeveloperName)
        : 0;
      rows.add(row);
    }
    return rows;
  }

  private static Retention loadRetention() {
    Retention retention = new Retention();
    retention.apiLogRetentionDays = OrgIntelSettings.apiLogRetentionDays();
    retention.logApiPayloads = OrgIntelSettings.logApiPayloads();
    retention.namedCredential = OrgIntelSettings.toolingNamedCredential();
    return retention;
  }

  private static List<AccessRow> loadAccess() {
    List<AccessRow> rows = new List<AccessRow>();
    for (PermissionSetAssignment assignment : [
      SELECT AssigneeId, Assignee.Name, Assignee.IsActive, PermissionSet.Label
      FROM PermissionSetAssignment
      WHERE PermissionSet.Name LIKE :PERMISSION_SET_PATTERN
      ORDER BY PermissionSet.Label, Assignee.Name
      LIMIT 500
    ]) {
      AccessRow row = new AccessRow();
      row.userId = assignment.AssigneeId;
      row.userName = assignment.Assignee.Name;
      row.isActive = assignment.Assignee.IsActive;
      row.permissionSet = assignment.PermissionSet.Label;
      rows.add(row);
    }
    return rows;
  }

  private static List<VolumeRow> loadVolumes() {
    // Le socle ne stocke rien : seuls les modules avec objets (Recommendations collaboratif,
    // API Monitoring) ont des volumes
    List<VolumeRow> rows = new List<VolumeRow>();
    for (OrgIntelModule module : OrgIntelModules.installed()) {
      if (!module.isAccessible()) {
        continue; // permission set du module non assigné
      }
      Map<String, Integer> counts = module.recordCounts();
      for (String label : counts.keySet()) {
        rows.add(volume(label, counts.get(label)));
      }
    }
    return rows;
  }

  private static VolumeRow volume(String label, Integer count) {
    VolumeRow row = new VolumeRow();
    row.label = label;
    row.count = count;
    return row;
  }

  // ---------- Modifications (custom settings, enregistrement immédiat) ----------

  /**
   * Activation, gravité et seuil d'une règle (surcharge du catalogue). Renvoie null : il n'y a
   * plus de déploiement à suivre (signature conservée pour l'interface).
   */
  public static Id updateRule(
    String code,
    Boolean enabled,
    String severity,
    Decimal threshold
  ) {
    OrgIntelSettings.saveRuleOverride(code, enabled, severity, threshold);
    return null;
  }

  public static Id updateRetention(Integer apiLogDays, Boolean logPayloads) {
    if (apiLogDays == null || apiLogDays < 1 || apiLogDays > 3650) {
      throw new IllegalArgumentException('Keep the API log 1 to 3650 days.');
    }
    OrgIntelSettings.save(
      new Map<String, Object>{
        'ApiLogRetentionDays__c' => apiLogDays,
        'LogApiPayloads__c' => logPayloads == true
      }
    );
    return null;
  }

  /**
   * Préférences du score de santé. Les scans gardés dans le navigateur recalculent leur score à
   * l'affichage avec ces réglages.
   */
  public static Id updateScore(String scoreJson) {
    Map<String, Object> score = (Map<String, Object>) JSON.deserializeUntyped(
      scoreJson
    );
    Map<String, Object> points = (Map<String, Object>) score.get('points');
    Map<String, Object> caps = (Map<String, Object>) score.get('caps');
    Map<String, Object> values = new Map<String, Object>();
    for (String severity : OrgIntelligenceConstants.SEVERITIES) {
      Decimal point = toDecimal(points?.get(severity));
      Decimal cap = toDecimal(caps?.get(severity));
      if (
        point == null ||
        point < 0 ||
        point > 100 ||
        cap == null ||
        cap < 0 ||
        cap > 100
      ) {
        throw new IllegalArgumentException(
          'Points and caps must be between 0 and 100 (' + severity + ').'
        );
      }
      values.put(OrgIntelSettings.pointsField(severity), point);
      values.put(OrgIntelSettings.capField(severity), cap);
    }
    List<String> domains = new List<String>();
    Object rawDomains = score.get('domains');
    for (
      Object domain : rawDomains instanceof List<Object>
        ? (List<Object>) rawDomains
        : new List<Object>()
    ) {
      if (OrgHealthScore.DOMAINS.contains(String.valueOf(domain))) {
        domains.add(String.valueOf(domain));
      }
    }
    if (domains.isEmpty()) {
      throw new IllegalArgumentException(
        'Keep at least one domain in the score.'
      );
    }
    values.put(
      'ScoreDomains__c',
      domains.size() == OrgHealthScore.DOMAINS.size()
        ? null
        : String.join(domains, ';')
    );
    values.put('ScoreExcludeIgnored__c', score.get('excludeIgnored') == true);
    Object preset = score.get('preset');
    values.put(
      'ScorePreset__c',
      preset == null ? null : String.valueOf(preset).left(20)
    );
    OrgIntelSettings.save(values);
    return null;
  }

  /** Projet et type de ticket Jira (le site et les identifiants sont dans la Named Credential). */
  @NamespaceAccessible
  public static Id updateJira(String projectKey, String issueType) {
    if (String.isNotBlank(projectKey) && projectKey.length() > 20) {
      throw new IllegalArgumentException('The Jira project key is too long.');
    }
    OrgIntelSettings.save(
      new Map<String, Object>{
        'JiraProjectKey__c' => projectKey,
        'JiraIssueType__c' => String.isBlank(issueType)
          ? OrgIntelSettings.DEFAULT_JIRA_ISSUE_TYPE
          : issueType.left(80)
      }
    );
    return null;
  }

  private static Decimal toDecimal(Object value) {
    return value == null ? null : Decimal.valueOf(String.valueOf(value));
  }
}
