/**
 * Entrée du module Security : découverte par le socle (OrgIntelModules), elle sert l'écran
 * « Security » (audit de sécurité de l'org) et l'écran « Profiles & Permission Sets » (analyse
 * des droits, OrgPermissionAnalysisService). Le module n'a aucun objet : l'accès est donné par la
 * custom permission OrgIntelligence_Security (permission set du module). Le navigateur garde
 * l'audit, construit le rapport imprimable et envoie les recommandations.
 */
@NamespaceAccessible
public inherited sharing class OrgIntelSecurityModule extends OrgIntelModule {
  @NamespaceAccessible
  public static final String PERMISSION = 'OrgIntelligence_Security';

  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.SECURITY;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return FeatureManagement.checkPermission(PERMISSION);
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'runAudit' {
        return OrgSecurityController.runAudit();
      }
      when 'permissionOverview' {
        return OrgSecurityController.permissionOverview();
      }
      when 'permissionUsers' {
        return OrgSecurityController.permissionUsers();
      }
      when 'permissionObjectAccess' {
        return OrgSecurityController.permissionObjectAccess(
          idList(params.get('containerIds'))
        );
      }
      when 'permissionFieldAccess' {
        return OrgSecurityController.permissionFieldAccess(
          (String) params.get('objectName')
        );
      }
      when 'comparePermissions' {
        return OrgSecurityController.comparePermissions(
          toId(params.get('leftId')),
          toId(params.get('rightId'))
        );
      }
    }
    throw unknownAction(action);
  }

  private static List<Id> idList(Object value) {
    List<Id> ids = new List<Id>();
    if (value instanceof List<Object>) {
      for (Object item : (List<Object>) value) {
        Id id = toId(item);
        if (id != null) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  private static Id toId(Object value) {
    if (value == null || String.isBlank(String.valueOf(value))) {
      return null;
    }
    try {
      return Id.valueOf(String.valueOf(value));
    } catch (Exception e) {
      throw OrgIntelAccess.error('Invalid identifier: ' + value);
    }
  }
}
