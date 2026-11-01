/**
 * Tests de la classe d'entrée du module Security (OrgIntelSecurityModule) et de son contrôleur :
 * chaque action passe par la classe d'entrée (invoke) avec un administrateur portant le
 * permission set du module ; refus sans le module, refus sans le socle, actions et paramètres invalides.
 */
@IsTest
private class OrgIntelSecurityModuleTest {
  private static String call(String action, Map<String, Object> params) {
    return OrgSecurityTestSupport.invokeModule(
      new OrgIntelSecurityModule(),
      action,
      params
    );
  }

  private static PermissionSet newPermissionSet(String name) {
    PermissionSet ps = new PermissionSet(Name = name, Label = name);
    insert ps;
    insert new ObjectPermissions(
      ParentId = ps.Id,
      SobjectType = 'Account',
      PermissionsRead = true
    );
    return ps;
  }

  @IsTest
  static void moduleIdentity() {
    OrgIntelSecurityModule module = new OrgIntelSecurityModule();
    Assert.areEqual(OrgIntelModules.SECURITY, module.key());
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    System.runAs(admin) {
      Assert.isTrue(module.isAccessible());
    }
  }

  @IsTest
  static void everyActionAnswersThroughTheController() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    PermissionSet left = newPermissionSet('OiModLeft');
    PermissionSet right = newPermissionSet('OiModRight');
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(false, null);
      Test.startTest();
      String audit = call('runAudit', null);
      Assert.isTrue(audit.contains('"checks"'), 'audit rendu');
      Assert.isTrue(audit.contains('HEALTH_CHECK'));

      Assert.isTrue(call('permissionOverview', null).contains('"containers"'));
      Assert.isTrue(call('permissionUsers', null).contains('"distribution"'));

      String objects = call(
        'permissionObjectAccess',
        new Map<String, Object>{
          'containerIds' => new List<Object>{ left.Id, '', right.Id }
        }
      );
      Assert.isTrue(objects.contains('Account:R'), objects);

      String fields = call(
        'permissionFieldAccess',
        new Map<String, Object>{ 'objectName' => 'Account' }
      );
      Assert.isTrue(fields.contains('"objectName":"Account"'), fields);

      String comparison = call(
        'comparePermissions',
        new Map<String, Object>{ 'leftId' => left.Id, 'rightId' => right.Id }
      );
      Assert.isTrue(comparison.contains('"leftName":"OiModLeft"'), comparison);
      Test.stopTest();
    }
  }

  @IsTest
  static void invalidRequestsAreRefusedReadably() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    System.runAs(admin) {
      Map<String, Map<String, Object>> cases = new Map<String, Map<String, Object>>{
        'nope' => new Map<String, Object>(),
        'comparePermissions' => new Map<String, Object>{
          'leftId' => 'not-an-id',
          'rightId' => null
        },
        'permissionFieldAccess' => new Map<String, Object>{
          'objectName' => 'Unknown_Object__zz'
        }
      };
      for (String action : cases.keySet()) {
        try {
          call(action, cases.get(action));
          Assert.fail('action refusée : ' + action);
        } catch (AuraHandledException e) {
          Assert.isFalse(String.isBlank(e.getMessage()), action);
        }
      }
      // Comparaison sans second conteneur : message métier conservé par le contrôleur
      try {
        OrgSecurityController.comparePermissions(null, null);
        Assert.fail('comparaison refusée');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('two different'));
      }
      try {
        new OrgIntelSecurityModule().invoke('nope', new Map<String, Object>());
        Assert.fail('action inconnue');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('nope'));
      }
    }
  }

  @IsTest
  static void userWithoutTheModuleIsRefused() {
    User restricted = OrgSecurityTestSupport.restrictedUser(
      new List<String>{ OrgSecurityTestSupport.CORE_ADMIN }
    );
    if (restricted == null) {
      return; // aucun profil sans droit d'administration dans l'org
    }
    System.runAs(restricted) {
      Assert.isFalse(new OrgIntelSecurityModule().isAccessible());
      try {
        call('runAudit', null);
        Assert.fail('module refusé');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('access'), e.getMessage());
      }
    }
  }

  @IsTest
  static void userWithoutTheCoreAdminIsRefused() {
    User restricted = OrgSecurityTestSupport.restrictedUser(
      new List<String>{ OrgSecurityTestSupport.MODULE_ADMIN }
    );
    if (restricted == null) {
      return;
    }
    System.runAs(restricted) {
      for (Integer i = 0; i < 6; i++) {
        try {
          if (i == 0) {
            OrgSecurityController.runAudit();
          } else if (i == 1) {
            OrgSecurityController.permissionOverview();
          } else if (i == 2) {
            OrgSecurityController.permissionUsers();
          } else if (i == 3) {
            OrgSecurityController.permissionObjectAccess(new List<Id>());
          } else if (i == 4) {
            OrgSecurityController.permissionFieldAccess('Account');
          } else {
            OrgSecurityController.comparePermissions(null, null);
          }
          Assert.fail('accès socle refusé (' + i + ')');
        } catch (AuraHandledException e) {
          Assert.isTrue(
            e.getMessage().contains('Org Intelligence'),
            e.getMessage()
          );
        }
      }
    }
  }

  @IsTest
  static void unexpectedFailuresAreTranslated() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    System.runAs(admin) {
      OrgSecurityController.simulatedFailure = 'Simulated failure';
      for (Integer i = 0; i < 6; i++) {
        try {
          if (i == 0) {
            OrgSecurityController.runAudit();
          } else if (i == 1) {
            OrgSecurityController.permissionOverview();
          } else if (i == 2) {
            OrgSecurityController.permissionUsers();
          } else if (i == 3) {
            OrgSecurityController.permissionObjectAccess(new List<Id>());
          } else if (i == 4) {
            OrgSecurityController.permissionFieldAccess('Account');
          } else {
            OrgSecurityController.comparePermissions(null, null);
          }
          Assert.fail('erreur attendue (' + i + ')');
        } catch (AuraHandledException e) {
          Assert.isTrue(
            e.getMessage().contains('Simulated failure'),
            e.getMessage()
          );
        }
      }
    }
  }
}
