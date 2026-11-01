/**
 * Fabrique de données de test du socle : utilisateurs portant les permission sets Org Intelligence,
 * passerelle Tooling simulée (aucun appel HTTP), modules factices et définitions de flows.
 */
@IsTest
public class OrgIntelTestSupport {
  public static final String ADMIN_PERMISSION_SET = 'OrgIntelligence_Admin';
  public static final String USER_PERMISSION_SET = 'OrgIntelligence_User';

  // ---------- Utilisateurs ----------

  /** Administrateur Salesforce portant le permission set d'administration Org Intelligence. */
  public static User adminUser() {
    User admin = newUser('oiadmin', true);
    insert admin;
    assign(admin.Id, ADMIN_PERMISSION_SET);
    return admin;
  }

  /** Utilisateur standard en consultation (permission set OrgIntelligence_User). */
  public static User readerUser() {
    User reader = newUser('oiread', false);
    insert reader;
    assign(reader.Id, USER_PERMISSION_SET);
    return reader;
  }

  /** Utilisateur standard sans aucun accès à Org Intelligence. */
  public static User outsiderUser() {
    User outsider = newUser('oiout', false);
    insert outsider;
    return outsider;
  }

  public static void assign(Id userId, String permissionSetName) {
    insert new PermissionSetAssignment(
      AssigneeId = userId,
      PermissionSetId = [
        SELECT Id
        FROM PermissionSet
        WHERE Name = :permissionSetName
        LIMIT 1
      ]
      .Id
    );
  }

  public static User newUser(String alias, Boolean systemAdmin) {
    Profile profile = systemAdmin
      ? [
          SELECT Id
          FROM Profile
          WHERE UserType = 'Standard' AND PermissionsModifyAllData = TRUE
          ORDER BY CreatedDate
          LIMIT 1
        ]
      : [
          SELECT Id
          FROM Profile
          WHERE
            UserType = 'Standard'
            AND PermissionsModifyAllData = FALSE
            AND UserLicense.Name = 'Salesforce'
          ORDER BY CreatedDate
          LIMIT 1
        ];
    String unique =
      alias +
      '.' +
      Math.abs(Crypto.getRandomInteger()) +
      '@orgintel.test';
    return new User(
      Alias = alias.left(8),
      Email = unique,
      Username = unique,
      LastName = 'Test ' + alias,
      ProfileId = profile.Id,
      TimeZoneSidKey = 'Europe/Paris',
      LocaleSidKey = 'en_US',
      LanguageLocaleKey = 'en_US',
      EmailEncodingKey = 'UTF-8'
    );
  }

  // ---------- Modules ----------

  /** Aucun module découvert : le socle se comporte comme installé seul. */
  public static void withoutModules() {
    OrgIntelModules.overrides = new Map<String, OrgIntelModule>();
    for (String key : OrgIntelModules.ENTRY_CLASSES.keySet()) {
      OrgIntelModules.overrides.put(key, null);
    }
    for (String key : OrgIntelModules.TOOL_CLASSES.keySet()) {
      OrgIntelModules.overrides.put(key, null);
    }
  }

  /** Remplace un module par une instance de test (les autres restent absents). */
  public static void withModule(String key, OrgIntelModule module) {
    if (OrgIntelModules.overrides == null) {
      withoutModules();
    }
    OrgIntelModules.overrides.put(key, module);
  }

  /**
   * Module factice : répond à « echo » (renvoie les paramètres), « fail » (exception technique),
   * « refuse » (message lisible) ; joue aussi le module Recommendations et le stockage du journal
   * API.
   */
  public class FakeModule extends OrgIntelModule implements OrgIntelRecommendationSource, OrgApiLogger.Sink {
    public String moduleKey;
    public Boolean accessible = true;
    public Integer savedEntries = 0;
    public Boolean failOnSave = false;
    public Integer purged = 0;

    public FakeModule(String moduleKey) {
      this.moduleKey = moduleKey;
    }

    public override String key() {
      return moduleKey;
    }

    public override Boolean isAccessible() {
      return accessible;
    }

    public override Map<String, Integer> recordCounts() {
      return new Map<String, Integer>{ 'Fake records' => 3 };
    }

    public override void purge(OrgMaintenanceService.Result result) {
      purged++;
      result.addDeleted(result.retentionDays() == null ? 0 : 2);
    }

    public override Object invoke(String action, Map<String, Object> params) {
      switch on action {
        when 'echo' {
          return params;
        }
        when 'helpers' {
          return new Map<String, Object>{
            'text' => text(params, 'text'),
            'recordId' => recordId(params, 'recordId'),
            'blankId' => recordId(params, 'missing'),
            'integer' => integerValue(params, 'integer'),
            'integerFromText' => integerValue(params, 'integerText'),
            'missingInteger' => integerValue(params, 'missing'),
            'decimal' => decimalValue(params, 'decimal'),
            'missingDecimal' => decimalValue(params, 'missing'),
            'boolean' => booleanValue(params, 'boolean'),
            'missingBoolean' => booleanValue(params, 'missing'),
            'list' => textList(params, 'list'),
            'ids' => idList(params, 'ids')
          };
        }
        when 'prefixed' {
          return new Map<String, Object>{ 'orgintel__Title__c' => 'x' };
        }
        when 'nothing' {
          return null;
        }
        when 'fail' {
          throw new IllegalArgumentException('technical failure');
        }
        when 'refuse' {
          throw OrgIntelAccess.error('Readable refusal');
        }
        when else {
          throw unknownAction(action);
        }
      }
    }

    public Map<String, Object> overviewData() {
      return new Map<String, Object>{
        'bySeverity' => new Map<String, Object>{
          'Critical' => 2,
          'High' => 1,
          '' => 1
        },
        'toReviewCount' => 3,
        'acceptedCount' => 1,
        'priorityRecommendations' => new List<Object>{
          new Map<String, Object>{
            'name' => 'REC-1',
            'title' => 'Fix it',
            'severity' => 'Critical',
            'stillDetected' => true
          }
        }
      };
    }

    public Map<String, Object> reportsData() {
      return new Map<String, Object>{
        'resolvedLast90Days' => 4,
        'createdLast90Days' => 6,
        'openCount' => 9,
        'averageDaysToResolve' => 3.5,
        'resolutionTrend' => new List<Object>{
          new Map<String, Object>{
            'month' => '2026-10',
            'created' => 6,
            'resolved' => 4
          }
        },
        'openByCategory' => new List<Object>{
          new Map<String, Object>{
            'componentType' => 'ApexClass',
            'count' => 5
          }
        }
      };
    }

    public Map<String, Integer> openCountByRule() {
      return new Map<String, Integer>{ 'APEX_HARDCODED_ID' => 2 };
    }

    public void save(List<OrgApiLogger.Entry> entries) {
      if (failOnSave) {
        throw new IllegalArgumentException('log storage unavailable');
      }
      savedEntries += entries.size();
    }
  }

  // ---------- Tooling API simulée ----------

  /**
   * Passerelle Tooling simulée : répond aux requêtes du scanner selon l'objet interrogé (FROM),
   * sans appel HTTP. Les réponses sont modifiables par test.
   */
  public class FakeTooling extends OrgToolingGateway {
    public Boolean configured = true;
    public Boolean authorized = true;
    public Boolean failQueries = false;
    public Boolean failRest = false;
    public Boolean failValidationMetadata = false;
    public Boolean emptyFlowMetadata = false;
    public List<String> queries = new List<String>();
    public Map<String, Object> flowMetadata = afterSaveFlowMetadata();
    public List<Map<String, Object>> coverageRows = new List<Map<String, Object>>();
    public List<Map<String, Object>> validationRules = new List<Map<String, Object>>();
    public List<Map<String, Object>> dependencyRows = new List<Map<String, Object>>();
    public String recordCountBody = JSON.serialize(
      new Map<String, Object>{
        'sObjects' => new List<Object>{
          new Map<String, Object>{ 'name' => 'Account', 'count' => 600000 },
          new Map<String, Object>{ 'name' => 'Task', 'count' => 150000 },
          new Map<String, Object>{ 'name' => 'Contact', 'count' => 0 }
        }
      }
    );

    public override Boolean isConfigured() {
      return configured;
    }

    public override Boolean isUserAuthorized() {
      return authorized;
    }

    public override String authorizationUrl() {
      return '/services/auth/xds/test';
    }

    public override List<Map<String, Object>> query(String soql) {
      queries.add(soql);
      if (failQueries) {
        throw new OrgToolingGateway.ToolingException('Tooling API error (500)');
      }
      if (soql.contains('FROM ApexCodeCoverageAggregate')) {
        return coverageRows;
      }
      if (soql.contains('Metadata FROM Flow')) {
        if (emptyFlowMetadata) {
          return new List<Map<String, Object>>();
        }
        return new List<Map<String, Object>>{
          new Map<String, Object>{
            'Id' => '301000000000001',
            'Metadata' => flowMetadata
          }
        };
      }
      if (soql.contains('Metadata FROM ValidationRule')) {
        if (failValidationMetadata) {
          throw new OrgToolingGateway.ToolingException('formula unreadable');
        }
        return new List<Map<String, Object>>{
          new Map<String, Object>{
            'Id' => '03d000000000001',
            'Metadata' => new Map<String, Object>{
              'errorConditionFormula' => 'ISBLANK(Name) && Amount > 1000'
            }
          }
        };
      }
      if (soql.contains('FROM ValidationRule')) {
        return validationRules;
      }
      if (soql.contains('FROM MetadataComponentDependency')) {
        return dependencyRows;
      }
      if (soql.contains('FROM ApexClass')) {
        return new List<Map<String, Object>>{
          new Map<String, Object>{ 'Id' => '01p000000000001' }
        };
      }
      return new List<Map<String, Object>>();
    }

    public override String getRest(String relativePath) {
      if (failRest) {
        throw new OrgToolingGateway.ToolingException('REST unavailable');
      }
      return recordCountBody;
    }
  }

  /** Installe la passerelle simulée pour la transaction et la renvoie. */
  public static FakeTooling useFakeTooling() {
    FakeTooling tooling = new FakeTooling();
    OrgToolingGateway.setInstance(tooling);
    return tooling;
  }

  // ---------- Données Tooling ----------

  public static Map<String, Object> validationRuleRow(
    String id,
    String objectName,
    String name,
    Boolean active
  ) {
    return new Map<String, Object>{
      'Id' => id,
      'ValidationName' => name,
      'Active' => active,
      'Description' => null,
      'ErrorMessage' => 'Fill the name',
      'ErrorDisplayField' => 'Name',
      'EntityDefinition' => new Map<String, Object>{
        'QualifiedApiName' => objectName
      },
      'LastModifiedDate' => '2020-01-15T10:00:00.000+0000',
      'LastModifiedBy' => new Map<String, Object>{ 'Name' => 'Admin' }
    };
  }

  public static Map<String, Object> dependencyRow(
    String type,
    String name,
    String refType,
    String refName
  ) {
    return new Map<String, Object>{
      'MetadataComponentType' => type,
      'MetadataComponentName' => name,
      'RefMetadataComponentType' => refType,
      'RefMetadataComponentName' => refName
    };
  }

  public static Map<String, Object> coverageRow(
    String id,
    String className,
    Integer covered,
    Integer uncovered
  ) {
    return new Map<String, Object>{
      'ApexClassOrTriggerId' => id,
      'ApexClassOrTrigger' => new Map<String, Object>{ 'Name' => className },
      'NumLinesCovered' => covered,
      'NumLinesUncovered' => uncovered
    };
  }

  // ---------- Définitions de flows (champ Metadata de la Tooling API) ----------

  public static Map<String, Object> connector(String target) {
    return new Map<String, Object>{ 'targetReference' => target };
  }

  /**
   * Flow after-save sur Opportunity : boucle avec requête et mise à jour, mise à jour du même
   * enregistrement sans chemin d'erreur, Id codé en dur, action Apex, sous-flow, attente.
   */
  public static Map<String, Object> afterSaveFlowMetadata() {
    return new Map<String, Object>{
      'label' => 'Opportunity after save',
      'processType' => 'AutoLaunchedFlow',
      'runInMode' => 'SystemModeWithoutSharing',
      'start' => new Map<String, Object>{
        'object' => 'Opportunity',
        'triggerType' => 'RecordAfterSave',
        'recordTriggerType' => 'CreateAndUpdate',
        'connector' => connector('Get_Lines'),
        'scheduledPaths' => new List<Object>{
          new Map<String, Object>{
            'label' => 'One day later',
            'connector' => connector('Update_Account')
          }
        }
      },
      'variables' => new List<Object>{
        new Map<String, Object>{
          'name' => 'recordId',
          'dataType' => 'String',
          'isInput' => true,
          'isOutput' => false
        },
        new Map<String, Object>{
          'name' => 'accountVar',
          'dataType' => 'SObject',
          'objectType' => 'Account',
          'isInput' => false,
          'isOutput' => true,
          'isCollection' => false
        },
        new Map<String, Object>{
          'name' => 'myVariable_current',
          'dataType' => 'SObject'
        }
      },
      'recordLookups' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Get_Lines',
          'label' => 'Get Lines',
          'object' => 'OpportunityLineItem',
          'connector' => connector('Each_Line')
        },
        new Map<String, Object>{
          'name' => 'Get_Owner',
          'object' => 'User',
          'connector' => connector('Update_Line')
        }
      },
      'loops' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Each_Line',
          'label' => 'Each Line',
          'collectionReference' => 'Get_Lines',
          'nextValueConnector' => connector('Check_Line'),
          'noMoreValuesConnector' => connector('Update_Opportunity')
        }
      },
      'decisions' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Check_Line',
          'label' => 'Check line',
          'rules' => new List<Object>{
            new Map<String, Object>{
              'label' => 'Has owner',
              'connector' => connector('Get_Owner')
            }
          },
          'defaultConnector' => connector('Each_Line')
        }
      },
      'recordUpdates' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Update_Line',
          'label' => 'Update line',
          'inputReference' => 'Each_Line',
          'connector' => connector('Each_Line')
        },
        new Map<String, Object>{
          'name' => 'Update_Opportunity',
          'label' => 'Update opportunity',
          'inputReference' => '$Record',
          'inputAssignments' => new List<Object>{
            new Map<String, Object>{ 'field' => 'StageName' }
          },
          'connector' => connector('Update_Account')
        },
        new Map<String, Object>{
          'name' => 'Update_Account',
          'label' => 'Update account',
          'object' => 'Account',
          'filters' => new List<Object>{
            new Map<String, Object>{
              'field' => 'Id',
              'value' => new Map<String, Object>{
                'elementReference' => '$Record.Id'
              }
            }
          },
          'faultConnector' => connector('Log_Error'),
          'connector' => connector('Wait_A_Bit')
        },
        new Map<String, Object>{
          'name' => 'Update_Account_Var',
          'inputReference' => 'accountVar'
        }
      },
      'assignments' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Set_Account',
          'assignmentItems' => new List<Object>{
            new Map<String, Object>{
              'assignToReference' => 'accountVar.Rating'
            },
            new Map<String, Object>{
              'assignToReference' => 'accountVar.Owner.Name'
            }
          }
        }
      },
      'recordCreates' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Create_Task',
          'label' => 'Create task',
          'object' => 'Task',
          'inputAssignments' => new List<Object>{
            new Map<String, Object>{
              'field' => 'OwnerId',
              'value' => new Map<String, Object>{
                'stringValue' => '005AB0000012345'
              }
            }
          }
        }
      },
      'recordDeletes' => new List<Object>{
        new Map<String, Object>{ 'name' => 'Delete_Old', 'object' => 'Note' }
      },
      'actionCalls' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Log_Error',
          'label' => 'Log error',
          'actionType' => 'apex',
          'actionName' => 'ErrorLogger'
        },
        new Map<String, Object>{
          'name' => 'Send_Email',
          'actionType' => 'emailSimple',
          'actionName' => 'emailSimple'
        }
      },
      'subflows' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Run_Sub',
          'flowName' => 'Child_Flow'
        }
      },
      'waits' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Wait_A_Bit',
          'waitEvents' => new List<Object>{
            new Map<String, Object>{
              'label' => 'Tomorrow',
              'connector' => connector('Run_Sub')
            }
          }
        }
      }
    };
  }

  /** Flow before-save sur Account, avec conditions d'entrée et affectations sur $Record. */
  public static Map<String, Object> beforeSaveFlowMetadata(Integer order) {
    return new Map<String, Object>{
      'label' => 'Account before save',
      'processType' => 'AutoLaunchedFlow',
      'triggerOrder' => order,
      'start' => new Map<String, Object>{
        'object' => 'Account',
        'triggerType' => 'RecordBeforeSave',
        'recordTriggerType' => 'Update',
        'filterLogic' => 'or',
        'filters' => new List<Object>{
          new Map<String, Object>{
            'field' => 'Rating',
            'operator' => 'EqualTo',
            'value' => new Map<String, Object>{ 'stringValue' => 'Hot' }
          },
          new Map<String, Object>{
            'field' => 'IsDeleted',
            'operator' => 'EqualTo',
            'value' => new Map<String, Object>{ 'booleanValue' => false }
          },
          new Map<String, Object>{
            'field' => 'Name',
            'operator' => 'IsNull',
            'value' => 'not a map'
          }
        },
        'connector' => connector('Set_Fields')
      },
      'assignments' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Set_Fields',
          'label' => 'Set fields',
          'assignmentItems' => new List<Object>{
            new Map<String, Object>{ 'assignToReference' => '$Record.Rating' },
            new Map<String, Object>{ 'assignToReference' => '$Record.Industry' }
          }
        }
      }
    };
  }

  /** Process Builder sur Contact (processMetadataValues), critères dans décisions et formules. */
  public static Map<String, Object> processBuilderMetadata() {
    return new Map<String, Object>{
      'label' => 'Contact process',
      'processType' => 'Workflow',
      'startElementReference' => 'myDecision',
      'processMetadataValues' => new List<Object>{
        new Map<String, Object>{
          'name' => 'ObjectType',
          'value' => new Map<String, Object>{ 'stringValue' => 'Contact' }
        },
        new Map<String, Object>{
          'name' => 'TriggerType',
          'value' => new Map<String, Object>{ 'stringValue' => 'onAllChanges' }
        }
      },
      'decisions' => new List<Object>{
        new Map<String, Object>{
          'name' => 'myDecision',
          'rules' => new List<Object>{
            new Map<String, Object>{
              'label' => 'Is VIP',
              'connector' => connector('myRule_1_A1')
            }
          }
        }
      },
      'formulas' => new List<Object>{
        new Map<String, Object>{ 'expression' => 'ISCHANGED([Contact].Email)' }
      },
      'recordUpdates' => new List<Object>{
        new Map<String, Object>{
          'name' => 'myRule_1_A1',
          'inputReference' => 'myVariable_current',
          'inputAssignments' => new List<Object>{
            new Map<String, Object>{ 'field' => 'Title' }
          }
        }
      }
    };
  }

  /** Flow déclenché sur Account (after save) qui met à jour des contacts : maillon d'une boucle. */
  public static Map<String, Object> writerFlowMetadata(
    String triggerObject,
    String writtenObject
  ) {
    return new Map<String, Object>{
      'label' => triggerObject +
      ' writes ' +
      writtenObject,
      'processType' => 'AutoLaunchedFlow',
      'start' => new Map<String, Object>{
        'object' => triggerObject,
        'triggerType' => 'RecordAfterSave',
        'recordTriggerType' => 'Update',
        'connector' => connector('Write')
      },
      'recordUpdates' => new List<Object>{
        new Map<String, Object>{
          'name' => 'Write',
          'object' => writtenObject,
          'faultConnector' => connector('Write')
        }
      }
    };
  }

  // ---------- Composants ----------

  public static OrgScanModels.Component component(
    String type,
    String name,
    String parentName,
    Map<String, Object> details
  ) {
    OrgScanModels.Component result = new OrgScanModels.Component(type, name);
    result.parentName = parentName;
    if (details != null) {
      result.details = details;
    }
    return result;
  }

  /** Flow analysé (détails « model ») déclenché sur un objet et qui en écrit un autre. */
  public static OrgScanModels.Component analysedFlow(
    String name,
    String triggerObject,
    String writtenObject
  ) {
    Map<String, Object> metadata = writerFlowMetadata(
      triggerObject,
      writtenObject
    );
    OrgFlowAnalyzer.FlowModel model = new OrgFlowAnalyzer(
        metadata,
        JSON.serialize(metadata)
      )
      .model;
    return component(
      'Flow',
      name,
      triggerObject,
      new Map<String, Object>{
        'label' => name,
        'processType' => 'AutoLaunchedFlow',
        'triggerType' => 'RecordAfterSave',
        'activeVersionId' => '301000000000001',
        'model' => JSON.deserializeUntyped(JSON.serialize(model))
      }
    );
  }

  /** Contexte d'étape sur un état construit pour la liste d'étapes donnée. */
  public static OrgScanContext context(List<String> steps, Boolean tooling) {
    OrgScanState state = new OrgScanState();
    state.steps = steps;
    state.toolingAvailable = tooling;
    state.referenceApiVersion = 66;
    return new OrgScanContext(state);
  }

  /** Constats du contexte par code de règle. */
  public static Map<String, List<OrgScanModels.Finding>> findingsByRule(
    OrgScanContext ctx
  ) {
    Map<String, List<OrgScanModels.Finding>> result = new Map<String, List<OrgScanModels.Finding>>();
    for (OrgScanModels.Finding finding : ctx.discoveredFindings()) {
      if (!result.containsKey(finding.ruleCode)) {
        result.put(finding.ruleCode, new List<OrgScanModels.Finding>());
      }
      result.get(finding.ruleCode).add(finding);
    }
    return result;
  }

  /** Active une règle avec un seuil donné (surcharge de Settings). */
  public static void overrideRule(String code, Decimal threshold) {
    OrgScanRule__mdt rule = OrgIntelSettings.rule(code);
    insert new OrgIntelRuleOverride__c(
      Name = code,
      IsEnabled__c = true,
      Severity__c = rule == null ? 'Medium' : rule.Severity__c,
      Threshold__c = threshold
    );
    OrgIntelSettings.resetCache();
  }

  public static Boolean logContains(OrgScanState state, String text) {
    for (OrgScanModels.LogEntry entry : state.log) {
      if (entry.message != null && entry.message.contains(text)) {
        return true;
      }
    }
    return false;
  }
}
