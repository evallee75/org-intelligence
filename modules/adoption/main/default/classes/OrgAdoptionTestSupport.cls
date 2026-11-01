/**
 * Données de test du module Adoption : utilisateurs (avec ou sans les permission sets) et analyse
 * synthétique construite en mémoire (licences, add-ons, fonctionnalités, clouds), indépendante des
 * licences réelles de l'org de test.
 */
@IsTest
public class OrgAdoptionTestSupport {
  public static final String CORE_ADMIN_PS = 'OrgIntelligence_Admin';
  public static final String MODULE_PS = 'OrgIntelligence_Adoption_Admin';

  /** Administrateur Org Intelligence avec le module Adoption. */
  public static User adminUser() {
    return newUser(
      adminProfileId(),
      new List<String>{ CORE_ADMIN_PS, MODULE_PS }
    );
  }

  /** Administrateur Org Intelligence sans le permission set du module (profil sans droits étendus). */
  public static User userWithoutModule() {
    return newUser(basicProfileId(), new List<String>{ CORE_ADMIN_PS });
  }

  /** Permission set du module seul, sans l'administration du socle. */
  public static User moduleOnlyUser() {
    return newUser(basicProfileId(), new List<String>{ MODULE_PS });
  }

  private static Id adminProfileId() {
    return [
      SELECT Id
      FROM Profile
      WHERE PermissionsModifyAllData = TRUE AND UserType = 'Standard'
      ORDER BY CreatedDate
      LIMIT 1
    ]
    .Id;
  }

  private static Id basicProfileId() {
    List<Profile> profiles = [
      SELECT Id
      FROM Profile
      WHERE
        UserType = 'Standard'
        AND PermissionsModifyAllData = FALSE
        AND PermissionsViewAllData = FALSE
        AND PermissionsCustomizeApplication = FALSE
        AND UserLicense.Name = 'Salesforce'
      ORDER BY CreatedDate
      LIMIT 1
    ];
    return profiles.isEmpty() ? adminProfileId() : profiles[0].Id;
  }

  private static Integer sequence = 0;

  private static User newUser(Id profileId, List<String> permissionSets) {
    sequence++;
    String unique = 'oiad' + sequence + DateTime.now().getTime();
    User user = new User(
      ProfileId = profileId,
      Username = unique + '@example.com.test',
      Email = unique + '@example.com.test',
      LastName = 'Adoption ' + sequence,
      Alias = ('oiad' + sequence).left(8),
      TimeZoneSidKey = 'Europe/Paris',
      LocaleSidKey = 'en_US',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US'
    );
    System.runAs(new User(Id = UserInfo.getUserId())) {
      insert user;
      List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
      for (PermissionSet ps : [
        SELECT Id
        FROM PermissionSet
        WHERE Name IN :permissionSets
      ]) {
        assignments.add(
          new PermissionSetAssignment(
            AssigneeId = user.Id,
            PermissionSetId = ps.Id
          )
        );
      }
      insert assignments;
    }
    return user;
  }

  // ---------- Analyse synthétique ----------

  public static OrgAdoptionService.Analysis analysis() {
    OrgAdoptionService.Analysis analysis = new OrgAdoptionService.Analysis();
    analysis.generatedAt = Datetime.now();
    analysis.generatedBy = 'Test';
    analysis.score = 50;
    analysis.selectedClouds = new List<String>{ OrgAdoptionFeatures.SALES };

    OrgAdoptionLicenses.Result licenses = new OrgAdoptionLicenses.Result();
    licenses.userLicenses.add(
      userLicense('Salesforce', 'Active', 30, 20, 5, false)
    );
    licenses.userLicenses.add(
      userLicense('Salesforce Platform', 'Active', 10, 10, 0, false)
    );
    licenses.userLicenses.add(
      userLicense('Chatter Free', 'Active', 5000, 3, 0, true)
    );
    licenses.userLicenses.add(
      userLicense('Old License', 'Disabled', 5, 0, 0, false)
    );
    licenses.addOns.add(
      addOn(
        'PSL:SalesConsole',
        'Sales Console User',
        'Permission set license',
        10,
        0,
        'Never assigned',
        null
      )
    );
    licenses.addOns.add(
      addOn('PSL:Cpq', 'CPQ', 'Permission set license', 20, 3, 'Low use', null)
    );
    licenses.addOns.add(
      addOn(
        'PKG:033000000000001',
        'acme',
        'Managed package',
        5,
        5,
        'In use',
        null
      )
    );
    licenses.addOns.add(
      addOn(
        'ENT:ApiCalls',
        'API calls',
        'Usage entitlement',
        1000,
        1200,
        'Over limit',
        'Daily'
      )
    );
    analysis.licenses = licenses;

    analysis.features.add(
      feature(
        'LEADS',
        OrgAdoptionFeatures.SALES,
        2,
        OrgAdoptionFeatures.NOT_USED
      )
    );
    analysis.features.add(
      feature(
        'QUOTES',
        OrgAdoptionFeatures.SALES,
        1,
        OrgAdoptionFeatures.PARTIAL
      )
    );
    analysis.features.add(
      feature(
        'OPPORTUNITIES',
        OrgAdoptionFeatures.SALES,
        2,
        OrgAdoptionFeatures.ADOPTED
      )
    );
    analysis.features.add(
      feature(
        'KNOWLEDGE',
        OrgAdoptionFeatures.SERVICE,
        2,
        OrgAdoptionFeatures.NOT_ENABLED
      )
    );

    OrgAdoptionFeatures.CloudSummary sales = new OrgAdoptionFeatures.CloudSummary();
    sales.name = OrgAdoptionFeatures.SALES;
    sales.detected = true;
    sales.selected = true;
    sales.score = 40;
    analysis.clouds.add(sales);
    return analysis;
  }

  public static OrgAdoptionLicenses.UserLicenseRow userLicense(
    String name,
    String status,
    Integer total,
    Integer used,
    Integer inactive,
    Boolean included
  ) {
    OrgAdoptionLicenses.UserLicenseRow row = new OrgAdoptionLicenses.UserLicenseRow();
    row.key = name.replace(' ', '');
    row.name = name;
    row.status = status;
    row.total = total;
    row.used = used;
    row.unused = Math.max(total - used, 0);
    row.inactive = inactive;
    row.included = included;
    row.verdict = OrgAdoptionLicenses.licenseVerdict(row);
    return row;
  }

  public static OrgAdoptionLicenses.AddOnRow addOn(
    String key,
    String name,
    String kind,
    Decimal total,
    Decimal used,
    String verdict,
    String unit
  ) {
    OrgAdoptionLicenses.AddOnRow row = new OrgAdoptionLicenses.AddOnRow();
    row.key = key;
    row.name = name;
    row.kind = kind;
    row.status = 'Active';
    row.total = total;
    row.used = used;
    row.verdict = verdict;
    row.unit = unit;
    return row;
  }

  public static OrgAdoptionFeatures.Feature feature(
    String key,
    String cloud,
    Integer weight,
    String status
  ) {
    OrgAdoptionFeatures.Feature feature = new OrgAdoptionFeatures.Feature();
    feature.key = key;
    feature.cloud = cloud;
    feature.label = key + ' label';
    feature.weight = weight;
    feature.status = status;
    feature.description = 'Description';
    feature.benefit = 'Benefit';
    feature.nextStep = 'Next step';
    feature.learnUrl = 'https://trailhead.salesforce.com';
    feature.metric = 'Metric';
    return feature;
  }

  /** Lignes de contrat au format envoyé par l'écran (maps JSON). */
  public static List<Object> contractLines() {
    return new List<Object>{
      new Map<String, Object>{
        'id' => 'L1',
        'product' => 'Sales Cloud Enterprise',
        'lineType' => OrgAdoptionContract.TYPE_USER_LICENSE,
        'cloud' => OrgAdoptionFeatures.SALES,
        'quantity' => '30',
        'unitPrice' => '165',
        'pricePeriod' => OrgAdoptionContract.PER_MONTH,
        'startDate' => '2026-01-01',
        'endDate' => String.valueOf(Date.today().addDays(60)),
        'matchedKey' => 'USER:Salesforce',
        'matchedLabel' => 'User license: Salesforce'
      },
      new Map<String, Object>{
        'id' => 'L2',
        'product' => 'Platform',
        'quantity' => 11,
        'unitPrice' => 300,
        'pricePeriod' => OrgAdoptionContract.PER_YEAR,
        'matchedKey' => 'USER:Salesforce Platform',
        'matchedLabel' => 'User license: Salesforce Platform'
      },
      new Map<String, Object>{
        'id' => 'L3',
        'product' => 'API calls',
        'lineType' => OrgAdoptionContract.TYPE_ENTITLEMENT,
        'quantity' => 1000,
        'matchedKey' => 'ENT:ApiCalls'
      },
      new Map<String, Object>{
        'id' => 'L4',
        'product' => 'Unlinked product',
        'quantity' => 'abc',
        'unitPrice' => '-5',
        'endDate' => 'not a date'
      },
      new Map<String, Object>{
        'id' => 'L5',
        'product' => 'CPQ',
        'lineType' => OrgAdoptionContract.TYPE_ADD_ON,
        'matchedKey' => 'PSL:Cpq'
      },
      new Map<String, Object>{
        'id' => 'L6',
        'product' => 'Missing license',
        'quantity' => 3,
        'matchedKey' => 'USER:Unknown'
      },
      new Map<String, Object>{ 'id' => 'L7', 'product' => '  ' },
      'not a map'
    };
  }

  /** Version JSON (maps non typées) d'une valeur, comme envoyée par l'écran. */
  public static Object untyped(Object value) {
    return JSON.deserializeUntyped(JSON.serialize(value));
  }

  /**
   * Appel d'une action comme l'écran, sans OrgIntelModuleController (@AuraEnabled, donc invisible
   * depuis un autre paquet du même namespace) : contrôle d'accès du module, paramètres passés par
   * JSON, résultat sérialisé, erreurs traduites en message lisible.
   */
  public static String invokeModule(
    OrgIntelModule module,
    String action,
    Map<String, Object> params
  ) {
    if (!module.isAccessible()) {
      throw OrgIntelAccess.error(
        'You do not have access to the Org Intelligence module ' + module.key()
      );
    }
    try {
      Map<String, Object> input = params == null
        ? new Map<String, Object>()
        : (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(params));
      Object result = module.invoke(action, input);
      return result == null ? null : JSON.serialize(result);
    } catch (AuraHandledException e) {
      throw e;
    } catch (Exception e) {
      throw OrgIntelAccess.error('The action could not be completed', e);
    }
  }
}
