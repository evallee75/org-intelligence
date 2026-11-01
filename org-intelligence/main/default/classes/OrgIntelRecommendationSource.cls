/**
 * Contrat du module Recommendations (édition collaborative, avec objet) envers le socle :
 * indicateurs de la vue d'ensemble, des reports et du catalogue des règles.
 *
 * La synchronisation d'un scan (fait dans le navigateur) passe par les actions du module
 * (`syncScan`, `linksForFingerprints`) appelées par le navigateur. Sans le module, les
 * recommandations sont gardées dans le navigateur (édition sans objet).
 *
 * Package géré : le module est un autre package du même namespace. Les DTO des écrans
 * (@AuraEnabled) ne peuvent pas porter @NamespaceAccessible : le module renvoie donc des données
 * simples (Map, List, types primitifs) que le socle recopie dans ses DTO.
 */
@NamespaceAccessible
public interface OrgIntelRecommendationSource {
  /**
   * Indicateurs de la vue d'ensemble, clés :
   * - bySeverity (Map<String, Integer>) : recommandations ouvertes par gravité (clé vide comprise) ;
   * - toReviewCount, acceptedCount (Integer) ;
   * - priorityRecommendations (List<Map<String, Object>>) : recommandations ouvertes par ordre de
   *   priorité (au plus OrgOverviewService.PRIORITY_LIMIT), clés de
   *   OrgOverviewService.RecommendationSummary (id, name, title, severity, category, status,
   *   componentName, componentType, assignedToName, lastDetectedAt, stillDetected).
   */
  Map<String, Object> overviewData();

  /**
   * Tendances de résolution de la page Reports, clés :
   * - resolvedLast90Days, createdLast90Days, openCount (Integer), averageDaysToResolve (Decimal) ;
   * - resolutionTrend (List<Map<String, Object>> : month « yyyy-MM », created, resolved) ;
   * - openByCategory (List<Map<String, Object>> : componentType, count).
   */
  Map<String, Object> reportsData();

  /** Recommandations ouvertes par code de règle (catalogue des règles de Settings). */
  Map<String, Integer> openCountByRule();
}
