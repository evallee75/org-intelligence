/**
 * Classe de base d'un module optionnel Org Intelligence (Recommendations, Context Hub, API
 * Monitoring, Field Usage, Adoption, Security, Inventory).
 *
 * Le socle ne référence jamais les objets ni les classes d'un module : il les découvre à l'exécution
 * par leur nom (OrgIntelModules, Type.forName). Un module absent de l'org est simplement ignoré, ce
 * qui permet d'installer le socle seul puis uniquement les modules voulus.
 *
 * Chaque module fournit une classe concrète (ex. OrgIntelRecommendationsModule) qui :
 * - répond aux appels de ses écrans (invoke : action + paramètres JSON, renvoie un objet sérialisé
 *   en JSON par OrgIntelModuleController) ;
 * - participe, si besoin, à la maintenance (purge) et aux volumes affichés dans Settings.
 *
 * Les écrans (LWC) des modules sont livrés avec le socle : sans le module, la section est masquée.
 *
 * Package géré : chaque module est un package distinct du même namespace ; la classe et tous ses
 * membres publics / protégés portent donc @NamespaceAccessible (jamais global).
 */
@NamespaceAccessible
public abstract inherited sharing class OrgIntelModule {
  /** Clé du module (OrgIntelModules.RECOMMENDATIONS, ...). */
  @NamespaceAccessible
  public abstract String key();

  /**
   * Traite une action demandée par un écran. Lever OrgIntelAccess.error(...) pour un message
   * lisible ; une action inconnue lève IllegalArgumentException.
   */
  @NamespaceAccessible
  public abstract Object invoke(String action, Map<String, Object> params);

  /**
   * L'utilisateur courant a accès au module (permission set du module assigné). Sinon la section est
   * masquée et le socle fait comme si le module n'était pas installé.
   */
  @NamespaceAccessible
  public virtual Boolean isAccessible() {
    return true;
  }

  /** Volumes affichés dans Settings › Data (libellé → nombre d'enregistrements). */
  @NamespaceAccessible
  public virtual Map<String, Integer> recordCounts() {
    return new Map<String, Integer>();
  }

  /** Application des durées de conservation du module (maintenance quotidienne et fin de scan). */
  @NamespaceAccessible
  public virtual void purge(OrgMaintenanceService.Result result) {
    return;
  }

  // ---------- Lecture des paramètres envoyés par les écrans ----------

  @NamespaceAccessible
  protected String text(Map<String, Object> params, String name) {
    Object value = params.get(name);
    return value == null ? null : String.valueOf(value);
  }

  @NamespaceAccessible
  protected Id recordId(Map<String, Object> params, String name) {
    String value = text(params, name);
    return String.isBlank(value) ? null : (Id) value;
  }

  @NamespaceAccessible
  protected Integer integerValue(Map<String, Object> params, String name) {
    Object value = params.get(name);
    if (value == null) {
      return null;
    }
    return value instanceof Integer
      ? (Integer) value
      : Decimal.valueOf(String.valueOf(value)).intValue();
  }

  @NamespaceAccessible
  protected Decimal decimalValue(Map<String, Object> params, String name) {
    Object value = params.get(name);
    return value == null ? null : Decimal.valueOf(String.valueOf(value));
  }

  @NamespaceAccessible
  protected Boolean booleanValue(Map<String, Object> params, String name) {
    Object value = params.get(name);
    return value == null ? null : Boolean.valueOf(value);
  }

  @NamespaceAccessible
  protected List<String> textList(Map<String, Object> params, String name) {
    List<String> values = new List<String>();
    Object value = params.get(name);
    if (value instanceof List<Object>) {
      for (Object item : (List<Object>) value) {
        values.add(item == null ? null : String.valueOf(item));
      }
    }
    return values;
  }

  @NamespaceAccessible
  protected List<Id> idList(Map<String, Object> params, String name) {
    List<Id> values = new List<Id>();
    for (String value : textList(params, name)) {
      if (String.isNotBlank(value)) {
        values.add((Id) value);
      }
    }
    return values;
  }

  @NamespaceAccessible
  protected IllegalArgumentException unknownAction(String action) {
    return new IllegalArgumentException(
      'Unknown action "' + action + '" for module ' + key()
    );
  }
}
