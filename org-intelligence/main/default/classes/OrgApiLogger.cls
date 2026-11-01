/**
 * Journal des appels API, réutilisable par toute intégration de l'org.
 *
 * Usage sortant (callout) : construire une Entry, puis `log(entry)` ; les entrées sont gardées en
 * mémoire et écrites par `flush()`, à appeler APRÈS le dernier callout de la transaction (une écriture
 * avant un callout le ferait échouer). Usage entrant (@RestResource) : `logNow(entry)`.
 *
 * L'écriture (OrgApiLog__c) est faite par le module API Monitoring (interface Sink) : sans ce module,
 * les entrées sont simplement ignorées et l'appel métier n'est jamais bloqué. Les secrets (jetons,
 * mots de passe, en-têtes d'autorisation, clés d'API) sont masqués par `redact` avant tout
 * enregistrement.
 */
@NamespaceAccessible
public without sharing class OrgApiLogger {
  // without sharing : le journal doit pouvoir être écrit par toute intégration, quel que soit
  // l'utilisateur ; la lecture reste contrôlée par les permission sets du module API Monitoring.
  @NamespaceAccessible
  public static final Integer MAX_BODY = 32000;
  private static final List<Entry> BUFFER = new List<Entry>();
  private static final List<Pattern> SECRET_PATTERNS = new List<Pattern>{
    Pattern.compile(
      '(?i)("(?:access_token|refresh_token|token|password|passwd|secret|client_secret|api_?key|apikey|authorization|session_?id|sid)"\\s*:\\s*")[^"]*(")'
    ),
    Pattern.compile(
      '(?i)((?:access_token|refresh_token|token|password|secret|client_secret|api_?key|apikey|session_?id|sid)=)[^&\\s]+()'
    ),
    Pattern.compile('(?i)(Bearer\\s+)[A-Za-z0-9._!\\-]+()'),
    Pattern.compile('(00D[A-Za-z0-9]{12,15}!)[A-Za-z0-9._]+()')
  };

  @NamespaceAccessible
  public class Entry {
    @NamespaceAccessible
    public String systemName;
    @NamespaceAccessible
    public String direction = 'Outbound';
    @NamespaceAccessible
    public String operation;
    @NamespaceAccessible
    public String method;
    @NamespaceAccessible
    public String endpoint;
    @NamespaceAccessible
    public Integer statusCode;
    @NamespaceAccessible
    public Boolean success;
    @NamespaceAccessible
    public Long durationMs;
    @NamespaceAccessible
    public String requestBody;
    @NamespaceAccessible
    public String responseBody;
    @NamespaceAccessible
    public String errorMessage;
    @NamespaceAccessible
    public String relatedRecordId;
    @NamespaceAccessible
    public Datetime calledAt = Datetime.now();
  }

  /** Stockage des entrées : implémenté par le module API Monitoring. */
  @NamespaceAccessible
  public interface Sink {
    void save(List<Entry> entries);
  }

  @NamespaceAccessible
  public static void log(Entry entry) {
    BUFFER.add(entry);
  }

  @NamespaceAccessible
  public static void logNow(Entry entry) {
    log(entry);
    flush();
  }

  @NamespaceAccessible
  public static void flush() {
    if (BUFFER.isEmpty()) {
      return;
    }
    List<Entry> entries = new List<Entry>(BUFFER);
    BUFFER.clear();
    Sink sink = OrgIntelModules.apiLogSink();
    if (sink == null) {
      return; // module API Monitoring non installé : pas de journal
    }
    try {
      sink.save(entries);
    } catch (Exception e) {
      System.debug(
        LoggingLevel.WARN,
        'OrgApiLogger: log not saved (' + e.getTypeName() + ')'
      );
    }
  }

  @TestVisible
  private static Integer pendingCount() {
    return BUFFER.size();
  }

  @TestVisible
  private static final Integer REDACT_CHUNK = 4000;

  /**
   * Masque les secrets connus (JSON, paramètres d'URL, jetons Bearer, identifiants de session).
   *
   * Le moteur d'expressions régulières d'Apex a une limite non interceptable (« Regex too
   * complicated ») sur les longs textes : le masquage se fait par morceaux, coupés sur une virgule
   * ou un espace pour ne pas séparer une clé de sa valeur.
   */
  @NamespaceAccessible
  public static String redact(String value) {
    if (String.isBlank(value)) {
      return value;
    }
    List<String> parts = new List<String>();
    Integer start = 0;
    Integer length = value.length();
    while (start < length) {
      Integer stop = Math.min(start + REDACT_CHUNK, length);
      if (stop < length) {
        // Recherche bornée au morceau : sur un texte sans séparateur, lastIndexOf sur tout le
        // texte remonterait jusqu'au début à chaque morceau (coût quadratique)
        String window = value.substring(start, stop);
        Integer cut = Math.max(
          window.lastIndexOf(','),
          window.lastIndexOf(' ')
        );
        if (cut > 0) {
          stop = start + cut + 1;
        }
      }
      parts.add(redactChunk(value.substring(start, stop)));
      start = stop;
    }
    return String.join(parts, '');
  }

  private static String redactChunk(String chunk) {
    String result = chunk;
    for (Pattern secret : SECRET_PATTERNS) {
      result = secret.matcher(result).replaceAll('$1•••$2');
    }
    return result;
  }
}
