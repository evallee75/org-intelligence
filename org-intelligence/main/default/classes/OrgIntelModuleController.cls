/**
 * Point d'entrée Apex unique des écrans des modules optionnels.
 *
 * Les LWC des modules sont livrés avec le socle mais ne peuvent pas importer les classes d'un module
 * (absent de l'org, le composant ne compilerait pas) : ils appellent invoke(module, action, params),
 * qui transmet au module installé et renvoie le résultat sérialisé en JSON (orgIntelUtils.callModule
 * le décode). Les contrôles d'accès restent dans chaque action du module.
 */
public with sharing class OrgIntelModuleController {
  /** Clé du socle dans le catalogue de l'écran Modules. */
  public static final String CORE = 'core';
  /** Taille maximale des paramètres JSON d'une action (caractères, environ 3 Mo). */
  private static final Integer MAX_PARAMS_LENGTH = 3000000;

  /** Permission set d'administration du socle et de chaque module (attribuable depuis l'écran Modules). */
  @TestVisible
  private static final Map<String, String> ADMIN_PERMISSION_SETS = new Map<String, String>{
    CORE => OrgIntelligenceConstants.ADMIN_PERMISSION,
    OrgIntelModules.RECOMMENDATIONS => 'OrgIntelligence_Recommendations_Admin',
    OrgIntelModules.CONTEXT_HUB => 'OrgIntelligence_ContextHub_Admin',
    OrgIntelModules.API_MONITORING => 'OrgIntelligence_ApiMonitoring_Admin',
    OrgIntelModules.FIELD_USAGE => 'OrgIntelligence_FieldUsage_Admin',
    OrgIntelModules.ADOPTION => 'OrgIntelligence_Adoption_Admin',
    OrgIntelModules.SECURITY => 'OrgIntelligence_Security_Admin',
    OrgIntelModules.INVENTORY => 'OrgIntelligence_Inventory_Admin'
  };

  /**
   * Modules installés et accessibles : la coquille masque les sections des autres. Non mis en cache :
   * la liste change dès qu'un module est installé ou qu'un accès est attribué depuis l'écran Modules.
   */
  @AuraEnabled
  public static List<ModuleInfo> getModules() {
    List<ModuleInfo> modules = new List<ModuleInfo>();
    for (OrgIntelModule module : OrgIntelModules.installed()) {
      if (!module.isAccessible()) {
        continue;
      }
      ModuleInfo info = new ModuleInfo();
      info.key = module.key();
      info.label = OrgIntelModules.LABELS.get(module.key());
      modules.add(info);
    }
    return modules;
  }

  /**
   * Outils présents seulement après une installation depuis les sources (ex. « uninstall ») et
   * accessibles à l'utilisateur : Settings n'affiche la désinstallation complète que s'il est là.
   */
  @AuraEnabled
  public static List<String> getTools() {
    return OrgIntelModules.availableTools();
  }

  /**
   * Namespace du package (« orgintel »), vide dans une installation depuis les sources : les écrans
   * s'en servent pour les noms cités en texte (pages Visualforce, onglet, objets).
   */
  @AuraEnabled(cacheable=true)
  public static String getNamespace() {
    return OrgIntelNamespace.prefix();
  }

  /**
   * Action d'un module. Les clés JSON des champs du package sont échangées sans préfixe de
   * namespace (les écrans lisent « Title__c » avec et sans package géré) : le préfixe est retiré de
   * la réponse (OrgIntelNamespace.stripKeys).
   */
  @AuraEnabled
  public static String invoke(String module, String action, String paramsJson) {
    OrgIntelModule target = OrgIntelModules.require(module);
    // Au-delà, la conversion et le traitement risquent de dépasser le tas Apex (6 Mo) : refus lisible
    if (paramsJson != null && paramsJson.length() > MAX_PARAMS_LENGTH) {
      throw OrgIntelAccess.error(
        'The data sent by the screen is too large (over 3 MB): send it in smaller batches.'
      );
    }
    try {
      Map<String, Object> params = readParams(paramsJson);
      Object result = target.invoke(action, params);
      return result == null
        ? null
        : OrgIntelNamespace.stripKeys(JSON.serialize(result));
    } catch (AuraHandledException e) {
      throw e;
    } catch (Exception e) {
      throw OrgIntelAccess.error('The action could not be completed', e);
    }
  }

  /** Paramètres JSON : un objet est attendu (un tableau ou une valeur simple est refusé). */
  private static Map<String, Object> readParams(String paramsJson) {
    if (String.isBlank(paramsJson)) {
      return new Map<String, Object>();
    }
    Object parsed;
    try {
      parsed = JSON.deserializeUntyped(paramsJson);
    } catch (JSONException e) {
      throw OrgIntelAccess.error(
        'The data sent by the screen is not valid JSON.'
      );
    }
    if (parsed == null) {
      return new Map<String, Object>();
    }
    if (!(parsed instanceof Map<String, Object>)) {
      throw OrgIntelAccess.error(
        'The data sent by the screen must be a JSON object.'
      );
    }
    return (Map<String, Object>) parsed;
  }

  /**
   * Écran « Choose your modules » : état du socle et de chaque module (installé, accessible,
   * permission set attribué à l'utilisateur courant). Ouvert à tout utilisateur qui voit l'application,
   * y compris un administrateur Salesforce qui vient d'installer le package sans permission set.
   */
  @AuraEnabled
  public static Catalog getModuleCatalog() {
    Id userId = UserInfo.getUserId();
    Set<String> names = new Set<String>(ADMIN_PERMISSION_SETS.values());
    // Permission sets du package seulement (un permission set du client peut porter le même nom)
    String namespace = OrgIntelNamespace.namespaceFilter();
    Set<String> existing = new Set<String>();
    for (PermissionSet permissionSet : [
      SELECT Name
      FROM PermissionSet
      WHERE Name IN :names AND NamespacePrefix = :namespace
    ]) {
      existing.add(permissionSet.Name);
    }
    Set<String> assigned = new Set<String>();
    for (PermissionSetAssignment assignment : [
      SELECT PermissionSet.Name
      FROM PermissionSetAssignment
      WHERE
        AssigneeId = :userId
        AND PermissionSet.Name IN :names
        AND PermissionSet.NamespacePrefix = :namespace
    ]) {
      assigned.add(assignment.PermissionSet.Name);
    }

    Catalog catalog = new Catalog();
    catalog.canAssign = Schema.SObjectType.PermissionSetAssignment.isCreateable();
    catalog.isAdmin = OrgIntelAccess.isAdmin();
    catalog.installBaseUrl =
      URL.getOrgDomainUrl().toExternalForm() +
      '/packaging/installPackage.apexp?p0=';
    for (String key : ADMIN_PERMISSION_SETS.keySet()) {
      String permissionSet = ADMIN_PERMISSION_SETS.get(key);
      CatalogEntry entry = new CatalogEntry();
      entry.key = key;
      if (key == CORE) {
        entry.installed = true;
        entry.accessible = OrgIntelAccess.canRead();
      } else {
        OrgIntelModule module = OrgIntelModules.get(key);
        entry.installed = module != null;
        entry.accessible = module != null && module.isAccessible();
      }
      entry.permissionSet = permissionSet;
      entry.permissionSetFound = existing.contains(permissionSet);
      entry.assigned = assigned.contains(permissionSet);
      catalog.modules.add(entry);
    }
    return catalog;
  }

  /**
   * Attribue à l'utilisateur courant le permission set d'administration du socle ou d'un module
   * installé. Insertion en USER_MODE : seul un utilisateur autorisé à attribuer des permission sets
   * (« Assign Permission Sets ») peut le faire, comme depuis Setup — pas d'élévation de droits.
   */
  @AuraEnabled
  public static void grantModuleAccess(String key) {
    String name = ADMIN_PERMISSION_SETS.get(key);
    if (name == null) {
      throw OrgIntelAccess.error('Unknown module: ' + key);
    }
    if (key != CORE && !OrgIntelModules.isInstalled(key)) {
      throw OrgIntelAccess.error(
        'The ' +
          OrgIntelModules.LABELS.get(key) +
          ' module is not installed in this org.'
      );
    }
    String namespace = OrgIntelNamespace.namespaceFilter();
    List<PermissionSet> permissionSets = [
      SELECT Id
      FROM PermissionSet
      WHERE Name = :name AND NamespacePrefix = :namespace
      LIMIT 1
    ];
    if (permissionSets.isEmpty()) {
      throw OrgIntelAccess.error(
        'The permission set ' + name + ' was not found in this org.'
      );
    }
    Id userId = UserInfo.getUserId();
    Id permissionSetId = permissionSets[0].Id;
    Integer existing = [
      SELECT COUNT()
      FROM PermissionSetAssignment
      WHERE AssigneeId = :userId AND PermissionSetId = :permissionSetId
    ];
    if (existing > 0) {
      return;
    }
    try {
      Database.insert(
        new PermissionSetAssignment(
          AssigneeId = userId,
          PermissionSetId = permissionSetId
        ),
        AccessLevel.USER_MODE
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error(
        'The permission set ' + name + ' could not be assigned',
        e
      );
    }
  }

  public class ModuleInfo {
    @AuraEnabled
    public String key;
    @AuraEnabled
    public String label;
  }

  public class Catalog {
    /** L'utilisateur peut s'attribuer les permission sets (sinon : demander à un administrateur). */
    @AuraEnabled
    public Boolean canAssign;
    /**
     * Administrateur Org Intelligence (custom permission), par permission set ou par profil : une
     * installation « admins seulement » l'accorde au profil Administrateur système.
     */
    @AuraEnabled
    public Boolean isAdmin;
    /** Page d'installation d'un package dans cette org, à compléter par l'identifiant 04t. */
    @AuraEnabled
    public String installBaseUrl;
    @AuraEnabled
    public List<CatalogEntry> modules = new List<CatalogEntry>();
  }

  public class CatalogEntry {
    @AuraEnabled
    public String key;
    @AuraEnabled
    public Boolean installed;
    @AuraEnabled
    public Boolean accessible;
    @AuraEnabled
    public String permissionSet;
    @AuraEnabled
    public Boolean permissionSetFound;
    @AuraEnabled
    public Boolean assigned;
  }
}
