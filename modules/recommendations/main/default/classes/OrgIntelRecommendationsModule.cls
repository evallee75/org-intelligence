/**
 * Entrée du module Recommendations : découverte par le socle (OrgIntelModules), elle sert les écrans
 * (recommandations, panneau de collaboration, export et réglages Jira, activité de l'équipe), reçoit
 * les constats des scans faits dans le navigateur (syncScan) et fournit au socle les indicateurs des
 * recommandations.
 */
@NamespaceAccessible
public inherited sharing class OrgIntelRecommendationsModule extends OrgIntelModule implements OrgIntelRecommendationSource {
  @NamespaceAccessible
  public override String key() {
    return OrgIntelModules.RECOMMENDATIONS;
  }

  @NamespaceAccessible
  public override Boolean isAccessible() {
    return Schema.SObjectType.OrgRecommendation__c.isAccessible();
  }

  @NamespaceAccessible
  public override Object invoke(String action, Map<String, Object> params) {
    switch on action {
      when 'listRecommendations' {
        return OrgRecommendationController.listRecommendations();
      }
      when 'getRecommendation' {
        return OrgRecommendationController.getRecommendation(
          recordId(params, 'recordId')
        );
      }
      when 'updateRecommendations' {
        return OrgRecommendationController.updateRecommendations(
          idList(params, 'recordIds'),
          text(params, 'changesJson')
        );
      }
      when 'postComment' {
        return OrgRecommendationController.postComment(
          recordId(params, 'recordId'),
          text(params, 'text'),
          text(params, 'mentionsJson'),
          text(params, 'parentCommentId')
        );
      }
      when 'setFollowing' {
        return OrgRecommendationController.setFollowing(
          recordId(params, 'recordId'),
          booleanValue(params, 'follow')
        );
      }
      when 'searchUsers' {
        return OrgRecommendationController.searchUsers(text(params, 'term'));
      }
      when 'recentActivity' {
        OrgIntelAccess.assertCanRead();
        return OrgRecommendationService.recentActivity(12);
      }
      when 'previewJiraExport' {
        return OrgRecommendationController.previewJiraExport(
          idList(params, 'recordIds')
        );
      }
      when 'exportToJira' {
        return OrgRecommendationController.exportToJira(
          idList(params, 'recordIds'),
          booleanValue(params, 'includeExported')
        );
      }
      when 'getJiraSettings' {
        return OrgRecommendationController.getJiraSettings();
      }
      when 'saveJiraSettings' {
        OrgRecommendationController.saveJiraSettings(
          text(params, 'siteUrl'),
          text(params, 'email'),
          text(params, 'apiToken'),
          text(params, 'projectKey'),
          text(params, 'issueType')
        );
        return null;
      }
      when 'testJiraConnection' {
        return OrgRecommendationController.testJiraConnection();
      }
      when 'syncScan' {
        // Constats d'un scan fait dans le navigateur (édition collaborative)
        OrgIntelAccess.assertAdmin();
        Object completedAt = params.get('completedAt');
        return OrgRecommendationSync.syncScan(
          (List<Object>) params.get('findings'),
          textList(params, 'reliableRules'),
          text(params, 'scanName'),
          completedAt == null || String.isBlank(String.valueOf(completedAt))
            ? null
            : (Datetime) JSON.deserialize(
                '"' + String.valueOf(completedAt) + '"',
                Datetime.class
              )
        );
      }
      when 'linksForFingerprints' {
        OrgIntelAccess.assertCanRead();
        return OrgRecommendationSync.linksForFingerprints(
          textList(params, 'fingerprints')
        );
      }
      when 'upsertExternal' {
        // Recommandations des analyses (Security, Adoption, Objects & Fields…) envoyées par le
        // navigateur (c/orgIntelRecommendationStore), réservé aux administrateurs.
        OrgIntelAccess.assertAdmin();
        return OrgRecommendationService.upsertExternal(
          (List<Object>) params.get('recommendations'),
          text(params, 'reopenReason')
        );
      }
      when 'importDecisions' {
        // Recommandations et décisions gardées dans un navigateur (édition sans objet ou fichier
        // partagé), reprises dans les recommandations partagées : réservé aux administrateurs.
        OrgIntelAccess.assertAdmin();
        try {
          return OrgRecommendationService.importDecisions(
            (List<Object>) params.get('recommendations')
          );
        } catch (Exception e) {
          throw OrgIntelAccess.error('The decisions could not be imported', e);
        }
      }
      when 'exportRecommendations' {
        OrgIntelAccess.assertCanRead();
        return OrgRecommendationService.exportRecommendations();
      }
    }
    throw unknownAction(action);
  }

  @NamespaceAccessible
  public override Map<String, Integer> recordCounts() {
    return new Map<String, Integer>{
      'Recommendations' => [
        SELECT COUNT()
        FROM OrgRecommendation__c
        WITH USER_MODE
      ]
    };
  }

  // ---------- OrgIntelRecommendationSource ----------

  @NamespaceAccessible
  public Map<String, Object> overviewData() {
    return OrgRecommendationInsights.overviewData();
  }

  @NamespaceAccessible
  public Map<String, Object> reportsData() {
    return OrgRecommendationInsights.reportsData();
  }

  @NamespaceAccessible
  public Map<String, Integer> openCountByRule() {
    return OrgRecommendationInsights.openCountByRule();
  }
}
