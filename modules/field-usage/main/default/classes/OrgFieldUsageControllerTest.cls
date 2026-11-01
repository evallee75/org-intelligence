/**
 * Contrôleur de la section Objects & Fields : erreurs traduites en messages lisibles et accès réservé
 * aux administrateurs Org Intelligence.
 */
@IsTest
private class OrgFieldUsageControllerTest {
  private static User admin() {
    return OrgFieldUsageTestSupport.adminUser(
      new List<String>{
        OrgFieldUsageTestSupport.CORE_ADMIN_PS,
        OrgFieldUsageTestSupport.MODULE_PS
      }
    );
  }

  @IsTest
  static void unknownObjectGivesReadableErrors() {
    OrgFieldUsageTestSupport.useTooling(false);
    System.runAs(admin()) {
      Integer errors = 0;
      try {
        OrgFieldUsageController.prepareAnalysis('NoSuchObject__zz', 10);
      } catch (AuraHandledException e) {
        errors++;
        Assert.isTrue(
          e.getMessage().contains('NoSuchObject__zz'),
          e.getMessage()
        );
      }
      try {
        OrgFieldUsageController.scanChunk(
          'NoSuchObject__zz',
          null,
          null,
          null,
          null
        );
      } catch (AuraHandledException e) {
        errors++;
      }
      try {
        OrgFieldUsageController.finalizeAnalysis(
          'NoSuchObject__zz',
          null,
          null,
          null,
          null,
          null
        );
      } catch (AuraHandledException e) {
        errors++;
      }
      try {
        OrgFieldUsageController.analyzeObjectSetup('NoSuchObject__zz');
      } catch (AuraHandledException e) {
        errors++;
      }
      Assert.areEqual(4, errors);
    }
  }

  @IsTest
  static void objectListIsReturned() {
    System.runAs(admin()) {
      List<OrgFieldUsageService.ObjectSummary> objects = OrgFieldUsageController.getObjects();
      Boolean hasAccount = false;
      for (OrgFieldUsageService.ObjectSummary summary : objects) {
        hasAccount = hasAccount || summary.apiName == 'Account';
        Assert.isFalse(summary.apiName.endsWith('__mdt'));
      }
      Assert.isTrue(hasAccount, 'Account est analysable');
    }
  }

  @IsTest
  static void nonAdministratorsAreRefused() {
    User user = OrgFieldUsageTestSupport.standardUser(new List<String>());
    System.runAs(user) {
      Integer refused = 0;
      try {
        OrgFieldUsageController.getObjects();
      } catch (AuraHandledException e) {
        refused++;
      }
      try {
        OrgFieldUsageController.prepareAnalysis('Account', 10);
      } catch (AuraHandledException e) {
        refused++;
      }
      try {
        OrgFieldUsageController.scanChunk('Account', null, null, null, null);
      } catch (AuraHandledException e) {
        refused++;
      }
      try {
        OrgFieldUsageController.finalizeAnalysis(
          'Account',
          null,
          null,
          null,
          null,
          null
        );
      } catch (AuraHandledException e) {
        refused++;
      }
      try {
        OrgFieldUsageController.analyzeObjectSetup('Account');
      } catch (AuraHandledException e) {
        refused++;
      }
      Assert.areEqual(5, refused);
    }
  }
}
