/**
 * Données serveur de la vue d'ensemble Org Intelligence.
 *
 * Les scans sont gardés dans le navigateur (édition sans objet) : l'interface calcule elle-même le
 * score, les constats et l'historique. Le serveur ne fournit que les droits, les préférences du
 * score et, si le module Recommendations collaboratif est installé, les indicateurs des
 * recommandations partagées (OrgIntelRecommendationSource.fillOverview).
 */
public inherited sharing class OrgOverviewService {
  public static final Integer PRIORITY_LIMIT = 200;

  public static Overview build() {
    Overview result = new Overview();
    result.canRunScan = FeatureManagement.checkPermission(
      OrgIntelligenceConstants.ADMIN_PERMISSION
    );
    OrgIntelRecommendationSource recommendations = OrgIntelModules.recommendations();
    result.recommendationsEnabled = recommendations != null;
    if (recommendations != null) {
      fillFromModule(result, recommendations.overviewData());
    }
    result.scoreConfig = OrgHealthScore.config();
    return result;
  }

  /** Répartition par gravité à partir des nombres par gravité (ligne vide comprise). */
  public static void fillSeverityDistribution(
    Overview result,
    Map<String, Integer> bySeverity
  ) {
    result.openRecommendationCount = 0;
    result.severityDistribution = new List<SeverityCount>();
    for (String severity : OrgIntelligenceConstants.SEVERITIES) {
      Integer count = bySeverity.containsKey(severity)
        ? bySeverity.get(severity)
        : 0;
      result.severityDistribution.add(new SeverityCount(severity, count));
    }
    // Total sur toutes les lignes, y compris une gravité vide (donnée saisie à la main)
    for (Integer count : bySeverity.values()) {
      result.openRecommendationCount += count;
    }
  }

  /** Recopie les indicateurs du module Recommendations (données simples, cf. contrat). */
  @TestVisible
  private static void fillFromModule(
    Overview result,
    Map<String, Object> data
  ) {
    if (data == null) {
      return;
    }
    Map<String, Integer> bySeverity = new Map<String, Integer>();
    Object severities = data.get('bySeverity');
    if (severities instanceof Map<String, Integer>) {
      bySeverity = (Map<String, Integer>) severities;
    } else if (severities instanceof Map<String, Object>) {
      Map<String, Object> source = (Map<String, Object>) severities;
      for (String severity : source.keySet()) {
        bySeverity.put(severity, toInteger(source.get(severity)));
      }
    }
    fillSeverityDistribution(result, bySeverity);
    result.toReviewCount = toInteger(data.get('toReviewCount'));
    result.acceptedCount = toInteger(data.get('acceptedCount'));
    Object priority = data.get('priorityRecommendations');
    result.priorityRecommendations = priority == null
      ? new List<RecommendationSummary>()
      : (List<RecommendationSummary>) JSON.deserialize(
          JSON.serialize(priority),
          List<RecommendationSummary>.class
        );
  }

  private static Integer toInteger(Object value) {
    return value == null ? 0 : Integer.valueOf(value);
  }

  // ---------- DTO ----------

  public class Overview {
    @AuraEnabled
    public Boolean canRunScan;
    @AuraEnabled
    public Integer openRecommendationCount;
    @AuraEnabled
    public Integer toReviewCount;
    @AuraEnabled
    public Integer acceptedCount;
    @AuraEnabled
    public List<SeverityCount> severityDistribution;
    @AuraEnabled
    public List<RecommendationSummary> priorityRecommendations;
    @AuraEnabled
    public OrgHealthScore.Config scoreConfig;
    /** Module Recommendations collaboratif installé : sinon l'interface calcule les compteurs. */
    @AuraEnabled
    public Boolean recommendationsEnabled;
  }

  public class SeverityCount {
    @AuraEnabled
    public String severity;
    @AuraEnabled
    public Integer count;

    public SeverityCount(String severity, Integer count) {
      this.severity = severity;
      this.count = count;
    }
  }

  public class RecommendationSummary {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String title;
    @AuraEnabled
    public String severity;
    @AuraEnabled
    public String category;
    @AuraEnabled
    public String status;
    @AuraEnabled
    public String componentName;
    @AuraEnabled
    public String componentType;
    @AuraEnabled
    public String assignedToName;
    @AuraEnabled
    public Datetime lastDetectedAt;
    @AuraEnabled
    public Boolean stillDetected;
  }
}
