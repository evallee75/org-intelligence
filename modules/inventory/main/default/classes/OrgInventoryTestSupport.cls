/**
 * Outils communs aux tests du module Inventory : utilisateurs de test, bouchon de la passerelle
 * Tooling et réponses HTTP simulées selon l'objet interrogé.
 */
@IsTest
public class OrgInventoryTestSupport {
  public static final String CORE_ADMIN = 'OrgIntelligence_Admin';
  public static final String MODULE_ADMIN = 'OrgIntelligence_Inventory_Admin';

  private static Integer counter = 0;

  /** Administrateur système portant les permission sets demandés. */
  public static User adminWith(List<String> permissionSets) {
    Profile profile = [
      SELECT Id
      FROM Profile
      WHERE PermissionsModifyAllData = TRUE AND UserType = 'Standard'
      ORDER BY CreatedDate
      LIMIT 1
    ];
    return newUser(profile.Id, permissionSets);
  }

  /** Utilisateur sans droit d'administration (refus robuste, quel que soit le mode d'installation). */
  public static User restrictedUser(List<String> permissionSets) {
    List<Profile> profiles = [
      SELECT Id
      FROM Profile
      WHERE
        UserType = 'Standard'
        AND PermissionsModifyAllData = FALSE
        AND PermissionsViewAllData = FALSE
        AND PermissionsCustomizeApplication = FALSE
        AND UserLicense.Name = 'Salesforce'
      ORDER BY CreatedDate
      LIMIT 1
    ];
    return profiles.isEmpty() ? null : newUser(profiles[0].Id, permissionSets);
  }

  public static User newUser(Id profileId, List<String> permissionSets) {
    counter++;
    String key = 'oiinv' + counter + DateTime.now().getTime();
    User u = new User(
      ProfileId = profileId,
      LastName = 'Inventory Test ' + counter,
      Alias = ('oinv' + counter).left(8),
      Email = key + '@example.com.test',
      Username = key + '@example.com.test',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US',
      LocaleSidKey = 'en_US',
      TimeZoneSidKey = 'Europe/Paris'
    );
    insert u;
    if (permissionSets != null && !permissionSets.isEmpty()) {
      List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
      for (PermissionSet ps : [
        SELECT Id
        FROM PermissionSet
        WHERE Name IN :permissionSets
      ]) {
        assignments.add(
          new PermissionSetAssignment(
            AssigneeId = u.Id,
            PermissionSetId = ps.Id
          )
        );
      }
      insert assignments;
    }
    return u;
  }

  public static List<String> fullAccess() {
    return new List<String>{ CORE_ADMIN, MODULE_ADMIN };
  }

  /** Passerelle Tooling configurée (ou non) : les appels HTTP passent par le mock. */
  public class StubGateway extends OrgToolingGateway {
    private Boolean configured;
    public StubGateway(Boolean configured) {
      this.configured = configured;
    }
    public override Boolean isConfigured() {
      return configured;
    }
  }

  /**
   * Installe le bouchon Tooling et retire le journal API (module API Monitoring) : sans écriture,
   * plusieurs jeux de données peuvent être calculés dans la même transaction de test.
   */
  public static void useTooling(Boolean configured, HttpCalloutMock mock) {
    OrgToolingGateway.setInstanceForTests(new StubGateway(configured));
    OrgIntelModules.overrideForTests(OrgIntelModules.API_MONITORING, null);
    if (mock != null) {
      Test.setMock(HttpCalloutMock.class, mock);
    }
  }

  /** Réponses Tooling selon l'objet interrogé ; les objets de `failing` répondent en erreur 500. */
  public class ToolingRouter implements HttpCalloutMock {
    public Set<String> failing = new Set<String>();
    public Map<String, String> records = defaultRecords();
    public List<String> endpoints = new List<String>();

    public HttpResponse respond(HttpRequest request) {
      String endpoint = EncodingUtil.urlDecode(request.getEndpoint(), 'UTF-8');
      endpoints.add(endpoint);
      String objectName = endpoint.substringAfter(' FROM ')
        .substringBefore(' ')
        .trim();
      HttpResponse response = new HttpResponse();
      if (failing.contains(objectName)) {
        response.setStatusCode(500);
        response.setBody(
          '[{"message":"Server unavailable","errorCode":"SERVER_ERROR"}]'
        );
        return response;
      }
      response.setStatusCode(200);
      String rows = records.containsKey(objectName)
        ? records.get(objectName)
        : '';
      response.setBody('{"done":true,"records":[' + rows + ']}');
      return response;
    }
  }

  private static Map<String, String> defaultRecords() {
    String old = '"2020-01-01T10:00:00.000+0000"';
    return new Map<String, String>{
      'MetadataComponentDependency' => '{"RefMetadataComponentName":"UsedComponent"},{"RefMetadataComponentName":"UsedComponent"},{"RefMetadataComponentName":"Used_Label"},{"RefMetadataComponentName":null}',
      'LightningComponentBundle' => '{"Id":"0Rb000000000001","DeveloperName":"UsedComponent","MasterLabel":"Used","ApiVersion":40.0,"Description":null,"NamespacePrefix":null,"IsExposed":false,"LastModifiedDate":' +
      old +
      '},' +
      '{"Id":"0Rb000000000002","DeveloperName":"exposedCard","MasterLabel":"Card","ApiVersion":66.0,"Description":"A card","NamespacePrefix":null,"IsExposed":true,"LastModifiedDate":"not a date"},' +
      '{"Id":"0Rb000000000003","DeveloperName":"pkgCmp","MasterLabel":"Pkg","ApiVersion":30.0,"NamespacePrefix":"pkg","IsExposed":false,"LastModifiedDate":null}',
      'FlexiPage' => '{"Id":"0M0000000000001","DeveloperName":"Account_Page","MasterLabel":"Account page","Type":"RecordPage","Description":null,"NamespacePrefix":null,"EntityDefinitionId":"Account","LastModifiedDate":' +
      old +
      '},' +
      '{"Id":"0M0000000000002","DeveloperName":"Home","MasterLabel":"Home","Type":"HomePage","Description":"Home page","NamespacePrefix":null}',
      'CustomTab' => '{"Id":"01r000000000001","DeveloperName":"My_Tab","MasterLabel":"My tab","Type":"customObject","Description":null,"NamespacePrefix":null},' +
      '{"Id":"01r000000000002","DeveloperName":"Pkg_Tab","MasterLabel":"Pkg tab","Type":"url","NamespacePrefix":"pkg"}',
      'ExternalString' => '{"Id":"101000000000001","Name":"Used_Label","MasterLabel":"Used","Value":"Hello","Category":"UI","Language":"en_US","NamespacePrefix":null},' +
      '{"Id":"101000000000002","Name":"Orphan_Label","MasterLabel":"Orphan","Value":"See https://acme.my.salesforce.com/001000000000001AAA/view","Category":null,"Language":"en_US","NamespacePrefix":null},' +
      '{"Id":"101000000000003","Name":"Pkg_Label","MasterLabel":"Pkg","Value":null,"NamespacePrefix":"pkg"}',
      'WebLink' => '{"Id":"00b000000000001","Name":"Old_Button","EntityDefinitionId":"Account","LinkType":"javascript","Url":"window.open(\'/001000000000001AAA\');","Description":null,"NamespacePrefix":null},' +
      '{"Id":"00b000000000002","Name":"Doc_Link","EntityDefinitionId":"Account","LinkType":"url","Url":"https://example.com","Description":"Documentation","NamespacePrefix":null}',
      'ProfileLayout' => '{"LayoutId":"00h000000000001"}',
      'Layout' => '{"Id":"00h000000000001AAA","Name":"Account Layout","TableEnumOrId":"Account","LayoutType":"Standard","NamespacePrefix":null,"LastModifiedDate":' +
      old +
      '},' +
      '{"Id":"00h000000000002AAA","Name":"Account Unused","TableEnumOrId":"Account","LayoutType":"Standard","NamespacePrefix":null}',
      'WorkflowRule' => '{"Id":"01Q000000000001","Name":"Legacy rule","TableEnumOrId":"Account","NamespacePrefix":null},' +
      '{"Id":"01Q000000000002","Name":"Pkg rule","TableEnumOrId":"Account","NamespacePrefix":"pkg"}',
      'InstalledSubscriberPackage' => '{"Id":"0A3000000000001","SubscriberPackage":{"Name":"Beta App","NamespacePrefix":"beta"},"SubscriberPackageVersion":{"Name":"Spring","MajorVersion":1,"MinorVersion":2,"IsBeta":true}},' +
      '{"Id":"0A3000000000002","SubscriberPackage":{"Name":"Stable App","NamespacePrefix":null},"SubscriberPackageVersion":{"Name":"GA","MajorVersion":3,"MinorVersion":0,"IsBeta":false}}'
    };
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
