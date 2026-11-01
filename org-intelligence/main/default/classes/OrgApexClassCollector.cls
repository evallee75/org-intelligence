/**
 * Collecte des classes Apex non gérées (code compris), par pages de 50 pour borner la mémoire.
 */
public inherited sharing class OrgApexClassCollector implements OrgScanStep {
  @TestVisible
  private static Integer pageSize = 50;

  public String run(OrgScanContext ctx, String cursor) {
    Integer size = pageSize;
    List<ApexClass> classes = cursor == null
      ? [
          SELECT
            Id,
            Name,
            ApiVersion,
            Status,
            Body,
            LengthWithoutComments,
            LastModifiedDate,
            LastModifiedBy.Name
          FROM ApexClass
          WHERE NamespacePrefix = NULL
          WITH USER_MODE
          ORDER BY Id
          LIMIT :size
        ]
      : [
          SELECT
            Id,
            Name,
            ApiVersion,
            Status,
            Body,
            LengthWithoutComments,
            LastModifiedDate,
            LastModifiedBy.Name
          FROM ApexClass
          WHERE NamespacePrefix = NULL AND Id > :cursor
          WITH USER_MODE
          ORDER BY Id
          LIMIT :size
        ];

    List<OrgScanModels.Component> components = new List<OrgScanModels.Component>();
    for (ApexClass record : classes) {
      OrgScanModels.Component component = new OrgScanModels.Component(
        'ApexClass',
        record.Name
      );
      component.metadataId = record.Id;
      component.apiVersion = record.ApiVersion;
      component.isActive = record.Status == 'Active';
      component.lastModifiedDate = record.LastModifiedDate;
      component.lastModifiedByName = record.LastModifiedBy?.Name;
      component.details.put('status', record.Status);
      component.details.put('length', record.LengthWithoutComments);
      component.source = record.Body;
      components.add(component);
    }
    OrgApexRules.evaluateClasses(components, ctx);
    ctx.addComponents(components);

    if (cursor == null && classes.isEmpty()) {
      ctx.info('No unmanaged Apex class found.');
    }
    return classes.size() == size ? classes[classes.size() - 1].Id : null;
  }
}
