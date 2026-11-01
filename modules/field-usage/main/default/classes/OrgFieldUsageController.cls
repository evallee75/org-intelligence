/**
 * Point d'entrée Apex de la section « Objects & Fields » (administrateurs), sans objet personnalisé :
 * objets analysables, préparation d'une analyse, lecture des enregistrements par tranches (agrégats
 * seulement) et calcul des statuts. Aucune écriture : les résultats sont gardés par le navigateur.
 */
public with sharing class OrgFieldUsageController {
  public static List<OrgFieldUsageService.ObjectSummary> getObjects() {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgFieldUsageService.listObjects();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The objects could not be loaded', e);
    }
  }

  public static OrgFieldUsageService.PreparedAnalysis prepareAnalysis(
    String objectName,
    Integer recentDays
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgFieldUsageService.prepare(objectName, recentDays);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The analysis could not be started', e);
    }
  }

  public static OrgFieldUsageService.ChunkResult scanChunk(
    String objectName,
    List<String> fields,
    String lastId,
    Integer chunkSize,
    Datetime recentSince
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgFieldUsageService.scanChunk(
        objectName,
        fields,
        lastId,
        chunkSize,
        recentSince
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error('The records could not be read', e);
    }
  }

  public static OrgFieldUsageService.AnalysisResult finalizeAnalysis(
    String objectName,
    Integer recentDays,
    Integer recordCount,
    Integer recentCount,
    Map<String, OrgFieldUsageService.FieldStats> stats,
    OrgFieldUsageService.MetadataInfo meta
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgFieldUsageService.finalizeAnalysis(
        objectName,
        recentDays,
        recordCount,
        recentCount,
        stats,
        meta
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error('The analysis could not be completed', e);
    }
  }

  /** Onglet « Object setup » : types d'enregistrement, présentations, assignations, pages Lightning. */
  public static OrgObjectSetupService.SetupResult analyzeObjectSetup(
    String objectName
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgObjectSetupService.analyze(objectName);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The object setup could not be analyzed', e);
    }
  }
}
