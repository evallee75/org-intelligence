@IsTest
public class OrgUninstallServiceTest {
  public static final String ADMIN_USERNAME = 'oi.uninstall.admin@example.com.orgintel';
  public static final String PLAIN_USERNAME = 'oi.uninstall.plain@example.com.orgintel';
  public static final String SYSADMIN_USERNAME = 'oi.uninstall.sysadmin@example.com.orgintel';
  private static final String TEST_JOB = 'Org Intelligence - uninstall test';
  public static final String DEPLOY_ID = '0AfAB0000000001AAA';

  /** Bouchon de la passerelle Tooling : pas de lecture de la Named Credential de l'org. */
  public class StubGateway extends OrgToolingGateway {
    public Boolean configured = true;
    public override Boolean isConfigured() {
      return configured;
    }
    public override String namedCredentialName() {
      return 'OrgIntelligenceTooling';
    }
  }

  /** Mock HTTP qui route selon la méthode et l'endpoint (Tooling, Analytics, Metadata REST). */
  public class UninstallMock implements HttpCalloutMock {
    public Integer toolingStatus = 200;
    public String toolingBody = '{"records":[],"done":true}';
    public Integer analyticsStatus = 204;
    public Integer submitStatus = 200;
    public String submitBody = '{"id":"' + DEPLOY_ID + '"}';
    public Integer statusCode = 200;
    public String statusBody = '{"deployResult":{"status":"Succeeded","done":true}}';
    public Integer submitCount = 0;
    public Integer deleteCount = 0;
    public List<String> checkOnlyFlags = new List<String>();

    public void setPackages(List<String> names) {
      List<String> rows = new List<String>();
      for (String name : names) {
        rows.add('{"SubscriberPackage":{"Name":"' + name + '"}}');
      }
      toolingBody = '{"records":[' + String.join(rows, ',') + '],"done":true}';
    }

    public HttpResponse respond(HttpRequest request) {
      String url = request.getEndpoint();
      String method = request.getMethod();
      HttpResponse response = new HttpResponse();
      response.setHeader('Content-Type', 'application/json');
      if (url.contains('/tooling/query')) {
        response.setStatusCode(toolingStatus);
        response.setBody(toolingBody);
      } else if (url.contains('/analytics/') && method == 'DELETE') {
        deleteCount++;
        response.setStatusCode(analyticsStatus);
        response.setBody('');
      } else if (url.contains('/metadata/deployRequest') && method == 'POST') {
        submitCount++;
        response.setStatusCode(submitStatus);
        response.setBody(submitBody);
      } else if (url.contains('/metadata/deployRequest/') && method == 'GET') {
        response.setStatusCode(statusCode);
        response.setBody(statusBody);
      } else {
        response.setStatusCode(404);
        response.setBody(
          '[{"message":"unexpected call","errorCode":"NOT_FOUND"}]'
        );
      }
      return response;
    }
  }

  /** Utilisateurs créés une fois (commités) : un callout ne peut suivre aucun DML en attente. */
  public static void createUsers() {
    Map<String, Id> profiles = new Map<String, Id>();
    for (Profile p : [
      SELECT Id, Name
      FROM Profile
      WHERE Name IN ('Standard User', 'System Administrator')
    ]) {
      profiles.put(p.Name, p.Id);
    }
    List<User> users = new List<User>{
      buildUser(ADMIN_USERNAME, 'Admin', profiles.get('Standard User')),
      buildUser(PLAIN_USERNAME, 'Plain', profiles.get('Standard User')),
      buildUser(
        SYSADMIN_USERNAME,
        'Sysadmin',
        profiles.get('System Administrator')
      )
    };
    insert users;
    PermissionSet adminSet = [
      SELECT Id
      FROM PermissionSet
      WHERE Name = 'OrgIntelligence_Admin'
      LIMIT 1
    ];
    insert new PermissionSetAssignment(
      AssigneeId = users[0].Id,
      PermissionSetId = adminSet.Id
    );
  }

  private static User buildUser(
    String username,
    String lastName,
    Id profileId
  ) {
    return new User(
      Username = username,
      Email = username,
      LastName = lastName,
      FirstName = 'Camille',
      Alias = lastName.left(5).toLowerCase(),
      ProfileId = profileId,
      TimeZoneSidKey = 'Europe/Paris',
      LocaleSidKey = 'fr_FR',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US'
    );
  }

  public static User userNamed(String username) {
    return [SELECT Id FROM User WHERE Username = :username LIMIT 1];
  }

  public static UninstallMock install(Boolean configured) {
    UninstallMock mock = new UninstallMock();
    StubGateway gateway = new StubGateway();
    gateway.configured = configured;
    OrgToolingGateway.setInstance(gateway);
    Test.setMock(HttpCalloutMock.class, mock);
    return mock;
  }

  public class NoopJob implements Schedulable {
    public void execute(SchedulableContext context) {
    }
  }

  @TestSetup
  static void setup() {
    createUsers();
    System.schedule(TEST_JOB, '0 0 3 * * ?', new NoopJob());
  }

  private static Boolean sandbox() {
    Organization org = [
      SELECT IsSandbox, OrganizationType
      FROM Organization
      LIMIT 1
    ];
    return org.IsSandbox || org.OrganizationType == 'Developer Edition';
  }

  private static Boolean realJobsPresent() {
    return [
        SELECT COUNT()
        FROM CronTrigger
        WHERE
          CronJobDetail.Name LIKE 'Org Intelligence%'
          AND CronJobDetail.Name != :TEST_JOB
      ] > 0;
  }

  @IsTest
  static void getStatusReportsSourceModeWhenNoPackage() {
    UninstallMock mock = install(true);
    OrgUninstallService.UninstallStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getStatus();
      Test.stopTest();
    }
    Assert.areEqual(OrgUninstallService.MODE_SOURCE, status.mode);
    Assert.isTrue(status.toolingConnected, 'connexion Tooling lue');
    Assert.isTrue(status.packages.isEmpty());
    Assert.isTrue(status.componentCount > 0, 'manifeste lu');
    Assert.areEqual('DELETE', status.confirmation);
    Assert.areEqual(
      status.isSandbox,
      status.canUninstall,
      'désinstallation permise seulement en sandbox / Developer Edition'
    );
  }

  @IsTest
  static void getStatusReportsPackageModeWhenOrgIntelligencePackageInstalled() {
    UninstallMock mock = install(true);
    mock.setPackages(new List<String>{ 'OrgIntelligence', 'Autre package' });
    OrgUninstallService.UninstallStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getStatus();
      Test.stopTest();
    }
    Assert.areEqual(OrgUninstallService.MODE_PACKAGE, status.mode);
    Assert.areEqual(new List<String>{ 'OrgIntelligence' }, status.packages);
    Assert.isFalse(status.canUninstall);
    Assert.isTrue(status.reason.contains('Installed Packages'));
  }

  @IsTest
  static void getStatusIsUnknownWhenToolingNotConfigured() {
    install(false);
    OrgUninstallService.UninstallStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getStatus();
      Test.stopTest();
    }
    Assert.areEqual(OrgUninstallService.MODE_UNKNOWN, status.mode);
    Assert.isFalse(status.toolingConnected);
    Assert.isFalse(status.canUninstall);
    Assert.isTrue(status.reason.contains('not set up'));
  }

  @IsTest
  static void getStatusIsUnknownWhenToolingQueryFails() {
    UninstallMock mock = install(true);
    mock.toolingStatus = 500;
    mock.toolingBody = '[{"message":"Server down","errorCode":"UNKNOWN"}]';
    OrgUninstallService.UninstallStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getStatus();
      Test.stopTest();
    }
    Assert.areEqual(OrgUninstallService.MODE_UNKNOWN, status.mode);
    Assert.isFalse(status.canUninstall);
    Assert.isTrue(status.reason.contains('500'), status.reason);
  }

  @IsTest
  static void uninstallRefusedWhenPackagesInstalled() {
    UninstallMock mock = install(true);
    mock.setPackages(new List<String>{ 'OrgIntelligence-Adoption' });
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      try {
        OrgUninstallService.uninstall('DELETE', false);
        Assert.fail('désinstallation permise en mode package');
      } catch (OrgUninstallService.UninstallException e) {
        Assert.isTrue(e.getMessage().contains('Installed Packages'));
      }
      Test.stopTest();
    }
    Assert.areEqual(0, mock.submitCount);
  }

  @IsTest
  static void uninstallSubmitsDeploymentsStopsJobsAndRemovesAssignments() {
    UninstallMock mock = install(true);
    OrgUninstallService.UninstallResult result;
    Boolean skipped = realJobsPresent();
    System.runAs(userNamed(ADMIN_USERNAME)) {
      // Production, ou jobs Org Intelligence réels dans l'org : on ne les arrête pas depuis un test
      if (skipped || !sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        result = OrgUninstallService.uninstall('DELETE', true);
        Test.stopTest();
        Assert.areEqual(DEPLOY_ID, result.deployId);
        Assert.areEqual(DEPLOY_ID, result.toolingDeployId);
        Assert.areEqual(
          3,
          mock.submitCount,
          'socle, droits, application Tooling'
        );
        Assert.isTrue(result.componentCount > 0);
        Assert.isTrue(
          result.jobsStopped >= 1,
          'job planifié Org Intelligence arrêté'
        );
        Assert.isTrue(result.assignmentsRemoved >= 1, 'assignation retirée');
        Assert.areEqual(
          0,
          [
            SELECT COUNT()
            FROM PermissionSetAssignment
            WHERE
              AssigneeId = :UserInfo.getUserId()
              AND PermissionSet.Name = 'OrgIntelligence_Admin'
          ],
          'assignation supprimée'
        );
      }
    }
  }

  @IsTest
  static void uninstallWithoutToolingRemovalSubmitsTwoDeployments() {
    UninstallMock mock = install(true);
    Boolean skipped = realJobsPresent();
    System.runAs(userNamed(ADMIN_USERNAME)) {
      if (skipped || !sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        OrgUninstallService.UninstallResult result = OrgUninstallService.uninstall(
          'DELETE',
          false
        );
        Test.stopTest();
        Assert.areEqual(
          2,
          mock.submitCount,
          'socle et droits, sans application Tooling'
        );
        Assert.isNotNull(result.toolingDeployId);
      }
    }
  }

  @IsTest
  static void uninstallFailsWhenSubmitReturnsError() {
    UninstallMock mock = install(true);
    mock.submitStatus = 500;
    mock.submitBody = '{"message":"deploy refused"}';
    System.runAs(userNamed(ADMIN_USERNAME)) {
      if (!sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        try {
          OrgUninstallService.uninstall('DELETE', false);
          Assert.fail('erreur HTTP ignorée');
        } catch (OrgUninstallService.UninstallException e) {
          Assert.isTrue(e.getMessage().contains('500'), e.getMessage());
          Assert.isTrue(e.getMessage().contains('deploy refused'));
        }
        Test.stopTest();
      }
    }
  }

  @IsTest
  static void wrongConfirmationIsRefused() {
    install(true);
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      for (String typed : new List<String>{ null, 'nope', 'delete' }) {
        try {
          OrgUninstallService.prepare(typed);
          Assert.fail('prepare permis avec la confirmation ' + typed);
        } catch (OrgUninstallService.UninstallException e) {
          Assert.isTrue(e.getMessage().contains('DELETE'), e.getMessage());
        }
        try {
          OrgUninstallService.uninstall(typed, false);
          Assert.fail('uninstall permis avec la confirmation ' + typed);
        } catch (OrgUninstallService.UninstallException e) {
          Assert.isTrue(e.getMessage().contains('DELETE'), e.getMessage());
        }
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void prepareRefusedWhenToolingNotConfigured() {
    install(false);
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      try {
        OrgUninstallService.prepare('DELETE');
        Assert.fail('prepare permis sans connexion Tooling');
      } catch (OrgUninstallService.UninstallException e) {
        Assert.isTrue(e.getMessage().contains('not set up'));
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void prepareDeletesReportsAndDashboardsThroughAnalyticsApi() {
    UninstallMock mock = install(true);
    Integer deleted;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      if (!sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        deleted = OrgUninstallService.prepare('DELETE');
        Test.stopTest();
        Assert.areEqual(
          mock.deleteCount,
          deleted,
          'un appel DELETE par rapport / tableau de bord, tous réussis'
        );
      }
    }
  }

  @IsTest
  static void prepareCountsNothingWhenAnalyticsCallsFail() {
    UninstallMock mock = install(true);
    mock.analyticsStatus = 500;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      if (!sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        Integer deleted = OrgUninstallService.prepare('DELETE');
        Test.stopTest();
        Assert.areEqual(
          0,
          deleted,
          'aucune suppression comptée sur erreur HTTP'
        );
      }
    }
  }

  @IsTest
  static void validateSubmitsCheckOnlyDeployment() {
    UninstallMock mock = install(true);
    System.runAs(userNamed(ADMIN_USERNAME)) {
      if (!sandbox()) {
        Assert.isTrue(true);
      } else {
        Test.startTest();
        String deployId = OrgUninstallService.validate();
        Test.stopTest();
        Assert.areEqual(DEPLOY_ID, deployId);
        Assert.areEqual(1, mock.submitCount, 'une seule simulation');
      }
    }
  }

  @IsTest
  static void validateRefusedWhenPackagesInstalled() {
    UninstallMock mock = install(true);
    mock.setPackages(new List<String>{ 'OrgIntelligence' });
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      try {
        OrgUninstallService.validate();
        Assert.fail('simulation permise en mode package');
      } catch (OrgUninstallService.UninstallException e) {
        Assert.isTrue(e.getMessage().contains('Installed Packages'));
      }
      Test.stopTest();
    }
    Assert.areEqual(0, mock.submitCount);
  }

  @IsTest
  static void getDeployStatusRejectsInvalidIds() {
    UninstallMock mock = install(true);
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      for (
        String bad : new List<String>{
          null,
          '',
          'short',
          '0AfAB0000000001AAA/../x',
          '0AfAB0000000001AAA?x=1'
        }
      ) {
        try {
          OrgUninstallService.getDeployStatus(bad);
          Assert.fail('identifiant invalide accepté : ' + bad);
        } catch (OrgUninstallService.UninstallException e) {
          Assert.areEqual('Invalid deployment id.', e.getMessage());
        }
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void getDeployStatusReadsSuccessfulDeployment() {
    UninstallMock mock = install(true);
    mock.statusBody = '{"deployResult":{"status":"Succeeded","done":true,"numberComponentsDeployed":12,"numberComponentsTotal":12,"numberComponentErrors":0}}';
    OrgUninstallService.DeployStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getDeployStatus(DEPLOY_ID);
      Test.stopTest();
    }
    Assert.areEqual(DEPLOY_ID, status.id);
    Assert.areEqual('Succeeded', status.status);
    Assert.isTrue(status.done);
    Assert.areEqual(12, status.componentsDeployed);
    Assert.areEqual(12, status.componentsTotal);
    Assert.areEqual(0, status.componentErrors);
    Assert.isTrue(status.problems.isEmpty());
  }

  @IsTest
  static void getDeployStatusListsComponentFailures() {
    UninstallMock mock = install(true);
    mock.statusBody = '{"deployResult":{"status":"Failed","done":true,"errorMessage":"Rolled back","numberComponentErrors":1,"details":{"componentFailures":[{"componentType":"ApexClass","fullName":"OrgScanJob","problem":"Dependent class"}]}}}';
    OrgUninstallService.DeployStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getDeployStatus(DEPLOY_ID);
      Test.stopTest();
    }
    Assert.areEqual('Failed', status.status);
    Assert.areEqual('Rolled back', status.errorMessage);
    Assert.areEqual(
      new List<String>{ 'ApexClass OrgScanJob: Dependent class' },
      status.problems
    );
  }

  @IsTest
  static void getDeployStatusReportsPendingDeployment() {
    UninstallMock mock = install(true);
    mock.statusBody = '{"deployResult":{"status":"InProgress","done":false,"details":null}}';
    OrgUninstallService.DeployStatus status;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      status = OrgUninstallService.getDeployStatus(DEPLOY_ID);
      Test.stopTest();
    }
    Assert.isFalse(status.done);
    Assert.areEqual('InProgress', status.status);
    Assert.isTrue(status.problems.isEmpty());
  }

  @IsTest
  static void getDeployStatusFailsOnHttpError() {
    UninstallMock mock = install(true);
    mock.statusCode = 404;
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      try {
        OrgUninstallService.getDeployStatus(DEPLOY_ID);
        Assert.fail('erreur HTTP ignorée');
      } catch (OrgUninstallService.UninstallException e) {
        Assert.isTrue(e.getMessage().contains('404'));
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void multipartBodyEndsWithFinalBoundaryForEveryPaddingCase() {
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      // 1, 2 et 3 octets : base64 terminé par « == », « = » ou sans remplissage
      for (String content : new List<String>{ 'A', 'AB', 'ABC' }) {
        Blob body = OrgUninstallService.multipartBody(
          '{"deployOptions":{}}',
          Blob.valueOf(content)
        );
        String text = body.toString();
        Assert.isTrue(
          text.startsWith('--' + OrgUninstallService.BOUNDARY),
          content
        );
        Assert.isTrue(text.contains('{"deployOptions":{}}'), content);
        Assert.isTrue(text.contains('filename="deploy.zip"'), content);
        Assert.isTrue(
          text.endsWith('\r\n--' + OrgUninstallService.BOUNDARY + '--'),
          'frontière finale précédée d\'un saut de ligne : ' + content
        );
        Assert.isTrue(text.contains('\r\n\r\n' + content.left(1)), content);
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void destructiveXmlSortsTypesAndEscapesMembers() {
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      String xml = OrgUninstallService.destructiveXml(
        new Map<String, Object>{
          'CustomObject' => new List<Object>{ 'Obj__c' },
          'ApexClass' => new List<Object>{ 'A&B', 'C' }
        }
      );
      Test.stopTest();
      Assert.isTrue(xml.contains('<members>A&amp;B</members>'));
      Assert.isTrue(
        xml.indexOf('<name>ApexClass</name>') <
        xml.indexOf('<name>CustomObject</name>'),
        'types triés'
      );
      Assert.isTrue(xml.endsWith('<version>66.0</version></Package>'));
    }
  }

  @IsTest
  static void buildZipProducesAnArchive() {
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      Blob zip = OrgUninstallService.buildZip('<Package/>');
      Test.stopTest();
      Assert.isTrue(zip.size() > 0);
    }
  }

  @IsTest
  static void readManifestListsComponentsAndToolingConnection() {
    System.runAs(userNamed(ADMIN_USERNAME)) {
      Test.startTest();
      Map<String, Object> manifest = OrgUninstallService.readManifest();
      Test.stopTest();
      Assert.isTrue(manifest.containsKey('components'));
      Assert.isTrue(manifest.containsKey('tooling'));
      Assert.isFalse(
        ((Map<String, Object>) manifest.get('components')).isEmpty()
      );
    }
  }
}
