/**
 * Tests des contrôles de sécurité (OrgSecurityChecks) avec des données créées dans le test :
 * permission sets inutilisés, « Modify All » par objet, lien public sans expiration, mode debug,
 * administrateur d'intégration. Les objets non créables (LoginHistory, jetons OAuth, Health Check)
 * sont vérifiés par des assertions tolérantes.
 */
@IsTest
private class OrgSecurityChecksTest {
  private static Map<String, OrgSecurityChecks.Check> byKey(
    List<OrgSecurityChecks.Check> checks
  ) {
    Map<String, OrgSecurityChecks.Check> result = new Map<String, OrgSecurityChecks.Check>();
    for (OrgSecurityChecks.Check check : checks) {
      result.put(check.key, check);
    }
    return result;
  }

  /** Données qui déclenchent des constats ; renvoie l'administrateur qui lance l'audit. */
  private static User setupFindings() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    // Administrateur d'intégration avec le mode debug
    User integration = OrgSecurityTestSupport.adminWith(null);
    integration.LastName = 'Integration';
    integration.UserPreferencesUserDebugModePref = true;
    update integration;

    // Permission sets jamais attribués (au-delà du seuil de 5)
    List<PermissionSet> unused = new List<PermissionSet>();
    for (Integer i = 0; i < 7; i++) {
      unused.add(
        new PermissionSet(
          Name = 'OiSecUnused' + i,
          Label = 'OI Sec Unused ' + i
        )
      );
    }
    // « Modify All » sur un objet sans « Modify All Data »
    PermissionSet modifyAll = new PermissionSet(
      Name = 'OiSecModifyAll',
      Label = 'OI Sec Modify All',
      PermissionsApiEnabled = true
    );
    unused.add(modifyAll);
    insert unused;
    insert new ObjectPermissions(
      ParentId = modifyAll.Id,
      SobjectType = 'Account',
      PermissionsRead = true,
      PermissionsEdit = true,
      PermissionsDelete = true,
      PermissionsCreate = true,
      PermissionsViewAllRecords = true,
      PermissionsModifyAllRecords = true
    );

    // Lien public sans expiration (objets de données : hors du contexte des objets de Setup)
    System.runAs(admin) {
      ContentVersion version = new ContentVersion(
        Title = 'Security test file',
        PathOnClient = 'security-test.txt',
        VersionData = Blob.valueOf('test')
      );
      insert version;
      insert new ContentDistribution(
        Name = 'Security test link',
        ContentVersionId = version.Id,
        PreferencesAllowViewInBrowser = true,
        PreferencesExpires = false,
        PreferencesPasswordRequired = false
      );
    }
    return admin;
  }

  @IsTest
  static void productionAuditFlagsTheTestData() {
    User admin = setupFindings();
    Map<String, OrgSecurityChecks.Check> checks;
    OrgSecurityChecks engine = new OrgSecurityChecks(false);
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(false, null);
      engine.loadHealthCheck();
      Test.startTest();
      checks = byKey(engine.run());
      Test.stopTest();
    }
    Assert.areEqual(26, checks.size());
    Assert.isTrue(engine.activeUsers >= 2);

    OrgSecurityChecks.Check unused = checks.get('UNUSED_PERMISSION_SETS');
    Assert.isTrue(unused.count >= 7, 'permission sets inutilisés');
    Assert.areEqual(OrgSecurityChecks.WARNING, unused.status);

    OrgSecurityChecks.Check modifyAll = checks.get('MODIFY_ALL_RECORDS');
    Assert.areEqual(OrgSecurityChecks.WARNING, modifyAll.status);
    Assert.isTrue(modifyAll.count >= 1);

    OrgSecurityChecks.Check links = checks.get('PUBLIC_LINKS');
    Assert.isTrue(links.count >= 1);
    Assert.areNotEqual(OrgSecurityChecks.PASS, links.status);

    OrgSecurityChecks.Check debug = checks.get('DEBUG_MODE');
    Assert.isTrue(debug.count >= 1);
    Assert.areEqual(OrgSecurityChecks.WARNING, debug.status);

    OrgSecurityChecks.Check integration = checks.get('INTEGRATION_ADMINS');
    Assert.areEqual(OrgSecurityChecks.FAIL, integration.status);

    OrgSecurityChecks.Check inactiveAdmins = checks.get('INACTIVE_ADMINS');
    Assert.areEqual(
      OrgSecurityChecks.FAIL,
      inactiveAdmins.status,
      'les administrateurs de test ne se sont jamais connectés'
    );
    Assert.isTrue(inactiveAdmins.items.size() <= OrgSecurityChecks.ITEM_CAP);

    Assert.areEqual(
      OrgSecurityChecks.NOT_EVALUATED,
      checks.get('HEALTH_CHECK').status
    );
    // Contrôles dépendant de l'org (LoginHistory, jetons, audit trail) : un statut est toujours rendu
    for (
      String key : new List<String>{
        'FAILED_LOGINS',
        'OAUTH_TOKENS',
        'SETUP_CHANGES',
        'MFA',
        'GUEST_ACCESS',
        'ORG_WIDE_DEFAULTS',
        'CUSTOM_OBJECT_SHARING',
        'UNUSED_PROFILES',
        'POWERFUL_PROFILES',
        'POWERFUL_PERMISSION_SETS',
        'API_ENABLED',
        'EXPORT_REPORTS'
      }
    ) {
      Assert.isNotNull(checks.get(key).status, key);
      Assert.isNotNull(checks.get(key).metric, key);
    }
  }

  @IsTest
  static void sandboxAuditIsMoreLenient() {
    User admin = setupFindings();
    Map<String, OrgSecurityChecks.Check> checks;
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(false, null);
      OrgSecurityChecks engine = new OrgSecurityChecks(true);
      Test.startTest();
      checks = byKey(engine.run());
      Test.stopTest();
    }
    Assert.areEqual(
      OrgSecurityChecks.PASS,
      checks.get('DEBUG_MODE').status,
      'le mode debug est admis en sandbox'
    );
    Assert.isTrue(checks.get('DEBUG_MODE').metric.contains('sandbox'));
  }

  @IsTest
  static void helpersAreReusable() {
    Assert.isTrue(OrgSecurityChecks.rowsLeft(0) > 0);
    Map<Id, Integer> byProfile = OrgSecurityChecks.activeUsersByProfile();
    Assert.isFalse(byProfile.isEmpty());
    Assert.isTrue(
      OrgSecurityChecks.ADMIN_PERMISSIONS.containsKey(
        'PermissionsModifyAllData'
      )
    );
    Assert.areEqual(6, OrgSecurityChecks.CATEGORY_ORDER.size());
    OrgSecurityChecks.Item item = new OrgSecurityChecks.Item('a', 'b');
    Assert.areEqual('a', item.label);
    Assert.areEqual('b', item.detail);
  }
}
