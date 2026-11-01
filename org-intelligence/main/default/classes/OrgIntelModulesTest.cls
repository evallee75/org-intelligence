/**
 * Socle et modules : registre (OrgIntelModules), classe de base (OrgIntelModule), contrôleur des
 * écrans des modules (OrgIntelModuleController), namespace (OrgIntelNamespace), droits
 * (OrgIntelAccess), journal API (OrgApiLogger) et maintenance (OrgMaintenanceService).
 */
@IsTest
private class OrgIntelModulesTest {
  @IsTest
  static void registryFindsOnlyAvailableModules() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.withoutModules();
      Assert.isFalse(OrgIntelModules.isInstalled(OrgIntelModules.SECURITY));
      Assert.isTrue(OrgIntelModules.installed().isEmpty());
      Assert.isNull(OrgIntelModules.recommendations());
      Assert.isNull(OrgIntelModules.apiLogSink());
      Assert.isTrue(OrgIntelModules.availableTools().isEmpty());

      OrgIntelTestSupport.FakeModule hidden = new OrgIntelTestSupport.FakeModule(
        OrgIntelModules.SECURITY
      );
      hidden.accessible = false;
      OrgIntelTestSupport.withModule(OrgIntelModules.SECURITY, hidden);
      OrgIntelTestSupport.withModule(
        OrgIntelModules.UNINSTALL,
        new OrgIntelTestSupport.FakeModule(OrgIntelModules.UNINSTALL)
      );
      OrgIntelTestSupport.withModule(
        OrgIntelModules.API_MONITORING,
        new OrgIntelTestSupport.FakeModule(OrgIntelModules.API_MONITORING)
      );
      Assert.isTrue(OrgIntelModules.isInstalled(OrgIntelModules.SECURITY));
      Assert.isNull(OrgIntelModules.available(OrgIntelModules.SECURITY));
      Assert.areEqual(2, OrgIntelModules.installed().size(), 'outils exclus');
      Assert.areEqual(
        new List<String>{ OrgIntelModules.UNINSTALL },
        OrgIntelModules.availableTools()
      );
      Assert.isNotNull(OrgIntelModules.apiLogSink());

      assertRequireFails(OrgIntelModules.SECURITY, 'do not have access');
      assertRequireFails(OrgIntelModules.ADOPTION, 'not installed');
      assertRequireFails('unknownModule', 'unknownModule');
      Assert.isNotNull(OrgIntelModules.require(OrgIntelModules.API_MONITORING));
    }
  }

  @IsTest
  static void realModulesAreDiscoveredByName() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      // Sans substitution : découverte par Type.forName (modules présents ou non dans l'org)
      for (String key : OrgIntelModules.ENTRY_CLASSES.keySet()) {
        OrgIntelModule module = OrgIntelModules.get(key);
        Assert.isTrue(module == null || module.key() == key);
      }
      Assert.isNotNull(OrgIntelModuleController.getModules());
      Assert.isNotNull(OrgIntelModuleController.getTools());
    }
  }

  private static void assertRequireFails(String key, String expected) {
    try {
      OrgIntelModules.require(key);
      Assert.fail('Expected an AuraHandledException for ' + key);
    } catch (AuraHandledException e) {
      Assert.isTrue(e.getMessage().contains(expected), e.getMessage());
    }
  }

  @IsTest
  static void controllerDispatchesToModules() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeModule module = new OrgIntelTestSupport.FakeModule(
        OrgIntelModules.INVENTORY
      );
      OrgIntelTestSupport.withModule(OrgIntelModules.INVENTORY, module);
      OrgIntelTestSupport.FakeModule hidden = new OrgIntelTestSupport.FakeModule(
        OrgIntelModules.ADOPTION
      );
      hidden.accessible = false;
      OrgIntelTestSupport.withModule(OrgIntelModules.ADOPTION, hidden);

      List<OrgIntelModuleController.ModuleInfo> modules = OrgIntelModuleController.getModules();
      Assert.areEqual(1, modules.size());
      Assert.areEqual('Inventory', modules[0].label);
      Assert.isTrue(OrgIntelModuleController.getTools().isEmpty());
      Assert.areEqual('', OrgIntelModuleController.getNamespace());

      String echoed = OrgIntelModuleController.invoke(
        OrgIntelModules.INVENTORY,
        'echo',
        '{"a":1}'
      );
      Assert.areEqual('{"a":1}', echoed);
      Assert.areEqual(
        '{}',
        OrgIntelModuleController.invoke(OrgIntelModules.INVENTORY, 'echo', '  ')
      );
      Assert.areEqual(
        '{}',
        OrgIntelModuleController.invoke(
          OrgIntelModules.INVENTORY,
          'echo',
          'null'
        )
      );
      Assert.isNull(
        OrgIntelModuleController.invoke(
          OrgIntelModules.INVENTORY,
          'nothing',
          null
        )
      );

      assertInvokeFails('echo', '[1,2]', 'JSON object');
      assertInvokeFails('echo', '{oops', 'not valid JSON');
      assertInvokeFails('fail', null, 'could not be completed');
      assertInvokeFails('refuse', null, 'Readable refusal');
      assertInvokeFails('unknown', null, 'Unknown action');
    }
  }

  private static void assertInvokeFails(
    String action,
    String paramsJson,
    String expected
  ) {
    try {
      OrgIntelModuleController.invoke(
        OrgIntelModules.INVENTORY,
        action,
        paramsJson
      );
      Assert.fail('Expected an AuraHandledException for ' + action);
    } catch (AuraHandledException e) {
      Assert.isTrue(e.getMessage().contains(expected), e.getMessage());
    }
  }

  @IsTest
  static void moduleHelpersReadParameters() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.withModule(
        OrgIntelModules.INVENTORY,
        new OrgIntelTestSupport.FakeModule(OrgIntelModules.INVENTORY)
      );
      String userId = UserInfo.getUserId();
      Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
        OrgIntelModuleController.invoke(
          OrgIntelModules.INVENTORY,
          'helpers',
          JSON.serialize(
            new Map<String, Object>{
              'text' => 42,
              'recordId' => userId,
              'integer' => 3,
              'integerText' => '4.0',
              'decimal' => '2.5',
              'boolean' => 'true',
              'list' => new List<Object>{ 'a', null, 1 },
              'ids' => new List<Object>{ userId, '' }
            }
          )
        )
      );
      Assert.areEqual('42', result.get('text'));
      Assert.areEqual(userId, result.get('recordId'));
      Assert.isNull(result.get('blankId'));
      Assert.areEqual(3, result.get('integer'));
      Assert.areEqual(4, result.get('integerFromText'));
      Assert.isNull(result.get('missingInteger'));
      Assert.areEqual(2.5, result.get('decimal'));
      Assert.isNull(result.get('missingDecimal'));
      Assert.areEqual(true, result.get('boolean'));
      Assert.isNull(result.get('missingBoolean'));
      Assert.areEqual(3, ((List<Object>) result.get('list')).size());
      Assert.areEqual(1, ((List<Object>) result.get('ids')).size());

      // Comportement par défaut de la classe de base
      OrgIntelModule plain = new PlainModule();
      Assert.isTrue(plain.isAccessible());
      Assert.isTrue(plain.recordCounts().isEmpty());
      OrgMaintenanceService.Result maintenance = new OrgMaintenanceService.Result();
      plain.purge(maintenance);
      Assert.areEqual(0, maintenance.apiLogsDeleted);
    }
  }

  /** Module minimal : seules les méthodes abstraites sont fournies. */
  private class PlainModule extends OrgIntelModule {
    public override String key() {
      return 'plain';
    }
    public override Object invoke(String action, Map<String, Object> params) {
      return null;
    }
  }

  @IsTest
  static void catalogAndAccessGrant() {
    User admin = OrgIntelTestSupport.adminUser();
    System.runAs(admin) {
      OrgIntelTestSupport.withoutModules();
      OrgIntelTestSupport.withModule(
        OrgIntelModules.INVENTORY,
        new OrgIntelTestSupport.FakeModule(OrgIntelModules.INVENTORY)
      );
      OrgIntelModuleController.Catalog catalog = OrgIntelModuleController.getModuleCatalog();
      Assert.isTrue(catalog.isAdmin);
      Assert.isTrue(catalog.installBaseUrl.contains('installPackage.apexp'));
      Map<String, OrgIntelModuleController.CatalogEntry> byKey = new Map<String, OrgIntelModuleController.CatalogEntry>();
      for (OrgIntelModuleController.CatalogEntry entry : catalog.modules) {
        byKey.put(entry.key, entry);
      }
      Assert.isTrue(byKey.get(OrgIntelModuleController.CORE).installed);
      Assert.isTrue(byKey.get(OrgIntelModuleController.CORE).assigned);
      Assert.isTrue(
        byKey.get(OrgIntelModuleController.CORE).permissionSetFound
      );
      Assert.isTrue(byKey.get(OrgIntelModules.INVENTORY).installed);
      Assert.isFalse(byKey.get(OrgIntelModules.SECURITY).installed);

      // Déjà attribué : rien à faire
      OrgIntelModuleController.grantModuleAccess(OrgIntelModuleController.CORE);
      assertGrantFails('nope', 'Unknown module');
      assertGrantFails(OrgIntelModules.SECURITY, 'not installed');
    }
  }

  @IsTest
  static void grantAssignsThePermissionSet() {
    User admin = OrgIntelTestSupport.newUser('oigrant', true);
    insert admin;
    System.runAs(admin) {
      OrgIntelTestSupport.withoutModules();
      Test.startTest();
      OrgIntelModuleController.grantModuleAccess(OrgIntelModuleController.CORE);
      Test.stopTest();
    }
    Assert.areEqual(
      1,
      [
        SELECT COUNT()
        FROM PermissionSetAssignment
        WHERE
          AssigneeId = :admin.Id
          AND PermissionSet.Name = :OrgIntelTestSupport.ADMIN_PERMISSION_SET
      ]
    );
  }

  @IsTest
  static void grantIsRefusedWithoutAssignRight() {
    System.runAs(OrgIntelTestSupport.outsiderUser()) {
      OrgIntelTestSupport.withoutModules();
      assertGrantFails(OrgIntelModuleController.CORE, 'could not be assigned');
      Assert.isFalse(OrgIntelModuleController.getModuleCatalog().canAssign);
    }
  }

  private static void assertGrantFails(String key, String expected) {
    try {
      OrgIntelModuleController.grantModuleAccess(key);
      Assert.fail('Expected an AuraHandledException for ' + key);
    } catch (AuraHandledException e) {
      Assert.isTrue(e.getMessage().contains(expected), e.getMessage());
    }
  }

  @IsTest
  static void namespaceHelpers() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      Assert.areEqual('', OrgIntelNamespace.prefix());
      Assert.areEqual('', OrgIntelNamespace.apiPrefix());
      Assert.isNull(OrgIntelNamespace.namespaceFilter());
      Assert.areEqual('Title__c', OrgIntelNamespace.qualify('Title__c'));
      Assert.areEqual('Title__c', OrgIntelNamespace.unqualify('Title__c'));
      Assert.areEqual('{"a__c":1}', OrgIntelNamespace.stripKeys('{"a__c":1}'));
      Assert.areEqual(
        OrgIntelNamespace.class.getName(),
        OrgIntelNamespace.typeFor('OrgIntelNamespace').getName()
      );

      OrgIntelNamespace.prefixOverride = 'orgintel';
      Assert.areEqual('orgintel__', OrgIntelNamespace.apiPrefix());
      Assert.areEqual('orgintel', OrgIntelNamespace.namespaceFilter());
      Assert.areEqual(
        'orgintel__OrgApiLog__c',
        OrgIntelNamespace.qualify('OrgApiLog__c')
      );
      Assert.areEqual(
        'orgintel__OrgApiLog__c',
        OrgIntelNamespace.qualify('orgintel__OrgApiLog__c')
      );
      Assert.areEqual(
        'other__Field__c',
        OrgIntelNamespace.qualify('other__Field__c'),
        'déjà préfixé par un autre namespace'
      );
      Assert.areEqual('', OrgIntelNamespace.qualify(''));
      Assert.areEqual(
        'OrgApiLog__c',
        OrgIntelNamespace.unqualify('orgintel__OrgApiLog__c')
      );
      Assert.areEqual('Name', OrgIntelNamespace.unqualify('Name'));
      Assert.areEqual(
        'callout:orgintel__OrgIntelligenceJira',
        OrgIntelNamespace.callout('OrgIntelligenceJira')
      );
      Assert.areEqual(
        '{"Title__c": "orgintel__x", "Rel__r":{}}',
        OrgIntelNamespace.stripKeys(
          '{"orgintel__Title__c": "orgintel__x", "orgintel__Rel__r":{}}'
        )
      );
      Assert.isNull(OrgIntelNamespace.stripKeys(null));
      Assert.isNull(OrgIntelNamespace.typeFor('OrgIntelNamespace'));
      OrgIntelNamespace.prefixOverride = null;
    }
  }

  @IsTest
  static void accessChecksAndErrors() {
    System.runAs(OrgIntelTestSupport.readerUser()) {
      Assert.isTrue(OrgIntelAccess.canRead());
      Assert.isFalse(OrgIntelAccess.isAdmin());
      OrgIntelAccess.assertCanRead();
      try {
        OrgIntelAccess.assertAdmin();
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('administrators'));
      }
      AuraHandledException original = OrgIntelAccess.error('original');
      Assert.areEqual(original, OrgIntelAccess.error('context', original));
      try {
        insert new Account();
      } catch (DmlException e) {
        AuraHandledException wrapped = OrgIntelAccess.error('Save failed', e);
        Assert.isTrue(wrapped.getMessage().startsWith('Save failed: '));
      }
      Assert.isTrue(
        OrgIntelAccess.error('Ctx', new IllegalArgumentException('bad'))
          .getMessage()
          .contains('bad')
      );
    }
    System.runAs(OrgIntelTestSupport.outsiderUser()) {
      Assert.isFalse(OrgIntelAccess.canRead());
      try {
        OrgIntelAccess.assertAdmin();
        Assert.fail('Expected an AuraHandledException');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('do not have access'));
      }
    }
  }

  @IsTest
  static void apiLoggerBuffersAndMasks() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeModule sink = new OrgIntelTestSupport.FakeModule(
        OrgIntelModules.API_MONITORING
      );
      OrgIntelTestSupport.withModule(OrgIntelModules.API_MONITORING, sink);
      OrgApiLogger.flush(); // rien en attente
      OrgApiLogger.Entry entry = new OrgApiLogger.Entry();
      entry.systemName = 'Test';
      OrgApiLogger.log(entry);
      Assert.areEqual(1, OrgApiLogger.pendingCount());
      OrgApiLogger.flush();
      Assert.areEqual(1, sink.savedEntries);
      Assert.areEqual(0, OrgApiLogger.pendingCount());

      sink.failOnSave = true;
      OrgApiLogger.logNow(new OrgApiLogger.Entry());
      Assert.areEqual(0, OrgApiLogger.pendingCount(), 'échec ignoré');

      OrgIntelTestSupport.withModule(OrgIntelModules.API_MONITORING, null);
      OrgApiLogger.logNow(new OrgApiLogger.Entry());
      Assert.areEqual(0, OrgApiLogger.pendingCount(), 'sans module : ignoré');

      String masked = OrgApiLogger.redact(
        '{"access_token":"abc123","password":"p4ss"} token=xyz Bearer abc.def 00D000000000001!AQ.secret'
      );
      Assert.isFalse(masked.contains('abc123'), masked);
      Assert.isFalse(masked.contains('p4ss'), masked);
      Assert.isFalse(masked.contains('xyz'), masked);
      Assert.isFalse(masked.contains('abc.def'), masked);
      Assert.isFalse(masked.contains('AQ.secret'), masked);
      Assert.isNull(OrgApiLogger.redact(null));

      String longText =
        '"password":"first", ' +
        'word '.repeat(OrgApiLogger.REDACT_CHUNK / 2) +
        '"password":"second"' +
        'x'.repeat(OrgApiLogger.REDACT_CHUNK + 10);
      String longMasked = OrgApiLogger.redact(longText);
      Assert.isFalse(longMasked.contains('first'));
      Assert.isFalse(longMasked.contains('second'));
    }
  }

  @IsTest
  static void maintenanceAsksEveryModuleToPurge() {
    System.runAs(OrgIntelTestSupport.adminUser()) {
      OrgIntelTestSupport.FakeModule module = new OrgIntelTestSupport.FakeModule(
        OrgIntelModules.API_MONITORING
      );
      OrgIntelTestSupport.withModule(OrgIntelModules.API_MONITORING, module);
      OrgMaintenanceService.Result result = OrgAdminController.runMaintenance();
      Assert.areEqual(1, module.purged);
      Assert.areEqual(2, result.apiLogsDeleted);
      Assert.areEqual(
        OrgIntelSettings.apiLogRetentionDays(),
        result.retentionDays()
      );
      result.addDeleted(null);
      Assert.areEqual(2, result.apiLogsDeleted);
    }
  }
}
