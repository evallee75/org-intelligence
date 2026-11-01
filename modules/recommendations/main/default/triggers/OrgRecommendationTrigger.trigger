/**
 * Recommandations Org Intelligence : horodatage des décisions (avant enregistrement), notification
 * et abonnement de la personne assignée (après enregistrement).
 */
trigger OrgRecommendationTrigger on OrgRecommendation__c(
  before insert,
  before update,
  after insert,
  after update
) {
  if (Trigger.isBefore) {
    OrgRecommendationTriggerHandler.handleBeforeSave(
      Trigger.new,
      Trigger.oldMap
    );
  } else {
    OrgRecommendationTriggerHandler.handleAfterSave(
      Trigger.new,
      Trigger.oldMap
    );
  }
}
