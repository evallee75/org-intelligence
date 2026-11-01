/**
 * Point d'entrée Apex de la section Security (administrateurs) : lancement d'un audit en lecture
 * seule. Le résultat est gardé par le navigateur (édition sans objet personnalisé).
 */
public with sharing class OrgSecurityController {
  public static OrgSecurityService.Audit runAudit() {
    OrgIntelAccess.assertAdmin();
    try {
      failIfSimulated();
      return OrgSecurityService.run();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The security audit could not be run', e);
    }
  }

  // ---------- Profiles & Permission Sets (lecture seule, résultat gardé par le navigateur) ----------

  public static OrgPermissionAnalysisService.Overview permissionOverview() {
    OrgIntelAccess.assertAdmin();
    try {
      failIfSimulated();
      return OrgPermissionAnalysisService.overview();
    } catch (Exception e) {
      throw OrgIntelAccess.error(
        'The profiles and permission sets could not be read',
        e
      );
    }
  }

  public static OrgPermissionAnalysisService.Users permissionUsers() {
    OrgIntelAccess.assertAdmin();
    try {
      failIfSimulated();
      return OrgPermissionAnalysisService.users();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The user assignments could not be read', e);
    }
  }

  public static OrgPermissionAnalysisService.ObjectAccess permissionObjectAccess(
    List<Id> containerIds
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      failIfSimulated();
      return OrgPermissionAnalysisService.objectAccess(containerIds);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The object permissions could not be read', e);
    }
  }

  public static OrgPermissionAnalysisService.FieldAccess permissionFieldAccess(
    String objectName
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      failIfSimulated();
      return OrgPermissionAnalysisService.fieldAccess(objectName);
    } catch (AuraHandledException e) {
      throw e;
    } catch (Exception e) {
      throw OrgIntelAccess.error('The field permissions could not be read', e);
    }
  }

  public static OrgPermissionAnalysisService.Comparison comparePermissions(
    Id leftId,
    Id rightId
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      failIfSimulated();
      return OrgPermissionAnalysisService.compare(leftId, rightId);
    } catch (AuraHandledException e) {
      throw e;
    } catch (Exception e) {
      throw OrgIntelAccess.error('The comparison could not be made', e);
    }
  }

  /** Panne simulée par les tests pour vérifier la traduction des erreurs (jamais active hors test). */
  @TestVisible
  private static String simulatedFailure;

  private static void failIfSimulated() {
    if (Test.isRunningTest() && simulatedFailure != null) {
      throw new IllegalArgumentException(simulatedFailure);
    }
  }
}
