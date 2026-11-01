/**
 * Collecte des flows et Process Builder non gérés, avec leurs versions (FlowVersionView).
 */
public inherited sharing class OrgFlowCollector implements OrgScanStep {
  private static final Integer VERSION_QUERY_CHUNK = 200;

  public String run(OrgScanContext ctx, String cursor) {
    List<FlowDefinitionView> definitions = [
      SELECT
        DurableId,
        ApiName,
        Label,
        ProcessType,
        TriggerType,
        RecordTriggerType,
        TriggerObjectOrEventId,
        IsActive,
        ActiveVersionId,
        LatestVersionId,
        Description,
        LastModifiedDate,
        LastModifiedBy
      FROM FlowDefinitionView
      WHERE NamespacePrefix = NULL
      WITH USER_MODE
      ORDER BY ApiName
      LIMIT 2000
    ];

    Map<String, List<FlowVersionView>> versionsByFlow = loadVersions(
      definitions
    );

    List<OrgScanModels.Component> components = buildComponents(
      definitions,
      versionsByFlow
    );
    OrgAutomationRules.evaluateFlows(components, ctx);
    ctx.addComponents(components);
    return null;
  }

  /** Composants Flow construits depuis les définitions et leurs versions. */
  @TestVisible
  private static List<OrgScanModels.Component> buildComponents(
    List<FlowDefinitionView> definitions,
    Map<String, List<FlowVersionView>> versionsByFlow
  ) {
    List<OrgScanModels.Component> components = new List<OrgScanModels.Component>();
    for (FlowDefinitionView definition : definitions) {
      OrgScanModels.Component component = new OrgScanModels.Component(
        'Flow',
        definition.ApiName
      );
      component.metadataId = definition.DurableId;
      component.parentName = definition.TriggerObjectOrEventId;
      component.isActive = definition.IsActive;
      component.description = definition.Description;
      component.lastModifiedDate = definition.LastModifiedDate;
      component.lastModifiedByName = definition.LastModifiedBy;
      component.details.put('label', definition.Label);
      component.details.put('activeVersionId', definition.ActiveVersionId);
      component.details.put('latestVersionId', definition.LatestVersionId);
      component.details.put('processType', definition.ProcessType);
      component.details.put('triggerType', definition.TriggerType);
      component.details.put('recordTriggerType', definition.RecordTriggerType);

      List<FlowVersionView> versions = versionsByFlow.get(definition.DurableId);
      if (versions != null) {
        component.details.put('versionCount', versions.size());
        component.apiVersion = currentApiVersion(versions);
      }
      components.add(component);
    }
    return components;
  }

  /** FlowVersionView exige un filtre sur FlowDefinitionViewId : requêtes par paquets. */
  @TestVisible
  private static Map<String, List<FlowVersionView>> loadVersions(
    List<FlowDefinitionView> definitions
  ) {
    Map<String, List<FlowVersionView>> result = new Map<String, List<FlowVersionView>>();
    List<String> ids = new List<String>();
    for (Integer i = 0; i < definitions.size(); i++) {
      ids.add(definitions[i].DurableId);
      if (ids.size() == VERSION_QUERY_CHUNK || i == definitions.size() - 1) {
        for (FlowVersionView version : [
          SELECT FlowDefinitionViewId, VersionNumber, Status, ApiVersion
          FROM FlowVersionView
          WHERE FlowDefinitionViewId IN :ids
          WITH USER_MODE
        ]) {
          addVersion(result, version);
        }
        ids.clear();
      }
    }
    return result;
  }

  @TestVisible
  private static void addVersion(
    Map<String, List<FlowVersionView>> result,
    FlowVersionView version
  ) {
    if (!result.containsKey(version.FlowDefinitionViewId)) {
      result.put(version.FlowDefinitionViewId, new List<FlowVersionView>());
    }
    result.get(version.FlowDefinitionViewId).add(version);
  }

  /** Version d'API de la version active, à défaut de la plus récente. */
  private static Decimal currentApiVersion(List<FlowVersionView> versions) {
    FlowVersionView latest;
    for (FlowVersionView version : versions) {
      if (version.Status == 'Active') {
        return version.ApiVersion;
      }
      if (latest == null || version.VersionNumber > latest.VersionNumber) {
        latest = version;
      }
    }
    return latest?.ApiVersion;
  }
}
