/**
 * Règles sur le modèle de données : objets, champs personnalisés et règles de validation.
 * Les constats « par objet » regroupent les champs ou règles concernés, pour ne pas produire une
 * recommandation par champ.
 */
public inherited sharing class OrgDataModelRules {
  private static final Integer MAX_LISTED = 40;
  private static final Pattern FORMULA_LITERAL = Pattern.compile(
    '["\']([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})["\']'
  );
  private static final List<String> BYPASS_MARKERS = new List<String>{
    '$permission',
    '$setup',
    '$user',
    '$profile',
    '$userrole',
    '$custommetadata'
  };

  /**
   * @param fieldsByObject     champs personnalisés non gérés inventoriés, par objet
   * @param customFieldCounts  nombre total de champs personnalisés par objet (packages compris)
   */
  public static void evaluateObjects(
    Map<String, List<OrgScanModels.Component>> fieldsByObject,
    Map<String, Integer> customFieldCounts,
    OrgScanContext ctx
  ) {
    if (ctx.beginRule('FIELD_MISSING_DESCRIPTION')) {
      for (String objectName : fieldsByObject.keySet()) {
        List<String> undocumented = new List<String>();
        for (OrgScanModels.Component field : fieldsByObject.get(objectName)) {
          if (String.isBlank(field.description)) {
            undocumented.add(field.apiName.substringAfter('.'));
          }
        }
        if (undocumented.isEmpty()) {
          continue;
        }
        undocumented.sort();
        Integer total = fieldsByObject.get(objectName).size();
        OrgScanModels.Finding finding = ctx.newFinding(
          'FIELD_MISSING_DESCRIPTION',
          'CustomObject',
          objectName,
          undocumented.size() +
            ' of ' +
            total +
            ' custom fields on ' +
            objectName +
            ' have no description'
        );
        finding.evidence =
          'Fields without description: ' +
          listOf(undocumented) +
          '.';
        for (String fieldName : undocumented) {
          finding.affectedComponents.add(objectName + '.' + fieldName);
        }
        ctx.addFinding(finding);
      }
    }

    if (ctx.beginRule('OBJECT_FIELDS_NEAR_LIMIT')) {
      Decimal threshold = ctx.threshold('OBJECT_FIELDS_NEAR_LIMIT', 400);
      for (String objectName : customFieldCounts.keySet()) {
        Integer count = customFieldCounts.get(objectName);
        if (count <= threshold) {
          continue;
        }
        OrgScanModels.Finding finding = ctx.newFinding(
          'OBJECT_FIELDS_NEAR_LIMIT',
          'CustomObject',
          objectName,
          objectName + ' has ' + count + ' custom fields'
        );
        finding.evidence =
          count +
          ' custom fields, managed packages included (threshold ' +
          threshold.stripTrailingZeros().toPlainString() +
          '; limit 500 in Enterprise Edition, 800 in Unlimited Edition).';
        ctx.addFinding(finding);
      }
    }
  }

  /** Règles de validation, avec leur formule dans `source`. */
  public static void evaluateValidationRules(
    List<OrgScanModels.Component> rules,
    OrgScanContext ctx
  ) {
    Boolean inactive = ctx.beginRule('VR_INACTIVE');
    Boolean hardcodedIds = ctx.beginRule('VR_HARDCODED_ID');
    for (OrgScanModels.Component rule : rules) {
      if (inactive && !rule.isActive) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'VR_INACTIVE',
          rule,
          'Validation rule ' + rule.apiName + ' is inactive'
        );
        finding.evidence = 'Active: false.';
        ctx.addFinding(finding);
      }
      if (hardcodedIds && rule.source != null) {
        List<String> ids = new List<String>();
        Matcher matcher = FORMULA_LITERAL.matcher(rule.source);
        while (matcher.find()) {
          String value = matcher.group(1);
          if (
            OrgApexSourceAnalyzer.looksLikeRecordId(value) &&
            !ids.contains(value)
          ) {
            ids.add(value);
          }
        }
        if (!ids.isEmpty()) {
          OrgScanModels.Finding finding = ctx.newFinding(
            'VR_HARDCODED_ID',
            rule,
            'Hardcoded record Id in validation rule ' + rule.apiName
          );
          finding.evidence =
            'Id-like literals in the formula: ' +
            String.join(ids, ', ') +
            '.';
          ctx.addFinding(finding);
        }
      }
    }
  }

  /**
   * Règles actives sans mécanisme de contournement, regroupées par objet. Ne s'applique qu'aux
   * règles dont la formule a pu être lue.
   */
  public static void evaluateBypass(
    List<OrgScanModels.Component> rules,
    OrgScanContext ctx
  ) {
    if (!ctx.beginRule('VR_WITHOUT_BYPASS')) {
      return;
    }
    Map<String, List<String>> withoutBypass = new Map<String, List<String>>();
    Map<String, Integer> activeCount = new Map<String, Integer>();
    for (OrgScanModels.Component rule : rules) {
      if (!rule.isActive || rule.source == null) {
        continue;
      }
      String objectName = rule.parentName;
      activeCount.put(
        objectName,
        (activeCount.containsKey(objectName)
          ? activeCount.get(objectName)
          : 0) + 1
      );
      String formula = rule.source.toLowerCase();
      Boolean bypass = false;
      for (String marker : BYPASS_MARKERS) {
        if (formula.contains(marker)) {
          bypass = true;
          break;
        }
      }
      if (!bypass) {
        if (!withoutBypass.containsKey(objectName)) {
          withoutBypass.put(objectName, new List<String>());
        }
        withoutBypass.get(objectName).add(rule.apiName.substringAfter('.'));
      }
    }
    for (String objectName : withoutBypass.keySet()) {
      List<String> names = withoutBypass.get(objectName);
      names.sort();
      OrgScanModels.Finding finding = ctx.newFinding(
        'VR_WITHOUT_BYPASS',
        'CustomObject',
        objectName,
        names.size() +
          ' of ' +
          activeCount.get(objectName) +
          ' active validation rules on ' +
          objectName +
          ' cannot be bypassed'
      );
      finding.evidence =
        'Formulas referencing neither $Permission, $Setup, $User, $Profile, $UserRole nor $CustomMetadata: ' +
        listOf(names) +
        '.';
      for (String name : names) {
        finding.affectedComponents.add(objectName + '.' + name);
      }
      ctx.addFinding(finding);
    }
  }

  private static String listOf(List<String> names) {
    if (names.size() <= MAX_LISTED) {
      return String.join(names, ', ');
    }
    List<String> head = new List<String>();
    for (Integer i = 0; i < MAX_LISTED; i++) {
      head.add(names[i]);
    }
    return String.join(head, ', ') +
      ' … and ' +
      (names.size() - MAX_LISTED) +
      ' more';
  }
}
