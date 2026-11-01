/**
 * Actions des recommandations, de la collaboration et de l'export Jira, appelées par les écrans via
 * OrgIntelModuleController → OrgIntelRecommendationsModule.
 * Contrôleur mince : droits, délégation aux services, messages d'erreur lisibles.
 */
public with sharing class OrgRecommendationController {
  public static OrgRecommendationService.RecommendationList listRecommendations() {
    OrgIntelAccess.assertCanRead();
    try {
      return OrgRecommendationService.listRecommendations();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The recommendations could not be loaded', e);
    }
  }

  public static OrgRecommendationService.Detail getRecommendation(Id recordId) {
    OrgIntelAccess.assertCanRead();
    try {
      return OrgRecommendationService.getDetail(recordId);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The recommendation could not be loaded', e);
    }
  }

  /**
   * @param changesJson clés possibles : status, decisionReason, assignedToId, dueDate (AAAA-MM-JJ),
   *                    severity ; seules les clés présentes sont appliquées.
   */
  public static Integer updateRecommendations(
    List<Id> recordIds,
    String changesJson
  ) {
    OrgIntelAccess.assertCanRead();
    try {
      Map<String, Object> changes = String.isBlank(changesJson)
        ? new Map<String, Object>()
        : (Map<String, Object>) JSON.deserializeUntyped(changesJson);
      if (changes.containsKey('severity') && !OrgIntelAccess.isAdmin()) {
        throw OrgIntelAccess.error(
          'Only Org Intelligence administrators can change the severity.'
        );
      }
      return OrgRecommendationService.applyChanges(recordIds, changes);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The recommendation could not be updated', e);
    }
  }

  public static List<OrgRecommendationService.Comment> postComment(
    Id recordId,
    String text,
    String mentionsJson,
    String parentCommentId
  ) {
    OrgIntelAccess.assertCanRead();
    try {
      List<OrgRecommendationService.MentionInput> mentions = String.isBlank(
          mentionsJson
        )
        ? new List<OrgRecommendationService.MentionInput>()
        : (List<OrgRecommendationService.MentionInput>) JSON.deserialize(
            mentionsJson,
            List<OrgRecommendationService.MentionInput>.class
          );
      OrgRecommendationService.postComment(
        recordId,
        text,
        mentions,
        parentCommentId
      );
      return OrgRecommendationService.loadComments(recordId);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The comment could not be posted', e);
    }
  }

  public static Boolean setFollowing(Id recordId, Boolean follow) {
    OrgIntelAccess.assertCanRead();
    try {
      return OrgRecommendationService.setFollowing(recordId, follow);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The subscription could not be changed', e);
    }
  }

  public static List<OrgRecommendationService.UserOption> searchUsers(
    String term
  ) {
    OrgIntelAccess.assertCanRead();
    try {
      return OrgRecommendationService.searchUsers(term);
    } catch (Exception e) {
      throw OrgIntelAccess.error('Users could not be searched', e);
    }
  }

  // ---------- Jira ----------

  // Export Jira réservé aux administrateurs : les tickets sont créés avec le compte Jira partagé.
  public static OrgJiraService.Preview previewJiraExport(List<Id> recordIds) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgJiraService.preview(recordIds);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The Jira export could not be prepared', e);
    }
  }

  public static List<OrgJiraService.ExportResult> exportToJira(
    List<Id> recordIds,
    Boolean includeExported
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgJiraService.export(recordIds, includeExported);
    } catch (Exception e) {
      throw OrgIntelAccess.error('The export to Jira failed', e);
    }
  }

  // ---------- Jira : réglages (administrateurs) ----------

  public static OrgJiraService.JiraStatus getJiraSettings() {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgJiraService.status();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The Jira settings could not be loaded', e);
    }
  }

  public static void saveJiraSettings(
    String siteUrl,
    String email,
    String apiToken,
    String projectKey,
    String issueType
  ) {
    OrgIntelAccess.assertAdmin();
    try {
      OrgJiraService.saveSettings(
        siteUrl,
        email,
        apiToken,
        projectKey,
        issueType
      );
    } catch (Exception e) {
      throw OrgIntelAccess.error('The Jira settings could not be saved', e);
    }
  }

  public static OrgJiraService.JiraStatus testJiraConnection() {
    OrgIntelAccess.assertAdmin();
    try {
      return OrgJiraService.testConnection();
    } catch (Exception e) {
      throw OrgIntelAccess.error('The Jira connection could not be tested', e);
    }
  }
}
