@IsTest
private class OrgIntelSettingsTest {
  @IsTest
  static void defaultsWithoutCustomSetting() {
    OrgIntelSettings__c settings = OrgIntelSettings.getOrgDefaults();

    Assert.isNull(settings.Id, 'Effective values only, nothing stored');
    Assert.isTrue(OrgIntelSettings.apiLogRetentionDays() > 0);
    Assert.isNotNull(OrgIntelSettings.toolingNamedCredential());
    Assert.isNotNull(OrgIntelSettings.jiraIssueType());
    Assert.isNotNull(settings.ScorePreset__c);
    for (String severity : OrgHealthScore.PRESETS.get('Balanced').keySet()) {
      Assert.isNotNull(settings.get(OrgIntelSettings.pointsField(severity)));
      Assert.isNotNull(settings.get(OrgIntelSettings.capField(severity)));
    }
    Assert.isNotNull(OrgIntelSettings.logApiPayloads());
  }

  @IsTest
  static void ensureOrgDefaultsIsIdempotent() {
    Assert.isTrue(OrgIntelSettings.ensureOrgDefaults());
    Assert.isFalse(OrgIntelSettings.ensureOrgDefaults());
    Assert.isNotNull(OrgIntelSettings__c.getOrgDefaults().Id);
    Assert.areEqual(1, [SELECT COUNT() FROM OrgIntelSettings__c]);
  }

  @IsTest
  static void storedValuesWinAndBlanksAreCompleted() {
    insert new OrgIntelSettings__c(
      SetupOwnerId = UserInfo.getOrganizationId(),
      ApiLogRetentionDays__c = 12,
      LogApiPayloads__c = false,
      JiraProjectKey__c = 'OPS',
      ToolingNamedCredential__c = 'MyTooling',
      ScorePointsCritical__c = 42
    );
    OrgIntelSettings.resetCache();

    Assert.areEqual(12, OrgIntelSettings.apiLogRetentionDays());
    Assert.isFalse(OrgIntelSettings.logApiPayloads());
    Assert.areEqual('OPS', OrgIntelSettings.jiraProjectKey());
    Assert.areEqual('MyTooling', OrgIntelSettings.toolingNamedCredential());
    Assert.areEqual(
      OrgIntelSettings.DEFAULT_JIRA_ISSUE_TYPE,
      OrgIntelSettings.jiraIssueType(),
      'Blank field completed by the product default'
    );
    Assert.areEqual(
      42,
      OrgIntelSettings.getOrgDefaults().ScorePointsCritical__c
    );
    Assert.areEqual(
      OrgHealthScore.PRESETS.get('Balanced').get('High')[0],
      OrgIntelSettings.getOrgDefaults().ScorePointsHigh__c
    );
  }

  @IsTest
  static void saveCreatesThenUpdatesTheOrgRecord() {
    OrgIntelSettings.save(
      new Map<String, Object>{ 'ApiLogRetentionDays__c' => 7 }
    );
    OrgIntelSettings.save(
      new Map<String, Object>{ 'JiraProjectKey__c' => 'ABC' }
    );

    OrgIntelSettings__c stored = OrgIntelSettings__c.getOrgDefaults();
    Assert.areEqual(7, stored.ApiLogRetentionDays__c);
    Assert.areEqual('ABC', stored.JiraProjectKey__c);
    Assert.areEqual(1, [SELECT COUNT() FROM OrgIntelSettings__c]);
  }

  @IsTest
  static void ruleOverrideIsMergedThenRemovedWhenBackToCatalog() {
    OrgScanRule__mdt catalog = anyRule();
    String code = catalog.DeveloperName;
    String otherSeverity = catalog.Severity__c == 'Info' ? 'Critical' : 'Info';

    OrgScanRule__mdt merged = OrgIntelSettings.saveRuleOverride(
      code,
      !catalog.IsEnabled__c,
      otherSeverity,
      99
    );

    Assert.areEqual(!catalog.IsEnabled__c, merged.IsEnabled__c);
    Assert.areEqual(otherSeverity, merged.Severity__c);
    Assert.areEqual(99, merged.Threshold__c);
    Assert.isTrue(OrgIntelSettings.isOverridden(code));
    Assert.areEqual(
      otherSeverity,
      OrgIntelSettings.rules().get(code).Severity__c
    );
    Assert.areEqual(
      catalog.Rationale__c,
      OrgIntelSettings.rule(code).Rationale__c,
      'Texts still come from the catalog'
    );

    OrgIntelSettings.saveRuleOverride(
      code,
      catalog.IsEnabled__c,
      catalog.Severity__c,
      catalog.Threshold__c
    );

    Assert.isFalse(OrgIntelSettings.isOverridden(code));
    Assert.areEqual(0, [SELECT COUNT() FROM OrgIntelRuleOverride__c]);
    Assert.areEqual(
      catalog.Severity__c,
      OrgIntelSettings.rule(code).Severity__c
    );
  }

  @IsTest
  static void ruleOverrideIsUpdatedInPlace() {
    OrgScanRule__mdt catalog = anyRule();
    String otherSeverity = catalog.Severity__c == 'Info' ? 'Critical' : 'Info';
    OrgIntelSettings.saveRuleOverride(
      catalog.DeveloperName,
      false,
      otherSeverity,
      1
    );
    OrgIntelSettings.saveRuleOverride(
      catalog.DeveloperName,
      false,
      otherSeverity,
      2
    );

    Assert.areEqual(1, [SELECT COUNT() FROM OrgIntelRuleOverride__c]);
    Assert.areEqual(
      2,
      OrgIntelSettings.rule(catalog.DeveloperName).Threshold__c
    );
    Assert.isFalse(OrgIntelSettings.rule(catalog.DeveloperName).IsEnabled__c);
  }

  @IsTest
  static void invalidRuleChangesAreRejected() {
    OrgScanRule__mdt catalog = anyRule();
    assertRejected(null, 'High', null);
    assertRejected('UNKNOWN_RULE_CODE', 'High', null);
    assertRejected(catalog.DeveloperName, 'Huge', null);
    assertRejected(catalog.DeveloperName, 'High', -1);
    Assert.isNull(OrgIntelSettings.rule(null));
  }

  private static void assertRejected(
    String code,
    String severity,
    Decimal threshold
  ) {
    try {
      OrgIntelSettings.saveRuleOverride(code, true, severity, threshold);
      Assert.fail('Expected an IllegalArgumentException');
    } catch (IllegalArgumentException e) {
      Assert.isNotNull(e.getMessage());
    }
  }

  private static OrgScanRule__mdt anyRule() {
    return [
      SELECT
        DeveloperName,
        IsEnabled__c,
        Severity__c,
        Threshold__c,
        Rationale__c
      FROM OrgScanRule__mdt
      ORDER BY DeveloperName
      LIMIT 1
    ];
  }
}
