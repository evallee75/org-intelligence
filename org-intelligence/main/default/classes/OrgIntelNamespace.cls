/**
 * Namespace du package Org Intelligence, détecté à l'exécution.
 *
 * Le même code tourne sans namespace (installation depuis les sources, packages non verrouillés)
 * et dans un package géré avec namespace (ex. « orgintel »). Le compilateur préfixe tout seul les
 * références statiques (OrgApiLog__c, Schema, imports LWC) ; cette classe sert aux noms cités dans
 * des chaînes : Type.forName des modules, Named Credentials (callout:), pages Visualforce, clés
 * JSON échangées avec les écrans.
 *
 * Convention des échanges avec les écrans : les clés JSON des champs du package sont toujours
 * SANS préfixe (« Title__c »). Les réponses sont nettoyées par stripKeys ; les paramètres sont lus
 * par le code Apex du package avec des noms sans préfixe (Map.get, SObject.put / get dynamiques,
 * describe), que la plateforme résout dans le namespace du code appelant.
 *
 * Détection sans requête : le nom d'une classe d'un package géré est « namespace.Classe ».
 */
@NamespaceAccessible
public inherited sharing class OrgIntelNamespace {
  private static String cachedPrefix;

  /** Tests : force un namespace (null = détection normale). */
  @TestVisible
  private static String prefixOverride;

  /** Namespace du package (« orgintel »), ou chaîne vide sans namespace. */
  @NamespaceAccessible
  public static String prefix() {
    if (prefixOverride != null) {
      return prefixOverride;
    }
    if (cachedPrefix == null) {
      String name = OrgIntelNamespace.class.getName();
      cachedPrefix = name.contains('.') ? name.substringBefore('.') : '';
    }
    return cachedPrefix;
  }

  /** Préfixe de nom d'API (« orgintel__ »), ou chaîne vide. */
  @NamespaceAccessible
  public static String apiPrefix() {
    String ns = prefix();
    return String.isBlank(ns) ? '' : ns + '__';
  }

  /** Préfixe des requêtes sur NamespacePrefix (null sans namespace : NamespacePrefix = null). */
  @NamespaceAccessible
  public static String namespaceFilter() {
    String ns = prefix();
    return String.isBlank(ns) ? null : ns;
  }

  /**
   * Nom d'API qualifié d'un composant du package : objet, champ, Named Credential, page Visualforce,
   * onglet... (« OrgApiLog__c » → « orgintel__OrgApiLog__c »). Un nom déjà préfixé ou vide est
   * renvoyé tel quel.
   */
  @NamespaceAccessible
  public static String qualify(String name) {
    if (String.isBlank(name) || String.isBlank(prefix())) {
      return name;
    }
    return isQualified(name) ? name : apiPrefix() + name;
  }

  /** Nom sans le préfixe du package (« orgintel__OrgApiLog__c » → « OrgApiLog__c »). */
  @NamespaceAccessible
  public static String unqualify(String name) {
    String prefix = apiPrefix();
    if (String.isBlank(name) || String.isBlank(prefix)) {
      return name;
    }
    return name.startsWithIgnoreCase(prefix)
      ? name.substring(prefix.length())
      : name;
  }

  /** Point de terminaison d'une Named Credential du package (« callout:orgintel__Nom »). */
  @NamespaceAccessible
  public static String callout(String namedCredential) {
    return 'callout:' + qualify(namedCredential);
  }

  /** Classe Apex du namespace du package, ou null si elle est absente de l'org. */
  @NamespaceAccessible
  public static Type typeFor(String className) {
    String ns = prefix();
    return String.isBlank(ns)
      ? Type.forName(className)
      : Type.forName(ns, className);
  }

  /**
   * Réponse JSON d'une action pour les écrans : retire le préfixe du package des clés
   * (« "orgintel__Title__c": » → « "Title__c": »), pour que les LWC lisent les mêmes noms de champs
   * avec et sans namespace. Les valeurs ne sont pas modifiées.
   */
  @NamespaceAccessible
  public static String stripKeys(String json) {
    String ns = prefix();
    if (json == null || String.isBlank(ns)) {
      return json;
    }
    return json.replaceAll(
      '"' + ns + '__(\\w+__(?:c|r|mdt|e|x))"(\\s*):',
      '"$1"$2:'
    );
  }

  // ---------- Interne ----------

  /** Nom déjà préfixé : « ns__Nom__c » (deux « __ ») ou « ns__Nom » d'un composant sans suffixe. */
  private static Boolean isQualified(String name) {
    String prefix = apiPrefix();
    if (name.startsWithIgnoreCase(prefix)) {
      return true;
    }
    String core = name.removeEnd('__c')
      .removeEnd('__r')
      .removeEnd('__mdt')
      .removeEnd('__e')
      .removeEnd('__x');
    return core.contains('__');
  }
}
