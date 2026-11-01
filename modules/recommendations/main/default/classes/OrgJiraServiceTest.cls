/**
 * Tests de l'export Jira (OrgJiraService) par la classe d'entrée du module : état, test de
 * connexion, aperçu, export groupé (succès, échec partiel, nouvel essai sans priorité), erreurs
 * HTTP et validation des réglages (site Jira Cloud uniquement). Appels Jira simulés.
 */
@IsTest
private class OrgJiraServiceTest {
  private static final String ADMIN = 'jiraadm';
  private static final String SITE = 'https://acme.atlassian.net';

  @TestSetup
  static void setup() {
    User admin = OrgRecommendationsTestData.createAdmin(ADMIN);
    System.runAs(admin) {
      insert new OrgIntelSettings__c(
        SetupOwnerId = UserInfo.getOrganizationId(),
        JiraProjectKey__c = 'ORG',
        JiraIssueType__c = 'Task'
      );
      OrgRecommendation__c exported = OrgRecommendationsTestData.recommendation(
        'J-3',
        'Low'
      );
      exported.JiraIssueKey__c = 'ORG-1';
      exported.JiraIssueUrl__c = SITE + '/browse/ORG-1';
      OrgRecommendation__c noDescription = OrgRecommendationsTestData.recommendation(
        'J-2',
        'Info'
      );
      noDescription.AffectedComponents__c = null;
      noDescription.Justification__c = null;
      insert new List<OrgRecommendation__c>{
        OrgRecommendationsTestData.recommendation('J-1', 'Critical'),
        noDescription,
        exported
      };
    }
  }

  /** Réponses Jira simulées, choisies par chemin. */
  private class JiraMock implements HttpCalloutMock {
    Integer bulkCalls = 0;
    Integer bulkStatus = 201;
    String bulkBody;
    String retryBody;
    Integer projectStatus = 200;
    Boolean unreachable = false;

    public HttpResponse respond(HttpRequest request) {
      if (unreachable) {
        throw new CalloutException('Read timed out');
      }
      Assert.isTrue(
        request.getEndpoint()
          .startsWith(OrgIntelNamespace.callout('OrgIntelligenceJira')),
        request.getEndpoint()
      );
      HttpResponse response = new HttpResponse();
      String endpoint = request.getEndpoint();
      if (endpoint.endsWith('/myself')) {
        response.setStatusCode(200);
        response.setBody('{"displayName":"Jira Bot"}');
      } else if (endpoint.contains('/project/')) {
        response.setStatusCode(projectStatus);
        response.setBody(
          projectStatus == 200
            ? '{"name":"Org project"}'
            : '{"errorMessages":["No project could be found"],"errors":{"key":"invalid"}}'
        );
      } else if (endpoint.endsWith('/issue/bulk')) {
        bulkCalls++;
        response.setStatusCode(bulkCalls == 1 ? bulkStatus : 201);
        response.setBody(bulkCalls == 1 ? bulkBody : retryBody);
      } else {
        response.setStatusCode(404);
        response.setBody('not json');
      }
      return response;
    }
  }

  private static OrgIntelRecommendationsModule module() {
    return new OrgIntelRecommendationsModule();
  }

  private static List<Id> ids(List<String> fingerprints) {
    List<Id> result = new List<Id>();
    for (OrgRecommendation__c rec : [
      SELECT Id
      FROM OrgRecommendation__c
      WHERE Fingerprint__c IN :fingerprints
      ORDER BY Fingerprint__c
    ]) {
      result.add(rec.Id);
    }
    return result;
  }

  @IsTest
  static void statusAndConnection() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    JiraMock mock = new JiraMock();
    System.runAs(admin) {
      Test.setMock(HttpCalloutMock.class, mock);
      Test.startTest();
      OrgJiraService.siteUrlOverride = OrgJiraService.PLACEHOLDER_URL;
      OrgJiraService.JiraStatus notConfigured = (OrgJiraService.JiraStatus) module()
        .invoke('getJiraSettings', new Map<String, Object>());
      OrgJiraService.JiraStatus skipped = (OrgJiraService.JiraStatus) module()
        .invoke('testJiraConnection', new Map<String, Object>());
      OrgJiraService.siteUrlOverride = SITE;
      OrgJiraService.JiraStatus connected = (OrgJiraService.JiraStatus) module()
        .invoke('testJiraConnection', new Map<String, Object>());
      Test.stopTest();
      Assert.isFalse(notConfigured.configured);
      Assert.isNull(skipped.connected);
      Assert.isTrue(connected.configured);
      Assert.isTrue(connected.connected, connected.message);
      Assert.areEqual('Jira Bot', connected.accountName);
      Assert.areEqual('Org project', connected.projectName);
    }
  }

  @IsTest
  static void connectionToUnknownProject() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    JiraMock mock = new JiraMock();
    mock.projectStatus = 404;
    System.runAs(admin) {
      Test.setMock(HttpCalloutMock.class, mock);
      Test.startTest();
      OrgJiraService.siteUrlOverride = SITE;
      OrgJiraService.JiraStatus failed = OrgJiraService.testConnection();
      Test.stopTest();
      Assert.isFalse(failed.connected);
      Assert.isTrue(failed.message.contains('404'), failed.message);
      Assert.isTrue(failed.message.contains('No project'), failed.message);
    }
  }

  @IsTest
  static void previewAndExport() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    JiraMock mock = new JiraMock();
    // Deux tickets à créer (J-1, J-2) : le second est refusé à cause de la priorité, puis recréé
    mock.bulkBody = '{"issues":[{"key":"ORG-10"}],"errors":[{"failedElementNumber":1,"elementErrors":{"errors":{"priority":"Field priority cannot be set"}}}]}';
    mock.retryBody = '{"issues":[{"key":"ORG-11"}]}';
    List<Id> recordIds = ids(new List<String>{ 'J-1', 'J-2', 'J-3' });
    System.runAs(admin) {
      Test.setMock(HttpCalloutMock.class, mock);
      Test.startTest();
      OrgJiraService.siteUrlOverride = SITE;
      OrgJiraService.Preview preview = (OrgJiraService.Preview) module()
        .invoke(
          'previewJiraExport',
          new Map<String, Object>{ 'recordIds' => recordIds }
        );
      List<OrgJiraService.ExportResult> results = (List<OrgJiraService.ExportResult>) module()
        .invoke(
          'exportToJira',
          new Map<String, Object>{
            'recordIds' => recordIds,
            'includeExported' => false
          }
        );
      Test.stopTest();
      Assert.areEqual(3, preview.items.size());
      Assert.isTrue(preview.samplePayload.contains('"project"'));
      Assert.isTrue(preview.samplePayload.contains('/lightning/r/'));
      Assert.areEqual(3, results.size());
      Integer skippedCount = 0;
      Set<String> keys = new Set<String>();
      for (OrgJiraService.ExportResult result : results) {
        if (result.skipped) {
          skippedCount++;
        } else {
          keys.add(result.issueKey);
          Assert.isTrue(result.issueUrl.startsWith(SITE + '/browse/'));
        }
      }
      Assert.areEqual(1, skippedCount);
      Assert.areEqual(new Set<String>{ 'ORG-10', 'ORG-11' }, keys);
      Assert.areEqual(2, mock.bulkCalls);
    }
    Assert.areEqual(
      3,
      [
        SELECT COUNT()
        FROM OrgRecommendation__c
        WHERE JiraIssueKey__c != NULL
      ]
    );
  }

  /** Un export par test : pas d'appel HTTP après l'écriture du journal API d'un export précédent. */
  private static OrgJiraService.ExportResult exportWith(JiraMock mock) {
    List<Id> recordIds = ids(new List<String>{ 'J-1' });
    OrgJiraService.ExportResult result;
    System.runAs(OrgRecommendationsTestData.userNamed(ADMIN)) {
      Test.setMock(HttpCalloutMock.class, mock);
      Test.startTest();
      OrgJiraService.siteUrlOverride = SITE;
      result = OrgJiraService.export(recordIds, true)[0];
      Test.stopTest();
    }
    Assert.isNull(result.issueKey);
    return result;
  }

  @IsTest
  static void exportWithRefusedCredentials() {
    JiraMock mock = new JiraMock();
    mock.bulkStatus = 401;
    mock.bulkBody = '{}';
    Assert.isTrue(exportWith(mock).error.contains('credentials'));
  }

  @IsTest
  static void exportWithJiraError() {
    JiraMock mock = new JiraMock();
    mock.bulkStatus = 400;
    mock.bulkBody = '{"errorMessages":["Bad request"]}';
    Assert.isTrue(exportWith(mock).error.contains('Bad request'));
  }

  @IsTest
  static void exportWithUnreadableError() {
    JiraMock mock = new JiraMock();
    mock.bulkStatus = 500;
    mock.bulkBody = 'Internal error';
    Assert.isTrue(exportWith(mock).error.contains('unexpected response'));
  }

  @IsTest
  static void exportWhenJiraIsUnreachable() {
    JiraMock mock = new JiraMock();
    mock.unreachable = true;
    Assert.isTrue(exportWith(mock).error.contains('unreachable'));
  }

  @IsTest
  static void exportIsRefusedWithoutConfigurationOrSelection() {
    List<Id> recordIds = ids(new List<String>{ 'J-1' });
    System.runAs(OrgRecommendationsTestData.userNamed(ADMIN)) {
      OrgJiraService.siteUrlOverride = OrgJiraService.PLACEHOLDER_URL;
      try {
        OrgJiraService.export(recordIds, true);
        Assert.fail('Export without configuration');
      } catch (OrgJiraService.JiraException e) {
        Assert.isTrue(e.getMessage().contains('not configured'));
      }
      try {
        OrgJiraService.preview(new List<Id>());
        Assert.fail('Empty selection');
      } catch (OrgJiraService.JiraException e) {
        Assert.isTrue(e.getMessage().contains('at least one'));
      }
      List<Id> tooMany = new List<Id>();
      for (Integer i = 0; i <= OrgJiraService.MAX_EXPORT; i++) {
        tooMany.add(recordIds[0]);
      }
      try {
        OrgJiraService.preview(tooMany);
        Assert.fail('Too many recommendations');
      } catch (OrgJiraService.JiraException e) {
        Assert.isTrue(e.getMessage().contains('at most'));
      }
    }
  }

  @IsTest
  static void settingsAreValidated() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    System.runAs(admin) {
      // Jira Cloud uniquement : tout autre hôte est refusé
      for (
        String site : new List<String>{
          'https://evil.example.com',
          'http://acme.atlassian.net',
          'https://acme.atlassian.net.evil.com',
          'https://acme.atlassian.net/path',
          ''
        }
      ) {
        try {
          module()
            .invoke(
              'saveJiraSettings',
              new Map<String, Object>{
                'siteUrl' => site,
                'projectKey' => 'ORG'
              }
            );
          Assert.fail('Site refused: ' + site);
        } catch (AuraHandledException e) {
          Assert.isTrue(e.getMessage().contains('Jira Cloud'), e.getMessage());
        }
      }
      try {
        OrgJiraService.saveSettings(SITE + '/', null, null, '1-bad', null);
        Assert.fail('Invalid project key');
      } catch (OrgJiraService.JiraException e) {
        Assert.isTrue(e.getMessage().contains('project key'));
      }
      Assert.isTrue(OrgJiraService.isJiraCloudSite(SITE));
      Assert.isFalse(OrgJiraService.isJiraCloudSite(null));
    }
  }
}
