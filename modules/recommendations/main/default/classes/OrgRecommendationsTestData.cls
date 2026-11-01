/**
 * Données de test du module Recommendations : utilisateurs portant les permission sets du socle et
 * du module, recommandations. Indépendant des données de l'org.
 */
@IsTest
public class OrgRecommendationsTestData {
  public static final String CORE_ADMIN = 'OrgIntelligence_Admin';
  public static final String CORE_USER = 'OrgIntelligence_User';
  public static final String MODULE_ADMIN = 'OrgIntelligence_Recommendations_Admin';
  public static final String MODULE_USER = 'OrgIntelligence_Recommendations_User';

  /** Administrateur Org Intelligence avec le module Recommendations. */
  public static User createAdmin(String alias) {
    return createUser(alias, new List<String>{ CORE_ADMIN, MODULE_ADMIN });
  }

  /** Utilisateur Org Intelligence (consultation) avec le module Recommendations. */
  public static User createReader(String alias) {
    return createUser(alias, new List<String>{ CORE_USER, MODULE_USER });
  }

  /** Utilisateur sans aucun permission set Org Intelligence. */
  public static User createOutsider(String alias) {
    return createUser(alias, new List<String>());
  }

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
    if (!permissionSets.isEmpty()) {
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
    }
    return user;
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

  /** Recommandation ouverte (non insérée). */
  public static OrgRecommendation__c recommendation(
    String fingerprint,
    String severity
  ) {
    return new OrgRecommendation__c(
      Fingerprint__c = fingerprint,
      RuleCode__c = 'APEX_HARDCODED_ID',
      Title__c = 'Hard-coded Id in ' + fingerprint,
      Description__c = 'The class contains a hard-coded record Id.',
      Justification__c = 'Ids differ between orgs.',
      SuggestedAction__c = 'Use a custom setting.',
      AffectedComponents__c = 'MyClass\nOtherClass',
      Severity__c = severity,
      Category__c = 'Reliability',
      Confidence__c = 'High',
      ComponentType__c = 'ApexClass',
      ComponentName__c = 'MyClass',
      Status__c = 'New',
      LastDetectedAt__c = Datetime.now().addDays(-1),
      LastScanName__c = 'Scan 1',
      StillDetected__c = true,
      OccurrenceCount__c = 1
    );
  }

  /** Utilisateur créé par @TestSetup, retrouvé par son nom. */
  public static User userNamed(String alias) {
    return [
      SELECT Id, Name
      FROM User
      WHERE LastName = :('Test ' + alias)
      LIMIT 1
    ];
  }
}
