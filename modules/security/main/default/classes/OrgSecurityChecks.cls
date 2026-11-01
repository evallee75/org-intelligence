/**
 * Contrôles de l'audit de sécurité (lecture seule) : accès privilégiés, utilisateurs et
 * authentification, profils et permission sets, partage et exposition des données, intégrations,
 * surveillance (Health Check Salesforce par la Tooling API, changements de sécurité récents).
 *
 * Chaque contrôle renvoie un statut (Pass / Warning / Fail / Not evaluated / Info), une mesure, le
 * risque, une recommandation et la liste des éléments concernés (plafonnée). Un contrôle qui échoue
 * techniquement (objet absent de l'édition, droits) passe « Not evaluated » sans interrompre l'audit.
 *
 * Mode système (classe sans partage) pour voir tous les utilisateurs et droits ; l'action est réservée
 * aux administrateurs Org Intelligence (OrgSecurityController). Les appels Tooling sont faits avant
 * toute écriture.
 */
public without sharing class OrgSecurityChecks {
  public static final String PASS = 'Pass';
  public static final String WARNING = 'Warning';
  public static final String FAIL = 'Fail';
  public static final String NOT_EVALUATED = 'Not evaluated';
  public static final String INFO = 'Info';

  public static final String CRITICAL = 'Critical';
  public static final String HIGH = 'High';
  public static final String MEDIUM = 'Medium';
  public static final String LOW = 'Low';

  public static final String CAT_PRIVILEGED = 'Privileged access';
  public static final String CAT_USERS = 'Users & authentication';
  public static final String CAT_PERMISSIONS = 'Profiles & permission sets';
  public static final String CAT_SHARING = 'Sharing & data exposure';
  public static final String CAT_INTEGRATIONS = 'Integrations';
  public static final String CAT_MONITORING = 'Monitoring';

  public static final List<String> CATEGORY_ORDER = new List<String>{
    CAT_PRIVILEGED,
    CAT_USERS,
    CAT_PERMISSIONS,
    CAT_SHARING,
    CAT_INTEGRATIONS,
    CAT_MONITORING
  };

  /** Jours sans connexion au-delà desquels un utilisateur actif est considéré comme inactif. */
  public static final Integer INACTIVE_DAYS = 90;

  /** Éléments conservés par contrôle (la mesure garde le total). */
  public static final Integer ITEM_CAP = 30;

  private static final Integer USER_CAP = 5000;

  public class Item {
    public String label { get; set; }
    public String detail { get; set; }

    public Item(String label, String detail) {
      this.label = label;
      this.detail = detail;
    }
  }

  public class Check {
    public String key;
    public String category;
    public String title;
    public String severity;
    public String status;
    public String metric;
    public String risk;
    public String recommendation;
    public Integer count;
    public List<Item> items = new List<Item>();
    public Integer moreItems = 0;
  }

  public class HealthCheck {
    public Decimal score;
    public List<Item> risks = new List<Item>();
    public Integer highRisks = 0;
    public Integer mediumRisks = 0;
    public String message;
  }

  /** Comptes privilégiés : utilisateur → origines du droit (profil, permission sets). */
  private class Grant {
    public Id userId;
    public String name;
    public String username;
    public String profile;
    public Datetime lastLogin;
    public Boolean apiOnly = false;
    public List<String> sources = new List<String>();
  }

  /** Utilisateurs internes actifs, compté au début du contrôle (relu par OrgSecurityService). */
  public Integer activeUsers = 0;
  /** Lignes gardées pour les contrôles suivants après chaque comptage. */
  private static final Integer RESERVED_QUERY_ROWS = 10000;
  private Boolean isSandbox = false;
  private Map<String, Map<Id, Grant>> grantsByPermission = new Map<String, Map<Id, Grant>>();
  public HealthCheck healthCheck;

  public OrgSecurityChecks(Boolean isSandbox) {
    this.isSandbox = isSandbox == true;
  }

  // ---------- Exécution ----------

  /** Health Check Salesforce par la Tooling API : à appeler avant toute écriture (callouts). */
  public void loadHealthCheck() {
    healthCheck = new HealthCheck();
    OrgToolingGateway gateway = OrgToolingGateway.getInstance();
    if (!gateway.isConfigured()) {
      healthCheck.message = 'Tooling API not configured: the Salesforce Health Check could not be read.';
      return;
    }
    try {
      List<Map<String, Object>> scores = gateway.query(
        'SELECT Score FROM SecurityHealthCheck'
      );
      if (!scores.isEmpty() && scores[0].get('Score') != null) {
        healthCheck.score = Decimal.valueOf(
          String.valueOf(scores[0].get('Score'))
        );
      }
      for (
        Map<String, Object> risk : gateway.query(
          'SELECT RiskType, Setting, SettingGroup, OrgValue, StandardValue FROM SecurityHealthCheckRisks'
        )
      ) {
        String type = String.valueOf(risk.get('RiskType'));
        if (type == 'HIGH_RISK') {
          healthCheck.highRisks++;
        } else if (type == 'MEDIUM_RISK') {
          healthCheck.mediumRisks++;
        } else {
          continue;
        }
        healthCheck.risks.add(
          new Item(
            (type == 'HIGH_RISK' ? 'High risk' : 'Medium risk') +
              ' · ' +
              String.valueOf(risk.get('SettingGroup')) +
              ' / ' +
              String.valueOf(risk.get('Setting')),
            'Your value: ' +
              text(risk.get('OrgValue')) +
              ' · Salesforce baseline: ' +
              text(risk.get('StandardValue'))
          )
        );
      }
    } catch (Exception e) {
      healthCheck.message =
        'The Salesforce Health Check could not be read: ' + e.getMessage();
    }
  }

  public List<Check> run() {
    activeUsers = safeCount(
      'SELECT COUNT() FROM User WHERE IsActive = true AND UserType = \'Standard\''
    );
    List<Check> checks = new List<Check>();
    for (
      String key : new List<String>{
        'MODIFY_ALL_DATA',
        'VIEW_ALL_DATA',
        'MANAGE_USERS',
        'CUSTOMIZE_APPLICATION',
        'INACTIVE_ADMINS',
        'MFA',
        'INACTIVE_USERS',
        'NEVER_LOGGED_IN',
        'FAILED_LOGINS',
        'PASSWORD_NEVER_EXPIRES',
        'DEBUG_MODE',
        'POWERFUL_PROFILES',
        'POWERFUL_PERMISSION_SETS',
        'API_ENABLED',
        'EXPORT_REPORTS',
        'MODIFY_ALL_RECORDS',
        'UNUSED_PROFILES',
        'UNUSED_PERMISSION_SETS',
        'GUEST_ACCESS',
        'ORG_WIDE_DEFAULTS',
        'CUSTOM_OBJECT_SHARING',
        'PUBLIC_LINKS',
        'INTEGRATION_ADMINS',
        'OAUTH_TOKENS',
        'HEALTH_CHECK',
        'SETUP_CHANGES'
      }
    ) {
      Check check = new Check();
      check.key = key;
      if (Limits.getQueries() >= Limits.getLimitQueries() - 4) {
        define(check);
        notEvaluated(
          check,
          'Not evaluated: the audit reached the Salesforce query limits.'
        );
      } else {
        try {
          define(check);
          evaluate(check);
        } catch (Exception e) {
          notEvaluated(check, 'Could not be evaluated: ' + e.getMessage());
        }
      }
      checks.add(check);
    }
    return checks;
  }

  // ---------- Catalogue ----------

  /** Titre, famille, gravité, risque et recommandation de chaque contrôle. */
  private static void define(Check c) {
    switch on c.key {
      when 'MODIFY_ALL_DATA' {
        describe(
          c,
          CAT_PRIVILEGED,
          'Users with "Modify All Data"',
          CRITICAL,
          'These users can read, change and delete every record of the org, bypassing sharing. Each extra account is an extra door for an attacker or a costly mistake.',
          'Keep "Modify All Data" for a handful of named administrators (3 to 5). Remove it from integration users and business profiles; grant precise permissions through permission sets instead.'
        );
      }
      when 'VIEW_ALL_DATA' {
        describe(
          c,
          CAT_PRIVILEGED,
          'Users with "View All Data"',
          HIGH,
          'These users read every record regardless of sharing: a single compromised account exposes the whole database.',
          'Restrict "View All Data" to administrators and audited reporting accounts. Use "View All" on the needed objects only.'
        );
      }
      when 'MANAGE_USERS' {
        describe(
          c,
          CAT_PRIVILEGED,
          'Users who can manage users',
          HIGH,
          '"Manage Users" lets someone create users, reset passwords and assign profiles or permission sets, which amounts to granting any access.',
          'Limit "Manage Users" to administrators. For local user support, use Delegated Administration.'
        );
      }
      when 'CUSTOMIZE_APPLICATION' {
        describe(
          c,
          CAT_PRIVILEGED,
          'Users who can change the configuration',
          MEDIUM,
          '"Customize Application" or "Author Apex" in production allows changing automations, code and security settings without going through your deployment process.',
          'In production, keep these permissions for administrators; developers work in sandboxes and deploy.'
        );
      }
      when 'INACTIVE_ADMINS' {
        describe(
          c,
          CAT_PRIVILEGED,
          'Inactive administrators',
          HIGH,
          'An administrator account nobody uses is not watched: if its password leaks, nobody notices.',
          'Deactivate or freeze administrator accounts without login for ' +
            INACTIVE_DAYS +
            ' days, or remove their administrator rights.'
        );
      }
      when 'MFA' {
        describe(
          c,
          CAT_USERS,
          'Users without multi-factor authentication',
          CRITICAL,
          'Multi-factor authentication blocks most account takeovers (phishing, reused passwords). Salesforce requires it for every direct login to the user interface.',
          'Enable "Multi-Factor Authentication for User Interface Logins" for all users (Setup › Session Settings or a permission set) and have every user register Salesforce Authenticator or a security key. Users signing in through SSO are protected by your identity provider.'
        );
      }
      when 'INACTIVE_USERS' {
        describe(
          c,
          CAT_USERS,
          'Active users without login for ' + INACTIVE_DAYS + ' days',
          MEDIUM,
          'Dormant accounts keep their access and their license; former employees or contractors may still be able to log in.',
          'Review these users with their managers, then deactivate or freeze them. Automate the deactivation of leavers from your HR process.'
        );
      }
      when 'NEVER_LOGGED_IN' {
        describe(
          c,
          CAT_USERS,
          'Users who never logged in',
          LOW,
          'Accounts created more than 30 days ago and never used often have a pending password reset link or an initial password.',
          'Deactivate the accounts that are not needed, or resend the welcome email to the right person.'
        );
      }
      when 'FAILED_LOGINS' {
        describe(
          c,
          CAT_USERS,
          'Failed logins in the last 7 days',
          MEDIUM,
          'Many failed logins on the same account can reveal a password guessing attempt.',
          'Check the accounts with the most failures (Setup › Login History), lock suspicious IP addresses with Network Access, and enforce MFA.'
        );
      }
      when 'PASSWORD_NEVER_EXPIRES' {
        describe(
          c,
          CAT_USERS,
          'Users whose password never expires',
          MEDIUM,
          'A password that never expires stays valid forever if it leaks.',
          'Remove "Password Never Expires" from human users. Integration users should use OAuth (connected app) instead of a password.'
        );
      }
      when 'DEBUG_MODE' {
        describe(
          c,
          CAT_USERS,
          'Users with Lightning debug mode enabled',
          LOW,
          'Debug mode makes Lightning pages slower for the user and is meant for developers only; left on in production it degrades performance.',
          'Turn debug mode off for these users (Setup › Debug Mode), and keep it for developers in sandboxes.'
        );
      }
      when 'POWERFUL_PROFILES' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Custom profiles with administrator permissions',
          HIGH,
          'Custom profiles granting "Modify All Data", "View All Data", "Manage Users" or "Author Apex" spread administrator rights to every user of the profile.',
          'Remove these permissions from business profiles and grant them through a dedicated, assigned-by-name permission set.'
        );
      }
      when 'POWERFUL_PERMISSION_SETS' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Permission sets granting administrator permissions',
          MEDIUM,
          'Permission sets with sweeping permissions are easy to assign and hard to follow.',
          'Keep a short, documented list of administrator permission sets and review their assignments every quarter.'
        );
      }
      when 'API_ENABLED' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Users with API access',
          MEDIUM,
          '"API Enabled" lets a user extract data massively with tools such as Data Loader, outside the user interface and its controls.',
          'Grant "API Enabled" only to integration users and to the people who really load data, through a permission set.'
        );
      }
      when 'EXPORT_REPORTS' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Users who can export reports',
          LOW,
          '"Export Reports" allows downloading report data to spreadsheets, which then leave Salesforce control.',
          'Grant "Export Reports" to the roles that need it, and keep the others on display-only reports.'
        );
      }
      when 'MODIFY_ALL_RECORDS' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Non-admin profiles and permission sets with "Modify All" on objects',
          MEDIUM,
          '"Modify All" on an object bypasses sharing for that object: every record can be edited or deleted.',
          'Replace "Modify All" with sharing rules or "View All" where possible, and keep it for the teams that own the data.'
        );
      }
      when 'UNUSED_PROFILES' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Custom profiles without active users',
          LOW,
          'Unused profiles make the access model harder to review and can be reassigned by mistake.',
          'Delete the custom profiles that no active user holds, after checking they are not referenced by a site or an automation.'
        );
      }
      when 'UNUSED_PERMISSION_SETS' {
        describe(
          c,
          CAT_PERMISSIONS,
          'Custom permission sets never assigned',
          LOW,
          'Unassigned permission sets add noise to access reviews.',
          'Delete them, or document why they are kept (e.g. assigned by a flow).'
        );
      }
      when 'GUEST_ACCESS' {
        describe(
          c,
          CAT_SHARING,
          'Guest users (public sites) with risky object access',
          CRITICAL,
          'Guest users are anonymous internet visitors. Edit, delete or "View All" access on an object exposes its data to anyone who finds the site.',
          'Give guest profiles read or create access only, and only on the objects the site needs. Run the Guest User Access Report (Setup › Sharing Settings).'
        );
      }
      when 'ORG_WIDE_DEFAULTS' {
        describe(
          c,
          CAT_SHARING,
          'Standard objects shared in read/write with everyone',
          HIGH,
          'An organisation-wide default "Public Read/Write" lets every internal user edit or reassign every record of the object.',
          'Set the default to "Private" or "Public Read Only" and open access with roles, teams or sharing rules.'
        );
      }
      when 'CUSTOM_OBJECT_SHARING' {
        describe(
          c,
          CAT_SHARING,
          'Custom objects shared in read/write with everyone',
          MEDIUM,
          'Custom objects with a "Public Read/Write" default (or external read/write access) can be changed by every user, including portal users.',
          'Review the sharing default of each object; keep external access "Private" unless a site needs it.'
        );
      }
      when 'PUBLIC_LINKS' {
        describe(
          c,
          CAT_SHARING,
          'Public file links without expiry or password',
          MEDIUM,
          'A public link gives the file to anyone who has the URL, forever if it does not expire.',
          'Set an expiry date and a password on public links, and delete the links that are no longer needed.'
        );
      }
      when 'INTEGRATION_ADMINS' {
        describe(
          c,
          CAT_INTEGRATIONS,
          'Integration users with administrator rights',
          HIGH,
          'Integration credentials are stored in other systems: with "Modify All Data", a leak in any of them exposes the whole org.',
          'Move each integration to a dedicated user with the "Salesforce Integration" license, "API Only" and only the permissions it needs.'
        );
      }
      when 'OAUTH_TOKENS' {
        describe(
          c,
          CAT_INTEGRATIONS,
          'Connected app tokens not used for ' + INACTIVE_DAYS + ' days',
          LOW,
          'Old OAuth tokens keep apps connected on behalf of users long after they stopped using them.',
          'Revoke the unused tokens (Setup › Connected Apps OAuth Usage) and set a refresh token expiry policy on your connected apps.'
        );
      }
      when 'HEALTH_CHECK' {
        describe(
          c,
          CAT_MONITORING,
          'Salesforce Health Check',
          HIGH,
          'Health Check compares your session, password and network settings with the Salesforce security baseline.',
          'Open Setup › Health Check and fix the high-risk settings first ("Fix Risks" applies the baseline values).'
        );
      }
      when 'SETUP_CHANGES' {
        describe(
          c,
          CAT_MONITORING,
          'Security changes in the last 30 days',
          LOW,
          'Changes to users, profiles, permissions and security settings should match approved requests.',
          'Review these changes with the change log of your team; export the Setup Audit Trail every month to keep more than 180 days.'
        );
      }
    }
  }

  private static void describe(
    Check c,
    String category,
    String title,
    String severity,
    String risk,
    String recommendation
  ) {
    c.category = category;
    c.title = title;
    c.severity = severity;
    c.risk = risk;
    c.recommendation = recommendation;
  }

  // ---------- Contrôles ----------

  @SuppressWarnings('PMD.CognitiveComplexity,PMD.NcssMethodCount')
  private void evaluate(Check c) {
    switch on c.key {
      when 'MODIFY_ALL_DATA' {
        Map<Id, Grant> grants = grants('PermissionsModifyAllData');
        addGrantItems(c, grants.values());
        Integer n = grants.size();
        c.count = n;
        String status = n <= 3
          ? PASS
          : n <= 5 || n * 20 <= activeUsers ? WARNING : FAIL;
        apply(
          c,
          status,
          n +
            ' active internal ' +
            users(n) +
            ' (' +
            share(n) +
            ' of ' +
            activeUsers +
            ').'
        );
      }
      when 'VIEW_ALL_DATA' {
        Map<Id, Grant> admins = grants('PermissionsModifyAllData');
        List<Grant> extra = new List<Grant>();
        for (Grant g : grants('PermissionsViewAllData').values()) {
          if (!admins.containsKey(g.userId)) {
            extra.add(g);
          }
        }
        addGrantItems(c, extra);
        c.count = extra.size();
        apply(
          c,
          extra.isEmpty() ? PASS : extra.size() <= 3 ? WARNING : FAIL,
          extra.size() +
            ' ' +
            users(extra.size()) +
            ' read all data without being full administrators.'
        );
      }
      when 'MANAGE_USERS' {
        Map<Id, Grant> admins = grants('PermissionsModifyAllData');
        List<Grant> extra = new List<Grant>();
        for (Grant g : grants('PermissionsManageUsers').values()) {
          if (!admins.containsKey(g.userId)) {
            extra.add(g);
          }
        }
        addGrantItems(c, extra);
        c.count = extra.size();
        apply(
          c,
          extra.isEmpty() ? PASS : extra.size() <= 2 ? WARNING : FAIL,
          extra.size() +
            ' non-administrator ' +
            users(extra.size()) +
            ' can manage users.'
        );
      }
      when 'CUSTOMIZE_APPLICATION' {
        Map<Id, Grant> admins = grants('PermissionsModifyAllData');
        Map<Id, Grant> all = new Map<Id, Grant>(
          grants('PermissionsCustomizeApplication')
        );
        all.putAll(grants('PermissionsAuthorApex'));
        List<Grant> extra = new List<Grant>();
        for (Grant g : all.values()) {
          if (!admins.containsKey(g.userId)) {
            extra.add(g);
          }
        }
        addGrantItems(c, extra);
        c.count = extra.size();
        String status = extra.isEmpty()
          ? PASS
          : isSandbox || extra.size() <= 3 ? WARNING : FAIL;
        apply(
          c,
          status,
          extra.size() +
            ' non-administrator ' +
            users(extra.size()) +
            ' can change the configuration or the code' +
            (isSandbox ? ' (expected in a sandbox).' : '.')
        );
      }
      when 'INACTIVE_ADMINS' {
        Datetime threshold = Datetime.now().addDays(-INACTIVE_DAYS);
        List<Grant> inactive = new List<Grant>();
        for (Grant g : grants('PermissionsModifyAllData').values()) {
          if (g.lastLogin == null || g.lastLogin < threshold) {
            inactive.add(g);
          }
        }
        addGrantItems(c, inactive);
        c.count = inactive.size();
        apply(
          c,
          inactive.isEmpty() ? PASS : FAIL,
          inactive.size() +
            ' administrator ' +
            (inactive.size() == 1 ? 'account' : 'accounts') +
            ' without login for ' +
            INACTIVE_DAYS +
            ' days.'
        );
      }
      when 'MFA' {
        evaluateMfa(c);
      }
      when 'INACTIVE_USERS' {
        Datetime threshold = Datetime.now().addDays(-INACTIVE_DAYS);
        List<User> rows = [
          SELECT Name, Username, LastLoginDate, Profile.Name
          FROM User
          WHERE
            IsActive = TRUE
            AND UserType = 'Standard'
            AND LastLoginDate < :threshold
          ORDER BY LastLoginDate ASC
          LIMIT :USER_CAP
        ];
        for (User u : rows) {
          addItem(
            c,
            u.Name,
            u.Username +
              ' · ' +
              u.Profile?.Name +
              ' · last login ' +
              u.LastLoginDate.date().format()
          );
        }
        c.count = rows.size();
        apply(
          c,
          rows.isEmpty()
            ? PASS
            : rows.size() * 10 <= activeUsers ? WARNING : FAIL,
          rows.size() +
            ' of ' +
            activeUsers +
            ' active internal users (' +
            share(rows.size()) +
            ').'
        );
      }
      when 'NEVER_LOGGED_IN' {
        Datetime created = Datetime.now().addDays(-30);
        List<User> rows = [
          SELECT Name, Username, CreatedDate, Profile.Name
          FROM User
          WHERE
            IsActive = TRUE
            AND UserType = 'Standard'
            AND LastLoginDate = NULL
            AND CreatedDate < :created
          ORDER BY CreatedDate ASC
          LIMIT :USER_CAP
        ];
        for (User u : rows) {
          addItem(
            c,
            u.Name,
            u.Username +
              ' · ' +
              u.Profile?.Name +
              ' · created ' +
              u.CreatedDate.date().format()
          );
        }
        c.count = rows.size();
        apply(
          c,
          rows.isEmpty() ? PASS : WARNING,
          rows.size() +
            ' ' +
            users(rows.size()) +
            ' created more than 30 days ago.'
        );
      }
      when 'FAILED_LOGINS' {
        // LoginHistory.Status n'est pas filtrable : lecture des connexions récentes et tri en Apex
        Map<Id, Integer> failures = new Map<Id, Integer>();
        Integer total = 0;
        Integer sample = 0;
        for (LoginHistory login : [
          SELECT UserId, Status
          FROM LoginHistory
          WHERE LoginTime = LAST_N_DAYS:7
          ORDER BY LoginTime DESC
          LIMIT 5000
        ]) {
          sample++;
          if (login.Status != 'Success') {
            total++;
            failures.put(
              login.UserId,
              (failures.containsKey(login.UserId)
                ? failures.get(login.UserId)
                : 0) + 1
            );
          }
        }
        Map<Id, User> names = new Map<Id, User>(
          [SELECT Id, Name, Username FROM User WHERE Id IN :failures.keySet()]
        );
        List<Id> ordered = new List<Id>(failures.keySet());
        sortByCount(ordered, failures);
        Integer maxPerUser = 0;
        for (Id userId : ordered) {
          Integer n = failures.get(userId);
          maxPerUser = Math.max(maxPerUser, n);
          User u = names.get(userId);
          addItem(
            c,
            u == null ? String.valueOf(userId) : u.Name,
            n +
              ' failed ' +
              (n == 1 ? 'login' : 'logins') +
              (u == null ? '' : ' · ' + u.Username)
          );
        }
        c.count = total;
        apply(
          c,
          total == 0
            ? PASS
            : maxPerUser >= 20 ? FAIL : total >= 20 ? WARNING : PASS,
          total +
            ' failed logins out of ' +
            sample +
            ' logins in the last 7 days' +
            (sample >= 5000 ? ' (latest 5,000 logins)' : '') +
            ', on ' +
            failures.size() +
            ' ' +
            (failures.size() == 1 ? 'account' : 'accounts') +
            '.'
        );
      }
      when 'PASSWORD_NEVER_EXPIRES' {
        List<Grant> rows = grants('PermissionsPasswordNeverExpires').values();
        addGrantItems(c, rows);
        c.count = rows.size();
        apply(
          c,
          rows.isEmpty() ? PASS : WARNING,
          rows.size() + ' active ' + users(rows.size()) + '.'
        );
      }
      when 'DEBUG_MODE' {
        List<User> rows = [
          SELECT Name, Username, Profile.Name
          FROM User
          WHERE IsActive = TRUE AND UserPreferencesUserDebugModePref = TRUE
          ORDER BY Name
          LIMIT :USER_CAP
        ];
        for (User u : rows) {
          addItem(c, u.Name, u.Username + ' · ' + u.Profile?.Name);
        }
        c.count = rows.size();
        apply(
          c,
          rows.isEmpty() ? PASS : isSandbox ? PASS : WARNING,
          rows.size() +
            ' active ' +
            users(rows.size()) +
            ' with debug mode on' +
            (isSandbox && !rows.isEmpty() ? ' (acceptable in a sandbox).' : '.')
        );
      }
      when 'POWERFUL_PROFILES' {
        powerfulPermissionSets(c, true);
      }
      when 'POWERFUL_PERMISSION_SETS' {
        powerfulPermissionSets(c, false);
      }
      when 'API_ENABLED' {
        Integer n = grants('PermissionsApiEnabled').size();
        c.count = n;
        Boolean broad = activeUsers > 10 && n * 2 > activeUsers;
        apply(
          c,
          broad ? WARNING : PASS,
          n +
            ' of ' +
            activeUsers +
            ' active internal users (' +
            share(n) +
            ') can use the API.'
        );
        addProfileBreakdown(c, grants('PermissionsApiEnabled').values());
      }
      when 'EXPORT_REPORTS' {
        Integer n = grants('PermissionsExportReport').size();
        c.count = n;
        Boolean broad = activeUsers > 10 && n * 2 > activeUsers;
        apply(
          c,
          broad ? WARNING : PASS,
          n +
            ' of ' +
            activeUsers +
            ' active internal users (' +
            share(n) +
            ') can export reports.'
        );
        addProfileBreakdown(c, grants('PermissionsExportReport').values());
      }
      when 'MODIFY_ALL_RECORDS' {
        Map<String, List<String>> byParent = new Map<String, List<String>>();
        for (ObjectPermissions permission : [
          SELECT
            SobjectType,
            Parent.Label,
            Parent.IsOwnedByProfile,
            Parent.Profile.Name
          FROM ObjectPermissions
          WHERE
            PermissionsModifyAllRecords = TRUE
            AND Parent.PermissionsModifyAllData = FALSE
            AND Parent.NamespacePrefix = NULL
          LIMIT 2000
        ]) {
          String parent = permission.Parent.IsOwnedByProfile
            ? 'Profile ' + permission.Parent.Profile?.Name
            : 'Permission set ' + permission.Parent.Label;
          if (!byParent.containsKey(parent)) {
            byParent.put(parent, new List<String>());
          }
          byParent.get(parent).add(permission.SobjectType);
        }
        for (String parent : byParent.keySet()) {
          List<String> objects = byParent.get(parent);
          objects.sort();
          addItem(
            c,
            parent,
            objects.size() +
              ' object(s): ' +
              String.join(objects, ', ').abbreviate(200)
          );
        }
        c.count = byParent.size();
        apply(
          c,
          byParent.isEmpty() ? PASS : WARNING,
          byParent.size() +
          ' profile(s) or permission set(s) without "Modify All Data" grant "Modify All" on objects.'
        );
      }
      when 'UNUSED_PROFILES' {
        evaluateUnusedProfiles(c);
      }
      when 'UNUSED_PERMISSION_SETS' {
        List<PermissionSet> unused = Database.query(
          'SELECT Label, Name, LastModifiedDate FROM PermissionSet ' +
            'WHERE IsOwnedByProfile = false AND NamespacePrefix = null AND IsCustom = true AND Type = \'Regular\' ' +
            'AND Id NOT IN (SELECT PermissionSetId FROM PermissionSetAssignment) ORDER BY Label LIMIT 500'
        );
        for (PermissionSet ps : unused) {
          addItem(
            c,
            ps.Label,
            ps.Name + ' · last modified ' + ps.LastModifiedDate.date().format()
          );
        }
        c.count = unused.size();
        apply(
          c,
          unused.isEmpty() ? PASS : unused.size() <= 5 ? PASS : WARNING,
          unused.size() + ' custom permission set(s) assigned to nobody.'
        );
      }
      when 'GUEST_ACCESS' {
        evaluateGuestAccess(c);
      }
      when 'ORG_WIDE_DEFAULTS' {
        evaluateOrgWideDefaults(c);
      }
      when 'CUSTOM_OBJECT_SHARING' {
        evaluateCustomObjectSharing(c);
      }
      when 'PUBLIC_LINKS' {
        Integer total = safeCount('SELECT COUNT() FROM ContentDistribution');
        List<ContentDistribution> open = [
          SELECT
            Name,
            CreatedDate,
            CreatedBy.Name,
            ViewCount,
            PreferencesPasswordRequired,
            PreferencesExpires
          FROM ContentDistribution
          WHERE
            PreferencesExpires = FALSE
            OR PreferencesPasswordRequired = FALSE
          ORDER BY CreatedDate DESC
          LIMIT 2000
        ];
        Integer noExpiry = 0;
        for (ContentDistribution link : open) {
          if (!link.PreferencesExpires) {
            noExpiry++;
          }
          addItem(
            c,
            link.Name,
            (link.PreferencesExpires ? 'expires' : 'never expires') +
              ' · ' +
              (link.PreferencesPasswordRequired ? 'password' : 'no password') +
              ' · ' +
              link.ViewCount +
              ' view(s) · by ' +
              link.CreatedBy?.Name +
              ', ' +
              link.CreatedDate.date().format()
          );
        }
        c.count = noExpiry;
        apply(
          c,
          noExpiry == 0 ? PASS : noExpiry >= 20 ? FAIL : WARNING,
          noExpiry +
            ' public link(s) without expiry, out of ' +
            total +
            ' public link(s).'
        );
      }
      when 'INTEGRATION_ADMINS' {
        List<Grant> rows = new List<Grant>();
        Map<Id, Grant> apiOnly = grants('PermissionsApiUserOnly');
        for (Grant g : grants('PermissionsModifyAllData').values()) {
          g.apiOnly = apiOnly.containsKey(g.userId);
          String name = (g.name + ' ' + g.username).toLowerCase();
          if (
            g.apiOnly ||
            name.contains('integration') ||
            name.contains('interface') ||
            name.contains(' api') ||
            name.contains('api.') ||
            name.contains('api@') ||
            name.contains('mulesoft') ||
            name.contains('boomi')
          ) {
            rows.add(g);
          }
        }
        addGrantItems(c, rows);
        c.count = rows.size();
        apply(
          c,
          rows.isEmpty() ? PASS : FAIL,
          rows.size() +
            ' integration or API-only ' +
            (rows.size() == 1 ? 'user has' : 'users have') +
            ' "Modify All Data".'
        );
      }
      when 'OAUTH_TOKENS' {
        Datetime threshold = Datetime.now().addDays(-INACTIVE_DAYS);
        List<OauthToken> tokens = [
          SELECT AppName, User.Name, LastUsedDate, CreatedDate, UseCount
          FROM OauthToken
          ORDER BY LastUsedDate ASC NULLS FIRST
          LIMIT 2000
        ];
        Integer stale = 0;
        Set<String> apps = new Set<String>();
        for (OauthToken token : tokens) {
          apps.add(token.AppName);
          if (token.LastUsedDate == null || token.LastUsedDate < threshold) {
            stale++;
            addItem(
              c,
              token.AppName,
              token.User?.Name +
                ' · last used ' +
                (token.LastUsedDate == null
                  ? 'never'
                  : token.LastUsedDate.date().format())
            );
          }
        }
        c.count = stale;
        apply(
          c,
          stale == 0 ? PASS : stale >= 20 ? WARNING : PASS,
          stale +
            ' unused token(s) out of ' +
            tokens.size() +
            ', for ' +
            apps.size() +
            ' connected app(s).'
        );
      }
      when 'HEALTH_CHECK' {
        if (healthCheck == null || healthCheck.score == null) {
          notEvaluated(
            c,
            healthCheck?.message == null
              ? 'The Salesforce Health Check was not read.'
              : healthCheck.message
          );
          return;
        }
        for (Item risk : healthCheck.risks) {
          addItem(c, risk.label, risk.detail);
        }
        c.count = healthCheck.highRisks + healthCheck.mediumRisks;
        Decimal score = healthCheck.score;
        apply(
          c,
          score >= 80 ? PASS : score >= 60 ? WARNING : FAIL,
          'Health Check score ' +
            score.setScale(0) +
            ' / 100 · ' +
            healthCheck.highRisks +
            ' high-risk and ' +
            healthCheck.mediumRisks +
            ' medium-risk setting(s).'
        );
      }
      when 'SETUP_CHANGES' {
        evaluateSetupChanges(c);
      }
    }
  }

  private void evaluateMfa(Check c) {
    List<SObject> rows = Database.query(
      'SELECT UserId, User.Name, User.Username, User.FederationIdentifier, HasSalesforceAuthenticator, HasTotp, HasU2F, HasBuiltInAuthenticator ' +
        'FROM TwoFactorMethodsInfo WHERE User.IsActive = true AND User.UserType = \'Standard\' LIMIT ' +
        USER_CAP
    );
    Integer without = 0;
    Integer sso = 0;
    for (SObject row : rows) {
      Boolean strong =
        row.get('HasSalesforceAuthenticator') == true ||
        row.get('HasTotp') == true ||
        row.get('HasU2F') == true ||
        row.get('HasBuiltInAuthenticator') == true;
      if (strong) {
        continue;
      }
      SObject userRecord = row.getSObject('User');
      if (
        userRecord != null &&
        String.isNotBlank((String) userRecord.get('FederationIdentifier'))
      ) {
        sso++;
        continue;
      }
      without++;
      addItem(
        c,
        userRecord == null
          ? String.valueOf(row.get('UserId'))
          : (String) userRecord.get('Name'),
        userRecord == null
          ? ''
          : (String) userRecord.get('Username') +
            ' · no verification method registered'
      );
    }
    c.count = without;
    apply(
      c,
      without == 0 ? PASS : without * 10 <= activeUsers ? WARNING : FAIL,
      without +
        ' of ' +
        activeUsers +
        ' active internal users (' +
        share(without) +
        ') have no strong verification method (authenticator app, security key)' +
        (sso > 0 ? '; ' + sso + ' SSO user(s) excluded.' : '.')
    );
  }

  private void powerfulPermissionSets(Check c, Boolean profiles) {
    String soql =
      'SELECT Id, Label, Name, Profile.Name, PermissionsModifyAllData, PermissionsViewAllData, PermissionsManageUsers, PermissionsAuthorApex, PermissionsCustomizeApplication ' +
      'FROM PermissionSet WHERE IsOwnedByProfile = ' +
      profiles +
      ' AND IsCustom = true AND NamespacePrefix = null ' +
      'AND (PermissionsModifyAllData = true OR PermissionsViewAllData = true OR PermissionsManageUsers = true OR PermissionsAuthorApex = true' +
      (profiles ? ' OR PermissionsCustomizeApplication = true' : '') +
      ') ORDER BY Label LIMIT 500';
    List<PermissionSet> sets = Database.query(soql);
    Map<Id, Integer> assignments = new Map<Id, Integer>();
    for (AggregateResult row : [
      SELECT PermissionSetId psId, COUNT(Id) total
      FROM PermissionSetAssignment
      WHERE PermissionSetId IN :sets AND Assignee.IsActive = TRUE
      GROUP BY PermissionSetId
    ]) {
      assignments.put((Id) row.get('psId'), (Integer) row.get('total'));
    }
    for (PermissionSet ps : sets) {
      List<String> powers = new List<String>();
      for (String field : ADMIN_PERMISSIONS.keySet()) {
        if (
          (profiles || field != 'PermissionsCustomizeApplication') &&
          ps.get(field) == true
        ) {
          powers.add(ADMIN_PERMISSIONS.get(field));
        }
      }
      Integer holders = assignments.containsKey(ps.Id)
        ? assignments.get(ps.Id)
        : 0;
      addItem(
        c,
        profiles ? ps.Profile?.Name : ps.Label,
        String.join(powers, ', ') +
          ' · ' +
          holders +
          ' active ' +
          users(holders)
      );
    }
    c.count = sets.size();
    String status = sets.isEmpty()
      ? PASS
      : profiles ? FAIL : sets.size() <= 3 ? PASS : WARNING;
    apply(
      c,
      status,
      sets.size() +
        (profiles ? ' custom profile(s)' : ' custom permission set(s)') +
        ' grant administrator permissions.'
    );
  }

  private void evaluateUnusedProfiles(Check c) {
    // L'agrégat compte chaque utilisateur actif dans la limite des 50 000 lignes : contrôle préalable
    Integer allActive = safeCount(
      'SELECT COUNT() FROM User WHERE IsActive = true'
    );
    if (allActive >= 40000) {
      notEvaluated(c, 'Not evaluated: more than 40,000 active users.');
      return;
    }
    Set<Id> used = activeUsersByProfile().keySet();
    List<Profile> unused = new List<Profile>();
    for (Profile p : [
      SELECT Id, Name, LastModifiedDate
      FROM Profile
      WHERE
        Id IN (
          SELECT ProfileId
          FROM PermissionSet
          WHERE IsOwnedByProfile = TRUE AND IsCustom = TRUE
        )
      ORDER BY Name
      LIMIT 1000
    ]) {
      if (!used.contains(p.Id)) {
        unused.add(p);
        addItem(
          c,
          p.Name,
          'last modified ' + p.LastModifiedDate.date().format()
        );
      }
    }
    c.count = unused.size();
    apply(
      c,
      unused.size() <= 3 ? PASS : WARNING,
      unused.size() + ' custom profile(s) without active users.'
    );
  }

  private void evaluateGuestAccess(Check c) {
    Integer risky = 0;
    for (ObjectPermissions permission : [
      SELECT
        SobjectType,
        Parent.Profile.Name,
        PermissionsRead,
        PermissionsCreate,
        PermissionsEdit,
        PermissionsDelete,
        PermissionsViewAllRecords,
        PermissionsModifyAllRecords
      FROM ObjectPermissions
      WHERE
        Parent.Profile.UserType = 'Guest'
        AND (PermissionsEdit = TRUE
        OR PermissionsDelete = TRUE
        OR PermissionsViewAllRecords = TRUE
        OR PermissionsModifyAllRecords = TRUE)
      ORDER BY Parent.Profile.Name, SobjectType
      LIMIT 1000
    ]) {
      risky++;
      List<String> rights = new List<String>();
      if (permission.PermissionsEdit) {
        rights.add('Edit');
      }
      if (permission.PermissionsDelete) {
        rights.add('Delete');
      }
      if (permission.PermissionsViewAllRecords) {
        rights.add('View All');
      }
      if (permission.PermissionsModifyAllRecords) {
        rights.add('Modify All');
      }
      addItem(
        c,
        permission.SobjectType,
        permission.Parent.Profile?.Name + ' · ' + String.join(rights, ', ')
      );
    }
    Integer sites = safeCount(
      'SELECT COUNT() FROM Site WHERE Status = \'Active\''
    );
    c.count = risky;
    apply(
      c,
      risky == 0 ? PASS : FAIL,
      risky +
        ' object permission(s) with edit, delete or "View All" for guest users · ' +
        sites +
        ' active site(s).'
    );
  }

  private void evaluateOrgWideDefaults(Check c) {
    Organization org = [
      SELECT
        DefaultAccountAccess,
        DefaultContactAccess,
        DefaultOpportunityAccess,
        DefaultLeadAccess,
        DefaultCaseAccess
      FROM Organization
      LIMIT 1
    ];
    Map<String, String> levels = new Map<String, String>{
      'Account' => org.DefaultAccountAccess,
      'Contact' => org.DefaultContactAccess,
      'Opportunity' => org.DefaultOpportunityAccess,
      'Lead' => org.DefaultLeadAccess,
      'Case' => org.DefaultCaseAccess
    };
    Integer open = 0;
    for (String objectName : levels.keySet()) {
      String level = levels.get(objectName);
      Boolean isOpen =
        level == 'Edit' ||
        level == 'ReadEditTransfer' ||
        level == 'All';
      if (isOpen) {
        open++;
      }
      addItem(
        c,
        objectName,
        sharingLabel(level) +
        (isOpen ? ' — every internal user can edit every record' : '')
      );
    }
    c.count = open;
    apply(
      c,
      open == 0 ? PASS : WARNING,
      open + ' of 5 key standard objects are "Public Read/Write".'
    );
  }

  private void evaluateCustomObjectSharing(Check c) {
    // EntityDefinition ne supporte pas queryMore : lecture dans une liste plafonnée, filtre en Apex
    List<EntityDefinition> entities = [
      SELECT QualifiedApiName, Label, InternalSharingModel, ExternalSharingModel
      FROM EntityDefinition
      WHERE IsCustomizable = TRUE AND IsCustomSetting = FALSE
      LIMIT 2000
    ];
    Integer open = 0;
    Integer external = 0;
    for (EntityDefinition entity : entities) {
      String name = entity.QualifiedApiName;
      if (!name.endsWith('__c') || name.removeEnd('__c').contains('__')) {
        continue;
      }
      Boolean internalOpen =
        entity.InternalSharingModel == 'ReadWrite' ||
        entity.InternalSharingModel == 'FullAccess';
      Boolean externalOpen =
        entity.ExternalSharingModel == 'ReadWrite' ||
        entity.ExternalSharingModel == 'Read' ||
        entity.ExternalSharingModel == 'FullAccess';
      if (internalOpen) {
        open++;
      }
      if (externalOpen) {
        external++;
      }
      if (internalOpen || externalOpen) {
        addItem(
          c,
          entity.Label + ' (' + name + ')',
          'internal: ' +
            sharingLabel(entity.InternalSharingModel) +
            ' · external: ' +
            sharingLabel(entity.ExternalSharingModel)
        );
      }
    }
    c.count = open + external;
    apply(
      c,
      external > 0 ? FAIL : open > 0 ? WARNING : PASS,
      open +
        ' custom object(s) "Public Read/Write" internally, ' +
        external +
        ' open to external users.'
    );
  }

  private void evaluateSetupChanges(Check c) {
    List<String> keywords = new List<String>{
      'user',
      'profile',
      'permission',
      'security',
      'sharing',
      'password',
      'session',
      'connected app',
      'certificate',
      'login',
      'auth',
      'identity',
      'network access',
      'role'
    };
    Integer total = 0;
    Integer loginAs = 0;
    for (SetupAuditTrail entry : [
      SELECT Action, Section, Display, CreatedDate, CreatedBy.Name, DelegateUser
      FROM SetupAuditTrail
      WHERE CreatedDate = LAST_N_DAYS:30
      ORDER BY CreatedDate DESC
      LIMIT 2000
    ]) {
      String section = entry.Section == null ? '' : entry.Section.toLowerCase();
      Boolean relevant = false;
      for (String keyword : keywords) {
        if (section.contains(keyword)) {
          relevant = true;
          break;
        }
      }
      if (String.isNotBlank(entry.DelegateUser)) {
        loginAs++;
        relevant = true;
      }
      if (!relevant) {
        continue;
      }
      total++;
      addItem(
        c,
        entry.CreatedDate.format('yyyy-MM-dd HH:mm') +
          ' · ' +
          entry.CreatedBy?.Name,
        (entry.Section == null ? '' : entry.Section + ' — ') +
          (entry.Display == null ? entry.Action : entry.Display)
            .abbreviate(220) +
          (String.isNotBlank(entry.DelegateUser)
            ? ' (logged in as by ' + entry.DelegateUser + ')'
            : '')
      );
    }
    c.count = total;
    apply(
      c,
      INFO,
      total +
        ' security-related change(s) in the last 30 days' +
        (loginAs > 0
          ? ', of which ' + loginAs + ' made while "logged in as" another user.'
          : '.')
    );
  }

  // ---------- Droits : qui détient une permission (profil ou permission set) ----------

  private Map<Id, Grant> grants(String permissionField) {
    if (grantsByPermission.containsKey(permissionField)) {
      return grantsByPermission.get(permissionField);
    }
    Map<Id, Grant> grants = new Map<Id, Grant>();
    for (
      PermissionSetAssignment assignment : Database.query(
        'SELECT AssigneeId, Assignee.Name, Assignee.Username, Assignee.Profile.Name, Assignee.LastLoginDate, ' +
          'PermissionSet.IsOwnedByProfile, PermissionSet.Label ' +
          'FROM PermissionSetAssignment WHERE PermissionSet.' +
          permissionField +
          ' = true ' +
          'AND Assignee.IsActive = true AND Assignee.UserType = \'Standard\' LIMIT ' +
          USER_CAP
      )
    ) {
      Grant g = grants.get(assignment.AssigneeId);
      if (g == null) {
        g = new Grant();
        g.userId = assignment.AssigneeId;
        g.name = assignment.Assignee.Name;
        g.username = assignment.Assignee.Username;
        g.profile = assignment.Assignee.Profile?.Name;
        g.lastLogin = assignment.Assignee.LastLoginDate;
        grants.put(g.userId, g);
      }
      g.sources.add(
        assignment.PermissionSet.IsOwnedByProfile
          ? 'profile ' + g.profile
          : 'permission set ' + assignment.PermissionSet.Label
      );
    }
    grantsByPermission.put(permissionField, grants);
    return grants;
  }

  private void addGrantItems(Check c, List<Grant> grants) {
    for (Grant g : grants) {
      addItem(
        c,
        g.name,
        g.username +
          ' · via ' +
          String.join(g.sources, ', ') +
          ' · last login ' +
          (g.lastLogin == null ? 'never' : g.lastLogin.date().format())
      );
    }
  }

  /** Répartition par profil (contrôles « larges » : API, export). */
  private void addProfileBreakdown(Check c, List<Grant> grants) {
    Map<String, Integer> byProfile = new Map<String, Integer>();
    for (Grant g : grants) {
      String profile = g.profile == null ? 'Unknown profile' : g.profile;
      byProfile.put(
        profile,
        (byProfile.containsKey(profile) ? byProfile.get(profile) : 0) + 1
      );
    }
    List<String> profiles = new List<String>(byProfile.keySet());
    profiles.sort();
    for (String profile : profiles) {
      addItem(
        c,
        profile,
        byProfile.get(profile) + ' ' + users(byProfile.get(profile))
      );
    }
  }

  // ---------- Outils (partagés avec l'analyse des profils et permission sets) ----------

  /**
   * Permissions d'administration, dans l'ordre d'affichage (champ PermissionSet → libellé).
   * Customize Application n'est comptée que pour les profils par l'audit.
   */
  public static final Map<String, String> ADMIN_PERMISSIONS = new Map<String, String>{
    'PermissionsModifyAllData' => 'Modify All Data',
    'PermissionsViewAllData' => 'View All Data',
    'PermissionsManageUsers' => 'Manage Users',
    'PermissionsAuthorApex' => 'Author Apex',
    'PermissionsCustomizeApplication' => 'Customize Application'
  };

  /**
   * Utilisateurs actifs par profil. Un agrégat GROUP BY ne compte que ses lignes de résultat dans
   * la limite des lignes de la transaction : une ligne par profil.
   */
  public static Map<Id, Integer> activeUsersByProfile() {
    Map<Id, Integer> counts = new Map<Id, Integer>();
    for (AggregateResult row : [
      SELECT ProfileId, COUNT(Id) total
      FROM User
      WHERE IsActive = TRUE
      GROUP BY ProfileId
    ]) {
      counts.put((Id) row.get('ProfileId'), (Integer) row.get('total'));
    }
    return counts;
  }

  /** Lignes de requête encore disponibles dans la transaction, moins une réserve. */
  public static Integer rowsLeft(Integer reserve) {
    return Math.max(
      0,
      Limits.getLimitQueryRows() - Limits.getQueryRows() - reserve
    );
  }

  // ---------- Outils ----------

  private static void apply(Check c, String status, String metric) {
    c.status = status;
    c.metric = metric;
  }

  private static void notEvaluated(Check c, String message) {
    c.status = NOT_EVALUATED;
    c.metric = message;
    c.items.clear();
    c.moreItems = 0;
  }

  private static void addItem(Check c, String label, String detail) {
    if (c.items.size() < ITEM_CAP) {
      c.items.add(new Item(label, detail));
    } else {
      c.moreItems++;
    }
  }

  /**
   * Comptage protégé. Chaque enregistrement compté par COUNT() s'impute sur la limite de lignes de
   * la transaction, et la LimitException n'est pas interceptable : le LIMIT est borné aux lignes
   * restantes (moins une réserve pour les contrôles suivants). Le résultat est alors un minimum.
   */
  private Integer safeCount(String soql) {
    Integer available = rowsLeft(RESERVED_QUERY_ROWS);
    if (available <= 0) {
      return 0;
    }
    try {
      return Database.countQuery(soql + ' LIMIT ' + available);
    } catch (Exception e) {
      return 0;
    }
  }

  private String share(Integer n) {
    return activeUsers == 0
      ? '—'
      : (Decimal.valueOf(n) * 100 / activeUsers).setScale(0) + ' %';
  }

  private static String users(Integer n) {
    return n == 1 ? 'user' : 'users';
  }

  private static String text(Object value) {
    return value == null ||
      String.valueOf(value) == ''
      ? '—'
      : String.valueOf(value);
  }

  private static String sharingLabel(String level) {
    switch on level {
      when 'None', 'Private' {
        return 'Private';
      }
      when 'Read' {
        return 'Public Read Only';
      }
      when 'Edit', 'ReadWrite' {
        return 'Public Read/Write';
      }
      when 'ReadEditTransfer' {
        return 'Public Read/Write/Transfer';
      }
      when 'All', 'FullAccess' {
        return 'Public Full Access';
      }
      when 'ControlledByParent' {
        return 'Controlled by parent';
      }
    }
    return level == null ? '—' : level;
  }

  private static void sortByCount(List<Id> ids, Map<Id, Integer> counts) {
    // Tri décroissant simple (peu d'éléments)
    for (Integer i = 1; i < ids.size(); i++) {
      Id current = ids[i];
      Integer j = i - 1;
      while (j >= 0 && counts.get(ids[j]) < counts.get(current)) {
        ids[j + 1] = ids[j];
        j--;
      }
      ids[j + 1] = current;
    }
  }
}
