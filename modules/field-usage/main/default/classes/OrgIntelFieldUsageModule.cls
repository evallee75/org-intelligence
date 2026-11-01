/**
 * Entrée du module Field Usage (« Objects & Fields ») : découverte par le socle (OrgIntelModules).
 * Le module n'a aucun objet : l'accès est donné par la custom permission OrgIntelligence_FieldUsage
 * (permission set du module), les analyses sont gardées par le navigateur et l'envoi vers les
 * recommandations est fait par l'écran (c/orgIntelRecommendationStore).
 */
@NamespaceAccessible
public inherited sharing class OrgIntelFieldUsageModule extends OrgIntelModule {
  @NamespaceAccessible
  public static final String PERMISSION = 'OrgIntelligence_FieldUsage';

  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.FIELD_USAGE;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return FeatureManagement.checkPermission(PERMISSION);
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'getObjects' {
        return OrgFieldUsageController.getObjects();
      }
      when 'prepareAnalysis' {
        return OrgFieldUsageController.prepareAnalysis(
          text(params, 'objectName'),
          integerValue(params, 'recentDays')
        );
      }
      when 'scanChunk' {
        return OrgFieldUsageController.scanChunk(
          text(params, 'objectName'),
          textList(params, 'fields'),
          text(params, 'lastId'),
          integerValue(params, 'chunkSize'),
          datetimeValue(params, 'recentSince')
        );
      }
      when 'analyzeObjectSetup' {
        return OrgFieldUsageController.analyzeObjectSetup(
          text(params, 'objectName')
        );
      }
      when 'finalizeAnalysis' {
        return OrgFieldUsageController.finalizeAnalysis(
          text(params, 'objectName'),
          integerValue(params, 'recentDays'),
          integerValue(params, 'recordCount'),
          integerValue(params, 'recentCount'),
          (Map<String, OrgFieldUsageService.FieldStats>) typed(
            params,
            'stats',
            Map<String, OrgFieldUsageService.FieldStats>.class
          ),
          (OrgFieldUsageService.MetadataInfo) typed(
            params,
            'meta',
            OrgFieldUsageService.MetadataInfo.class
          )
        );
      }
    }
    throw unknownAction(action);
  }

  /** Paramètre JSON relu dans un type Apex (agrégats et métadonnées renvoyés par le navigateur). */
  private static Object typed(
    Map<String, Object> params,
    String name,
    System.Type apexType
  ) {
    Object value = params == null ? null : params.get(name);
    return value == null
      ? null
      : JSON.deserialize(JSON.serialize(value), apexType);
  }

  private static Datetime datetimeValue(
    Map<String, Object> params,
    String name
  ) {
    Object value = params == null ? null : params.get(name);
    if (value == null || String.isBlank(String.valueOf(value))) {
      return null;
    }
    return (Datetime) JSON.deserialize(
      '"' + String.valueOf(value) + '"',
      Datetime.class
    );
  }
}
