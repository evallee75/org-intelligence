/**
 * Contrôle planifié des alertes API (toutes les 15 min ou toutes les heures, cf.
 * OrgApiAlertService.schedule), purge des alertes au-delà de la rétention et du journal API au-delà
 * de sa durée de conservation (OrgMaintenanceService : plus de tâche de maintenance planifiée).
 */
public with sharing class OrgApiAlertJob implements Schedulable {
  public void execute(SchedulableContext context) {
    // Mode système : le contrôle doit voir tout le journal, quel que soit l'utilisateur planificateur
    OrgApiAlertService.evaluate(null, AccessLevel.SYSTEM_MODE);
    OrgApiAlertService.purgeOldEvents();
    OrgMaintenanceService.purge();
  }
}
