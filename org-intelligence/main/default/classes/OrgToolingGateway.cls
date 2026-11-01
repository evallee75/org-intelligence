/**
 * Accès à la Tooling API de l'org courante via la Named Credential paramétrée
 * (OrgIntelSettings__c.ToolingNamedCredential__c).
 *
 * La Named Credential utilise un principal par utilisateur : les appels sont faits avec les droits
 * de la personne qui lance le scan (ni identifiant de session, ni compte technique). La connexion
 * (External Client App, Auth. Provider, External / Named Credential) est créée dans l'org par
 * l'assistant OrgToolingSetupController ; chaque utilisateur l'autorise ensuite d'un clic
 * (authorizationUrl). En package géré, la Named Credential reste locale à l'org et autorise le
 * namespace du package (cf. docs/org-intelligence/tooling-api-setup.md). Sans Named Credential (ou sans authentification de
 * l'utilisateur), le scanner passe en mode dégradé et le note dans son journal.
 *
 * Classe virtuelle : les tests la remplacent par un bouchon (setInstance), ce qui évite tout appel
 * HTTP au milieu des DML du scan.
 */
@NamespaceAccessible
public virtual inherited sharing class OrgToolingGateway {
  @NamespaceAccessible
  public static final String API_VERSION = 'v66.0';
  private static final Integer MAX_PAGES = 20;

  private static OrgToolingGateway instance;

  @NamespaceAccessible
  public static OrgToolingGateway getInstance() {
    if (instance == null) {
      instance = new OrgToolingGateway();
    }
    return instance;
  }

  @TestVisible
  private static void setInstance(OrgToolingGateway gateway) {
    instance = gateway;
  }

  /**
   * Tests de tous les paquets du namespace (les membres @TestVisible privés ne traversent pas les
   * paquets) : remplace la passerelle par un bouchon. Refusé hors contexte de test.
   */
  @NamespaceAccessible
  public static void setInstanceForTests(OrgToolingGateway gateway) {
    if (!Test.isRunningTest()) {
      throw new ToolingException('Tests only');
    }
    instance = gateway;
  }

  @NamespaceAccessible
  public class ToolingException extends Exception {
  }

  /** État de la connexion, affiché dans le scanner. */
  @NamespaceAccessible
  public class Status {
    @AuraEnabled
    public Boolean configured = false;
    @AuraEnabled
    public Boolean connected = false;
    @AuraEnabled
    public String namedCredential;
    @AuraEnabled
    public String message;
    /**
     * L'utilisateur courant a-t-il autorisé son accès (jeton OAuth du principal par utilisateur) ?
     * Lu par ConnectApi, sans appel HTTP ; null si l'information n'est pas disponible.
     */
    @AuraEnabled
    public Boolean authorized;
    /** URL qui lance l'autorisation OAuth de l'utilisateur courant (bouton « Connect »). */
    @AuraEnabled
    public String authorizationUrl;
    /** Assistant de création de la connexion (page Visualforce, préfixe du namespace compris). */
    @AuraEnabled
    public String setupUrl;
  }

  /** Principal par utilisateur de l'External Credential (même nom que la Named Credential). */
  @NamespaceAccessible
  public static final String PRINCIPAL_NAME = 'PerUser';

  /**
   * Namespace du package qui contient ce code (« orgintel » en package géré), vide dans une
   * installation depuis les sources : le nom d'une classe namespacée est « ns.Classe ».
   */
  @NamespaceAccessible
  public static String namespacePrefix() {
    return OrgIntelNamespace.prefix();
  }

  @NamespaceAccessible
  public virtual String namedCredentialName() {
    return OrgIntelSettings.toolingNamedCredential();
  }

  /**
   * External Credential de la connexion : même nom que la Named Credential (convention de
   * l'assistant et du script setup-tooling.mjs).
   */
  @NamespaceAccessible
  public virtual String externalCredentialName() {
    return namedCredentialName();
  }

  /**
   * La Named Credential existe-t-elle ? (sans appel HTTP). Le nom peut porter un namespace
   * (« ns__Nom ») si la connexion est un jour livrée par un package.
   */
  @NamespaceAccessible
  public virtual Boolean isConfigured() {
    String name = namedCredentialName();
    if (String.isBlank(name)) {
      return false;
    }
    String namespace = name.contains('__') ? name.substringBefore('__') : null;
    String developerName = name.contains('__')
      ? name.substringAfter('__')
      : name;
    return ![
        SELECT Id
        FROM NamedCredential
        WHERE DeveloperName = :developerName AND NamespacePrefix = :namespace
        LIMIT 1
      ]
      .isEmpty();
  }

  /**
   * Jeton OAuth de l'utilisateur courant sur le principal par utilisateur : true / false, ou null
   * si ConnectApi ne répond pas (droits, contexte de test) — l'appel de test tranche alors.
   */
  @NamespaceAccessible
  public virtual Boolean isUserAuthorized() {
    try {
      ConnectApi.Credential credential = ConnectApi.NamedCredentials.getCredential(
        externalCredentialName(),
        PRINCIPAL_NAME,
        ConnectApi.CredentialPrincipalType.PerUserPrincipal
      );
      return credential?.credentials != null &&
        credential.credentials.containsKey('oAuthToken');
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * URL d'autorisation OAuth de l'utilisateur courant (/services/auth/xds/…) : équivalent du
   * bouton « Allow Access » des paramètres personnels, en un clic depuis l'application.
   */
  @NamespaceAccessible
  public virtual String authorizationUrl() {
    try {
      ConnectApi.OAuthCredentialAuthUrlInput input = new ConnectApi.OAuthCredentialAuthUrlInput();
      input.externalCredential = externalCredentialName();
      input.principalName = PRINCIPAL_NAME;
      input.principalType = ConnectApi.CredentialPrincipalType.PerUserPrincipal;
      return ConnectApi.NamedCredentials.getOAuthCredentialAuthUrl(input)
        ?.authenticationUrl;
    } catch (Exception e) {
      return null;
    }
  }

  /** URL de l'assistant de connexion (Page.getUrl ajoute le namespace en package géré). */
  @NamespaceAccessible
  public static String setupPageUrl() {
    return Page.OrgIntelligenceToolingSetup.getUrl();
  }

  /** Vérifie la configuration puis tente une requête minimale. */
  @NamespaceAccessible
  public virtual Status checkConnection() {
    Status status = new Status();
    status.namedCredential = namedCredentialName();
    status.setupUrl = setupPageUrl();
    status.configured = isConfigured();
    if (!status.configured) {
      status.message =
        'Tooling API not configured: the Named Credential "' +
        status.namedCredential +
        '" does not exist. Validation rules, dependencies and code coverage are skipped.';
      return status;
    }
    status.authorized = isUserAuthorized();
    if (status.authorized == false) {
      // Pas de jeton : inutile d'appeler (et de journaliser) un 401 certain
      status.authorizationUrl = authorizationUrl();
      status.message = 'Tooling API not authorized for your user: click "Connect" to allow your access. Validation rules, dependencies and code coverage are skipped.';
      return status;
    }
    try {
      query('SELECT Id FROM ApexClass LIMIT 1');
      status.connected = true;
      status.authorized = true;
      status.message = 'Tooling API connected.';
    } catch (ToolingException e) {
      status.message = e.getMessage();
      status.authorizationUrl = authorizationUrl();
    }
    return status;
  }

  /** Requête Tooling, pagination comprise. Chaque enregistrement est une Map JSON. */
  @NamespaceAccessible
  public virtual List<Map<String, Object>> query(String soql) {
    List<Map<String, Object>> records = new List<Map<String, Object>>();
    String path =
      '/services/data/' +
      API_VERSION +
      '/tooling/query/?q=' +
      EncodingUtil.urlEncode(soql, 'UTF-8');
    Integer pages = 0;
    while (path != null && pages < MAX_PAGES) {
      Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(
        send(path)
      );
      for (Object record : (List<Object>) body.get('records')) {
        records.add((Map<String, Object>) record);
      }
      path = (Boolean) body.get('done') == true
        ? null
        : (String) body.get('nextRecordsUrl');
      pages++;
    }
    return records;
  }

  /** Appel REST en lecture sur l'org (ex. /limits/recordCount), même connexion et même journal. */
  @NamespaceAccessible
  public virtual String getRest(String relativePath) {
    return send('/services/data/' + API_VERSION + relativePath);
  }

  @NamespaceAccessible
  protected virtual String send(String path) {
    HttpRequest request = new HttpRequest();
    // Pas OrgIntelNamespace.callout : la Named Credential Tooling est créée dans l'org par
    // l'assistant, hors package, donc sans préfixe (elle autorise le namespace du package)
    request.setEndpoint('callout:' + namedCredentialName() + path);
    request.setMethod('GET');
    request.setTimeout(60000);

    OrgApiLogger.Entry entry = new OrgApiLogger.Entry();
    entry.systemName = 'Salesforce Tooling API';
    entry.method = 'GET';
    entry.endpoint = path.substringBefore('?');
    entry.operation = describeOperation(path);
    Long started = System.currentTimeMillis();
    HttpResponse response;
    try {
      response = new Http().send(request);
    } catch (CalloutException e) {
      entry.durationMs = System.currentTimeMillis() - started;
      entry.success = false;
      entry.errorMessage = e.getMessage();
      OrgApiLogger.log(entry);
      throw new ToolingException(
        'Tooling API unreachable through the Named Credential: ' +
        e.getMessage()
      );
    }
    entry.durationMs = System.currentTimeMillis() - started;
    entry.statusCode = response.getStatusCode();
    if (response.getStatusCode() >= 300) {
      // Corps gardé seulement en cas d'erreur : une réponse réussie contient des définitions de
      // métadonnées (flows, formules, présentations) qui n'ont pas leur place dans le journal API
      entry.responseBody = response.getBody();
      entry.errorMessage = readErrorMessage(response.getBody());
    }
    OrgApiLogger.log(entry);

    if (response.getStatusCode() == 401 || response.getStatusCode() == 403) {
      throw new ToolingException(
        'Tooling API access refused (' +
          response.getStatusCode() +
          '). Authenticate your user on the "' +
          namedCredentialName() +
          '" external credential (personal settings > External Credentials) and check you have "View Setup and Configuration".'
      );
    }
    if (response.getStatusCode() >= 300) {
      throw new ToolingException(
        'Tooling API error (' +
          response.getStatusCode() +
          '): ' +
          readErrorMessage(response.getBody())
      );
    }
    return response.getBody();
  }

  /** « Tooling query: ValidationRule » : objet interrogé, lisible dans le journal API. */
  @TestVisible
  private static String describeOperation(String path) {
    String query = path.contains('?q=')
      ? EncodingUtil.urlDecode(path.substringAfter('?q='), 'UTF-8')
      : null;
    if (query == null) {
      return path.contains('/tooling/')
        ? 'Tooling query (next page)'
        : 'REST GET ' +
          path.substringAfter('/services/data/').substringAfter('/');
    }
    Matcher matcher = Pattern.compile('(?i)\\bFROM\\s+(\\w+)').matcher(query);
    return matcher.find()
      ? 'Tooling query: ' + matcher.group(1)
      : 'Tooling query';
  }

  /** Message d'erreur Salesforce (« [{"message": …, "errorCode": …}] »), borné en longueur. */
  @TestVisible
  private static String readErrorMessage(String body) {
    try {
      List<Object> errors = (List<Object>) JSON.deserializeUntyped(body);
      Map<String, Object> first = (Map<String, Object>) errors[0];
      return ((String) first.get('message')).abbreviate(300);
    } catch (Exception e) {
      return 'unexpected response';
    }
  }

  // ---------- Lecture des Map JSON ----------

  @NamespaceAccessible
  public static String getString(Map<String, Object> record, String path) {
    Object value = getValue(record, path);
    return value == null ? null : String.valueOf(value);
  }

  /** Lecture d'un chemin pointé (« EntityDefinition.QualifiedApiName »). */
  @NamespaceAccessible
  public static Object getValue(Map<String, Object> record, String path) {
    Object current = record;
    for (String part : path.split('\\.')) {
      if (!(current instanceof Map<String, Object>)) {
        return null;
      }
      current = ((Map<String, Object>) current).get(part);
    }
    return current;
  }
}
