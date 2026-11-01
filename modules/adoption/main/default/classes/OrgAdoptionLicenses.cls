/**
 * Licences de l'org : ce que l'entreprise a acheté (ce que Salesforce expose par API) face à ce qui
 * est réellement attribué et utilisé.
 *
 * Sources : UserLicense (licences utilisateur), PermissionSetLicense (add-ons attribués par
 * licence de permission set), PackageLicense (packages gérés sous licence), TenantUsageEntitlement
 * (droits d'usage : stockage, appels, crédits...), licences de fonctionnalité portées par
 * l'utilisateur (Service Cloud User, Marketing User...), et l'activité des utilisateurs internes
 * (dernière connexion, utilisateurs gelés).
 *
 * Le contrat (prix, lignes de commande) n'est pas lisible par API : seules les quantités le sont.
 * Lecture en mode système (classe sans partage) : seuls des compteurs sortent, l'action est réservée
 * aux administrateurs Org Intelligence (OrgAdoptionController).
 */
public without sharing class OrgAdoptionLicenses {
  /** Jours sans connexion au-delà desquels un utilisateur actif est considéré comme inactif. */
  public static final Integer INACTIVE_DAYS = 90;

  /** Plafond des comptages d'utilisateurs (limite des 50 000 lignes agrégées par transaction). */
  private static final Integer USER_COUNT_CAP = 5000;

  /** Plafond des comptages par licence de fonctionnalité. */
  private static final Integer FEATURE_LICENSE_CAP = 1000;

  /**
   * Licences utilisateur incluses sans surcoût (ou en quantité gratuite) : elles ne comptent pas
   * dans les licences payantes. Repérées par un fragment de leur nom.
   */
  private static final List<String> INCLUDED_LICENSE_HINTS = new List<String>{
    'guest',
    'chatter free',
    'chatter external',
    'identity',
    'integration',
    'work.com only',
    'customer portal manager standard',
    'external apps login'
  };

  /** Licences de fonctionnalité portées par l'utilisateur (champ User → libellé). */
  private static final Map<String, String> FEATURE_LICENSES = new Map<String, String>{
    'UserPermissionsSupportUser' => 'Service Cloud User',
    'UserPermissionsKnowledgeUser' => 'Knowledge User',
    'UserPermissionsMarketingUser' => 'Marketing User',
    'UserPermissionsInteractionUser' => 'Flow User',
    'UserPermissionsLiveAgentUser' => 'Chat User',
    'UserPermissionsSFContentUser' => 'Salesforce CRM Content User',
    'UserPermissionsOfflineUser' => 'Offline User'
  };

  // ---------- Résultats ----------

  public class UserLicenseRow {
    public String key;
    public String name;
    public String status;
    public Integer total;
    public Integer used;
    public Integer unused;
    public Integer inactive = 0;
    public Integer frozen = 0;
    public Boolean included = false;
    public Decimal utilization;
    /** OK, Seats to reclaim, Over-allocated, Included, Inactive (licence suspendue). */
    public String verdict;
  }

  public class AddOnRow {
    public String key;
    public String name;
    public String kind; // Permission set license, Managed package, Usage entitlement
    public String status;
    public Decimal total;
    public Decimal used;
    public Decimal utilization;
    public Date expirationDate;
    public String unit;
    /** In use, Never assigned, Low use, Expiring soon, Expired, Site-wide, Over limit. */
    public String verdict;
  }

  public class FeatureLicenseRow {
    public String key;
    public String name;
    public Integer assigned;
    public Integer inactive;
  }

  public class Result {
    public List<UserLicenseRow> userLicenses = new List<UserLicenseRow>();
    public List<AddOnRow> addOns = new List<AddOnRow>();
    public List<FeatureLicenseRow> featureLicenses = new List<FeatureLicenseRow>();
    public Integer paidSeats = 0;
    public Integer usedPaidSeats = 0;
    public Integer unusedSeats = 0;
    public Integer inactiveUsers = 0;
    public Integer activeInternalUsers = 0;
    public Integer loggedInLast30 = 0;
    public Integer neverLoggedIn = 0;
    public List<String> warnings = new List<String>();
  }

  // ---------- Collecte ----------

  public static Result collect() {
    Result result = new Result();
    collectUserLicenses(result);
    collectUserActivity(result);
    collectPermissionSetLicenses(result);
    collectPackageLicenses(result);
    collectEntitlements(result);
    collectFeatureLicenses(result);
    return result;
  }

  private static void collectUserLicenses(Result result) {
    for (UserLicense license : [
      SELECT
        Id,
        Name,
        MasterLabel,
        LicenseDefinitionKey,
        Status,
        TotalLicenses,
        UsedLicenses
      FROM UserLicense
    ]) {
      if (license.TotalLicenses == null || license.TotalLicenses == 0) {
        continue;
      }
      UserLicenseRow row = new UserLicenseRow();
      row.key = license.LicenseDefinitionKey;
      row.name = String.isNotBlank(license.MasterLabel)
        ? license.MasterLabel
        : license.Name;
      row.status = license.Status;
      row.total = license.TotalLicenses;
      row.used = license.UsedLicenses == null ? 0 : license.UsedLicenses;
      row.unused = Math.max(row.total - row.used, 0);
      row.included = isIncluded(row.name);
      row.utilization = percent(row.used, row.total);
      result.userLicenses.add(row);
    }
  }

  @TestVisible
  private static Boolean isIncluded(String name) {
    String lower = name == null ? '' : name.toLowerCase();
    for (String fragment : INCLUDED_LICENSE_HINTS) {
      if (lower.contains(fragment)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Utilisateurs internes actifs sans connexion récente, jamais connectés ou gelés, par licence :
   * ils consomment une licence sans s'en servir.
   */
  private static void collectUserActivity(Result result) {
    Map<String, UserLicenseRow> byName = new Map<String, UserLicenseRow>();
    for (UserLicenseRow row : result.userLicenses) {
      byName.put(row.name, row);
    }
    Datetime threshold = Datetime.now().addDays(-INACTIVE_DAYS);
    try {
      result.activeInternalUsers = [
        SELECT COUNT()
        FROM User
        WHERE IsActive = TRUE AND UserType = 'Standard'
        LIMIT :USER_COUNT_CAP
      ];
      result.loggedInLast30 = [
        SELECT COUNT()
        FROM User
        WHERE
          IsActive = TRUE
          AND UserType = 'Standard'
          AND LastLoginDate = LAST_N_DAYS:30
        LIMIT :USER_COUNT_CAP
      ];
      result.neverLoggedIn = [
        SELECT COUNT()
        FROM User
        WHERE IsActive = TRUE AND UserType = 'Standard' AND LastLoginDate = NULL
        LIMIT :USER_COUNT_CAP
      ];
      // L'agrégat compte chaque utilisateur inactif dans la limite des lignes : contrôle préalable
      Integer inactiveTotal = [
        SELECT COUNT()
        FROM User
        WHERE
          IsActive = TRUE
          AND UserType = 'Standard'
          AND (LastLoginDate = NULL
          OR LastLoginDate < :threshold)
        LIMIT :USER_COUNT_CAP
      ];
      if (inactiveTotal >= USER_COUNT_CAP) {
        result.warnings.add(
          'More than ' +
            USER_COUNT_CAP +
            ' inactive internal users: the breakdown by license is not computed.'
        );
      } else if (inactiveTotal > 0) {
        for (AggregateResult row : [
          SELECT Profile.UserLicense.MasterLabel license, COUNT(Id) total
          FROM User
          WHERE
            IsActive = TRUE
            AND UserType = 'Standard'
            AND (LastLoginDate = NULL
            OR LastLoginDate < :threshold)
          GROUP BY Profile.UserLicense.MasterLabel
        ]) {
          UserLicenseRow license = byName.get((String) row.get('license'));
          if (license != null) {
            license.inactive += (Integer) row.get('total');
          }
        }
      }
    } catch (Exception e) {
      result.warnings.add('User activity could not be read: ' + e.getMessage());
    }
    try {
      Set<Id> frozenIds = new Set<Id>();
      for (UserLogin login : [
        SELECT UserId
        FROM UserLogin
        WHERE IsFrozen = TRUE
        LIMIT 2000
      ]) {
        frozenIds.add(login.UserId);
      }
      if (!frozenIds.isEmpty()) {
        for (AggregateResult row : [
          SELECT Profile.UserLicense.MasterLabel license, COUNT(Id) total
          FROM User
          WHERE Id IN :frozenIds AND IsActive = TRUE
          GROUP BY Profile.UserLicense.MasterLabel
        ]) {
          UserLicenseRow license = byName.get((String) row.get('license'));
          if (license != null) {
            license.frozen += (Integer) row.get('total');
          }
        }
      }
    } catch (Exception e) {
      result.warnings.add('Frozen users could not be read: ' + e.getMessage());
    }

    for (UserLicenseRow row : result.userLicenses) {
      row.verdict = licenseVerdict(row);
      if (!row.included && row.status == 'Active') {
        result.paidSeats += row.total;
        result.usedPaidSeats += Math.min(row.used, row.total);
        result.unusedSeats += row.unused;
        result.inactiveUsers += row.inactive;
      }
    }
  }

  @TestVisible
  private static String licenseVerdict(UserLicenseRow row) {
    if (row.status != 'Active') {
      return 'Inactive';
    }
    if (row.included) {
      return 'Included';
    }
    if (row.used > row.total) {
      return 'Over-allocated';
    }
    Integer reclaimable = row.unused + row.inactive;
    // Seuil : au moins 2 licences et 10 % du parc à récupérer
    if (reclaimable >= 2 && reclaimable * 10 >= row.total) {
      return 'Seats to reclaim';
    }
    return 'OK';
  }

  private static void collectPermissionSetLicenses(Result result) {
    Date soon = Date.today().addDays(90);
    for (PermissionSetLicense license : [
      SELECT
        Id,
        MasterLabel,
        DeveloperName,
        Status,
        TotalLicenses,
        UsedLicenses,
        ExpirationDate
      FROM PermissionSetLicense
    ]) {
      if (license.TotalLicenses == null || license.TotalLicenses == 0) {
        continue;
      }
      AddOnRow row = new AddOnRow();
      row.key = 'PSL:' + license.DeveloperName;
      row.name = license.MasterLabel;
      row.kind = 'Permission set license';
      row.status = license.Status;
      row.total = license.TotalLicenses;
      row.used = license.UsedLicenses == null ? 0 : license.UsedLicenses;
      row.utilization = percent(row.used, row.total);
      row.expirationDate = license.ExpirationDate;
      row.unit = 'users';
      row.verdict = addOnVerdict(row, soon);
      result.addOns.add(row);
    }
  }

  private static void collectPackageLicenses(Result result) {
    Date soon = Date.today().addDays(90);
    for (PackageLicense license : [
      SELECT
        Id,
        NamespacePrefix,
        Status,
        AllowedLicenses,
        UsedLicenses,
        ExpirationDate
      FROM PackageLicense
    ]) {
      AddOnRow row = new AddOnRow();
      row.key = 'PKG:' + license.Id;
      row.name = license.NamespacePrefix;
      row.kind = 'Managed package';
      row.status = license.Status;
      row.total = license.AllowedLicenses;
      row.used = license.UsedLicenses == null ? 0 : license.UsedLicenses;
      row.expirationDate = license.ExpirationDate?.date();
      row.unit = 'users';
      if (license.AllowedLicenses == null || license.AllowedLicenses < 0) {
        row.total = null;
        row.verdict = expiryVerdict(row.expirationDate, soon, 'Site-wide');
      } else {
        row.utilization = percent(row.used, row.total);
        row.verdict = addOnVerdict(row, soon);
      }
      result.addOns.add(row);
    }
  }

  /**
   * Droits d'usage (TenantUsageEntitlement) : pas exposés dans toutes les éditions, lus en dynamique
   * et ignorés en cas d'erreur.
   */
  private static void collectEntitlements(Result result) {
    try {
      for (
        SObject entitlement : Database.query(
          'SELECT Id, MasterLabel, Setting, AmountUsed, CurrentAmountAllowed, Frequency ' +
          'FROM TenantUsageEntitlement LIMIT 500'
        )
      ) {
        Decimal allowed = (Decimal) entitlement.get('CurrentAmountAllowed');
        if (allowed == null || allowed <= 0) {
          continue;
        }
        AddOnRow row = new AddOnRow();
        row.key = 'ENT:' + String.valueOf(entitlement.get('Setting'));
        row.name = (String) entitlement.get('MasterLabel');
        row.kind = 'Usage entitlement';
        row.status = 'Active';
        row.total = allowed;
        Decimal used = (Decimal) entitlement.get('AmountUsed');
        row.used = used == null ? 0 : used;
        row.utilization = percent(row.used, row.total);
        // EndDate = fin de la période de mesure (mois en cours...), pas une expiration du contrat
        row.unit = (String) entitlement.get('Frequency');
        row.verdict = row.used > row.total
          ? 'Over limit'
          : row.utilization != null &&
              row.utilization >= 90
              ? 'Near limit'
              : 'In use';
        result.addOns.add(row);
      }
    } catch (Exception e) {
      // Objet absent de l'édition ou non accessible : section simplement vide
      return;
    }
  }

  @TestVisible
  private static String addOnVerdict(AddOnRow row, Date soon) {
    if (row.status != null && row.status != 'Active') {
      return row.expirationDate != null &&
        row.expirationDate < Date.today()
        ? 'Expired'
        : 'Inactive';
    }
    if (row.used == 0) {
      return 'Never assigned';
    }
    if (row.total != null && row.total >= 5 && row.utilization < 50) {
      return expiryVerdict(row.expirationDate, soon, 'Low use');
    }
    return expiryVerdict(row.expirationDate, soon, 'In use');
  }

  private static String expiryVerdict(
    Date expiration,
    Date soon,
    String fallback
  ) {
    if (expiration == null) {
      return fallback;
    }
    if (expiration < Date.today()) {
      return 'Expired';
    }
    return expiration <= soon ? 'Expiring soon' : fallback;
  }

  /** Licences de fonctionnalité attribuées aux utilisateurs internes actifs. */
  private static void collectFeatureLicenses(Result result) {
    Datetime threshold = Datetime.now().addDays(-INACTIVE_DAYS);
    for (String field : FEATURE_LICENSES.keySet()) {
      try {
        String base =
          'SELECT COUNT() FROM User WHERE IsActive = true AND UserType = \'Standard\' AND ' +
          field +
          ' = true';
        Integer assigned = Database.countQuery(
          base + ' LIMIT ' + FEATURE_LICENSE_CAP
        );
        if (assigned == 0) {
          continue;
        }
        FeatureLicenseRow row = new FeatureLicenseRow();
        row.key = field;
        row.name = FEATURE_LICENSES.get(field);
        row.assigned = assigned;
        row.inactive = Database.countQuery(
          base +
            ' AND (LastLoginDate = null OR LastLoginDate < :threshold) LIMIT ' +
            FEATURE_LICENSE_CAP
        );
        result.featureLicenses.add(row);
      } catch (Exception e) {
        // Champ absent de l'édition : licence ignorée
        continue;
      }
    }
  }

  private static Decimal percent(Decimal part, Decimal total) {
    if (total == null || total == 0 || part == null) {
      return null;
    }
    return (part * 100 / total).setScale(1);
  }

  /** Noms des licences et add-ons présents : servent à détecter les clouds de l'org. */
  public static Set<String> licenseNames(Result result) {
    Set<String> names = new Set<String>();
    for (UserLicenseRow row : result.userLicenses) {
      if (row.status == 'Active' && !row.included) {
        names.add(row.name.toLowerCase());
      }
    }
    for (AddOnRow row : result.addOns) {
      if (row.kind != 'Usage entitlement' && row.name != null) {
        names.add(row.name.toLowerCase());
      }
    }
    return names;
  }

  /** Utilisateurs attribués pour une licence de fonctionnalité (0 si absente). */
  public static Integer featureLicenseCount(Result result, String field) {
    for (FeatureLicenseRow row : result.featureLicenses) {
      if (row.key == field) {
        return row.assigned;
      }
    }
    return 0;
  }
}
