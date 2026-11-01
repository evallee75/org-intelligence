/**
 * Maintenance Org Intelligence : application des durées de conservation des modules qui stockent
 * des données (journal API). Lancée par le contrôle planifié des alertes API (OrgApiAlertJob) ou à
 * la demande depuis Settings. Chaque module purge ses propres données (OrgIntelModule.purge) ; le
 * socle ne stocke rien.
 */
@NamespaceAccessible
public inherited sharing class OrgMaintenanceService {
  /** Plafond de suppressions par objet et par exécution (limite de 10 000 lignes DML). */
  @NamespaceAccessible
  public static final Integer MAX_DELETED = 9000;

  @NamespaceAccessible
  public class Result {
    @AuraEnabled
    public Integer apiLogsDeleted = 0;
    @AuraEnabled
    public Integer apiLogRetentionDays;

    /** Durée de conservation du journal API (jours), pour les modules (champs @AuraEnabled non accessibles). */
    @NamespaceAccessible
    public Integer retentionDays() {
      return apiLogRetentionDays;
    }

    /** Ajoute des entrées supprimées au bilan, pour les modules. */
    @NamespaceAccessible
    public void addDeleted(Integer count) {
      apiLogsDeleted += count == null ? 0 : count;
    }
  }

  @NamespaceAccessible
  public static Result purge() {
    Result result = new Result();
    result.apiLogRetentionDays = OrgIntelSettings.apiLogRetentionDays();
    for (OrgIntelModule module : OrgIntelModules.installed()) {
      module.purge(result);
    }
    return result;
  }
}
