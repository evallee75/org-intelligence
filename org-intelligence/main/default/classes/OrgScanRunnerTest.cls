/**
 * Scan piloté par le navigateur (OrgScanRunner, via OrgIntelligenceController) : démarrage, boucle
 * des étapes avec l'inventaire renvoyé, étape en échec, scan terminé, droits.
 */
@IsTest
private class OrgScanRunnerTest {
  /**
   * Joue le rôle du navigateur : appelle runScanStep jusqu'à la fin, renvoie aux étapes l'inventaire
   * qu'elles demandent, et passe à l'étape suivante dès la deuxième page (scan borné pour le test).
   */
  private static List<Map<String, Object>> runAllSteps(
    Map<String, Object> started,
    List<Map<String, Object>> extraInventory
  ) {
    Map<String, Object> needs = (Map<String, Object>) started.get(
      'inventoryNeeds'
    );
    Object state = started.get('state');
    List<Map<String, Object>> inventory = new List<Map<String, Object>>(
      extraInventory
    );
    List<Map<String, Object>> results = new List<Map<String, Object>>();
    for (Integer guard = 0; guard < 30; guard++) {
      Map<String, Object> stateMap = (Map<String, Object>) JSON.deserializeUntyped(
        JSON.serialize(state)
      );
      List<Object> steps = (List<Object>) stateMap.get('steps');
      Integer index = Integer.valueOf(stateMap.get('stepIndex'));
      if (index >= steps.size()) {
        break;
      }
      String step = (String) steps[index];
      String inventoryJson = null;
      if (needs.containsKey(step)) {
        Set<String> types = new Set<String>();
        for (Object type : (List<Object>) needs.get(step)) {
          types.add((String) type);
        }
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        for (Map<String, Object> row : inventory) {
          if (types.contains((String) row.get('componentType'))) {
            rows.add(row);
          }
        }
        inventoryJson = JSON.serialize(rows);
      }
      Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
        OrgIntelligenceController.runScanStep(
          JSON.serialize(stateMap),
          inventoryJson
        )
      );
      results.add(result);
      for (Object component : (List<Object>) result.get('components')) {
        inventory.add((Map<String, Object>) component);
      }
      Map<String, Object> next = (Map<String, Object>) result.get('state');
      if (next.get('cursor') != null) {
        // Étape sur plusieurs pages : le test passe directement à la suivante
        next.put('cursor', null);
        next.put('stepIndex', Integer.valueOf(next.get('stepIndex')) + 1);
      }
      state = next;
    }
    return results;
  }

  private static Map<String, Object> inventoryRow(
    String type,
    String name,
    String parentName,
    Map<String, Object> details
  ) {
    return new Map<String, Object>{
      'componentType' => type,
      'apiName' => name,
      'parentName' => parentName,
      'metadataId' => '301000000000001',
      'apiVersion' => 50,
      'isActive' => true,
      'details' => details
    };
  }

  @IsTest
  static void fullScanRunsEveryStep() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.withoutModules();
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      tooling.validationRules = new List<Map<String, Object>>{
        OrgIntelTestSupport.validationRuleRow(
          '03d000000000001',
          'Opportunity',
          'Amount_Check',
          true
        )
      };
      tooling.dependencyRows = new List<Map<String, Object>>{
        OrgIntelTestSupport.dependencyRow(
          'Flow',
          'My_Flow',
          'ApexClass',
          'Logger'
        )
      };
      OrgApexClassCollector.pageSize = 5;
      OrgObjectFieldCollector.entitiesPerPage = 10;

      Test.startTest();
      Map<String, Object> started = (Map<String, Object>) JSON.deserializeUntyped(
        OrgIntelligenceController.startScan(OrgScanRunner.SCOPES)
      );
      Assert.areEqual(
        OrgScanRunner.SCOPES.size(),
        ((List<Object>) started.get('scope')).size()
      );
      Assert.isFalse(((List<Object>) started.get('rules')).isEmpty());
      Assert.isNotNull(started.get('scoreConfig'));

      List<Map<String, Object>> results = runAllSteps(
        started,
        new List<Map<String, Object>>{
          inventoryRow(
            'Flow',
            'AAA_Scan_Test_Flow',
            'Opportunity',
            new Map<String, Object>{
              'activeVersionId' => '301000000000001',
              'processType' => 'AutoLaunchedFlow',
              'triggerType' => 'RecordAfterSave'
            }
          ),
          inventoryRow(
            'ApexTrigger',
            'OpportunityTrigger',
            'Opportunity',
            new Map<String, Object>{
              'events' => new List<Object>{ 'after update' }
            }
          )
        }
      );
      Test.stopTest();

      Set<String> steps = new Set<String>();
      Set<String> rules = new Set<String>();
      Boolean finished = false;
      for (Map<String, Object> result : results) {
        steps.add((String) result.get('step'));
        for (Object finding : (List<Object>) result.get('findings')) {
          Map<String, Object> row = (Map<String, Object>) finding;
          rules.add((String) row.get('ruleCode'));
          Assert.isNotNull(row.get('fingerprint'));
          Assert.isNotNull(row.get('domain'));
        }
        finished = finished || result.get('finished') == true;
      }
      Assert.isTrue(finished, 'le scan se termine');
      Assert.isTrue(steps.contains(OrgScanState.STEP_PREPARE));
      Assert.isTrue(steps.contains(OrgScanState.STEP_FLOW_ANALYSIS));
      Assert.isTrue(steps.contains(OrgScanState.STEP_STORAGE));
      Assert.isTrue(steps.contains(OrgScanState.STEP_CROSS_RULES));
      Assert.isTrue(rules.contains('FLOW_DML_IN_LOOP'), String.valueOf(rules));
      Map<String, Object> last = results[results.size() - 1];
      Assert.areEqual(100, last.get('progress'));
      Assert.isFalse(((List<Object>) last.get('reliableRules')).isEmpty());
    }
  }

  @IsTest
  static void failingStepIsMarkedAndScanContinues() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.withoutModules();
      OrgIntelTestSupport.FakeTooling tooling = OrgIntelTestSupport.useFakeTooling();
      OrgScanState state = new OrgScanState();
      state.steps = new List<String>{
        OrgScanState.STEP_VALIDATION_RULES,
        OrgScanState.STEP_CROSS_RULES
      };
      state.toolingAvailable = true;
      tooling.failQueries = true;

      Map<String, Object> result = OrgScanRunner.runStep(
        JSON.serialize(state),
        null
      );
      OrgScanState next = (OrgScanState) result.get('state');
      Assert.isTrue(
        next.failedSteps.contains(OrgScanState.STEP_VALIDATION_RULES)
      );
      Assert.areEqual(1, next.stepIndex);
      Assert.areEqual('Cross-component rules', result.get('nextStepLabel'));
      List<OrgScanModels.LogEntry> log = (List<OrgScanModels.LogEntry>) result.get(
        'log'
      );
      Assert.isTrue(log[0].message.startsWith('Step failed'));
      Assert.isTrue(((List<Object>) result.get('components')).isEmpty());

      next.stepIndex = next.steps.size();
      try {
        OrgScanRunner.runStep(JSON.serialize(next), null);
        Assert.fail('Expected a ScanException');
      } catch (OrgScanRunner.ScanException e) {
        Assert.isTrue(e.getMessage().contains('already finished'));
      }
    }
  }

  @IsTest
  static void inventoryIsReadUntyped() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      List<OrgScanModels.Component> components = OrgScanRunner.parseInventory(
        JSON.serialize(
          new List<Object>{
            inventoryRow(
              'ApexClass',
              'Foo',
              null,
              new Map<String, Object>{ 'isTest' => true }
            ),
            new Map<String, Object>{
              'componentType' => 'Flow',
              'apiName' => 'Bar',
              'isActive' => false,
              'details' => 'not a map'
            }
          }
        )
      );
      Assert.areEqual(2, components.size());
      Assert.areEqual(50, components[0].apiVersion);
      Assert.areEqual(true, components[0].details.get('isTest'));
      Assert.isFalse(components[1].isActive);
      Assert.isNull(components[1].apiVersion);
      Assert.isTrue(components[1].details.isEmpty());
      Assert.isTrue(
        OrgScanRunner.describe(new IllegalArgumentException('boom'))
          .contains('boom')
      );
    }
  }

  @IsTest
  static void startRequiresAScopeAndAnAdmin() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      try {
        OrgIntelligenceController.startScan(new List<String>{ 'Nothing' });
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('at least one area'));
      }
      try {
        OrgIntelligenceController.runScanStep('not json', null);
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('scan step failed'));
      }
      try {
        OrgScanRunner.start(null);
        Assert.fail('Expected a ScanException');
      } catch (OrgScanRunner.ScanException e) {
        Assert.isNotNull(e.getMessage());
      }
    }
    System.runAs(OrgIntelTestSupport.readerUser()) {
      try {
        OrgIntelligenceController.startScan(OrgScanRunner.SCOPES);
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('administrators'));
      }
    }
  }
}
