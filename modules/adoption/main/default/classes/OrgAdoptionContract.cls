/**
 * Contrat Salesforce saisi par l'administrateur (gardé dans son navigateur, envoyé à chaque appel),
 * comparé à l'utilisation réelle mesurée par une analyse d'adoption. Aucune écriture dans l'org.
 *
 * Salesforce n'expose pas le contrat par API (ni prix ni lignes de commande) : l'administrateur
 * saisit ses lignes (ou les pré-remplit depuis les licences détectées) et les rattache à une licence
 * de l'org (matchedKey). Pour chaque ligne : quantité du contrat face aux licences visibles dans
 * Salesforce, licences attribuées et réellement utilisées, licences payées inutilisées et leur coût
 * annuel, renouvellement. Les clouds déclarés sur les lignes définissent le périmètre du score
 * d'adoption.
 */
public inherited sharing class OrgAdoptionContract {
  public static final String TYPE_USER_LICENSE = 'User license';
  public static final String TYPE_ADD_ON = 'Add-on';
  public static final String TYPE_ENTITLEMENT = 'Usage entitlement';
  public static final String TYPE_OTHER = 'Other';
  public static final String PER_YEAR = 'Per year';
  public static final String PER_MONTH = 'Per month';

  /** Renouvellement signalé « bientôt » en deçà de ce nombre de jours. */
  private static final Integer RENEWAL_NOTICE_DAYS = 120;

  public class LineView {
    public String id;
    public String product;
    public String lineType;
    public String cloud;
    public Decimal quantity;
    public Decimal unitPrice;
    public String pricePeriod;
    public Date startDate;
    public Date endDate;
    public String matchedKey;
    public String matchedLabel;
    public String notes;
    // Comparaison
    public Boolean matched = false;
    public Decimal orgTotal;
    public Decimal assigned;
    public Decimal active;
    public Decimal unused;
    public Decimal annualCost;
    public Decimal annualWaste;
    public Integer renewalDays;
    public Integer sharedWith = 0;
    public Integer cloudScore;
    /** Not matched, Unused licenses, Check quantity, Over limit, Fully used, No quantity. */
    public String verdict;
    public String detail;
  }

  public class Option {
    public String value;
    public String label;
    public String kind;

    public Option(String value, String label, String kind) {
      this.value = value;
      this.label = label;
      this.kind = kind;
    }
  }

  public class Summary {
    public List<LineView> lines = new List<LineView>();
    public List<Option> licenseOptions = new List<Option>();
    public List<String> clouds = new List<String>();
    public String currencyCode = UserInfo.getDefaultCurrency();
    public Decimal annualValue = 0;
    public Decimal annualWaste = 0;
    public Decimal unusedLicenses = 0;
    public Boolean priced = false;
    public Date nextRenewal;
    public Integer nextRenewalDays;
    public Boolean hasAnalysis = false;
  }

  /** Ligne du contrat telle que saisie dans le navigateur (id local). */
  public class Line {
    public String id;
    public String product;
    public String lineType;
    public String cloud;
    public Decimal quantity;
    public Decimal unitPrice;
    public String pricePeriod;
    public Date startDate;
    public Date endDate;
    public String matchedKey;
    public String matchedLabel;
    public String notes;
  }

  // ---------- Lecture et comparaison ----------

  /**
   * Lignes envoyées par l'écran (liste de maps JSON). Les lignes sans produit sont ignorées, les
   * nombres illisibles ou négatifs sont laissés vides : le contrôle de saisie est fait à l'écran.
   */
  public static List<Line> parseLines(Object raw) {
    List<Line> result = new List<Line>();
    if (!(raw instanceof List<Object>)) {
      return result;
    }
    for (Object item : (List<Object>) raw) {
      if (!(item instanceof Map<String, Object>)) {
        continue;
      }
      Map<String, Object> values = (Map<String, Object>) item;
      String product = blankToNull(text(values, 'product'));
      if (product == null) {
        continue;
      }
      Line line = new Line();
      line.id = text(values, 'id');
      line.product = product.abbreviate(80);
      line.lineType = String.isBlank(text(values, 'lineType'))
        ? TYPE_USER_LICENSE
        : text(values, 'lineType');
      line.cloud = blankToNull(text(values, 'cloud'));
      line.quantity = nonNegative(values, 'quantity');
      line.unitPrice = nonNegative(values, 'unitPrice');
      line.pricePeriod = String.isBlank(text(values, 'pricePeriod'))
        ? PER_MONTH
        : text(values, 'pricePeriod');
      line.startDate = dateValue(values, 'startDate');
      line.endDate = dateValue(values, 'endDate');
      line.matchedKey = blankToNull(text(values, 'matchedKey'));
      line.matchedLabel = line.matchedKey == null
        ? null
        : blankToNull(text(values, 'matchedLabel'));
      line.notes = blankToNull(text(values, 'notes'));
      result.add(line);
    }
    return result;
  }

  /** Clouds déclarés sur les lignes du contrat (vide = détection automatique). */
  public static List<String> contractClouds(List<Line> lines) {
    Set<String> clouds = new Set<String>();
    for (Line line : lines) {
      if (String.isNotBlank(line.cloud)) {
        clouds.add(line.cloud);
      }
    }
    return new List<String>(clouds);
  }

  /** Comparaison du contrat avec une analyse (null = lignes seules, sans comparaison). */
  public static Summary compare(
    List<Line> records,
    OrgAdoptionService.Analysis analysis
  ) {
    Summary summary = new Summary();
    summary.hasAnalysis = analysis != null;
    Map<String, Usage> usages = analysis == null
      ? new Map<String, Usage>()
      : usages(analysis);
    for (Usage usage : usages.values()) {
      summary.licenseOptions.add(
        new Option(usage.key, usage.label, usage.kind)
      );
    }
    Map<String, Integer> cloudScores = new Map<String, Integer>();
    if (analysis != null) {
      for (OrgAdoptionFeatures.CloudSummary cloud : analysis.clouds) {
        cloudScores.put(cloud.name, cloud.score);
      }
    }

    // Quantité totale du contrat par licence rattachée (plusieurs produits peuvent partager une licence :
    // ex. « Sales Cloud Enterprise » et « Service Cloud Enterprise » → licence utilisateur « Salesforce »)
    Map<String, Decimal> contractedByKey = new Map<String, Decimal>();
    Map<String, Integer> linesByKey = new Map<String, Integer>();
    for (Line record : records) {
      if (String.isNotBlank(record.matchedKey) && record.quantity != null) {
        String key = record.matchedKey;
        contractedByKey.put(
          key,
          (contractedByKey.containsKey(key) ? contractedByKey.get(key) : 0) +
          record.quantity
        );
        linesByKey.put(
          key,
          (linesByKey.containsKey(key) ? linesByKey.get(key) : 0) + 1
        );
      }
    }

    Set<String> clouds = new Set<String>();
    for (Line record : records) {
      LineView line = toView(record);
      if (String.isNotBlank(line.cloud)) {
        clouds.add(line.cloud);
        line.cloudScore = cloudScores.get(line.cloud);
      }
      Usage usage = usages.get(line.matchedKey);
      evaluate(
        line,
        usage,
        contractedByKey.get(line.matchedKey),
        linesByKey.get(line.matchedKey)
      );
      summary.lines.add(line);

      if (line.annualCost != null) {
        summary.annualValue += line.annualCost;
        summary.priced = true;
      }
      if (line.annualWaste != null) {
        summary.annualWaste += line.annualWaste;
      }
      // Licences inutilisées : licences utilisateur, et add-ons dont le prix est connu
      if (
        line.unused != null &&
        (line.lineType == TYPE_USER_LICENSE ||
        line.annualWaste != null)
      ) {
        summary.unusedLicenses += line.unused;
      }
      if (
        line.endDate != null &&
        line.endDate >= Date.today() &&
        (summary.nextRenewal == null ||
        line.endDate < summary.nextRenewal)
      ) {
        summary.nextRenewal = line.endDate;
        summary.nextRenewalDays = Date.today().daysBetween(line.endDate);
      }
    }
    summary.clouds = new List<String>(clouds);
    return summary;
  }

  private static LineView toView(Line record) {
    LineView line = new LineView();
    line.id = record.id;
    line.product = record.product;
    line.lineType = record.lineType;
    line.cloud = record.cloud;
    line.quantity = record.quantity;
    line.unitPrice = record.unitPrice;
    line.pricePeriod = String.isBlank(record.pricePeriod)
      ? PER_MONTH
      : record.pricePeriod;
    line.startDate = record.startDate;
    line.endDate = record.endDate;
    line.matchedKey = record.matchedKey;
    line.matchedLabel = record.matchedLabel;
    line.notes = record.notes;
    if (line.endDate != null) {
      line.renewalDays = Date.today().daysBetween(line.endDate);
    }
    if (line.unitPrice != null && line.quantity != null) {
      line.annualCost = (line.quantity * annualUnitPrice(line)).setScale(2);
    }
    return line;
  }

  private static Decimal annualUnitPrice(LineView line) {
    return line.pricePeriod == PER_YEAR ? line.unitPrice : line.unitPrice * 12;
  }

  @TestVisible
  private static void evaluate(
    LineView line,
    Usage usage,
    Decimal contractedTotal,
    Integer sharedLines
  ) {
    if (usage == null) {
      line.verdict = 'Not matched';
      line.detail = String.isBlank(line.matchedKey)
        ? 'Link this line to a license of the org to compare it with the actual usage.'
        : 'The linked license was not found in the latest analysis.';
      return;
    }
    line.matched = true;
    line.orgTotal = usage.total;
    line.assigned = usage.assigned;
    line.active = usage.active;
    line.sharedWith = sharedLines == null ? 0 : sharedLines - 1;
    if (line.quantity == null) {
      line.verdict = 'No quantity';
      line.detail = 'Enter the quantity bought to compare it with the usage.';
      return;
    }

    // Part de l'usage attribuée à cette ligne quand plusieurs lignes partagent la licence
    Decimal share = contractedTotal == null ||
      contractedTotal == 0
      ? 1
      : line.quantity / contractedTotal;
    Decimal activeShare = usage.active == null
      ? null
      : (usage.active * share).round(System.RoundingMode.HALF_UP);
    line.unused = activeShare == null
      ? null
      : Math.max(Decimal.valueOf(0), line.quantity - activeShare);
    if (line.unused != null && line.unitPrice != null) {
      line.annualWaste = (line.unused * annualUnitPrice(line)).setScale(2);
    }

    List<String> facts = new List<String>();
    if (usage.total != null) {
      facts.add(
        'Salesforce shows ' +
          format(usage.total) +
          ' ' +
          usage.unit +
          ' for ' +
          format(contractedTotal) +
          ' in the contract' +
          (line.sharedWith > 0
            ? ' (shared with ' + line.sharedWith + ' other line(s))'
            : '')
      );
    }
    if (usage.assigned != null) {
      facts.add(format(usage.assigned) + ' assigned');
    }
    if (usage.inactive != null && usage.inactive > 0) {
      facts.add(
        format(usage.inactive) +
          ' held by users inactive for ' +
          OrgAdoptionLicenses.INACTIVE_DAYS +
          ' days'
      );
    }
    line.detail = String.join(facts, ', ') + '.';

    if (usage.kind == TYPE_ENTITLEMENT) {
      line.verdict = usage.assigned != null &&
        usage.assigned > line.quantity
        ? 'Over limit'
        : 'Fully used';
      line.unused = null;
      line.annualWaste = null;
      return;
    }
    Boolean quantityMismatch =
      usage.total != null &&
      contractedTotal != null &&
      usage.total != contractedTotal;
    if (
      line.unused != null &&
      line.unused >= 2 &&
      line.unused * 10 >= line.quantity
    ) {
      line.verdict = 'Unused licenses';
    } else if (quantityMismatch) {
      line.verdict = 'Check quantity';
    } else {
      line.verdict = 'Fully used';
    }
  }

  private static String format(Decimal value) {
    return value == null ? '?' : value.setScale(0).format();
  }

  // ---------- Licences de l'org (cibles de rattachement) ----------

  private class Usage {
    public String key;
    public String label;
    public String kind;
    public String unit = 'licenses';
    public Decimal total;
    public Decimal assigned;
    public Decimal inactive;
    public Decimal active;
  }

  private static Map<String, Usage> usages(
    OrgAdoptionService.Analysis analysis
  ) {
    Map<String, Usage> usages = new Map<String, Usage>();
    OrgAdoptionLicenses.Result licenses = analysis.licenses;
    if (licenses == null) {
      return usages;
    }
    for (OrgAdoptionLicenses.UserLicenseRow row : licenses.userLicenses) {
      Usage usage = new Usage();
      usage.key = userLicenseKey(row.name);
      usage.label = 'User license: ' + row.name;
      usage.kind = TYPE_USER_LICENSE;
      usage.total = row.total;
      usage.assigned = row.used;
      usage.inactive = row.included ? null : row.inactive;
      usage.active = Math.max(0, row.used - (row.included ? 0 : row.inactive));
      usages.put(usage.key, usage);
    }
    for (OrgAdoptionLicenses.AddOnRow row : licenses.addOns) {
      Usage usage = new Usage();
      usage.key = row.key;
      usage.kind = row.kind == 'Usage entitlement'
        ? TYPE_ENTITLEMENT
        : TYPE_ADD_ON;
      usage.label = row.kind + ': ' + row.name;
      usage.unit = row.kind == 'Usage entitlement'
        ? (String.isBlank(row.unit) ? 'units' : row.unit.toLowerCase())
        : 'licenses';
      usage.total = row.total;
      usage.assigned = row.used;
      usage.active = row.used;
      usages.put(usage.key, usage);
    }
    return usages;
  }

  public static String userLicenseKey(String name) {
    return 'USER:' + name;
  }

  // ---------- Pré-remplissage ----------

  /**
   * Lignes proposées depuis une analyse : une ligne par licence utilisateur payante, quantité =
   * celle visible dans Salesforce. Il ne reste qu'à saisir les prix et le renouvellement. Les
   * licences de permission sets (souvent gratuites) ne sont pas reprises : elles se rattachent à la
   * main. Les licences déjà rattachées à une ligne existante sont ignorées. Rien n'est enregistré :
   * l'écran ajoute les lignes au contrat gardé dans le navigateur.
   */
  public static List<Line> prefill(
    OrgAdoptionService.Analysis analysis,
    List<Line> existingLines
  ) {
    if (analysis == null || analysis.licenses == null) {
      throw new IllegalArgumentException(
        'Run an adoption analysis first: the contract is prefilled from the licenses it found.'
      );
    }
    Set<String> existing = new Set<String>();
    for (Line line : existingLines) {
      if (String.isNotBlank(line.matchedKey)) {
        existing.add(line.matchedKey);
      }
    }
    // Licence utilisateur « Salesforce » : le cloud n'est pas lisible, on reprend ceux de l'analyse
    List<String> analysedClouds = analysis.selectedClouds == null
      ? new List<String>()
      : analysis.selectedClouds;
    List<Line> created = new List<Line>();
    for (
      OrgAdoptionLicenses.UserLicenseRow row : analysis.licenses.userLicenses
    ) {
      String key = userLicenseKey(row.name);
      if (row.included || row.status != 'Active' || existing.contains(key)) {
        continue;
      }
      Line line = new Line();
      line.product = row.name.abbreviate(80);
      line.lineType = TYPE_USER_LICENSE;
      line.cloud = guessCloud(row.name);
      line.quantity = row.total;
      line.pricePeriod = PER_MONTH;
      line.matchedKey = key;
      line.matchedLabel = 'User license: ' + row.name;
      if (line.cloud == null && row.name == 'Salesforce') {
        line.cloud = analysedClouds.contains(OrgAdoptionFeatures.SALES)
          ? OrgAdoptionFeatures.SALES
          : analysedClouds.contains(OrgAdoptionFeatures.SERVICE)
              ? OrgAdoptionFeatures.SERVICE
              : null;
      }
      created.add(line);
    }
    return created;
  }

  /** Cloud déduit du nom d'un produit ou d'une licence (null si inconnu). */
  @TestVisible
  private static String guessCloud(String name) {
    String lower = name == null ? '' : name.toLowerCase();
    if (lower.contains('field service')) {
      return OrgAdoptionFeatures.FIELD_SERVICE;
    }
    if (lower.contains('service cloud')) {
      return OrgAdoptionFeatures.SERVICE;
    }
    if (lower.contains('sales cloud')) {
      return OrgAdoptionFeatures.SALES;
    }
    if (
      lower.contains('community') ||
      lower.contains('experience cloud') ||
      lower.contains('partner community') ||
      lower.contains('customer community')
    ) {
      return OrgAdoptionFeatures.EXPERIENCE;
    }
    if (
      lower.contains('salesforce platform') ||
      lower.contains('lightning platform')
    ) {
      return OrgAdoptionFeatures.PLATFORM;
    }
    return null;
  }

  // ---------- Paramètres ----------

  private static String text(Map<String, Object> values, String name) {
    Object value = values.get(name);
    return value == null ? null : String.valueOf(value);
  }

  private static String blankToNull(String value) {
    return String.isBlank(value) ? null : value.trim();
  }

  private static Decimal nonNegative(Map<String, Object> values, String name) {
    String value = text(values, name);
    if (String.isBlank(value)) {
      return null;
    }
    try {
      Decimal amount = Decimal.valueOf(value.trim());
      return amount < 0 ? null : amount;
    } catch (Exception e) {
      return null;
    }
  }

  private static Date dateValue(Map<String, Object> values, String name) {
    String value = text(values, name);
    if (String.isBlank(value)) {
      return null;
    }
    try {
      return Date.valueOf(value.trim().left(10));
    } catch (Exception e) {
      return null;
    }
  }
}
