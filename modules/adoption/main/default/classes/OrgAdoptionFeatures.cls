/**
 * Catalogue des fonctionnalités natives de Salesforce et mesure de leur utilisation réelle dans
 * l'org : Sales Cloud (pistes, conversion, opportunités, produits, devis, prévisions...), Service
 * Cloud (requêtes, Email-to-Case, Knowledge, Omni-Channel...), plateforme (Lightning, mobile,
 * rapports, Chatter, approbations...), Experience Cloud et Field Service.
 *
 * Chaque fonctionnalité reçoit un statut :
 * - Adopted : utilisée régulièrement (seuil propre à la fonctionnalité) ;
 * - Partial : activée ou utilisée ponctuellement ;
 * - Not used : disponible mais jamais utilisée sur la période ;
 * - Not enabled : objet absent de l'org (fonctionnalité désactivée ou non incluse dans le contrat) ;
 * - Unknown : mesure impossible (droits, édition, limites atteintes).
 *
 * Mesures par comptages plafonnés (CAP) : seuls des nombres sortent, jamais de données métier.
 * Mode système (classe sans partage) pour compter tous les enregistrements, l'action est réservée
 * aux administrateurs Org Intelligence (OrgAdoptionController).
 */
public without sharing class OrgAdoptionFeatures {
  public static final String ADOPTED = 'Adopted';
  public static final String PARTIAL = 'Partial';
  public static final String NOT_USED = 'Not used';
  public static final String NOT_ENABLED = 'Not enabled';
  public static final String UNKNOWN = 'Unknown';

  public static final String SALES = 'Sales Cloud';
  public static final String SERVICE = 'Service Cloud';
  public static final String PLATFORM = 'Platform';
  public static final String EXPERIENCE = 'Experience Cloud';
  public static final String FIELD_SERVICE = 'Field Service';

  /** Clouds dans l'ordre d'affichage. */
  public static final List<String> CLOUD_ORDER = new List<String>{
    SALES,
    SERVICE,
    PLATFORM,
    EXPERIENCE,
    FIELD_SERVICE
  };

  /** Plafond de chaque comptage (« 200+ ») : la limite des 50 000 lignes reste loin. */
  @TestVisible
  private static final Integer CAP = 200;

  private static final String TRAILHEAD_SEARCH = 'https://trailhead.salesforce.com/search?keywords=';

  public class Feature {
    public String key;
    public String cloud;
    public String label;
    public Integer weight;
    public String description;
    public String benefit;
    public String nextStep;
    public String learnUrl;
    public String status;
    public String metric;
    public Decimal value;
  }

  public class CloudSummary {
    public String name;
    public Boolean detected = false;
    public Boolean selected = false;
    public String signal;
    public Integer evaluated = 0;
    public Integer adopted = 0;
    public Integer partial = 0;
    public Integer unused = 0;
    public Integer notEnabled = 0;
    public Integer score;
  }

  private Map<String, Schema.SObjectType> globalDescribe = Schema.getGlobalDescribe();
  private OrgAdoptionLicenses.Result licenses;
  /** Mesures déjà faites, réutilisées par les fonctionnalités voisines (pistes → conversion...). */
  private Map<String, Integer> measures = new Map<String, Integer>();

  public OrgAdoptionFeatures(OrgAdoptionLicenses.Result licenses) {
    this.licenses = licenses;
  }

  // ---------- Évaluation ----------

  public List<Feature> evaluate() {
    List<Feature> features = catalog();
    for (Feature feature : features) {
      if (!hasBudget()) {
        feature.status = UNKNOWN;
        feature.metric = 'Not evaluated: the analysis reached the Salesforce query limits.';
        continue;
      }
      try {
        measure(feature);
      } catch (Exception e) {
        feature.status = UNKNOWN;
        feature.metric = 'Could not be measured: ' + e.getMessage();
      }
    }
    return features;
  }

  private Boolean hasBudget() {
    return Limits.getQueries() < Limits.getLimitQueries() - 6 &&
      Limits.getLimitQueryRows() - Limits.getQueryRows() > 2000;
  }

  /** Mesure d'une fonctionnalité : statut, phrase de mesure et valeur principale. */
  @SuppressWarnings('PMD.CognitiveComplexity,PMD.NcssMethodCount')
  private void measure(Feature f) {
    switch on f.key {
      // ---------- Sales Cloud ----------
      when 'LEADS' {
        Integer leads = leadsCreated();
        setLevel(
          f,
          leads,
          10,
          plural(leads, 'lead') + ' created in the last 90 days'
        );
      }
      when 'LEAD_CONVERSION' {
        Integer leads = leadsCreated();
        if (leads == 0) {
          apply(
            f,
            NOT_USED,
            0,
            'No leads created in the last 90 days, so nothing to convert.'
          );
          return;
        }
        Integer converted = count(
          'SELECT COUNT() FROM Lead WHERE IsConverted = true AND ConvertedDate = LAST_N_DAYS:90'
        );
        Decimal rate = ratio(converted, leads);
        String text =
          plural(converted, 'lead') +
          ' converted in the last 90 days (' +
          rate +
          ' % of the ' +
          display(leads) +
          ' created)';
        if (converted == 0) {
          apply(
            f,
            NOT_USED,
            0,
            'Leads are created but never converted: opportunities are probably created by hand, which loses the lead source and history.'
          );
        } else {
          apply(f, converted >= 5 && rate >= 5 ? ADOPTED : PARTIAL, rate, text);
        }
      }
      when 'LEAD_ASSIGNMENT' {
        assignmentRule(f, 'Lead', leadsCreated());
      }
      when 'OPPORTUNITIES' {
        Integer opportunities = opportunitiesCreated();
        setLevel(
          f,
          opportunities,
          10,
          plural(opportunities, 'opportunity', 'opportunities') +
          ' created in the last 90 days'
        );
      }
      when 'OPPORTUNITY_PRODUCTS' {
        Integer lines = recent('OpportunityLineItem', null, 90);
        Integer products = count(
          'SELECT COUNT() FROM Product2 WHERE IsActive = true'
        );
        String text =
          plural(lines, 'product line') +
          ' added to opportunities in the last 90 days, ' +
          plural(products, 'active product');
        if (lines == 0 && products > 0) {
          apply(
            f,
            PARTIAL,
            0,
            text + ': the catalogue exists but is not used on deals.'
          );
        } else {
          setLevel(f, lines, 5, text);
        }
      }
      when 'QUOTES' {
        if (
          !enabled(
            f,
            'Quote',
            'Quotes are not enabled (Setup › Quote Settings).'
          )
        ) {
          return;
        }
        Integer quotes = recent('Quote', null, 90);
        setLevel(
          f,
          quotes,
          3,
          plural(quotes, 'quote') + ' created in the last 90 days'
        );
      }
      when 'FORECASTS' {
        if (
          !enabled(
            f,
            'ForecastingType',
            'Collaborative Forecasts are not enabled (Setup › Forecasts Settings).'
          )
        ) {
          return;
        }
        Integer types = Database.query(
            'SELECT Id FROM ForecastingType WHERE IsActive = true LIMIT 50'
          )
          .size();
        apply(
          f,
          types > 0 ? ADOPTED : NOT_USED,
          types,
          plural(types, 'active forecast type')
        );
      }
      when 'CONTACT_ROLES' {
        Integer opportunities = opportunitiesCreated();
        Integer roles = recent('OpportunityContactRole', null, 90);
        if (opportunities == 0) {
          apply(
            f,
            NOT_USED,
            0,
            'No opportunities created in the last 90 days.'
          );
          return;
        }
        Decimal rate = ratio(roles, opportunities);
        String text =
          plural(roles, 'contact role') +
          ' added in the last 90 days for ' +
          plural(opportunities, 'new opportunity', 'new opportunities');
        apply(
          f,
          roles == 0 ? NOT_USED : rate >= 30 ? ADOPTED : PARTIAL,
          rate,
          text
        );
      }
      when 'OPPORTUNITY_TEAMS' {
        teamMembers(
          f,
          'OpportunityTeamMember',
          'Opportunity teams are not enabled (Setup › Opportunity Team Settings).'
        );
      }
      when 'ACCOUNT_TEAMS' {
        teamMembers(
          f,
          'AccountTeamMember',
          'Account teams are not enabled (Setup › Account Teams).'
        );
      }
      when 'TERRITORIES' {
        if (
          !enabled(
            f,
            'Territory2Model',
            'Enterprise Territory Management is not enabled (Setup › Territory Settings).'
          )
        ) {
          return;
        }
        Integer active = count(
          'SELECT COUNT() FROM Territory2Model WHERE State = \'Active\''
        );
        apply(
          f,
          active > 0 ? ADOPTED : NOT_USED,
          active,
          active > 0
            ? 'An active territory model'
            : 'Enabled but no active territory model'
        );
      }
      when 'ACTIVITIES' {
        Integer tasks = recent('Task', null, 30);
        Integer events = recent('Event', null, 30);
        setLevel(
          f,
          tasks + events,
          20,
          plural(tasks, 'task') +
            ' and ' +
            plural(events, 'event') +
            ' created in the last 30 days'
        );
      }
      when 'EMAIL' {
        Integer emails = recent('EmailMessage', 'Incoming = false', 30);
        setLevel(
          f,
          emails,
          10,
          plural(emails, 'outgoing email') +
          ' logged in Salesforce in the last 30 days'
        );
      }
      when 'CAMPAIGNS' {
        Integer campaigns = recent('Campaign', null, 365);
        Integer members = recent('CampaignMember', null, 90);
        String text =
          plural(campaigns, 'campaign') +
          ' created in the last 12 months, ' +
          plural(members, 'campaign member') +
          ' added in the last 90 days';
        apply(
          f,
          campaigns == 0
            ? NOT_USED
            : members > 0 && campaigns >= 3 ? ADOPTED : PARTIAL,
          campaigns,
          text
        );
      }
      when 'ORDERS' {
        Integer contracts = recent('Contract', null, 90);
        Integer orders = exists('Order') ? recent('Order', null, 90) : 0;
        setLevel(
          f,
          contracts + orders,
          5,
          plural(orders, 'order') +
            ' and ' +
            plural(contracts, 'contract') +
            ' created in the last 90 days'
        );
      }
      // ---------- Service Cloud ----------
      when 'CASES' {
        Integer cases = casesCreated();
        setLevel(
          f,
          cases,
          10,
          plural(cases, 'case') + ' created in the last 90 days'
        );
      }
      when 'CASE_ASSIGNMENT' {
        assignmentRule(f, 'Case', casesCreated());
      }
      when 'EMAIL_TO_CASE' {
        Integer emails = recent(
          'EmailMessage',
          'Incoming = true AND ParentId != null',
          90
        );
        setLevel(
          f,
          emails,
          5,
          plural(emails, 'incoming email') +
          ' received on cases in the last 90 days'
        );
      }
      when 'WEB_TO_CASE' {
        Integer cases = recent('Case', 'Origin = \'Web\'', 90);
        setLevel(
          f,
          cases,
          5,
          plural(cases, 'case') + ' with the origin "Web" in the last 90 days'
        );
      }
      when 'ENTITLEMENTS' {
        if (
          !enabled(
            f,
            'Entitlement',
            'Entitlement Management is not enabled (Setup › Entitlement Settings).'
          )
        ) {
          return;
        }
        Integer entitlements = count('SELECT COUNT() FROM Entitlement');
        Integer processes = exists('SlaProcess')
          ? count('SELECT COUNT() FROM SlaProcess WHERE IsActive = true')
          : 0;
        String text =
          plural(entitlements, 'entitlement') +
          ', ' +
          plural(
            processes,
            'active entitlement process',
            'active entitlement processes'
          );
        apply(
          f,
          entitlements > 0 &&
            processes > 0
            ? ADOPTED
            : entitlements + processes > 0 ? PARTIAL : NOT_USED,
          entitlements,
          text
        );
      }
      when 'KNOWLEDGE' {
        if (
          !enabled(
            f,
            'KnowledgeArticleVersion',
            'Lightning Knowledge is not enabled (Setup › Knowledge Settings).'
          )
        ) {
          return;
        }
        Integer articles = count(
          'SELECT COUNT() FROM KnowledgeArticleVersion WHERE PublishStatus = \'Online\' AND IsLatestVersion = true'
        );
        setLevel(f, articles, 10, plural(articles, 'published article'));
      }
      when 'OMNI_CHANNEL' {
        if (
          !enabled(
            f,
            'ServiceChannel',
            'Omni-Channel is not enabled (Setup › Omni-Channel Settings).'
          )
        ) {
          return;
        }
        Integer channels = count('SELECT COUNT() FROM ServiceChannel');
        Integer work = exists('AgentWork') ? recent('AgentWork', null, 30) : 0;
        String text =
          plural(channels, 'service channel') +
          ', ' +
          plural(work, 'work item') +
          ' routed in the last 30 days';
        apply(
          f,
          work > 0 ? ADOPTED : channels > 0 ? PARTIAL : NOT_USED,
          work,
          text
        );
      }
      when 'MACROS' {
        if (!enabled(f, 'Macro', 'Macros are not available in this org.')) {
          return;
        }
        Integer macros = count('SELECT COUNT() FROM Macro');
        setLevel(f, macros, 3, plural(macros, 'macro'));
      }
      when 'QUICK_TEXT' {
        if (
          !enabled(
            f,
            'QuickText',
            'Quick Text is not enabled (Setup › Quick Text Settings).'
          )
        ) {
          return;
        }
        Integer texts = count('SELECT COUNT() FROM QuickText');
        setLevel(f, texts, 5, plural(texts, 'Quick Text message'));
      }
      when 'MESSAGING' {
        Boolean messaging = exists('MessagingSession');
        Boolean chat = exists('LiveChatTranscript');
        if (!messaging && !chat) {
          apply(f, NOT_ENABLED, null, 'Messaging and Chat are not enabled.');
          return;
        }
        Integer sessions =
          (messaging ? recent('MessagingSession', null, 90) : 0) +
          (chat ? recent('LiveChatTranscript', null, 90) : 0);
        setLevel(
          f,
          sessions,
          10,
          plural(sessions, 'conversation') + ' in the last 90 days'
        );
      }
      when 'WORK_ORDERS' {
        if (
          !enabled(f, 'WorkOrder', 'Work orders are not available in this org.')
        ) {
          return;
        }
        Integer orders = recent('WorkOrder', null, 90);
        setLevel(
          f,
          orders,
          5,
          plural(orders, 'work order') + ' created in the last 90 days'
        );
      }
      // ---------- Plateforme ----------
      when 'LIGHTNING' {
        Integer active = licenses.activeInternalUsers;
        if (active == 0) {
          apply(f, UNKNOWN, null, 'No active internal users found.');
          return;
        }
        Integer lightning = Database.countQuery(
          'SELECT COUNT() FROM User WHERE IsActive = true AND UserType = \'Standard\' AND UserPreferencesLightningExperiencePreferred = true LIMIT 5000'
        );
        Decimal rate = ratio(lightning, active);
        apply(
          f,
          rate >= 90 ? ADOPTED : lightning > 0 ? PARTIAL : NOT_USED,
          rate,
          rate + ' % of active internal users work in Lightning Experience'
        );
      }
      when 'MOBILE' {
        // LoginHistory.Application n'est pas filtrable : tri en Apex sur les connexions récentes
        Integer sample = 2000;
        Integer logins = 0;
        List<LoginHistory> history = [
          SELECT Application
          FROM LoginHistory
          WHERE LoginTime = LAST_N_DAYS:30
          ORDER BY LoginTime DESC
          LIMIT :sample
        ];
        for (LoginHistory login : history) {
          String app = login.Application == null
            ? ''
            : login.Application.toLowerCase();
          if (
            app.contains('salesforce for ios') ||
            app.contains('salesforce for android')
          ) {
            logins++;
          }
        }
        String scope = history.size() >= sample
          ? ' among the latest ' + sample + ' logins'
          : ' in the last 30 days';
        Integer adoptedAt = 20;
        apply(
          f,
          logins >= adoptedAt ? ADOPTED : logins > 0 ? PARTIAL : NOT_USED,
          logins,
          logins +
            (logins == 1 ? ' mobile app login' : ' mobile app logins') +
            scope
        );
      }
      when 'REPORTS' {
        Integer run = count(
          'SELECT COUNT() FROM Report WHERE LastRunDate = LAST_N_DAYS:30'
        );
        Integer total = Database.countQuery(
          'SELECT COUNT() FROM Report LIMIT 5000'
        );
        setLevel(
          f,
          run,
          10,
          plural(run, 'report') +
            ' run in the last 30 days, out of ' +
            (total >= 5000 ? '5,000+' : String.valueOf(total))
        );
      }
      when 'DASHBOARDS' {
        Integer dashboards = count('SELECT COUNT() FROM Dashboard');
        Integer recentDashboards = count(
          'SELECT COUNT() FROM Dashboard WHERE LastModifiedDate = LAST_N_DAYS:180'
        );
        String text =
          plural(dashboards, 'dashboard') +
          ', ' +
          display(recentDashboards) +
          ' updated in the last 6 months';
        apply(
          f,
          dashboards == 0 ? NOT_USED : recentDashboards > 0 ? ADOPTED : PARTIAL,
          dashboards,
          text
        );
      }
      when 'CHATTER' {
        Integer posts = recent(
          'FeedItem',
          'Type IN (\'TextPost\', \'LinkPost\', \'ContentPost\')',
          30
        );
        setLevel(
          f,
          posts,
          20,
          plural(posts, 'Chatter post') + ' in the last 30 days'
        );
      }
      when 'FILES' {
        Integer files = recent('ContentVersion', 'IsLatest = true', 90);
        setLevel(
          f,
          files,
          20,
          plural(files, 'file') + ' uploaded in the last 90 days'
        );
      }
      when 'APPROVALS' {
        Integer processes = count(
          'SELECT COUNT() FROM ProcessDefinition WHERE Type = \'Approval\' AND State = \'Active\''
        );
        Integer requests = recent('ProcessInstance', null, 90);
        String text =
          plural(
            processes,
            'active approval process',
            'active approval processes'
          ) +
          ', ' +
          plural(requests, 'approval request') +
          ' in the last 90 days';
        apply(
          f,
          requests > 0 ? ADOPTED : processes > 0 ? PARTIAL : NOT_USED,
          requests,
          text
        );
      }
      when 'FLOWS' {
        Integer flows = Database.query(
            'SELECT Id FROM FlowDefinitionView WHERE IsActive = true AND ProcessType IN (\'Flow\', \'AutoLaunchedFlow\') LIMIT ' +
            CAP
          )
          .size();
        setLevel(f, flows, 3, plural(flows, 'active flow'));
      }
      when 'DUPLICATES' {
        Integer rules = count(
          'SELECT COUNT() FROM DuplicateRule WHERE IsActive = true'
        );
        apply(
          f,
          rules > 0 ? ADOPTED : NOT_USED,
          rules,
          plural(rules, 'active duplicate rule')
        );
      }
      // ---------- Experience Cloud ----------
      when 'SITES' {
        if (
          !enabled(
            f,
            'Network',
            'Digital Experiences are not enabled (Setup › Digital Experiences › Settings).'
          )
        ) {
          return;
        }
        Integer live = Database.query(
            'SELECT Id FROM Network WHERE Status = \'Live\' LIMIT 50'
          )
          .size();
        apply(
          f,
          live > 0 ? ADOPTED : NOT_USED,
          live,
          plural(live, 'live Experience Cloud site')
        );
      }
      when 'EXTERNAL_USERS' {
        Integer logins = count(
          'SELECT COUNT() FROM User WHERE IsActive = true AND UserType IN (\'PowerCustomerSuccess\', \'CspLitePortal\', \'PowerPartner\', \'CustomerSuccess\') AND LastLoginDate = LAST_N_DAYS:30'
        );
        setLevel(
          f,
          logins,
          10,
          plural(logins, 'external user') + ' logged in during the last 30 days'
        );
      }
      // ---------- Field Service ----------
      when 'SERVICE_APPOINTMENTS' {
        if (
          !enabled(
            f,
            'ServiceAppointment',
            'Field Service is not enabled (Setup › Field Service Settings).'
          )
        ) {
          return;
        }
        Integer appointments = recent('ServiceAppointment', null, 90);
        setLevel(
          f,
          appointments,
          10,
          plural(appointments, 'service appointment') +
          ' created in the last 90 days'
        );
      }
      when 'SCHEDULING' {
        if (
          !enabled(
            f,
            'ServiceResource',
            'Field Service is not enabled (Setup › Field Service Settings).'
          )
        ) {
          return;
        }
        Integer resources = count(
          'SELECT COUNT() FROM ServiceResource WHERE IsActive = true'
        );
        Integer territories = exists('ServiceTerritory')
          ? count('SELECT COUNT() FROM ServiceTerritory WHERE IsActive = true')
          : 0;
        String text =
          plural(resources, 'active service resource') +
          ', ' +
          plural(territories, 'service territory', 'service territories');
        apply(
          f,
          resources > 0 &&
            territories > 0
            ? ADOPTED
            : resources + territories > 0 ? PARTIAL : NOT_USED,
          resources,
          text
        );
      }
    }
  }

  // ---------- Mesures partagées ----------

  private Integer leadsCreated() {
    return cached('leads', 'Lead', null, 90);
  }

  private Integer opportunitiesCreated() {
    return cached('opportunities', 'Opportunity', null, 90);
  }

  private Integer casesCreated() {
    return cached('cases', 'Case', null, 90);
  }

  private Integer cached(
    String key,
    String objectName,
    String filter,
    Integer days
  ) {
    if (!measures.containsKey(key)) {
      measures.put(key, recent(objectName, filter, days));
    }
    return measures.get(key);
  }

  private void assignmentRule(Feature f, String objectName, Integer volume) {
    Integer rules = count(
      'SELECT COUNT() FROM AssignmentRule WHERE SobjectType = \'' +
        objectName +
        '\' AND Active = true'
    );
    String noun = objectName == 'Lead' ? 'leads' : 'cases';
    if (rules > 0) {
      apply(f, ADOPTED, rules, 'An active assignment rule distributes ' + noun);
    } else if (volume > 0) {
      apply(
        f,
        NOT_USED,
        0,
        'No active assignment rule while ' +
          display(volume) +
          ' ' +
          noun +
          ' were created in the last 90 days: they are assigned by hand.'
      );
    } else {
      apply(f, NOT_USED, 0, 'No active assignment rule.');
    }
  }

  private void teamMembers(Feature f, String objectName, String disabledText) {
    if (!enabled(f, objectName, disabledText)) {
      return;
    }
    Integer members = count('SELECT COUNT() FROM ' + objectName);
    setLevel(f, members, 5, plural(members, 'team member'));
  }

  // ---------- Outils ----------

  private Boolean exists(String objectName) {
    return globalDescribe.containsKey(objectName.toLowerCase());
  }

  /** Objet présent ; sinon la fonctionnalité passe « Not enabled » avec le texte fourni. */
  private Boolean enabled(Feature f, String objectName, String disabledText) {
    if (exists(objectName)) {
      return true;
    }
    apply(f, NOT_ENABLED, null, disabledText);
    return false;
  }

  /** Enregistrements créés sur les N derniers jours (plafonné). */
  private Integer recent(String objectName, String filter, Integer days) {
    if (!exists(objectName)) {
      return 0;
    }
    return count(
      'SELECT COUNT() FROM ' +
        objectName +
        ' WHERE CreatedDate = LAST_N_DAYS:' +
        days +
        (String.isBlank(filter) ? '' : ' AND ' + filter)
    );
  }

  /**
   * Comptage plafonné à CAP. Certains objets refusent COUNT() (FeedItem, objets de configuration) :
   * repli sur une sélection d'identifiants limitée.
   */
  private Integer count(String countQuery) {
    try {
      return Database.countQuery(countQuery + ' LIMIT ' + CAP);
    } catch (QueryException e) {
      String idQuery = countQuery.replaceFirst(
        'SELECT COUNT\\(\\)',
        'SELECT Id'
      );
      return Database.query(idQuery + ' LIMIT ' + CAP).size();
    }
  }

  private void setLevel(
    Feature f,
    Integer value,
    Integer adoptedAt,
    String text
  ) {
    apply(
      f,
      value >= adoptedAt ? ADOPTED : value > 0 ? PARTIAL : NOT_USED,
      value,
      text
    );
  }

  private void apply(Feature f, String status, Decimal value, String text) {
    f.status = status;
    f.value = value;
    f.metric = text;
  }

  private static Decimal ratio(Integer part, Integer total) {
    if (total == null || total == 0) {
      return 0;
    }
    return Math.min(Decimal.valueOf(100), Decimal.valueOf(part) * 100 / total)
      .setScale(0);
  }

  private static String display(Integer value) {
    return value >= CAP ? CAP + '+' : String.valueOf(value);
  }

  private static String plural(Integer value, String noun) {
    return plural(value, noun, noun + 's');
  }

  private static String plural(Integer value, String noun, String nouns) {
    return display(value) + ' ' + (value == 1 ? noun : nouns);
  }

  // ---------- Clouds ----------

  /** Clouds détectés dans l'org, avec le signal qui les révèle. */
  public Map<String, CloudSummary> detectClouds(List<Feature> features) {
    Map<String, CloudSummary> clouds = new Map<String, CloudSummary>();
    for (String name : CLOUD_ORDER) {
      CloudSummary summary = new CloudSummary();
      summary.name = name;
      clouds.put(name, summary);
    }
    Set<String> names = OrgAdoptionLicenses.licenseNames(licenses);
    Map<String, Feature> byKey = new Map<String, Feature>();
    for (Feature feature : features) {
      byKey.put(feature.key, feature);
    }

    Boolean fullLicense = names.contains('salesforce');
    if (
      fullLicense ||
      isUsed(byKey, 'OPPORTUNITIES') ||
      isUsed(byKey, 'LEADS')
    ) {
      detect(
        clouds,
        SALES,
        fullLicense
          ? 'Salesforce user licenses'
          : 'Leads or opportunities in use'
      );
    }
    Integer serviceUsers = OrgAdoptionLicenses.featureLicenseCount(
      licenses,
      'UserPermissionsSupportUser'
    );
    if (serviceUsers > 0) {
      detect(
        clouds,
        SERVICE,
        serviceUsers + ' Service Cloud User feature license(s) assigned'
      );
    } else if (
      isUsed(byKey, 'CASES') ||
      isUsed(byKey, 'KNOWLEDGE') ||
      isUsed(byKey, 'OMNI_CHANNEL')
    ) {
      detect(clouds, SERVICE, 'Cases, Knowledge or Omni-Channel in use');
    }
    detect(clouds, PLATFORM, 'Included in every edition');
    if (
      containsAny(
        names,
        new List<String>{ 'community', 'partner', 'customer', 'external' }
      )
    ) {
      detect(clouds, EXPERIENCE, 'External user licenses');
    } else if (
      byKey.containsKey('SITES') && byKey.get('SITES').status != NOT_ENABLED
    ) {
      detect(clouds, EXPERIENCE, 'Digital Experiences enabled');
    }
    if (containsAny(names, new List<String>{ 'field service' })) {
      detect(clouds, FIELD_SERVICE, 'Field Service licenses');
    } else if (isUsed(byKey, 'SERVICE_APPOINTMENTS')) {
      detect(clouds, FIELD_SERVICE, 'Service appointments in use');
    }
    return clouds;
  }

  private static void detect(
    Map<String, CloudSummary> clouds,
    String name,
    String signal
  ) {
    clouds.get(name).detected = true;
    clouds.get(name).signal = signal;
  }

  private static Boolean isUsed(Map<String, Feature> byKey, String key) {
    Feature feature = byKey.get(key);
    return feature != null &&
      (feature.status == ADOPTED ||
      feature.status == PARTIAL);
  }

  private static Boolean containsAny(Set<String> names, List<String> hints) {
    for (String name : names) {
      for (String fragment : hints) {
        if (name.contains(fragment)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Score d'adoption (0-100) sur les clouds retenus : Adopted = 1, Partial = 0,5, sinon 0, pondéré
   * par l'importance de la fonctionnalité ; les fonctionnalités non mesurables sont exclues.
   * Remplit aussi les compteurs de chaque cloud.
   */
  public static Integer score(
    List<Feature> features,
    Map<String, CloudSummary> clouds
  ) {
    Decimal points = 0;
    Decimal weights = 0;
    Map<String, Decimal[]> perCloud = new Map<String, Decimal[]>();
    for (Feature feature : features) {
      CloudSummary cloud = clouds.get(feature.cloud);
      if (cloud == null || feature.status == UNKNOWN) {
        continue;
      }
      cloud.evaluated++;
      Decimal earned = 0;
      if (feature.status == ADOPTED) {
        cloud.adopted++;
        earned = 1;
      } else if (feature.status == PARTIAL) {
        cloud.partial++;
        earned = 0.5;
      } else if (feature.status == NOT_USED) {
        cloud.unused++;
      } else if (feature.status == NOT_ENABLED) {
        cloud.notEnabled++;
      }
      if (!perCloud.containsKey(cloud.name)) {
        perCloud.put(cloud.name, new List<Decimal>{ 0, 0 });
      }
      perCloud.get(cloud.name)[0] += earned * feature.weight;
      perCloud.get(cloud.name)[1] += feature.weight;
      if (cloud.selected) {
        points += earned * feature.weight;
        weights += feature.weight;
      }
    }
    for (String name : perCloud.keySet()) {
      Decimal[] totals = perCloud.get(name);
      clouds.get(name).score = totals[1] == 0
        ? null
        : (totals[0] *
            100 /
            totals[1])
            .round(System.RoundingMode.HALF_UP)
            .intValue();
    }
    return weights == 0
      ? null
      : (points * 100 / weights).round(System.RoundingMode.HALF_UP).intValue();
  }

  // ---------- Catalogue ----------

  private static Feature define(
    String key,
    String cloud,
    String label,
    Integer weight,
    String description,
    String benefit,
    String nextStep,
    String learnKeywords
  ) {
    Feature feature = new Feature();
    feature.key = key;
    feature.cloud = cloud;
    feature.label = label;
    feature.weight = weight;
    feature.description = description;
    feature.benefit = benefit;
    feature.nextStep = nextStep;
    feature.learnUrl =
      TRAILHEAD_SEARCH + EncodingUtil.urlEncode(learnKeywords, 'UTF-8');
    return feature;
  }

  /** Fonctionnalités évaluées. Poids 2 = fonctionnalité centrale du cloud, 1 = complémentaire. */
  @TestVisible
  private static List<Feature> catalog() {
    return new List<Feature>{
      // Sales Cloud
      define(
        'LEADS',
        SALES,
        'Lead management',
        2,
        'Capture prospects as leads before they become accounts, contacts and opportunities.',
        'Separates prospecting from the customer base and measures lead sources.',
        'Create leads from your web forms (Web-to-Lead) or imports and work them from lead list views.',
        'lead management'
      ),
      define(
        'LEAD_CONVERSION',
        SALES,
        'Lead conversion',
        2,
        'Convert a qualified lead into an account, a contact and an opportunity in one click.',
        'Keeps the lead source on the opportunity and measures the conversion rate of your funnel.',
        'Agree on qualification criteria, then convert leads instead of creating opportunities by hand.',
        'lead conversion'
      ),
      define(
        'LEAD_ASSIGNMENT',
        SALES,
        'Lead assignment rules',
        1,
        'Route new leads automatically to the right owner or queue.',
        'Faster follow-up, no lead left without an owner.',
        'Create an assignment rule (Setup › Lead Assignment Rules) and activate it.',
        'lead assignment rules'
      ),
      define(
        'OPPORTUNITIES',
        SALES,
        'Opportunity pipeline',
        2,
        'Track deals by stage, amount and close date.',
        'Pipeline visibility, forecasting and win-rate analysis.',
        'Log every deal as an opportunity and keep stages up to date.',
        'opportunity management'
      ),
      define(
        'OPPORTUNITY_PRODUCTS',
        SALES,
        'Products and price books',
        1,
        'Add products from a price book to opportunities.',
        'Revenue by product, consistent prices and quotes generated from the deal.',
        'Load your catalogue in Products and price books, then add product lines to opportunities.',
        'products price books'
      ),
      define(
        'QUOTES',
        SALES,
        'Quotes',
        1,
        'Generate quotes (PDF) from an opportunity and sync the accepted one.',
        'No more quotes built outside Salesforce, history kept on the deal.',
        'Enable Quotes (Setup › Quote Settings), add the related list and a PDF template.',
        'quotes'
      ),
      define(
        'FORECASTS',
        SALES,
        'Collaborative forecasts',
        1,
        'Forecast revenue by period and by team, with manager adjustments.',
        'Reliable revenue forecast without spreadsheets.',
        'Enable Forecasts (Setup › Forecasts Settings) and add a forecast type on opportunities.',
        'collaborative forecasts'
      ),
      define(
        'CONTACT_ROLES',
        SALES,
        'Opportunity contact roles',
        1,
        'Name the decision makers and influencers of each deal.',
        'Know who buys, and measure campaign influence on revenue.',
        'Make contact roles part of your sales process (Path guidance or a validation rule at a given stage).',
        'opportunity contact roles'
      ),
      define(
        'OPPORTUNITY_TEAMS',
        SALES,
        'Opportunity teams',
        1,
        'Several people working on the same deal, with their role and access.',
        'Shared visibility and credit for team selling.',
        'Enable Opportunity Teams and set default teams for your sellers.',
        'opportunity teams'
      ),
      define(
        'ACCOUNT_TEAMS',
        SALES,
        'Account teams',
        1,
        'Define who works on each key account and with which access.',
        'Clear account ownership for key accounts and sharing without custom rules.',
        'Enable Account Teams (Setup › Account Teams).',
        'account teams'
      ),
      define(
        'TERRITORIES',
        SALES,
        'Territory management',
        1,
        'Organise accounts and sellers by territory, with its own sharing and forecasts.',
        'Fair coverage of the market and forecasts by territory.',
        'Enable Enterprise Territory Management, build a model and activate it.',
        'enterprise territory management'
      ),
      define(
        'ACTIVITIES',
        SALES,
        'Activities',
        2,
        'Log calls, meetings and tasks on records.',
        'Full customer history and follow-up reminders for everyone.',
        'Log activities from the activity timeline, or sync calendars with Einstein Activity Capture.',
        'activities tasks events'
      ),
      define(
        'EMAIL',
        SALES,
        'Email from Salesforce',
        1,
        'Send and log emails from records, with templates.',
        'Customer emails visible to the whole team, reusable templates.',
        'Connect Outlook or Gmail (integration) and create Lightning email templates.',
        'email integration'
      ),
      define(
        'CAMPAIGNS',
        SALES,
        'Campaigns',
        1,
        'Track marketing actions, their members and the revenue they influence.',
        'Measure the return on events and marketing actions.',
        'Give the Marketing User license to marketing users and create campaigns for your events.',
        'campaigns'
      ),
      define(
        'ORDERS',
        SALES,
        'Contracts and orders',
        1,
        'Record contracts and orders after a deal is won.',
        'Continuity from deal to delivery and renewals.',
        'Enable Orders (Setup › Order Settings) and create them from won opportunities.',
        'contracts orders'
      ),
      // Service Cloud
      define(
        'CASES',
        SERVICE,
        'Case management',
        2,
        'Track customer requests as cases, with status and priority.',
        'Shared view of every customer request, response times you can measure.',
        'Create cases from every channel (email, web, phone) instead of tracking requests by email.',
        'case management'
      ),
      define(
        'CASE_ASSIGNMENT',
        SERVICE,
        'Case assignment rules',
        1,
        'Route new cases automatically to the right queue or agent.',
        'Faster first response, workload spread evenly.',
        'Create an assignment rule (Setup › Case Assignment Rules) and activate it.',
        'case assignment rules'
      ),
      define(
        'EMAIL_TO_CASE',
        SERVICE,
        'Email-to-Case',
        1,
        'Turn emails sent to your support addresses into cases automatically.',
        'No more shared mailboxes: every email becomes a tracked case.',
        'Set up Email-to-Case (Setup › Email-to-Case) with your support address.',
        'email-to-case'
      ),
      define(
        'WEB_TO_CASE',
        SERVICE,
        'Web-to-Case',
        1,
        'Create cases from a form on your website.',
        'Customers reach support without email, with structured information.',
        'Generate a Web-to-Case form (Setup › Web-to-Case).',
        'web-to-case'
      ),
      define(
        'ENTITLEMENTS',
        SERVICE,
        'Entitlements and milestones',
        1,
        'Define service levels (SLA) and track milestones on cases.',
        'Commitments to customers measured and escalated automatically.',
        'Enable Entitlement Management and create an entitlement process.',
        'entitlement management'
      ),
      define(
        'KNOWLEDGE',
        SERVICE,
        'Knowledge base',
        1,
        'Write and share help articles with agents and customers.',
        'Faster answers, fewer cases thanks to self-service.',
        'Enable Lightning Knowledge and publish answers to frequent questions.',
        'lightning knowledge'
      ),
      define(
        'OMNI_CHANNEL',
        SERVICE,
        'Omni-Channel routing',
        1,
        'Push work to available agents according to their capacity and skills.',
        'Balanced workload and shorter waiting times.',
        'Enable Omni-Channel, create a service channel and a routing configuration.',
        'omni-channel'
      ),
      define(
        'MACROS',
        SERVICE,
        'Macros',
        1,
        'Automate repetitive steps of agents in one click.',
        'Time saved on every case, consistent answers.',
        'Create macros for the most frequent replies and actions.',
        'macros service console'
      ),
      define(
        'QUICK_TEXT',
        SERVICE,
        'Quick Text',
        1,
        'Insert ready-made messages in emails and chats.',
        'Consistent and faster answers.',
        'Enable Quick Text and write the most common messages.',
        'quick text'
      ),
      define(
        'MESSAGING',
        SERVICE,
        'Messaging and chat',
        1,
        'Talk to customers on the website, WhatsApp, SMS or Facebook.',
        'Customers reach you on their channel, conversations kept on the record.',
        'Set up Messaging for In-App and Web, or another messaging channel.',
        'messaging for in-app and web'
      ),
      define(
        'WORK_ORDERS',
        SERVICE,
        'Work orders',
        1,
        'Track work to perform for a customer, with its line items.',
        'Clear follow-up of interventions linked to cases and assets.',
        'Use work orders for interventions instead of tasks or custom objects.',
        'work orders'
      ),
      // Plateforme
      define(
        'LIGHTNING',
        PLATFORM,
        'Lightning Experience',
        2,
        'The current Salesforce interface, where every new feature ships.',
        'Access to all recent features (Dynamic Forms, Path, in-app guidance...).',
        'Switch the remaining users to Lightning and remove the Classic switcher.',
        'lightning experience adoption'
      ),
      define(
        'MOBILE',
        PLATFORM,
        'Salesforce mobile app',
        1,
        'Access Salesforce from a phone, included in every license.',
        'Sellers and technicians update records on the go.',
        'Promote the app, and check the mobile layouts of your main objects.',
        'salesforce mobile app'
      ),
      define(
        'REPORTS',
        PLATFORM,
        'Reports',
        2,
        'Built-in reports on every object.',
        'Decisions on live data, without exports to spreadsheets.',
        'Build the reports your teams export today, and delete those nobody runs.',
        'reports dashboards'
      ),
      define(
        'DASHBOARDS',
        PLATFORM,
        'Dashboards',
        1,
        'Visual summary of key figures, refreshed from reports.',
        'Managers follow activity without asking for figures.',
        'Create one dashboard per team with its key indicators, and subscribe managers to it.',
        'dashboards'
      ),
      define(
        'CHATTER',
        PLATFORM,
        'Chatter collaboration',
        1,
        'Discuss on records and groups, mention colleagues.',
        'Fewer internal emails, decisions kept on the record.',
        'Use @mentions on records instead of emails about a customer.',
        'chatter'
      ),
      define(
        'FILES',
        PLATFORM,
        'Files',
        1,
        'Store and share documents on records.',
        'Documents found with the customer, versioned and shared safely.',
        'Attach documents to records instead of shared drives.',
        'salesforce files'
      ),
      define(
        'APPROVALS',
        PLATFORM,
        'Approval processes',
        1,
        'Submit records (discounts, expenses...) for approval with a traceable decision.',
        'Validation trail and no more approvals by email.',
        'Create an approval process for discounts or any decision taken by email today.',
        'approval processes'
      ),
      define(
        'FLOWS',
        PLATFORM,
        'Flow automation',
        1,
        'Automate business processes without code.',
        'Less manual entry and fewer errors.',
        'Automate a repetitive task with a record-triggered flow.',
        'flow builder'
      ),
      define(
        'DUPLICATES',
        PLATFORM,
        'Duplicate management',
        1,
        'Warn or block when a duplicate account, contact or lead is created.',
        'Clean data and a single view of each customer.',
        'Activate the standard duplicate rules (Setup › Duplicate Rules).',
        'duplicate management'
      ),
      // Experience Cloud
      define(
        'SITES',
        EXPERIENCE,
        'Experience Cloud sites',
        2,
        'Portals for customers or partners connected to your Salesforce data.',
        'Self-service and partner collaboration without email.',
        'Enable Digital Experiences and publish a site from a template.',
        'experience cloud'
      ),
      define(
        'EXTERNAL_USERS',
        EXPERIENCE,
        'Portal user logins',
        1,
        'Customers or partners who actually log in to your sites.',
        'Return on your external licenses.',
        'Invite the external users who hold a license and follow their logins.',
        'experience cloud users'
      ),
      // Field Service
      define(
        'SERVICE_APPOINTMENTS',
        FIELD_SERVICE,
        'Service appointments',
        2,
        'Plan interventions at the customer site.',
        'Optimised planning and on-time interventions.',
        'Create service appointments from work orders and dispatch them.',
        'field service appointments'
      ),
      define(
        'SCHEDULING',
        FIELD_SERVICE,
        'Resources and territories',
        1,
        'Describe technicians, their skills and their territories.',
        'Automatic scheduling of the right technician.',
        'Create service resources and service territories, then a scheduling policy.',
        'field service scheduling'
      )
    };
  }
}
