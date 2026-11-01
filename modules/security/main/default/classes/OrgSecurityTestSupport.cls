/**
 * Outils communs aux tests du module Security : utilisateurs de test (avec ou sans les permission
 * sets), bouchon de la passerelle Tooling et réponses HTTP simulées du Health Check.
 */
@IsTest
public class OrgSecurityTestSupport {
  public static final String CORE_ADMIN = 'OrgIntelligence_Admin';
  public static final String MODULE_ADMIN = 'OrgIntelligence_Security_Admin';

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
    if (profiles.isEmpty()) {
      return null;
    }
    return newUser(profiles[0].Id, permissionSets);
  }

  public static User newUser(Id profileId, List<String> permissionSets) {
    counter++;
    String key = 'oisec' + counter + DateTime.now().getTime();
    User u = new User(
      ProfileId = profileId,
      LastName = 'Security Test ' + counter,
      Alias = ('osec' + counter).left(8),
      Email = key + '@example.com.test',
      Username = key + '@example.com.test',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US',
      LocaleSidKey = 'en_US',
      TimeZoneSidKey = 'Europe/Paris'
    );
    insert u;
    assign(u.Id, permissionSets);
    return u;
  }

  public static void assign(Id userId, List<String> permissionSets) {
    if (permissionSets == null || permissionSets.isEmpty()) {
      return;
    }
    List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
    for (PermissionSet ps : [
      SELECT Id
      FROM PermissionSet
      WHERE Name IN :permissionSets
    ]) {
      assignments.add(
        new PermissionSetAssignment(
          AssigneeId = userId,
          PermissionSetId = ps.Id
        )
      );
    }
    insert assignments;
  }

  public static List<String> fullAccess() {
    return new List<String>{ CORE_ADMIN, MODULE_ADMIN };
  }

  /** Passerelle Tooling configurée et autorisée : les appels HTTP passent par le mock. */
  public class StubGateway extends OrgToolingGateway {
    private Boolean configured;
    public StubGateway(Boolean configured) {
      this.configured = configured;
    }
    public override Boolean isConfigured() {
      return configured;
    }
  }

  public static void useTooling(Boolean configured, HttpCalloutMock mock) {
    OrgToolingGateway.setInstanceForTests(new StubGateway(configured));
    if (mock != null) {
      Test.setMock(HttpCalloutMock.class, mock);
    }
  }

  /** Réponses du Health Check selon l'objet interrogé ; statusCode >= 300 pour simuler une panne. */
  public class HealthCheckMock implements HttpCalloutMock {
    public Integer statusCode = 200;
    public String score = '72';
    public List<String> endpoints = new List<String>();

    public HttpResponse respond(HttpRequest request) {
      String endpoint = EncodingUtil.urlDecode(request.getEndpoint(), 'UTF-8');
      endpoints.add(endpoint);
      HttpResponse response = new HttpResponse();
      response.setStatusCode(statusCode);
      if (statusCode >= 300) {
        response.setBody(
          '[{"message":"Server unavailable","errorCode":"SERVER_ERROR"}]'
        );
        return response;
      }
      if (endpoint.contains('SecurityHealthCheckRisks')) {
        response.setBody(
          '{"done":true,"records":[' +
            '{"RiskType":"HIGH_RISK","Setting":"Minimum password length","SettingGroup":"Password Policies","OrgValue":"5","StandardValue":"8"},' +
            '{"RiskType":"MEDIUM_RISK","Setting":"Session timeout","SettingGroup":"Session Settings","OrgValue":"12 hours","StandardValue":"2 hours"},' +
            '{"RiskType":"MEETS_STANDARD","Setting":"Clickjack","SettingGroup":"Session Settings","OrgValue":"On","StandardValue":"On"}' +
            ']}'
        );
      } else {
        response.setBody(
          '{"done":true,"records":[{"Score":' +
            (score == null ? 'null' : '"' + score + '"') +
            '}]}'
        );
      }
      return response;
    }
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
