@IsTest
private class OrgIntelAdoptionModuleTest {
  private static String call(String action, Map<String, Object> params) {
    return OrgAdoptionTestSupport.invokeModule(
      new OrgIntelAdoptionModule(),
      action,
      params
    );
  }

  @IsTest
  static void runAnalysisThroughTheModuleEntry() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Test.startTest();
      String result = call(
        'runAnalysis',
        new Map<String, Object>{
          'clouds' => new List<String>{ OrgAdoptionFeatures.PLATFORM },
          'contractLines' => OrgAdoptionTestSupport.contractLines()
        }
      );
      Test.stopTest();
      Map<String, Object> view = (Map<String, Object>) JSON.deserializeUntyped(
        result
      );
      Map<String, Object> analysis = (Map<String, Object>) view.get('analysis');
      Assert.areEqual('Contract', analysis.get('cloudSource'));
      Assert.isNotNull(view.get('contract'));
    }
  }

  @IsTest
  static void contractActionsThroughTheModuleEntry() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Object analysis = OrgAdoptionTestSupport.untyped(
        OrgAdoptionTestSupport.analysis()
      );
      List<Object> lines = OrgAdoptionTestSupport.contractLines();

      Map<String, Object> summary = (Map<String, Object>) JSON.deserializeUntyped(
        call(
          'compareContract',
          new Map<String, Object>{
            'analysis' => analysis,
            'contractLines' => lines
          }
        )
      );
      Assert.areEqual(6, ((List<Object>) summary.get('lines')).size());

      List<Object> prefilled = (List<Object>) JSON.deserializeUntyped(
        call(
          'prefillContract',
          new Map<String, Object>{
            'analysis' => analysis,
            'contractLines' => lines
          }
        )
      );
      // Salesforce et Salesforce Platform sont déjà rattachées au contrat
      Assert.areEqual(0, prefilled.size());

      Map<String, Object> batch = (Map<String, Object>) JSON.deserializeUntyped(
        call(
          'buildRecommendations',
          new Map<String, Object>{
            'analysis' => analysis,
            'contractLines' => lines,
            'keys' => new List<String>{ 'FEATURE:LEADS', 'CONTRACT:L1' }
          }
        )
      );
      Assert.areEqual(2, ((List<Object>) batch.get('specs')).size());
    }
  }

  @IsTest
  static void readableErrors() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      try {
        call('prefillContract', new Map<String, Object>());
        Assert.fail('analyse requise');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().contains('Run an adoption analysis'),
          e.getMessage()
        );
      }
      try {
        call(
          'compareContract',
          new Map<String, Object>{
            'analysis' => new Map<String, Object>{ 'score' => 'abc' }
          }
        );
        Assert.fail('analyse illisible');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('unreadable'), e.getMessage());
      }
      try {
        call('nope', new Map<String, Object>());
        Assert.fail('action inconnue');
      } catch (AuraHandledException e) {
        Assert.isNotNull(e.getMessage());
      }
      try {
        new OrgIntelAdoptionModule().invoke('nope', new Map<String, Object>());
        Assert.fail('action inconnue');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('adoption'), e.getMessage());
      }
      OrgIntelAdoptionModule module = new OrgIntelAdoptionModule();
      Assert.areEqual(OrgIntelModules.ADOPTION, module.key());
      Assert.isTrue(module.isAccessible());
    }
  }

  @IsTest
  static void accessDeniedWithoutTheModulePermissionSet() {
    User user = OrgAdoptionTestSupport.userWithoutModule();
    System.runAs(user) {
      Assert.isFalse(new OrgIntelAdoptionModule().isAccessible());
      try {
        call('runAnalysis', new Map<String, Object>());
        Assert.fail('module refusé');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().contains('do not have access'),
          e.getMessage()
        );
      }
    }
  }

  @IsTest
  static void accessDeniedWithoutTheCoreAdminPermissionSet() {
    User user = OrgAdoptionTestSupport.moduleOnlyUser();
    System.runAs(user) {
      Assert.isTrue(new OrgIntelAdoptionModule().isAccessible());
      for (
        String action : new List<String>{
          'runAnalysis',
          'compareContract',
          'prefillContract',
          'buildRecommendations'
        }
      ) {
        try {
          new OrgIntelAdoptionModule()
            .invoke(action, new Map<String, Object>());
          Assert.fail('administration du socle requise : ' + action);
        } catch (AuraHandledException e) {
          Assert.isTrue(
            e.getMessage().contains('Org Intelligence'),
            e.getMessage()
          );
        }
      }
    }
  }
}
