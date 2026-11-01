/**
 * Outils des tests du module Field Usage : utilisateurs (avec ou sans les permission sets) et
 * Tooling API simulée (bouchon de la passerelle + HttpCalloutMock qui répond selon l'objet interrogé).
 */
@IsTest
public class OrgFieldUsageTestSupport {
  public static final String CORE_ADMIN_PS = 'OrgIntelligence_Admin';
  public static final String MODULE_PS = 'OrgIntelligence_FieldUsage_Admin';

  // ---------- Utilisateurs ----------

  /** Administrateur (profil ModifyAllData) portant les permission sets demandés. */
  public static User adminUser(List<String> permissionSets) {
    Profile profile = [
      SELECT Id
      FROM Profile
      WHERE PermissionsModifyAllData = TRUE AND UserType = 'Standard'
      ORDER BY CreatedDate
      LIMIT 1
    ];
    return createUser(profile.Id, permissionSets);
  }

  /** Utilisateur sans droits d'administration (refus robuste, même en package « for Admins Only »). */
  public static User standardUser(List<String> permissionSets) {
    Profile profile = [
      SELECT Id
      FROM Profile
      WHERE
        UserType = 'Standard'
        AND UserLicense.Name = 'Salesforce'
        AND PermissionsModifyAllData = FALSE
        AND PermissionsViewAllData = FALSE
        AND PermissionsCustomizeApplication = FALSE
      ORDER BY CreatedDate
      LIMIT 1
    ];
    return createUser(profile.Id, permissionSets);
  }

  public static User createUser(Id profileId, List<String> permissionSets) {
    String unique =
      String.valueOf(DateTime.now().getTime()) +
      String.valueOf(Crypto.getRandomInteger()).replace('-', '');
    User user = new User(
      ProfileId = profileId,
      Username = 'oifu' + unique + '@example.com.test',
      Email = 'oifu' + unique.left(10) + '@example.com.test',
      LastName = 'FieldUsage',
      Alias = 'oifu' + unique.right(4),
      TimeZoneSidKey = 'Europe/Paris',
      LocaleSidKey = 'en_US',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US'
    );
    System.runAs(new User(Id = UserInfo.getUserId())) {
      insert user;
      List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
      for (PermissionSet ps : [
        SELECT Id
        FROM PermissionSet
        WHERE Name IN :permissionSets
      ]) {
        assignments.add(
          new PermissionSetAssignment(
            AssigneeId = user.Id,
            PermissionSetId = ps.Id
          )
        );
      }
      insert assignments;
    }
    return user;
  }

  // ---------- Tooling API simulée ----------

  /** Passerelle dont la connexion est imposée ; les appels HTTP passent par le mock. */
  public class StubGateway extends OrgToolingGateway {
    Boolean configured;
    Boolean failOnCheck = false;
    public StubGateway(Boolean configured) {
      this.configured = configured;
    }
    public StubGateway failing() {
      failOnCheck = true;
      return this;
    }
    public override Boolean isConfigured() {
      if (failOnCheck) {
        throw new IllegalArgumentException('Tooling check failed');
      }
      return configured;
    }
  }

  public static void useTooling(Boolean configured) {
    OrgToolingGateway.setInstanceForTests(new StubGateway(configured));
  }

  public static void useFailingTooling() {
    OrgToolingGateway.setInstanceForTests(new StubGateway(true).failing());
  }

  /**
   * Réponses Tooling selon l'objet interrogé. `failing` : objets en erreur 500 (« CustomField »,
   * « Layout », « LayoutMetadata », « FlexiPage », « ProfileLayout », « CompactLayout », « Describe »,
   * « ValidationRule », « Dependency », ou « * » pour tout).
   */
  public class ToolingRouter implements HttpCalloutMock {
    public Set<String> failing = new Set<String>();
    public Boolean emptyPages = false;
    public Boolean defaultCompact = false;
    public List<String> profileIds = new List<String>();
    public String recordTypeId;
    public List<String> queries = new List<String>();

    public HttpResponse respond(HttpRequest request) {
      String endpoint = EncodingUtil.urlDecode(request.getEndpoint(), 'UTF-8');
      queries.add(endpoint);
      String kind = kindOf(endpoint);
      HttpResponse response = new HttpResponse();
      if (failing.contains('*') || failing.contains(kind)) {
        response.setStatusCode(500);
        response.setBody(
          '[{"message":"Simulated failure","errorCode":"UNKNOWN_EXCEPTION"}]'
        );
        return response;
      }
      response.setStatusCode(200);
      response.setBody(body(kind));
      return response;
    }

    private String kindOf(String endpoint) {
      if (endpoint.contains('/describe/compactLayouts')) {
        return 'Describe';
      }
      if (endpoint.contains('SELECT Metadata FROM Layout')) {
        return 'LayoutMetadata';
      }
      if (endpoint.contains('SELECT Metadata FROM FlexiPage')) {
        return 'FlexiPageMetadata';
      }
      if (endpoint.contains('FROM ProfileLayout')) {
        return 'ProfileLayout';
      }
      if (endpoint.contains('FROM CompactLayout')) {
        return 'CompactLayout';
      }
      if (endpoint.contains(' FROM Layout ')) {
        return 'Layout';
      }
      if (endpoint.contains('FROM FlexiPage')) {
        return 'FlexiPage';
      }
      if (endpoint.contains('FROM CustomField')) {
        return 'CustomField';
      }
      if (endpoint.contains('FROM MetadataComponentDependency')) {
        return 'Dependency';
      }
      if (endpoint.contains('FROM ValidationRule')) {
        return 'ValidationRule';
      }
      return 'Other';
    }

    private String body(String kind) {
      switch on kind {
        when 'Describe' {
          return JSON.serialize(
            new Map<String, Object>{
              'defaultCompactLayoutId' => defaultCompact
                ? '0AH000000000001AAA'
                : null,
              'recordTypeCompactLayoutMappings' => new List<Object>{
                new Map<String, Object>{
                  'compactLayoutId' => '0AH000000000001AAA',
                  'recordTypeName' => 'Master'
                }
              }
            }
          );
        }
        when 'LayoutMetadata' {
          return records(
            new List<Object>{
              new Map<String, Object>{ 'Metadata' => layoutMetadata() }
            }
          );
        }
        when 'FlexiPageMetadata' {
          return records(
            new List<Object>{
              new Map<String, Object>{ 'Metadata' => pageMetadata() }
            }
          );
        }
        when 'ProfileLayout' {
          return records(profileLayouts());
        }
        when 'CompactLayout' {
          return records(
            new List<Object>{
              new Map<String, Object>{
                'Id' => '0AH000000000001AAA',
                'DeveloperName' => 'Main',
                'MasterLabel' => 'Main'
              },
              new Map<String, Object>{
                'Id' => '0AH000000000002AAA',
                'DeveloperName' => 'Old',
                'MasterLabel' => 'Old'
              }
            }
          );
        }
        when 'Layout' {
          return records(layouts());
        }
        when 'FlexiPage' {
          return records(
            emptyPages
              ? new List<Object>()
              : new List<Object>{
                  page('0M0000000000001AAA', 'Account Record Page'),
                  page('0M0000000000002AAA', 'Heavy Page')
                }
          );
        }
        when 'CustomField' {
          return records(
            new List<Object>{
              new Map<String, Object>{
                'Id' => '00N000000000001AAA',
                'DeveloperName' => 'Legacy',
                'NamespacePrefix' => null,
                'CreatedDate' => '2020-01-01T00:00:00.000+0000',
                'Description' => 'Legacy field'
              },
              new Map<String, Object>{
                'Id' => '00N000000000002AAA',
                'DeveloperName' => 'Pkg',
                'NamespacePrefix' => 'pkg',
                'CreatedDate' => null,
                'Description' => null
              }
            }
          );
        }
        when 'Dependency' {
          return records(
            new List<Object>{
              dependency(
                '301000000000001AAA',
                'MyFlow',
                'Flow',
                '00N000000000001'
              ),
              dependency(
                '00h000000000001AAA',
                'Layout A',
                'Layout',
                '00N000000000001'
              ),
              dependency(
                '00N000000000001AAA',
                'Self',
                'CustomField',
                '00N000000000001'
              ),
              dependency(
                '01p000000000001AAA',
                'Unknown',
                'ApexClass',
                '00N000000000009'
              )
            }
          );
        }
        when 'ValidationRule' {
          return records(
            new List<Object>{
              new Map<String, Object>{ 'Id' => '03d1', 'Active' => true },
              new Map<String, Object>{ 'Id' => '03d2', 'Active' => false }
            }
          );
        }
      }
      return records(new List<Object>());
    }

    private List<Object> layouts() {
      List<Object> rows = new List<Object>();
      for (Integer i = 1; i <= 7; i++) {
        rows.add(
          new Map<String, Object>{
            'Id' => '00h00000000000' +
            i +
            'AAA',
            'Name' => 'Layout ' + i,
            'LayoutType' => i == 7 ? 'ProcessDefinition' : 'Standard',
            'NamespacePrefix' => i == 6 ? 'pkg' : null,
            'LastModifiedDate' => i == 2
              ? 'not a date'
              : '2025-05-01T10:00:00.000+0000',
            'LastModifiedBy' => new Map<String, Object>{ 'Name' => 'Admin' }
          }
        );
      }
      return rows;
    }

    /** Assignations : 3 présentations différentes pour le même type, profils avec utilisateurs actifs. */
    private List<Object> profileLayouts() {
      List<Object> rows = new List<Object>();
      String rt = recordTypeId;
      for (Integer i = 0; i < profileIds.size(); i++) {
        rows.add(
          new Map<String, Object>{
            'ProfileId' => profileIds[i],
            'Profile' => i == 0
              ? new Map<String, Object>{ 'Name' => 'Named profile' }
              : null,
            'RecordTypeId' => rt,
            'LayoutId' => '00h00000000000' +
            (Math.mod(i, 3) + 1) +
            'AAA'
          }
        );
        // Assignation « Master » (ignorée s'il existe des types d'enregistrement)
        rows.add(
          new Map<String, Object>{
            'ProfileId' => profileIds[i],
            'RecordTypeId' => null,
            'LayoutId' => '00h000000000001AAA'
          }
        );
      }
      // Profil sans utilisateur actif et inconnu de SOQL : « Hidden profile »
      rows.add(
        new Map<String, Object>{
          'ProfileId' => '00e000000000000AAA',
          'RecordTypeId' => rt,
          'LayoutId' => '00h000000000004AAA'
        }
      );
      // Présentation inconnue : ignorée
      rows.add(
        new Map<String, Object>{
          'ProfileId' => '00e000000000000AAA',
          'RecordTypeId' => rt,
          'LayoutId' => '00h000000000099AAA'
        }
      );
      return rows;
    }

    private Map<String, Object> page(String id, String label) {
      return new Map<String, Object>{
        'Id' => id,
        'DeveloperName' => label.replace(' ', '_'),
        'MasterLabel' => label,
        'NamespacePrefix' => null,
        'LastModifiedDate' => '2025-05-01T10:00:00.000+0000'
      };
    }

    private Map<String, Object> dependency(
      String sourceId,
      String name,
      String type,
      String refId
    ) {
      return new Map<String, Object>{
        'MetadataComponentId' => sourceId,
        'MetadataComponentName' => name,
        'MetadataComponentType' => type,
        'RefMetadataComponentId' => refId + 'AAA'
      };
    }
  }

  public static String records(List<Object> rows) {
    return JSON.serialize(
      new Map<String, Object>{ 'done' => true, 'records' => rows }
    );
  }

  /** Présentation : 2 sections, champs Name, Phone, Legacy__c et une liste associée. */
  public static Map<String, Object> layoutMetadata() {
    return new Map<String, Object>{
      'layoutSections' => new List<Object>{
        new Map<String, Object>{
          'layoutColumns' => new List<Object>{
            new Map<String, Object>{
              'layoutItems' => new List<Object>{
                new Map<String, Object>{ 'field' => 'Name' },
                new Map<String, Object>{ 'field' => 'Phone' },
                new Map<String, Object>{ 'customLink' => 'Link' }
              }
            }
          }
        },
        new Map<String, Object>{
          'layoutColumns' => new List<Object>{
            new Map<String, Object>{
              'layoutItems' => new List<Object>{
                new Map<String, Object>{ 'field' => 'Legacy__c' }
              }
            }
          }
        }
      },
      'relatedLists' => new List<Object>{
        new Map<String, Object>{ 'relatedList' => 'RelatedContactList' }
      }
    };
  }

  /** Page Lightning : champs Dynamic Forms, panneau de surbrillance avec Dynamic Actions, onglets. */
  public static Map<String, Object> pageMetadata() {
    List<Object> items = new List<Object>{
      new Map<String, Object>{
        'fieldInstance' => new Map<String, Object>{
          'fieldItem' => 'Record.Website',
          'visibilityRule' => new Map<String, Object>()
        }
      },
      new Map<String, Object>{
        'fieldInstance' => new Map<String, Object>{ 'fieldItem' => 'Industry' }
      },
      component('flexipage:tab', null),
      component('flexipage:fieldSection', null),
      component('flexipage:column', null),
      component('force:detailPanel', null),
      component(
        'force:highlightsPanel',
        new List<Object>{
          new Map<String, Object>{
            'name' => 'enableActionsConfiguration',
            'value' => 'true'
          }
        }
      ),
      component('c:customWidget', null),
      new Map<String, Object>{
        'componentInstance' => new Map<String, Object>()
      }
    };
    Map<String, Object> visible = (Map<String, Object>) items[2];
    ((Map<String, Object>) visible.get('componentInstance'))
      .put('visibilityRule', new Map<String, Object>());
    // Page lourde : beaucoup de composants
    for (Integer i = 0; i < 26; i++) {
      items.add(component('runtime_sales:widget' + i, null));
    }
    return new Map<String, Object>{
      'template' => new Map<String, Object>{
        'name' => 'flexipage:recordHomeTemplateDesktop'
      },
      'flexiPageRegions' => new List<Object>{
        new Map<String, Object>{ 'itemInstances' => items }
      }
    };
  }

  private static Map<String, Object> component(
    String name,
    List<Object> properties
  ) {
    Map<String, Object> component = new Map<String, Object>{
      'componentName' => name
    };
    if (properties != null) {
      component.put('componentInstanceProperties', properties);
    }
    return new Map<String, Object>{ 'componentInstance' => component };
  }

  /**
   * Appel d'une action comme l'écran, sans OrgIntelModuleController (@AuraEnabled, donc invisible
   * depuis un autre paquet du même namespace) : contrôle d'accès du module, paramètres passés par
   * JSON, résultat sérialisé, erreurs traduites en message lisible.
   */
  public static String invokeModule(
    OrgIntelModule module,
    String action,
    Map<String, Object> params
  ) {
    if (!module.isAccessible()) {
      throw OrgIntelAccess.error(
        'You do not have access to the Org Intelligence module ' + module.key()
      );
    }
    try {
      Map<String, Object> input = params == null
        ? new Map<String, Object>()
        : (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(params));
      Object result = module.invoke(action, input);
      return result == null ? null : JSON.serialize(result);
    } catch (AuraHandledException e) {
      throw e;
    } catch (Exception e) {
      throw OrgIntelAccess.error('The action could not be completed', e);
    }
  }
}
