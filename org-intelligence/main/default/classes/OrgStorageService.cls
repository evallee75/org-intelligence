/**
 * Vue Storage, partie serveur : limites de stockage en direct (OrgLimits).
 * La photographie par objet, son évolution et les constats STORAGE_* viennent des scans gardés
 * dans le navigateur (orgIntelScanData.buildStorageView).
 */
public inherited sharing class OrgStorageService {
  public class StorageView {
    @AuraEnabled
    public Integer dataUsedMb;
    @AuraEnabled
    public Integer dataMaxMb;
    @AuraEnabled
    public Integer fileUsedMb;
    @AuraEnabled
    public Integer fileMaxMb;
  }

  public static StorageView getView() {
    StorageView view = new StorageView();
    Map<String, System.OrgLimit> limits = OrgLimits.getMap();
    if (limits.containsKey('DataStorageMB')) {
      view.dataUsedMb = limits.get('DataStorageMB').getValue();
      view.dataMaxMb = limits.get('DataStorageMB').getLimit();
    }
    if (limits.containsKey('FileStorageMB')) {
      view.fileUsedMb = limits.get('FileStorageMB').getValue();
      view.fileMaxMb = limits.get('FileStorageMB').getLimit();
    }
    return view;
  }
}
