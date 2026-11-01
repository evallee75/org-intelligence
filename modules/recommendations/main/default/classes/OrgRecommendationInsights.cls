/**
 * Indicateurs des recommandations demandés par le socle (vue d'ensemble, reports, catalogue des
 * règles). Lus avec les droits de l'utilisateur (USER_MODE).
 *
 * Renvoyés en données simples (Map, List) : les DTO @AuraEnabled du socle ne sont pas accessibles
 * depuis un autre package du namespace (cf. OrgIntelRecommendationSource).
 */
public inherited sharing class OrgRecommendationInsights {
  // ---------- Vue d'ensemble ----------

  /** Taille de la liste des recommandations prioritaires (OrgOverviewService.PRIORITY_LIMIT). */
  private static final Integer PRIORITY_LIMIT = 200;

  public static Map<String, Object> overviewData() {
    Map<String, Object> result = new Map<String, Object>();
    Map<String, Integer> bySeverity = new Map<String, Integer>();
    for (AggregateResult row : [
      SELECT Severity__c severity, COUNT(Id) total
      FROM OrgRecommendation__c
      WHERE IsOpen__c = TRUE
      WITH USER_MODE
      GROUP BY Severity__c
    ]) {
      bySeverity.put((String) row.get('severity'), (Integer) row.get('total'));
    }
    result.put('bySeverity', bySeverity);

    Integer toReviewCount = 0;
    Integer acceptedCount = 0;
    for (AggregateResult row : [
      SELECT Status__c status, COUNT(Id) total
      FROM OrgRecommendation__c
      WHERE IsOpen__c = TRUE
      WITH USER_MODE
      GROUP BY Status__c
    ]) {
      String status = (String) row.get('status');
      Integer count = (Integer) row.get('total');
      if (status == OrgIntelligenceConstants.REC_ACCEPTED) {
        acceptedCount += count;
      } else {
        toReviewCount += count; // New et To Review : en attente de décision
      }
    }
    result.put('toReviewCount', toReviewCount);
    result.put('acceptedCount', acceptedCount);

    // Recommandations ouvertes par ordre de priorité : la vue d'ensemble filtre (gravité, recherche)
    // et en affiche les premières sans nouvel appel
    Integer size = PRIORITY_LIMIT;
    List<Map<String, Object>> priority = new List<Map<String, Object>>();
    for (OrgRecommendation__c rec : [
      SELECT
        Id,
        Name,
        Title__c,
        Severity__c,
        Category__c,
        Status__c,
        ComponentName__c,
        ComponentType__c,
        AssignedTo__r.Name,
        LastDetectedAt__c,
        StillDetected__c
      FROM OrgRecommendation__c
      WHERE IsOpen__c = TRUE
      WITH USER_MODE
      ORDER BY SeverityRank__c ASC, LastDetectedAt__c DESC NULLS LAST, Name ASC
      LIMIT :size
    ]) {
      priority.add(
        new Map<String, Object>{
          'id' => rec.Id,
          'name' => rec.Name,
          'title' => rec.Title__c,
          'severity' => rec.Severity__c,
          'category' => rec.Category__c,
          'status' => rec.Status__c,
          'componentName' => rec.ComponentName__c,
          'componentType' => rec.ComponentType__c,
          'assignedToName' => rec.AssignedTo__r?.Name,
          'lastDetectedAt' => rec.LastDetectedAt__c,
          'stillDetected' => rec.StillDetected__c
        }
      );
    }
    result.put('priorityRecommendations', priority);
    return result;
  }

  // ---------- Reports ----------

  public static Map<String, Object> reportsData() {
    Map<String, Object> view = new Map<String, Object>();
    Datetime since = Datetime.now().addDays(-90);
    view.put(
      'resolvedLast90Days',
      [
        SELECT COUNT()
        FROM OrgRecommendation__c
        WHERE ResolvedDate__c >= :since
        WITH USER_MODE
      ]
    );
    view.put(
      'createdLast90Days',
      [
        SELECT COUNT()
        FROM OrgRecommendation__c
        WHERE CreatedDate >= :since
        WITH USER_MODE
      ]
    );
    view.put(
      'openCount',
      [
        SELECT COUNT()
        FROM OrgRecommendation__c
        WHERE IsOpen__c = TRUE
        WITH USER_MODE
      ]
    );
    List<AggregateResult> average = [
      SELECT AVG(DaysToResolve__c) days
      FROM OrgRecommendation__c
      WHERE ResolvedDate__c != NULL
      WITH USER_MODE
    ];
    if (!average.isEmpty() && average[0].get('days') != null) {
      view.put(
        'averageDaysToResolve',
        ((Decimal) average[0].get('days')).setScale(1)
      );
    }

    // Créées et résolues par mois, sur 6 mois
    Map<String, Map<String, Object>> months = new Map<String, Map<String, Object>>();
    Date firstMonth = Date.today().toStartOfMonth().addMonths(-5);
    for (Integer i = 0; i < 6; i++) {
      Date month = firstMonth.addMonths(i);
      String key = Datetime.newInstance(month.year(), month.month(), 1)
        .format('yyyy-MM');
      months.put(
        key,
        new Map<String, Object>{
          'month' => key,
          'created' => 0,
          'resolved' => 0
        }
      );
    }
    Datetime monthStart = Datetime.newInstance(
      firstMonth.year(),
      firstMonth.month(),
      1
    );
    for (OrgRecommendation__c rec : [
      SELECT CreatedDate, ResolvedDate__c
      FROM OrgRecommendation__c
      WHERE CreatedDate >= :monthStart OR ResolvedDate__c >= :monthStart
      WITH USER_MODE
      LIMIT 10000
    ]) {
      String created = rec.CreatedDate.format('yyyy-MM');
      if (months.containsKey(created)) {
        increment(months.get(created), 'created');
      }
      if (
        rec.ResolvedDate__c != null &&
        months.containsKey(rec.ResolvedDate__c.format('yyyy-MM'))
      ) {
        increment(
          months.get(rec.ResolvedDate__c.format('yyyy-MM')),
          'resolved'
        );
      }
    }
    view.put('resolutionTrend', months.values());

    List<Map<String, Object>> openByCategory = new List<Map<String, Object>>();
    for (AggregateResult row : [
      SELECT Category__c category, COUNT(Id) total
      FROM OrgRecommendation__c
      WHERE IsOpen__c = TRUE
      WITH USER_MODE
      GROUP BY Category__c
      ORDER BY COUNT(Id) DESC
    ]) {
      openByCategory.add(
        new Map<String, Object>{
          'componentType' => (String) row.get('category'),
          'count' => (Integer) row.get('total')
        }
      );
    }
    view.put('openByCategory', openByCategory);
    return view;
  }

  private static void increment(Map<String, Object> point, String key) {
    point.put(key, (Integer) point.get(key) + 1);
  }

  // ---------- Settings ----------

  public static Map<String, Integer> openCountByRule() {
    Map<String, Integer> openByRule = new Map<String, Integer>();
    for (AggregateResult row : [
      SELECT RuleCode__c code, COUNT(Id) total
      FROM OrgRecommendation__c
      WHERE IsOpen__c = TRUE
      WITH USER_MODE
      GROUP BY RuleCode__c
    ]) {
      openByRule.put((String) row.get('code'), (Integer) row.get('total'));
    }
    return openByRule;
  }
}
