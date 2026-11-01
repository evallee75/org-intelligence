/**
 * Contrôleur des écrans du socle (OrgIntelligenceController) et services qu'il sert : vue
 * d'ensemble, état du scanner, catalogue des règles, organisation, Automation, Storage, Reports.
 */
@IsTest
private class OrgIntelligenceControllerTest {
  @IsTest
  static void adminSeesEveryView() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.withoutModules();
      OrgIntelTestSupport.useFakeTooling();
      Test.startTest();
      OrgOverviewService.Overview overview = OrgIntelligenceController.getOverview();
      Assert.isTrue(overview.canRunScan);
      Assert.isFalse(overview.recommendationsEnabled);
      Assert.isNotNull(overview.scoreConfig);

      OrgIntelligenceController.ScannerState state = OrgIntelligenceController.getScannerState();
      Assert.isTrue(state.canRunScan);
      Assert.isTrue(state.tooling.connected);
      Assert.isNotNull(state.tooling.setupUrl);

      Map<String, Object> catalog = (Map<String, Object>) JSON.deserializeUntyped(
        OrgIntelligenceController.getRuleCatalog()
      );
      Assert.isFalse(((List<Object>) catalog.get('rules')).isEmpty());

      Map<String, Object> org = OrgIntelligenceController.getOrgInfo();
      Assert.areEqual(
        UserInfo.getOrganizationId(),
        String.valueOf(org.get('orgId'))
      );

      OrgAutomationService.AutomationView automation = OrgIntelligenceController.getAutomationView();
      Assert.isNotNull(automation.orgDomainUrl);
      Assert.isNotNull(automation.flowErrors);
      Assert.areEqual(OrgAutomationService.ERROR_DAYS, automation.errorDays);

      OrgStorageService.StorageView storage = OrgIntelligenceController.getStorageView();
      Assert.isNotNull(storage);

      OrgReportsService.ReportsView reports = OrgIntelligenceController.getReportsView();
      Assert.isFalse(reports.recommendationsEnabled);
      Assert.isNotNull(reports.reports);
      Test.stopTest();
    }
  }

  @IsTest
  static void recommendationsModuleFeedsOverviewAndReports() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.withModule(
        OrgIntelModules.RECOMMENDATIONS,
        new OrgIntelTestSupport.FakeModule(OrgIntelModules.RECOMMENDATIONS)
      );
      OrgOverviewService.Overview overview = OrgIntelligenceController.getOverview();
      Assert.isTrue(overview.recommendationsEnabled);
      Assert.areEqual(
        4,
        overview.openRecommendationCount,
        'gravité vide comprise'
      );
      Assert.areEqual(3, overview.toReviewCount);
      Assert.areEqual(1, overview.acceptedCount);
      Assert.areEqual(1, overview.priorityRecommendations.size());
      Assert.areEqual('REC-1', overview.priorityRecommendations[0].name);
      Assert.areEqual(
        OrgIntelligenceConstants.SEVERITIES.size(),
        overview.severityDistribution.size()
      );
      Assert.areEqual(2, overview.severityDistribution[0].count);

      OrgReportsService.ReportsView reports = OrgIntelligenceController.getReportsView();
      Assert.isTrue(reports.recommendationsEnabled);
      Assert.areEqual(4, reports.resolvedLast90Days);
      Assert.areEqual(6, reports.createdLast90Days);
      Assert.areEqual(9, reports.openCount);
      Assert.areEqual(3.5, reports.averageDaysToResolve);
      Assert.areEqual('2026-10', reports.resolutionTrend[0].month);
      Assert.areEqual(5, reports.openByCategory[0].count);
    }
  }

  @IsTest
  static void moduleDataMayBeMissingOrTyped() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgOverviewService.Overview overview = new OrgOverviewService.Overview();
      OrgOverviewService.fillFromModule(overview, null);
      Assert.isNull(overview.openRecommendationCount);
      OrgOverviewService.fillFromModule(
        overview,
        new Map<String, Object>{
          'bySeverity' => new Map<String, Integer>{ 'High' => 5 }
        }
      );
      Assert.areEqual(5, overview.openRecommendationCount);
      Assert.isTrue(overview.priorityRecommendations.isEmpty());

      OrgReportsService.ReportsView reports = new OrgReportsService.ReportsView();
      reports.resolutionTrend = new List<OrgReportsService.MonthPoint>();
      reports.openByCategory = new List<OrgReportsService.TypeCount>();
      OrgReportsService.fillFromModule(reports, null);
      OrgReportsService.fillFromModule(reports, new Map<String, Object>());
      Assert.isNull(reports.averageDaysToResolve);
      Assert.isTrue(reports.resolutionTrend.isEmpty());
    }
  }

  @IsTest
  static void readerCannotRunScansNorSeeFlowErrors() {
    System.runAs(OrgIntelTestSupport.readerUser()) {
      OrgIntelTestSupport.withoutModules();
      OrgIntelligenceController.ScannerState state = OrgIntelligenceController.getScannerState();
      Assert.isFalse(state.canRunScan);
      Assert.isNull(state.tooling, 'pas d’appel HTTP pour un lecteur');
      Assert.isFalse(OrgIntelligenceController.getOverview().canRunScan);
      OrgAutomationService.AutomationView automation = OrgIntelligenceController.getAutomationView();
      Assert.isTrue(automation.flowErrors.isEmpty());
      Assert.isTrue(automation.flowErrorsMessage.contains('administrators'));
      try {
        OrgIntelligenceController.runScanStep('{}', null);
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('administrators'));
      }
    }
  }

  @IsTest
  static void outsiderIsRefusedEverywhere() {
    System.runAs(OrgIntelTestSupport.outsiderUser()) {
      Integer refused = 0;
      List<String> calls = new List<String>{
        'overview',
        'scanner',
        'rules',
        'org',
        'automation',
        'storage',
        'reports'
      };
      for (String call : calls) {
        try {
          switch on call {
            when 'overview' {
              OrgIntelligenceController.getOverview();
            }
            when 'scanner' {
              OrgIntelligenceController.getScannerState();
            }
            when 'rules' {
              OrgIntelligenceController.getRuleCatalog();
            }
            when 'org' {
              OrgIntelligenceController.getOrgInfo();
            }
            when 'automation' {
              OrgIntelligenceController.getAutomationView();
            }
            when 'storage' {
              OrgIntelligenceController.getStorageView();
            }
            when 'reports' {
              OrgIntelligenceController.getReportsView();
            }
          }
        } catch (AuraHandledException e) {
          refused++;
        }
      }
      Assert.areEqual(calls.size(), refused);
    }
  }

  @IsTest
  static void flowErrorsAreGroupedByFlow() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      // Les interviews en échec ne se créent pas en test : la lecture doit répondre sans erreur
      OrgAutomationService.AutomationView view = OrgAutomationService.getView();
      Assert.isNotNull(view.flowErrors);
      Assert.isNull(view.flowErrorsMessage, 'lecture des erreurs sans échec');

      Map<String, OrgAutomationService.FlowErrorSummary> byFlow = new Map<String, OrgAutomationService.FlowErrorSummary>();
      for (Integer i = 0; i < 7; i++) {
        OrgAutomationService.FlowErrorSample sample = new OrgAutomationService.FlowErrorSample();
        sample.occurredAt = Datetime.now().addMinutes(-i);
        OrgAutomationService.addError(byFlow, 'My_Flow', sample);
      }
      OrgAutomationService.FlowErrorSummary summary = byFlow.get('My_Flow');
      Assert.areEqual(7, summary.count);
      Assert.areEqual(5, summary.samples.size(), 'échantillons bornés');
      Assert.isNotNull(summary.lastAt);
    }
  }
}
