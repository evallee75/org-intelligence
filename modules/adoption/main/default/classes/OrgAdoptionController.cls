/**
 * Point d'entrée Apex de la section Adoption (administrateurs). Édition sans objet personnalisé :
 * aucune écriture dans l'org. L'écran garde l'analyse et le contrat dans le navigateur et les
 * renvoie à chaque appel (comparaison, pré-remplissage, recommandations).
 */
public with sharing class OrgAdoptionController {
  public static OrgAdoptionService.View runAnalysis(
    List<String> clouds,
    Object contractLines
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgAdoptionService.run(
        clouds,
        OrgAdoptionContract.parseLines(contractLines)
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error('The adoption analysis could not be run', e);
    }
  }

  public static OrgAdoptionContract.Summary compareContract(
    Object analysis,
    Object contractLines
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgAdoptionContract.compare(
        OrgAdoptionContract.parseLines(contractLines),
        OrgAdoptionService.parse(analysis)
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error('The contract could not be compared', e);
    }
  }

  public static List<OrgAdoptionContract.Line> prefillContract(
    Object analysis,
    Object contractLines
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgAdoptionContract.prefill(
        OrgAdoptionService.parse(analysis),
        OrgAdoptionContract.parseLines(contractLines)
      );
    } catch (IllegalArgumentException e) {
      throw OrgIntelAccess.error(e.getMessage());
    } catch (Exception e) {
      throw OrgIntelAccess.error('The contract could not be prefilled', e);
    }
  }

  public static OrgAdoptionService.RecommendationBatch buildRecommendations(
    Object analysis,
    Object contractLines,
    List<String> keys
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgAdoptionService.buildRecommendations(
        OrgAdoptionService.parse(analysis),
        OrgAdoptionContract.parseLines(contractLines),
        keys
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error('The recommendations could not be built', e);
    }
  }
}
