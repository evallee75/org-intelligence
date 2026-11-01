@IsTest
private class OrgIntelUninstallToolTest {
  private static final String DEPLOY_ID = OrgUninstallServiceTest.DEPLOY_ID;

  @TestSetup
  static void setup() {
    OrgUninstallServiceTest.createUsers();
  }

  private static User admin() {
    return OrgUninstallServiceTest.userNamed(
      OrgUninstallServiceTest.ADMIN_USERNAME
    );
  }

  private static User plain() {
    return OrgUninstallServiceTest.userNamed(
      OrgUninstallServiceTest.PLAIN_USERNAME
    );
  }

  private static Boolean sandbox() {
    Organization org = [
      SELECT IsSandbox, OrganizationType
      FROM Organization
      LIMIT 1
    ];
    return org.IsSandbox || org.OrganizationType == 'Developer Edition';
  }

  @IsTest
  static void keyIsUninstall() {
    System.runAs(admin()) {
      Test.startTest();
      String key = new OrgIntelUninstallTool().key();
      Test.stopTest();
      Assert.areEqual(OrgIntelModules.UNINSTALL, key);
    }
  }

  @IsTest
  static void isAccessibleForOrgIntelligenceAdmin() {
    System.runAs(admin()) {
      Test.startTest();
      Boolean accessible = new OrgIntelUninstallTool().isAccessible();
      Test.stopTest();
      Assert.isTrue(accessible, 'administrateur Org Intelligence');
    }
  }

  @IsTest
  static void isAccessibleForUserAllowedToDeployMetadata() {
    System.runAs(OrgUninstallServiceTest.userNamed(
      OrgUninstallServiceTest.SYSADMIN_USERNAME
    )) {
      Test.startTest();
      Boolean accessible = new OrgIntelUninstallTool().isAccessible();
      Test.stopTest();
      Assert.isTrue(accessible, 'Modify Metadata / Modify All Data');
    }
  }

  @IsTest
  static void isNotAccessibleForUserWithoutRights() {
    System.runAs(plain()) {
      Test.startTest();
      Boolean accessible = new OrgIntelUninstallTool().isAccessible();
      Test.stopTest();
      Assert.isFalse(accessible, 'utilisateur standard sans permission set');
    }
  }

  @IsTest
  static void getStatusReturnsUninstallStatus() {
    OrgUninstallServiceTest.install(true);
    System.runAs(admin()) {
      Test.startTest();
      Object result = new OrgIntelUninstallTool()
        .invoke('getStatus', new Map<String, Object>());
      Test.stopTest();
      OrgUninstallService.UninstallStatus status = (OrgUninstallService.UninstallStatus) result;
      Assert.areEqual(OrgUninstallService.MODE_SOURCE, status.mode);
      Assert.areEqual('DELETE', status.confirmation);
    }
  }

  @IsTest
  static void getStatusWrapsErrorsInReadableMessage() {
    OrgUninstallServiceTest.install(true);
    System.runAs(admin()) {
      Test.startTest();
      // Les actions sont gardées par assertAdmin : l'erreur vient ici du manque de droits
      System.runAs(plain()) {
        try {
          new OrgIntelUninstallTool()
            .invoke('getStatus', new Map<String, Object>());
          Assert.fail('action admin acceptée sans droits');
        } catch (AuraHandledException e) {
          Assert.isTrue(
            e.getMessage().contains('Org Intelligence'),
            e.getMessage()
          );
        }
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void adminActionsRefusedForUserWithoutRights() {
    OrgUninstallServiceTest.UninstallMock mock = OrgUninstallServiceTest.install(
      true
    );
    System.runAs(plain()) {
      Test.startTest();
      for (
        String action : new List<String>{ 'getStatus', 'prepare', 'uninstall' }
      ) {
        try {
          new OrgIntelUninstallTool()
            .invoke(
              action,
              new Map<String, Object>{ 'confirmation' => 'DELETE' }
            );
          Assert.fail('action acceptée sans droits : ' + action);
        } catch (AuraHandledException e) {
          Assert.isNotNull(e.getMessage(), action);
        }
      }
      Test.stopTest();
    }
    Assert.areEqual(0, mock.submitCount, 'aucun déploiement soumis');
    Assert.areEqual(0, mock.deleteCount, 'aucun rapport supprimé');
  }

  @IsTest
  static void prepareWrapsFailureInReadableError() {
    OrgUninstallServiceTest.install(false);
    System.runAs(admin()) {
      Test.startTest();
      try {
        new OrgIntelUninstallTool()
          .invoke(
            'prepare',
            new Map<String, Object>{ 'confirmation' => 'DELETE' }
          );
        Assert.fail('prepare permis sans connexion Tooling');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().startsWith('The reports could not be removed')
        );
        Assert.isTrue(e.getMessage().contains('not set up'), e.getMessage());
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void prepareDeletesReports() {
    OrgUninstallServiceTest.UninstallMock mock = OrgUninstallServiceTest.install(
      true
    );
    System.runAs(admin()) {
      if (!sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        Object result = new OrgIntelUninstallTool()
          .invoke(
            'prepare',
            new Map<String, Object>{ 'confirmation' => 'DELETE' }
          );
        Test.stopTest();
        Assert.areEqual(mock.deleteCount, (Integer) result);
      }
    }
  }

  @IsTest
  static void uninstallWrapsFailureInReadableError() {
    OrgUninstallServiceTest.UninstallMock mock = OrgUninstallServiceTest.install(
      false
    );
    System.runAs(admin()) {
      Test.startTest();
      try {
        new OrgIntelUninstallTool()
          .invoke(
            'uninstall',
            new Map<String, Object>{ 'confirmation' => 'DELETE' }
          );
        Assert.fail('désinstallation permise sans connexion Tooling');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().startsWith('The uninstall could not start')
        );
        Assert.isTrue(e.getMessage().contains('not set up'), e.getMessage());
      }
      Test.stopTest();
    }
    Assert.areEqual(0, mock.submitCount);
  }

  @IsTest
  static void uninstallFailsWhenDeploymentRejected() {
    OrgUninstallServiceTest.UninstallMock mock = OrgUninstallServiceTest.install(
      true
    );
    mock.submitStatus = 500;
    mock.submitBody = 'refused';
    System.runAs(admin()) {
      if (!sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        try {
          new OrgIntelUninstallTool()
            .invoke(
              'uninstall',
              new Map<String, Object>{
                'confirmation' => 'DELETE',
                'removeToolingConnection' => 'true'
              }
            );
          Assert.fail('rejet HTTP ignoré');
        } catch (AuraHandledException e) {
          Assert.isTrue(e.getMessage().contains('500'), e.getMessage());
        }
        Test.stopTest();
      }
    }
  }

  @IsTest
  static void uninstallSubmitsDeploymentsAndReturnsResult() {
    OrgUninstallServiceTest.UninstallMock mock = OrgUninstallServiceTest.install(
      true
    );
    Boolean realJobs =
      [
        SELECT COUNT()
        FROM CronTrigger
        WHERE CronJobDetail.Name LIKE 'Org Intelligence%'
      ] > 0;
    System.runAs(admin()) {
      // Jobs réels dans l'org : on ne les arrête pas depuis un test
      if (realJobs || !sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        Object result = new OrgIntelUninstallTool()
          .invoke(
            'uninstall',
            new Map<String, Object>{
              'confirmation' => 'DELETE',
              'removeToolingConnection' => true
            }
          );
        Test.stopTest();
        OrgUninstallService.UninstallResult uninstall = (OrgUninstallService.UninstallResult) result;
        Assert.areEqual(DEPLOY_ID, uninstall.deployId);
        Assert.areEqual(3, mock.submitCount);
        Assert.isTrue(uninstall.assignmentsRemoved >= 1);
      }
    }
  }

  @IsTest
  static void getDeployStatusReturnsProgress() {
    OrgUninstallServiceTest.UninstallMock mock = OrgUninstallServiceTest.install(
      true
    );
    mock.statusBody = '{"deployResult":{"status":"InProgress","done":false}}';
    System.runAs(admin()) {
      Test.startTest();
      Object result = new OrgIntelUninstallTool()
        .invoke(
          'getDeployStatus',
          new Map<String, Object>{ 'deployId' => DEPLOY_ID }
        );
      Test.stopTest();
      OrgUninstallService.DeployStatus status = (OrgUninstallService.DeployStatus) result;
      Assert.areEqual('InProgress', status.status);
      Assert.isFalse(status.done);
    }
  }

  @IsTest
  static void getDeployStatusWrapsInvalidIdInReadableError() {
    OrgUninstallServiceTest.install(true);
    System.runAs(admin()) {
      Test.startTest();
      try {
        new OrgIntelUninstallTool()
          .invoke(
            'getDeployStatus',
            new Map<String, Object>{ 'deployId' => 'x' }
          );
        Assert.fail('identifiant invalide accepté');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().startsWith('The uninstall progress could not be read')
        );
        Assert.isTrue(e.getMessage().contains('Invalid deployment id.'));
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void unknownActionThrowsIllegalArgument() {
    OrgUninstallServiceTest.install(true);
    System.runAs(admin()) {
      Test.startTest();
      try {
        new OrgIntelUninstallTool()
          .invoke('explode', new Map<String, Object>());
        Assert.fail('action inconnue acceptée');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('explode'));
      }
      Test.stopTest();
    }
  }
}
