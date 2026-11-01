/**
 * Alertes sur le journal des appels API (OrgApiLog__c).
 *
 * Une règle (OrgApiAlertRule__c) mesure une métrique (erreurs, appels, taux d'erreur, durée
 * moyenne, appels lents) sur une fenêtre glissante, après filtres (système, opération, codes HTTP,
 * texte d'erreur), et la compare à un seuil. Au déclenchement : une alerte (OrgApiAlertEvent__c)
 * et les canaux choisis (e-mail, tâche rattachée à la règle, notification Salesforce). Un délai de
 * carence (cooldown) évite de renvoyer la même alerte à chaque contrôle.
 *
 * Le même moteur sert au contrôle planifié (OrgApiAlertJob), au contrôle à la demande et à la
 * simulation sur les 7 derniers jours (aperçu dans l'éditeur, courbes des cartes) : fenêtre
 * glissante à deux curseurs sur les appels triés, évaluée à chaque pas de contrôle.
 */
public inherited sharing class OrgApiAlertService {
  public static final String JOB_NAME = 'Org Intelligence - API alerts';
  public static final Integer STEP_MINUTES = 15;
  public static final Integer BACKTEST_DAYS = 7;
  public static final Integer EVENT_RETENTION_DAYS = 90;
  private static final Integer MAX_LOGS = 20000;
  private static final Integer MAX_ERROR_LOGS = 2000;
  private static final Integer MAX_RULES = 50;
  private static final String APP_PATH = '/lightning/n/Org_Intelligence?c__section=apiMonitoring';

  private static final Pattern GUID = Pattern.compile(
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
  );
  private static final Pattern RECORD_ID = Pattern.compile(
    '\\b(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\\b'
  );
  private static final Pattern EMAIL = Pattern.compile(
    '[\\w.+-]+@[\\w-]+\\.[\\w.-]+'
  );
  private static final Pattern HEX = Pattern.compile(
    '\\b(?=[0-9a-fA-F]*[0-9])[0-9a-fA-F]{12,}\\b'
  );
  private static final Pattern DIGITS = Pattern.compile('\\d+');
  private static final Pattern SPACES = Pattern.compile('\\s+');

  // ---------- DTO ----------

  /** Règle telle qu'échangée avec l'interface (et lue depuis l'enregistrement). */
  public class RuleSpec {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public Boolean active = true;
    @AuraEnabled
    public String description;
    @AuraEnabled
    public String systemName;
    @AuraEnabled
    public String operationContains;
    @AuraEnabled
    public String metric = 'Errors';
    @AuraEnabled
    public String comparator = 'AtLeast';
    @AuraEnabled
    public Decimal threshold;
    @AuraEnabled
    public Integer windowMinutes = 60;
    @AuraEnabled
    public String statusCodes;
    @AuraEnabled
    public String errorContains;
    @AuraEnabled
    public Integer slowThresholdMs;
    @AuraEnabled
    public Integer minimumCalls;
    @AuraEnabled
    public String severity = 'High';
    @AuraEnabled
    public List<String> channels = new List<String>();
    @AuraEnabled
    public String recipients;
    @AuraEnabled
    public Id taskOwnerId;
    @AuraEnabled
    public String taskOwnerName;
    @AuraEnabled
    public Integer cooldownMinutes = 60;
    @AuraEnabled
    public Datetime lastEvaluatedAt;
    @AuraEnabled
    public Decimal lastValue;
    @AuraEnabled
    public Datetime lastTriggeredAt;
    @AuraEnabled
    public Integer triggerCount = 0;
    @AuraEnabled
    public Integer openAlerts = 0;
    /** Courbe des dernières 24 h (une valeur par heure) et état courant. */
    @AuraEnabled
    public List<Decimal> sparkline;
    @AuraEnabled
    public Decimal currentValue;
    @AuraEnabled
    public Boolean breachingNow = false;
  }

  public class AlertsView {
    @AuraEnabled
    public List<RuleSpec> rules = new List<RuleSpec>();
    @AuraEnabled
    public List<AlertEvent> events = new List<AlertEvent>();
    @AuraEnabled
    public Schedule schedule;
    @AuraEnabled
    public List<String> systems = new List<String>();
    @AuraEnabled
    public Integer openCount = 0;
    @AuraEnabled
    public Integer firedLast24h = 0;
    @AuraEnabled
    public Id currentUserId = UserInfo.getUserId();
    @AuraEnabled
    public String currentUserName = UserInfo.getName();
    @AuraEnabled
    public String currentUserEmail = UserInfo.getUserEmail();
  }

  public class Schedule {
    @AuraEnabled
    public Boolean scheduled = false;
    @AuraEnabled
    public Integer frequencyMinutes;
    @AuraEnabled
    public Datetime nextRunAt;
    @AuraEnabled
    public Datetime previousRunAt;
  }

  public class AlertEvent {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public Id ruleId;
    @AuraEnabled
    public String ruleName;
    @AuraEnabled
    public String severity;
    @AuraEnabled
    public Datetime firedAt;
    @AuraEnabled
    public Decimal value;
    @AuraEnabled
    public Decimal threshold;
    @AuraEnabled
    public String metric;
    @AuraEnabled
    public String comparator;
    @AuraEnabled
    public Datetime windowStart;
    @AuraEnabled
    public Datetime windowEnd;
    @AuraEnabled
    public String summary;
    @AuraEnabled
    public String status;
    @AuraEnabled
    public String channels;
    @AuraEnabled
    public String deliveryErrors;
    @AuraEnabled
    public Id taskId;
    @AuraEnabled
    public Datetime acknowledgedAt;
    @AuraEnabled
    public String acknowledgedBy;
  }

  /** Résultat d'une simulation (aperçu) ou d'un contrôle. */
  public class Simulation {
    @AuraEnabled
    public List<Decimal> values = new List<Decimal>();
    @AuraEnabled
    public List<Datetime> times = new List<Datetime>();
    @AuraEnabled
    public List<Datetime> fireTimes = new List<Datetime>();
    @AuraEnabled
    public Integer fires = 0;
    @AuraEnabled
    public Datetime lastFireAt;
    @AuraEnabled
    public Decimal currentValue;
    @AuraEnabled
    public Boolean breachingNow = false;
    @AuraEnabled
    public Decimal maxValue;
    @AuraEnabled
    public Integer matchedCalls = 0;
    @AuraEnabled
    public Integer matchedErrors = 0;
    @AuraEnabled
    public Boolean truncated = false;
    @AuraEnabled
    public Integer days = BACKTEST_DAYS;
    @AuraEnabled
    public List<ErrorType> topErrors = new List<ErrorType>();
  }

  /** Type d'erreur : système + code HTTP + message normalisé. */
  public class ErrorType {
    @AuraEnabled
    public String key;
    @AuraEnabled
    public String systemName;
    @AuraEnabled
    public Integer statusCode;
    @AuraEnabled
    public String pattern;
    @AuraEnabled
    public String sampleMessage;
    @AuraEnabled
    public Id sampleLogId;
    @AuraEnabled
    public String operation;
    @AuraEnabled
    public String containsHint;
    @AuraEnabled
    public Integer count = 0;
    @AuraEnabled
    public Integer last24h = 0;
    @AuraEnabled
    public Integer previous24h = 0;
    @AuraEnabled
    public Datetime firstAt;
    @AuraEnabled
    public Datetime lastAt;
    @AuraEnabled
    public List<Integer> daily;
    /** Plus forte concentration observée sur une heure glissante : base du seuil suggéré. */
    @AuraEnabled
    public Integer peakPerHour = 0;
  }

  public class ErrorTypesView {
    @AuraEnabled
    public Integer periodDays;
    @AuraEnabled
    public Integer errorCount = 0;
    @AuraEnabled
    public Boolean truncated = false;
    @AuraEnabled
    public List<ErrorType> types = new List<ErrorType>();
  }

  public class CheckResult {
    @AuraEnabled
    public Integer evaluated = 0;
    @AuraEnabled
    public Integer fired = 0;
    @AuraEnabled
    public Integer skippedCooldown = 0;
    @AuraEnabled
    public List<String> messages = new List<String>();
  }

  /** Appel du journal réduit à ce que l'évaluation utilise. */
  private class LogPoint {
    Id id;
    Long at;
    Boolean success;
    Integer statusCode;
    Decimal durationMs;
    String systemName;
    String operation;
    String error;
    String rawError;
    String logName;
  }

  /** Compteurs d'une fenêtre (additifs : entrée et sortie des appels). */
  private class Counter {
    Integer calls = 0;
    Integer errors = 0;
    Integer slow = 0;
    Decimal durationSum = 0;
    Integer durationCount = 0;

    void add(LogPoint p, RuleSpec spec, Integer sign) {
      calls += sign;
      if (p.success != true) {
        errors += sign;
      }
      if (p.durationMs != null) {
        durationSum += sign * p.durationMs;
        durationCount += sign;
        if (
          spec.slowThresholdMs != null &&
          p.durationMs > spec.slowThresholdMs
        ) {
          slow += sign;
        }
      }
    }
  }

  // ---------- Lecture pour l'interface ----------

  public static AlertsView getView() {
    AlertsView view = new AlertsView();
    view.schedule = getSchedule();
    List<OrgApiAlertRule__c> records = queryRules(null, AccessLevel.USER_MODE);
    Map<Id, Integer> openByRule = new Map<Id, Integer>();
    for (AggregateResult row : [
      SELECT Rule__c rule, COUNT(Id) total
      FROM OrgApiAlertEvent__c
      WHERE Status__c = 'Open'
      WITH USER_MODE
      GROUP BY Rule__c
    ]) {
      openByRule.put((Id) row.get('rule'), (Integer) row.get('total'));
      view.openCount += (Integer) row.get('total');
    }
    Datetime dayAgo = Datetime.now().addHours(-24);
    view.firedLast24h = [
      SELECT COUNT()
      FROM OrgApiAlertEvent__c
      WHERE FiredAt__c >= :dayAgo
      WITH USER_MODE
    ];

    // Courbes 24 h : une seule lecture du journal pour toutes les règles
    List<RuleSpec> specs = new List<RuleSpec>();
    Integer maxWindow = 0;
    Boolean needsErrors = false;
    for (OrgApiAlertRule__c record : records) {
      RuleSpec spec = toSpec(record);
      spec.openAlerts = openByRule.containsKey(record.Id)
        ? openByRule.get(record.Id)
        : 0;
      specs.add(spec);
      maxWindow = Math.max(maxWindow, spec.windowMinutes);
      needsErrors = needsErrors || String.isNotBlank(spec.errorContains);
    }
    if (!specs.isEmpty()) {
      Datetime until = Datetime.now();
      Datetime fromAt = until.addHours(-24);
      List<LogPoint> points = loadPoints(
        null,
        fromAt.addMinutes(-maxWindow),
        until,
        needsErrors,
        false,
        AccessLevel.USER_MODE
      );
      for (RuleSpec spec : specs) {
        Simulation sim = simulate(spec, points, fromAt, until, 60, false);
        spec.sparkline = sim.values;
        spec.currentValue = sim.currentValue;
        spec.breachingNow = sim.breachingNow;
      }
    }
    view.rules = specs;

    for (OrgApiAlertEvent__c event : [
      SELECT
        Id,
        Name,
        Rule__c,
        Rule__r.Name,
        Rule__r.Severity__c,
        Rule__r.Metric__c,
        Rule__r.Comparator__c,
        FiredAt__c,
        Value__c,
        Threshold__c,
        WindowStart__c,
        WindowEnd__c,
        Summary__c,
        Status__c,
        Channels__c,
        DeliveryErrors__c,
        TaskId__c,
        AcknowledgedAt__c,
        AcknowledgedBy__r.Name
      FROM OrgApiAlertEvent__c
      WITH USER_MODE
      ORDER BY FiredAt__c DESC
      LIMIT 100
    ]) {
      view.events.add(toEvent(event));
    }

    Datetime since = Datetime.now().addDays(-90);
    for (AggregateResult row : [
      SELECT System__c name
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since AND System__c != NULL
      WITH USER_MODE
      GROUP BY System__c
      ORDER BY System__c
      LIMIT 200
    ]) {
      view.systems.add((String) row.get('name'));
    }
    return view;
  }

  /** Aperçu d'une règle en cours d'édition : simulation sur les 7 derniers jours. */
  public static Simulation preview(RuleSpec spec) {
    normalize(spec);
    Datetime until = Datetime.now();
    Datetime fromAt = until.addDays(-BACKTEST_DAYS);
    List<LogPoint> points = loadPoints(
      spec,
      fromAt.addMinutes(-spec.windowMinutes),
      until,
      String.isNotBlank(spec.errorContains),
      true,
      AccessLevel.USER_MODE
    );
    Simulation sim = simulate(spec, points, fromAt, until, STEP_MINUTES, true);
    sim.truncated = points.size() >= MAX_LOGS;
    for (LogPoint p : points) {
      if (p.at >= fromAt.getTime() && matches(spec, p)) {
        sim.matchedCalls++;
        if (p.success != true) {
          sim.matchedErrors++;
        }
      }
    }
    sim.topErrors = errorTypesFor(spec, fromAt, until, 3);
    return sim;
  }

  /** Erreurs de la période regroupées par type (système + code + message normalisé). */
  public static ErrorTypesView getErrorTypes(Integer days) {
    Integer period = days == null || days <= 0 ? 7 : Math.min(days, 90);
    ErrorTypesView view = new ErrorTypesView();
    view.periodDays = period;
    Datetime until = Datetime.now();
    Datetime since = until.addDays(-period);
    view.errorCount = [
      SELECT COUNT()
      FROM OrgApiLog__c
      WHERE CalledAt__c >= :since AND Success__c = FALSE
      WITH USER_MODE
    ];
    view.types = errorTypesFor(null, since, until, 50);
    view.truncated = view.errorCount > MAX_ERROR_LOGS;
    return view;
  }

  /** Brouillon de règle « erreurs similaires » à partir d'un appel du journal. */
  public static RuleSpec suggestFromLog(Id logId) {
    List<OrgApiLog__c> logs = [
      SELECT System__c, Operation__c, StatusCode__c, ErrorMessage__c, Success__c
      FROM OrgApiLog__c
      WHERE Id = :logId
      WITH USER_MODE
    ];
    if (logs.isEmpty()) {
      throw new IllegalArgumentException(
        'This log entry does not exist anymore.'
      );
    }
    OrgApiLog__c log = logs[0];
    RuleSpec spec = new RuleSpec();
    spec.systemName = log.System__c;
    spec.metric = 'Errors';
    spec.comparator = 'AtLeast';
    spec.windowMinutes = 60;
    spec.cooldownMinutes = 60;
    if (log.StatusCode__c != null) {
      spec.statusCodes = String.valueOf(log.StatusCode__c.intValue());
    }
    spec.errorContains = containsHint(log.ErrorMessage__c);
    spec.channels = new List<String>{ 'Email', 'Task' };
    spec.recipients = UserInfo.getUserEmail();
    spec.taskOwnerId = UserInfo.getUserId();
    // Seuil suggéré : au-dessus du pic horaire observé sur 7 jours, au moins 5
    Integer peak = 0;
    for (
      ErrorType type : errorTypesFor(
        spec,
        Datetime.now().addDays(-7),
        Datetime.now(),
        1
      )
    ) {
      peak = Math.max(peak, type.peakPerHour);
    }
    spec.threshold = Math.max(5, peak + 1);
    spec.severity = log.StatusCode__c != null &&
      log.StatusCode__c >= 500
      ? 'High'
      : 'Medium';
    spec.name =
      'Errors on ' +
      (log.System__c == null ? 'all systems' : log.System__c) +
      (spec.statusCodes == null ? '' : ' (' + spec.statusCodes + ')');
    return spec;
  }

  // ---------- Écriture depuis l'interface ----------

  public static Id saveRule(RuleSpec spec) {
    normalize(spec);
    validate(spec);
    OrgApiAlertRule__c record = new OrgApiAlertRule__c(
      Id = spec.id,
      Name = spec.name.abbreviate(80),
      Active__c = spec.active == true,
      Description__c = spec.description?.abbreviate(255),
      System__c = spec.systemName,
      OperationContains__c = spec.operationContains,
      Metric__c = spec.metric,
      Comparator__c = spec.comparator,
      Threshold__c = spec.threshold,
      WindowMinutes__c = spec.windowMinutes,
      StatusCodes__c = spec.statusCodes,
      ErrorContains__c = spec.errorContains,
      SlowThresholdMs__c = spec.slowThresholdMs,
      MinimumCalls__c = spec.minimumCalls,
      Severity__c = spec.severity,
      Channels__c = String.join(spec.channels, ';'),
      Recipients__c = spec.recipients,
      TaskOwner__c = spec.taskOwnerId,
      CooldownMinutes__c = spec.cooldownMinutes
    );
    if (spec.id == null) {
      record.TriggerCount__c = 0;
      Database.insert(record, AccessLevel.USER_MODE);
    } else {
      Database.update(record, AccessLevel.USER_MODE);
    }
    return record.Id;
  }

  public static void setActive(Id ruleId, Boolean active) {
    Database.update(
      new OrgApiAlertRule__c(Id = ruleId, Active__c = active == true),
      AccessLevel.USER_MODE
    );
  }

  public static void deleteRule(Id ruleId) {
    Database.delete(new OrgApiAlertRule__c(Id = ruleId), AccessLevel.USER_MODE);
  }

  public static void setEventStatus(List<Id> eventIds, String status) {
    if (
      !new Set<String>{ 'Open', 'Acknowledged', 'Resolved' }.contains(status)
    ) {
      throw new IllegalArgumentException('Unknown alert status: ' + status);
    }
    List<OrgApiAlertEvent__c> events = new List<OrgApiAlertEvent__c>();
    for (Id eventId : eventIds) {
      OrgApiAlertEvent__c event = new OrgApiAlertEvent__c(
        Id = eventId,
        Status__c = status
      );
      if (status == 'Open') {
        event.AcknowledgedAt__c = null;
        event.AcknowledgedBy__c = null;
      } else {
        event.AcknowledgedAt__c = Datetime.now();
        event.AcknowledgedBy__c = UserInfo.getUserId();
      }
      events.add(event);
    }
    Database.update(events, AccessLevel.USER_MODE);
  }

  // ---------- Planification ----------

  public static Schedule getSchedule() {
    Schedule result = new Schedule();
    String pattern = JOB_NAME + '%';
    List<CronTrigger> jobs = [
      SELECT Id, NextFireTime, PreviousFireTime, CronJobDetail.Name
      FROM CronTrigger
      WHERE CronJobDetail.Name LIKE :pattern
      ORDER BY NextFireTime ASC
    ];
    result.scheduled = !jobs.isEmpty();
    if (result.scheduled) {
      result.frequencyMinutes = jobs.size() >= 4 ? 15 : 60;
      result.nextRunAt = jobs[0].NextFireTime;
      for (CronTrigger job : jobs) {
        if (
          job.PreviousFireTime != null &&
          (result.previousRunAt == null ||
          job.PreviousFireTime > result.previousRunAt)
        ) {
          result.previousRunAt = job.PreviousFireTime;
        }
      }
    }
    return result;
  }

  /** Planifie le contrôle toutes les 15 min (4 tâches à :00, :15, :30, :45) ou toutes les heures. */
  public static Schedule schedule(Integer frequencyMinutes) {
    unschedule();
    List<Integer> minutes = frequencyMinutes == 15
      ? new List<Integer>{ 0, 15, 30, 45 }
      : new List<Integer>{ 0 };
    for (Integer minute : minutes) {
      String suffix = ' :' + String.valueOf(minute).leftPad(2, '0');
      System.schedule(
        JOB_NAME + suffix,
        '0 ' + minute + ' * * * ?',
        new OrgApiAlertJob()
      );
    }
    return getSchedule();
  }

  public static void unschedule() {
    String pattern = JOB_NAME + '%';
    for (CronTrigger job : [
      SELECT Id
      FROM CronTrigger
      WHERE CronJobDetail.Name LIKE :pattern
    ]) {
      System.abortJob(job.Id);
    }
  }

  /** Purge des alertes au-delà de la rétention (appelée par le job planifié). */
  public static Integer purgeOldEvents() {
    Datetime limitDate = Datetime.now().addDays(-EVENT_RETENTION_DAYS);
    List<OrgApiAlertEvent__c> old = [
      SELECT Id
      FROM OrgApiAlertEvent__c
      WHERE FiredAt__c < :limitDate
      LIMIT 5000
    ];
    Database.delete(old, false);
    return old.size();
  }

  // ---------- Évaluation ----------

  /**
   * Contrôle des règles actives (ou d'une seule). `mode` : USER_MODE depuis l'interface,
   * SYSTEM_MODE depuis le job planifié.
   */
  public static CheckResult evaluate(Id onlyRuleId, AccessLevel mode) {
    CheckResult result = new CheckResult();
    List<OrgApiAlertRule__c> records = queryRules(onlyRuleId, mode);
    Datetime now = Datetime.now();
    List<OrgApiAlertRule__c> ruleUpdates = new List<OrgApiAlertRule__c>();
    List<OrgApiAlertEvent__c> events = new List<OrgApiAlertEvent__c>();
    List<RuleSpec> firedSpecs = new List<RuleSpec>();
    List<List<LogPoint>> firedSamples = new List<List<LogPoint>>();

    for (OrgApiAlertRule__c record : records) {
      if (record.Active__c != true && onlyRuleId == null) {
        continue;
      }
      RuleSpec spec = toSpec(record);
      result.evaluated++;
      Datetime windowStart = now.addMinutes(-spec.windowMinutes);
      List<LogPoint> points = loadPoints(
        spec,
        windowStart,
        now,
        true,
        false,
        mode
      );
      Counter counter = new Counter();
      List<LogPoint> matched = new List<LogPoint>();
      for (LogPoint p : points) {
        if (matches(spec, p)) {
          counter.add(p, spec, 1);
          matched.add(p);
        }
      }
      Decimal value = valueOf(spec, counter);
      Boolean breaching = isBreaching(spec, value);
      OrgApiAlertRule__c ruleUpdate = new OrgApiAlertRule__c(
        Id = record.Id,
        LastEvaluatedAt__c = now,
        LastValue__c = value
      );
      ruleUpdates.add(ruleUpdate);
      if (!breaching) {
        continue;
      }
      if (
        record.LastTriggeredAt__c != null &&
        spec.cooldownMinutes > 0 &&
        record.LastTriggeredAt__c.addMinutes(spec.cooldownMinutes) > now
      ) {
        result.skippedCooldown++;
        result.messages.add(
          spec.name + ': threshold reached, still in cooldown.'
        );
        continue;
      }
      ruleUpdate.LastTriggeredAt__c = now;
      ruleUpdate.TriggerCount__c =
        (record.TriggerCount__c == null ? 0 : record.TriggerCount__c) + 1;
      List<String> sampleIds = new List<String>();
      List<LogPoint> samples = new List<LogPoint>();
      for (LogPoint p : matched) {
        if (
          samples.size() < 5 &&
          (p.success != true ||
          spec.metric == 'Calls' ||
          spec.metric == 'AvgDuration' ||
          spec.metric == 'SlowCalls')
        ) {
          samples.add(p);
          sampleIds.add(p.id);
        }
      }
      events.add(
        new OrgApiAlertEvent__c(
          Rule__c = record.Id,
          FiredAt__c = now,
          Value__c = value,
          Threshold__c = spec.threshold,
          WindowStart__c = windowStart,
          WindowEnd__c = now,
          Status__c = 'Open',
          Summary__c = buildSummary(spec, value, counter, matched),
          SampleLogIds__c = String.join(sampleIds, '\n')
        )
      );
      firedSpecs.add(spec);
      firedSamples.add(samples);
      result.fired++;
      result.messages.add(
        spec.name + ': alert sent (' + formatValue(spec, value) + ').'
      );
    }

    Database.update(ruleUpdates, mode);
    if (events.isEmpty()) {
      return result;
    }
    Database.insert(events, mode);
    deliver(events, firedSpecs, firedSamples, mode);
    return result;
  }

  /** Notification de test (aucune alerte enregistrée). */
  public static List<String> sendTest(Id ruleId) {
    List<OrgApiAlertRule__c> records = queryRules(
      ruleId,
      AccessLevel.USER_MODE
    );
    if (records.isEmpty()) {
      throw new IllegalArgumentException('This rule does not exist anymore.');
    }
    RuleSpec spec = toSpec(records[0]);
    OrgApiAlertEvent__c fake = new OrgApiAlertEvent__c(
      Rule__c = spec.id,
      FiredAt__c = Datetime.now(),
      Value__c = spec.threshold,
      Threshold__c = spec.threshold,
      WindowStart__c = Datetime.now().addMinutes(-spec.windowMinutes),
      WindowEnd__c = Datetime.now(),
      Summary__c = 'This is a test notification: the rule is configured correctly. No alert was recorded.'
    );
    List<String> sent = new List<String>();
    List<String> errors = new List<String>();
    deliverOne(
      fake,
      spec,
      new List<LogPoint>(),
      true,
      sent,
      errors,
      AccessLevel.USER_MODE
    );
    if (!errors.isEmpty()) {
      throw new IllegalArgumentException(String.join(errors, ' '));
    }
    return sent;
  }

  // ---------- Livraison ----------

  private static void deliver(
    List<OrgApiAlertEvent__c> events,
    List<RuleSpec> specs,
    List<List<LogPoint>> samples,
    AccessLevel mode
  ) {
    List<OrgApiAlertEvent__c> updates = new List<OrgApiAlertEvent__c>();
    for (Integer i = 0; i < events.size(); i++) {
      List<String> sent = new List<String>();
      List<String> errors = new List<String>();
      deliverOne(events[i], specs[i], samples[i], false, sent, errors, mode);
      updates.add(
        new OrgApiAlertEvent__c(
          Id = events[i].Id,
          Channels__c = String.join(sent, ';'),
          TaskId__c = events[i].TaskId__c,
          DeliveryErrors__c = errors.isEmpty()
            ? null
            : String.join(errors, '\n').abbreviate(4000)
        )
      );
    }
    try {
      Database.update(updates, false);
    } catch (Exception e) {
      System.debug(
        LoggingLevel.WARN,
        'Alert delivery status not saved: ' + e.getMessage()
      );
    }
  }

  private static void deliverOne(
    OrgApiAlertEvent__c event,
    RuleSpec spec,
    List<LogPoint> samples,
    Boolean isTest,
    List<String> sent,
    List<String> errors,
    AccessLevel mode
  ) {
    String prefix = isTest ? '[TEST] ' : '';
    String title = prefix + 'API alert: ' + spec.name;
    Id ownerId = spec.taskOwnerId != null
      ? spec.taskOwnerId
      : UserInfo.getUserId();

    if (spec.channels.contains('Task')) {
      try {
        Task task = new Task(
          Subject = title.abbreviate(255),
          WhatId = spec.id,
          OwnerId = ownerId,
          ActivityDate = Date.today(),
          Priority = spec.severity == 'Critical' ||
            spec.severity == 'High'
            ? 'High'
            : 'Normal',
          Description = (event.Summary__c +
            '\n\nOpen API Monitoring: ' +
            appUrl())
            .abbreviate(32000)
        );
        // Mode système : la tâche est une notification, pas une saisie de l'utilisateur (FLS de Task)
        Database.insert(task, AccessLevel.SYSTEM_MODE);
        event.TaskId__c = task.Id;
        sent.add('Task');
      } catch (Exception e) {
        errors.add('Task: ' + e.getMessage());
      }
    }

    if (spec.channels.contains('Email')) {
      List<String> to = parseEmails(spec.recipients);
      if (to.isEmpty()) {
        errors.add('Email: no recipient.');
      } else {
        try {
          Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
          mail.setToAddresses(to);
          mail.setSubject(
            ('[Org Intelligence] ' +
              prefix +
              spec.severity +
              ' — ' +
              spec.name)
              .abbreviate(200)
          );
          mail.setHtmlBody(buildEmailHtml(event, spec, samples, isTest));
          mail.setPlainTextBody(event.Summary__c + '\n\n' + appUrl());
          mail.setSaveAsActivity(false);
          List<Messaging.SendEmailResult> results = Messaging.sendEmail(
            new List<Messaging.SingleEmailMessage>{ mail },
            false
          );
          if (results[0].isSuccess()) {
            sent.add('Email');
          } else {
            errors.add('Email: ' + results[0].getErrors()[0].getMessage());
          }
        } catch (Exception e) {
          errors.add('Email: ' + e.getMessage());
        }
      }
    }

    if (spec.channels.contains('Notification')) {
      try {
        List<CustomNotificationType> types = [
          SELECT Id
          FROM CustomNotificationType
          WHERE
            DeveloperName = 'OrgIntelligenceNotification'
            AND NamespacePrefix = :OrgIntelNamespace.namespaceFilter()
          LIMIT 1
        ];
        if (types.isEmpty()) {
          errors.add('Notification: the notification type is missing.');
        } else {
          Messaging.CustomNotification notification = new Messaging.CustomNotification();
          notification.setNotificationTypeId(types[0].Id);
          notification.setTargetId(spec.id);
          notification.setTitle(title.abbreviate(250));
          notification.setBody(
            event.Summary__c.substringBefore('\n').abbreviate(750)
          );
          notification.send(new Set<String>{ (String) ownerId });
          sent.add('Notification');
        }
      } catch (Exception e) {
        errors.add('Notification: ' + e.getMessage());
      }
    }
  }

  private static String appUrl() {
    return Url.getOrgDomainUrl().toExternalForm() + APP_PATH;
  }

  private static String buildEmailHtml(
    OrgApiAlertEvent__c event,
    RuleSpec spec,
    List<LogPoint> samples,
    Boolean isTest
  ) {
    String color = spec.severity == 'Critical'
      ? '#c62828'
      : spec.severity == 'High'
          ? '#dd6b20'
          : spec.severity == 'Medium' ? '#b7791f' : '#0b5cab';
    String html =
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#181818">' +
      '<div style="background:linear-gradient(120deg,#032d60,#0b5cab);color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">' +
      '<div style="font-size:12px;opacity:.85">Org Intelligence · API Monitoring' +
      (isTest ? ' · TEST' : '') +
      '</div><div style="font-size:18px;font-weight:bold;margin-top:4px">' +
      esc(spec.name) +
      '</div></div>' +
      '<div style="border:1px solid #e3e8ef;border-top:0;padding:16px 20px;border-radius:0 0 10px 10px">' +
      '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:' +
      color +
      ';color:#fff;font-size:12px;font-weight:bold">' +
      esc(spec.severity) +
      '</span>' +
      '<p style="font-size:28px;font-weight:bold;margin:12px 0 0;color:' +
      color +
      '">' +
      esc(formatValue(spec, event.Value__c)) +
      '</p><p style="margin:2px 0 12px;color:#5c6470;font-size:13px">' +
      esc(describe(spec)) +
      '</p>' +
      '<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:13px;background:#f4f6f9;padding:12px;border-radius:8px">' +
      esc(event.Summary__c) +
      '</pre>';
    if (!samples.isEmpty()) {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><tr style="text-align:left;color:#5c6470"><th style="padding:4px">Call</th><th style="padding:4px">HTTP</th><th style="padding:4px">Error</th></tr>';
      for (LogPoint p : samples) {
        html +=
          '<tr style="border-top:1px solid #e3e8ef"><td style="padding:4px;white-space:nowrap">' +
          esc(p.logName) +
          '<br/><span style="color:#5c6470">' +
          Datetime.newInstance(p.at).format('dd/MM HH:mm:ss') +
          '</span></td><td style="padding:4px">' +
          (p.statusCode == null ? '—' : String.valueOf(p.statusCode)) +
          '</td><td style="padding:4px;font-family:monospace;color:#a12a2a">' +
          esc(p.rawError == null ? '' : p.rawError.abbreviate(200)) +
          '</td></tr>';
      }
      html += '</table>';
    }
    html +=
      '<p style="margin-top:16px"><a href="' +
      appUrl() +
      '" style="background:#0b5cab;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold">Open API Monitoring</a></p>' +
      '</div></div>';
    return html;
  }

  private static String esc(String value) {
    return value == null ? '' : value.escapeHtml4();
  }

  // ---------- Moteur ----------

  @TestVisible
  private static Simulation simulate(
    RuleSpec spec,
    List<LogPoint> points,
    Datetime fromAt,
    Datetime until,
    Integer outputStepMinutes,
    Boolean withFires
  ) {
    Simulation sim = new Simulation();
    List<LogPoint> matched = new List<LogPoint>();
    for (LogPoint p : points) {
      if (matches(spec, p)) {
        matched.add(p);
      }
    }
    // loadPoints renvoie les appels triés par date croissante
    Long windowMs = spec.windowMinutes * 60000L;
    Long stepMs = STEP_MINUTES * 60000L;
    Long outputMs = outputStepMinutes * 60000L;
    Long start = fromAt.getTime();
    Long stop = until.getTime();
    Counter counter = new Counter();
    Integer head = 0;
    Integer tail = 0;
    Long lastFire = null;
    Long cooldownMs = spec.cooldownMinutes * 60000L;
    Decimal bucketValue = null;
    Long bucketEnd = start + outputMs;
    Long t = start;
    while (true) {
      while (head < matched.size() && matched[head].at <= t) {
        counter.add(matched[head], spec, 1);
        head++;
      }
      while (tail < head && matched[tail].at <= t - windowMs) {
        counter.add(matched[tail], spec, -1);
        tail++;
      }
      Decimal value = valueOf(spec, counter);
      Boolean breaching = isBreaching(spec, value);
      if (
        withFires &&
        breaching &&
        (lastFire == null ||
        t - lastFire >= cooldownMs)
      ) {
        lastFire = t;
        sim.fires++;
        sim.fireTimes.add(Datetime.newInstance(t));
        sim.lastFireAt = Datetime.newInstance(t);
      }
      if (value != null) {
        sim.maxValue = sim.maxValue == null
          ? value
          : Math.max(sim.maxValue, value);
        // Agrégat d'un pas d'affichage : la valeur la plus défavorable
        if (bucketValue == null) {
          bucketValue = value;
        } else if (spec.comparator == 'AtMost') {
          bucketValue = Math.min(bucketValue, value);
        } else {
          bucketValue = Math.max(bucketValue, value);
        }
      }
      if (t >= bucketEnd || t >= stop) {
        sim.values.add(bucketValue == null ? 0 : bucketValue.setScale(1));
        sim.times.add(Datetime.newInstance(Math.min(bucketEnd, stop)));
        bucketValue = null;
        bucketEnd += outputMs;
      }
      if (t >= stop) {
        sim.currentValue = value;
        sim.breachingNow = breaching;
        break;
      }
      t = Math.min(t + stepMs, stop);
    }
    if (sim.fireTimes.size() > 200) {
      List<Datetime> recent = new List<Datetime>();
      for (
        Integer i = sim.fireTimes.size() - 200; i < sim.fireTimes.size(); i++
      ) {
        recent.add(sim.fireTimes[i]);
      }
      sim.fireTimes = recent;
    }
    return sim;
  }

  private static Decimal valueOf(RuleSpec spec, Counter counter) {
    switch on spec.metric {
      when 'Calls' {
        return counter.calls;
      }
      when 'ErrorRate' {
        Integer minimum = spec.minimumCalls == null
          ? 1
          : Math.max(1, spec.minimumCalls);
        if (counter.calls < minimum) {
          return null;
        }
        return (100.0 * counter.errors / counter.calls).setScale(1);
      }
      when 'AvgDuration' {
        return counter.durationCount == 0
          ? null
          : (counter.durationSum / counter.durationCount).setScale(0);
      }
      when 'SlowCalls' {
        return counter.slow;
      }
      when else {
        return counter.errors;
      }
    }
  }

  private static Boolean isBreaching(RuleSpec spec, Decimal value) {
    if (value == null || spec.threshold == null) {
      return false;
    }
    return spec.comparator == 'AtMost'
      ? value <= spec.threshold
      : value >= spec.threshold;
  }

  private static Boolean matches(RuleSpec spec, LogPoint p) {
    if (
      String.isNotBlank(spec.systemName) &&
      !spec.systemName.equalsIgnoreCase(p.systemName)
    ) {
      return false;
    }
    if (
      String.isNotBlank(spec.operationContains) &&
      (p.operation == null ||
      !p.operation.containsIgnoreCase(spec.operationContains))
    ) {
      return false;
    }
    if (
      String.isNotBlank(spec.statusCodes) &&
      !statusMatches(spec.statusCodes, p.statusCode)
    ) {
      return false;
    }
    if (
      String.isNotBlank(spec.errorContains) &&
      (p.error == null || !p.error.contains(spec.errorContains.toLowerCase()))
    ) {
      return false;
    }
    return true;
  }

  /** Codes « 401, 403, 4xx, 5xx, 0 » : 0 = pas de réponse (code vide). */
  @TestVisible
  private static Boolean statusMatches(String codes, Integer status) {
    for (String token : codes.toLowerCase().split('[,;\\s]+')) {
      if (String.isBlank(token)) {
        continue;
      }
      if (token == '0') {
        if (status == null || status == 0) {
          return true;
        }
      } else if (
        token.length() == 3 &&
        token.endsWith('xx') &&
        token.left(1).isNumeric()
      ) {
        Integer family = Integer.valueOf(token.left(1));
        if (status != null && status / 100 == family) {
          return true;
        }
      } else if (
        token.isNumeric() &&
        status != null &&
        Integer.valueOf(token) == status
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Appels triés par date croissante. Les filtres système et opération sont appliqués en SOQL
   * (réduit le volume) ; codes et texte d'erreur en Apex. `errorsOnly` quand seules les erreurs
   * peuvent compter.
   */
  private static List<LogPoint> loadPoints(
    RuleSpec spec,
    Datetime fromAt,
    Datetime until,
    Boolean withErrors,
    Boolean narrow,
    AccessLevel mode
  ) {
    Map<String, Object> binds = new Map<String, Object>{
      'fromAt' => fromAt,
      'until' => until
    };
    String soql =
      'SELECT Id, Name, CalledAt__c, Success__c, StatusCode__c, DurationMs__c, System__c, Operation__c' +
      (withErrors ? ', ErrorMessage__c' : '') +
      ' FROM OrgApiLog__c WHERE CalledAt__c > :fromAt AND CalledAt__c <= :until';
    if (spec != null) {
      if (String.isNotBlank(spec.systemName)) {
        soql += ' AND System__c = :systemName';
        binds.put('systemName', spec.systemName);
      }
      if (String.isNotBlank(spec.operationContains)) {
        soql += ' AND Operation__c LIKE :operation';
        binds.put('operation', '%' + spec.operationContains + '%');
      }
      if (
        narrow &&
        (spec.metric == 'Errors' || String.isNotBlank(spec.errorContains))
      ) {
        soql += ' AND Success__c = FALSE';
      }
    }
    soql += ' ORDER BY CalledAt__c DESC LIMIT ' + MAX_LOGS;
    List<LogPoint> points = new List<LogPoint>();
    List<OrgApiLog__c> logs = (List<OrgApiLog__c>) Database.queryWithBinds(
      soql,
      binds,
      mode
    );
    for (Integer i = logs.size() - 1; i >= 0; i--) {
      OrgApiLog__c log = logs[i];
      LogPoint p = new LogPoint();
      p.id = log.Id;
      p.logName = log.Name;
      p.at = log.CalledAt__c.getTime();
      p.success = log.Success__c;
      p.statusCode = log.StatusCode__c == null
        ? null
        : log.StatusCode__c.intValue();
      p.durationMs = log.DurationMs__c;
      p.systemName = log.System__c;
      p.operation = log.Operation__c;
      if (withErrors && log.ErrorMessage__c != null) {
        p.rawError = log.ErrorMessage__c.left(1000);
        p.error = p.rawError.toLowerCase();
      }
      points.add(p);
    }
    return points;
  }

  // ---------- Types d'erreurs ----------

  private static List<ErrorType> errorTypesFor(
    RuleSpec spec,
    Datetime since,
    Datetime until,
    Integer maxTypes
  ) {
    Map<String, Object> binds = new Map<String, Object>{
      'since' => since,
      'until' => until
    };
    String soql = 'SELECT Id, CalledAt__c, System__c, Operation__c, StatusCode__c, ErrorMessage__c FROM OrgApiLog__c WHERE Success__c = FALSE AND CalledAt__c >= :since AND CalledAt__c <= :until';
    if (spec != null && String.isNotBlank(spec.systemName)) {
      soql += ' AND System__c = :systemName';
      binds.put('systemName', spec.systemName);
    }
    soql += ' ORDER BY CalledAt__c DESC LIMIT ' + MAX_ERROR_LOGS;
    Integer days = Math.max(
      1,
      Math.ceil((until.getTime() - since.getTime()) / 86400000.0).intValue()
    );
    Long dayAgo = until.getTime() - 86400000L;
    Long twoDaysAgo = dayAgo - 86400000L;
    Map<String, ErrorType> byKey = new Map<String, ErrorType>();
    Map<String, List<Long>> timesByKey = new Map<String, List<Long>>();
    for (
      OrgApiLog__c log : (List<OrgApiLog__c>) Database.queryWithBinds(
        soql,
        binds,
        AccessLevel.USER_MODE
      )
    ) {
      Integer status = log.StatusCode__c == null
        ? null
        : log.StatusCode__c.intValue();
      if (spec != null) {
        LogPoint p = new LogPoint();
        p.systemName = log.System__c;
        p.operation = log.Operation__c;
        p.statusCode = status;
        p.success = false;
        p.error = log.ErrorMessage__c?.left(1000).toLowerCase();
        if (!matches(spec, p)) {
          continue;
        }
      }
      String pattern = normalizeMessage(log.ErrorMessage__c);
      String key =
        (log.System__c == null ? 'Other' : log.System__c) +
        '|' +
        status +
        '|' +
        pattern;
      ErrorType type = byKey.get(key);
      if (type == null) {
        type = new ErrorType();
        type.key = EncodingUtil.convertToHex(
          Crypto.generateDigest('MD5', Blob.valueOf(key))
        );
        type.systemName = log.System__c == null ? 'Other' : log.System__c;
        type.statusCode = status;
        type.pattern = String.isBlank(pattern) ? '(no error message)' : pattern;
        type.sampleMessage = log.ErrorMessage__c?.abbreviate(300);
        type.sampleLogId = log.Id;
        type.operation = log.Operation__c;
        type.containsHint = containsHint(log.ErrorMessage__c);
        type.lastAt = log.CalledAt__c;
        type.daily = new List<Integer>();
        for (Integer i = 0; i < Math.min(days, 30); i++) {
          type.daily.add(0);
        }
        byKey.put(key, type);
        timesByKey.put(key, new List<Long>());
      }
      type.count++;
      type.firstAt = log.CalledAt__c;
      Long at = log.CalledAt__c.getTime();
      timesByKey.get(key).add(at);
      if (at >= dayAgo) {
        type.last24h++;
      } else if (at >= twoDaysAgo) {
        type.previous24h++;
      }
      Integer index =
        type.daily.size() -
        1 -
        ((until.getTime() - at) / 86400000L).intValue();
      if (index >= 0 && index < type.daily.size()) {
        type.daily[index]++;
      }
    }
    // Pic sur une heure glissante (appels triés du plus récent au plus ancien)
    for (String key : byKey.keySet()) {
      List<Long> times = timesByKey.get(key);
      Integer best = 0;
      Integer j = 0;
      for (Integer i = 0; i < times.size(); i++) {
        while (times[j] - times[i] > 3600000L) {
          j++;
        }
        best = Math.max(best, i - j + 1);
      }
      byKey.get(key).peakPerHour = best;
    }
    List<ErrorType> types = byKey.values();
    // Tri par nombre décroissant (tri par insertion : listes courtes)
    for (Integer i = 1; i < types.size(); i++) {
      ErrorType current = types[i];
      Integer k = i - 1;
      while (k >= 0 && types[k].count < current.count) {
        types[k + 1] = types[k];
        k--;
      }
      types[k + 1] = current;
    }
    List<ErrorType> result = new List<ErrorType>();
    for (Integer i = 0; i < Math.min(maxTypes, types.size()); i++) {
      result.add(types[i]);
    }
    return result;
  }

  /** Message sans les parties variables (Ids, GUID, e-mails, nombres), pour regrouper les erreurs. */
  @TestVisible
  private static String normalizeMessage(String message) {
    if (String.isBlank(message)) {
      return '';
    }
    String text = message.left(400);
    text = GUID.matcher(text).replaceAll('<guid>');
    text = EMAIL.matcher(text).replaceAll('<email>');
    text = RECORD_ID.matcher(text).replaceAll('<id>');
    text = HEX.matcher(text).replaceAll('<hex>');
    text = DIGITS.matcher(text).replaceAll('#');
    text = SPACES.matcher(text).replaceAll(' ').trim();
    return text.abbreviate(160);
  }

  /** Plus long fragment fixe du message : texte « contient » proposé pour une règle. */
  @TestVisible
  private static String containsHint(String message) {
    String normalized = normalizeMessage(message);
    if (String.isBlank(normalized)) {
      return null;
    }
    String best = '';
    for (
      String part : normalized.split('<guid>|<email>|<id>|<hex>|#|\\.\\.\\.')
    ) {
      String candidate = part.trim().replaceAll('^[^A-Za-z]+|[^A-Za-z)]+$', '');
      if (candidate.length() > best.length()) {
        best = candidate;
      }
    }
    return best.length() < 4 ? null : best.abbreviate(80);
  }

  // ---------- Conversions ----------

  private static List<OrgApiAlertRule__c> queryRules(
    Id onlyRuleId,
    AccessLevel mode
  ) {
    String soql =
      'SELECT Id, Name, Active__c, Description__c, System__c, OperationContains__c, Metric__c, Comparator__c,' +
      ' Threshold__c, WindowMinutes__c, StatusCodes__c, ErrorContains__c, SlowThresholdMs__c, MinimumCalls__c,' +
      ' Severity__c, Channels__c, Recipients__c, TaskOwner__c, TaskOwner__r.Name, CooldownMinutes__c,' +
      ' LastEvaluatedAt__c, LastValue__c, LastTriggeredAt__c, TriggerCount__c' +
      ' FROM OrgApiAlertRule__c' +
      (onlyRuleId != null ? ' WHERE Id = :ruleId' : '') +
      ' ORDER BY Active__c DESC, Name LIMIT ' +
      MAX_RULES;
    return (List<OrgApiAlertRule__c>) Database.queryWithBinds(
      soql,
      new Map<String, Object>{ 'ruleId' => onlyRuleId },
      mode
    );
  }

  private static RuleSpec toSpec(OrgApiAlertRule__c record) {
    RuleSpec spec = new RuleSpec();
    spec.id = record.Id;
    spec.name = record.Name;
    spec.active = record.Active__c;
    spec.description = record.Description__c;
    spec.systemName = record.System__c;
    spec.operationContains = record.OperationContains__c;
    spec.metric = record.Metric__c;
    spec.comparator = record.Comparator__c;
    spec.threshold = record.Threshold__c;
    spec.windowMinutes = record.WindowMinutes__c?.intValue();
    spec.statusCodes = record.StatusCodes__c;
    spec.errorContains = record.ErrorContains__c;
    spec.slowThresholdMs = record.SlowThresholdMs__c?.intValue();
    spec.minimumCalls = record.MinimumCalls__c?.intValue();
    spec.severity = record.Severity__c;
    spec.channels = String.isBlank(record.Channels__c)
      ? new List<String>()
      : record.Channels__c.split(';');
    spec.recipients = record.Recipients__c;
    spec.taskOwnerId = record.TaskOwner__c;
    spec.taskOwnerName = record.TaskOwner__r?.Name;
    spec.cooldownMinutes = record.CooldownMinutes__c?.intValue();
    spec.lastEvaluatedAt = record.LastEvaluatedAt__c;
    spec.lastValue = record.LastValue__c;
    spec.lastTriggeredAt = record.LastTriggeredAt__c;
    spec.triggerCount = record.TriggerCount__c == null
      ? 0
      : record.TriggerCount__c.intValue();
    normalize(spec);
    return spec;
  }

  private static AlertEvent toEvent(OrgApiAlertEvent__c record) {
    AlertEvent event = new AlertEvent();
    event.id = record.Id;
    event.name = record.Name;
    event.ruleId = record.Rule__c;
    event.ruleName = record.Rule__r?.Name;
    event.severity = record.Rule__r?.Severity__c;
    event.metric = record.Rule__r?.Metric__c;
    event.comparator = record.Rule__r?.Comparator__c;
    event.firedAt = record.FiredAt__c;
    event.value = record.Value__c;
    event.threshold = record.Threshold__c;
    event.windowStart = record.WindowStart__c;
    event.windowEnd = record.WindowEnd__c;
    event.summary = record.Summary__c;
    event.status = record.Status__c;
    event.channels = record.Channels__c;
    event.deliveryErrors = record.DeliveryErrors__c;
    event.taskId = record.TaskId__c;
    event.acknowledgedAt = record.AcknowledgedAt__c;
    event.acknowledgedBy = record.AcknowledgedBy__r?.Name;
    return event;
  }

  /** Valeurs par défaut et nettoyage d'une règle (interface ou enregistrement). */
  private static void normalize(RuleSpec spec) {
    spec.name = spec.name?.trim();
    spec.systemName = String.isBlank(spec.systemName)
      ? null
      : spec.systemName.trim();
    spec.operationContains = String.isBlank(spec.operationContains)
      ? null
      : spec.operationContains.trim();
    spec.statusCodes = String.isBlank(spec.statusCodes)
      ? null
      : spec.statusCodes.trim();
    spec.errorContains = String.isBlank(spec.errorContains)
      ? null
      : spec.errorContains.trim();
    spec.metric = String.isBlank(spec.metric) ? 'Errors' : spec.metric;
    spec.comparator = String.isBlank(spec.comparator)
      ? 'AtLeast'
      : spec.comparator;
    spec.windowMinutes = spec.windowMinutes == null ||
      spec.windowMinutes <= 0
      ? 60
      : spec.windowMinutes;
    spec.cooldownMinutes = spec.cooldownMinutes == null ||
      spec.cooldownMinutes < 0
      ? 60
      : spec.cooldownMinutes;
    spec.severity = String.isBlank(spec.severity) ? 'High' : spec.severity;
    spec.channels = spec.channels == null ? new List<String>() : spec.channels;
    if (spec.metric == 'SlowCalls' && spec.slowThresholdMs == null) {
      spec.slowThresholdMs = 5000;
    }
    if (spec.metric == 'ErrorRate' && spec.minimumCalls == null) {
      spec.minimumCalls = 10;
    }
  }

  private static void validate(RuleSpec spec) {
    List<String> problems = new List<String>();
    if (String.isBlank(spec.name)) {
      problems.add('Give the rule a name.');
    }
    if (spec.threshold == null || spec.threshold < 0) {
      problems.add('Set a threshold (0 or more).');
    }
    if (spec.windowMinutes < 5 || spec.windowMinutes > 10080) {
      problems.add('The window must be between 5 minutes and 7 days.');
    }
    if (
      spec.metric == 'ErrorRate' &&
      spec.threshold != null &&
      spec.threshold > 100
    ) {
      problems.add('An error rate threshold cannot exceed 100%.');
    }
    if (spec.channels.isEmpty()) {
      problems.add(
        'Choose at least one channel (email, task or notification).'
      );
    }
    if (spec.channels.contains('Email')) {
      List<String> emails = parseEmails(spec.recipients);
      if (emails.isEmpty()) {
        problems.add('Add at least one email recipient.');
      }
      for (
        String token : (spec.recipients == null ? '' : spec.recipients)
          .split('[,;\\s]+')
      ) {
        if (
          String.isNotBlank(token) && !EMAIL.matcher(token.trim()).matches()
        ) {
          problems.add('Invalid email address: ' + token.trim());
        }
      }
    }
    if (String.isNotBlank(spec.statusCodes)) {
      for (String token : spec.statusCodes.toLowerCase().split('[,;\\s]+')) {
        if (
          String.isNotBlank(token) &&
          !Pattern.matches('[0-9]{1,3}|[1-5]xx', token)
        ) {
          problems.add(
            'Invalid status code "' + token + '": use 401, 4xx, 5xx or 0.'
          );
        }
      }
    }
    if (!problems.isEmpty()) {
      throw new IllegalArgumentException(String.join(problems, ' '));
    }
  }

  private static List<String> parseEmails(String recipients) {
    List<String> result = new List<String>();
    if (String.isBlank(recipients)) {
      return result;
    }
    for (String token : recipients.split('[,;\\s]+')) {
      if (String.isNotBlank(token) && EMAIL.matcher(token.trim()).matches()) {
        result.add(token.trim());
      }
    }
    return result;
  }

  private static final Map<String, String> METRIC_LABELS = new Map<String, String>{
    'Errors' => 'errors',
    'Calls' => 'calls',
    'ErrorRate' => 'error rate',
    'AvgDuration' => 'average duration',
    'SlowCalls' => 'slow calls'
  };

  private static String formatValue(RuleSpec spec, Decimal value) {
    if (value == null) {
      return 'n/a';
    }
    switch on spec.metric {
      when 'ErrorRate' {
        return value.setScale(1) + '% errors';
      }
      when 'AvgDuration' {
        return value.setScale(0) + ' ms on average';
      }
      when 'SlowCalls' {
        return value.intValue() + ' slow call(s)';
      }
      when 'Calls' {
        return value.intValue() + ' call(s)';
      }
      when else {
        return value.intValue() + ' error(s)';
      }
    }
  }

  /** Règle en une phrase (e-mail et tâche). */
  public static String describe(RuleSpec spec) {
    String scope = spec.systemName == null ? 'all systems' : spec.systemName;
    String text =
      'When ' +
      METRIC_LABELS.get(spec.metric) +
      ' on ' +
      scope +
      (spec.operationContains == null
        ? ''
        : ' (operation contains "' + spec.operationContains + '")') +
      (spec.statusCodes == null ? '' : ', status ' + spec.statusCodes) +
      (spec.errorContains == null
        ? ''
        : ', error contains "' + spec.errorContains + '"') +
      (spec.metric == 'SlowCalls'
        ? ' (slower than ' + spec.slowThresholdMs + ' ms)'
        : '') +
      ' is ' +
      (spec.comparator == 'AtMost' ? 'at most ' : 'at least ') +
      (spec.threshold == null
        ? '?'
        : String.valueOf(spec.threshold.stripTrailingZeros().toPlainString())) +
      (spec.metric == 'ErrorRate'
        ? '%'
        : spec.metric == 'AvgDuration' ? ' ms' : '') +
      ' within ' +
      windowLabel(spec.windowMinutes) +
      '.';
    return text;
  }

  private static String windowLabel(Integer minutes) {
    if (minutes >= 1440 && Math.mod(minutes, 1440) == 0) {
      return minutes / 1440 + (minutes == 1440 ? ' day' : ' days');
    }
    if (minutes >= 60 && Math.mod(minutes, 60) == 0) {
      return minutes / 60 + (minutes == 60 ? ' hour' : ' hours');
    }
    return minutes + ' minutes';
  }

  private static String buildSummary(
    RuleSpec spec,
    Decimal value,
    Counter counter,
    List<LogPoint> matched
  ) {
    String text =
      formatValue(spec, value) +
      ' in the last ' +
      windowLabel(spec.windowMinutes) +
      ' — threshold: ' +
      (spec.comparator == 'AtMost' ? 'at most ' : 'at least ') +
      spec.threshold.stripTrailingZeros().toPlainString() +
      '.\n' +
      describe(spec) +
      '\n' +
      'Window: ' +
      counter.calls +
      ' matching call(s), ' +
      counter.errors +
      ' error(s).';
    Map<String, Integer> patterns = new Map<String, Integer>();
    for (LogPoint p : matched) {
      if (p.success == true) {
        continue;
      }
      String key =
        (p.statusCode == null ? 'no status' : 'HTTP ' + p.statusCode) +
        ' · ' +
        (p.rawError == null ? '(no message)' : normalizeMessage(p.rawError));
      patterns.put(
        key,
        (patterns.containsKey(key) ? patterns.get(key) : 0) + 1
      );
    }
    if (!patterns.isEmpty()) {
      text += '\nMain error types:';
      Integer shown = 0;
      while (!patterns.isEmpty() && shown < 3) {
        String bestKey = null;
        for (String key : patterns.keySet()) {
          if (bestKey == null || patterns.get(key) > patterns.get(bestKey)) {
            bestKey = key;
          }
        }
        text += '\n• ' + patterns.get(bestKey) + ' × ' + bestKey;
        patterns.remove(bestKey);
        shown++;
      }
    }
    return text.abbreviate(32000);
  }
}
