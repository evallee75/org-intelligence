/**
 * Entrée du module Context Hub : découverte par le socle (OrgIntelModules), elle sert l'écran
 * Context Hub. Le module n'a aucun objet (édition sans objet personnalisé) : l'accès est donné par
 * la custom permission OrgIntelligence_ContextHub (permission sets du module). Il ne dépend plus du
 * module Recommendations : les recommandations viennent du navigateur ou, si le module collaboratif
 * est installé, de ses propres actions appelées par l'écran.
 */
@NamespaceAccessible
public inherited sharing class OrgIntelContextHubModule extends OrgIntelModule {
  @NamespaceAccessible
  public static final String PERMISSION = 'OrgIntelligence_ContextHub';

  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.CONTEXT_HUB;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return FeatureManagement.checkPermission(PERMISSION);
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'prepareContext' {
        OrgIntelAccess.assertCanRead();
        try {
          return OrgContextService.prepare(text(params, 'content'));
        } catch (Exception e) {
          throw OrgIntelAccess.error('The context could not be generated', e);
        }
      }
    }
    throw unknownAction(action);
  }
}
