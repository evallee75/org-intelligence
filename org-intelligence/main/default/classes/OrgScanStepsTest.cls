/**
 * Étapes du scanner, une à une, avec la Tooling API simulée (OrgIntelTestSupport.FakeTooling) :
 * collecte, règles évaluées, mode dégradé et cas d'erreur.
 */
@IsTest
private class OrgScanStepsTest {
  private static final List<String> ALL_STEPS = new List<String>{
    OrgScanState.STEP_PREPARE,
    OrgScanState.STEP_APEX_CLASSES,
    OrgScanState.STEP_APEX_COVERAGE,
    OrgScanState.STEP_APEX_TRIGGERS,
    OrgScanState.STEP_FLOWS,
    OrgScanState.STEP_FLOW_ANALYSIS,
    OrgScanState.STEP_OBJECTS_FIELDS,
    OrgScanState.STEP_VALIDATION_RULES,
    OrgScanState.STEP_STORAGE,
    OrgScanState.STEP_DEPENDENCIES,
    OrgScanState.STEP_CROSS_RULES
  };

  private static OrgScanContext contextAt(String step, Boolean tooling) {
    OrgScanContext ctx = OrgIntelTestSupport.context(ALL_STEPS, tooling);
    ctx.state.stepIndex = ALL_STEPS.indexOf(step);
    return ctx;
  }

  // ---------- Préparation ----------

  @IsTest
  static void prepareDetectsToolingAndReferenceVersion() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgScanContext ctx = contextAt(OrgScanState.STEP_PREPARE, false);
      Assert.isNull(new OrgScanPrepareStep().run(ctx, null));
      Assert.isTrue(ctx.state.toolingAvailable);
      Assert.isNotNull(ctx.state.referenceApiVersion);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(ctx.state, 'Reference API')
      );

      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      tooling.configured = false;
      ctx = contextAt(OrgScanState.STEP_PREPARE, true);
      new OrgScanPrepareStep().run(ctx, null);
      Assert.isFalse(ctx.state.toolingAvailable);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(ctx.state, 'degraded mode')
      );
    }
  }

  // ---------- Apex ----------

  @IsTest
  static void apexClassesArePagedAndAnalysed() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgApexClassCollector.pageSize = 2;
      OrgScanContext ctx = contextAt(OrgScanState.STEP_APEX_CLASSES, true);
      String cursor = new OrgApexClassCollector().run(ctx, null);
      Assert.isTrue(ctx.discoveredComponents().size() <= 2);
      Set<String> firstPage = new Set<String>();
      for (OrgScanModels.Component component : ctx.discoveredComponents()) {
        firstPage.add(component.metadataId);
      }
      if (cursor != null) {
        OrgScanContext next = contextAt(OrgScanState.STEP_APEX_CLASSES, true);
        new OrgApexClassCollector().run(next, cursor);
        for (OrgScanModels.Component component : next.discoveredComponents()) {
          Assert.areEqual('ApexClass', component.componentType);
          Assert.isFalse(
            firstPage.contains(component.metadataId),
            'page suivante'
          );
        }
      }
      Assert.isTrue(ctx.state.evaluatedRules.contains('APEX_HARDCODED_ID'));
    }
  }

  @IsTest
  static void coverageIsMeasuredForInventoriedClasses() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      tooling.coverageRows = new List<Map<String, Object>>{
        OrgIntelTestSupport.coverageRow(
          '01p000000000001',
          'LowCovered',
          10,
          90
        ),
        OrgIntelTestSupport.coverageRow(
          '01p000000000002',
          'WellCovered',
          95,
          5
        ),
        OrgIntelTestSupport.coverageRow('01p000000000003', 'NotInScan', 0, 10),
        OrgIntelTestSupport.coverageRow(
          '01q000000000004',
          'SomeTrigger',
          0,
          10
        ),
        OrgIntelTestSupport.coverageRow('01p000000000005', 'EmptyClass', 0, 0)
      };
      OrgScanContext ctx = contextAt(OrgScanState.STEP_APEX_COVERAGE, true);
      ctx.inventory = new List<OrgScanModels.Component>{
        OrgIntelTestSupport.component('ApexClass', 'LowCovered', null, null),
        OrgIntelTestSupport.component('ApexClass', 'WellCovered', null, null),
        OrgIntelTestSupport.component('ApexClass', 'EmptyClass', null, null),
        OrgIntelTestSupport.component(
          'ApexClass',
          'SomeTest',
          null,
          new Map<String, Object>{ 'isTest' => true }
        )
      };
      Assert.isNull(new OrgApexCoverageCollector().run(ctx, null));
      Map<String, List<OrgScanModels.Finding>> byRule = OrgIntelTestSupport.findingsByRule(
        ctx
      );
      Assert.areEqual(1, byRule.get('APEX_LOW_COVERAGE').size());
      Assert.areEqual(
        'LowCovered',
        byRule.get('APEX_LOW_COVERAGE')[0].componentName
      );
      Assert.isTrue(OrgIntelTestSupport.logContains(ctx.state, '2 classes'));
    }
  }

  @IsTest
  static void coverageIsSkippedWhenItCannotBeMeasured() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgScanContext noTooling = contextAt(
        OrgScanState.STEP_APEX_COVERAGE,
        false
      );
      new OrgApexCoverageCollector().run(noTooling, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(noTooling.state, 'not available')
      );

      OrgScanContext failedInventory = contextAt(
        OrgScanState.STEP_APEX_COVERAGE,
        true
      );
      failedInventory.state.failedSteps.add(OrgScanState.STEP_APEX_CLASSES);
      new OrgApexCoverageCollector().run(failedInventory, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(
          failedInventory.state,
          'inventory failed'
        )
      );

      OrgScanContext noData = contextAt(OrgScanState.STEP_APEX_COVERAGE, true);
      new OrgApexCoverageCollector().run(noData, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(noData.state, 'No code coverage')
      );
    }
  }

  @IsTest
  static void triggersAreCollected() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgScanContext ctx = contextAt(OrgScanState.STEP_APEX_TRIGGERS, true);
      Assert.isNull(new OrgApexTriggerCollector().run(ctx, null));
      for (OrgScanModels.Component component : ctx.discoveredComponents()) {
        Assert.areEqual('ApexTrigger', component.componentType);
        Assert.isTrue(component.details.get('events') instanceof List<String>);
      }
      Assert.isTrue(
        ctx.state.evaluatedRules.contains('TRIGGER_MULTIPLE_PER_OBJECT')
      );
    }
  }

  // ---------- Flows ----------

  @IsTest
  static void flowsAreCollected() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgScanContext ctx = contextAt(OrgScanState.STEP_FLOWS, true);
      Assert.isNull(new OrgFlowCollector().run(ctx, null));
      for (OrgScanModels.Component component : ctx.discoveredComponents()) {
        Assert.areEqual('Flow', component.componentType);
        Assert.isTrue(component.details.containsKey('processType'));
      }
      Assert.isTrue(
        ctx.state.evaluatedRules.contains('FLOW_PROCESS_BUILDER_ACTIVE')
      );
    }
  }

  @IsTest
  static void flowLogicIsAnalysedPageByPage() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgFlowAnalysisStep.flowsPerPage = 2;
      List<OrgScanModels.Component> flows = new List<OrgScanModels.Component>();
      for (String name : new List<String>{ 'C_Flow', 'A_Flow', 'B_Flow' }) {
        flows.add(
          OrgIntelTestSupport.component(
            'Flow',
            name,
            'Opportunity',
            new Map<String, Object>{ 'activeVersionId' => '301000000000001' }
          )
        );
      }
      flows.add(
        OrgIntelTestSupport.component(
          'Flow',
          'D_No_Version',
          null,
          new Map<String, Object>()
        )
      );

      OrgScanContext ctx = contextAt(OrgScanState.STEP_FLOW_ANALYSIS, true);
      ctx.inventory = flows;
      String cursor = new OrgFlowAnalysisStep().run(ctx, null);
      Assert.areEqual('2', cursor);
      Assert.isTrue(
        ctx.detailUpdates.containsKey('Flow:A_Flow'),
        'ordre alphabétique'
      );
      Assert.isTrue(ctx.detailUpdates.containsKey('Flow:B_Flow'));
      Map<String, List<OrgScanModels.Finding>> byRule = OrgIntelTestSupport.findingsByRule(
        ctx
      );
      Assert.isTrue(byRule.containsKey('FLOW_DML_IN_LOOP'));
      Assert.isTrue(byRule.containsKey('FLOW_AFTER_SAVE_SAME_RECORD'));
      Assert.isTrue(byRule.containsKey('FLOW_NO_ENTRY_CRITERIA'));
      Assert.isTrue(byRule.containsKey('FLOW_MISSING_FAULT_PATH'));
      Assert.isTrue(byRule.containsKey('FLOW_HARDCODED_ID'));

      OrgScanContext last = contextAt(OrgScanState.STEP_FLOW_ANALYSIS, true);
      last.inventory = flows;
      Assert.isNull(new OrgFlowAnalysisStep().run(last, cursor));
      Assert.isTrue(last.detailUpdates.containsKey('Flow:C_Flow'));
      Assert.isFalse(last.detailUpdates.containsKey('Flow:D_No_Version'));
      Assert.isTrue(OrgIntelTestSupport.logContains(last.state, '4 flows'));
    }
  }

  @IsTest
  static void flowLogicHandlesProcessBuilderAndUnreadableDefinitions() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      tooling.flowMetadata = OrgIntelTestSupport.processBuilderMetadata();
      OrgScanModels.Component process = OrgIntelTestSupport.component(
        'Flow',
        'Contact_Process',
        'Contact',
        new Map<String, Object>{ 'latestVersionId' => '301000000000002' }
      );
      OrgScanContext ctx = contextAt(OrgScanState.STEP_FLOW_ANALYSIS, true);
      ctx.inventory = new List<OrgScanModels.Component>{ process };
      new OrgFlowAnalysisStep().run(ctx, null);
      Assert.isTrue(
        OrgIntelTestSupport.findingsByRule(ctx)
          .containsKey('FLOW_AFTER_SAVE_SAME_RECORD')
      );

      tooling.emptyFlowMetadata = true;
      OrgScanContext empty = contextAt(OrgScanState.STEP_FLOW_ANALYSIS, true);
      empty.inventory = new List<OrgScanModels.Component>{ process };
      new OrgFlowAnalysisStep().run(empty, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(empty.state, 'could not be read')
      );

      tooling.failQueries = true;
      OrgScanContext failing = contextAt(OrgScanState.STEP_FLOW_ANALYSIS, true);
      failing.inventory = new List<OrgScanModels.Component>{ process };
      new OrgFlowAnalysisStep().run(failing, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(failing.state, 'could not be read')
      );

      OrgScanContext noTooling = contextAt(
        OrgScanState.STEP_FLOW_ANALYSIS,
        false
      );
      new OrgFlowAnalysisStep().run(noTooling, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(noTooling.state, 'not available')
      );
      OrgScanContext failedInventory = contextAt(
        OrgScanState.STEP_FLOW_ANALYSIS,
        true
      );
      failedInventory.state.failedSteps.add(OrgScanState.STEP_FLOWS);
      new OrgFlowAnalysisStep().run(failedInventory, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(
          failedInventory.state,
          'inventory failed'
        )
      );
    }
  }

  @IsTest
  static void largeFlowDetailsAreReducedWithoutBreakingJson() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      List<Object> nodes = new List<Object>();
      for (Integer i = 0; i < 800; i++) {
        nodes.add(
          new Map<String, Object>{
            'id' => 'Node_' + i,
            'label' => 'A rather long label for node number ' + i
          }
        );
      }
      Map<String, Object> details = new Map<String, Object>{
        'label' => 'Big',
        'model' => new Map<String, Object>{
          'nodes' => nodes,
          'edges' => new List<Object>(),
          'writes' => new List<Object>{
            new Map<String, Object>{ 'fields' => new List<Object>{ 'A' } }
          },
          'timing' => 'After save'
        }
      };
      Map<String, Object> reduced = OrgFlowAnalysisStep.fitDetails(details);
      Map<String, Object> model = (Map<String, Object>) reduced.get('model');
      Assert.isTrue((Boolean) model.get('truncated'));
      Assert.areEqual(800, model.get('nodesCount'));
      Assert.areEqual('After save', model.get('timing'));
      Assert.isTrue(JSON.serialize(reduced).length() <= 32000);

      // Détails sans modèle : rien à réduire
      Map<String, Object> noModel = new Map<String, Object>{ 'nodes' => nodes };
      Assert.isFalse(
        OrgFlowAnalysisStep.fitDetails(noModel).containsKey('model')
      );

      // Modèle dont le reste ne tient pas : retiré en dernier recours
      Map<String, Object> hopeless = new Map<String, Object>{
        'model' => new Map<String, Object>{ 'label' => 'x'.repeat(40000) }
      };
      Map<String, Object> omitted = OrgFlowAnalysisStep.fitDetails(hopeless);
      Assert.isTrue((Boolean) omitted.get('modelOmitted'));
      Assert.isFalse(omitted.containsKey('model'));
    }
  }

  // ---------- Modèle de données ----------

  @IsTest
  static void objectsAndFieldsArePaged() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgObjectFieldCollector.entitiesPerPage = 40;
      OrgScanContext ctx = contextAt(OrgScanState.STEP_OBJECTS_FIELDS, true);
      String cursor = new OrgObjectFieldCollector().run(ctx, null);
      Assert.isNotNull(cursor, 'plus de 40 objets personnalisables');
      Assert.areEqual('40', cursor);
      for (OrgScanModels.Component component : ctx.discoveredComponents()) {
        Assert.isTrue(
          component.componentType == 'CustomObject' ||
            component.componentType == 'CustomField'
        );
      }
      Assert.isTrue(
        ctx.state.evaluatedRules.contains('FIELD_MISSING_DESCRIPTION')
      );
    }
  }

  @IsTest
  static void validationRulesAreReadWithTheirFormula() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      OrgValidationRuleCollector.rulesPerPage = 1;
      tooling.validationRules = new List<Map<String, Object>>{
        OrgIntelTestSupport.validationRuleRow(
          '03d000000000001',
          'Opportunity',
          'Amount_Check',
          true
        ),
        OrgIntelTestSupport.validationRuleRow(
          '03d000000000002',
          'Opportunity',
          'Old_Rule',
          false
        )
      };
      OrgScanContext ctx = contextAt(OrgScanState.STEP_VALIDATION_RULES, true);
      String cursor = new OrgValidationRuleCollector().run(ctx, null);
      Assert.areEqual('1', cursor);
      OrgScanModels.Component rule = ctx.discoveredComponents()[0];
      Assert.areEqual('Opportunity.Amount_Check', rule.apiName);
      Assert.isTrue(((String) rule.details.get('formula')).contains('Amount'));
      Assert.isNotNull(rule.lastModifiedDate);
      Assert.isTrue(OrgIntelTestSupport.logContains(ctx.state, '2 unmanaged'));

      tooling.failValidationMetadata = true;
      OrgScanContext next = contextAt(OrgScanState.STEP_VALIDATION_RULES, true);
      Assert.isNull(new OrgValidationRuleCollector().run(next, cursor));
      Assert.isFalse(next.discoveredComponents()[0].isActive);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(next.state, 'could not be read')
      );
      Assert.isTrue(
        OrgIntelTestSupport.findingsByRule(next).containsKey('VR_INACTIVE')
      );

      OrgScanContext noTooling = contextAt(
        OrgScanState.STEP_VALIDATION_RULES,
        false
      );
      Assert.isNull(new OrgValidationRuleCollector().run(noTooling, null));
      Assert.isTrue(
        OrgIntelTestSupport.logContains(noTooling.state, 'not available')
      );
    }
  }

  @IsTest
  static void dependenciesAreGroupedByComponent() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      tooling.dependencyRows = new List<Map<String, Object>>{
        OrgIntelTestSupport.dependencyRow(
          'ApexClass',
          'AccountService',
          'ApexClass',
          'Logger'
        ),
        OrgIntelTestSupport.dependencyRow(
          'Flow',
          'My_Flow',
          'ApexClass',
          'Logger'
        )
      };
      OrgScanContext ctx = contextAt(OrgScanState.STEP_DEPENDENCIES, true);
      Assert.isNull(new OrgDependencyCollector().run(ctx, null));
      Map<String, Object> logger = ctx.dependencyUpdates.get(
        'ApexClass:Logger'
      );
      Assert.areEqual(
        new List<String>{ 'ApexClass:AccountService', 'Flow:My_Flow' },
        (List<String>) logger.get('usedBy')
      );
      Assert.areEqual(
        new List<String>{ 'ApexClass:Logger' },
        (List<String>) ctx.dependencyUpdates.get('Flow:My_Flow').get('uses')
      );
      Assert.isTrue(
        OrgIntelTestSupport.logContains(ctx.state, 'dependency links')
      );

      OrgScanContext noTooling = contextAt(
        OrgScanState.STEP_DEPENDENCIES,
        false
      );
      new OrgDependencyCollector().run(noTooling, null);
      Assert.isTrue(
        OrgIntelTestSupport.logContains(noTooling.state, 'not available')
      );
    }
  }

  @IsTest
  static void truncatedDependenciesAreReported() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      List<Map<String, Object>> rows = new List<Map<String, Object>>();
      for (Integer i = 0; i < OrgDependencyCollector.API_ROW_LIMIT; i++) {
        rows.add(
          OrgIntelTestSupport.dependencyRow(
            'ApexClass',
            'Caller' + Math.mod(i, 5),
            'ApexClass',
            'Target' + i
          )
        );
      }
      tooling.dependencyRows = rows;
      OrgScanContext ctx = contextAt(OrgScanState.STEP_DEPENDENCIES, true);
      new OrgDependencyCollector().run(ctx, null);
      Assert.isTrue(OrgIntelTestSupport.logContains(ctx.state, 'truncated'));
      List<String> uses = (List<String>) ctx.dependencyUpdates.get(
          'ApexClass:Caller0'
        )
        .get('uses');
      Assert.isTrue(uses.size() <= 200, 'liste bornée');
    }
  }

  // ---------- Stockage ----------

  @IsTest
  static void storageUsesRecordCountApiAndRaisesFindings() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgIntelTestSupport.overrideRule('STORAGE_DATA_NEAR_LIMIT', 0);
      OrgIntelTestSupport.overrideRule('STORAGE_FILE_NEAR_LIMIT', 0);
      OrgIntelTestSupport.overrideRule('STORAGE_LARGE_OBJECT', 0);
      OrgIntelTestSupport.overrideRule('STORAGE_ACTIVITY_VOLUME', 1000);
      OrgIntelTestSupport.overrideRule('STORAGE_OLD_FILE_VERSIONS', 0);
      OrgIntelTestSupport.overrideRule('STORAGE_LARGE_FILES', 0);
      insert new ContentVersion(
        Title = 'Specification',
        PathOnClient = 'spec.txt',
        VersionData = Blob.valueOf('Org Intelligence test file')
      );

      OrgScanContext ctx = contextAt(OrgScanState.STEP_STORAGE, true);
      Assert.isNull(new OrgStorageStep().run(ctx, null));
      Map<String, Object> storage = (Map<String, Object>) ctx.scanValues.get(
        'storage'
      );
      Map<String, Object> snapshot = (Map<String, Object>) storage.get(
        'snapshot'
      );
      Assert.areEqual('Record Count API', snapshot.get('countSource'));
      Map<String, Object> files = (Map<String, Object>) snapshot.get('files');
      Assert.isTrue(((List<Object>) files.get('largest')).size() >= 1);

      Map<String, List<OrgScanModels.Finding>> byRule = OrgIntelTestSupport.findingsByRule(
        ctx
      );
      Assert.isTrue(byRule.containsKey('STORAGE_LARGE_OBJECT'), 'Account');
      Assert.isTrue(byRule.containsKey('STORAGE_ACTIVITY_VOLUME'), 'Task');
      Assert.isTrue(byRule.containsKey('STORAGE_OLD_FILE_VERSIONS'));
      Assert.isTrue(byRule.containsKey('STORAGE_LARGE_FILES'));
    }
  }

  @IsTest
  static void storageFallsBackToSoqlCounts() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      tooling.failRest = true;
      OrgScanContext ctx = contextAt(OrgScanState.STEP_STORAGE, true);
      Test.startTest();
      new OrgStorageStep().run(ctx, null);
      Test.stopTest();
      Map<String, Object> snapshot = (Map<String, Object>) ((Map<String, Object>) ctx.scanValues.get(
          'storage'
        ))
        .get('snapshot');
      Assert.areEqual('SOQL COUNT()', snapshot.get('countSource'));
      Assert.isTrue(
        OrgIntelTestSupport.logContains(ctx.state, 'falling back to SOQL')
      );
    }
  }

  @IsTest
  static void storageLogObjectGrowth() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      // Objet personnalisé « technique » de l'org de test, s'il existe : sinon la règle est évaluée sans constat
      List<EntityDefinition> logObjects = [
        SELECT QualifiedApiName
        FROM EntityDefinition
        WHERE IsCustomizable = TRUE AND IsCustomSetting = FALSE
        LIMIT 2000
      ];
      String logObject;
      for (EntityDefinition entity : logObjects) {
        if (
          entity.QualifiedApiName.endsWith('__c') &&
          entity.QualifiedApiName.containsIgnoreCase('log')
        ) {
          logObject = entity.QualifiedApiName;
          break;
        }
      }
      tooling.recordCountBody = JSON.serialize(
        new Map<String, Object>{
          'sObjects' => new List<Object>{
            new Map<String, Object>{
              'name' => logObject == null ? 'Account' : logObject,
              'count' => 50000
            }
          }
        }
      );
      OrgIntelTestSupport.overrideRule('STORAGE_LOG_OBJECT_GROWTH', 100);
      OrgScanContext ctx = contextAt(OrgScanState.STEP_STORAGE, true);
      new OrgStorageStep().run(ctx, null);
      Assert.isTrue(
        ctx.state.evaluatedRules.contains('STORAGE_LOG_OBJECT_GROWTH')
      );
      Assert.areEqual(
        logObject != null,
        OrgIntelTestSupport.findingsByRule(ctx)
          .containsKey('STORAGE_LOG_OBJECT_GROWTH')
      );
    }
  }

  // ---------- Règles croisées ----------

  @IsTest
  static void crossRulesCombineInventories() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.useFakeTooling();
      OrgScanContext ctx = contextAt(OrgScanState.STEP_CROSS_RULES, true);
      OrgScanModels.Component unorderedA = OrgIntelTestSupport.analysedFlow(
        'Account_Writes_Contact',
        'Account',
        'Contact'
      );
      OrgScanModels.Component unorderedB = OrgIntelTestSupport.analysedFlow(
        'Account_Second_Flow',
        'Account',
        'Opportunity'
      );
      OrgScanModels.Component back = OrgIntelTestSupport.analysedFlow(
        'Contact_Writes_Account',
        'Contact',
        'Account'
      );
      OrgScanModels.Component accountTrigger = OrgIntelTestSupport.component(
        'ApexTrigger',
        'AccountTrigger',
        'Account',
        new Map<String, Object>{
          'events' => new List<Object>{ 'after update' }
        }
      );
      OrgScanModels.Component process = OrgIntelTestSupport.component(
        'Flow',
        'Account_Process',
        'Account',
        new Map<String, Object>{ 'processType' => 'Workflow' }
      );
      OrgScanModels.Component screenFlow = OrgIntelTestSupport.component(
        'Flow',
        'Screen',
        'Account',
        new Map<String, Object>{ 'processType' => 'Flow' }
      );
      OrgScanModels.Component inactiveTrigger = OrgIntelTestSupport.component(
        'ApexTrigger',
        'Disabled',
        'Contact',
        null
      );
      inactiveTrigger.isActive = false;
      OrgScanModels.Component rule = OrgIntelTestSupport.component(
        'ValidationRule',
        'Account.Name_Check',
        'Account',
        new Map<String, Object>{ 'formula' => 'ISBLANK(Name)' }
      );
      ctx.inventory = new List<OrgScanModels.Component>{
        unorderedA,
        unorderedB,
        back,
        accountTrigger,
        process,
        screenFlow,
        inactiveTrigger,
        rule
      };
      Assert.isNull(new OrgCrossRulesStep().run(ctx, null));

      Map<String, List<OrgScanModels.Finding>> byRule = OrgIntelTestSupport.findingsByRule(
        ctx
      );
      OrgScanModels.Finding mixed = byRule.get('AUTOMATION_MIXED_ON_OBJECT')[0];
      Assert.areEqual('Account', mixed.componentName);
      Assert.isTrue(mixed.title.contains('Apex trigger'), mixed.title);
      Assert.isTrue(mixed.affectedComponents.contains('Account_Process'));
      Assert.isTrue(byRule.containsKey('FLOW_SAME_TIMING_NO_ORDER'));
      Assert.isTrue(byRule.containsKey('AUTOMATION_RECURSION_RISK'));
      Assert.isTrue(byRule.containsKey('VR_WITHOUT_BYPASS'));
    }
  }

  @IsTest
  static void mixedAutomationNeedsBothInventories() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgScanContext ctx = contextAt(OrgScanState.STEP_CROSS_RULES, false);
      ctx.state.failedSteps.add(OrgScanState.STEP_FLOWS);
      new OrgCrossRulesStep().run(ctx, null);
      Assert.isTrue(OrgIntelTestSupport.logContains(ctx.state, 'skipped'));
      Assert.isTrue(ctx.discoveredFindings().isEmpty());
    }
  }

  // ---------- État et contexte ----------

  @IsTest
  static void stateTracksStepsAndReliableRules() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgScanState state = new OrgScanState();
      Assert.areEqual(0, state.progressPercent());
      state.steps = OrgScanState.stepsFor(
        new Set<String>{ 'Flow', 'ValidationRule' }
      );
      Assert.areEqual(
        new List<String>{
          OrgScanState.STEP_PREPARE,
          OrgScanState.STEP_FLOWS,
          OrgScanState.STEP_FLOW_ANALYSIS,
          OrgScanState.STEP_VALIDATION_RULES,
          OrgScanState.STEP_CROSS_RULES
        },
        state.steps
      );
      Assert.areEqual('Preparing', state.currentStepLabel());
      state.addLog(OrgScanModels.LEVEL_INFO, 'started');
      Assert.areEqual('Preparing', state.log[0].step);
      state.evaluatedRules.add('FLOW_DML_IN_LOOP');
      state.ruleSteps.put('FLOW_DML_IN_LOOP', OrgScanState.STEP_FLOW_ANALYSIS);
      state.evaluatedRules.add('VR_INACTIVE');
      state.ruleSteps.put('VR_INACTIVE', OrgScanState.STEP_VALIDATION_RULES);
      state.failedSteps.add(OrgScanState.STEP_FLOW_ANALYSIS);
      Assert.areEqual(
        new Set<String>{ 'VR_INACTIVE' },
        state.reliablyEvaluatedRules()
      );
      Assert.isFalse(state.isStepSuccessful(OrgScanState.STEP_FLOW_ANALYSIS));
      Assert.isFalse(state.isStepSuccessful(OrgScanState.STEP_STORAGE));
      Assert.isTrue(state.hasStep(OrgScanState.STEP_FLOWS));
      state.cursor = '30';
      state.advance();
      Assert.isNull(state.cursor);
      Assert.areEqual(20, state.progressPercent());
      state.stepIndex = state.steps.size();
      Assert.isTrue(state.isFinished());
      Assert.isNull(state.currentStep());
      Assert.isNull(state.currentStepLabel());
      state.addLog(OrgScanModels.LEVEL_INFO, 'done');
      Assert.areEqual('Scan', state.log[1].step);
      Assert.isNull(new OrgScanModels.LogEntry().step);
    }
  }

  @IsTest
  static void contextBuffersAndRules() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgScanContext ctx = OrgIntelTestSupport.context(
        new List<String>{ OrgScanState.STEP_CROSS_RULES },
        true
      );
      Assert.isFalse(ctx.beginRule('NO_SUCH_RULE'));
      Assert.areEqual(7, ctx.threshold('NO_SUCH_RULE', 7));
      ctx.info('info');
      ctx.warning('warning');
      ctx.error('error');
      Assert.areEqual(3, ctx.state.log.size());
      OrgScanModels.Component component = new OrgScanModels.Component(
        'ApexClass',
        'Foo'
      );
      ctx.addComponents(new List<OrgScanModels.Component>{ component });
      OrgScanModels.Finding finding = ctx.newFinding(
        'APEX_HARDCODED_ID',
        component,
        'title'
      );
      Assert.areEqual('ApexClass:Foo', finding.componentKey);
      Assert.areEqual('APEX_HARDCODED_ID|ApexClass:Foo', finding.fingerprint());
      ctx.addFindings(new List<OrgScanModels.Finding>{ finding });
      ctx.updateDetails(component.key(), new Map<String, Object>{ 'a' => 1 });
      ctx.setDependencies(component.key(), new Map<String, Object>());
      ctx.setScanValue('x', 1);
      Assert.areEqual(1, ctx.discoveredComponents().size());
      Assert.areEqual(1, ctx.discoveredFindings().size());
      Assert.areEqual(1, ctx.detailUpdates.size());
      Assert.areEqual(1, ctx.dependencyUpdates.size());
      Assert.areEqual(1, ctx.scanValues.get('x'));
      ctx.inventory.add(component);
      Assert.areEqual(1, ctx.inventoryOf('ApexClass').size());
      Assert.areEqual(0, ctx.inventoryOf('Flow').size());
    }
  }
}
