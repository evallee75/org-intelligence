/**
 * Assistant de connexion Tooling API (page Visualforce OrgIntelligenceToolingSetup), équivalent du
 * script scripts/org-intelligence/setup-tooling.mjs sans aucun outil.
 *
 * Pourquoi une page Visualforce : la session d'une page Visualforce donne accès aux API, contrairement
 * à celle d'un composant Lightning. Le contrôleur soumet donc lui-même, avec la session de
 * l'administrateur connecté (donc avec ses droits : aucune élévation), des déploiements à l'API
 * Metadata REST de sa propre org (pas de Remote Site Setting nécessaire pour le domaine de l'org) :
 *   1. External Client App (OAuth) + Auth. Provider « Salesforce » — clé et secret OAuth générés au
 *      hasard, utilisés dans ce seul déploiement, jamais stockés ni affichés ;
 *   2. External Credential (principal par utilisateur) + Named Credential OrgIntelligenceTooling ;
 *   3. permission set OrgIntelligence_Tooling_Access (accès au principal), puis assigné à l'utilisateur.
 * La page interroge l'avancement toutes les quelques secondes (actionPoller). Chaque administrateur
 * clique ensuite « Connect » (action connect) : permission set attribué s'il manque, puis redirection
 * vers l'autorisation OAuth de son principal (URL fournie par ConnectApi, équivalent de « Allow
 * Access » dans les paramètres personnels).
 *
 * Les composants créés sont hors package (propres à l'org) : la désinstallation les retire
 * (OrgUninstallService, troisième déploiement). En package géré (namespace), la Named Credential
 * reste locale et déclare le namespace du package dans « Allowed Namespaces for Callouts », sans
 * quoi le code du package ne pourrait pas l'appeler.
 *
 * Revue de sécurité : l'identifiant de session sert uniquement côté serveur, pour appeler l'API
 * Metadata de l'org elle-même (aucun envoi à un tiers, jamais exposé dans la page) ; les actions qui
 * modifient l'org sont des boutons de formulaire (protection CSRF de Visualforce), jamais l'attribut
 * action de la page ; l'assistant est réservé aux administrateurs Org Intelligence.
 */
public with sharing class OrgToolingSetupController {
  public static final String NAME = 'OrgIntelligenceTooling';
  public static final String PERMISSION_SET = 'OrgIntelligence_Tooling_Access';
  private static final String API_VERSION = 'v66.0';
  private static final String NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
  private static final String BOUNDARY = 'OrgIntelligenceToolingBoundary';
  private static final List<String> STEP_LABELS = new List<String>{
    'External Client App and Auth. Provider',
    'External Credential and Named Credential',
    'Permission set'
  };

  /** Étape en cours (0 à 2), -1 avant le démarrage, 3 une fois terminé. */
  @TestVisible
  public Integer stepIndex { get; private set; }
  public String deployId { get; private set; }
  public Boolean running { get; private set; }
  @TestVisible
  public Boolean finished { get; private set; }
  public Boolean failed { get; private set; }
  @TestVisible
  public Boolean alreadyConfigured { get; private set; }
  @TestVisible
  public Boolean isAdmin { get; private set; }
  public String errorMessage { get; private set; }
  public List<String> progress { get; private set; }
  /** L'utilisateur courant a-t-il déjà autorisé son accès ? */
  public Boolean userAuthorized { get; private set; }

  public OrgToolingSetupController() {
    stepIndex = -1;
    running = false;
    finished = false;
    failed = false;
    progress = new List<String>();
    isAdmin = OrgIntelAccess.isAdmin();
    alreadyConfigured = ![
        SELECT Id
        FROM NamedCredential
        WHERE DeveloperName = :NAME
        LIMIT 1
      ]
      .isEmpty();
    // Inconnu (null) traité comme « non connecté » : le bouton Connect reste proposé
    userAuthorized =
      alreadyConfigured &&
      OrgToolingGateway.getInstance().isUserAuthorized() == true;
  }

  /** Namespace du package (« orgintel »), vide pour une installation depuis les sources. */
  public static String namespacePrefix() {
    return OrgToolingGateway.namespacePrefix();
  }

  public String callbackUrl {
    get {
      return orgDomain() + '/services/authcallback/' + NAME;
    }
  }

  /** Page « External Credentials » des paramètres personnels (Allow Access manuel, en secours). */
  public String allowAccessUrl {
    get {
      return '/lightning/settings/personal/ExternalCredentials/home';
    }
  }

  /** Onglet de l'application (nom préfixé par le namespace en package géré). */
  public String appUrl {
    get {
      String namespace = namespacePrefix();
      return '/lightning/n/' +
        (String.isBlank(namespace) ? '' : namespace + '__') +
        'Org_Intelligence?c__section=settings';
    }
  }

  public String currentStepLabel {
    get {
      return stepIndex >= 0 &&
        stepIndex < STEP_LABELS.size()
        ? STEP_LABELS[stepIndex]
        : '';
    }
  }

  // ---------- Actions de la page ----------

  public PageReference start() {
    if (running || finished) {
      return null;
    }
    if (!isAdmin) {
      fail(
        'This setup is reserved to Org Intelligence administrators ("Org Intelligence - Admin" permission set).'
      );
      return null;
    }
    if (alreadyConfigured) {
      fail(
        'The Tooling API connection already exists in this org. To recreate it, use the script scripts/org-intelligence/setup-tooling.mjs with --reset.'
      );
      return null;
    }
    errorMessage = null;
    failed = false;
    stepIndex = 0;
    submitCurrentStep();
    return null;
  }

  /** Appelée par l'actionPoller : avancement du déploiement en cours, puis étape suivante. */
  public PageReference poll() {
    if (!running || String.isBlank(deployId)) {
      return null;
    }
    try {
      Map<String, Object> result = readDeploy(deployId);
      if (result.get('done') != true) {
        return null;
      }
      String status = (String) result.get('status');
      if (status != 'Succeeded') {
        fail(STEP_LABELS[stepIndex] + ': ' + describeFailure(result));
        return null;
      }
      progress.add('✔ ' + STEP_LABELS[stepIndex]);
      stepIndex++;
      if (stepIndex < STEP_LABELS.size()) {
        submitCurrentStep();
      } else {
        assignPermissionSet(); // après les callouts de ce passage
        running = false;
        finished = true;
        deployId = null;
      }
    } catch (Exception e) {
      fail(e.getMessage());
    }
    return null;
  }

  /**
   * « Connect » : attribue le permission set d'accès au principal s'il manque (insertion en
   * USER_MODE : exige « Assign Permission Sets », aucune élévation), puis redirige vers
   * l'autorisation OAuth de l'utilisateur. Le jeton est stocké chiffré par Salesforce.
   */
  public PageReference connect() {
    if (!isAdmin) {
      fail(
        'Connecting is reserved to Org Intelligence administrators ("Org Intelligence - Admin" permission set).'
      );
      return null;
    }
    if (!alreadyConfigured && !finished) {
      fail('Create the connection first.');
      return null;
    }
    try {
      assignPermissionSet();
    } catch (Exception e) {
      fail(
        'The permission set "Org Intelligence - Tooling Access" could not be assigned to you (' +
          e.getMessage() +
          '). Ask an administrator who can assign permission sets.'
      );
      return null;
    }
    String url = OrgToolingGateway.getInstance().authorizationUrl();
    if (
      String.isBlank(url) ||
      !url.startsWith('/') && !url.startsWith(orgDomain())
    ) {
      fail(
        'The authorization link is not available yet. Reload this page, or use "Open my External Credentials" › Allow Access.'
      );
      return null;
    }
    PageReference target = new PageReference(url);
    target.setRedirect(true);
    return target;
  }

  // ---------- Déploiements ----------

  private void submitCurrentStep() {
    try {
      deployId = submit(buildZip(stepIndex));
      running = true;
    } catch (Exception e) {
      fail(STEP_LABELS[stepIndex] + ': ' + e.getMessage());
    }
  }

  private void fail(String message) {
    failed = true;
    running = false;
    errorMessage = message;
  }

  @TestVisible
  private static Blob buildZip(Integer step) {
    Map<String, String> files = new Map<String, String>();
    Map<String, List<String>> types = new Map<String, List<String>>();
    String domain = orgDomain();
    if (step == 0) {
      // Clé et secret propres à cette org, connus de ce seul déploiement
      String consumerKey =
        'OI_' + EncodingUtil.convertToHex(Crypto.generateAesKey(256)).left(60);
      String consumerSecret = EncodingUtil.convertToHex(
          Crypto.generateAesKey(256)
        )
        .toUpperCase();
      files.put(
        'externalClientApps/' + NAME + '.eca',
        '<ExternalClientApplication ' +
          NS +
          '>' +
          '<contactEmail>' +
          xml(UserInfo.getUserEmail()) +
          '</contactEmail>' +
          '<description>Org Intelligence: access to the Tooling API of this org, on behalf of each user.</description>' +
          '<distributionState>Local</distributionState>' +
          '<isProtected>false</isProtected>' +
          '<label>Org Intelligence Tooling</label>' +
          '</ExternalClientApplication>'
      );
      files.put(
        'extlClntAppOauthSettings/' + NAME + '_oauth.ecaOauth',
        '<ExtlClntAppOauthSettings ' +
          NS +
          '>' +
          '<commaSeparatedOauthScopes>Api, RefreshToken</commaSeparatedOauthScopes>' +
          '<externalClientApplication>' +
          NAME +
          '</externalClientApplication>' +
          '<label>' +
          NAME +
          '_oauth</label>' +
          '</ExtlClntAppOauthSettings>'
      );
      files.put(
        'extlClntAppGlobalOauthSets/' + NAME + '_glbloauth.ecaGlblOauth',
        '<ExtlClntAppGlobalOauthSettings ' +
          NS +
          '>' +
          '<callbackUrl>' +
          xml(domain + '/services/authcallback/' + NAME) +
          '</callbackUrl>' +
          '<consumerKey>' +
          consumerKey +
          '</consumerKey>' +
          '<consumerSecret>' +
          consumerSecret +
          '</consumerSecret>' +
          '<externalClientApplication>' +
          NAME +
          '</externalClientApplication>' +
          '<isConsumerSecretOptional>false</isConsumerSecretOptional>' +
          '<isIntrospectAllTokens>false</isIntrospectAllTokens>' +
          '<isPkceRequired>true</isPkceRequired>' +
          '<isSecretRequiredForRefreshToken>true</isSecretRequiredForRefreshToken>' +
          '<label>' +
          NAME +
          '_glbloauth</label>' +
          '</ExtlClntAppGlobalOauthSettings>'
      );
      files.put(
        'authproviders/' + NAME + '.authprovider',
        '<AuthProvider ' +
          NS +
          '>' +
          '<authorizeUrl>' +
          xml(domain + '/services/oauth2/authorize') +
          '</authorizeUrl>' +
          '<consumerKey>' +
          consumerKey +
          '</consumerKey>' +
          '<consumerSecret>' +
          consumerSecret +
          '</consumerSecret>' +
          '<defaultScopes>api refresh_token</defaultScopes>' +
          '<friendlyName>Org Intelligence Tooling</friendlyName>' +
          '<includeOrgIdInIdentifier>false</includeOrgIdInIdentifier>' +
          '<isPkceEnabled>true</isPkceEnabled>' +
          '<providerType>Salesforce</providerType>' +
          '<sendAccessTokenInHeader>true</sendAccessTokenInHeader>' +
          '<sendClientCredentialsInHeader>false</sendClientCredentialsInHeader>' +
          '<sendSecretInApis>true</sendSecretInApis>' +
          '<tokenUrl>' +
          xml(domain + '/services/oauth2/token') +
          '</tokenUrl>' +
          '<userInfoUrl>' +
          xml(domain + '/services/oauth2/userinfo') +
          '</userInfoUrl>' +
          '</AuthProvider>'
      );
      types.put('ExternalClientApplication', new List<String>{ NAME });
      types.put(
        'ExtlClntAppOauthSettings',
        new List<String>{ NAME + '_oauth' }
      );
      types.put(
        'ExtlClntAppGlobalOauthSettings',
        new List<String>{ NAME + '_glbloauth' }
      );
      types.put('AuthProvider', new List<String>{ NAME });
    } else if (step == 1) {
      files.put(
        'externalCredentials/' + NAME + '.externalCredential',
        '<ExternalCredential ' +
          NS +
          '>' +
          '<authenticationProtocol>Oauth</authenticationProtocol>' +
          '<externalCredentialParameters><authProvider>' +
          NAME +
          '</authProvider><parameterName>AuthProvider</parameterName><parameterType>AuthProvider</parameterType></externalCredentialParameters>' +
          '<externalCredentialParameters><parameterName>Scope</parameterName><parameterType>AuthParameter</parameterType><parameterValue>api refresh_token</parameterValue></externalCredentialParameters>' +
          '<externalCredentialParameters><parameterName>PerUser</parameterName><parameterType>PerUserPrincipal</parameterType><sequenceNumber>1</sequenceNumber></externalCredentialParameters>' +
          '<label>Org Intelligence Tooling</label>' +
          '</ExternalCredential>'
      );
      files.put(
        'namedCredentials/' + NAME + '.namedCredential',
        '<NamedCredential ' +
          NS +
          '>' +
          '<allowMergeFieldsInBody>false</allowMergeFieldsInBody>' +
          '<allowMergeFieldsInHeader>false</allowMergeFieldsInHeader>' +
          '<calloutStatus>Enabled</calloutStatus>' +
          '<generateAuthorizationHeader>true</generateAuthorizationHeader>' +
          '<label>Org Intelligence Tooling</label>' +
          '<namedCredentialParameters><parameterName>Url</parameterName><parameterType>Url</parameterType><parameterValue>' +
          xml(domain) +
          '</parameterValue></namedCredentialParameters>' +
          '<namedCredentialParameters><externalCredential>' +
          NAME +
          '</externalCredential><parameterName>ExternalCredential</parameterName><parameterType>Authentication</parameterType></namedCredentialParameters>' +
          allowedNamespaceParameter(namespacePrefix()) +
          '<namedCredentialType>SecuredEndpoint</namedCredentialType>' +
          '</NamedCredential>'
      );
      types.put('ExternalCredential', new List<String>{ NAME });
      types.put('NamedCredential', new List<String>{ NAME });
    } else {
      files.put(
        'permissionsets/' + PERMISSION_SET + '.permissionset',
        '<PermissionSet ' +
          NS +
          '>' +
          '<description>Org Intelligence: access to the per-user principal of the Tooling API connection (created by the setup assistant).</description>' +
          '<externalCredentialPrincipalAccesses><enabled>true</enabled><externalCredentialPrincipal>' +
          NAME +
          '-PerUser</externalCredentialPrincipal></externalCredentialPrincipalAccesses>' +
          '<hasActivationRequired>false</hasActivationRequired>' +
          '<label>Org Intelligence - Tooling Access</label>' +
          '</PermissionSet>'
      );
      types.put('PermissionSet', new List<String>{ PERMISSION_SET });
    }

    String packageXml = '<Package ' + NS + '>';
    for (String type : types.keySet()) {
      packageXml += '<types>';
      for (String member : types.get(type)) {
        packageXml += '<members>' + member + '</members>';
      }
      packageXml += '<name>' + type + '</name></types>';
    }
    packageXml +=
      '<version>' +
      API_VERSION.removeStart('v') +
      '</version></Package>';

    Compression.ZipWriter writer = new Compression.ZipWriter();
    writer.addEntry('package.xml', Blob.valueOf(header() + packageXml));
    for (String path : files.keySet()) {
      writer.addEntry(path, Blob.valueOf(header() + files.get(path)));
    }
    return writer.getArchive();
  }

  private static String submit(Blob zip) {
    Map<String, Object> options = new Map<String, Object>{
      'deployOptions' => new Map<String, Object>{
        'checkOnly' => false,
        'ignoreWarnings' => true,
        'rollbackOnError' => true,
        'singlePackage' => true,
        'testLevel' => 'NoTestRun'
      }
    };
    HttpRequest request = apiRequest('/metadata/deployRequest');
    request.setMethod('POST');
    request.setTimeout(120000);
    request.setHeader(
      'Content-Type',
      'multipart/form-data; boundary=' + BOUNDARY
    );
    request.setBodyAsBlob(multipartBody(JSON.serialize(options), zip));
    HttpResponse response = new Http().send(request);
    if (response.getStatusCode() >= 300) {
      throw new SetupException(
        'the deployment could not be submitted (' +
          response.getStatusCode() +
          '): ' +
          response.getBody().abbreviate(300)
      );
    }
    return (String) ((Map<String, Object>) JSON.deserializeUntyped(
        response.getBody()
      ))
      .get('id');
  }

  private static Map<String, Object> readDeploy(String id) {
    if (!Pattern.matches('[a-zA-Z0-9]{15,18}', id)) {
      throw new SetupException('Invalid deployment id.');
    }
    HttpRequest request = apiRequest(
      '/metadata/deployRequest/' + id + '?includeDetails=true'
    );
    request.setMethod('GET');
    request.setTimeout(60000);
    HttpResponse response = new Http().send(request);
    if (response.getStatusCode() >= 300) {
      throw new SetupException(
        'The deployment status could not be read (' +
          response.getStatusCode() +
          ').'
      );
    }
    return (Map<String, Object>) ((Map<String, Object>) JSON.deserializeUntyped(
        response.getBody()
      ))
      .get('deployResult');
  }

  private static String describeFailure(Map<String, Object> deploy) {
    List<String> problems = new List<String>();
    Map<String, Object> details = (Map<String, Object>) deploy.get('details');
    Object failures = details == null ? null : details.get('componentFailures');
    if (failures instanceof List<Object>) {
      for (Object item : (List<Object>) failures) {
        Map<String, Object> failure = (Map<String, Object>) item;
        problems.add(failure.get('fullName') + ': ' + failure.get('problem'));
      }
    }
    if (problems.isEmpty() && deploy.get('errorMessage') != null) {
      problems.add((String) deploy.get('errorMessage'));
    }
    return problems.isEmpty()
      ? 'the deployment failed.'
      : String.join(problems, ' | ').abbreviate(600);
  }

  /** Appel à l'API de l'org avec la session Visualforce de l'utilisateur (droits de l'utilisateur). */
  private static HttpRequest apiRequest(String path) {
    HttpRequest request = new HttpRequest();
    request.setEndpoint(orgDomain() + '/services/data/' + API_VERSION + path);
    request.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
    return request;
  }

  private void assignPermissionSet() {
    List<PermissionSet> permissionSets = [
      SELECT Id
      FROM PermissionSet
      WHERE Name = :PERMISSION_SET
      LIMIT 1
    ];
    if (permissionSets.isEmpty()) {
      return;
    }
    Id userId = UserInfo.getUserId();
    Id permissionSetId = permissionSets[0].Id;
    if (
      [
        SELECT COUNT()
        FROM PermissionSetAssignment
        WHERE AssigneeId = :userId AND PermissionSetId = :permissionSetId
      ] == 0
    ) {
      Database.insert(
        new PermissionSetAssignment(
          AssigneeId = userId,
          PermissionSetId = permissionSetId
        ),
        AccessLevel.USER_MODE
      );
    }
  }

  /**
   * Package géré : la Named Credential, locale à l'org, doit autoriser le namespace du package
   * (« Allowed Namespaces for Callouts »). Rien à déclarer pour une installation depuis les sources.
   */
  @TestVisible
  private static String allowedNamespaceParameter(String namespace) {
    if (String.isBlank(namespace)) {
      return '';
    }
    return '<namedCredentialParameters><parameterName>AllowedManagedPackageNamespaces</parameterName>' +
      '<parameterType>AllowedManagedPackageNamespaces</parameterType><parameterValue>' +
      xml(namespace) +
      '</parameterValue></namedCredentialParameters>';
  }

  /**
   * Corps multipart binaire de l'API Metadata REST (copie de celui d'OrgUninstallService, qui ne
   * sera pas livré dans le package géré). Apex ne sait pas concaténer des Blob : on concatène leurs
   * encodages base64, en alignant chaque partie sur un groupe de 4 caractères (en-tête complété par
   * des espaces, fin du zip ajustée pour absorber le saut de ligne qui précède la frontière finale).
   */
  @TestVisible
  private static Blob multipartBody(String json, Blob file) {
    String header =
      '--' +
      BOUNDARY +
      '\r\n' +
      'Content-Disposition: form-data; name="json"\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      json +
      '\r\n' +
      '--' +
      BOUNDARY +
      '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="deploy.zip"\r\n' +
      'Content-Type: application/zip';
    String headerEncoded = EncodingUtil.base64Encode(
      Blob.valueOf(header + '\r\n\r\n')
    );
    while (headerEncoded.endsWith('=')) {
      header += ' ';
      headerEncoded = EncodingUtil.base64Encode(
        Blob.valueOf(header + '\r\n\r\n')
      );
    }
    String bodyEncoded = EncodingUtil.base64Encode(file);
    String footer = '--' + BOUNDARY + '--';
    String last4 = bodyEncoded.substring(bodyEncoded.length() - 4);
    if (last4.endsWith('==')) {
      // 1 octet utile dans le dernier groupe : « 0K » y encode le « \r\n » qui précède la frontière
      last4 = last4.substring(0, 2) + '0K';
      bodyEncoded = bodyEncoded.substring(0, bodyEncoded.length() - 4) + last4;
    } else if (last4.endsWith('=')) {
      // 2 octets utiles : « N » y encode un « \r », le « \n » ouvre le pied
      last4 = last4.substring(0, 3) + 'N';
      bodyEncoded = bodyEncoded.substring(0, bodyEncoded.length() - 4) + last4;
      footer = '\n' + footer;
    } else {
      footer = '\r\n' + footer;
    }
    return EncodingUtil.base64Decode(
      headerEncoded +
        bodyEncoded +
        EncodingUtil.base64Encode(Blob.valueOf(footer))
    );
  }
  private static String orgDomain() {
    return URL.getOrgDomainUrl().toExternalForm().removeEnd('/');
  }

  private static String header() {
    return '<?xml version="1.0" encoding="UTF-8"?>\n';
  }

  private static String xml(String value) {
    return value == null ? '' : value.escapeXml();
  }

  public class SetupException extends Exception {
  }
}
