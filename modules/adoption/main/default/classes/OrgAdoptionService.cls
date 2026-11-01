/**
 * Section Adoption : « utilisons-nous pleinement notre Salesforce ? ».
 *
 * Une analyse (synchrone, quelques secondes) confronte ce que l'org a acheté (licences utilisateur,
 * licences de permission sets, packages, droits d'usage) à ce qui est attribué et utilisé, puis
 * mesure l'usage des fonctionnalités natives des clouds de l'org (OrgAdoptionFeatures).
 *
 * Édition sans objet personnalisé : rien n'est écrit dans l'org. Le résultat est renvoyé à l'écran,
 * qui le garde dans le navigateur avec le contrat saisi ; l'écran renvoie l'analyse et le contrat
 * pour la comparaison, le pré-remplissage et la construction des recommandations.
 */
public inherited sharing class OrgAdoptionService {
  /** Résultat complet d'une analyse. */
  public class Analysis {
    public Datetime generatedAt;
    public String generatedBy;
    public Long durationMs;
    public String edition;
    public Boolean isSandbox;
    public Integer inactiveDays = OrgAdoptionLicenses.INACTIVE_DAYS;
    public Integer score;
    public List<String> selectedClouds = new List<String>();
    /** Origine du périmètre : Contract (lignes du contrat), Manual (choix de l'écran) ou Detected. */
    public String cloudSource;
    public List<OrgAdoptionFeatures.CloudSummary> clouds = new List<OrgAdoptionFeatures.CloudSummary>();
    public List<OrgAdoptionFeatures.Feature> features = new List<OrgAdoptionFeatures.Feature>();
    public OrgAdoptionLicenses.Result licenses;
  }

  /** Réponse d'une analyse : l'analyse et sa comparaison avec le contrat envoyé. */
  public class View {
    public Analysis analysis;
    public OrgAdoptionContract.Summary contract;
  }

  /** Recommandations à envoyer (specs au format de OrgRecommendation__c), sans DML. */
  public class RecommendationBatch {
    public List<Map<String, Object>> specs = new List<Map<String, Object>>();
    public Integer skipped = 0;
    public String reopenReason = 'Detected again by an adoption analysis after being resolved.';
  }

  // ---------- Analyse ----------

  /**
   * Lance une analyse. Périmètre du score : les clouds déclarés dans le contrat s'il y en a, sinon
   * les clouds choisis à l'écran (clouds), sinon les clouds détectés.
   */
  public static View run(
    List<String> clouds,
    List<OrgAdoptionContract.Line> lines
  ) {
    Long started = System.currentTimeMillis();
    Analysis analysis = analyse(
      clouds,
      OrgAdoptionContract.contractClouds(lines)
    );
    analysis.durationMs = System.currentTimeMillis() - started;
    analysis.generatedBy = UserInfo.getName();
    View view = new View();
    view.analysis = analysis;
    view.contract = OrgAdoptionContract.compare(lines, analysis);
    return view;
  }

  /**
   * Analyse typée depuis le JSON renvoyé par l'écran (null si absente). Un format illisible lève
   * une erreur lisible plutôt que de rendre silencieusement une comparaison vide.
   */
  public static Analysis parse(Object raw) {
    if (raw == null) {
      return null;
    }
    try {
      return (Analysis) JSON.deserialize(JSON.serialize(raw), Analysis.class);
    } catch (Exception e) {
      throw OrgIntelAccess.error(
        'The analysis sent by the screen is unreadable',
        e
      );
    }
  }

  @TestVisible
  private static Analysis analyse(
    List<String> clouds,
    List<String> fromContract
  ) {
    Analysis analysis = new Analysis();
    analysis.generatedAt = Datetime.now();
    List<Organization> orgs = [
      SELECT OrganizationType, IsSandbox
      FROM Organization
      LIMIT 1
    ];
    if (!orgs.isEmpty()) {
      analysis.edition = orgs[0].OrganizationType;
      analysis.isSandbox = orgs[0].IsSandbox;
    }
    analysis.licenses = OrgAdoptionLicenses.collect();
    OrgAdoptionFeatures engine = new OrgAdoptionFeatures(analysis.licenses);
    analysis.features = engine.evaluate();
    Map<String, OrgAdoptionFeatures.CloudSummary> summaries = engine.detectClouds(
      analysis.features
    );

    Set<String> chosen = new Set<String>();
    List<String> requested = !fromContract.isEmpty()
      ? fromContract
      : clouds == null ? new List<String>() : clouds;
    for (String cloud : requested) {
      if (summaries.containsKey(cloud)) {
        chosen.add(cloud);
      }
    }
    analysis.cloudSource = !fromContract.isEmpty() && !chosen.isEmpty()
      ? 'Contract'
      : !chosen.isEmpty() ? 'Manual' : 'Detected';
    for (OrgAdoptionFeatures.CloudSummary summary : summaries.values()) {
      summary.selected = chosen.isEmpty()
        ? summary.detected
        : chosen.contains(summary.name);
      if (summary.selected) {
        analysis.selectedClouds.add(summary.name);
      }
    }
    analysis.score = OrgAdoptionFeatures.score(analysis.features, summaries);
    analysis.clouds = summaries.values();
    return analysis;
  }

  // ---------- Envoi vers les recommandations ----------

  /**
   * Construit une recommandation par fonctionnalité non utilisée (ou partielle), par licence
   * utilisateur à récupérer, par add-on jamais attribué et par ligne de contrat à revoir, d'après
   * l'analyse et le contrat envoyés par l'écran. Empreinte = règle + clé : l'écran les envoie par
   * sendRecommendations (orgIntelRecommendationStore), qui ne remplace jamais une décision prise.
   */
  public static RecommendationBatch buildRecommendations(
    Analysis analysis,
    List<OrgAdoptionContract.Line> lines,
    List<String> keys
  ) {
    RecommendationBatch result = new RecommendationBatch();
    if (analysis == null || keys == null || keys.isEmpty()) {
      return result;
    }
    Set<String> wanted = new Set<String>(keys);
    List<Map<String, Object>> specs = result.specs;
    String source =
      ' (adoption analysis of ' +
      (analysis.generatedAt == null ? Datetime.now() : analysis.generatedAt)
        .format('yyyy-MM-dd HH:mm') +
      ').';

    for (OrgAdoptionFeatures.Feature feature : analysis.features) {
      if (!wanted.contains('FEATURE:' + feature.key)) {
        continue;
      }
      if (
        feature.status != OrgAdoptionFeatures.NOT_USED &&
        feature.status != OrgAdoptionFeatures.PARTIAL &&
        feature.status != OrgAdoptionFeatures.NOT_ENABLED
      ) {
        result.skipped++;
        continue;
      }
      String severity = feature.status == OrgAdoptionFeatures.PARTIAL
        ? 'Low'
        : feature.weight > 1 ? 'Medium' : 'Low';
      specs.add(
        spec(
          'ADOPTION_FEATURE_' + feature.key,
          feature.cloud + ' feature',
          feature.label,
          (feature.status == OrgAdoptionFeatures.PARTIAL
            ? 'Feature partly used: '
            : 'Feature not used: ') + feature.label,
          feature.description +
            '\n\nMeasured: ' +
            feature.metric +
            source +
            '\n\nWhy it matters: ' +
            feature.benefit,
          feature.nextStep + '\nLearn more: ' + feature.learnUrl,
          severity
        )
      );
    }
    for (
      OrgAdoptionLicenses.UserLicenseRow license : analysis.licenses.userLicenses
    ) {
      if (!wanted.contains('LICENSE:' + license.name)) {
        continue;
      }
      if (license.verdict != 'Seats to reclaim') {
        result.skipped++;
        continue;
      }
      Integer reclaimable = license.unused + license.inactive;
      specs.add(
        spec(
          'ADOPTION_LICENSE',
          'User license',
          license.name,
          'Licenses to reclaim: ' + license.name,
          license.used +
            ' of ' +
            license.total +
            ' ' +
            license.name +
            ' licenses assigned, ' +
            license.unused +
            ' unassigned and ' +
            license.inactive +
            ' held by active users without login for ' +
            analysis.inactiveDays +
            ' days' +
            source,
          'Deactivate or freeze the users who no longer log in, reassign their licenses, and adjust the quantity at the next renewal.',
          reclaimable >= 10 ? 'High' : 'Medium'
        )
      );
    }
    for (OrgAdoptionLicenses.AddOnRow addOn : analysis.licenses.addOns) {
      if (!wanted.contains('ADDON:' + addOn.key)) {
        continue;
      }
      if (addOn.verdict != 'Never assigned' && addOn.verdict != 'Low use') {
        result.skipped++;
        continue;
      }
      specs.add(
        spec(
          'ADOPTION_ADDON',
          addOn.kind,
          addOn.name,
          (addOn.verdict == 'Never assigned'
            ? 'Add-on never assigned: '
            : 'Add-on rarely used: ') + addOn.name,
          addOn.kind +
            ' ' +
            addOn.name +
            ': ' +
            addOn.used +
            ' of ' +
            addOn.total +
            ' used' +
            source,
          'Check whether this add-on is paid in your contract. If so, assign it to the users who need it or remove it at the next renewal; some licenses are included at no cost.',
          'Medium'
        )
      );
    }
    // Lignes du contrat : licences payées et inutilisées, avec leur coût
    OrgAdoptionContract.Summary contract = OrgAdoptionContract.compare(
      lines,
      analysis
    );
    for (OrgAdoptionContract.LineView line : contract.lines) {
      if (!wanted.contains('CONTRACT:' + line.id)) {
        continue;
      }
      if (
        line.verdict != 'Unused licenses' &&
        line.verdict != 'Check quantity'
      ) {
        result.skipped++;
        continue;
      }
      Boolean unused = line.verdict == 'Unused licenses';
      String cost = line.annualWaste == null
        ? ''
        : ' (about ' +
          line.annualWaste.setScale(0).format() +
          ' ' +
          contract.currencyCode +
          ' a year)';
      specs.add(
        spec(
          unused ? 'ADOPTION_CONTRACT_UNUSED' : 'ADOPTION_CONTRACT_QUANTITY',
          'Contract line',
          line.product,
          (unused
            ? 'Paid licenses not used: '
            : 'Contract quantity differs from Salesforce: ') + line.product,
          (unused
              ? line.unused.setScale(0).format() +
                ' of the ' +
                line.quantity.setScale(0).format() +
                ' licenses bought are not actively used' +
                cost +
                '. '
              : '') +
            line.detail +
            source,
          unused
            ? 'Reassign these licenses or deactivate inactive users, then reduce the quantity at the renewal' +
              (line.endDate == null ? '' : ' on ' + line.endDate.format()) +
              '.'
            : 'Compare the quantity of your order form with Setup › Company Information, and correct the contract line or ask your Salesforce account executive.',
          unused &&
            line.annualWaste != null &&
            line.annualWaste >= 5000
            ? 'High'
            : 'Medium'
        )
      );
    }
    return result;
  }

  private static Map<String, Object> spec(
    String rule,
    String componentKind,
    String componentName,
    String title,
    String description,
    String suggestedAction,
    String severity
  ) {
    String component = componentKind + ': ' + componentName;
    String fingerprint = (rule + '|' + component).abbreviate(255);
    return new Map<String, Object>{
      'Fingerprint__c' => fingerprint,
      'RuleCode__c' => rule.abbreviate(40),
      'Title__c' => title.abbreviate(255),
      'Description__c' => description,
      'SuggestedAction__c' => suggestedAction,
      'Category__c' => 'Adoption',
      'Confidence__c' => 'Medium',
      'ComponentName__c' => component.abbreviate(255),
      'AffectedComponents__c' => component,
      'LastDetectedAt__c' => Datetime.now(),
      'StillDetected__c' => true,
      'Severity__c' => severity
    };
  }
}
