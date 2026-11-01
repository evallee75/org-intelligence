/**
 * Outil « installation depuis les sources » : désinstallation complète d'Org Intelligence
 * (Settings › Uninstall), appelée par les écrans via OrgIntelModuleController.invoke('uninstall', ...).
 *
 * Ce dossier (source-tools/) n'appartient à aucun package : il est déployé par scripts/install.mjs
 * avec le socle et les modules. Une installation par packages non verrouillés
 * se désinstalle depuis Setup › Installed Packages ; le bouton Uninstall n'y apparaît pas, puisque
 * le socle découvre cette classe dynamiquement (OrgIntelModules, clé « uninstall »).
 */
public with sharing class OrgIntelUninstallTool extends OrgIntelModule {
  public override String key() {
    return OrgIntelModules.UNINSTALL;
  }

  /**
   * Administrateur Org Intelligence, ou utilisateur autorisé à déployer des métadonnées : la
   * désinstallation retire les assignations des permission sets dès sa première transaction, le suivi
   * doit rester possible ensuite.
   */
  public override Boolean isAccessible() {
    return OrgIntelAccess.isAdmin() || canDeployMetadata();
  }

  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'getStatus' {
        OrgIntelAccess.assertAdmin();
        try {
          return OrgUninstallService.getStatus();
        } catch (Exception e) {
          throw OrgIntelAccess.error(
            'The uninstall options could not be loaded',
            e
          );
        }
      }
      when 'prepare' {
        OrgIntelAccess.assertAdmin();
        try {
          return OrgUninstallService.prepare(text(params, 'confirmation'));
        } catch (Exception e) {
          throw OrgIntelAccess.error('The reports could not be removed', e);
        }
      }
      when 'uninstall' {
        OrgIntelAccess.assertAdmin();
        try {
          return OrgUninstallService.uninstall(
            text(params, 'confirmation'),
            booleanValue(params, 'removeToolingConnection') == true
          );
        } catch (Exception e) {
          throw OrgIntelAccess.error('The uninstall could not start', e);
        }
      }
      when 'getDeployStatus' {
        try {
          return OrgUninstallService.getDeployStatus(text(params, 'deployId'));
        } catch (Exception e) {
          throw OrgIntelAccess.error(
            'The uninstall progress could not be read',
            e
          );
        }
      }
    }
    throw unknownAction(action);
  }

  private static Boolean canDeployMetadata() {
    List<UserPermissionAccess> access = [
      SELECT PermissionsModifyAllData, PermissionsModifyMetadata
      FROM UserPermissionAccess
      LIMIT 1
    ];
    return !access.isEmpty() &&
      (access[0].PermissionsModifyAllData ||
      access[0].PermissionsModifyMetadata);
  }
}
