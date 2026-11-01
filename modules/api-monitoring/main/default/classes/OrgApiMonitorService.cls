/**
 * Suivi des API : journal des appels (OrgApiLog__c), consommation des limites de l'org (OrgLimits)
 * et connexions API (LoginHistory, hors connexions navigateur à l'interface).
 */
public inherited sharing class OrgApiMonitorService {
  @TestVisible
  private static final Integer LOG_LIMIT = 1000;
  private static final List<String> WATCHED_LIMITS = new List<String>{
    'DailyApiRequests',
    'DailyAsyncApexExecutions',
    'DailyBulkApiBatches',
    'DailyBulkV2QueryJobs',
    'DailyStreamingApiEvents',
    'HourlyPublishedPlatformEvents',
    'SingleEmail',
    'DataStorageMB',
    'FileStorageMB'
  };
  private static final Map<String, String> LIMIT_LABELS = new Map<String, String>{
    'DailyApiRequests' => 'API requests (24 h)',
    'DailyAsyncApexExecutions' => 'Async Apex executions (24 h)',
    'DailyBulkApiBatches' => 'Bulk API batches (24 h)',
    'DailyBulkV2QueryJobs' => 'Bulk API 2.0 query jobs (24 h)',
    'DailyStreamingApiEvents' => 'Streaming API events (24 h)',
    'HourlyPublishedPlatformEvents' => 'Platform events published (1 h)',
    'SingleEmail' => 'Single emails (24 h)',
    'DataStorageMB' => 'Data storage (MB)',
    'FileStorageMB' => 'File storage (MB)'
  };

  // ---------- Journal des appels ----------

  public static LogPage getLogs(Integer days) {
    Integer period = days == null || days <= 0 ? 7 : Math.min(days, 365);
    Datetime since = Datetime.now().addDays(-period);
    Datetime lastDay = Datetime.now().addHours(-24);

    LogPage page = new LogPage();
    page.periodDays = period;
    page.total = [
      SELECT COUNT()
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since
      WITH USER_MODE
    ];
    page.successCount = [
      SELECT COUNT()
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since AND Success__c = TRUE
      WITH USER_MODE
    ];
    page.errorCount = page.total - page.successCount;
    page.last24hCount = [
      SELECT COUNT()
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :lastDay
      WITH USER_MODE
    ];
    page.averageDurationMs = 0;

    page.systems = new List<SystemCount>();
    for (AggregateResult row : [
      SELECT System__c name, COUNT(Id) total
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since
      WITH USER_MODE
      GROUP BY System__c
      ORDER BY COUNT(Id) DESC
    ]) {
      SystemCount counter = new SystemCount();
      counter.name = row.get('name') == null
        ? 'Other'
        : (String) row.get('name');
      counter.total = (Integer) row.get('total');
      page.systems.add(counter);
    }
    for (AggregateResult row : [
      SELECT System__c name, COUNT(Id) total
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since AND Success__c = FALSE
      WITH USER_MODE
      GROUP BY System__c
    ]) {
      String name = row.get('name') == null
        ? 'Other'
        : (String) row.get('name');
      for (SystemCount counter : page.systems) {
        if (counter.name == name) {
          counter.errors = (Integer) row.get('total');
        }
      }
    }
    List<AggregateResult> average = [
      SELECT AVG(DurationMs__c) duration
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since
      WITH USER_MODE
    ];
    if (!average.isEmpty() && average[0].get('duration') != null) {
      page.averageDurationMs = ((Decimal) average[0].get('duration'))
        .setScale(0)
        .intValue();
    }

    page.rows = new List<LogRow>();
    for (OrgApiLog__c log : [
      SELECT
        Id,
        Name,
        System__c,
        Direction__c,
        Operation__c,
        Method__c,
        Endpoint__c,
        StatusCode__c,
        Success__c,
        DurationMs__c,
        CalledAt__c,
        ErrorMessage__c,
        RelatedRecordId__c,
        CreatedBy.Name
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since
      WITH USER_MODE
      ORDER BY CalledAt__c DESC
      LIMIT :LOG_LIMIT
    ]) {
      page.rows.add(new LogRow(log));
    }
    page.truncated = page.total > page.rows.size();
    return page;
  }

  public static LogDetail getLog(Id logId) {
    List<OrgApiLog__c> logs = [
      SELECT
        Id,
        Name,
        System__c,
        Direction__c,
        Operation__c,
        Method__c,
        Endpoint__c,
        StatusCode__c,
        Success__c,
        DurationMs__c,
        CalledAt__c,
        ErrorMessage__c,
        RelatedRecordId__c,
        CreatedBy.Name,
        RequestBody__c,
        ResponseBody__c
      FROM OrgApiLog__c
      WHERE Id = :logId
      WITH USER_MODE
    ];
    if (logs.isEmpty()) {
      throw new IllegalArgumentException(
        'This log entry does not exist anymore.'
      );
    }
    LogDetail detail = new LogDetail();
    detail.row = new LogRow(logs[0]);
    detail.requestBody = logs[0].RequestBody__c;
    detail.responseBody = logs[0].ResponseBody__c;
    return detail;
  }

  // ---------- Consommation de l'org ----------

  public static OrgUsage getOrgUsage(Integer days) {
    Integer period = days == null || days <= 0 ? 7 : Math.min(days, 180);
    OrgUsage usage = new OrgUsage();
    usage.periodDays = period;
    usage.limits = new List<LimitRow>();
    Map<String, System.OrgLimit> limits = OrgLimits.getMap();
    for (String name : WATCHED_LIMITS) {
      System.OrgLimit orgLimit = limits.get(name);
      if (orgLimit == null || orgLimit.getLimit() == 0) {
        continue;
      }
      LimitRow row = new LimitRow();
      row.name = name;
      row.label = LIMIT_LABELS.get(name);
      row.max = orgLimit.getLimit();
      row.used = orgLimit.getValue();
      row.percent = (100.0 * row.used / row.max).setScale(1);
      usage.limits.add(row);
    }

    usage.applications = new List<LoginGroup>();
    usage.users = new List<LoginGroup>();
    usage.failures = new List<LoginRow>();
    Datetime since = Datetime.now().addDays(-period);
    try {
      for (AggregateResult row : [
        SELECT
          Application,
          LoginType,
          Status,
          COUNT(Id) total,
          MAX(LoginTime) lastLogin
        FROM LoginHistory
        WHERE LoginTime >= :since AND LoginType != 'Application'
        GROUP BY Application, LoginType, Status
        ORDER BY COUNT(Id) DESC
        LIMIT 50
      ]) {
        LoginGroup item = new LoginGroup();
        item.name = (String) row.get('Application');
        item.loginType = (String) row.get('LoginType');
        item.status = (String) row.get('Status');
        item.total = (Integer) row.get('total');
        item.lastLogin = (Datetime) row.get('lastLogin');
        usage.applications.add(item);
        usage.apiLoginCount =
          (usage.apiLoginCount == null ? 0 : usage.apiLoginCount) + item.total;
        if (item.status != 'Success') {
          usage.failedLoginCount =
            (usage.failedLoginCount == null ? 0 : usage.failedLoginCount) +
            item.total;
        }
      }
      Map<Id, LoginGroup> byUser = new Map<Id, LoginGroup>();
      for (AggregateResult row : [
        SELECT UserId, COUNT(Id) total, MAX(LoginTime) lastLogin
        FROM LoginHistory
        WHERE LoginTime >= :since AND LoginType != 'Application'
        GROUP BY UserId
        ORDER BY COUNT(Id) DESC
        LIMIT 10
      ]) {
        LoginGroup item = new LoginGroup();
        item.userId = (Id) row.get('UserId');
        item.total = (Integer) row.get('total');
        item.lastLogin = (Datetime) row.get('lastLogin');
        byUser.put(item.userId, item);
      }
      for (User user : [
        SELECT Id, Name, Username, IsActive
        FROM User
        WHERE Id IN :byUser.keySet()
      ]) {
        byUser.get(user.Id).name = user.Name;
        byUser.get(user.Id).detail =
          user.Username + (user.IsActive ? '' : ' (inactive)');
      }
      usage.users = byUser.values();
      // Status n'est pas filtrable en SOQL : filtre sur les connexions récentes
      for (LoginHistory login : [
        SELECT UserId, LoginTime, Application, LoginType, Status, SourceIp
        FROM LoginHistory
        WHERE LoginTime >= :since
        ORDER BY LoginTime DESC
        LIMIT 5000
      ]) {
        if (login.Status == 'Success' || usage.failures.size() >= 50) {
          continue;
        }
        LoginRow row = new LoginRow();
        row.userId = login.UserId;
        row.loginTime = login.LoginTime;
        row.application = login.Application;
        row.loginType = login.LoginType;
        row.status = login.Status;
        row.sourceIp = login.SourceIp;
        usage.failures.add(row);
      }
      Map<Id, String> names = new Map<Id, String>();
      Set<Id> userIds = new Set<Id>();
      for (LoginRow row : usage.failures) {
        userIds.add(row.userId);
      }
      for (User user : [SELECT Id, Name FROM User WHERE Id IN :userIds]) {
        names.put(user.Id, user.Name);
      }
      for (LoginRow row : usage.failures) {
        row.userName = names.get(row.userId);
      }
      usage.loginHistoryAvailable = true;
    } catch (Exception e) {
      usage.loginHistoryAvailable = false;
      usage.loginHistoryMessage = 'Login history is not readable with your permissions ("Manage Users" is required).';
    }
    return usage;
  }

  // ---------- DTO ----------

  public class LogPage {
    @AuraEnabled
    public Integer periodDays;
    @AuraEnabled
    public Integer total;
    @AuraEnabled
    public Integer successCount;
    @AuraEnabled
    public Integer errorCount;
    @AuraEnabled
    public Integer last24hCount;
    @AuraEnabled
    public Integer averageDurationMs;
    @AuraEnabled
    public List<SystemCount> systems;
    @AuraEnabled
    public List<LogRow> rows;
    @AuraEnabled
    public Boolean truncated;
  }

  public class SystemCount {
    @AuraEnabled
    public String name;
    @AuraEnabled
    public Integer total = 0;
    @AuraEnabled
    public Integer errors = 0;
  }

  public class LogRow {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String systemName;
    @AuraEnabled
    public String direction;
    @AuraEnabled
    public String operation;
    @AuraEnabled
    public String method;
    @AuraEnabled
    public String endpoint;
    @AuraEnabled
    public Integer statusCode;
    @AuraEnabled
    public Boolean success;
    @AuraEnabled
    public Integer durationMs;
    @AuraEnabled
    public Datetime calledAt;
    @AuraEnabled
    public String errorMessage;
    @AuraEnabled
    public String relatedRecordId;
    @AuraEnabled
    public String userName;

    public LogRow(OrgApiLog__c log) {
      id = log.Id;
      name = log.Name;
      systemName = log.System__c == null ? 'Other' : log.System__c;
      direction = log.Direction__c;
      operation = log.Operation__c;
      method = log.Method__c;
      endpoint = log.Endpoint__c;
      statusCode = log.StatusCode__c == null
        ? null
        : log.StatusCode__c.intValue();
      success = log.Success__c;
      durationMs = log.DurationMs__c == null
        ? null
        : log.DurationMs__c.intValue();
      calledAt = log.CalledAt__c;
      errorMessage = log.ErrorMessage__c?.abbreviate(500);
      relatedRecordId = log.RelatedRecordId__c;
      userName = log.CreatedBy?.Name;
    }
  }

  public class LogDetail {
    @AuraEnabled
    public LogRow row;
    @AuraEnabled
    public String requestBody;
    @AuraEnabled
    public String responseBody;
  }

  public class OrgUsage {
    @AuraEnabled
    public Integer periodDays;
    @AuraEnabled
    public List<LimitRow> limits;
    @AuraEnabled
    public List<LoginGroup> applications;
    @AuraEnabled
    public List<LoginGroup> users;
    @AuraEnabled
    public List<LoginRow> failures;
    @AuraEnabled
    public Integer apiLoginCount = 0;
    @AuraEnabled
    public Integer failedLoginCount = 0;
    @AuraEnabled
    public Boolean loginHistoryAvailable;
    @AuraEnabled
    public String loginHistoryMessage;
  }

  public class LimitRow {
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String label;
    @AuraEnabled
    public Integer max;
    @AuraEnabled
    public Integer used;
    @AuraEnabled
    public Decimal percent;
  }

  public class LoginGroup {
    @AuraEnabled
    public Id userId;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String detail;
    @AuraEnabled
    public String loginType;
    @AuraEnabled
    public String status;
    @AuraEnabled
    public Integer total;
    @AuraEnabled
    public Datetime lastLogin;
  }

  public class LoginRow {
    @AuraEnabled
    public Id userId;
    @AuraEnabled
    public String userName;
    @AuraEnabled
    public Datetime loginTime;
    @AuraEnabled
    public String application;
    @AuraEnabled
    public String loginType;
    @AuraEnabled
    public String status;
    @AuraEnabled
    public String sourceIp;
  }
}
