/**
 * Actions de la section API Monitoring (journal des appels, consommation, alertes), appelées par les
 * écrans via OrgIntelModuleController → OrgIntelApiMonitoringModule. Réservées aux administrateurs.
 */
public with sharing class OrgApiMonitorController {
  public static OrgApiMonitorService.LogPage getApiLogs(Integer days) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiMonitorService.getLogs(days);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The API log could not be loaded', e);
    }
  }

  public static OrgApiMonitorService.LogDetail getApiLog(Id logId) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiMonitorService.getLog(logId);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The API call could not be loaded', e);
    }
  }

  public static OrgApiMonitorService.OrgUsage getOrgApiUsage(Integer days) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiMonitorService.getOrgUsage(days);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The API usage could not be loaded', e);
    }
  }

  // ---------- Alertes API ----------

  public static OrgApiAlertService.AlertsView getApiAlerts() {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.getView();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The API alerts could not be loaded', e);
    }
  }

  public static OrgApiAlertService.Simulation previewApiAlertRule(
    String ruleJson
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.preview(parseRule(ruleJson));
    } catch (Exception e) {
      throw OrgIntelAccess.error('The preview could not be computed', e);
    }
  }

  public static Id saveApiAlertRule(String ruleJson) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.saveRule(parseRule(ruleJson));
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert rule could not be saved', e);
    }
  }

  public static void setApiAlertRuleActive(Id ruleId, Boolean active) {
    OrgIntelAccess.assertAdmin();
    try {
      OrgApiAlertService.setActive(ruleId, active);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert rule could not be changed', e);
    }
  }

  public static void deleteApiAlertRule(Id ruleId) {
    OrgIntelAccess.assertAdmin();
    try {
      OrgApiAlertService.deleteRule(ruleId);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert rule could not be deleted', e);
    }
  }

  /** Contrôle immédiat : une règle, ou toutes les règles actives si ruleId est vide. */
  public static OrgApiAlertService.CheckResult checkApiAlerts(Id ruleId) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.evaluate(ruleId, AccessLevel.USER_MODE);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert check could not run', e);
    }
  }

  public static List<String> sendApiAlertTest(Id ruleId) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.sendTest(ruleId);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The test notification could not be sent', e);
    }
  }

  public static void setApiAlertStatus(List<Id> alertIds, String status) {
    OrgIntelAccess.assertAdmin();
    try {
      OrgApiAlertService.setEventStatus(alertIds, status);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert could not be updated', e);
    }
  }

  /** Planification du contrôle : 0 = arrêt, 15 ou 60 minutes. */
  public static OrgApiAlertService.Schedule scheduleApiAlerts(
    Integer frequencyMinutes
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      if (frequencyMinutes == null || frequencyMinutes <= 0) {
        OrgApiAlertService.unschedule();
        return OrgApiAlertService.getSchedule();
      }
      return OrgApiAlertService.schedule(frequencyMinutes == 15 ? 15 : 60);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert schedule could not be changed', e);
    }
  }

  public static OrgApiAlertService.ErrorTypesView getApiErrorTypes(
    Integer days
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.getErrorTypes(days);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The error types could not be loaded', e);
    }
  }

  public static OrgApiAlertService.RuleSpec suggestApiAlertFromLog(Id logId) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgApiAlertService.suggestFromLog(logId);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The alert could not be prepared', e);
    }
  }

  private static OrgApiAlertService.RuleSpec parseRule(String ruleJson) {
    if (String.isBlank(ruleJson)) {
      throw new IllegalArgumentException('The rule is empty.');
    }
    return (OrgApiAlertService.RuleSpec) JSON.deserialize(
      ruleJson,
      OrgApiAlertService.RuleSpec.class
    );
  }
}
