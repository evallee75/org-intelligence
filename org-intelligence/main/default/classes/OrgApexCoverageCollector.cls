/**
 * Couverture de code par classe (Tooling ApexCodeCoverageAggregate). Reflète les derniers tests
 * exécutés dans l'org : le journal le rappelle.
 */
public inherited sharing class OrgApexCoverageCollector implements OrgScanStep {
  public String run(OrgScanContext ctx, String cursor) {
    if (!ctx.state.toolingAvailable) {
      ctx.warning(
        'Code coverage not collected: the Tooling API is not available.'
      );
      return null;
    }
    if (!ctx.state.isStepSuccessful(OrgScanState.STEP_APEX_CLASSES)) {
      ctx.warning('Code coverage skipped: the Apex class inventory failed.');
      return null;
    }

    List<Map<String, Object>> rows = ctx.tooling.query(
      'SELECT ApexClassOrTrigger.Name, ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate'
    );

    // Classes inventoriées par ce scan (non gérées) et leur nature de test, renvoyées par le navigateur
    Map<String, Boolean> isTestByClass = new Map<String, Boolean>();
    for (OrgScanModels.Component component : ctx.inventoryOf('ApexClass')) {
      isTestByClass.put(
        component.apiName,
        component.details?.get('isTest') == true
      );
    }

    Map<String, Decimal> coverageByClass = new Map<String, Decimal>();
    Integer covered = 0;
    Integer total = 0;
    for (Map<String, Object> row : rows) {
      String id = OrgToolingGateway.getString(row, 'ApexClassOrTriggerId');
      String name = OrgToolingGateway.getString(row, 'ApexClassOrTrigger.Name');
      Integer linesCovered = toInteger(row.get('NumLinesCovered'));
      Integer lines = linesCovered + toInteger(row.get('NumLinesUncovered'));
      if (
        id == null ||
        !id.startsWith('01p') ||
        !isTestByClass.containsKey(name) ||
        lines == 0
      ) {
        continue;
      }
      coverageByClass.put(name, 100.0 * linesCovered / lines);
      covered += linesCovered;
      total += lines;
    }

    if (coverageByClass.isEmpty()) {
      ctx.warning(
        'No code coverage data found: run all Apex tests in the org, then scan again.'
      );
      return null;
    }
    ctx.info(
      'Coverage measured for ' +
        coverageByClass.size() +
        ' classes, ' +
        (100.0 * covered / total).setScale(1).toPlainString() +
        '% of their lines overall (latest test runs in this org).'
    );
    OrgApexRules.evaluateCoverage(coverageByClass, isTestByClass, ctx);
    return null;
  }

  private static Integer toInteger(Object value) {
    return value == null ? 0 : Integer.valueOf(value);
  }
}
