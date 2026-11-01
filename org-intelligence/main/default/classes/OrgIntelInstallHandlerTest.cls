@IsTest
private class OrgIntelInstallHandlerTest {
  @IsTest
  static void installCreatesDefaults() {
    Test.testInstall(new OrgIntelInstallHandler(), null);

    OrgIntelSettings__c stored = OrgIntelSettings__c.getOrgDefaults();
    Assert.isNotNull(stored.Id);
    Assert.isNotNull(stored.ToolingNamedCredential__c);
    Assert.isNotNull(stored.ApiLogRetentionDays__c);
    Assert.isNotNull(stored.ScorePointsCritical__c);
  }

  @IsTest
  static void upgradeKeepsExistingSettings() {
    insert new OrgIntelSettings__c(
      SetupOwnerId = UserInfo.getOrganizationId(),
      ApiLogRetentionDays__c = 5
    );

    Test.testInstall(new OrgIntelInstallHandler(), new Version(1, 0), false);

    Assert.areEqual(1, [SELECT COUNT() FROM OrgIntelSettings__c]);
    Assert.areEqual(
      5,
      OrgIntelSettings__c.getOrgDefaults().ApiLogRetentionDays__c
    );
  }
}
