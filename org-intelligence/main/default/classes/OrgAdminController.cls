/**
 * Point d'entrée Apex de la section Settings (réservée aux administrateurs). Les réglages propres à
 * un module (Jira, alertes API) sont servis par le module, via OrgIntelModuleController.
 */
public with sharing class OrgAdminController {
  @AuraEnabled
  public static OrgSettingsService.SettingsView getSettings() {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgSettingsService.getSettings();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The settings could not be loaded', e);
    }
  }

  @AuraEnabled
  public static Id updateRule(
    String code,
    Boolean enabled,
    String severity,
    Decimal threshold
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgSettingsService.updateRule(code, enabled, severity, threshold);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The rule could not be saved', e);
    }
  }

  @AuraEnabled
  public static Id updateRetention(Integer apiLogDays, Boolean logPayloads) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgSettingsService.updateRetention(apiLogDays, logPayloads);
    } catch (Exception e) {
      throw OrgIntelAccess.error(
        'The retention settings could not be saved',
        e
      );
    }
  }

  @AuraEnabled
  public static Id updateScoreSettings(String scoreJson) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgSettingsService.updateScore(scoreJson);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The score settings could not be saved', e);
    }
  }

  @AuraEnabled
  public static OrgMaintenanceService.Result runMaintenance() {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgMaintenanceService.purge();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The maintenance could not run', e);
    }
  }

  // Désinstallation complète (Settings › Uninstall) : outil hors package OrgIntelUninstallTool
  // (dossier source-tools/), appelé par OrgIntelModuleController.invoke('uninstall', ...).
}
