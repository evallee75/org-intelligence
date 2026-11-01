/**
 * Préférences du score de santé (custom setting OrgIntelSettings__c, lu par OrgIntelSettings). Le calcul se fait dans le
 * navigateur (orgIntelScanData.computeHealthScore), où sont gardés les scans :
 * 100 − Σ par règle de min(plafond de sa gravité, Σ points de ses constats), plancher 0.
 * Les domaines non retenus ne comptent pas ; les constats dont la recommandation est « Ignored »
 * (risque accepté) sont exclus si la préférence est cochée.
 */
public inherited sharing class OrgHealthScore {
  /** Préréglages proposés dans Settings (points par constat, plafond par règle). */
  public static final Map<String, Map<String, List<Decimal>>> PRESETS = new Map<String, Map<String, List<Decimal>>>{
    'Strict' => new Map<String, List<Decimal>>{
      'Critical' => new List<Decimal>{ 15, 40 },
      'High' => new List<Decimal>{ 8, 25 },
      'Medium' => new List<Decimal>{ 3, 12 },
      'Low' => new List<Decimal>{ 1, 6 },
      'Info' => new List<Decimal>{ 0, 0 }
    },
    'Balanced' => new Map<String, List<Decimal>>{
      'Critical' => new List<Decimal>{ 10, 25 },
      'High' => new List<Decimal>{ 5, 15 },
      'Medium' => new List<Decimal>{ 2, 8 },
      'Low' => new List<Decimal>{ 0.5, 4 },
      'Info' => new List<Decimal>{ 0, 0 }
    },
    'Lenient' => new Map<String, List<Decimal>>{
      'Critical' => new List<Decimal>{ 6, 15 },
      'High' => new List<Decimal>{ 3, 8 },
      'Medium' => new List<Decimal>{ 1, 4 },
      'Low' => new List<Decimal>{ 0.25, 2 },
      'Info' => new List<Decimal>{ 0, 0 }
    }
  };

  public static final List<String> DOMAINS = new List<String>{
    'Apex',
    'Flows & Automation',
    'Data Model',
    'Data Quality',
    'Storage'
  };

  /** Réglages effectifs du score (exposés à l'interface pour afficher la méthode). */
  public class Config {
    @AuraEnabled
    public String preset;
    @AuraEnabled
    public Map<String, Decimal> points = new Map<String, Decimal>();
    @AuraEnabled
    public Map<String, Decimal> caps = new Map<String, Decimal>();
    @AuraEnabled
    public Boolean excludeIgnored = true;
    @AuraEnabled
    public List<String> domains = new List<String>();
  }

  public static Config config() {
    OrgIntelSettings__c setting = OrgIntelSettings.getOrgDefaults();
    Config result = new Config();
    result.preset = setting.ScorePreset__c;
    for (String severity : PRESETS.get('Balanced').keySet()) {
      result.points.put(
        severity,
        (Decimal) setting.get(OrgIntelSettings.pointsField(severity))
      );
      result.caps.put(
        severity,
        (Decimal) setting.get(OrgIntelSettings.capField(severity))
      );
    }
    result.excludeIgnored = setting.ScoreExcludeIgnored__c == true;
    result.domains = String.isBlank(setting.ScoreDomains__c)
      ? new List<String>(DOMAINS)
      : setting.ScoreDomains__c.split(';');
    return result;
  }

  /** Domaine d'une règle d'après son préfixe (même convention que le champ Domain__c des recommandations). */
  public static String domainOf(String ruleCode) {
    String code = ruleCode == null ? '' : ruleCode;
    if (code.startsWith('APEX_') || code.startsWith('TRIGGER_')) {
      return 'Apex';
    }
    if (code.startsWith('FLOW_') || code.startsWith('AUTOMATION_')) {
      return 'Flows & Automation';
    }
    if (code.startsWith('OBJECT_') || code.startsWith('FIELD_')) {
      return 'Data Model';
    }
    if (code.startsWith('VR_')) {
      return 'Data Quality';
    }
    if (code.startsWith('STORAGE_')) {
      return 'Storage';
    }
    return 'Other';
  }
}
