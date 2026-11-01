/**
 * Valeurs de référence partagées par les couches d'Org Intelligence (statuts, gravités, droits).
 * Les valeurs de listes de choix sont celles des champs de OrgRecommendation__c (module).
 */
@NamespaceAccessible
public inherited sharing class OrgIntelligenceConstants {
  @NamespaceAccessible
  public static final String ADMIN_PERMISSION = 'OrgIntelligence_Admin';
  /** Consultation (aucun objet dans le socle : l'accès est une custom permission). */
  @NamespaceAccessible
  public static final String USER_PERMISSION = 'OrgIntelligence_User';

  // Statuts d'une recommandation (OrgRecommendation__c.Status__c)
  @NamespaceAccessible
  public static final String REC_NEW = 'New';
  @NamespaceAccessible
  public static final String REC_TO_REVIEW = 'To Review';
  @NamespaceAccessible
  public static final String REC_ACCEPTED = 'Accepted';
  @NamespaceAccessible
  public static final String REC_IGNORED = 'Ignored';
  @NamespaceAccessible
  public static final String REC_RESOLVED = 'Resolved';

  /** Gravités, de la plus forte à la plus faible (ordre d'affichage). */
  @NamespaceAccessible
  public static final List<String> SEVERITIES = new List<String>{
    'Critical',
    'High',
    'Medium',
    'Low',
    'Info'
  };
}
