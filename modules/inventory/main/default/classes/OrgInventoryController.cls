/**
 * Point d'entrée Apex de la section Inventory (administrateurs) : catalogue et jeux de données de
 * l'inventaire. Rien n'est enregistré dans l'org : l'écran garde les résultats dans le navigateur.
 */
public with sharing class OrgInventoryController {
  public static Map<String, String> getCatalog() {
    OrgIntelAccess.assertAdmin();
    return OrgInventoryService.DATASETS;
  }

  public static OrgInventoryService.Dataset getDataset(String name) {
    OrgIntelAccess.assertAdmin();
    try {
      return new OrgInventoryService().load(name);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The inventory could not be loaded', e);
    }
  }
}
