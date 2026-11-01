/**
 * Entrée du module Inventory : découverte par le socle (OrgIntelModules), elle sert l'écran
 * « Inventory » (inventaire des métadonnées à la manière d'Org Check). Le module n'a aucun objet :
 * l'accès est donné par la custom permission OrgIntelligence_Inventory (permission set du module).
 */
@NamespaceAccessible
public inherited sharing class OrgIntelInventoryModule extends OrgIntelModule {
  @NamespaceAccessible
  public static final String PERMISSION = 'OrgIntelligence_Inventory';

  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.INVENTORY;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return FeatureManagement.checkPermission(PERMISSION);
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'getCatalog' {
        return OrgInventoryController.getCatalog();
      }
      when 'getDataset' {
        return OrgInventoryController.getDataset(text(params, 'name'));
      }
    }
    throw unknownAction(action);
  }
}
