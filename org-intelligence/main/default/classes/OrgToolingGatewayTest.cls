@IsTest
private class OrgToolingGatewayTest {
  /** Réponses HTTP simulées : pages successives ou erreur. */
  private class ToolingMock implements HttpCalloutMock {
    private List<HttpResponse> responses = new List<HttpResponse>();
    public List<String> endpoints = new List<String>();

    ToolingMock add(Integer status, String body) {
      HttpResponse response = new HttpResponse();
      response.setStatusCode(status);
      response.setBody(body);
      responses.add(response);
      return this;
    }

    public HttpResponse respond(HttpRequest request) {
      endpoints.add(request.getEndpoint());
      return responses.remove(0);
    }
  }

  @IsTest
  static void queryFollowsPagination() {
    ToolingMock mock = new ToolingMock()
      .add(
        200,
        '{"done":false,"nextRecordsUrl":"/services/data/v66.0/tooling/query/01g-2000","records":[{"Id":"1"}]}'
      )
      .add(
        200,
        '{"done":true,"records":[{"Id":"2","EntityDefinition":{"QualifiedApiName":"Account"}}]}'
      );
    Test.setMock(HttpCalloutMock.class, mock);

    Test.startTest();
    List<Map<String, Object>> rows = OrgToolingGateway.getInstance()
      .query('SELECT Id FROM ValidationRule');
    Test.stopTest();

    Assert.areEqual(2, rows.size());
    Assert.areEqual(
      'Account',
      OrgToolingGateway.getString(rows[1], 'EntityDefinition.QualifiedApiName')
    );
    Assert.isNull(
      OrgToolingGateway.getString(rows[0], 'EntityDefinition.QualifiedApiName')
    );
    Assert.isTrue(
      mock.endpoints[0]
        .startsWith('callout:OrgIntelligenceTooling/services/data/')
    );
    Assert.isTrue(mock.endpoints[1].endsWith('/tooling/query/01g-2000'));
  }

  @IsTest
  static void authorizationErrorsAreExplained() {
    Test.setMock(
      HttpCalloutMock.class,
      new ToolingMock()
        .add(
          401,
          '[{"message":"Session expired","errorCode":"INVALID_SESSION_ID"}]'
        )
    );
    String message;
    Test.startTest();
    try {
      OrgToolingGateway.getInstance().query('SELECT Id FROM ApexClass');
    } catch (OrgToolingGateway.ToolingException e) {
      message = e.getMessage();
    }
    Test.stopTest();
    Assert.isTrue(message.contains('Authenticate your user'), message);
  }

  @IsTest
  static void apiErrorsKeepTheSalesforceMessage() {
    Test.setMock(
      HttpCalloutMock.class,
      new ToolingMock()
        .add(400, '[{"message":"No such column","errorCode":"INVALID_FIELD"}]')
    );
    String message;
    Test.startTest();
    try {
      OrgToolingGateway.getInstance().query('SELECT Nope FROM ApexClass');
    } catch (OrgToolingGateway.ToolingException e) {
      message = e.getMessage();
    }
    Test.stopTest();
    Assert.areEqual('Tooling API error (400): No such column', message);
    Assert.areEqual(
      'unexpected response',
      OrgToolingGateway.readErrorMessage('<html>')
    );
  }

  @IsTest
  static void missingNamedCredentialMeansDegradedMode() {
    // La sandbox de test n'a pas forcément la Named Credential : on vérifie le message dans ce cas.
    Test.setMock(
      HttpCalloutMock.class,
      new ToolingMock().add(200, '{"done":true,"records":[]}')
    );
    OrgToolingGateway.Status status = OrgToolingGateway.getInstance()
      .checkConnection();
    Assert.areEqual('OrgIntelligenceTooling', status.namedCredential);
    if (!status.configured) {
      Assert.isFalse(status.connected);
      Assert.isTrue(status.message.contains('not configured'));
    }
  }

  /** Bouchon : configuration et autorisation imposées, appels HTTP simulés par le mock. */
  private class StubGateway extends OrgToolingGateway {
    Boolean configured;
    Boolean authorized;
    StubGateway(Boolean configured, Boolean authorized) {
      this.configured = configured;
      this.authorized = authorized;
    }
    public override Boolean isConfigured() {
      return configured;
    }
    public override Boolean isUserAuthorized() {
      return authorized;
    }
    public override String authorizationUrl() {
      return 'https://example.my.salesforce.com/services/auth/xds/OrgIntelligenceTooling';
    }
  }

  @IsTest
  static void unauthorizedUserSkipsTheCallout() {
    ToolingMock mock = new ToolingMock();
    Test.setMock(HttpCalloutMock.class, mock);
    OrgToolingGateway.Status status = new StubGateway(true, false)
      .checkConnection();
    Assert.isTrue(status.configured);
    Assert.isFalse(status.connected);
    Assert.isFalse(status.authorized);
    Assert.isTrue(status.authorizationUrl.contains('/services/auth/xds/'));
    Assert.isTrue(status.message.contains('Connect'), status.message);
    Assert.isTrue(mock.endpoints.isEmpty(), 'aucun appel sans jeton');
    Assert.isNotNull(status.setupUrl);
  }

  @IsTest
  static void connectedWhenTheTestQuerySucceeds() {
    Test.setMock(
      HttpCalloutMock.class,
      new ToolingMock().add(200, '{"done":true,"records":[{"Id":"1"}]}')
    );
    Test.startTest();
    OrgToolingGateway.Status status = new StubGateway(true, null)
      .checkConnection();
    Test.stopTest();
    Assert.isTrue(status.connected);
    Assert.isTrue(status.authorized);
    Assert.areEqual('Tooling API connected.', status.message);
  }

  @IsTest
  static void refusedCalloutOffersTheAuthorizationLink() {
    Test.setMock(
      HttpCalloutMock.class,
      new ToolingMock()
        .add(401, '[{"message":"Bad token","errorCode":"INVALID_SESSION_ID"}]')
    );
    Test.startTest();
    OrgToolingGateway.Status status = new StubGateway(true, true)
      .checkConnection();
    Test.stopTest();
    Assert.isFalse(status.connected);
    Assert.isNotNull(status.authorizationUrl);
    Assert.isTrue(status.message.contains('(401)'), status.message);
  }

  @IsTest
  static void notConfiguredStatusExplainsTheDegradedMode() {
    OrgToolingGateway.Status status = new StubGateway(false, null)
      .checkConnection();
    Assert.isFalse(status.configured);
    Assert.isTrue(status.message.contains('not configured'));
    Assert.isTrue(
      status.setupUrl.containsIgnoreCase('orgintelligencetoolingsetup')
    );
  }

  @IsTest
  static void namespaceAndCredentialHelpers() {
    OrgToolingGateway gateway = OrgToolingGateway.getInstance();
    // Installation depuis les sources : pas de namespace
    Assert.areEqual(
      OrgIntelNamespace.prefix(),
      OrgToolingGateway.namespacePrefix()
    );
    Assert.areEqual(
      gateway.namedCredentialName(),
      gateway.externalCredentialName()
    );
    // ConnectApi peut refuser en contexte de test : les deux lectures ne lèvent jamais d'exception
    gateway.isUserAuthorized();
    String url = gateway.authorizationUrl();
    Assert.isTrue(url == null || url.contains('/services/auth/'));
  }

  @IsTest
  static void namespacedNamedCredentialNameIsSplit() {
    OrgToolingGateway gateway = new NamedGateway('zzoi__Missing');
    Assert.isFalse(gateway.isConfigured());
    Assert.isFalse(new NamedGateway('').isConfigured());
  }

  private class NamedGateway extends OrgToolingGateway {
    String name;
    NamedGateway(String name) {
      this.name = name;
    }
    public override String namedCredentialName() {
      return name;
    }
  }

  @IsTest
  static void restCallsAndJsonHelpers() {
    ToolingMock mock = new ToolingMock().add(200, '{"sObjects":[]}');
    Test.setMock(HttpCalloutMock.class, mock);
    Test.startTest();
    String body = OrgToolingGateway.getInstance()
      .getRest('/limits/recordCount');
    Test.stopTest();
    Assert.areEqual('{"sObjects":[]}', body);
    Assert.isTrue(mock.endpoints[0].endsWith('/limits/recordCount'));
    Assert.areEqual(
      'REST GET limits/recordCount',
      OrgToolingGateway.describeOperation(
        '/services/data/v66.0/limits/recordCount'
      )
    );
    Assert.areEqual(
      'Tooling query (next page)',
      OrgToolingGateway.describeOperation(
        '/services/data/v66.0/tooling/query/01g-2000'
      )
    );
    Assert.areEqual(
      'Tooling query: ValidationRule',
      OrgToolingGateway.describeOperation(
        '/services/data/v66.0/tooling/query/?q=' +
        EncodingUtil.urlEncode('SELECT Id FROM ValidationRule', 'UTF-8')
      )
    );
    Assert.isNull(
      OrgToolingGateway.getValue(new Map<String, Object>{ 'A' => 1 }, 'A.B')
    );
  }

  @IsTest
  static void unreachableEndpointIsReported() {
    Test.setMock(HttpCalloutMock.class, new ThrowingMock());
    String message;
    Test.startTest();
    try {
      OrgToolingGateway.getInstance().query('SELECT Id FROM ApexClass');
    } catch (OrgToolingGateway.ToolingException e) {
      message = e.getMessage();
    }
    Test.stopTest();
    Assert.isTrue(message.contains('unreachable'), message);
  }

  private class ThrowingMock implements HttpCalloutMock {
    public HttpResponse respond(HttpRequest request) {
      throw new CalloutException('Unauthorized endpoint');
    }
  }
}
