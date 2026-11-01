@IsTest
private class OrgSettingsServiceTest {
  /** Réponse Tooling simulée (test de connexion de getSettings). */
  private class ToolingMock implements HttpCalloutMock {
    public HttpResponse respond(HttpRequest request) {
      HttpResponse response = new HttpResponse();
      response.setStatusCode(200);
      response.setBody('{"done":true,"totalSize":0,"records":[]}');
      return response;
    }
  }

  @IsTest
  static void getSettingsReturnsMergedRulesAndSettings() {
    Test.setMock(HttpCalloutMock.class, new ToolingMock());
    OrgScanRule__mdt catalog = anyRule();
    String otherSeverity = catalog.Severity__c == 'Info' ? 'Critical' : 'Info';
    OrgSettingsService.updateRule(
      catalog.DeveloperName,
      true,
      otherSeverity,
      3
    );

    Test.startTest();
    OrgSettingsService.SettingsView view = OrgSettingsService.getSettings();
    Test.stopTest();

    Assert.isNotNull(view.tooling);
    Assert.isNotNull(view.retention.apiLogRetentionDays);
    Assert.isNotNull(view.score);
    Assert.isFalse(view.rules.isEmpty());
    OrgSettingsService.RuleRow row;
    for (OrgSettingsService.RuleRow candidate : view.rules) {
      if (candidate.code == catalog.DeveloperName) {
        row = candidate;
      }
    }
    Assert.areEqual(otherSeverity, row.severity);
    Assert.areEqual(3, row.threshold);
    Assert.isTrue(row.overridden);
  }

  @IsTest
  static void retentionIsSavedImmediately() {
    Assert.isNull(OrgSettingsService.updateRetention(45, false));

    Assert.areEqual(45, OrgIntelSettings.apiLogRetentionDays());
    Assert.isFalse(OrgIntelSettings.logApiPayloads());
    assertRejected('retention', null);
    assertRejected('retention', 0);
  }

  @IsTest
  static void scoreIsSavedImmediately() {
    Map<String, Object> score = scoreDraft(new List<String>{ 'Apex' });
    OrgSettingsService.updateScore(JSON.serialize(score));

    OrgHealthScore.Config config = OrgHealthScore.config();
    Assert.areEqual('Custom', config.preset);
    Assert.areEqual(7, config.points.get('Critical'));
    Assert.areEqual(30, config.caps.get('Critical'));
    Assert.areEqual(new List<String>{ 'Apex' }, config.domains);
    Assert.isFalse(config.excludeIgnored);

    OrgSettingsService.updateScore(
      JSON.serialize(scoreDraft(OrgHealthScore.DOMAINS))
    );
    Assert.areEqual(
      OrgHealthScore.DOMAINS.size(),
      OrgHealthScore.config().domains.size(),
      'Every domain kept = blank field'
    );
    Assert.isNull(OrgIntelSettings__c.getOrgDefaults().ScoreDomains__c);
  }

  @IsTest
  static void invalidScoreIsRejected() {
    Map<String, Object> noDomain = scoreDraft(new List<String>());
    Map<String, Object> badPoints = scoreDraft(new List<String>{ 'Apex' });
    ((Map<String, Object>) badPoints.get('points')).put('High', 150);
    for (
      Map<String, Object> draft : new List<Map<String, Object>>{
        noDomain,
        badPoints
      }
    ) {
      try {
        OrgSettingsService.updateScore(JSON.serialize(draft));
        Assert.fail('Expected an IllegalArgumentException');
      } catch (IllegalArgumentException e) {
        Assert.isNotNull(e.getMessage());
      }
    }
  }

  @IsTest
  static void jiraProjectIsSavedImmediately() {
    OrgSettingsService.updateJira('OPS', null);
    Assert.areEqual('OPS', OrgIntelSettings.jiraProjectKey());
    Assert.areEqual(
      OrgIntelSettings.DEFAULT_JIRA_ISSUE_TYPE,
      OrgIntelSettings.jiraIssueType()
    );
    OrgSettingsService.updateJira('OPS', 'Bug');
    Assert.areEqual('Bug', OrgIntelSettings.jiraIssueType());
    try {
      OrgSettingsService.updateJira('THIS-KEY-IS-FAR-TOO-LONG', 'Bug');
      Assert.fail('Expected an IllegalArgumentException');
    } catch (IllegalArgumentException e) {
      Assert.isNotNull(e.getMessage());
    }
  }

  @IsTest
  static void adminControllerSavesSettings() {
    User admin = adminUser();
    OrgScanRule__mdt catalog = anyRule();
    System.runAs(admin) {
      Test.startTest();
      Test.setMock(HttpCalloutMock.class, new ToolingMock());
      Assert.isNotNull(OrgAdminController.getSettings());
      Assert.isNotNull(OrgAdminController.runMaintenance());
      OrgAdminController.updateRetention(20, true);
      OrgAdminController.updateRule(
        catalog.DeveloperName,
        !catalog.IsEnabled__c,
        catalog.Severity__c,
        catalog.Threshold__c
      );
      OrgAdminController.updateScoreSettings(
        JSON.serialize(scoreDraft(new List<String>{ 'Storage' }))
      );
      try {
        OrgAdminController.updateRetention(-1, true);
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isNotNull(e.getMessage());
      }
      Test.stopTest();
    }
    Assert.areEqual(20, OrgIntelSettings.apiLogRetentionDays());
    Assert.isTrue(OrgIntelSettings.isOverridden(catalog.DeveloperName));
  }

  @IsTest
  static void adminControllerRejectsNonAdmins() {
    User reader = newUser('oi-reader');
    reader.ProfileId = [
      SELECT Id
      FROM Profile
      WHERE
        UserType = 'Standard'
        AND PermissionsModifyAllData = FALSE
        AND UserLicense.Name = 'Salesforce'
      LIMIT 1
    ]
    .Id;
    insert reader;
    System.runAs(reader) {
      try {
        OrgAdminController.updateRetention(20, true);
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isNotNull(e.getMessage());
      }
    }
    Assert.isNull(OrgIntelSettings__c.getOrgDefaults().Id);
  }

  private static void assertRejected(String what, Integer days) {
    try {
      OrgSettingsService.updateRetention(days, true);
      Assert.fail('Expected an IllegalArgumentException (' + what + ')');
    } catch (IllegalArgumentException e) {
      Assert.isNotNull(e.getMessage());
    }
  }

  private static Map<String, Object> scoreDraft(List<String> domains) {
    Map<String, Object> points = new Map<String, Object>();
    Map<String, Object> caps = new Map<String, Object>();
    for (String severity : OrgHealthScore.PRESETS.get('Balanced').keySet()) {
      points.put(severity, severity == 'Critical' ? 7 : 1);
      caps.put(severity, severity == 'Critical' ? 30 : 5);
    }
    return new Map<String, Object>{
      'preset' => 'Custom',
      'points' => points,
      'caps' => caps,
      'domains' => domains,
      'excludeIgnored' => false
    };
  }

  private static OrgScanRule__mdt anyRule() {
    return [
      SELECT DeveloperName, IsEnabled__c, Severity__c, Threshold__c
      FROM OrgScanRule__mdt
      ORDER BY DeveloperName
      LIMIT 1
    ];
  }

  private static User adminUser() {
    User admin = newUser('oi-admin');
    insert admin;
    insert new PermissionSetAssignment(
      AssigneeId = admin.Id,
      PermissionSetId = [
        SELECT Id
        FROM PermissionSet
        WHERE Name = 'OrgIntelligence_Admin'
        LIMIT 1
      ]
      .Id
    );
    return admin;
  }

  private static User newUser(String alias) {
    Profile profile = [
      SELECT Id
      FROM Profile
      WHERE UserType = 'Standard' AND PermissionsModifyAllData = TRUE
      LIMIT 1
    ];
    String unique = alias + '.' + Crypto.getRandomInteger() + '@orgintel.test';
    return new User(
      Alias = alias.left(8),
      Email = unique,
      Username = unique,
      LastName = 'Test',
      ProfileId = profile.Id,
      TimeZoneSidKey = 'Europe/Paris',
      LocaleSidKey = 'en_US',
      LanguageLocaleKey = 'en_US',
      EmailEncodingKey = 'UTF-8'
    );
  }

  @IsTest
  static void domainFollowsRulePrefix() {
    Assert.areEqual('Apex', OrgHealthScore.domainOf('TRIGGER_X'));
    Assert.areEqual(
      'Flows & Automation',
      OrgHealthScore.domainOf('AUTOMATION_X')
    );
    Assert.areEqual('Data Model', OrgHealthScore.domainOf('FIELD_X'));
    Assert.areEqual('Data Quality', OrgHealthScore.domainOf('VR_X'));
    Assert.areEqual('Storage', OrgHealthScore.domainOf('STORAGE_X'));
    Assert.areEqual('Other', OrgHealthScore.domainOf(null));
  }
}
