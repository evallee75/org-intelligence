/**
 * Données de test du module API Monitoring : utilisateurs portant les permission sets du socle et
 * du module, entrées du journal API, règles d'alerte. Indépendant des données de l'org.
 */
@IsTest
public class OrgApiMonitoringTestData {
  public static final String CORE_ADMIN = 'OrgIntelligence_Admin';
  public static final String CORE_USER = 'OrgIntelligence_User';
  public static final String MODULE_ADMIN = 'OrgIntelligence_ApiMonitoring_Admin';

  public static User createUser(String alias, List<String> permissionSets) {
    String unique =
      alias +
      '.' +
      EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(10) +
      '@orgintel.test';
    User user = new User(
      Alias = alias.left(8),
      Email = unique,
      Username = unique,
      LastName = 'Test ' + alias,
      ProfileId = standardProfileId(),
      TimeZoneSidKey = 'Europe/Paris',
      LocaleSidKey = 'en_US',
      LanguageLocaleKey = 'en_US',
      EmailEncodingKey = 'UTF-8'
    );
    insert user;
    List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
    for (PermissionSet permissionSet : [
      SELECT Id
      FROM PermissionSet
      WHERE
        Name IN :permissionSets
        AND NamespacePrefix = :OrgIntelNamespace.namespaceFilter()
    ]) {
      assignments.add(
        new PermissionSetAssignment(
          AssigneeId = user.Id,
          PermissionSetId = permissionSet.Id
        )
      );
    }
    insert assignments;
    return user;
  }

  public static User userNamed(String alias) {
    return [
      SELECT Id, Name, Email
      FROM User
      WHERE LastName = :('Test ' + alias)
      LIMIT 1
    ];
  }

  private static Id standardProfileId() {
    List<Profile> profiles = [
      SELECT Id, Name
      FROM Profile
      WHERE
        UserType = 'Standard'
        AND PermissionsModifyAllData = FALSE
        AND PermissionsViewAllData = FALSE
        AND UserLicense.Name = 'Salesforce'
      ORDER BY Name
    ];
    for (Profile profile : profiles) {
      if (profile.Name == 'Standard User') {
        return profile.Id;
      }
    }
    return profiles[0].Id;
  }

  /** Entrée du journal (non insérée), `minutesAgo` avant maintenant. */
  public static OrgApiLog__c log(
    String systemName,
    Integer statusCode,
    Integer minutesAgo,
    String error
  ) {
    Boolean success =
      statusCode != null &&
      statusCode >= 200 &&
      statusCode < 300;
    return new OrgApiLog__c(
      System__c = systemName,
      Direction__c = 'Outbound',
      Operation__c = 'Create order',
      Method__c = 'POST',
      Endpoint__c = '/orders',
      StatusCode__c = statusCode,
      Success__c = success,
      DurationMs__c = success ? 200 : 7000,
      CalledAt__c = Datetime.now().addMinutes(-minutesAgo),
      ErrorMessage__c = error,
      RequestBody__c = '{"id":1}',
      ResponseBody__c = '{}'
    );
  }
}
