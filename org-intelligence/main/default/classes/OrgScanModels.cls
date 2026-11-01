/**
 * Structures manipulées par le scanner, entre la collecte, les règles et le résultat renvoyé au navigateur.
 */
public inherited sharing class OrgScanModels {
  /** Composant découvert. `source` (code, formule) sert aux règles et n'est jamais stocké. */
  public class Component {
    public String componentType;
    public String apiName;
    public String parentName;
    public String metadataId;
    public String namespacePrefix;
    public Decimal apiVersion;
    public Boolean isActive = true;
    public String description;
    public Datetime lastModifiedDate;
    public String lastModifiedByName;
    public Map<String, Object> details = new Map<String, Object>();
    public transient String source;

    public Component(String componentType, String apiName) {
      this.componentType = componentType;
      this.apiName = apiName;
    }

    public String key() {
      return buildKey(componentType, apiName);
    }
  }

  /** Constat produit par une règle sur un composant. */
  public class Finding {
    public String ruleCode;
    public String componentType;
    public String componentName;
    public String componentKey;
    public String title;
    public String description;
    public String evidence;
    public List<String> affectedComponents = new List<String>();

    public String fingerprint() {
      return (ruleCode + '|' + componentKey).abbreviate(255);
    }
  }

  /** Entrée du journal de collecte, affichée telle quelle dans l'application. */
  public class LogEntry {
    public String step;
    public String level;
    public String message;
    public Datetime loggedAt;

    public LogEntry() {
    }

    public LogEntry(String step, String level, String message) {
      this.step = step;
      this.level = level;
      this.message = message;
      this.loggedAt = Datetime.now();
    }
  }

  public static final String LEVEL_INFO = 'info';
  public static final String LEVEL_WARNING = 'warning';
  public static final String LEVEL_ERROR = 'error';

  public static String buildKey(String componentType, String apiName) {
    return (componentType + ':' + apiName).abbreviate(255);
  }
}
