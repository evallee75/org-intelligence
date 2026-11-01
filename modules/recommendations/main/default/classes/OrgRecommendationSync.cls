/**
 * Transforme les constats d'un scan (calculés dans le navigateur) en recommandations partagées :
 * une recommandation par empreinte (règle + composant), créée au premier constat puis mise à jour
 * par les scans suivants.
 *
 * Les décisions humaines ne sont jamais écrasées (statut, assignation, motif, gravité ajustée). Deux
 * exceptions, tracées : une recommandation résolue qui réapparaît repasse « To Review » ; une
 * recommandation dont la règle a été évaluée sans échec et sans la retrouver est marquée « plus
 * détectée », sans être résolue automatiquement.
 *
 * Envoi par lots possible : tous les lots portent le même `scanName` ; les règles fiables
 * (`reliableRules`) ne sont envoyées qu'avec le dernier lot (ou l'appel unique), car le marquage
 * « plus détectée » vise les recommandations que ce scan n'a pas touchées (LastScanName__c).
 */
public inherited sharing class OrgRecommendationSync {
  /** Plafond de constats par appel (limite de 10 000 lignes DML par transaction). */
  public static final Integer MAX_FINDINGS = 4000;

  public class SyncException extends Exception {
  }

  /**
   * @param findings      constats du navigateur : fingerprint, ruleCode, componentType, componentName,
   *                      componentKey, title, description, evidence, affectedComponents (liste),
   *                      severity, category, confidence
   * @param reliableRules codes des règles évaluées sans échec par ce scan
   * @param scanName      nom du scan (identifie les recommandations touchées par ce scan)
   * @param completedAt   fin du scan (date de dernière détection), maintenant par défaut
   * @return created, updated, notDetected et links (empreinte → id, name, status)
   */
  public static Map<String, Object> syncScan(
    List<Object> findings,
    List<String> reliableRules,
    String scanName,
    Datetime completedAt
  ) {
    List<Map<String, Object>> rows = toRows(findings);
    if (rows.size() > MAX_FINDINGS) {
      throw new SyncException(
        'Too many findings in one call (' +
          rows.size() +
          ', maximum ' +
          MAX_FINDINGS +
          '): send them in batches.'
      );
    }
    String label = String.isBlank(scanName)
      ? 'Scan ' + Datetime.now().formatGmt('yyyy-MM-dd HH:mm')
      : scanName.abbreviate(80);
    Datetime detectedAt = completedAt == null ? Datetime.now() : completedAt;

    Set<String> fingerprints = new Set<String>();
    Set<String> ruleCodes = new Set<String>();
    for (Map<String, Object> row : rows) {
      fingerprints.add(text(row, 'fingerprint'));
      ruleCodes.add(text(row, 'ruleCode'));
    }
    Map<String, OrgRecommendation__c> existing = new Map<String, OrgRecommendation__c>();
    if (!fingerprints.isEmpty()) {
      for (OrgRecommendation__c rec : [
        SELECT
          Id,
          Fingerprint__c,
          Status__c,
          StillDetected__c,
          OccurrenceCount__c,
          LastScanName__c
        FROM OrgRecommendation__c
        WHERE Fingerprint__c IN :fingerprints
        WITH USER_MODE
      ]) {
        existing.put(rec.Fingerprint__c, rec);
      }
    }
    // Textes complets des règles (getAll tronque les champs texte long)
    Map<String, OrgScanRule__mdt> rules = new Map<String, OrgScanRule__mdt>();
    for (OrgScanRule__mdt rule : [
      SELECT DeveloperName, Rationale__c, SuggestedAction__c
      FROM OrgScanRule__mdt
      WHERE DeveloperName IN :ruleCodes
    ]) {
      rules.put(rule.DeveloperName, rule);
    }

    Map<String, OrgRecommendation__c> toInsert = new Map<String, OrgRecommendation__c>();
    Map<String, OrgRecommendation__c> toUpdate = new Map<String, OrgRecommendation__c>();
    for (Map<String, Object> row : rows) {
      String fingerprint = text(row, 'fingerprint');
      if (
        toInsert.containsKey(fingerprint) || toUpdate.containsKey(fingerprint)
      ) {
        continue; // doublon dans le même envoi
      }
      OrgRecommendation__c rec = buildContent(
        row,
        rules.get(text(row, 'ruleCode')),
        label,
        detectedAt
      );
      OrgRecommendation__c current = existing.get(fingerprint);
      if (current == null) {
        rec.Status__c = OrgIntelligenceConstants.REC_NEW;
        rec.Severity__c = text(row, 'severity');
        rec.FirstDetectedAt__c = detectedAt;
        rec.OccurrenceCount__c = 1;
        toInsert.put(fingerprint, rec);
      } else {
        rec.Id = current.Id;
        // Une occurrence par scan distinct : un lot du même scan (ou un renvoi) ne compte pas deux fois
        Boolean sameScan = current.LastScanName__c == label;
        rec.OccurrenceCount__c =
          (current.OccurrenceCount__c == null
            ? 0
            : current.OccurrenceCount__c) + (sameScan ? 0 : 1);
        if (
          !sameScan &&
          current.Status__c == OrgIntelligenceConstants.REC_RESOLVED
        ) {
          rec.Status__c = OrgIntelligenceConstants.REC_TO_REVIEW;
          rec.DecisionReason__c = ('Detected again by ' +
            label +
            ' after being resolved.')
            .abbreviate(255);
        }
        toUpdate.put(fingerprint, rec);
      }
    }
    Database.insert(toInsert.values(), AccessLevel.USER_MODE);
    Database.update(toUpdate.values(), AccessLevel.USER_MODE);

    Integer notDetected = markNoLongerDetected(reliableRules, label);

    return new Map<String, Object>{
      'created' => toInsert.size(),
      'updated' => toUpdate.size(),
      'notDetected' => notDetected,
      'links' => linksForFingerprints(new List<String>(fingerprints))
    };
  }

  /** Recommandation liée à chaque empreinte : id, name (REC-…), status. */
  public static Map<String, Object> linksForFingerprints(
    List<String> fingerprints
  ) {
    Map<String, Object> links = new Map<String, Object>();
    Set<String> keys = new Set<String>();
    for (
      String fingerprint : fingerprints == null
        ? new List<String>()
        : fingerprints
    ) {
      if (String.isNotBlank(fingerprint)) {
        keys.add(fingerprint);
      }
    }
    if (
      keys.isEmpty() || !Schema.SObjectType.OrgRecommendation__c.isAccessible()
    ) {
      return links;
    }
    for (OrgRecommendation__c rec : [
      SELECT Id, Name, Status__c, Fingerprint__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c IN :keys
      WITH USER_MODE
    ]) {
      links.put(
        rec.Fingerprint__c,
        new Map<String, Object>{
          'id' => rec.Id,
          'name' => rec.Name,
          'status' => rec.Status__c
        }
      );
    }
    return links;
  }

  /** Contenu technique, rafraîchi à chaque détection. */
  private static OrgRecommendation__c buildContent(
    Map<String, Object> row,
    OrgScanRule__mdt rule,
    String scanName,
    Datetime detectedAt
  ) {
    String evidence = text(row, 'evidence');
    String justification = rule?.Rationale__c == null ? '' : rule.Rationale__c;
    if (String.isNotBlank(evidence)) {
      justification +=
        (justification == '' ? '' : '\n\n') +
        'Evidence:\n' +
        evidence;
    }
    String componentName = text(row, 'componentName');
    String affected = affectedComponents(row.get('affectedComponents'));
    return new OrgRecommendation__c(
      Fingerprint__c = text(row, 'fingerprint'),
      RuleCode__c = abbreviate(text(row, 'ruleCode'), 40),
      Title__c = abbreviate(text(row, 'title'), 255),
      Description__c = abbreviate(text(row, 'description'), 32768),
      Justification__c = justification.abbreviate(32768),
      SuggestedAction__c = rule?.SuggestedAction__c,
      Category__c = text(row, 'category'),
      Confidence__c = text(row, 'confidence'),
      ComponentType__c = text(row, 'componentType'),
      ComponentName__c = abbreviate(componentName, 255),
      AffectedComponents__c = abbreviate(
        String.isBlank(affected) ? componentName : affected,
        32768
      ),
      LastScanName__c = scanName,
      LastDetectedAt__c = detectedAt,
      StillDetected__c = true
    );
  }

  /** Règles évaluées par ce scan qui ne retrouvent plus une recommandation encore active. */
  private static Integer markNoLongerDetected(
    List<String> reliableRules,
    String scanName
  ) {
    Set<String> evaluated = new Set<String>();
    for (
      String code : reliableRules == null ? new List<String>() : reliableRules
    ) {
      if (String.isNotBlank(code)) {
        evaluated.add(code);
      }
    }
    if (evaluated.isEmpty()) {
      return 0;
    }
    List<OrgRecommendation__c> gone = [
      SELECT Id
      FROM OrgRecommendation__c
      WHERE
        StillDetected__c = TRUE
        AND RuleCode__c IN :evaluated
        AND (LastScanName__c != :scanName
        OR LastScanName__c = NULL)
      WITH USER_MODE
      LIMIT 5000
    ];
    for (OrgRecommendation__c rec : gone) {
      rec.StillDetected__c = false;
    }
    Database.update(gone, AccessLevel.USER_MODE);
    return gone.size();
  }

  // ---------- Lecture des constats envoyés en JSON ----------

  private static List<Map<String, Object>> toRows(List<Object> findings) {
    List<Map<String, Object>> rows = new List<Map<String, Object>>();
    for (Object item : findings == null ? new List<Object>() : findings) {
      if (item instanceof Map<String, Object>) {
        Map<String, Object> row = (Map<String, Object>) item;
        if (String.isNotBlank(text(row, 'fingerprint'))) {
          rows.add(row);
        }
      }
    }
    return rows;
  }

  private static String affectedComponents(Object value) {
    if (value instanceof List<Object>) {
      List<String> names = new List<String>();
      for (Object name : (List<Object>) value) {
        if (name != null && String.isNotBlank(String.valueOf(name))) {
          names.add(String.valueOf(name));
        }
      }
      return String.join(names, '\n');
    }
    return value == null ? null : String.valueOf(value);
  }

  private static String text(Map<String, Object> row, String name) {
    Object value = row.get(name);
    return value == null ? null : String.valueOf(value);
  }

  private static String abbreviate(String value, Integer size) {
    return value == null ? null : value.abbreviate(size);
  }
}
