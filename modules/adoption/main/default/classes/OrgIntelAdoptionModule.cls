/**
 * Entrée du module Adoption : découverte par le socle (OrgIntelModules), elle sert l'écran
 * « Adoption » (licences payées et utilisées, fonctionnalités natives exploitées ou non). Le module
 * n'a aucun objet : l'accès est donné par la custom permission OrgIntelligence_Adoption (permission
 * set du module), et l'analyse comme le contrat sont gardés dans le navigateur.
 */
@NamespaceAccessible
public inherited sharing class OrgIntelAdoptionModule extends OrgIntelModule {
  @NamespaceAccessible
  public static final String PERMISSION = 'OrgIntelligence_Adoption';

  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.ADOPTION;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return FeatureManagement.checkPermission(PERMISSION);
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'runAnalysis' {
        return OrgAdoptionController.runAnalysis(
          textList(params, 'clouds'),
          params.get('contractLines')
        );
      }
      when 'compareContract' {
        return OrgAdoptionController.compareContract(
          params.get('analysis'),
          params.get('contractLines')
        );
      }
      when 'prefillContract' {
        return OrgAdoptionController.prefillContract(
          params.get('analysis'),
          params.get('contractLines')
        );
      }
      when 'buildRecommendations' {
        return OrgAdoptionController.buildRecommendations(
          params.get('analysis'),
          params.get('contractLines'),
          textList(params, 'keys')
        );
      }
    }
    throw unknownAction(action);
  }
}
