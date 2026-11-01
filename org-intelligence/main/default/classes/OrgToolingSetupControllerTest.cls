@IsTest
private class OrgToolingSetupControllerTest {
  /**
   * API Metadata REST simulée : dépôt accepté (id), puis statut « Succeeded » ou « Failed ».
   * Les URL appelées sont gardées pour vérifier le parcours.
   */
  private class MetadataMock implements HttpCalloutMock {
    String finalStatus;
    Integer submitStatus = 201;
    List<String> calls = new List<String>();
    MetadataMock(String finalStatus) {
      this.finalStatus = finalStatus;
    }
    public HttpResponse respond(HttpRequest request) {
      calls.add(request.getMethod() + ' ' + request.getEndpoint());
      HttpResponse response = new HttpResponse();
      if (request.getMethod() == 'POST') {
        response.setStatusCode(submitStatus);
        response.setBody(
          submitStatus < 300
            ? '{"id":"0AfAP000000AbCdEFG"}'
            : '[{"message":"INVALID_SESSION_ID"}]'
        );
        return response;
      }
      response.setStatusCode(200);
      Map<String, Object> result = new Map<String, Object>{
        'done' => true,
        'status' => finalStatus
      };
      if (finalStatus == 'Failed') {
        result.put(
          'details',
          new Map<String, Object>{
            'componentFailures' => new List<Object>{
              new Map<String, Object>{
                'fullName' => 'OrgIntelligenceTooling',
                'problem' => 'Duplicate name'
              }
            }
          }
        );
      }
      response.setBody(
        JSON.serialize(new Map<String, Object>{ 'deployResult' => result })
      );
      return response;
    }
  }

  private static OrgToolingSetupController adminController() {
    OrgToolingSetupController controller = new OrgToolingSetupController();
    controller.isAdmin = true;
    controller.alreadyConfigured = false;
    return controller;
  }

  @IsTest
  static void zipsContainTheExpectedComponents() {
    for (Integer step = 0; step < 3; step++) {
      Blob zip = OrgToolingSetupController.buildZip(step);
      Compression.ZipReader reader = new Compression.ZipReader(zip);
      Set<String> names = new Set<String>();
      for (Compression.ZipEntry entry : reader.getEntries()) {
        names.add(entry.getName());
      }
      Assert.isTrue(names.contains('package.xml'));
      if (step == 0) {
        Assert.isTrue(
          names.contains('authproviders/OrgIntelligenceTooling.authprovider')
        );
        Assert.isTrue(
          names.contains('externalClientApps/OrgIntelligenceTooling.eca')
        );
      } else if (step == 1) {
        Assert.isTrue(
          names.contains(
            'namedCredentials/OrgIntelligenceTooling.namedCredential'
          )
        );
      } else {
        Assert.isTrue(
          names.contains(
            'permissionsets/OrgIntelligence_Tooling_Access.permissionset'
          )
        );
      }
    }
  }

  @IsTest
  static void managedPackageNamespaceIsAllowedOnTheNamedCredential() {
    Assert.areEqual(
      '',
      OrgToolingSetupController.allowedNamespaceParameter('')
    );
    String parameter = OrgToolingSetupController.allowedNamespaceParameter(
      'orgintel'
    );
    Assert.isTrue(
      parameter.contains(
        '<parameterType>AllowedManagedPackageNamespaces</parameterType>'
      )
    );
    Assert.isTrue(
      parameter.contains('<parameterValue>orgintel</parameterValue>')
    );
  }

  @IsTest
  static void fullSetupRunsTheThreeDeployments() {
    MetadataMock mock = new MetadataMock('Succeeded');
    Test.setMock(HttpCalloutMock.class, mock);
    OrgToolingSetupController controller = adminController();
    Test.startTest();
    controller.start();
    Assert.isTrue(controller.running);
    for (Integer i = 0; i < 3; i++) {
      controller.poll();
    }
    Test.stopTest();
    Assert.isTrue(
      controller.finished,
      'step=' +
        controller.stepIndex +
        ' running=' +
        controller.running +
        ' failed=' +
        controller.failed +
        ' error=' +
        controller.errorMessage +
        ' calls=' +
        mock.calls
    );
    Assert.isFalse(controller.failed);
    Assert.areEqual(3, controller.progress.size());
    Integer posts = 0;
    for (String call : mock.calls) {
      if (call.startsWith('POST') && call.endsWith('/metadata/deployRequest')) {
        posts++;
      }
    }
    Assert.areEqual(3, posts);
    // Poll sans déploiement en cours : rien ne se passe
    Assert.isNull(controller.poll());
  }

  @IsTest
  static void failedDeploymentStopsWithTheSalesforceProblem() {
    Test.setMock(HttpCalloutMock.class, new MetadataMock('Failed'));
    OrgToolingSetupController controller = adminController();
    Test.startTest();
    controller.start();
    controller.poll();
    Test.stopTest();
    Assert.isTrue(controller.failed);
    Assert.isTrue(
      controller.errorMessage.contains('Duplicate name'),
      controller.errorMessage
    );
  }

  @IsTest
  static void refusedSubmissionIsReported() {
    MetadataMock mock = new MetadataMock('Succeeded');
    mock.submitStatus = 401;
    Test.setMock(HttpCalloutMock.class, mock);
    OrgToolingSetupController controller = adminController();
    Test.startTest();
    controller.start();
    Test.stopTest();
    Assert.isTrue(controller.failed);
    Assert.isTrue(
      controller.errorMessage.contains('401'),
      controller.errorMessage
    );
  }

  @IsTest
  static void guardsBlockNonAdminsAndExistingConnections() {
    OrgToolingSetupController controller = new OrgToolingSetupController();
    controller.isAdmin = false;
    controller.start();
    Assert.isTrue(controller.failed);
    Assert.isTrue(controller.errorMessage.contains('administrators'));

    controller = new OrgToolingSetupController();
    controller.isAdmin = false;
    Assert.isNull(controller.connect());
    Assert.isTrue(controller.errorMessage.contains('administrators'));

    controller = adminController();
    controller.alreadyConfigured = true;
    controller.start();
    Assert.isTrue(controller.errorMessage.contains('already exists'));

    controller = adminController();
    Assert.isNull(controller.connect());
    Assert.isTrue(
      controller.errorMessage.contains('Create the connection first')
    );
  }

  @IsTest
  static void connectRedirectsOrExplains() {
    OrgToolingSetupController controller = adminController();
    controller.alreadyConfigured = true;
    Test.startTest();
    PageReference target = controller.connect();
    Test.stopTest();
    // ConnectApi peut ne pas fournir d'URL en contexte de test : redirection ou message explicite
    if (target == null) {
      Assert.isTrue(controller.failed);
    } else {
      Assert.isTrue(target.getUrl().contains('/services/auth/'));
    }
  }

  @IsTest
  static void pageUrlsAndLabels() {
    OrgToolingSetupController controller = new OrgToolingSetupController();
    Assert.isTrue(
      controller.callbackUrl.endsWith(
        '/services/authcallback/OrgIntelligenceTooling'
      )
    );
    Assert.isTrue(
      controller.appUrl.contains('Org_Intelligence?c__section=settings')
    );
    Assert.isTrue(controller.allowAccessUrl.contains('ExternalCredentials'));
    Assert.areEqual('', controller.currentStepLabel);
    controller.stepIndex = 1;
    Assert.areEqual(
      'External Credential and Named Credential',
      controller.currentStepLabel
    );
    Assert.areEqual(
      OrgToolingGateway.namespacePrefix(),
      OrgToolingSetupController.namespacePrefix()
    );
  }

  @IsTest
  static void multipartBodyKeepsTheZipIntact() {
    // Trois tailles de fichier : les trois cas de bourrage base64
    for (String content : new List<String>{ 'a', 'ab', 'abc' }) {
      Blob body = OrgToolingSetupController.multipartBody(
        '{}',
        Blob.valueOf(content)
      );
      String text = body.toString();
      Assert.isTrue(text.contains('name="json"'));
      Assert.isTrue(text.contains('\r\n' + content + '\r\n--'), text);
      Assert.isTrue(text.endsWith('--OrgIntelligenceToolingBoundary--'));
    }
  }
}
