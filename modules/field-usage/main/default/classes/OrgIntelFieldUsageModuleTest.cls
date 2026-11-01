/**
 * Entrée du module Field Usage : chaque action passe par la classe d'entrée (invoke, comme
 * l'écran), avec un administrateur portant le permission set du module, et les refus d'accès.
 */
@IsTest
private class OrgIntelFieldUsageModuleTest {
  private static final String MODULE = 'fieldUsage';

  @TestSetup
  static void setup() {
    OrgFieldUsageTestSupport.adminUser(
      new List<String>{
        OrgFieldUsageTestSupport.CORE_ADMIN_PS,
        OrgFieldUsageTestSupport.MODULE_PS
      }
    );
    // Product2 : objet rarement personnalisé (ni règle de validation ni trigger en général)
    insert new List<Product2>{
      new Product2(Name = 'Acme', ProductCode = 'A1', IsActive = true),
      new Product2(Name = 'Globex', IsActive = false)
    };
  }

  private static User admin() {
    return [
      SELECT Id
      FROM User
      WHERE LastName = 'FieldUsage' AND IsActive = TRUE
      ORDER BY CreatedDate DESC
      LIMIT 1
    ];
  }

  private static Object call(String action, Map<String, Object> params) {
    String result = OrgFieldUsageTestSupport.invokeModule(
      new OrgIntelFieldUsageModule(),
      action,
      params
    );
    return result == null ? null : JSON.deserializeUntyped(result);
  }

  @IsTest
  static void allActionsAnswerThroughTheModuleEntry() {
    OrgFieldUsageTestSupport.useTooling(false);
    System.runAs(admin()) {
      Test.startTest();
      Assert.isTrue(
        new OrgIntelFieldUsageModule().isAccessible(),
        'permission set du module assigné'
      );
      Assert.areEqual(MODULE, new OrgIntelFieldUsageModule().key());

      List<Object> objects = (List<Object>) call('getObjects', null);
      Assert.isFalse(objects.isEmpty(), 'objets analysables');

      Map<String, Object> prepared = (Map<String, Object>) call(
        'prepareAnalysis',
        new Map<String, Object>{
          'objectName' => 'Product2',
          'recentDays' => 30
        }
      );
      Assert.areEqual('Product2', prepared.get('objectName'));
      Assert.areEqual(30, prepared.get('recentDays'));

      Map<String, Object> chunk = (Map<String, Object>) call(
        'scanChunk',
        new Map<String, Object>{
          'objectName' => 'Product2',
          'fields' => new List<Object>{ 'Name', 'ProductCode', 'IsActive' },
          'lastId' => null,
          'chunkSize' => 500,
          'recentSince' => '2000-01-01T00:00:00.000Z'
        }
      );
      Assert.areEqual(2, chunk.get('records'));
      Assert.areEqual(true, chunk.get('done'));

      Map<String, Object> stats = (Map<String, Object>) chunk.get('stats');
      Map<String, Object> analysis = (Map<String, Object>) call(
        'finalizeAnalysis',
        new Map<String, Object>{
          'objectName' => 'Product2',
          'recentDays' => 30,
          'recordCount' => 2,
          'recentCount' => 2,
          'stats' => stats,
          'meta' => prepared.get('meta')
        }
      );
      Assert.areEqual(3, ((List<Object>) analysis.get('fields')).size());

      Map<String, Object> setup = (Map<String, Object>) call(
        'analyzeObjectSetup',
        new Map<String, Object>{ 'objectName' => 'Account' }
      );
      Assert.areEqual('Account', setup.get('objectName'));
      Assert.areEqual(false, setup.get('toolingAvailable'));
      Test.stopTest();
    }
  }

  @IsTest
  static void optionalParametersMayBeMissing() {
    System.runAs(admin()) {
      OrgIntelFieldUsageModule module = new OrgIntelFieldUsageModule();
      Object result = module.invoke(
        'scanChunk',
        new Map<String, Object>{
          'objectName' => 'Account',
          'recentSince' => ''
        }
      );
      Assert.isNotNull(result);
      OrgFieldUsageService.AnalysisResult analysis = (OrgFieldUsageService.AnalysisResult) module.invoke(
        'finalizeAnalysis',
        new Map<String, Object>{ 'objectName' => 'Account' }
      );
      Assert.areEqual(0, analysis.fields.size(), 'aucun agrégat : aucun champ');
    }
  }

  @IsTest
  static void unknownActionIsRefused() {
    System.runAs(admin()) {
      try {
        new OrgIntelFieldUsageModule()
          .invoke('nope', new Map<String, Object>());
        Assert.fail('action inconnue');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('nope'), e.getMessage());
      }
    }
  }

  @IsTest
  static void userWithoutTheModulePermissionSetIsRefused() {
    User user = OrgFieldUsageTestSupport.standardUser(
      new List<String>{ OrgFieldUsageTestSupport.CORE_ADMIN_PS }
    );
    System.runAs(user) {
      Assert.isFalse(new OrgIntelFieldUsageModule().isAccessible());
      try {
        call('getObjects', null);
        Assert.fail('accès au module refusé attendu');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('access'), e.getMessage());
      }
    }
  }

  @IsTest
  static void moduleUserWithoutCoreAdminIsRefused() {
    User user = OrgFieldUsageTestSupport.standardUser(
      new List<String>{ OrgFieldUsageTestSupport.MODULE_PS }
    );
    System.runAs(user) {
      try {
        call('getObjects', null);
        Assert.fail('accès Org Intelligence refusé attendu');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().contains('Org Intelligence'),
          e.getMessage()
        );
      }
    }
  }
}
