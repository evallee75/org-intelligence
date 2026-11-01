/**
 * Contrôles d'accès communs aux contrôleurs Org Intelligence et traduction des erreurs en messages
 * lisibles (sans pile d'appels ni détail technique sensible).
 */
@NamespaceAccessible
public inherited sharing class OrgIntelAccess {
  @NamespaceAccessible
  public static Boolean isAdmin() {
    return FeatureManagement.checkPermission(
      OrgIntelligenceConstants.ADMIN_PERMISSION
    );
  }

  /**
   * Consultation : custom permission OrgIntelligence_User ou OrgIntelligence_Admin (permission sets
   * du socle). Les modules contrôlent en plus l'accès à leurs propres données.
   */
  @NamespaceAccessible
  public static Boolean canRead() {
    return isAdmin() ||
      FeatureManagement.checkPermission(
        OrgIntelligenceConstants.USER_PERMISSION
      );
  }

  @NamespaceAccessible
  public static void assertCanRead() {
    if (!canRead()) {
      throw error(
        'You do not have access to Org Intelligence. Ask your administrator for the ' +
        '"Org Intelligence - User" or "Org Intelligence - Admin" permission set.'
      );
    }
  }

  @NamespaceAccessible
  public static void assertAdmin() {
    assertCanRead();
    if (!isAdmin()) {
      throw error(
        'This action is reserved to Org Intelligence administrators ("Org Intelligence - Admin" permission set).'
      );
    }
  }

  @NamespaceAccessible
  public static AuraHandledException error(String message) {
    AuraHandledException e = new AuraHandledException(message);
    e.setMessage(message);
    return e;
  }

  /** Message d'une exception métier ou plateforme, préfixé par le contexte de l'action. */
  @NamespaceAccessible
  public static AuraHandledException error(String context, Exception cause) {
    if (cause instanceof AuraHandledException) {
      return (AuraHandledException) cause;
    }
    String message = cause.getMessage();
    if (cause instanceof DmlException) {
      message = ((DmlException) cause).getDmlMessage(0);
    }
    return error(context + ': ' + message);
  }
}
