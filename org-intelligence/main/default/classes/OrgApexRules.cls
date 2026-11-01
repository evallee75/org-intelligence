/**
 * Règles sur le code Apex (classes et triggers). Chaque règle est explicable : le constat cite les
 * lignes ou valeurs qui l'ont déclenché.
 */
public inherited sharing class OrgApexRules {
  @TestVisible
  private static final Integer MAX_EVIDENCE_ITEMS = 15;

  /** Règles évaluées sur le source des classes (composants avec `source` renseigné). */
  public static void evaluateClasses(
    List<OrgScanModels.Component> classes,
    OrgScanContext ctx
  ) {
    Boolean hardcodedIds = ctx.beginRule('APEX_HARDCODED_ID');
    Boolean loops = ctx.beginRule('APEX_SOQL_DML_IN_LOOP');
    Boolean sharing = ctx.beginRule('APEX_ENTRY_WITHOUT_SHARING');
    Boolean apiVersion = ctx.beginRule('APEX_OLD_API_VERSION');
    Boolean asserts = ctx.beginRule('APEX_TEST_WITHOUT_ASSERT');
    Decimal maxLag = ctx.threshold('APEX_OLD_API_VERSION', 10);

    for (OrgScanModels.Component component : classes) {
      if (component.source == null) {
        continue;
      }
      OrgApexSourceAnalyzer analyzer = new OrgApexSourceAnalyzer(
        component.source
      );
      Boolean isTest = analyzer.isTestClass();
      component.details.put('isTest', isTest);
      component.details.put('codeLines', analyzer.codeLineCount());

      if (hardcodedIds) {
        addHardcodedIdFinding('APEX_HARDCODED_ID', component, analyzer, ctx);
      }
      if (loops && !isTest) {
        addLoopFinding(component, analyzer, ctx);
      }
      if (sharing && !isTest) {
        addSharingFinding(component, analyzer, ctx);
      }
      if (apiVersion) {
        addApiVersionFinding('APEX_OLD_API_VERSION', component, maxLag, ctx);
      }
      if (
        asserts &&
        isTest &&
        analyzer.hasTestMethods() &&
        !analyzer.hasAssertions()
      ) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'APEX_TEST_WITHOUT_ASSERT',
          component,
          'Test class ' + component.apiName + ' has no assertion'
        );
        finding.evidence = 'Test methods found, but no call to System.assert*, Assert.* in the class.';
        ctx.addFinding(finding);
      }
    }
  }

  public static void addHardcodedIdFinding(
    String ruleCode,
    OrgScanModels.Component component,
    OrgApexSourceAnalyzer analyzer,
    OrgScanContext ctx
  ) {
    List<OrgApexSourceAnalyzer.Literal> ids = analyzer.hardcodedIds();
    if (ids.isEmpty()) {
      return;
    }
    List<String> lines = new List<String>();
    for (OrgApexSourceAnalyzer.Literal literal : ids) {
      if (lines.size() == MAX_EVIDENCE_ITEMS) {
        lines.add('… and ' + (ids.size() - MAX_EVIDENCE_ITEMS) + ' more');
        break;
      }
      lines.add('Line ' + literal.line + ': \'' + literal.value + '\'');
    }
    OrgScanModels.Finding finding = ctx.newFinding(
      ruleCode,
      component,
      ids.size() == 1
        ? 'Hardcoded record Id in ' + component.apiName
        : ids.size() + ' hardcoded record Ids in ' + component.apiName
    );
    finding.evidence = String.join(lines, '\n');
    ctx.addFinding(finding);
  }

  private static void addLoopFinding(
    OrgScanModels.Component component,
    OrgApexSourceAnalyzer analyzer,
    OrgScanContext ctx
  ) {
    List<OrgApexSourceAnalyzer.LoopHit> hits = analyzer.queriesOrDmlInLoops();
    if (hits.isEmpty()) {
      return;
    }
    List<String> lines = new List<String>();
    for (OrgApexSourceAnalyzer.LoopHit hit : hits) {
      if (lines.size() == MAX_EVIDENCE_ITEMS) {
        lines.add('… and ' + (hits.size() - MAX_EVIDENCE_ITEMS) + ' more');
        break;
      }
      lines.add(
        'Line ' +
          hit.line +
          ': ' +
          hit.kind +
          ' inside the loop starting line ' +
          hit.loopLine
      );
    }
    OrgScanModels.Finding finding = ctx.newFinding(
      'APEX_SOQL_DML_IN_LOOP',
      component,
      'Query or DML inside a loop in ' + component.apiName
    );
    finding.evidence = String.join(lines, '\n');
    ctx.addFinding(finding);
  }

  private static void addSharingFinding(
    OrgScanModels.Component component,
    OrgApexSourceAnalyzer analyzer,
    OrgScanContext ctx
  ) {
    List<String> markers = analyzer.entryPointMarkers();
    if (markers.isEmpty() || analyzer.sharingDeclaration() != 'without') {
      return;
    }
    OrgScanModels.Finding finding = ctx.newFinding(
      'APEX_ENTRY_WITHOUT_SHARING',
      component,
      component.apiName +
        ' is exposed (' +
        String.join(markers, ', ') +
        ') and declared without sharing'
    );
    finding.evidence =
      'Class declaration: without sharing. Entry point markers found: ' +
      String.join(markers, ', ') +
      '.';
    ctx.addFinding(finding);
  }

  public static void addApiVersionFinding(
    String ruleCode,
    OrgScanModels.Component component,
    Decimal maxLag,
    OrgScanContext ctx
  ) {
    Decimal reference = ctx.state.referenceApiVersion;
    if (component.apiVersion == null || reference == null) {
      return;
    }
    Decimal lag = reference - component.apiVersion;
    if (lag <= maxLag) {
      return;
    }
    OrgScanModels.Finding finding = ctx.newFinding(
      ruleCode,
      component,
      component.apiName +
        ' uses API version ' +
        component.apiVersion.stripTrailingZeros().toPlainString()
    );
    finding.evidence =
      'API version ' +
      component.apiVersion.stripTrailingZeros().toPlainString() +
      ', ' +
      lag.stripTrailingZeros().toPlainString() +
      ' versions behind ' +
      reference.stripTrailingZeros().toPlainString() +
      ' (most recent version used in this org). Threshold: ' +
      maxLag.stripTrailingZeros().toPlainString() +
      ' versions.';
    ctx.addFinding(finding);
  }

  /** Couverture par classe (Tooling ApexCodeCoverageAggregate), classes de test exclues. */
  public static void evaluateCoverage(
    Map<String, Decimal> coverageByClass,
    Map<String, Boolean> isTestByClass,
    OrgScanContext ctx
  ) {
    if (!ctx.beginRule('APEX_LOW_COVERAGE')) {
      return;
    }
    Decimal threshold = ctx.threshold('APEX_LOW_COVERAGE', 75);
    for (String className : coverageByClass.keySet()) {
      Decimal percent = coverageByClass.get(className);
      if (isTestByClass.get(className) == true || percent >= threshold) {
        continue;
      }
      OrgScanModels.Finding finding = ctx.newFinding(
        'APEX_LOW_COVERAGE',
        'ApexClass',
        className,
        className +
          ' is covered at ' +
          percent.setScale(0).toPlainString() +
          '%'
      );
      finding.evidence =
        'Latest measured coverage: ' +
        percent.setScale(1).toPlainString() +
        '% (threshold ' +
        threshold.stripTrailingZeros().toPlainString() +
        '%). Coverage reflects the last test runs in this org.';
      ctx.addFinding(finding);
    }
  }
}
