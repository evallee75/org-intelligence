/**
 * Collecte des objets et champs personnalisés (EntityDefinition / FieldDefinition, sans Tooling API).
 *
 * Inventaire : objets personnalisés non gérés, objets standard portant des champs personnalisés non
 * gérés, et ces champs. Les objets sont parcourus par paquets (curseur = position dans la liste).
 * Le joker « _ » du LIKE SOQL ne permet pas de filtrer « __c » en requête : filtre fait en Apex.
 */
public inherited sharing class OrgObjectFieldCollector implements OrgScanStep {
  @TestVisible
  private static Integer entitiesPerPage = 100;
  private static final Integer ENTITIES_PER_QUERY = 10;
  @TestVisible
  private static Integer fieldQueryLimit = 2000;

  public String run(OrgScanContext ctx, String cursor) {
    List<EntityDefinition> entities = [
      SELECT
        QualifiedApiName,
        Label,
        NamespacePrefix,
        DurableId,
        KeyPrefix,
        IsCustomSetting,
        LastModifiedDate,
        LastModifiedBy.Name
      FROM EntityDefinition
      WHERE IsCustomizable = TRUE
      WITH USER_MODE
      ORDER BY QualifiedApiName
    ];
    Integer start = cursor == null ? 0 : Integer.valueOf(cursor);
    Integer stop = Math.min(start + entitiesPerPage, entities.size());

    Map<String, EntityDefinition> pageById = new Map<String, EntityDefinition>();
    for (Integer i = start; i < stop; i++) {
      pageById.put(entities[i].DurableId, entities[i]);
    }

    buildInventory(
      pageById,
      loadFields(new List<String>(pageById.keySet())),
      ctx
    );
    return stop < entities.size() ? String.valueOf(stop) : null;
  }

  /** Composants (objets, champs) et règles du modèle de données pour une page d'objets. */
  @TestVisible
  private static void buildInventory(
    Map<String, EntityDefinition> pageById,
    List<FieldDefinition> fields,
    OrgScanContext ctx
  ) {
    Map<String, List<OrgScanModels.Component>> fieldsByObject = new Map<String, List<OrgScanModels.Component>>();
    Map<String, Integer> customFieldCounts = new Map<String, Integer>();
    for (FieldDefinition field : fields) {
      if (!field.QualifiedApiName.endsWith('__c')) {
        continue;
      }
      String objectName = pageById.get(field.EntityDefinitionId)
        .QualifiedApiName;
      customFieldCounts.put(
        objectName,
        (customFieldCounts.containsKey(objectName)
          ? customFieldCounts.get(objectName)
          : 0) + 1
      );
      if (field.NamespacePrefix != null) {
        continue;
      }
      OrgScanModels.Component component = new OrgScanModels.Component(
        'CustomField',
        objectName + '.' + field.QualifiedApiName
      );
      component.parentName = objectName;
      component.description = field.Description;
      component.lastModifiedDate = field.LastModifiedDate;
      component.lastModifiedByName = field.LastModifiedBy?.Name;
      component.details.put('label', field.Label);
      component.details.put('dataType', field.DataType);
      if (!fieldsByObject.containsKey(objectName)) {
        fieldsByObject.put(objectName, new List<OrgScanModels.Component>());
      }
      fieldsByObject.get(objectName).add(component);
    }

    List<OrgScanModels.Component> components = new List<OrgScanModels.Component>();
    for (EntityDefinition entity : pageById.values()) {
      Boolean isCustom =
        entity.QualifiedApiName.endsWith('__c') &&
        entity.NamespacePrefix == null;
      if (!isCustom && !fieldsByObject.containsKey(entity.QualifiedApiName)) {
        continue;
      }
      OrgScanModels.Component component = new OrgScanModels.Component(
        'CustomObject',
        entity.QualifiedApiName
      );
      component.metadataId = entity.DurableId.left(18);
      component.namespacePrefix = entity.NamespacePrefix;
      component.lastModifiedDate = entity.LastModifiedDate;
      component.lastModifiedByName = entity.LastModifiedBy?.Name;
      component.details.put('label', entity.Label);
      component.details.put('isCustom', isCustom);
      component.details.put('isCustomSetting', entity.IsCustomSetting);
      component.details.put('keyPrefix', entity.KeyPrefix);
      component.details.put(
        'customFieldCount',
        customFieldCounts.containsKey(entity.QualifiedApiName)
          ? customFieldCounts.get(entity.QualifiedApiName)
          : 0
      );
      components.add(component);
      if (fieldsByObject.containsKey(entity.QualifiedApiName)) {
        components.addAll(fieldsByObject.get(entity.QualifiedApiName));
      }
    }

    OrgDataModelRules.evaluateObjects(fieldsByObject, customFieldCounts, ctx);
    ctx.addComponents(components);
  }

  /**
   * FieldDefinition ne supporte pas queryMore : chaque requête doit tenir en un seul lot de
   * fieldQueryLimit lignes. Un paquet d'objets qui l'atteint est relu objet par objet.
   */
  private static List<FieldDefinition> loadFields(List<String> entityIds) {
    List<FieldDefinition> result = new List<FieldDefinition>();
    for (Integer i = 0; i < entityIds.size(); i += ENTITIES_PER_QUERY) {
      List<String> chunk = new List<String>();
      for (
        Integer j = i;
        j < Math.min(i + ENTITIES_PER_QUERY, entityIds.size());
        j++
      ) {
        chunk.add(entityIds[j]);
      }
      List<FieldDefinition> fields = queryFields(chunk);
      if (fields.size() < fieldQueryLimit) {
        result.addAll(fields);
        continue;
      }
      for (String entityId : chunk) {
        result.addAll(queryFields(new List<String>{ entityId }));
      }
    }
    return result;
  }

  private static List<FieldDefinition> queryFields(List<String> entityIds) {
    Integer size = fieldQueryLimit;
    return [
      SELECT
        QualifiedApiName,
        EntityDefinitionId,
        Label,
        Description,
        DataType,
        NamespacePrefix,
        LastModifiedDate,
        LastModifiedBy.Name
      FROM FieldDefinition
      WHERE EntityDefinitionId IN :entityIds
      WITH USER_MODE
      LIMIT :size
    ];
  }
}
