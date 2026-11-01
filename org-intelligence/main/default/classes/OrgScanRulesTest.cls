/**
 * Règles du scanner sur des composants construits à la main : chaque règle doit produire un constat
 * explicable quand ses conditions sont réunies, et rien sinon.
 */
@IsTest
private class OrgScanRulesTest {
  private static OrgScanContext newContext() {
    OrgScanState state = new OrgScanState();
    state.steps = new List<String>{ OrgScanState.STEP_CROSS_RULES };
    state.referenceApiVersion = 66;
    return new OrgScanContext(state);
  }

  private static OrgScanModels.Component component(
    String type,
    String name,
    String source
  ) {
    OrgScanModels.Component result = new OrgScanModels.Component(type, name);
    result.source = source;
    return result;
  }

  private static Map<String, List<OrgScanModels.Finding>> byRule(
    OrgScanContext ctx
  ) {
    Map<String, List<OrgScanModels.Finding>> result = new Map<String, List<OrgScanModels.Finding>>();
    for (OrgScanModels.Finding finding : ctx.pendingFindings) {
      if (!result.containsKey(finding.ruleCode)) {
        result.put(finding.ruleCode, new List<OrgScanModels.Finding>());
      }
      result.get(finding.ruleCode).add(finding);
    }
    return result;
  }

  @IsTest
  static void apexClassRules() {
    OrgScanContext ctx = newContext();
    String realId = String.valueOf(UserInfo.getUserId());
    OrgScanModels.Component risky = component(
      'ApexClass',
      'RiskyController',
      'public without sharing class RiskyController {\n' +
        ' @AuraEnabled public static void go(List<Account> rows) {\n' +
        '  for (Account a : rows) { update a; }\n' +
        '  Id owner = \'' +
        realId +
        '\';\n' +
        ' }\n}'
    );
    risky.apiVersion = 48;
    OrgScanModels.Component clean = component(
      'ApexClass',
      'CleanService',
      'public with sharing class CleanService { public static void go() {} }'
    );
    clean.apiVersion = 66;
    OrgScanModels.Component weakTest = component(
      'ApexClass',
      'WeakTest',
      '@IsTest private class WeakTest { @IsTest static void a() { CleanService.go(); } }'
    );
    weakTest.apiVersion = 66;

    OrgApexRules.evaluateClasses(
      new List<OrgScanModels.Component>{ risky, clean, weakTest },
      ctx
    );
    Map<String, List<OrgScanModels.Finding>> findings = byRule(ctx);

    Assert.areEqual(
      'RiskyController',
      findings.get('APEX_ENTRY_WITHOUT_SHARING')[0].componentName
    );
    Assert.areEqual(1, findings.get('APEX_SOQL_DML_IN_LOOP').size());
    Assert.isTrue(
      findings.get('APEX_HARDCODED_ID')[0].evidence.contains(realId)
    );
    Assert.isTrue(
      findings.get('APEX_OLD_API_VERSION')[0]
        .evidence.contains('18 versions behind')
    );
    Assert.areEqual(
      'WeakTest',
      findings.get('APEX_TEST_WITHOUT_ASSERT')[0].componentName
    );
    for (OrgScanModels.Finding finding : ctx.pendingFindings) {
      Assert.areNotEqual(
        'CleanService',
        finding.componentName,
        'A clean class produces no finding'
      );
      Assert.isNotNull(finding.description, 'The rule description is attached');
    }
    Assert.isTrue(ctx.state.evaluatedRules.contains('APEX_SOQL_DML_IN_LOOP'));
    Assert.areEqual(true, weakTest.details.get('isTest'));
  }

  @IsTest
  static void coverageRuleIgnoresTestClassesAndWellCoveredOnes() {
    OrgScanContext ctx = newContext();
    OrgApexRules.evaluateCoverage(
      new Map<String, Decimal>{ 'Low' => 40, 'High' => 90, 'SomeTest' => 0 },
      new Map<String, Boolean>{
        'Low' => false,
        'High' => false,
        'SomeTest' => true
      },
      ctx
    );
    Assert.areEqual(1, ctx.pendingFindings.size());
    Assert.areEqual('Low', ctx.pendingFindings[0].componentName);
    Assert.isTrue(ctx.pendingFindings[0].title.contains('40%'));
  }

  @IsTest
  static void triggerRules() {
    OrgScanContext ctx = newContext();
    List<String> lines = new List<String>();
    for (Integer i = 0; i < 30; i++) {
      lines.add('  if (x == ' + i + ') { y = ' + i + '; }');
    }
    OrgScanModels.Component fat = component(
      'ApexTrigger',
      'FatTrigger',
      'trigger FatTrigger on Contact (before insert) {\n' +
        String.join(lines, '\n') +
        '\n}'
    );
    fat.parentName = 'Contact';
    OrgScanModels.Component thin = component(
      'ApexTrigger',
      'ThinTrigger',
      'trigger ThinTrigger on Contact (after update) { Handler.run(); }'
    );
    thin.parentName = 'Contact';
    OrgScanModels.Component off = component(
      'ApexTrigger',
      'OldTrigger',
      'trigger OldTrigger on Account (before insert) {}'
    );
    off.parentName = 'Account';
    off.isActive = false;

    OrgAutomationRules.evaluateTriggers(
      new List<OrgScanModels.Component>{ fat, thin, off },
      ctx
    );
    Map<String, List<OrgScanModels.Finding>> findings = byRule(ctx);

    OrgScanModels.Finding multiple = findings.get(
      'TRIGGER_MULTIPLE_PER_OBJECT'
    )[0];
    Assert.areEqual('Contact', multiple.componentName);
    Assert.areEqual(
      new List<String>{ 'FatTrigger', 'ThinTrigger' },
      multiple.affectedComponents
    );
    Assert.areEqual(
      'FatTrigger',
      findings.get('TRIGGER_LOGIC_IN_BODY')[0].componentName
    );
    Assert.areEqual(
      'OldTrigger',
      findings.get('TRIGGER_INACTIVE')[0].componentName
    );
    Assert.isFalse(findings.containsKey('TRIGGER_HARDCODED_ID'));
  }

  @IsTest
  static void flowRules() {
    OrgScanContext ctx = newContext();
    OrgScanModels.Component process = new OrgScanModels.Component(
      'Flow',
      'PB_Account'
    );
    process.details.put('processType', 'Workflow');
    process.apiVersion = 66;
    OrgScanModels.Component stale = new OrgScanModels.Component(
      'Flow',
      'Old_Flow'
    );
    stale.isActive = false;
    stale.lastModifiedDate = Datetime.now().addDays(-400);
    OrgScanModels.Component crowded = new OrgScanModels.Component(
      'Flow',
      'Crowded_Flow'
    );
    crowded.apiVersion = 50;
    crowded.details.put('versionCount', 35);

    OrgAutomationRules.evaluateFlows(
      new List<OrgScanModels.Component>{ process, stale, crowded },
      ctx
    );
    Map<String, List<OrgScanModels.Finding>> findings = byRule(ctx);

    Assert.areEqual(
      'PB_Account',
      findings.get('FLOW_PROCESS_BUILDER_ACTIVE')[0].componentName
    );
    Assert.areEqual(
      'Old_Flow',
      findings.get('FLOW_INACTIVE_STALE')[0].componentName
    );
    Assert.areEqual(
      'Crowded_Flow',
      findings.get('FLOW_OLD_API_VERSION')[0].componentName
    );
    Assert.areEqual(
      'Crowded_Flow',
      findings.get('FLOW_TOO_MANY_VERSIONS')[0].componentName
    );
  }

  @IsTest
  static void dataModelRules() {
    OrgScanContext ctx = newContext();
    OrgScanModels.Component documented = new OrgScanModels.Component(
      'CustomField',
      'Account.Documented__c'
    );
    documented.description = 'Purpose';
    OrgScanModels.Component bare = new OrgScanModels.Component(
      'CustomField',
      'Account.Bare__c'
    );

    OrgDataModelRules.evaluateObjects(
      new Map<String, List<OrgScanModels.Component>>{
        'Account' => new List<OrgScanModels.Component>{ documented, bare }
      },
      new Map<String, Integer>{ 'Account' => 450, 'Contact' => 20 },
      ctx
    );
    Map<String, List<OrgScanModels.Finding>> findings = byRule(ctx);
    OrgScanModels.Finding missing = findings.get(
      'FIELD_MISSING_DESCRIPTION'
    )[0];
    Assert.isTrue(missing.title.startsWith('1 of 2'));
    Assert.areEqual(
      new List<String>{ 'Account.Bare__c' },
      missing.affectedComponents
    );
    Assert.areEqual(1, findings.get('OBJECT_FIELDS_NEAR_LIMIT').size());
    Assert.areEqual(
      'Account',
      findings.get('OBJECT_FIELDS_NEAR_LIMIT')[0].componentName
    );
  }

  @IsTest
  static void validationRuleRules() {
    OrgScanContext ctx = newContext();
    String realId = String.valueOf(UserInfo.getUserId());
    OrgScanModels.Component hardcoded = component(
      'ValidationRule',
      'Account.Owner_Check',
      'AND(ISCHANGED(Name), OwnerId <> "' + realId + '")'
    );
    hardcoded.parentName = 'Account';
    OrgScanModels.Component bypassed = component(
      'ValidationRule',
      'Account.Bypassed',
      'AND(NOT($Permission.Bypass_VR), ISBLANK(Name))'
    );
    bypassed.parentName = 'Account';
    OrgScanModels.Component inactive = component(
      'ValidationRule',
      'Account.Old',
      'TRUE'
    );
    inactive.parentName = 'Account';
    inactive.isActive = false;
    List<OrgScanModels.Component> rules = new List<OrgScanModels.Component>{
      hardcoded,
      bypassed,
      inactive
    };

    OrgDataModelRules.evaluateValidationRules(rules, ctx);
    OrgDataModelRules.evaluateBypass(rules, ctx);
    Map<String, List<OrgScanModels.Finding>> findings = byRule(ctx);

    Assert.areEqual(
      'Account.Owner_Check',
      findings.get('VR_HARDCODED_ID')[0].componentName
    );
    Assert.areEqual(
      'Account.Old',
      findings.get('VR_INACTIVE')[0].componentName
    );
    OrgScanModels.Finding bypass = findings.get('VR_WITHOUT_BYPASS')[0];
    Assert.isTrue(
      bypass.title.startsWith('1 of 2 active validation rules on Account')
    );
    Assert.areEqual(
      new List<String>{ 'Account.Owner_Check' },
      bypass.affectedComponents
    );
  }

  @IsTest
  static void disabledRulesAreNotEvaluated() {
    OrgScanContext ctx = newContext();
    Assert.isFalse(
      ctx.beginRule('UNKNOWN_RULE'),
      'A rule missing from the catalog is skipped'
    );
    Assert.isFalse(ctx.state.evaluatedRules.contains('UNKNOWN_RULE'));
    Assert.areEqual(7, ctx.threshold('UNKNOWN_RULE', 7), 'Fallback threshold');
  }
}
