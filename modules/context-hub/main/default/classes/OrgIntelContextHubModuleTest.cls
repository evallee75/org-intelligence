/**
 * Tests du module Context Hub par sa classe d'entrée (invoke) : préparation du contexte (masquage
 * des secrets, taille, empreinte SHA-256), taille maximale, contrôles d'accès.
 */
@IsTest
private class OrgIntelContextHubModuleTest {
  private static final String READER = 'ctxrd';
  private static final String NO_MODULE = 'ctxcore';
  private static final String OUTSIDER = 'ctxout';

  @TestSetup
  static void setup() {
    createUser(
      READER,
      new List<String>{
        'OrgIntelligence_User',
        'OrgIntelligence_ContextHub_User'
      }
    );
    createUser(NO_MODULE, new List<String>{ 'OrgIntelligence_Admin' });
    createUser(
      OUTSIDER,
      new List<String>{ 'OrgIntelligence_ContextHub_Admin' }
    );
  }

  @IsTest
  static void prepareMasksSecrets() {
    System.runAs(userNamed(READER)) {
      OrgIntelContextHubModule module = new OrgIntelContextHubModule();
      Test.startTest();
      Assert.areEqual(OrgIntelModules.CONTEXT_HUB, module.key());
      Assert.isTrue(module.isAccessible());
      OrgContextService.ContextResult result = (OrgContextService.ContextResult) module.invoke(
        'prepareContext',
        new Map<String, Object>{
          'content' => '# Context\nAuthorization: Bearer abc.def.ghi\nurl?access_token=xyz'
        }
      );
      OrgContextService.ContextResult empty = (OrgContextService.ContextResult) module.invoke(
        'prepareContext',
        new Map<String, Object>()
      );
      Test.stopTest();
      Assert.isFalse(result.content.contains('abc.def.ghi'));
      Assert.isFalse(result.content.contains('xyz'));
      Assert.areEqual(2, result.redactionCount);
      Assert.areEqual(result.content.length(), result.characterCount);
      Assert.areEqual(64, result.contentHash.length());
      Assert.areEqual('', empty.content);
      Assert.areEqual(0, empty.characterCount);
    }
  }

  @IsTest
  static void tooLargeContextIsRefused() {
    System.runAs(userNamed(READER)) {
      try {
        new OrgIntelContextHubModule()
          .invoke(
            'prepareContext',
            new Map<String, Object>{
              'content' => 'x'.repeat(OrgContextService.MAX_LENGTH + 1)
            }
          );
        Assert.fail('Context too large');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('too large'), e.getMessage());
      }
    }
  }

  @IsTest
  static void accessIsChecked() {
    System.runAs(userNamed(NO_MODULE)) {
      Assert.isFalse(
        new OrgIntelContextHubModule().isAccessible(),
        'Custom permission of the module missing'
      );
    }
    System.runAs(userNamed(OUTSIDER)) {
      OrgIntelContextHubModule module = new OrgIntelContextHubModule();
      Assert.isTrue(module.isAccessible());
      try {
        module.invoke('prepareContext', new Map<String, Object>());
        Assert.fail('No Org Intelligence permission set');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('do not have access'));
      }
      try {
        module.invoke('doesNotExist', new Map<String, Object>());
        Assert.fail('Unknown action');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('doesNotExist'));
      }
    }
  }

  // ---------- Outils ----------

  private static void createUser(String alias, List<String> permissionSets) {
    String unique =
      alias +
      '.' +
      EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(10) +
      '@orgintel.test';
    Profile profile = [
      SELECT Id
      FROM Profile
      WHERE
        UserType = 'Standard'
        AND PermissionsModifyAllData = FALSE
        AND UserLicense.Name = 'Salesforce'
      ORDER BY Name
      LIMIT 1
    ];
    User user = new User(
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
  }

  private static User userNamed(String alias) {
    return [SELECT Id FROM User WHERE LastName = :('Test ' + alias) LIMIT 1];
  }
}
