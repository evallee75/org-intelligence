/**
 * Dépendances des classes, triggers et flows (Tooling MetadataComponentDependency, API en bêta).
 *
 * Renvoyées au navigateur par clé de composant (« uses » et « usedBy »). L'API renvoie
 * au plus 2 000 lignes par requête : une requête tronquée est signalée dans le journal.
 */
public inherited sharing class OrgDependencyCollector implements OrgScanStep {
  @TestVisible
  private static final Integer API_ROW_LIMIT = 2000;
  private static final List<String> TYPES = new List<String>{
    'ApexClass',
    'ApexTrigger',
    'Flow'
  };
  private static final Integer MAX_ITEMS = 200;

  public String run(OrgScanContext ctx, String cursor) {
    if (!ctx.state.toolingAvailable) {
      ctx.warning(
        'Dependencies not collected: the Tooling API is not available.'
      );
      return null;
    }

    // Callouts d'abord (aucune écriture ne doit les précéder)
    List<Map<String, Object>> rows = new List<Map<String, Object>>();
    for (String type : TYPES) {
      rows.addAll(
        queryChecked(
          ctx,
          'MetadataComponentType = \'' + type + '\'',
          'components of type ' + type
        )
      );
    }
    rows.addAll(
      queryChecked(
        ctx,
        'RefMetadataComponentType = \'ApexClass\'',
        'references to Apex classes'
      )
    );

    Map<String, Set<String>> uses = new Map<String, Set<String>>();
    Map<String, Set<String>> usedBy = new Map<String, Set<String>>();
    for (Map<String, Object> row : rows) {
      String sourceKey = OrgScanModels.buildKey(
        OrgToolingGateway.getString(row, 'MetadataComponentType'),
        OrgToolingGateway.getString(row, 'MetadataComponentName')
      );
      String targetKey = OrgScanModels.buildKey(
        OrgToolingGateway.getString(row, 'RefMetadataComponentType'),
        OrgToolingGateway.getString(row, 'RefMetadataComponentName')
      );
      addTo(uses, sourceKey, targetKey);
      addTo(usedBy, targetKey, sourceKey);
    }

    // Le navigateur rattache les dépendances aux composants inventoriés (clé de composant)
    Set<String> keys = new Set<String>(uses.keySet());
    keys.addAll(usedBy.keySet());
    for (String key : keys) {
      ctx.setDependencies(
        key,
        new Map<String, Object>{
          'uses' => limited(uses.get(key)),
          'usedBy' => limited(usedBy.get(key))
        }
      );
    }
    ctx.info(
      rows.size() +
        ' dependency links read for ' +
        keys.size() +
        ' components.'
    );
    return null;
  }

  private static List<Map<String, Object>> queryChecked(
    OrgScanContext ctx,
    String filter,
    String label
  ) {
    List<Map<String, Object>> rows = ctx.tooling.query(
      'SELECT MetadataComponentType, MetadataComponentName, RefMetadataComponentType, RefMetadataComponentName ' +
        'FROM MetadataComponentDependency WHERE ' +
        filter
    );
    if (rows.size() >= API_ROW_LIMIT) {
      ctx.warning(
        'Dependencies for ' +
          label +
          ' are truncated: the API returns at most ' +
          API_ROW_LIMIT +
          ' links per query.'
      );
    }
    return rows;
  }

  private static void addTo(
    Map<String, Set<String>> target,
    String key,
    String value
  ) {
    if (!target.containsKey(key)) {
      target.put(key, new Set<String>());
    }
    target.get(key).add(value);
  }

  private static List<String> limited(Set<String> values) {
    List<String> result = values == null
      ? new List<String>()
      : new List<String>(values);
    result.sort();
    while (result.size() > MAX_ITEMS) {
      result.remove(result.size() - 1);
    }
    return result;
  }
}
