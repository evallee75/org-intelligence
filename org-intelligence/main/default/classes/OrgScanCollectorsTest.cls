/**
 * Collecteurs de flows, d'objets / champs et erreurs de flows : les objets de configuration
 * (FlowDefinitionView, EntityDefinition, FlowInterview...) ne s'insèrent pas en test, les lignes
 * sont donc fabriquées par désérialisation JSON et passées aux méthodes de construction.
 */
@IsTest
private class OrgScanCollectorsTest {
  private static final String FLOW_ID = '300000000000001AAA';

  private static SObject row(String sobjectName, Map<String, Object> values) {
    values.put('attributes', new Map<String, Object>{ 'type' => sobjectName });
    return (SObject) JSON.deserialize(
      JSON.serialize(values),
      Type.forName(sobjectName)
    );
  }

  private static Map<String, Object> user(String name) {
    return new Map<String, Object>{
      'attributes' => new Map<String, Object>{ 'type' => 'User' },
      'Name' => name
    };
  }

  private static FlowVersionView version(
    Integer versionNumber,
    String status,
    Decimal apiVersion
  ) {
    return (FlowVersionView) row(
      'FlowVersionView',
      new Map<String, Object>{
        'FlowDefinitionViewId' => FLOW_ID,
        'VersionNumber' => versionNumber,
        'Status' => status,
        'ApiVersion' => apiVersion
      }
    );
  }

  // ---------- Flows ----------

  @IsTest
  static void buildComponentsMapsDefinitionsAndVersions() {
    FlowDefinitionView withVersions = (FlowDefinitionView) row(
      'FlowDefinitionView',
      new Map<String, Object>{
        'DurableId' => FLOW_ID,
        'ApiName' => 'Account_Before_Save',
        'Label' => 'Account before save',
        'ProcessType' => 'AutolaunchedFlow',
        'TriggerType' => 'RecordBeforeSave',
        'RecordTriggerType' => 'Create',
        'TriggerObjectOrEventId' => 'Account',
        'IsActive' => true,
        'ActiveVersionId' => '301000000000002AAA',
        'LatestVersionId' => '301000000000003AAA',
        'Description' => 'Sets defaults',
        'LastModifiedDate' => '2025-03-01T10:00:00.000+0000',
        'LastModifiedBy' => 'Marie Durand'
      }
    );
    FlowDefinitionView withoutVersions = (FlowDefinitionView) row(
      'FlowDefinitionView',
      new Map<String, Object>{
        'DurableId' => '300000000000002AAA',
        'ApiName' => 'Orphan_Flow',
        'IsActive' => false
      }
    );

    Test.startTest();
    List<OrgScanModels.Component> components = OrgFlowCollector.buildComponents(
      new List<FlowDefinitionView>{ withVersions, withoutVersions },
      new Map<String, List<FlowVersionView>>{
        FLOW_ID => new List<FlowVersionView>{
          version(1, 'Obsolete', 58),
          version(2, 'Active', 62)
        }
      }
    );
    Test.stopTest();

    Assert.areEqual(2, components.size(), 'un composant par définition');
    OrgScanModels.Component first = components[0];
    Assert.areEqual('Flow', first.componentType);
    Assert.areEqual('Account_Before_Save', first.apiName);
    Assert.areEqual('Account', first.parentName);
    Assert.areEqual(FLOW_ID, first.metadataId);
    Assert.areEqual('Marie Durand', first.lastModifiedByName);
    Assert.areEqual('Create', first.details.get('recordTriggerType'));
    Assert.areEqual(2, first.details.get('versionCount'));
    Assert.areEqual(62, first.apiVersion, 'version d’API de la version active');
    OrgScanModels.Component second = components[1];
    Assert.isFalse(second.isActive);
    Assert.isFalse(second.details.containsKey('versionCount'));
    Assert.isNull(second.apiVersion, 'sans version, pas de version d’API');
  }

  @IsTest
  static void buildComponentsFallsBackToTheLatestVersionWithoutActiveOne() {
    FlowDefinitionView definition = (FlowDefinitionView) row(
      'FlowDefinitionView',
      new Map<String, Object>{
        'DurableId' => FLOW_ID,
        'ApiName' => 'Draft_Flow'
      }
    );
    List<OrgScanModels.Component> components = OrgFlowCollector.buildComponents(
      new List<FlowDefinitionView>{ definition },
      new Map<String, List<FlowVersionView>>{
        FLOW_ID => new List<FlowVersionView>{
          version(3, 'Draft', 64),
          version(1, 'Obsolete', 50),
          version(2, 'Obsolete', 55)
        }
      }
    );
    Assert.areEqual(64, components[0].apiVersion, 'version la plus récente');
    Assert.areEqual(3, components[0].details.get('versionCount'));
  }

  @IsTest
  static void addVersionGroupsByFlow() {
    Map<String, List<FlowVersionView>> grouped = new Map<String, List<FlowVersionView>>();
    OrgFlowCollector.addVersion(grouped, version(1, 'Active', 60));
    OrgFlowCollector.addVersion(grouped, version(2, 'Draft', 61));
    Assert.areEqual(1, grouped.size());
    Assert.areEqual(2, grouped.get(FLOW_ID).size());
  }

  @IsTest
  static void loadVersionsQueriesByChunksWithoutFailing() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      List<FlowDefinitionView> definitions = new List<FlowDefinitionView>();
      for (Integer i = 0; i < 201; i++) {
        definitions.add(
          (FlowDefinitionView) row(
            'FlowDefinitionView',
            new Map<String, Object>{
              'DurableId' => '3000000000' +
              String.valueOf(10000 + i) +
              'AAA',
              'ApiName' => 'Flow_' + i
            }
          )
        );
      }
      Test.startTest();
      Map<String, List<FlowVersionView>> result = OrgFlowCollector.loadVersions(
        definitions
      );
      Test.stopTest();
      Assert.isTrue(
        result.isEmpty(),
        'aucune version pour des flows inexistants'
      );
      Assert.isTrue(
        OrgFlowCollector.loadVersions(new List<FlowDefinitionView>()).isEmpty(),
        'liste vide sans requête'
      );
    }
  }

  @IsTest
  static void flowCollectorRunsOnAnyOrg() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgScanContext ctx = OrgIntelTestSupport.context(
        new List<String>{ OrgScanState.STEP_FLOWS },
        false
      );
      Test.startTest();
      String cursor = new OrgFlowCollector().run(ctx, null);
      Test.stopTest();
      Assert.isNull(cursor, 'une seule page');
      for (OrgScanModels.Component component : ctx.discoveredComponents()) {
        Assert.areEqual('Flow', component.componentType);
      }
    }
  }

  // ---------- Objets et champs ----------

  private static EntityDefinition entity(
    String apiName,
    String namespacePrefix
  ) {
    return (EntityDefinition) row(
      'EntityDefinition',
      new Map<String, Object>{
        'QualifiedApiName' => apiName,
        'Label' => apiName,
        'NamespacePrefix' => namespacePrefix,
        'DurableId' => '01I000000000' +
        Math.abs(apiName.hashCode()) +
        'XYZ',
        'KeyPrefix' => 'a01',
        'IsCustomSetting' => false,
        'LastModifiedDate' => '2025-02-01T08:00:00.000+0000',
        'LastModifiedBy' => user('Paul Martin')
      }
    );
  }

  private static FieldDefinition field(
    EntityDefinition parent,
    String apiName,
    String namespacePrefix,
    String description
  ) {
    return (FieldDefinition) row(
      'FieldDefinition',
      new Map<String, Object>{
        'QualifiedApiName' => apiName,
        'EntityDefinitionId' => parent.DurableId,
        'Label' => apiName,
        'Description' => description,
        'DataType' => 'Text(80)',
        'NamespacePrefix' => namespacePrefix,
        'LastModifiedDate' => '2025-02-01T08:00:00.000+0000',
        'LastModifiedBy' => user('Paul Martin')
      }
    );
  }

  @IsTest
  static void buildInventoryKeepsCustomObjectsAndStandardObjectsWithCustomFields() {
    EntityDefinition invoice = entity('Invoice__c', null);
    EntityDefinition account = entity('Account', null);
    EntityDefinition contact = entity('Contact', null);
    EntityDefinition packaged = entity('pkg__Thing__c', 'pkg');
    Map<String, EntityDefinition> page = new Map<String, EntityDefinition>();
    for (
      EntityDefinition e : new List<EntityDefinition>{
        invoice,
        account,
        contact,
        packaged
      }
    ) {
      page.put(e.DurableId, e);
    }
    List<FieldDefinition> fields = new List<FieldDefinition>{
      field(invoice, 'Amount__c', null, null),
      field(invoice, 'Name', null, null),
      field(invoice, 'pkg__Extra__c', 'pkg', null),
      field(account, 'Segment__c', null, 'Customer segment'),
      field(contact, 'Email', null, null)
    };
    OrgScanContext ctx = OrgIntelTestSupport.context(
      new List<String>{ OrgScanState.STEP_OBJECTS_FIELDS },
      false
    );

    Test.startTest();
    OrgObjectFieldCollector.buildInventory(page, fields, ctx);
    Test.stopTest();

    Map<String, OrgScanModels.Component> byName = new Map<String, OrgScanModels.Component>();
    for (OrgScanModels.Component component : ctx.discoveredComponents()) {
      byName.put(component.apiName, component);
    }
    Assert.isTrue(byName.containsKey('Invoice__c'), 'objet personnalisé');
    Assert.isTrue(
      byName.containsKey('Account'),
      'objet standard avec champ personnalisé'
    );
    Assert.isFalse(
      byName.containsKey('Contact'),
      'objet standard sans champ personnalisé'
    );
    Assert.isFalse(
      byName.containsKey('pkg__Thing__c'),
      'objet de package sans champ non géré ignoré'
    );
    Assert.areEqual(true, byName.get('Invoice__c').details.get('isCustom'));
    Assert.areEqual(false, byName.get('Account').details.get('isCustom'));
    Assert.areEqual(
      2,
      byName.get('Invoice__c').details.get('customFieldCount'),
      'champs de package comptés'
    );
    Assert.areEqual(1, byName.get('Account').details.get('customFieldCount'));
    Assert.areEqual('Paul Martin', byName.get('Invoice__c').lastModifiedByName);
    Assert.isTrue(byName.containsKey('Invoice__c.Amount__c'));
    Assert.isFalse(
      byName.containsKey('Invoice__c.pkg__Extra__c'),
      'champ de package non inventorié'
    );
    Assert.isFalse(
      byName.containsKey('Invoice__c.Name'),
      'champ standard ignoré'
    );
    Assert.areEqual(
      'Customer segment',
      byName.get('Account.Segment__c').description
    );
    Assert.areEqual('Account', byName.get('Account.Segment__c').parentName);
    Assert.isTrue(
      ctx.state.evaluatedRules.contains('FIELD_MISSING_DESCRIPTION'),
      'règles du modèle de données évaluées'
    );
  }

  @IsTest
  static void runFallsBackToOneQueryPerObjectWhenTheFieldLimitIsReached() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgObjectFieldCollector.entitiesPerPage = 20;
      OrgObjectFieldCollector.fieldQueryLimit = 1;
      OrgScanContext ctx = OrgIntelTestSupport.context(
        new List<String>{ OrgScanState.STEP_OBJECTS_FIELDS },
        false
      );
      Test.startTest();
      String cursor = new OrgObjectFieldCollector().run(ctx, null);
      Test.stopTest();
      Assert.areEqual('20', cursor, 'il reste des objets à parcourir');
    }
  }

  @IsTest
  static void runPastTheLastPageReturnsNoCursor() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgScanContext ctx = OrgIntelTestSupport.context(
        new List<String>{ OrgScanState.STEP_OBJECTS_FIELDS },
        false
      );
      Test.startTest();
      String cursor = new OrgObjectFieldCollector().run(ctx, '100000');
      Test.stopTest();
      Assert.isNull(cursor, 'plus de page');
      Assert.isTrue(ctx.discoveredComponents().isEmpty());
    }
  }

  // ---------- Erreurs de flows ----------

  @IsTest
  static void interviewsAndLogsAreGroupedByFlow() {
    FlowInterview failed = (FlowInterview) row(
      'FlowInterview',
      new Map<String, Object>{
        'Id' => '301000000000001AAA',
        'InterviewLabel' => 'Account flow 2025-03-01',
        'CurrentElement' => 'Update_Account',
        'Error' => 'x'.repeat(1500),
        'CreatedDate' => '2025-03-01T10:00:00.000+0000',
        'CreatedBy' => user('Marie Durand'),
        'FlowVersionView' => new Map<String, Object>{
          'attributes' => new Map<String, Object>{
            'type' => 'FlowVersionView'
          },
          'VersionNumber' => 3,
          'FlowDefinitionView' => new Map<String, Object>{
            'attributes' => new Map<String, Object>{
              'type' => 'FlowDefinitionView'
            },
            'ApiName' => 'Account_Flow'
          }
        }
      }
    );
    FlowInterview withoutFlow = (FlowInterview) row(
      'FlowInterview',
      new Map<String, Object>{
        'Id' => '301000000000002AAA',
        'CreatedDate' => '2025-03-01T10:00:00.000+0000'
      }
    );
    FlowInterview withoutMessage = (FlowInterview) row(
      'FlowInterview',
      new Map<String, Object>{
        'Id' => '301000000000003AAA',
        'CreatedDate' => '2025-03-02T10:00:00.000+0000',
        'FlowVersionView' => new Map<String, Object>{
          'attributes' => new Map<String, Object>{
            'type' => 'FlowVersionView'
          },
          'VersionNumber' => 3,
          'FlowDefinitionView' => new Map<String, Object>{
            'attributes' => new Map<String, Object>{
              'type' => 'FlowDefinitionView'
            },
            'ApiName' => 'Account_Flow'
          }
        }
      }
    );
    FlowInterviewLog started = (FlowInterviewLog) row(
      'FlowInterviewLog',
      new Map<String, Object>{
        'FlowDeveloperName' => 'Account_Flow',
        'FlowVersionNumber' => 3,
        'InterviewStartTimestamp' => '2025-03-03T09:00:00.000+0000',
        'CreatedDate' => '2025-03-03T09:05:00.000+0000',
        'CreatedBy' => user('Paul Martin')
      }
    );
    FlowInterviewLog createdOnly = (FlowInterviewLog) row(
      'FlowInterviewLog',
      new Map<String, Object>{
        'FlowDeveloperName' => 'Case_Flow',
        'CreatedDate' => '2025-03-04T09:05:00.000+0000'
      }
    );
    FlowInterviewLog unnamed = (FlowInterviewLog) row(
      'FlowInterviewLog',
      new Map<String, Object>{ 'CreatedDate' => '2025-03-04T09:05:00.000+0000' }
    );

    Map<String, OrgAutomationService.FlowErrorSummary> byFlow = new Map<String, OrgAutomationService.FlowErrorSummary>();
    Test.startTest();
    OrgAutomationService.addInterviews(
      byFlow,
      new List<FlowInterview>{ failed, withoutFlow, withoutMessage }
    );
    OrgAutomationService.addLogs(
      byFlow,
      new List<FlowInterviewLog>{ started, createdOnly, unnamed }
    );
    Test.stopTest();

    Assert.areEqual(
      2,
      byFlow.size(),
      'interview sans flow et journal sans nom ignorés'
    );
    OrgAutomationService.FlowErrorSummary account = byFlow.get('Account_Flow');
    Assert.areEqual(3, account.count);
    Assert.areEqual(
      Datetime.valueOfGmt('2025-03-03 09:00:00'),
      account.lastAt,
      'dernière erreur = début d’interview du journal'
    );
    OrgAutomationService.FlowErrorSample first = account.samples[0];
    Assert.areEqual('Update_Account', first.element);
    Assert.areEqual(1000, first.message.length(), 'message tronqué à 1000');
    Assert.areEqual('Marie Durand', first.userName);
    Assert.areEqual('Account flow 2025-03-01', first.label);
    Assert.areEqual(3, first.versionNumber);
    Assert.isNull(account.samples[1].message);
    Assert.areEqual(
      Datetime.valueOfGmt('2025-03-04 09:05:00'),
      byFlow.get('Case_Flow').samples[0].occurredAt,
      'sans début d’interview, date de création'
    );
  }

  @IsTest
  static void viewIsReadWithoutErrorForAnAdministrator() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      Test.startTest();
      OrgAutomationService.AutomationView view = OrgAutomationService.getView();
      Test.stopTest();
      Assert.isNotNull(view.flowErrors);
      Assert.isNull(view.flowErrorsMessage);
    }
  }

  @IsTest
  static void viewReportsAReadFailureInsteadOfThrowing() {
    User limited = OrgIntelTestSupport.newUser('oilimit', false);
    insert limited;
    OrgIntelTestSupport.assign(
      limited.Id,
      OrgIntelTestSupport.ADMIN_PERMISSION_SET
    );
    System.runAs(limited) {
      Test.startTest();
      OrgAutomationService.AutomationView view = OrgAutomationService.getView();
      Test.stopTest();
      Assert.isNotNull(view.flowErrors, 'liste toujours renseignée');
      Assert.isTrue(
        view.flowErrorsMessage == null ||
        view.flowErrorsMessage.startsWith('Flow errors could not be read'),
        'échec de lecture signalé sans exception : ' + view.flowErrorsMessage
      );
    }
  }
}
