/**
 * Tests du module API Monitoring par sa classe d'entrée (invoke) : journal des appels,
 * consommation de l'org, règles et alertes (simulation, contrôle, livraison, planification),
 * écriture et purge du journal (Sink), contrôles d'accès.
 */
@IsTest
private class OrgIntelApiMonitoringModuleTest {
  private static final String ADMIN = 'apiadm';
  private static final String READER = 'apird';
  private static final String OUTSIDER = 'apiout';

  @TestSetup
  static void setup() {
    User admin = OrgApiMonitoringTestData.createUser(
      ADMIN,
      new List<String>{
        OrgApiMonitoringTestData.CORE_ADMIN,
        OrgApiMonitoringTestData.MODULE_ADMIN
      }
    );
    OrgApiMonitoringTestData.createUser(
      READER,
      new List<String>{
        OrgApiMonitoringTestData.CORE_USER,
        OrgApiMonitoringTestData.MODULE_ADMIN
      }
    );
    OrgApiMonitoringTestData.createUser(OUTSIDER, new List<String>());
    System.runAs(admin) {
      List<OrgApiLog__c> logs = new List<OrgApiLog__c>();
      for (Integer i = 0; i < 6; i++) {
        logs.add(
          OrgApiMonitoringTestData.log(
            'ERP',
            500,
            5 + i,
            'Timeout calling order 00123456' + i + ' for jane@acme.com'
          )
        );
      }
      logs.add(OrgApiMonitoringTestData.log('ERP', 200, 20, null));
      logs.add(OrgApiMonitoringTestData.log('ERP', 201, 30, null));
      logs.add(
        OrgApiMonitoringTestData.log('Payments', 401, 40, 'Invalid token')
      );
      logs.add(OrgApiMonitoringTestData.log('Payments', null, 50, null));
      logs.add(OrgApiMonitoringTestData.log(null, 200, 60 * 30, null));
      insert logs;
    }
  }

  private static OrgIntelApiMonitoringModule module() {
    return new OrgIntelApiMonitoringModule();
  }

  private static Object call(String action, Map<String, Object> params) {
    return module().invoke(action, params);
  }

  private static Map<String, Object> rule(
    String name,
    String metric,
    Decimal threshold,
    List<String> channels
  ) {
    return new Map<String, Object>{
      'name' => name,
      'active' => true,
      'metric' => metric,
      'comparator' => 'AtLeast',
      'threshold' => threshold,
      'windowMinutes' => 60,
      'systemName' => 'ERP',
      'severity' => 'High',
      'channels' => channels,
      'recipients' => 'ops@acme.com',
      'cooldownMinutes' => 60
    };
  }

  private static Id saveRule(Map<String, Object> spec) {
    return (Id) call(
      'saveApiAlertRule',
      new Map<String, Object>{ 'ruleJson' => JSON.serialize(spec) }
    );
  }

  @IsTest
  static void logAndUsage() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    Id logId = [
      SELECT Id
      FROM OrgApiLog__c
      WHERE System__c = 'Payments' AND StatusCode__c = 401
    ]
    .Id;
    System.runAs(admin) {
      Test.startTest();
      Assert.areEqual(OrgIntelModules.API_MONITORING, module().key());
      Assert.isTrue(module().isAccessible());
      OrgApiMonitorService.LogPage page = (OrgApiMonitorService.LogPage) call(
        'getApiLogs',
        new Map<String, Object>{ 'days' => 7 }
      );
      OrgApiMonitorService.LogPage defaultPage = (OrgApiMonitorService.LogPage) call(
        'getApiLogs',
        new Map<String, Object>()
      );
      OrgApiMonitorService.LogDetail detail = (OrgApiMonitorService.LogDetail) call(
        'getApiLog',
        new Map<String, Object>{ 'logId' => logId }
      );
      OrgApiMonitorService.OrgUsage usage = (OrgApiMonitorService.OrgUsage) call(
        'getOrgApiUsage',
        new Map<String, Object>{ 'days' => 30 }
      );
      Map<String, Integer> counts = module().recordCounts();
      Test.stopTest();
      Assert.areEqual(11, page.total);
      Assert.areEqual(3, page.successCount);
      Assert.areEqual(8, page.errorCount);
      Assert.areEqual(10, page.last24hCount);
      Assert.areEqual(3, page.systems.size());
      Assert.areEqual(11, page.rows.size());
      Assert.isFalse(page.truncated);
      Assert.areEqual(7, defaultPage.periodDays);
      Assert.areEqual('Invalid token', detail.row.errorMessage);
      Assert.areEqual('{"id":1}', detail.requestBody);
      Assert.isFalse(usage.limits.isEmpty());
      Assert.isNotNull(usage.loginHistoryAvailable);
      Assert.areEqual(11, counts.get('API log entries'));
      Assert.areEqual(0, counts.get('API alert rules'));
    }
  }

  @IsTest
  static void missingLogFails() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    OrgApiLog__c log = [SELECT Id FROM OrgApiLog__c LIMIT 1];
    System.runAs(admin) {
      delete log;
      for (
        String action : new List<String>{
          'getApiLog',
          'suggestApiAlertFromLog'
        }
      ) {
        try {
          call(action, new Map<String, Object>{ 'logId' => log.Id });
          Assert.fail(action + ' on a deleted log');
        } catch (AuraHandledException e) {
          Assert.isTrue(e.getMessage().contains('does not exist'));
        }
      }
    }
  }

  @IsTest
  static void rulesPreviewAndView() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    System.runAs(admin) {
      Test.startTest();
      Map<String, Object> errors = rule(
        'ERP errors',
        'Errors',
        3,
        new List<String>{ 'Task' }
      );
      errors.put('statusCodes', '5xx, 0');
      errors.put('errorContains', 'Timeout');
      errors.put('operationContains', 'order');
      OrgApiAlertService.Simulation preview = (OrgApiAlertService.Simulation) call(
        'previewApiAlertRule',
        new Map<String, Object>{ 'ruleJson' => JSON.serialize(errors) }
      );
      Id errorsId = saveRule(errors);
      // Autres métriques, dont la détection de silence (AtMost)
      Map<String, Object> silence = rule(
        'Silence',
        'Calls',
        0,
        new List<String>{ 'Task' }
      );
      silence.put('comparator', 'AtMost');
      saveRule(silence);
      saveRule(rule('Rate', 'ErrorRate', 50, new List<String>{ 'Task' }));
      saveRule(rule('Slow', 'SlowCalls', 1, new List<String>{ 'Task' }));
      Map<String, Object> duration = rule(
        'Duration',
        'AvgDuration',
        1000,
        new List<String>{ 'Task' }
      );
      duration.put('systemName', null);
      duration.put('description', 'Average duration');
      saveRule(duration);
      // Mise à jour d'une règle existante
      errors.put('id', errorsId);
      errors.put('threshold', 2);
      saveRule(errors);
      OrgApiAlertService.AlertsView view = (OrgApiAlertService.AlertsView) call(
        'getApiAlerts',
        new Map<String, Object>()
      );
      Test.stopTest();
      Assert.isTrue(preview.matchedErrors >= 6, 'Six ERP timeouts');
      Assert.isTrue(preview.fires >= 1);
      Assert.isTrue(preview.breachingNow);
      Assert.isFalse(preview.topErrors.isEmpty());
      Assert.areEqual(5, view.rules.size());
      Assert.isTrue(view.systems.contains('ERP'));
      for (OrgApiAlertService.RuleSpec spec : view.rules) {
        Assert.areEqual(24, spec.sparkline.size(), spec.name);
        if (spec.name == 'ERP errors') {
          Assert.areEqual(2, spec.threshold);
          Assert.isTrue(spec.breachingNow);
        }
      }
      Assert.isTrue(
        OrgApiAlertService.describe(view.rules[0]).startsWith('When ')
      );
    }
  }

  @IsTest
  static void invalidRulesAreRefused() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    System.runAs(admin) {
      Map<String, Object> invalid = new Map<String, Object>{
        'name' => '',
        'metric' => 'ErrorRate',
        'threshold' => 150,
        'windowMinutes' => 2,
        'channels' => new List<String>{ 'Email' },
        'recipients' => 'not-an-email',
        'statusCodes' => '9xx'
      };
      try {
        saveRule(invalid);
        Assert.fail('Invalid rule saved');
      } catch (AuraHandledException e) {
        String message = e.getMessage();
        Assert.isTrue(message.contains('name'), message);
        Assert.isTrue(message.contains('100%'), message);
        Assert.isTrue(message.contains('window'), message);
        Assert.isTrue(message.contains('recipient'), message);
        Assert.isTrue(message.contains('Invalid email'), message);
        Assert.isTrue(message.contains('9xx'), message);
      }
      try {
        saveRule(
          new Map<String, Object>{ 'name' => 'No channel', 'threshold' => -1 }
        );
        Assert.fail('Rule without channel saved');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('channel'), e.getMessage());
      }
      for (
        String action : new List<String>{
          'saveApiAlertRule',
          'previewApiAlertRule'
        }
      ) {
        try {
          call(action, new Map<String, Object>{ 'ruleJson' => '' });
          Assert.fail('Empty rule');
        } catch (AuraHandledException e) {
          Assert.isTrue(e.getMessage().contains('empty'), e.getMessage());
        }
      }
    }
  }

  @IsTest
  static void checkFiresAndDelivers() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    System.runAs(admin) {
      Map<String, Object> errors = rule(
        'ERP errors',
        'Errors',
        3,
        new List<String>{ 'Task', 'Email', 'Notification' }
      );
      errors.put('taskOwnerId', admin.Id);
      Id ruleId = saveRule(errors);
      Map<String, Object> quiet = rule(
        'Quiet',
        'Errors',
        100,
        new List<String>{ 'Task' }
      );
      Id quietId = saveRule(quiet);
      // Notification de test sur une règle « tâche » seule (l'e-mail dépend de l'org)
      Id taskOnlyId = saveRule(
        rule('Task only', 'Errors', 100, new List<String>{ 'Task' })
      );
      call(
        'setApiAlertRuleActive',
        new Map<String, Object>{ 'ruleId' => taskOnlyId, 'active' => false }
      );
      call(
        'setApiAlertRuleActive',
        new Map<String, Object>{ 'ruleId' => quietId, 'active' => false }
      );
      Test.startTest();
      OrgApiAlertService.CheckResult first = (OrgApiAlertService.CheckResult) call(
        'checkApiAlerts',
        new Map<String, Object>()
      );
      // Deuxième contrôle : délai de carence
      OrgApiAlertService.CheckResult second = (OrgApiAlertService.CheckResult) call(
        'checkApiAlerts',
        new Map<String, Object>{ 'ruleId' => ruleId }
      );
      List<String> sent = (List<String>) call(
        'sendApiAlertTest',
        new Map<String, Object>{ 'ruleId' => taskOnlyId }
      );
      Test.stopTest();
      Assert.areEqual(1, first.evaluated, 'Inactive rule skipped');
      Assert.areEqual(1, first.fired);
      Assert.areEqual(1, second.skippedCooldown);
      Assert.isTrue(sent.contains('Task'));
    }
    OrgApiAlertEvent__c event = [
      SELECT Status__c, Summary__c, TaskId__c, Channels__c, SampleLogIds__c
      FROM OrgApiAlertEvent__c
      LIMIT 1
    ];
    Assert.areEqual('Open', event.Status__c);
    Assert.isTrue(event.Summary__c.contains('Main error types'));
    Assert.isNotNull(event.TaskId__c);
    Assert.isTrue(event.Channels__c.contains('Task'));
    Assert.isNotNull(event.SampleLogIds__c);
    Assert.areEqual(
      1,
      [SELECT TriggerCount__c FROM OrgApiAlertRule__c WHERE Name = 'ERP errors']
      .TriggerCount__c
    );
  }

  @IsTest
  static void alertStatusesAndDeletion() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    System.runAs(admin) {
      Id ruleId = saveRule(
        rule('ERP errors', 'Errors', 1, new List<String>{ 'Task' })
      );
      OrgApiAlertEvent__c event = new OrgApiAlertEvent__c(
        Rule__c = ruleId,
        FiredAt__c = Datetime.now(),
        Status__c = 'Open',
        Summary__c = 'Test'
      );
      OrgApiAlertEvent__c old = new OrgApiAlertEvent__c(
        Rule__c = ruleId,
        FiredAt__c = Datetime.now().addDays(-120),
        Status__c = 'Resolved',
        Summary__c = 'Old'
      );
      insert new List<OrgApiAlertEvent__c>{ event, old };
      Test.startTest();
      call(
        'setApiAlertStatus',
        new Map<String, Object>{
          'alertIds' => new List<Object>{ event.Id },
          'status' => 'Acknowledged'
        }
      );
      OrgApiAlertEvent__c acknowledged = [
        SELECT AcknowledgedBy__c
        FROM OrgApiAlertEvent__c
        WHERE Id = :event.Id
      ];
      call(
        'setApiAlertStatus',
        new Map<String, Object>{
          'alertIds' => new List<Object>{ event.Id },
          'status' => 'Open'
        }
      );
      try {
        call(
          'setApiAlertStatus',
          new Map<String, Object>{
            'alertIds' => new List<Object>{ event.Id },
            'status' => 'Closed'
          }
        );
        Assert.fail('Unknown status');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('Unknown alert status'));
      }
      Integer purged = OrgApiAlertService.purgeOldEvents();
      call('deleteApiAlertRule', new Map<String, Object>{ 'ruleId' => ruleId });
      Test.stopTest();
      Assert.areEqual(admin.Id, acknowledged.AcknowledgedBy__c);
      Assert.areEqual(1, purged);
      Assert.areEqual(0, [SELECT COUNT() FROM OrgApiAlertRule__c]);
    }
  }

  @IsTest
  static void scheduleAndScheduledJob() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    System.runAs(admin) {
      saveRule(rule('ERP errors', 'Errors', 3, new List<String>{ 'Task' }));
      Test.startTest();
      OrgApiAlertService.Schedule quarter = (OrgApiAlertService.Schedule) call(
        'scheduleApiAlerts',
        new Map<String, Object>{ 'frequencyMinutes' => 15 }
      );
      OrgApiAlertService.Schedule hourly = (OrgApiAlertService.Schedule) call(
        'scheduleApiAlerts',
        new Map<String, Object>{ 'frequencyMinutes' => 60 }
      );
      OrgApiAlertService.Schedule off = (OrgApiAlertService.Schedule) call(
        'scheduleApiAlerts',
        new Map<String, Object>{ 'frequencyMinutes' => 0 }
      );
      // Exécution du contrôle planifié (mode système), purge comprise
      new OrgApiAlertJob().execute(null);
      Test.stopTest();
      Assert.isTrue(quarter.scheduled);
      Assert.areEqual(15, quarter.frequencyMinutes);
      Assert.areEqual(60, hourly.frequencyMinutes);
      Assert.isFalse(off.scheduled);
    }
    Assert.areEqual(1, [SELECT COUNT() FROM OrgApiAlertEvent__c]);
  }

  @IsTest
  static void errorTypesAndSuggestion() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    Id logId = [
      SELECT Id
      FROM OrgApiLog__c
      WHERE System__c = 'ERP' AND StatusCode__c = 500
      LIMIT 1
    ]
    .Id;
    System.runAs(admin) {
      Test.startTest();
      OrgApiAlertService.ErrorTypesView types = (OrgApiAlertService.ErrorTypesView) call(
        'getApiErrorTypes',
        new Map<String, Object>{ 'days' => 7 }
      );
      OrgApiAlertService.RuleSpec suggestion = (OrgApiAlertService.RuleSpec) call(
        'suggestApiAlertFromLog',
        new Map<String, Object>{ 'logId' => logId }
      );
      Test.stopTest();
      Assert.areEqual(8, types.errorCount);
      Assert.isFalse(types.truncated);
      OrgApiAlertService.ErrorType top = types.types[0];
      Assert.areEqual('ERP', top.systemName);
      Assert.areEqual(6, top.count);
      Assert.areEqual(6, top.peakPerHour);
      Assert.areEqual(6, top.last24h);
      Assert.areEqual('ERP', suggestion.systemName);
      Assert.areEqual('500', suggestion.statusCodes);
      Assert.areEqual(7, suggestion.threshold);
      Assert.areEqual('High', suggestion.severity);
      Assert.isNotNull(suggestion.errorContains);
    }
  }

  @IsTest
  static void messageHelpers() {
    Assert.isTrue(OrgApiAlertService.statusMatches('401, 5xx', 503));
    Assert.isTrue(OrgApiAlertService.statusMatches('0', null));
    Assert.isTrue(OrgApiAlertService.statusMatches('401;403', 403));
    Assert.isFalse(OrgApiAlertService.statusMatches('4xx', 200));
    Assert.areEqual('', OrgApiAlertService.normalizeMessage(null));
    Assert.areEqual(
      'Record <id> owned by <email> failed after # ms <guid>',
      OrgApiAlertService.normalizeMessage(
        'Record 001000000000001AAA owned by a.b@acme.com failed after 120 ms 123e4567-e89b-12d3-a456-426614174000'
      )
    );
    Assert.isNull(OrgApiAlertService.containsHint(''));
    Assert.areEqual(
      'Unable to lock row',
      OrgApiAlertService.containsHint('42 Unable to lock row 17')
    );
  }

  @IsTest
  static void sinkWritesAndPurgesTheLog() {
    User admin = OrgApiMonitoringTestData.userNamed(ADMIN);
    System.runAs(admin) {
      OrgApiLog__c old = OrgApiMonitoringTestData.log('ERP', 200, 0, null);
      old.CalledAt__c = Datetime.now().addDays(-400);
      insert old;
      OrgApiLogger.Entry ok = new OrgApiLogger.Entry();
      ok.systemName = 'Jira';
      ok.operation = 'Create issue';
      ok.method = 'POST';
      ok.endpoint = '/rest/api/3/issue?access_token=secret123';
      ok.statusCode = 201;
      ok.requestBody = '{"password":"x"}';
      OrgApiLogger.Entry failed = new OrgApiLogger.Entry();
      failed.systemName = 'Jira';
      failed.success = false;
      failed.errorMessage = 'Bearer abc.def';
      Test.startTest();
      module().save(new List<OrgApiLogger.Entry>{ ok, failed });
      Assert.isNotNull(OrgMaintenanceService.purge());
      Test.stopTest();
    }
    List<OrgApiLog__c> written = [
      SELECT Success__c, Endpoint__c, ErrorMessage__c
      FROM OrgApiLog__c
      WHERE System__c = 'Jira'
      ORDER BY Success__c DESC
    ];
    Assert.areEqual(2, written.size());
    Assert.isTrue(written[0].Success__c);
    Assert.isFalse(written[0].Endpoint__c.contains('secret123'), 'Redacted');
    Assert.isFalse(written[1].Success__c);
    Assert.isFalse(written[1].ErrorMessage__c.contains('abc.def'));
    Assert.areEqual(
      0,
      [SELECT COUNT() FROM OrgApiLog__c WHERE CalledAt__c < LAST_N_DAYS:365],
      'Entry older than the retention purged'
    );
  }

  @IsTest
  static void accessIsChecked() {
    User reader = OrgApiMonitoringTestData.userNamed(READER);
    User outsider = OrgApiMonitoringTestData.userNamed(OUTSIDER);
    System.runAs(outsider) {
      Assert.isFalse(module().isAccessible(), 'No module permission set');
      try {
        call('getApiLogs', new Map<String, Object>());
        Assert.fail('Outsider');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('do not have access'));
      }
    }
    System.runAs(reader) {
      // Module accessible, mais actions réservées aux administrateurs Org Intelligence
      Assert.isTrue(module().isAccessible());
      for (
        String action : new List<String>{
          'getApiLogs',
          'getApiLog',
          'getOrgApiUsage',
          'getApiAlerts',
          'previewApiAlertRule',
          'saveApiAlertRule',
          'setApiAlertRuleActive',
          'deleteApiAlertRule',
          'checkApiAlerts',
          'sendApiAlertTest',
          'setApiAlertStatus',
          'scheduleApiAlerts',
          'getApiErrorTypes',
          'suggestApiAlertFromLog'
        }
      ) {
        try {
          call(action, new Map<String, Object>());
          Assert.fail(action + ' allowed to a reader');
        } catch (AuraHandledException e) {
          Assert.isTrue(
            e.getMessage().contains('administrators'),
            action + ': ' + e.getMessage()
          );
        }
      }
      try {
        call('doesNotExist', new Map<String, Object>());
        Assert.fail('Unknown action');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('doesNotExist'));
      }
    }
  }
}
