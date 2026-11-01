/**
 * Tests de l'entrée du module Inventory et de son contrôleur : appels par
 * la classe d'entrée (invoke, comme l'écran), accès refusés et action inconnue.
 */
@IsTest
private class OrgIntelInventoryModuleTest {
  @IsTest
  static void adminReadsTheCatalogAndADataset() {
    User u = OrgInventoryTestSupport.adminWith(
      OrgInventoryTestSupport.fullAccess()
    );
    System.runAs(u) {
      OrgInventoryTestSupport.useTooling(
        true,
        new OrgInventoryTestSupport.ToolingRouter()
      );
      Test.startTest();
      String catalog = OrgInventoryTestSupport.invokeModule(
        new OrgIntelInventoryModule(),
        'getCatalog',
        null
      );
      String dataset = OrgInventoryTestSupport.invokeModule(
        new OrgIntelInventoryModule(),
        'getDataset',
        new Map<String, Object>{ 'name' => 'customTabs' }
      );
      Test.stopTest();

      Map<String, Object> labels = (Map<String, Object>) JSON.deserializeUntyped(
        catalog
      );
      Assert.areEqual(OrgInventoryService.DATASETS.size(), labels.size());
      Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
        dataset
      );
      Assert.areEqual('customTabs', result.get('name'));
      Assert.areEqual(2, result.get('total'));

      OrgIntelInventoryModule module = new OrgIntelInventoryModule();
      Assert.areEqual(OrgIntelModules.INVENTORY, module.key());
      Assert.isTrue(module.isAccessible());
    }
  }

  @IsTest
  static void unknownActionAndDatasetAreRefused() {
    User u = OrgInventoryTestSupport.adminWith(
      OrgInventoryTestSupport.fullAccess()
    );
    System.runAs(u) {
      OrgInventoryTestSupport.useTooling(false, null);
      try {
        new OrgIntelInventoryModule().invoke('nope', new Map<String, Object>());
        Assert.fail('action inconnue');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('nope'));
      }
      try {
        OrgInventoryController.getDataset('nope');
        Assert.fail('jeu inconnu');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().contains('could not be loaded'),
          e.getMessage()
        );
      }
    }
  }

  @IsTest
  static void moduleIsRefusedWithoutItsPermissionSet() {
    User u = OrgInventoryTestSupport.restrictedUser(
      new List<String>{ OrgInventoryTestSupport.CORE_ADMIN }
    );
    if (u == null) {
      return; // aucun profil restreint dans l'org de test
    }
    System.runAs(u) {
      Assert.isFalse(new OrgIntelInventoryModule().isAccessible());
      try {
        OrgInventoryTestSupport.invokeModule(
          new OrgIntelInventoryModule(),
          'getCatalog',
          null
        );
        Assert.fail('module refusé');
      } catch (AuraHandledException e) {
        Assert.isTrue(
          e.getMessage().contains('do not have access'),
          e.getMessage()
        );
      }
    }
  }

  @IsTest
  static void coreAdminIsRequired() {
    User u = OrgInventoryTestSupport.restrictedUser(
      new List<String>{ OrgInventoryTestSupport.MODULE_ADMIN }
    );
    if (u == null) {
      return;
    }
    System.runAs(u) {
      try {
        OrgInventoryController.getCatalog();
        Assert.fail('administration du socle exigée');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('Org Intelligence'));
      }
    }
  }
}
