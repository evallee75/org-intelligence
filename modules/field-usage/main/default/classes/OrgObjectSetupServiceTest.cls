/**
 * Onglet « Object setup » : types d'enregistrement, présentations et assignations, pages Lightning,
 * présentations compactes et constats, avec la Tooling API simulée (réussites, échecs, absence).
 */
@IsTest
private class OrgObjectSetupServiceTest {
  @TestSetup
  static void setup() {
    OrgFieldUsageTestSupport.adminUser(
      new List<String>{
        OrgFieldUsageTestSupport.CORE_ADMIN_PS,
        OrgFieldUsageTestSupport.MODULE_PS
      }
    );
    // Profils avec utilisateurs actifs (fragmentation des assignations)
    List<Profile> profiles = [
      SELECT Id
      FROM Profile
      WHERE UserType = 'Standard'
      ORDER BY CreatedDate
      LIMIT 3
    ];
    for (Profile profile : profiles) {
      OrgFieldUsageTestSupport.createUser(profile.Id, new List<String>());
    }
  }

  private static User admin() {
    return [
      SELECT Id
      FROM User
      WHERE
        LastName = 'FieldUsage'
        AND IsActive = TRUE
        AND Profile.PermissionsModifyAllData = TRUE
      ORDER BY CreatedDate
      LIMIT 1
    ];
  }

  private static OrgFieldUsageTestSupport.ToolingRouter router() {
    OrgFieldUsageTestSupport.ToolingRouter router = new OrgFieldUsageTestSupport.ToolingRouter();
    for (AggregateResult row : [
      SELECT ProfileId
      FROM User
      WHERE LastName = 'FieldUsage' AND IsActive = TRUE
      GROUP BY ProfileId
    ]) {
      router.profileIds.add(String.valueOf(row.get('ProfileId')));
    }
    List<RecordType> types = [
      SELECT Id
      FROM RecordType
      WHERE SobjectType = 'Account'
      LIMIT 1
    ];
    router.recordTypeId = types.isEmpty() ? null : types[0].Id;
    return router;
  }

  @IsTest
  static void fullAnalysisWithTooling() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = router();
    Test.setMock(HttpCalloutMock.class, router);
    System.runAs(admin()) {
      Test.startTest();
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        ' Account '
      );
      Test.stopTest();
      Assert.areEqual('Account', result.objectName);
      Assert.isTrue(result.toolingAvailable);
      Assert.areEqual(
        6,
        result.layouts.size(),
        'présentation de processus ignorée'
      );
      Assert.areEqual(3, result.layouts[0].fieldCount);
      Assert.areEqual(2, result.layouts[0].sectionCount);
      Assert.areEqual(1, result.layouts[0].relatedListCount);
      Assert.isNull(result.layouts[1].lastModifiedDate, 'date illisible');
      Assert.isTrue(result.assignmentsKnown);
      Assert.isFalse(result.profiles.isEmpty());
      Boolean hiddenProfile = false;
      for (OrgObjectSetupService.ProfileRow row : result.profiles) {
        hiddenProfile =
          hiddenProfile || row.profileName.startsWith('Hidden profile');
        Assert.isNotNull(row.profileName);
      }
      Assert.isTrue(hiddenProfile, 'profil inconnu de SOQL');
      Assert.isTrue(result.pagesKnown);
      Assert.areEqual(2, result.pages.size());
      OrgObjectSetupService.PageInfo page = result.pages[0];
      Assert.isTrue(page.detailsRead);
      Assert.isTrue(page.dynamicForms);
      Assert.isTrue(page.dynamicActions);
      Assert.isTrue(page.usesRecordDetail);
      Assert.areEqual(2, page.fieldCount);
      Assert.areEqual(1, page.tabCount);
      Assert.isTrue(page.customComponentCount >= 1);
      Assert.isTrue(result.compactKnown);
      Assert.isTrue(result.systemDefaultCompact);
      Assert.areEqual('System Default', result.defaultCompactLayout);
      Assert.areEqual(2, result.summary.validationRules);
      Assert.areEqual(1, result.summary.activeValidationRules);
      Assert.isNotNull(result.summary.fieldCount);

      Set<String> keys = new Set<String>();
      for (OrgObjectSetupService.Finding finding : result.findings) {
        keys.add(finding.key);
      }
      Assert.isTrue(keys.contains('MANY_LAYOUTS'), String.valueOf(keys));
      Assert.isTrue(keys.contains('LAYOUT_UNASSIGNED'), String.valueOf(keys));
      Assert.isTrue(
        keys.contains('LAYOUT_NO_ACTIVE_USER'),
        String.valueOf(keys)
      );
      Assert.isTrue(keys.contains('HEAVY_PAGE'), String.valueOf(keys));
      Assert.isTrue(
        keys.contains('SYSTEM_COMPACT_LAYOUT'),
        String.valueOf(keys)
      );
      Assert.isTrue(keys.contains('COMPACT_UNUSED'), String.valueOf(keys));
      if (router.profileIds.size() >= 3) {
        Assert.isTrue(
          keys.contains('FRAGMENTED_ASSIGNMENTS'),
          String.valueOf(keys)
        );
      }
      Assert.isTrue(result.score < 100);
    }
  }

  @IsTest
  static void defaultCompactLayoutAndNoLightningPage() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = router();
    router.emptyPages = true;
    router.defaultCompact = true;
    Test.setMock(HttpCalloutMock.class, router);
    System.runAs(admin()) {
      Test.startTest();
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        'Account'
      );
      Test.stopTest();
      Assert.isFalse(result.systemDefaultCompact);
      Assert.areEqual('Main', result.defaultCompactLayout);
      Set<String> keys = new Set<String>();
      for (OrgObjectSetupService.Finding finding : result.findings) {
        keys.add(finding.key);
      }
      Assert.isTrue(keys.contains('NO_LIGHTNING_PAGE'), String.valueOf(keys));
      Assert.isFalse(keys.contains('SYSTEM_COMPACT_LAYOUT'));
    }
  }

  @IsTest
  static void partialToolingFailuresAreNoted() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = router();
    router.failing.addAll(
      new List<String>{
        'LayoutMetadata',
        'ProfileLayout',
        'FlexiPageMetadata',
        'Describe',
        'ValidationRule'
      }
    );
    Test.setMock(HttpCalloutMock.class, router);
    System.runAs(admin()) {
      Test.startTest();
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        'Account'
      );
      Test.stopTest();
      Assert.isTrue(result.toolingAvailable);
      Assert.isFalse(result.assignmentsKnown);
      Assert.isFalse(result.compactKnown);
      Assert.isFalse(result.pages[0].detailsRead);
      String notes = String.join(result.notes, ' | ');
      Assert.isTrue(notes.contains('layout(s) not opened'), notes);
      Assert.isTrue(notes.contains('Layout assignments not read'), notes);
      Assert.isTrue(notes.contains('Lightning page(s) not opened'), notes);
      Assert.isTrue(notes.contains('Default compact layout not read'), notes);
      Assert.isTrue(notes.contains('Validation rules not read'), notes);
    }
  }

  @IsTest
  static void pageAndCompactListFailuresAreNoted() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = router();
    router.failing.addAll(new List<String>{ 'FlexiPage', 'CompactLayout' });
    Test.setMock(HttpCalloutMock.class, router);
    System.runAs(admin()) {
      Test.startTest();
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        'Account'
      );
      Test.stopTest();
      Assert.isFalse(result.pagesKnown);
      String notes = String.join(result.notes, ' | ');
      Assert.isTrue(notes.contains('Lightning record pages not read'), notes);
      Assert.isTrue(notes.contains('Compact layouts not read'), notes);
    }
  }

  @IsTest
  static void layoutListFailureStopsTheToolingReads() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = router();
    router.failing.add('*');
    Test.setMock(HttpCalloutMock.class, router);
    System.runAs(admin()) {
      Test.startTest();
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        'Account'
      );
      Test.stopTest();
      Assert.isFalse(result.toolingAvailable);
      Assert.isTrue(
        result.notes[result.notes.size() - 1].contains('Tooling API needed')
      );
    }
  }

  @IsTest
  static void withoutToolingOnlySoqlAndDescribeAreUsed() {
    OrgFieldUsageTestSupport.useTooling(false);
    System.runAs(admin()) {
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        'Opportunity'
      );
      Assert.isFalse(result.toolingAvailable);
      Assert.isTrue(
        String.join(result.notes, ' ').contains('Tooling API needed')
      );
      Assert.isNotNull(result.summary.triggers);
      Assert.isNotNull(result.summary.recordTriggeredFlows);
      for (OrgObjectSetupService.RecordTypeInfo rt : result.recordTypes) {
        Assert.areNotEqual(true, rt.hasRecords, 'aucune donnée de test');
      }
      Assert.isTrue(result.score <= 100);
    }
  }

  @IsTest
  static void failingToolingCheckIsNoted() {
    OrgFieldUsageTestSupport.useFailingTooling();
    System.runAs(admin()) {
      OrgObjectSetupService.SetupResult result = OrgObjectSetupService.analyze(
        'Contact'
      );
      Assert.isFalse(result.toolingAvailable);
      Assert.isTrue(
        String.join(result.notes, ' ').contains('Tooling check failed')
      );
    }
  }

  @IsTest
  static void unknownObjectIsRefused() {
    try {
      OrgObjectSetupService.analyze(null);
      Assert.fail('objet vide');
    } catch (IllegalArgumentException e) {
      Assert.isTrue(e.getMessage().contains('does not exist'));
    }
  }

  @IsTest
  static void pageWithoutContentIsDescribed() {
    OrgObjectSetupService.PageInfo page = new OrgObjectSetupService.PageInfo();
    OrgObjectSetupService.describePage(page, new Map<String, Object>());
    Assert.isTrue(page.detailsRead);
    Assert.isFalse(page.dynamicForms);
    Assert.areEqual(0, page.componentCount);
    Assert.isNull(page.template);
  }
}
