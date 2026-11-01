/**
 * Collecte des triggers Apex non gérés (code compris).
 */
public inherited sharing class OrgApexTriggerCollector implements OrgScanStep {
  public String run(OrgScanContext ctx, String cursor) {
    List<OrgScanModels.Component> components = new List<OrgScanModels.Component>();
    for (ApexTrigger record : [
      SELECT
        Id,
        Name,
        TableEnumOrId,
        Status,
        ApiVersion,
        Body,
        LastModifiedDate,
        LastModifiedBy.Name,
        UsageBeforeInsert,
        UsageAfterInsert,
        UsageBeforeUpdate,
        UsageAfterUpdate,
        UsageBeforeDelete,
        UsageAfterDelete,
        UsageAfterUndelete
      FROM ApexTrigger
      WHERE NamespacePrefix = NULL
      WITH USER_MODE
      ORDER BY TableEnumOrId, Name
      LIMIT 2000
    ]) {
      OrgScanModels.Component component = new OrgScanModels.Component(
        'ApexTrigger',
        record.Name
      );
      component.metadataId = record.Id;
      component.parentName = record.TableEnumOrId;
      component.apiVersion = record.ApiVersion;
      component.isActive = record.Status == 'Active';
      component.lastModifiedDate = record.LastModifiedDate;
      component.lastModifiedByName = record.LastModifiedBy?.Name;
      component.details.put('events', events(record));
      component.source = record.Body;
      components.add(component);
    }
    OrgAutomationRules.evaluateTriggers(components, ctx);
    ctx.addComponents(components);
    return null;
  }

  private static List<String> events(ApexTrigger record) {
    List<String> result = new List<String>();
    if (record.UsageBeforeInsert)
      result.add('before insert');
    if (record.UsageBeforeUpdate)
      result.add('before update');
    if (record.UsageBeforeDelete)
      result.add('before delete');
    if (record.UsageAfterInsert)
      result.add('after insert');
    if (record.UsageAfterUpdate)
      result.add('after update');
    if (record.UsageAfterDelete)
      result.add('after delete');
    if (record.UsageAfterUndelete)
      result.add('after undelete');
    return result;
  }
}
