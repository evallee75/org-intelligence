@IsTest
private class OrgAdoptionServiceTest {
  @IsTest
  static void runUsesTheContractClouds() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Test.startTest();
      OrgAdoptionService.View view = OrgAdoptionService.run(
        new List<String>{ OrgAdoptionFeatures.SERVICE },
        OrgAdoptionContract.parseLines(OrgAdoptionTestSupport.contractLines())
      );
      Test.stopTest();
      Assert.isNotNull(view.analysis);
      Assert.isNotNull(view.analysis.licenses);
      Assert.isNotNull(view.analysis.generatedBy);
      Assert.isNotNull(view.analysis.durationMs);
      Assert.areEqual('Contract', view.analysis.cloudSource);
      Assert.areEqual(
        new List<String>{ OrgAdoptionFeatures.SALES },
        view.analysis.selectedClouds
      );
      Assert.isTrue(view.contract.hasAnalysis);
      Assert.areEqual(6, view.contract.lines.size());
    }
  }

  @IsTest
  static void analyseManualAndDetectedScopes() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Test.startTest();
      OrgAdoptionService.Analysis manual = OrgAdoptionService.analyse(
        new List<String>{ OrgAdoptionFeatures.PLATFORM, 'Unknown cloud' },
        new List<String>()
      );
      OrgAdoptionService.Analysis detected = OrgAdoptionService.analyse(
        null,
        new List<String>()
      );
      Test.stopTest();
      Assert.areEqual('Manual', manual.cloudSource);
      Assert.areEqual(
        new List<String>{ OrgAdoptionFeatures.PLATFORM },
        manual.selectedClouds
      );
      Assert.areEqual('Detected', detected.cloudSource);
      Assert.isTrue(
        detected.selectedClouds.contains(OrgAdoptionFeatures.PLATFORM)
      );
      Assert.isNotNull(detected.edition);
    }
  }

  @IsTest
  static void parseReadsTheScreenJson() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Assert.isNull(OrgAdoptionService.parse(null));
      OrgAdoptionService.Analysis analysis = OrgAdoptionService.parse(
        OrgAdoptionTestSupport.untyped(OrgAdoptionTestSupport.analysis())
      );
      Assert.areEqual(4, analysis.licenses.userLicenses.size());
      Assert.areEqual(4, analysis.features.size());
      try {
        OrgAdoptionService.parse(new Map<String, Object>{ 'score' => 'abc' });
        Assert.fail('analyse illisible');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('unreadable'), e.getMessage());
      }
    }
  }

  @IsTest
  static void buildRecommendationsForSelectedKeys() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      OrgAdoptionService.Analysis analysis = OrgAdoptionTestSupport.analysis();
      List<OrgAdoptionContract.Line> lines = OrgAdoptionContract.parseLines(
        OrgAdoptionTestSupport.contractLines()
      );
      List<String> keys = new List<String>{
        'FEATURE:LEADS',
        'FEATURE:QUOTES',
        'FEATURE:KNOWLEDGE',
        'FEATURE:OPPORTUNITIES',
        'LICENSE:Salesforce',
        'LICENSE:Salesforce Platform',
        'ADDON:PSL:SalesConsole',
        'ADDON:PSL:Cpq',
        'ADDON:PKG:033000000000001',
        'CONTRACT:L1',
        'CONTRACT:L2',
        'CONTRACT:L3'
      };
      OrgAdoptionService.RecommendationBatch batch = OrgAdoptionService.buildRecommendations(
        analysis,
        lines,
        keys
      );
      Map<String, Map<String, Object>> byRule = new Map<String, Map<String, Object>>();
      for (Map<String, Object> spec : batch.specs) {
        byRule.put((String) spec.get('Fingerprint__c'), spec);
        Assert.areEqual('Adoption', spec.get('Category__c'));
        Assert.areEqual(true, spec.get('StillDetected__c'));
      }
      // 3 fonctionnalités, 1 licence, 2 add-ons, 2 lignes de contrat
      Assert.areEqual(8, batch.specs.size(), String.valueOf(byRule.keySet()));
      Assert.areEqual(
        4,
        batch.skipped,
        'OPPORTUNITIES, Platform, package, entitlement'
      );
      Assert.areEqual(
        'Medium',
        byRule.get('ADOPTION_FEATURE_LEADS|Sales Cloud feature: LEADS label')
          .get('Severity__c')
      );
      Assert.areEqual(
        'Low',
        byRule.get('ADOPTION_FEATURE_QUOTES|Sales Cloud feature: QUOTES label')
          .get('Severity__c')
      );
      Assert.areEqual(
        'High',
        byRule.get(
            'ADOPTION_CONTRACT_UNUSED|Contract line: Sales Cloud Enterprise'
          )
          .get('Severity__c'),
        'gaspillage ≥ 5 000 par an'
      );
      Assert.isTrue(
        byRule.containsKey('ADOPTION_CONTRACT_QUANTITY|Contract line: Platform')
      );
      Assert.isTrue(
        byRule.containsKey('ADOPTION_LICENSE|User license: Salesforce')
      );
      Assert.isTrue(
        byRule.containsKey('ADOPTION_ADDON|Permission set license: CPQ')
      );
      Assert.isNotNull(batch.reopenReason);
    }
  }

  @IsTest
  static void buildRecommendationsWithoutInput() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Assert.isTrue(
        OrgAdoptionService.buildRecommendations(
            null,
            null,
            new List<String>{ 'X' }
          )
          .specs.isEmpty()
      );
      Assert.isTrue(
        OrgAdoptionService.buildRecommendations(
            OrgAdoptionTestSupport.analysis(),
            new List<OrgAdoptionContract.Line>(),
            new List<String>()
          )
          .specs.isEmpty()
      );
      // Sans date d'analyse ni prix : textes construits quand même
      OrgAdoptionService.Analysis analysis = OrgAdoptionTestSupport.analysis();
      analysis.generatedAt = null;
      OrgAdoptionContract.Line line = new OrgAdoptionContract.Line();
      line.id = 'X1';
      line.product = 'No price';
      line.lineType = OrgAdoptionContract.TYPE_USER_LICENSE;
      line.quantity = 30;
      line.matchedKey = 'USER:Salesforce';
      OrgAdoptionService.RecommendationBatch batch = OrgAdoptionService.buildRecommendations(
        analysis,
        new List<OrgAdoptionContract.Line>{ line },
        new List<String>{ 'CONTRACT:X1' }
      );
      Assert.areEqual(1, batch.specs.size());
      Assert.areEqual('Medium', batch.specs[0].get('Severity__c'));
    }
  }
}
