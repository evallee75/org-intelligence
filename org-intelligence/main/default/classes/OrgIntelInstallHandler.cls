/**
 * Post-installation du package OrgIntelligence (déclaré dans sfdx-project.json,
 * postInstallScript) : crée les valeurs par défaut du custom setting OrgIntelSettings__c à
 * l'installation, et à la montée de version si elles manquent (reprise de l'ancien CMDT
 * OrgIntelligenceSetting__mdt.Default). Aucun appel externe, idempotent : un paramétrage existant
 * n'est jamais modifié. Un échec ne bloque pas l'installation (les écrans retombent sur les
 * valeurs par défaut du produit).
 * without sharing : exécuté par l'utilisateur technique de l'installation, ne touche qu'au custom
 * setting de l'application (aucune donnée métier).
 */
global without sharing class OrgIntelInstallHandler implements InstallHandler {
  global void onInstall(InstallContext context) {
    try {
      OrgIntelSettings.ensureOrgDefaults();
    } catch (Exception e) {
      System.debug(
        LoggingLevel.ERROR,
        'Org Intelligence post-install: ' + e.getMessage()
      );
    }
  }
}
