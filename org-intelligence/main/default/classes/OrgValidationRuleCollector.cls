/**
 * Collecte des règles de validation non gérées (Tooling API). La formule n'est lisible qu'une règle
 * à la fois (champ Metadata) : 40 règles par page, pour rester sous la limite de 100 callouts.
 * Elle est gardée dans les détails du composant pour la règle « contournement » (étape suivante).
 */
public inherited sharing class OrgValidationRuleCollector implements OrgScanStep {
  @TestVisible
  private static Integer rulesPerPage = 40;

  public String run(OrgScanContext ctx, String cursor) {
    if (!ctx.state.toolingAvailable) {
      ctx.warning(
        'Validation rules not collected: the Tooling API is not available.'
      );
      return null;
    }
    List<Map<String, Object>> rules = ctx.tooling.query(
      'SELECT Id, ValidationName, Active, Description, ErrorMessage, ErrorDisplayField, ' +
        'EntityDefinition.QualifiedApiName, LastModifiedDate, LastModifiedBy.Name ' +
        'FROM ValidationRule WHERE NamespacePrefix = null ORDER BY Id'
    );
    Integer start = cursor == null ? 0 : Integer.valueOf(cursor);
    Integer stop = Math.min(start + rulesPerPage, rules.size());

    List<OrgScanModels.Component> components = new List<OrgScanModels.Component>();
    Integer unreadable = 0;
    for (Integer i = start; i < stop; i++) {
      Map<String, Object> rule = rules[i];
      String objectName = OrgToolingGateway.getString(
        rule,
        'EntityDefinition.QualifiedApiName'
      );
      OrgScanModels.Component component = new OrgScanModels.Component(
        'ValidationRule',
        objectName + '.' + OrgToolingGateway.getString(rule, 'ValidationName')
      );
      component.metadataId = OrgToolingGateway.getString(rule, 'Id');
      component.parentName = objectName;
      component.isActive = rule.get('Active') == true;
      component.description = OrgToolingGateway.getString(rule, 'Description');
      component.lastModifiedByName = OrgToolingGateway.getString(
        rule,
        'LastModifiedBy.Name'
      );
      String modified = OrgToolingGateway.getString(rule, 'LastModifiedDate');
      if (modified != null) {
        component.lastModifiedDate = (Datetime) JSON.deserialize(
          '"' + modified + '"',
          Datetime.class
        );
      }
      component.details.put(
        'errorMessage',
        OrgToolingGateway.getString(rule, 'ErrorMessage')
      );
      component.details.put(
        'errorDisplayField',
        OrgToolingGateway.getString(rule, 'ErrorDisplayField')
      );

      try {
        List<Map<String, Object>> metadata = ctx.tooling.query(
          'SELECT Id, Metadata FROM ValidationRule WHERE Id = \'' +
            String.escapeSingleQuotes(component.metadataId) +
            '\''
        );
        component.source = metadata.isEmpty()
          ? null
          : OrgToolingGateway.getString(
              metadata[0],
              'Metadata.errorConditionFormula'
            );
        component.details.put('formula', component.source?.abbreviate(20000));
      } catch (OrgToolingGateway.ToolingException e) {
        unreadable++;
      }
      components.add(component);
    }
    if (unreadable > 0) {
      ctx.warning(
        unreadable +
        ' validation rule formulas could not be read: their content was not analysed.'
      );
    }
    if (cursor == null) {
      ctx.info(rules.size() + ' unmanaged validation rules found.');
    }

    OrgDataModelRules.evaluateValidationRules(components, ctx);
    ctx.addComponents(components);
    return stop < rules.size() ? String.valueOf(stop) : null;
  }
}
