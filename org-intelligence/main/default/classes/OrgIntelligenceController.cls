/**
 * Point d'entrée Apex des écrans Org Intelligence (LWC orgIntelApp et ses sections).
 *
 * Contrôleur mince : vérifie les droits, délègue aux services et traduit les erreurs en messages
 * lisibles, sans exposer de détail technique sensible.
 */
public with sharing class OrgIntelligenceController {
  @AuraEnabled
  public static OrgOverviewService.Overview getOverview() {
    assertCanRead();
    try {
      return OrgOverviewService.build();
    } catch (Exception e) {
      throw auraException(
        'The overview could not be loaded: ' + e.getMessage()
      );
    }
  }

  // ---------- Org Scanner (piloté par le navigateur) ----------

  /** État de la connexion Tooling et droit de lancer un scan. */
  @AuraEnabled
  public static ScannerState getScannerState() {
    assertCanRead();
    try {
      ScannerState state = new ScannerState();
      state.canRunScan = canRunScan();
      // Le test de connexion fait un appel HTTP : réservé à qui peut lancer un scan
      state.tooling = state.canRunScan
        ? OrgToolingGateway.getInstance().checkConnection()
        : null;
      OrgApiLogger.flush();
      return state;
    } catch (Exception e) {
      throw auraException('The scanner could not be loaded: ' + e.getMessage());
    }
  }

  /** Démarre un scan : état initial et référentiels (JSON), rien n'est écrit dans l'org. */
  @AuraEnabled
  public static String startScan(List<String> scope) {
    assertCanRun();
    try {
      return JSON.serialize(OrgScanRunner.start(scope));
    } catch (Exception e) {
      throw auraException('The scan could not be started: ' + e.getMessage());
    }
  }

  /** Exécute une page d'étape du scan et renvoie ses résultats (JSON). */
  @AuraEnabled
  public static String runScanStep(String stateJson, String inventoryJson) {
    assertCanRun();
    try {
      return JSON.serialize(OrgScanRunner.runStep(stateJson, inventoryJson));
    } catch (Exception e) {
      throw auraException('The scan step failed: ' + e.getMessage());
    }
  }

  /** Catalogue des règles (gravité, catégorie, domaine), pour l'affichage des scans gardés. */
  @AuraEnabled
  public static String getRuleCatalog() {
    assertCanRead();
    try {
      return JSON.serialize(
        new Map<String, Object>{
          'rules' => OrgScanRunner.ruleCatalog(),
          'scoreConfig' => OrgHealthScore.config()
        }
      );
    } catch (Exception e) {
      throw auraException('The rules could not be loaded: ' + e.getMessage());
    }
  }

  /**
   * Identité de l'org, écrite dans l'enveloppe des fichiers exportés pour avertir à l'import
   * quand un fichier vient d'une autre org (production importée dans une sandbox…).
   */
  @AuraEnabled(cacheable=true)
  public static Map<String, Object> getOrgInfo() {
    assertCanRead();
    try {
      Organization org = [
        SELECT Id, Name, IsSandbox
        FROM Organization
        LIMIT 1
      ];
      return new Map<String, Object>{
        'orgId' => org.Id,
        'orgName' => org.Name,
        'isSandbox' => org.IsSandbox
      };
    } catch (Exception e) {
      throw auraException(
        'The organization details could not be loaded: ' + e.getMessage()
      );
    }
  }

  // ---------- Automation ----------

  @AuraEnabled
  public static OrgAutomationService.AutomationView getAutomationView() {
    assertCanRead();
    try {
      return OrgAutomationService.getView();
    } catch (Exception e) {
      throw auraException(
        'The automation view could not be loaded: ' + e.getMessage()
      );
    }
  }

  @AuraEnabled
  public static OrgStorageService.StorageView getStorageView() {
    assertCanRead();
    try {
      return OrgStorageService.getView();
    } catch (Exception e) {
      throw auraException(
        'The storage view could not be loaded: ' + e.getMessage()
      );
    }
  }

  // ---------- Reports et activité ----------

  @AuraEnabled
  public static OrgReportsService.ReportsView getReportsView() {
    assertCanRead();
    try {
      return OrgReportsService.getView();
    } catch (Exception e) {
      throw auraException('The reports could not be loaded: ' + e.getMessage());
    }
  }

  public class ScannerState {
    @AuraEnabled
    public Boolean canRunScan;
    @AuraEnabled
    public OrgToolingGateway.Status tooling;
  }

  private static Boolean canRunScan() {
    return FeatureManagement.checkPermission(
      OrgIntelligenceConstants.ADMIN_PERMISSION
    );
  }

  @TestVisible
  private static void assertCanRead() {
    OrgIntelAccess.assertCanRead();
  }

  private static void assertCanRun() {
    assertCanRead();
    if (!canRunScan()) {
      throw auraException(
        'Only Org Intelligence administrators can run a scan ("Org Intelligence - Admin" permission set).'
      );
    }
  }

  private static AuraHandledException auraException(String message) {
    AuraHandledException e = new AuraHandledException(message);
    e.setMessage(message);
    return e;
  }
}
