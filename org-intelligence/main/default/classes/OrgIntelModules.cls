/**
 * Registre des modules optionnels Org Intelligence.
 *
 * Un module est « installé » quand sa classe d'entrée existe dans l'org (Type.forName) : c'est le
 * cas après installation de son package (ou déploiement de son dossier modules/<module>). Le socle
 * ne passe que par ce registre pour parler à un module, sans référence statique : il compile et
 * fonctionne seul.
 *
 * Package géré : les classes d'entrée sont cherchées dans le namespace du package
 * (OrgIntelNamespace.typeFor) ; elles portent @NamespaceAccessible.
 *
 * « Outils » : classes présentes seulement après une installation depuis les sources (dossier
 * source-tools/, hors package), découvertes de la même façon mais absentes du menu et du
 * catalogue des modules (ex. désinstallation complète, OrgIntelUninstallTool).
 */
@NamespaceAccessible
public inherited sharing class OrgIntelModules {
  @NamespaceAccessible
  public static final String RECOMMENDATIONS = 'recommendations';
  @NamespaceAccessible
  public static final String CONTEXT_HUB = 'contextHub';
  @NamespaceAccessible
  public static final String API_MONITORING = 'apiMonitoring';
  @NamespaceAccessible
  public static final String FIELD_USAGE = 'fieldUsage';
  @NamespaceAccessible
  public static final String ADOPTION = 'adoption';
  @NamespaceAccessible
  public static final String SECURITY = 'security';
  @NamespaceAccessible
  public static final String INVENTORY = 'inventory';

  /** Clé du module → classe d'entrée (étend OrgIntelModule). L'ordre est celui de l'affichage. */
  @TestVisible
  private static final Map<String, String> ENTRY_CLASSES = new Map<String, String>{
    RECOMMENDATIONS => 'OrgIntelRecommendationsModule',
    CONTEXT_HUB => 'OrgIntelContextHubModule',
    API_MONITORING => 'OrgIntelApiMonitoringModule',
    FIELD_USAGE => 'OrgIntelFieldUsageModule',
    ADOPTION => 'OrgIntelAdoptionModule',
    SECURITY => 'OrgIntelSecurityModule',
    INVENTORY => 'OrgIntelInventoryModule'
  };

  /** Outil « installation depuis les sources » : désinstallation complète (Settings › Uninstall). */
  @NamespaceAccessible
  public static final String UNINSTALL = 'uninstall';

  /** Outils hors package (source-tools/) : clé → classe d'entrée (étend OrgIntelModule). */
  @TestVisible
  private static final Map<String, String> TOOL_CLASSES = new Map<String, String>{
    UNINSTALL => 'OrgIntelUninstallTool'
  };

  @NamespaceAccessible
  public static final Map<String, String> LABELS = new Map<String, String>{
    RECOMMENDATIONS => 'Recommendations',
    CONTEXT_HUB => 'Context Hub',
    API_MONITORING => 'API Monitoring',
    FIELD_USAGE => 'Field Usage',
    ADOPTION => 'Adoption',
    SECURITY => 'Security',
    INVENTORY => 'Inventory',
    UNINSTALL => 'Uninstall'
  };

  private static Map<String, OrgIntelModule> instances;

  /** Tests : remplace les modules découverts (clé → instance, null = absent). */
  @TestVisible
  private static Map<String, OrgIntelModule> overrides;

  /**
   * Tests de tous les paquets du namespace : remplace un module découvert (null = absent), par
   * exemple API Monitoring pour qu'aucune écriture du journal ne bloque les callouts suivants.
   * Refusé hors contexte de test.
   */
  @NamespaceAccessible
  public static void overrideForTests(String key, OrgIntelModule module) {
    if (!Test.isRunningTest()) {
      throw new IllegalArgumentException('Tests only');
    }
    if (overrides == null) {
      overrides = new Map<String, OrgIntelModule>();
    }
    overrides.put(key, module);
  }

  public static Boolean isInstalled(String key) {
    return get(key) != null;
  }

  /** Module installé, ou null s'il est absent de l'org. */
  public static OrgIntelModule get(String key) {
    if (overrides != null && overrides.containsKey(key)) {
      return overrides.get(key);
    }
    if (instances == null) {
      instances = new Map<String, OrgIntelModule>();
      Map<String, String> classes = new Map<String, String>(ENTRY_CLASSES);
      classes.putAll(TOOL_CLASSES);
      for (String moduleKey : classes.keySet()) {
        try {
          Type entry = OrgIntelNamespace.typeFor(classes.get(moduleKey));
          if (entry != null) {
            instances.put(moduleKey, (OrgIntelModule) entry.newInstance());
          }
        } catch (Exception e) {
          // Module présent mais invalide (version incompatible avec le socle) : ignoré
          System.debug(
            LoggingLevel.WARN,
            'Org Intelligence module ' +
              moduleKey +
              ' ignored: ' +
              e.getMessage()
          );
        }
      }
    }
    return instances.get(key);
  }

  /** Module installé ; sinon une erreur lisible pour l'écran. */
  public static OrgIntelModule require(String key) {
    OrgIntelModule module = ENTRY_CLASSES.containsKey(key) ||
      TOOL_CLASSES.containsKey(key)
      ? get(key)
      : null;
    if (module != null && !module.isAccessible()) {
      String label = LABELS.get(key);
      throw OrgIntelAccess.error(
        'You do not have access to the Org Intelligence ' +
          label +
          ' module. Ask your administrator for its permission set.'
      );
    }
    if (module == null) {
      String label = LABELS.containsKey(key) ? LABELS.get(key) : key;
      throw OrgIntelAccess.error(
        'The Org Intelligence ' +
          label +
          ' module is not installed in this org. Install it to use this feature.'
      );
    }
    return module;
  }

  /** Module installé et accessible à l'utilisateur courant, ou null. */
  public static OrgIntelModule available(String key) {
    OrgIntelModule module = get(key);
    return module != null && module.isAccessible() ? module : null;
  }

  /** Outils hors package présents et accessibles (clés), ex. désinstallation complète. */
  public static List<String> availableTools() {
    List<String> keys = new List<String>();
    for (String key : TOOL_CLASSES.keySet()) {
      if (available(key) != null) {
        keys.add(key);
      }
    }
    return keys;
  }

  /** Modules installés (hors outils), dans l'ordre d'affichage. */
  public static List<OrgIntelModule> installed() {
    List<OrgIntelModule> modules = new List<OrgIntelModule>();
    for (String key : ENTRY_CLASSES.keySet()) {
      OrgIntelModule module = get(key);
      if (module != null) {
        modules.add(module);
      }
    }
    return modules;
  }

  // ---------- Recommendations ----------

  /** Contrat du module Recommendations, ou null s'il n'est pas installé ou pas accessible. */
  public static OrgIntelRecommendationSource recommendations() {
    OrgIntelModule module = available(RECOMMENDATIONS);
    return module instanceof OrgIntelRecommendationSource
      ? (OrgIntelRecommendationSource) module
      : null;
  }

  // ---------- API Monitoring ----------

  /** Stockage du journal API, ou null sans le module API Monitoring (le journal est ignoré). */
  public static OrgApiLogger.Sink apiLogSink() {
    OrgIntelModule module = get(API_MONITORING);
    return module instanceof OrgApiLogger.Sink
      ? (OrgApiLogger.Sink) module
      : null;
  }
}
