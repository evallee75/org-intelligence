/**
 * Audit de sécurité : exécution (OrgSecurityChecks), score et note. Édition sans objet : rien n'est
 * écrit dans l'org, le navigateur garde le dernier audit, l'historique des résumés, construit le
 * rapport imprimable et les recommandations.
 */
public inherited sharing class OrgSecurityService {
  /** Points retirés par contrôle en échec (un avertissement compte pour moitié). */
  private static final Map<String, Integer> PENALTIES = new Map<String, Integer>{
    OrgSecurityChecks.CRITICAL => 20,
    OrgSecurityChecks.HIGH => 10,
    OrgSecurityChecks.MEDIUM => 5,
    OrgSecurityChecks.LOW => 2
  };

  /** Résultat complet d'un audit (renvoyé au navigateur, qui le garde en cache). */
  public class Audit {
    public Datetime generatedAt;
    public String orgName;
    public String orgId;
    public String edition;
    public Boolean isSandbox;
    public String runBy;
    public Integer activeUsers;
    public Integer score;
    public String grade;
    public Map<String, Integer> failedBySeverity = new Map<String, Integer>();
    public Integer warnings = 0;
    public Integer passed = 0;
    public Integer notEvaluated = 0;
    public Decimal healthCheckScore;
    public Long durationMs;
    public List<OrgSecurityChecks.Check> checks = new List<OrgSecurityChecks.Check>();
  }

  // ---------- Audit ----------

  /** Exécute l'audit et renvoie le résultat complet, sans rien écrire (gardé dans le navigateur). */
  public static Audit run() {
    Long started = System.currentTimeMillis();
    Audit audit = new Audit();
    audit.generatedAt = Datetime.now();
    audit.runBy = UserInfo.getName();
    Organization org = [
      SELECT Id, Name, OrganizationType, IsSandbox
      FROM Organization
      LIMIT 1
    ];
    audit.orgName = org.Name;
    audit.orgId = org.Id;
    audit.edition = org.OrganizationType;
    audit.isSandbox = org.IsSandbox;

    OrgSecurityChecks engine = new OrgSecurityChecks(org.IsSandbox);
    engine.loadHealthCheck(); // callouts Tooling avant toute écriture
    audit.checks = engine.run();
    audit.healthCheckScore = engine.healthCheck?.score;
    audit.activeUsers = engine.activeUsers;
    summarise(audit);
    audit.durationMs = System.currentTimeMillis() - started;
    OrgApiLogger.flush();
    return audit;
  }

  @TestVisible
  private static void summarise(Audit audit) {
    for (String severity : PENALTIES.keySet()) {
      audit.failedBySeverity.put(severity, 0);
    }
    Decimal score = 100;
    for (OrgSecurityChecks.Check check : audit.checks) {
      Integer penalty = PENALTIES.containsKey(check.severity)
        ? PENALTIES.get(check.severity)
        : 0;
      if (check.status == OrgSecurityChecks.FAIL) {
        audit.failedBySeverity.put(
          check.severity,
          audit.failedBySeverity.get(check.severity) + 1
        );
        score -= penalty;
      } else if (check.status == OrgSecurityChecks.WARNING) {
        audit.warnings++;
        score -= penalty / 2.0;
      } else if (check.status == OrgSecurityChecks.PASS) {
        audit.passed++;
      } else if (check.status == OrgSecurityChecks.NOT_EVALUATED) {
        audit.notEvaluated++;
      }
    }
    audit.score = Math.max(
      0,
      score.round(System.RoundingMode.HALF_UP).intValue()
    );
    audit.grade = grade(audit.score);
  }

  public static String grade(Integer score) {
    if (score == null) {
      return null;
    }
    return score >= 90
      ? 'A'
      : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
  }
}
