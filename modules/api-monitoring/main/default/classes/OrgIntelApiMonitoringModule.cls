/**
 * Entrée du module API Monitoring : découverte par le socle (OrgIntelModules), elle sert les écrans
 * (journal des appels, consommation de l'org, alertes), enregistre le journal tenu par OrgApiLogger
 * (interface Sink) et purge les entrées au-delà de la durée de conservation.
 */
@NamespaceAccessible
public inherited sharing class OrgIntelApiMonitoringModule extends OrgIntelModule implements OrgApiLogger.Sink {
  // Partage hérité de l'appelant : les actions des écrans sont contrôlées (administrateurs,
  // USER_MODE) par OrgApiMonitorController. Seules l'écriture du journal et sa purge passent par
  // la classe interne SystemLog, sans partage (cf. sa justification).

  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.API_MONITORING;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return Schema.SObjectType.OrgApiLog__c.isAccessible();
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'getApiLogs' {
        return OrgApiMonitorController.getApiLogs(integerValue(params, 'days'));
      }
      when 'getApiLog' {
        return OrgApiMonitorController.getApiLog(recordId(params, 'logId'));
      }
      when 'getOrgApiUsage' {
        return OrgApiMonitorController.getOrgApiUsage(
          integerValue(params, 'days')
        );
      }
      when 'getApiAlerts' {
        return OrgApiMonitorController.getApiAlerts();
      }
      when 'previewApiAlertRule' {
        return OrgApiMonitorController.previewApiAlertRule(
          text(params, 'ruleJson')
        );
      }
      when 'saveApiAlertRule' {
        return OrgApiMonitorController.saveApiAlertRule(
          text(params, 'ruleJson')
        );
      }
      when 'setApiAlertRuleActive' {
        OrgApiMonitorController.setApiAlertRuleActive(
          recordId(params, 'ruleId'),
          booleanValue(params, 'active')
        );
        return null;
      }
      when 'deleteApiAlertRule' {
        OrgApiMonitorController.deleteApiAlertRule(recordId(params, 'ruleId'));
        return null;
      }
      when 'checkApiAlerts' {
        return OrgApiMonitorController.checkApiAlerts(
          recordId(params, 'ruleId')
        );
      }
      when 'sendApiAlertTest' {
        return OrgApiMonitorController.sendApiAlertTest(
          recordId(params, 'ruleId')
        );
      }
      when 'setApiAlertStatus' {
        OrgApiMonitorController.setApiAlertStatus(
          idList(params, 'alertIds'),
          text(params, 'status')
        );
        return null;
      }
      when 'scheduleApiAlerts' {
        return OrgApiMonitorController.scheduleApiAlerts(
          integerValue(params, 'frequencyMinutes')
        );
      }
      when 'getApiErrorTypes' {
        return OrgApiMonitorController.getApiErrorTypes(
          integerValue(params, 'days')
        );
      }
      when 'suggestApiAlertFromLog' {
        return OrgApiMonitorController.suggestApiAlertFromLog(
          recordId(params, 'logId')
        );
      }
    }
    throw unknownAction(action);
  }

  @NamespaceAccessible
  public override Map<String, Integer> recordCounts() {
    return new Map<String, Integer>{
      'API log entries' => [SELECT COUNT() FROM OrgApiLog__c WITH USER_MODE],
      'API alert rules' => [
        SELECT COUNT()
        FROM OrgApiAlertRule__c
        WITH USER_MODE
      ]
    };
  }

  @NamespaceAccessible
  public override void purge(OrgMaintenanceService.Result result) {
    result.addDeleted(
      new SystemLog()
        .deleteExpired(
          Datetime.now().addDays(-result.retentionDays()),
          OrgMaintenanceService.MAX_DELETED
        )
    );
  }

  // ---------- OrgApiLogger.Sink ----------

  @NamespaceAccessible
  public void save(List<OrgApiLogger.Entry> entries) {
    Boolean keepPayloads = payloadsEnabled();
    List<OrgApiLog__c> records = new List<OrgApiLog__c>();
    for (OrgApiLogger.Entry entry : entries) {
      records.add(toRecord(entry, keepPayloads));
    }
    new SystemLog().insertEntries(records);
  }

  /**
   * Seul accès sans partage du module, volontairement réduit à deux opérations sur OrgApiLog__c :
   * - écriture : le journal est tenu pour toute intégration (OrgApiLogger), quel que soit
   *   l'utilisateur qui déclenche l'appel, y compris un utilisateur sans droit sur l'objet ;
   * - purge : la durée de conservation s'applique à toutes les entrées, quel que soit leur
   *   propriétaire (OWD en lecture seule : un administrateur ne pourrait pas supprimer celles des
   *   autres).
   * Aucune donnée n'est renvoyée à l'appelant (nombre d'entrées supprimées seulement).
   */
  private without sharing class SystemLog {
    public void insertEntries(List<OrgApiLog__c> records) {
      Database.insert(records, false, AccessLevel.SYSTEM_MODE);
    }

    public Integer deleteExpired(Datetime logLimit, Integer size) {
      List<OrgApiLog__c> logs = [
        SELECT Id
        FROM OrgApiLog__c
        WHERE CalledAt__c < :logLimit
        WITH SYSTEM_MODE
        LIMIT :size
      ];
      Database.delete(logs, false, AccessLevel.SYSTEM_MODE);
      return logs.size();
    }
  }

  private static OrgApiLog__c toRecord(
    OrgApiLogger.Entry entry,
    Boolean keepPayloads
  ) {
    Integer maxBody = OrgApiLogger.MAX_BODY;
    Boolean success = entry.success != null
      ? entry.success
      : entry.statusCode != null &&
        entry.statusCode >= 200 &&
        entry.statusCode < 300;
    return new OrgApiLog__c(
      System__c = entry.systemName?.abbreviate(80),
      Direction__c = entry.direction,
      Operation__c = entry.operation?.abbreviate(255),
      Method__c = entry.method?.abbreviate(10),
      Endpoint__c = OrgApiLogger.redact(entry.endpoint)?.abbreviate(255),
      StatusCode__c = entry.statusCode,
      Success__c = success,
      DurationMs__c = entry.durationMs,
      CalledAt__c = entry.calledAt,
      RequestBody__c = keepPayloads
        ? OrgApiLogger.redact(entry.requestBody?.abbreviate(maxBody))
        : null,
      ResponseBody__c = keepPayloads
        ? OrgApiLogger.redact(entry.responseBody?.abbreviate(maxBody))
        : null,
      ErrorMessage__c = OrgApiLogger.redact(
        entry.errorMessage?.abbreviate(maxBody)
      ),
      RelatedRecordId__c = entry.relatedRecordId?.left(18)
    );
  }

  private static Boolean payloadsEnabled() {
    return OrgIntelSettings.logApiPayloads();
  }
}
