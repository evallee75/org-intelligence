/**
 * Horodatage des décisions sur les recommandations Org Intelligence.
 *
 * StatusChangedAt__c suit chaque changement de statut ; ResolvedDate__c n'est renseignée que tant
 * que la recommandation est résolue (une réouverture la vide), ce qui alimente le rapport de délai
 * de résolution. Le détail des décisions reste dans l'historique des champs.
 */
public inherited sharing class OrgRecommendationTriggerHandler {
  public static void handleBeforeSave(
    List<OrgRecommendation__c> records,
    Map<Id, OrgRecommendation__c> oldMap
  ) {
    Datetime now = Datetime.now();
    for (OrgRecommendation__c record : records) {
      OrgRecommendation__c old = oldMap == null ? null : oldMap.get(record.Id);
      if (old != null && old.Status__c == record.Status__c) {
        continue;
      }
      record.StatusChangedAt__c = now;
      record.ResolvedDate__c = record.Status__c ==
        OrgIntelligenceConstants.REC_RESOLVED
        ? now
        : null;
    }
  }

  /**
   * Nouvelle assignation : la personne assignée reçoit une notification Salesforce (cloche et mobile)
   * et suit la recommandation (fil Chatter). Pas de notification quand on s'assigne soi-même.
   */
  public static void handleAfterSave(
    List<OrgRecommendation__c> records,
    Map<Id, OrgRecommendation__c> oldMap
  ) {
    List<OrgRecommendation__c> assigned = new List<OrgRecommendation__c>();
    for (OrgRecommendation__c record : records) {
      OrgRecommendation__c old = oldMap == null ? null : oldMap.get(record.Id);
      Boolean changed = old == null
        ? record.AssignedTo__c != null
        : record.AssignedTo__c != null &&
          record.AssignedTo__c != old.AssignedTo__c;
      if (changed) {
        assigned.add(record);
      }
    }
    if (assigned.isEmpty()) {
      return;
    }
    followAssignees(assigned);
    notifyAssignees(assigned);
  }

  private static void followAssignees(List<OrgRecommendation__c> records) {
    Set<Id> recordIds = new Set<Id>();
    Set<Id> userIds = new Set<Id>();
    for (OrgRecommendation__c record : records) {
      recordIds.add(record.Id);
      userIds.add(record.AssignedTo__c);
    }
    Set<String> existing = new Set<String>();
    try {
      for (EntitySubscription subscription : [
        SELECT ParentId, SubscriberId
        FROM EntitySubscription
        WHERE ParentId IN :recordIds AND SubscriberId IN :userIds
        LIMIT 1000
      ]) {
        existing.add(subscription.ParentId + '|' + subscription.SubscriberId);
      }
      List<EntitySubscription> subscriptions = new List<EntitySubscription>();
      for (OrgRecommendation__c record : records) {
        if (existing.add(record.Id + '|' + record.AssignedTo__c)) {
          subscriptions.add(
            new EntitySubscription(
              ParentId = record.Id,
              SubscriberId = record.AssignedTo__c
            )
          );
        }
      }
      Database.insert(subscriptions, false);
    } catch (Exception e) {
      // Chatter désactivé : l'assignation reste valable sans abonnement
      System.debug(LoggingLevel.FINE, e.getMessage());
    }
  }

  private static void notifyAssignees(List<OrgRecommendation__c> records) {
    List<CustomNotificationType> types = [
      SELECT Id
      FROM CustomNotificationType
      WHERE
        DeveloperName = 'OrgIntelligenceNotification'
        AND NamespacePrefix = :OrgIntelNamespace.namespaceFilter()
      LIMIT 1
    ];
    if (types.isEmpty()) {
      return;
    }
    String sender = UserInfo.getName();
    for (OrgRecommendation__c record : records) {
      if (record.AssignedTo__c == UserInfo.getUserId()) {
        continue;
      }
      Messaging.CustomNotification notification = new Messaging.CustomNotification();
      notification.setNotificationTypeId(types[0].Id);
      notification.setTargetId(record.Id);
      notification.setTitle('Recommendation assigned to you');
      String body =
        sender +
        ' assigned you "' +
        (record.Title__c == null
          ? 'a recommendation'
          : record.Title__c.abbreviate(150)) +
        '"' +
        (record.Severity__c == null ? '' : ' (' + record.Severity__c + ')') +
        (record.DueDate__c == null
          ? '.'
          : ', due ' + record.DueDate__c.format() + '.');
      notification.setBody(body);
      try {
        notification.send(new Set<String>{ (String) record.AssignedTo__c });
      } catch (Exception e) {
        System.debug(
          LoggingLevel.WARN,
          'Assignment notification not sent: ' + e.getMessage()
        );
      }
    }
  }
}
