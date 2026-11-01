/**
 * Analyse des définitions de flows (OrgFlowAnalyzer) et graphe des automatisations
 * (OrgAutomationGraph) sur des définitions construites à la main.
 */
@IsTest
private class OrgFlowAnalyzerTest {
  private static OrgFlowAnalyzer.FlowModel analyse(
    Map<String, Object> metadata
  ) {
    return new OrgFlowAnalyzer(metadata, JSON.serialize(metadata)).model;
  }

  private static OrgFlowAnalyzer.DataAccess write(
    OrgFlowAnalyzer.FlowModel model,
    String element
  ) {
    for (OrgFlowAnalyzer.DataAccess access : model.writes) {
      if (access.element == element) {
        return access;
      }
    }
    return null;
  }

  @IsTest
  static void afterSaveFlowModel() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgFlowAnalyzer.FlowModel model = analyse(
        OrgIntelTestSupport.afterSaveFlowMetadata()
      );

      Assert.areEqual('Opportunity', model.triggerObject);
      Assert.areEqual('After save', model.timing);
      Assert.areEqual('CreateAndUpdate', model.triggerEvent);
      Assert.isTrue(model.isRecordTriggered);
      Assert.isFalse(model.hasEntryCriteria);
      Assert.areEqual(1, model.scheduledPaths);
      Assert.areEqual(1, model.inputs.size(), 'recordId en entrée');
      Assert.areEqual(1, model.outputs.size(), 'accountVar en sortie');
      Assert.areEqual('SObject (Account)', model.outputs[0].dataType);
      Assert.isTrue(model.reads.contains('OpportunityLineItem'));
      Assert.isTrue(model.subflows.contains('Child_Flow'));
      Assert.isTrue(model.apexActions.contains('ErrorLogger'));
      Assert.isTrue(model.otherActions.contains('emailSimple: emailSimple'));

      // Écritures : variable de boucle, $Record, filtre sur $Record.Id, variable affectée
      Assert.areEqual(
        'OpportunityLineItem',
        write(model, 'Update line').objectName
      );
      OrgFlowAnalyzer.DataAccess sameRecord = write(
        model,
        'Update opportunity'
      );
      Assert.isTrue(sameRecord.sameRecord);
      Assert.areEqual('Opportunity', sameRecord.objectName);
      Assert.areEqual(new List<String>{ 'StageName' }, sameRecord.fields);
      Assert.isTrue(write(model, 'Update account').sameRecord);
      OrgFlowAnalyzer.DataAccess fromVariable = write(
        model,
        'Update_Account_Var'
      );
      Assert.areEqual('Account', fromVariable.objectName);
      Assert.areEqual(new List<String>{ 'Rating' }, fromVariable.fields);
      Assert.areEqual('Task', write(model, 'Create task').objectName);
      Assert.areEqual('Delete', write(model, 'Delete_Old').operation);

      // Boucle : requête et mise à jour dans le corps, pas l'élément après la boucle
      String inLoop = String.join(model.costlyInLoop, '\n');
      Assert.isTrue(inLoop.contains('Get_Owner (Get Records)'), inLoop);
      Assert.isTrue(inLoop.contains('Update line (Update Records)'), inLoop);
      Assert.isFalse(inLoop.contains('Update opportunity'), inLoop);

      // Chemins d'erreur : écritures et actions sans faultConnector (pas les requêtes)
      Assert.isTrue(model.missingFaultPaths.contains('Update opportunity'));
      Assert.isTrue(model.missingFaultPaths.contains('Create task'));
      Assert.isFalse(model.missingFaultPaths.contains('Update account'));
      Assert.isFalse(model.missingFaultPaths.contains('Get Lines'));

      Assert.areEqual(
        new List<String>{ '005AB0000012345' },
        model.hardcodedIds
      );
      Assert.isTrue(model.elementCount > 10);
      Assert.areEqual(4, model.elementCounts.get('recordUpdates'));

      // Logigramme : départ, chemins planifiés, règles, boucle, attente, chemin d'erreur
      Assert.areEqual('START', model.nodes[0].id);
      Assert.isTrue(model.nodes[0].label.contains('Opportunity'));
      Set<String> labels = new Set<String>();
      Boolean hasFault = false;
      for (OrgFlowAnalyzer.DiagramEdge edge : model.edges) {
        labels.add(edge.label);
        hasFault = hasFault || edge.fault;
      }
      Assert.isTrue(labels.contains('One day later'));
      Assert.isTrue(labels.contains('Has owner'));
      Assert.isTrue(labels.contains('Default'));
      Assert.isTrue(labels.contains('For each'));
      Assert.isTrue(labels.contains('After last'));
      Assert.isTrue(labels.contains('Tomorrow'));
      Assert.isTrue(hasFault);
    }
  }

  @IsTest
  static void beforeSaveFlowWithCriteria() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgFlowAnalyzer.FlowModel model = analyse(
        OrgIntelTestSupport.beforeSaveFlowMetadata(10)
      );
      Assert.areEqual('Before save', model.timing);
      Assert.areEqual(10, model.triggerOrder);
      Assert.isTrue(model.hasEntryCriteria);
      Assert.isTrue(model.entryCriteria.contains(' OR '), model.entryCriteria);
      Assert.isTrue(model.entryCriteria.contains('Rating EqualTo Hot'));
      Assert.isTrue(model.entryCriteria.contains('IsDeleted EqualTo false'));
      OrgFlowAnalyzer.DataAccess access = write(
        model,
        'Assignments to $Record'
      );
      Assert.isNotNull(access, 'affectations sur $Record = écriture');
      Assert.areEqual('Account', access.objectName);
      Assert.areEqual(new List<String>{ 'Industry', 'Rating' }, access.fields);
    }
  }

  @IsTest
  static void processBuilderModel() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgFlowAnalyzer.FlowModel model = analyse(
        OrgIntelTestSupport.processBuilderMetadata()
      );
      Assert.areEqual('Process Builder', model.timing);
      Assert.areEqual('Contact', model.triggerObject);
      Assert.areEqual('CreateAndUpdate', model.triggerEvent);
      Assert.isTrue(model.hasEntryCriteria);
      Assert.isTrue(model.entryCriteria.contains('Is VIP'));
      Assert.isTrue(model.entryCriteria.contains('ISCHANGED'));
      Assert.areEqual(0, model.inputs.size(), 'variables techniques ignorées');
      OrgFlowAnalyzer.DataAccess access = write(model, 'myRule_1_A1');
      Assert.isTrue(access.sameRecord);
      Assert.areEqual('Contact', access.objectName);
      // Départ par startElementReference (ancien format)
      Assert.areEqual('myDecision', model.edges[0].target);
    }
  }

  @IsTest
  static void otherTriggerTypes() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      Map<String, String> expected = new Map<String, String>{
        'RecordBeforeDelete' => 'Before delete',
        'Scheduled' => 'Scheduled',
        'PlatformEvent' => 'Platform event',
        'Unknown' => 'Invoked'
      };
      for (String triggerType : expected.keySet()) {
        OrgFlowAnalyzer.FlowModel model = analyse(
          new Map<String, Object>{
            'processType' => 'AutoLaunchedFlow',
            'start' => new Map<String, Object>{
              'object' => 'Case',
              'triggerType' => triggerType,
              'filterFormula' => '  ISNEW()  '
            }
          }
        );
        Assert.areEqual(expected.get(triggerType), model.timing);
        Assert.isTrue(model.hasEntryCriteria);
      }
      Assert.areEqual(
        'Delete',
        analyse(
            new Map<String, Object>{
              'start' => new Map<String, Object>{
                'triggerType' => 'RecordBeforeDelete'
              }
            }
          )
          .triggerEvent
      );
      Assert.areEqual(
        'Screen flow',
        analyse(new Map<String, Object>{ 'processType' => 'Flow' }).timing
      );
      Assert.areEqual(
        'Invoked',
        analyse(new Map<String, Object>{ 'processType' => 'AutoLaunchedFlow' })
          .timing
      );
      Assert.areEqual(
        'Screen flow',
        analyse(
            new Map<String, Object>{
              'processType' => 'Flow',
              'start' => new Map<String, Object>{ 'connector' => null }
            }
          )
          .timing
      );
      OrgFlowAnalyzer.FlowModel empty = new OrgFlowAnalyzer(null, null).model;
      Assert.areEqual(1, empty.nodes.size(), 'seul le départ');
      Assert.isTrue(empty.hardcodedIds.isEmpty());
    }
  }

  @IsTest
  static void graphLoadsAutomationsAndFindsCycles() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      List<OrgScanModels.Component> components = new List<OrgScanModels.Component>{
        OrgIntelTestSupport.analysedFlow(
          'Account_Writes_Contact',
          'Account',
          'Contact'
        ),
        OrgIntelTestSupport.analysedFlow(
          'Contact_Writes_Account',
          'Contact',
          'Account'
        ),
        OrgIntelTestSupport.analysedFlow('Case_Writes_Case', 'Case', 'Case'),
        OrgIntelTestSupport.component(
          'Flow',
          'Old_Process',
          'Lead',
          new Map<String, Object>{ 'processType' => 'Workflow' }
        ),
        OrgIntelTestSupport.component(
          'Flow',
          'Not_Analysed',
          'Lead',
          new Map<String, Object>{ 'triggerType' => 'RecordAfterSave' }
        ),
        OrgIntelTestSupport.component(
          'ApexTrigger',
          'AccountTrigger',
          'Account',
          new Map<String, Object>{
            'events' => new List<Object>{ 'before insert' }
          }
        ),
        OrgIntelTestSupport.component(
          'ValidationRule',
          'Account.Name_Required',
          'Account',
          null
        )
      };
      components[6].details = null;

      List<OrgAutomationGraph.Automation> automations = OrgAutomationGraph.load(
        components
      );
      Assert.areEqual(7, automations.size());
      Assert.areEqual('After save', automations[0].timing);
      Assert.areEqual(new List<String>{ 'Update' }, automations[0].events);
      Assert.isNotNull(automations[0].modelJson);
      Assert.areEqual('Process Builder', automations[3].kind);
      Assert.areEqual('Process Builder', automations[3].timing);
      Assert.areEqual('RecordAfterSave', automations[4].timing);
      Assert.areEqual('Apex trigger', automations[5].kind);
      Assert.areEqual(
        new List<String>{ 'before insert' },
        automations[5].events
      );
      Assert.areEqual('Validation rule', automations[6].kind);
      Assert.areEqual('Name_Required', automations[6].label);

      List<OrgAutomationGraph.Cycle> cycles = OrgAutomationGraph.findCycles(
        automations
      );
      Assert.areEqual(1, cycles.size(), 'Account ⇄ Contact, pas Case → Case');
      Assert.areEqual('Account>Contact', cycles[0].key);
      Assert.areEqual(
        new List<String>{ 'Account_Writes_Contact', 'Contact_Writes_Account' },
        cycles[0].automations
      );
      Assert.isTrue(cycles[0].label.contains('→'));

      Assert.areEqual(
        new List<String>{ 'Create' },
        OrgAutomationGraph.eventsOf('Create')
      );
      Assert.areEqual(
        new List<String>{ 'Create', 'Update' },
        OrgAutomationGraph.eventsOf('CreateAndUpdate')
      );
      Assert.areEqual(
        new List<String>{ 'Delete' },
        OrgAutomationGraph.eventsOf('Delete')
      );
      Assert.isTrue(OrgAutomationGraph.eventsOf(null).isEmpty());
    }
  }
}
