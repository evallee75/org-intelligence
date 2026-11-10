/**
 * Désinstallation complète d'Org Intelligence depuis l'application (Settings › Uninstall).
 *
 * - Installation par packages : la désinstallation se fait dans Setup › Installed Packages (modules
 *   d'abord, puis le socle) ; l'écran y renvoie.
 * - Installation depuis les sources (sandbox, Developer Edition) : un déploiement destructif est
 *   soumis à l'API Metadata REST (deployRequest), par la connexion Tooling de l'utilisateur. Il
 *   supprime en une transaction, avec purge (sans corbeille), tous les composants du socle et des
 *   modules listés dans la ressource statique OrgIntelligenceUninstall (générée depuis le dépôt par
 *   scripts/build-uninstall-manifest.mjs) — jamais un autre composant de l'org. Un second déploiement,
 *   exécuté après le premier, supprime la connexion Tooling elle-même (option).
 *
 * Callouts d'abord, écritures ensuite : après la soumission, les jobs planifiés sont arrêtés et les
 * assignations des permission sets Org Intelligence retirées (un permission set assigné ne peut pas
 * être supprimé). L'utilisateur perd alors l'accès à l'application, qui disparaît en une minute.
 * Refusé en production (la purge et le déploiement sans tests n'y sont pas permis).
 */
public with sharing class OrgUninstallService {
  /** Erreur lisible (convertie en message d'écran par OrgAdminController). */
  public class UninstallException extends Exception {
  }

  public static final String CONFIRMATION = 'DELETE';
  public static final String MODE_SOURCE = 'source';
  public static final String MODE_PACKAGE = 'package';
  public static final String MODE_UNKNOWN = 'unknown';
  // Dossiers de rapports / dashboards livrés par le produit (dont l'ancien dossier du socle) :
  // jamais un autre dossier dont le nom commencerait par OrgIntelligence.
  @TestVisible
  private static final Set<String> ANALYTICS_FOLDERS = new Set<String>{
    'OrgIntelligence',
    'OrgIntelligenceRecommendations'
  };
  @TestVisible
  private static final String MANIFEST_RESOURCE = 'OrgIntelligenceUninstall';
  private static final String API_VERSION = 'v66.0';
  public static final String BOUNDARY = 'OrgIntelligenceUninstallBoundary';

  public class UninstallStatus {
    @AuraEnabled
    public String mode;
    @AuraEnabled
    public String orgName;
    @AuraEnabled
    public Boolean isSandbox;
    @AuraEnabled
    public Boolean toolingConnected = false;
    @AuraEnabled
    public Boolean canUninstall = false;
    @AuraEnabled
    public String reason;
    @AuraEnabled
    public Integer componentCount = 0;
    @AuraEnabled
    public List<String> packages = new List<String>();
    @AuraEnabled
    public String confirmation;
  }

  public class UninstallResult {
    @AuraEnabled
    public String deployId;
    @AuraEnabled
    public String toolingDeployId;
    @AuraEnabled
    public Integer componentCount;
    @AuraEnabled
    public Integer jobsStopped = 0;
    @AuraEnabled
    public Integer assignmentsRemoved = 0;
  }

  public class DeployStatus {
    @AuraEnabled
    public String id;
    @AuraEnabled
    public String status;
    @AuraEnabled
    public Boolean done = false;
    @AuraEnabled
    public Integer componentsDeployed;
    @AuraEnabled
    public Integer componentsTotal;
    @AuraEnabled
    public Integer componentErrors;
    @AuraEnabled
    public String errorMessage;
    @AuraEnabled
    public List<String> problems = new List<String>();
  }

  // ---------- État ----------

  /** État pour l'écran (écrit ensuite le journal des appels Tooling). */
  public static UninstallStatus getStatus() {
    UninstallStatus status = computeStatus();
    OrgApiLogger.flush();
    return status;
  }

  /**
   * État sans aucune écriture : prepare, uninstall et validate font leurs callouts après lui (un
   * callout est refusé après une écriture dans la même transaction).
   */
  private static UninstallStatus computeStatus() {
    UninstallStatus status = new UninstallStatus();
    status.confirmation = CONFIRMATION;
    Organization org = [
      SELECT Name, IsSandbox, OrganizationType
      FROM Organization
      LIMIT 1
    ];
    status.orgName = org.Name;
    status.isSandbox =
      org.IsSandbox || org.OrganizationType == 'Developer Edition';
    status.componentCount = countComponents(readManifest());

    OrgToolingGateway gateway = OrgToolingGateway.getInstance();
    if (!gateway.isConfigured()) {
      status.mode = MODE_UNKNOWN;
      status.reason =
        'The Tooling API connection is not set up: uninstall with the command line ' +
        '(node scripts/uninstall.mjs) or, for packages, from Setup > Installed Packages.';
      return status;
    }
    try {
      for (
        Map<String, Object> row : gateway.query(
          'SELECT SubscriberPackage.Name FROM InstalledSubscriberPackage'
        )
      ) {
        String name = OrgToolingGateway.getString(
          row,
          'SubscriberPackage.Name'
        );
        if (name != null && name.startsWith('OrgIntelligence')) {
          status.packages.add(name);
        }
      }
      status.toolingConnected = true;
    } catch (Exception e) {
      status.mode = MODE_UNKNOWN;
      status.reason = e.getMessage();
      return status;
    }
    status.mode = status.packages.isEmpty() ? MODE_SOURCE : MODE_PACKAGE;
    if (status.mode == MODE_PACKAGE) {
      status.reason = 'Org Intelligence is installed as packages: uninstall the modules, then the core, from Setup > Installed Packages.';
    } else if (!status.isSandbox) {
      status.reason = 'Uninstalling from the app is only available in sandboxes and Developer Edition orgs.';
    } else {
      status.canUninstall = true;
    }
    return status;
  }

  // ---------- Désinstallation ----------

  public static UninstallResult uninstall(
    String confirmation,
    Boolean removeToolingConnection
  ) {
    // Nom qualifié : le paramètre « confirmation » masquerait la constante (Apex ignore la casse),
    // et equals compare en respectant la casse (« != » ne la respecte pas)
    if (!OrgUninstallService.CONFIRMATION.equals(confirmation)) {
      throw new UninstallException(
        'Type ' +
          OrgUninstallService.CONFIRMATION +
          ' to confirm the uninstall.'
      );
    }
    UninstallStatus status = computeStatus();
    if (!status.canUninstall) {
      throw new UninstallException(status.reason);
    }
    Map<String, Object> manifest = readManifest();
    Map<String, Object> components = (Map<String, Object>) manifest.get(
      'components'
    );
    List<List<String>> tooling = new List<List<String>>();
    for (Object item : (List<Object>) manifest.get('tooling')) {
      Map<String, Object> entry = (Map<String, Object>) item;
      tooling.add(
        new List<String>{
          (String) entry.get('type'),
          (String) entry.get('name')
        }
      );
    }

    // 1. Callouts, trois déploiements indépendants (Salesforce peut les exécuter en parallèle) :
    //    a. socle et modules (purge), sans les permission sets : l'application disparaît ;
    //    b. permission sets (+ Named / External Credential Tooling) : un permission set assigné ne
    //       peut pas être supprimé, les assignations sont retirées par cette transaction, validée en
    //       quelques millisecondes, avant le démarrage du déploiement (quelques secondes). Si (b)
    //       échouait quand même, seuls des permission sets resteraient : relancer
    //       scripts/uninstall.mjs ou les supprimer dans Setup ;
    //    c. Auth. Provider et External Client App Tooling (sans purge, qui échoue sur ces types).
    UninstallResult result = new UninstallResult();
    result.componentCount = countComponents(manifest);
    result.deployId = submitDeploy(
      buildZip(destructiveXml(withoutPermissionSets(components))),
      true,
      false
    );
    Map<String, Object> access = new Map<String, Object>{
      'PermissionSet' => components.get('PermissionSet')
    };
    Map<String, Object> toolingApp = new Map<String, Object>();
    if (removeToolingConnection == true) {
      for (List<String> entry : tooling) {
        Map<String, Object> target = new Set<String>{
              'PermissionSet',
              'NamedCredential',
              'ExternalCredential'
            }
            .contains(entry[0])
          ? access
          : toolingApp;
        List<Object> members = target.containsKey(entry[0])
          ? new List<Object>((List<Object>) target.get(entry[0]))
          : new List<Object>();
        members.add(entry[1]);
        target.put(entry[0], members);
      }
    }
    result.toolingDeployId = submitDeploy(
      buildZip(destructiveXml(access)),
      false,
      false
    );
    if (!toolingApp.isEmpty()) {
      submitDeploy(buildZip(destructiveXml(toolingApp)), false, false);
    }
    OrgApiLogger.flush();

    // 2. Écritures : jobs arrêtés et assignations retirées avant que le déploiement ne démarre
    Set<String> classNames = new Set<String>();
    for (Object name : (List<Object>) components.get('ApexClass')) {
      classNames.add((String) name);
    }
    for (CronTrigger job : [
      SELECT Id
      FROM CronTrigger
      WHERE CronJobDetail.Name LIKE 'Org Intelligence%'
    ]) {
      System.abortJob(job.Id);
      result.jobsStopped++;
    }
    for (AsyncApexJob job : [
      SELECT Id
      FROM AsyncApexJob
      WHERE
        Status IN ('Holding', 'Queued', 'Preparing', 'Processing')
        AND ApexClass.Name IN :classNames
    ]) {
      System.abortJob(job.Id);
      result.jobsStopped++;
    }
    Set<String> permissionSets = new Set<String>();
    for (Object name : (List<Object>) components.get('PermissionSet')) {
      permissionSets.add((String) name);
    }
    if (removeToolingConnection == true) {
      permissionSets.add('OrgIntelligence_Tooling_Access');
    }
    List<PermissionSetAssignment> assignments = [
      SELECT Id
      FROM PermissionSetAssignment
      WHERE PermissionSet.Name IN :permissionSets
    ];
    Database.delete(assignments, AccessLevel.SYSTEM_MODE);
    result.assignmentsRemoved = assignments.size();
    return result;
  }

  /**
   * Première étape : supprime les rapports et tableaux de bord des dossiers Org Intelligence par
   * l'API Analytics (corbeille), puis vide la corbeille pour eux. Supprimés par un déploiement, ils
   * garderaient leur nom réservé et bloqueraient une réinstallation. Callouts puis écriture : appelée
   * seule, avant uninstall().
   *
   * @return nombre de rapports et tableaux de bord supprimés
   */
  public static Integer prepare(String confirmation) {
    // Nom qualifié : le paramètre « confirmation » masquerait la constante (Apex ignore la casse),
    // et equals compare en respectant la casse (« != » ne la respecte pas)
    if (!OrgUninstallService.CONFIRMATION.equals(confirmation)) {
      throw new UninstallException(
        'Type ' +
          OrgUninstallService.CONFIRMATION +
          ' to confirm the uninstall.'
      );
    }
    UninstallStatus status = computeStatus();
    if (!status.canUninstall) {
      throw new UninstallException(status.reason);
    }
    List<Id> deleted = new List<Id>();
    for (Report report : [
      SELECT Id
      FROM Report
      WHERE
        OwnerId IN (
          SELECT Id
          FROM Folder
          WHERE Type = 'Report' AND DeveloperName IN :ANALYTICS_FOLDERS
        )
    ]) {
      if (deleteAnalytics('reports', report.Id)) {
        deleted.add(report.Id);
      }
    }
    for (Dashboard dashboard : [
      SELECT Id
      FROM Dashboard
      WHERE
        FolderId IN (
          SELECT Id
          FROM Folder
          WHERE Type = 'Dashboard' AND DeveloperName IN :ANALYTICS_FOLDERS
        )
    ]) {
      if (deleteAnalytics('dashboards', dashboard.Id)) {
        deleted.add(dashboard.Id);
      }
    }
    OrgApiLogger.flush();
    if (!deleted.isEmpty()) {
      Database.emptyRecycleBin(deleted);
    }
    return deleted.size();
  }

  private static Boolean deleteAnalytics(String kind, Id recordId) {
    HttpRequest request = new HttpRequest();
    request.setEndpoint(
      'callout:' +
        OrgToolingGateway.getInstance().namedCredentialName() +
        '/services/data/' +
        API_VERSION +
        '/analytics/' +
        kind +
        '/' +
        recordId
    );
    request.setMethod('DELETE');
    request.setTimeout(60000);
    HttpResponse response = new Http().send(request);
    return response.getStatusCode() < 300;
  }

  /**
   * Simulation (validation sans suppression) du déploiement destructif du socle et des modules :
   * vérifie la connexion, le manifeste et les dépendances. Renvoie l'identifiant du déploiement de
   * validation, à suivre avec getDeployStatus (scripts/smoke-test.mjs --uninstall-dry-run).
   */
  public static String validate() {
    UninstallStatus status = computeStatus();
    if (!status.canUninstall) {
      throw new UninstallException(status.reason);
    }
    Map<String, Object> components = (Map<String, Object>) readManifest()
      .get('components');
    // Sans les permission sets : encore assignés pendant une simulation (la vraie désinstallation
    // retire les assignations, puis les supprime dans un second déploiement)
    String deployId = submitDeploy(
      buildZip(destructiveXml(withoutPermissionSets(components))),
      true,
      true
    );
    OrgApiLogger.flush();
    return deployId;
  }

  /** Avancement d'un déploiement (tant que l'utilisateur a encore accès à l'application). */
  public static DeployStatus getDeployStatus(String deployId) {
    if (
      String.isBlank(deployId) ||
      !Pattern.matches('[a-zA-Z0-9]{15,18}', deployId)
    ) {
      throw new UninstallException('Invalid deployment id.');
    }
    HttpRequest request = new HttpRequest();
    request.setEndpoint(
      'callout:' +
        OrgToolingGateway.getInstance().namedCredentialName() +
        '/services/data/' +
        API_VERSION +
        '/metadata/deployRequest/' +
        deployId +
        '?includeDetails=true'
    );
    request.setMethod('GET');
    request.setTimeout(60000);
    HttpResponse response = new Http().send(request);
    if (response.getStatusCode() >= 300) {
      throw new UninstallException(
        'The deployment status could not be read (' +
          response.getStatusCode() +
          ').'
      );
    }
    Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(
      response.getBody()
    );
    Map<String, Object> deploy = (Map<String, Object>) body.get('deployResult');
    DeployStatus status = new DeployStatus();
    status.id = deployId;
    status.status = (String) deploy.get('status');
    status.done = deploy.get('done') == true;
    status.componentsDeployed = (Integer) deploy.get(
      'numberComponentsDeployed'
    );
    status.componentsTotal = (Integer) deploy.get('numberComponentsTotal');
    status.componentErrors = (Integer) deploy.get('numberComponentErrors');
    status.errorMessage = (String) deploy.get('errorMessage');
    Map<String, Object> details = (Map<String, Object>) deploy.get('details');
    Object failures = details == null ? null : details.get('componentFailures');
    if (failures instanceof List<Object>) {
      for (Object item : (List<Object>) failures) {
        Map<String, Object> failure = (Map<String, Object>) item;
        status.problems.add(
          failure.get('componentType') +
            ' ' +
            failure.get('fullName') +
            ': ' +
            failure.get('problem')
        );
      }
    }
    return status;
  }

  // ---------- Construction du déploiement ----------

  @TestVisible
  private static Map<String, Object> readManifest() {
    List<StaticResource> resources = [
      SELECT Body
      FROM StaticResource
      WHERE Name = :MANIFEST_RESOURCE
      LIMIT 1
    ];
    if (resources.isEmpty()) {
      throw new UninstallException(
        'The uninstall manifest (static resource ' +
          MANIFEST_RESOURCE +
          ') is missing.'
      );
    }
    return (Map<String, Object>) JSON.deserializeUntyped(
      resources[0].Body.toString()
    );
  }

  private static Integer countComponents(Map<String, Object> manifest) {
    Integer total = 0;
    Map<String, Object> components = (Map<String, Object>) manifest.get(
      'components'
    );
    for (String type : components.keySet()) {
      total += ((List<Object>) components.get(type)).size();
    }
    return total;
  }

  private static Map<String, Object> withoutPermissionSets(
    Map<String, Object> components
  ) {
    Map<String, Object> result = new Map<String, Object>(components);
    result.remove('PermissionSet');
    return result;
  }

  @TestVisible
  private static String destructiveXml(Map<String, Object> componentsByType) {
    List<String> types = new List<String>(componentsByType.keySet());
    types.sort();
    String xml = '<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">';
    for (String type : types) {
      xml += '<types>';
      for (Object member : (List<Object>) componentsByType.get(type)) {
        xml += '<members>' + ((String) member).escapeXml() + '</members>';
      }
      xml += '<name>' + type + '</name></types>';
    }
    return xml +
      '<version>' +
      API_VERSION.removeStart('v') +
      '</version></Package>';
  }

  @TestVisible
  private static Blob buildZip(String destructiveXml) {
    Compression.ZipWriter writer = new Compression.ZipWriter();
    writer.addEntry(
      'package.xml',
      Blob.valueOf(
        '<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>' +
          API_VERSION.removeStart('v') +
          '</version></Package>'
      )
    );
    writer.addEntry('destructiveChanges.xml', Blob.valueOf(destructiveXml));
    return writer.getArchive();
  }

  /** Soumet le déploiement (multipart : options JSON + zip) et renvoie son identifiant. */
  private static String submitDeploy(
    Blob zip,
    Boolean purge,
    Boolean checkOnly
  ) {
    Map<String, Object> options = new Map<String, Object>{
      'deployOptions' => new Map<String, Object>{
        'purgeOnDelete' => purge,
        'checkOnly' => checkOnly,
        'ignoreWarnings' => true,
        'rollbackOnError' => true,
        'singlePackage' => true,
        'testLevel' => 'NoTestRun'
      }
    };
    HttpRequest request = new HttpRequest();
    request.setEndpoint(
      'callout:' +
        OrgToolingGateway.getInstance().namedCredentialName() +
        '/services/data/' +
        API_VERSION +
        '/metadata/deployRequest'
    );
    request.setMethod('POST');
    request.setTimeout(120000);
    request.setHeader(
      'Content-Type',
      'multipart/form-data; boundary=' + BOUNDARY
    );
    request.setBodyAsBlob(multipartBody(JSON.serialize(options), zip));

    OrgApiLogger.Entry entry = new OrgApiLogger.Entry();
    entry.systemName = 'Salesforce Metadata API';
    entry.method = 'POST';
    entry.endpoint = '/metadata/deployRequest';
    entry.operation =
      'Uninstall Org Intelligence' + (purge ? '' : ' (Tooling connection)');
    Long started = System.currentTimeMillis();
    HttpResponse response = new Http().send(request);
    entry.durationMs = System.currentTimeMillis() - started;
    entry.statusCode = response.getStatusCode();
    entry.responseBody = response.getBody();
    OrgApiLogger.log(entry);
    if (response.getStatusCode() >= 300) {
      throw new UninstallException(
        'The uninstall could not be submitted (' +
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

  /**
   * Corps multipart binaire. Apex ne sait pas concaténer des Blob : on concatène leurs encodages
   * base64, en alignant chaque partie sur un groupe de 4 caractères (en-tête complété par des espaces,
   * fin du zip ajustée pour absorber le saut de ligne qui précède la frontière finale). Réutilisé par
   * l'assistant de connexion Tooling (OrgToolingSetupController).
   */
  public static Blob multipartBody(String json, Blob file) {
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
}
