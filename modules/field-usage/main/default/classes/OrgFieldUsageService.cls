/**
 * Section « Objects & Fields » (module Field Usage), édition sans objet personnalisé : rien n'est
 * enregistré dans l'org. Le navigateur pilote l'analyse en trois temps :
 * 1. prepare : describe, champs analysables, présentations / pages Lightning / définitions de champs /
 *    dépendances lues par la Tooling API (callouts uniquement) ;
 * 2. scanChunk : une tranche d'enregistrements (Id > dernier Id lu), dont seuls des agrégats sortent
 *    (remplissage, dernière modification, comptes de valeurs pour listes de choix et cases à cocher,
 *    empreintes pour les autres champs) — le navigateur cumule et boucle jusqu'au dernier enregistrement ;
 * 3. finalizeAnalysis : statut et recommandation de chaque champ, score — sans DML.
 * Lectures en USER_MODE (objet, champs, partage de l'utilisateur).
 */
public inherited sharing class OrgFieldUsageService {
  public static final Integer DEFAULT_RECENT_DAYS = 90;
  /** En dessous de ce taux (%), un champ est « peu rempli ». */
  public static final Decimal LOW_FILL_PERCENT = 5;
  /** Un champ créé depuis moins de N jours est trop récent pour être jugé. */
  public static final Integer NEW_FIELD_DAYS = 90;
  /** Part de la valeur dominante au-delà de laquelle un champ est « constant ». */
  public static final Decimal CONSTANT_SHARE = 0.95;
  /** Plafond des valeurs distinctes suivies par champ. */
  public static final Integer DISTINCT_CAP = 25;
  private static final Integer MIN_RECORDS_CONSTANT = 10;
  private static final Integer MIN_RECENT_RECORDS = 5;
  private static final Integer TOP_VALUES = 8;
  private static final Integer CALLOUT_RESERVE = 3;
  private static final Integer DEPENDENCY_CHUNK = 100;
  /** Taille de tranche : budget de cellules (tas synchrone de 6 Mo), entre 50 et 2 000 lignes. */
  private static final Integer HEAP_BUDGET_PER_CHUNK = 30000;
  private static final Integer MIN_CHUNK = 50;
  private static final Integer MAX_CHUNK = 2000;
  /** Au-delà, la tranche s'arrête et rend la main (le navigateur reprend au dernier Id traité). */
  private static final Integer CPU_BUDGET_MS = 7000;
  /** Comptage indicatif (progression) : plafonné pour ne pas consommer la limite de lignes. */
  private static final Integer COUNT_CAP = 40000;

  public static final String STATUS_UNUSED = 'Unused';
  public static final String STATUS_EMPTY_ON_LAYOUT = 'Empty on layout';
  public static final String STATUS_NEVER_FILLED = 'Never filled';
  public static final String STATUS_ABANDONED = 'Abandoned';
  public static final String STATUS_LOW_FILL = 'Low fill';
  public static final String STATUS_CONSTANT = 'Constant';
  public static final String STATUS_HIDDEN = 'Hidden but filled';
  public static final String STATUS_UNDOCUMENTED = 'Undocumented';
  public static final String STATUS_NEW = 'New';
  public static final String STATUS_CALCULATED = 'Calculated';
  public static final String STATUS_NO_DATA = 'No data';
  public static final String STATUS_HEALTHY = 'Healthy';

  /** Points de chaque statut dans le score d'utilisation (statuts absents : hors score). */
  private static final Map<String, Decimal> SCORE_POINTS = new Map<String, Decimal>{
    STATUS_HEALTHY => 1,
    STATUS_HIDDEN => 1,
    STATUS_UNDOCUMENTED => 1,
    STATUS_LOW_FILL => 0.5,
    STATUS_CONSTANT => 0.5,
    STATUS_ABANDONED => 0.25,
    STATUS_UNUSED => 0,
    STATUS_EMPTY_ON_LAYOUT => 0,
    STATUS_NEVER_FILLED => 0
  };
  private static final Set<String> ISSUE_STATUSES = new Set<String>{
    STATUS_UNUSED,
    STATUS_EMPTY_ON_LAYOUT,
    STATUS_NEVER_FILLED,
    STATUS_ABANDONED
  };
  /** Champs système : jamais analysés (renseignés par la plateforme). */
  private static final Set<String> SYSTEM_FIELDS = new Set<String>{
    'id',
    'isdeleted',
    'systemmodstamp',
    'createddate',
    'createdbyid',
    'lastmodifieddate',
    'lastmodifiedbyid',
    'lastvieweddate',
    'lastreferenceddate',
    'lastactivitydate',
    'masterrecordid',
    'connectionreceivedid',
    'connectionsentid',
    'lastcurequestdate',
    'lastcuupdatedate'
  };
  private static final List<String> EXCLUDED_SUFFIXES = new List<String>{
    '__mdt',
    '__e',
    '__x',
    '__b',
    '__share',
    '__history',
    '__feed',
    '__changeevent',
    '__hd',
    '_hd',
    'history',
    'share',
    'feed',
    'changeevent'
  };

  // ---------- Modèles ----------

  /** Compteurs d'un champ (une tranche, ou le cumul fait par le navigateur). */
  public class FieldStats {
    public Integer filled = 0;
    public Integer recentFilled = 0;
    public Integer falseCount = 0;
    public Datetime lastFilledAt;
    /** Libellé (listes de choix, cases) ou empreinte (autres champs) → nombre d'enregistrements. */
    public Map<String, Integer> values = new Map<String, Integer>();
    public Boolean overflow = false;
  }

  public class ObjectSummary {
    public String apiName;
    public String label;
    public Boolean isCustom;
  }

  /** Définition d'un champ personnalisé lue par la Tooling API. */
  public class CustomFieldInfo {
    public String id;
    public String createdDate;
    public String description;
  }

  /** Ce que la Tooling API a appris de l'objet (renvoyé au navigateur, puis à finalizeAnalysis). */
  public class MetadataInfo {
    public Boolean toolingAvailable = false;
    public Boolean layoutsKnown = false;
    public Boolean fieldsKnown = false;
    public Boolean dependenciesKnown = false;
    public Integer layoutCount = 0;
    public Map<String, List<String>> layoutsByField = new Map<String, List<String>>();
    public Map<String, CustomFieldInfo> customFields = new Map<String, CustomFieldInfo>();
    public Map<String, List<Map<String, String>>> dependenciesByField = new Map<String, List<Map<String, String>>>();
    public List<String> notes = new List<String>();
  }

  public class PreparedAnalysis {
    public String objectName;
    public String objectLabel;
    public Integer recentDays;
    public Datetime recentSince;
    public Datetime startedAt;
    public List<String> fields = new List<String>();
    public Integer chunkSize;
    /** Nombre d'enregistrements (indicatif, plafonné : countCapped). */
    public Integer estimatedCount;
    public Boolean countCapped = false;
    public String orgDomainUrl;
    public MetadataInfo meta;
  }

  public class ChunkResult {
    public Integer records = 0;
    public Integer recent = 0;
    public String lastId;
    public Boolean done = false;
    public Map<String, FieldStats> stats = new Map<String, FieldStats>();
  }

  public class FieldResult {
    public String id;
    public String apiName;
    public String label;
    public String dataType;
    public Boolean isCustom;
    public Boolean isCalculated;
    public Boolean isRequired;
    public Integer filled;
    public Integer recentFilled;
    public Integer distinctCount;
    public Boolean onLayout;
    public Integer layoutCount;
    public Integer dependencyCount;
    public Date fieldCreatedDate;
    public Datetime lastFilledAt;
    public String status;
    public Map<String, Object> details;
  }

  public class AnalysisResult {
    public Integer score;
    public Integer issueCount = 0;
    public Integer unusedCount = 0;
    public Map<String, Integer> statusCounts = new Map<String, Integer>();
    public List<FieldResult> fields = new List<FieldResult>();
  }

  // ---------- Objets ----------

  public static Schema.DescribeSObjectResult describeObject(String objectName) {
    List<Schema.DescribeSObjectResult> results;
    try {
      results = Schema.describeSObjects(
        new List<String>{ objectName },
        SObjectDescribeOptions.FULL
      );
    } catch (Exception e) {
      results = new List<Schema.DescribeSObjectResult>();
    }
    if (results.isEmpty()) {
      throw new IllegalArgumentException(
        'The object "' + objectName + '" does not exist.'
      );
    }
    return results[0];
  }

  /** Objet lisible et interrogeable par l'utilisateur, sinon erreur lisible. */
  private static Schema.DescribeSObjectResult queryableObject(
    String objectName
  ) {
    Schema.DescribeSObjectResult describe = describeObject(objectName);
    if (!describe.isAccessible()) {
      throw OrgIntelAccess.error(
        'You do not have access to the records of ' + objectName + '.'
      );
    }
    if (!describe.isQueryable()) {
      throw new IllegalArgumentException(
        'The records of ' + objectName + ' cannot be queried.'
      );
    }
    return describe;
  }

  /**
   * Champs analysés : tous les champs lisibles par l'utilisateur (FLS), hors champs système, composés
   * et binaires.
   */
  public static List<Schema.DescribeFieldResult> analysableFields(
    Schema.DescribeSObjectResult describe
  ) {
    List<Schema.DescribeFieldResult> result = new List<Schema.DescribeFieldResult>();
    List<String> names = new List<String>();
    Map<String, Schema.SObjectField> fields = describe.fields.getMap();
    names.addAll(fields.keySet());
    names.sort();
    for (String key : names) {
      Schema.DescribeFieldResult field = fields.get(key).getDescribe();
      Schema.DisplayType type = field.getType();
      if (
        !field.isAccessible() ||
        SYSTEM_FIELDS.contains(key) ||
        isRedundantComponent(field, key) ||
        field.isDeprecatedAndHidden() ||
        type == Schema.DisplayType.ADDRESS ||
        type == Schema.DisplayType.LOCATION ||
        type == Schema.DisplayType.BASE64 ||
        type == Schema.DisplayType.ID ||
        type == Schema.DisplayType.ENCRYPTEDSTRING ||
        type == Schema.DisplayType.COMPLEXVALUE ||
        type == Schema.DisplayType.ANYTYPE
      ) {
        continue;
      }
      result.add(field);
    }
    return result;
  }

  /** Sous-champs techniques d'une adresse (coordonnées, codes ISO) : redondants avec le composé. */
  private static Boolean isRedundantComponent(
    Schema.DescribeFieldResult field,
    String key
  ) {
    if (field.getCompoundFieldName() == null) {
      return false;
    }
    return key.endsWith('latitude') ||
      key.endsWith('longitude') ||
      key.endsWith('geocodeaccuracy') ||
      key.endsWith('statecode') ||
      key.endsWith('countrycode');
  }

  /** Objets analysables (les analyses déjà faites sont gardées par le navigateur). */
  public static List<ObjectSummary> listObjects() {
    Map<String, Schema.SObjectType> globalTypes = Schema.getGlobalDescribe();
    List<ObjectSummary> result = new List<ObjectSummary>();
    // Liste lue en une fois : une boucle for sur la requête lirait par paquets de 200 (queryMore),
    // non supporté par EntityDefinition
    List<EntityDefinition> entities = [
      SELECT QualifiedApiName, Label, IsCustomSetting, KeyPrefix
      FROM EntityDefinition
      WHERE IsCustomizable = TRUE
      WITH USER_MODE
      ORDER BY QualifiedApiName
      LIMIT 2000
    ];
    for (EntityDefinition entity : entities) {
      String name = entity.QualifiedApiName;
      if (
        entity.IsCustomSetting ||
        entity.KeyPrefix == null ||
        isExcluded(name) ||
        !globalTypes.containsKey(name.toLowerCase())
      ) {
        continue;
      }
      ObjectSummary summary = new ObjectSummary();
      summary.apiName = name;
      summary.label = entity.Label;
      summary.isCustom = name.endsWith('__c');
      result.add(summary);
    }
    return result;
  }

  private static Boolean isExcluded(String name) {
    String lower = name.toLowerCase();
    for (String suffix : EXCLUDED_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  }

  /** Score d'utilisation (0-100) : part pondérée des champs jugés utiles. */
  public static Integer score(Map<String, Integer> byStatus) {
    Decimal points = 0;
    Integer counted = 0;
    for (String status : byStatus.keySet()) {
      if (SCORE_POINTS.containsKey(status)) {
        points += SCORE_POINTS.get(status) * byStatus.get(status);
        counted += byStatus.get(status);
      }
    }
    return counted == 0 ? null : (100 * points / counted).round().intValue();
  }

  // ---------- 1. Préparation ----------

  public static PreparedAnalysis prepare(
    String objectName,
    Integer recentDays
  ) {
    Schema.DescribeSObjectResult describe = queryableObject(objectName);
    String apiName = describe.getName();
    PreparedAnalysis prepared = new PreparedAnalysis();
    prepared.objectName = apiName;
    prepared.objectLabel = describe.getLabel();
    prepared.recentDays = recentDays == null ||
      recentDays <= 0
      ? DEFAULT_RECENT_DAYS
      : Math.min(recentDays, 3650);
    prepared.startedAt = Datetime.now();
    prepared.recentSince = prepared.startedAt.addDays(-prepared.recentDays);
    prepared.orgDomainUrl = Url.getOrgDomainUrl().toExternalForm();
    Integer weight = 0;
    for (Schema.DescribeFieldResult field : analysableFields(describe)) {
      prepared.fields.add(field.getName());
      weight += cellWeight(field);
    }
    prepared.chunkSize = Math.max(
      MIN_CHUNK,
      Math.min(MAX_CHUNK, HEAP_BUDGET_PER_CHUNK / Math.max(1, weight))
    );
    // Callouts Tooling avant tout ; aucune écriture ici (hors journal API, écrit en dernier)
    prepared.meta = collectMetadata(apiName);
    try {
      prepared.estimatedCount = Database.countQuery(
        'SELECT COUNT() FROM ' +
          String.escapeSingleQuotes(apiName) +
          ' LIMIT ' +
          COUNT_CAP,
        AccessLevel.USER_MODE
      );
      prepared.countCapped = prepared.estimatedCount >= COUNT_CAP;
    } catch (Exception e) {
      prepared.estimatedCount = null;
    }
    OrgApiLogger.flush();
    return prepared;
  }

  /** Poids d'un champ dans le tas : les textes longs pèsent bien plus qu'une cellule ordinaire. */
  private static Integer cellWeight(Schema.DescribeFieldResult field) {
    Schema.DisplayType type = field.getType();
    if (type == Schema.DisplayType.TEXTAREA && field.getLength() > 255) {
      return 1 + Math.min(32, field.getLength() / 1000);
    }
    return 1;
  }

  // ---------- 2. Parcours par tranches ----------

  /**
   * Lit une tranche d'enregistrements (Id > lastId, tri par Id) et n'en renvoie que des agrégats.
   * Les noms de champs demandés sont recoupés avec les champs analysables (jamais injectés tels quels).
   */
  public static ChunkResult scanChunk(
    String objectName,
    List<String> requestedFields,
    String lastId,
    Integer chunkSize,
    Datetime recentSince
  ) {
    Schema.DescribeSObjectResult describe = queryableObject(objectName);
    Map<String, Schema.SObjectField> allFields = describe.fields.getMap();
    Set<String> requested = new Set<String>();
    for (
      String name : requestedFields == null
        ? new List<String>()
        : requestedFields
    ) {
      // textList garde les valeurs nulles : noms vides ignorés
      if (String.isNotBlank(name)) {
        requested.add(name.toLowerCase());
      }
    }
    List<String> fieldNames = new List<String>();
    Set<String> booleanFields = new Set<String>();
    Set<String> valueFields = new Set<String>();
    Set<String> multiFields = new Set<String>();
    for (Schema.DescribeFieldResult field : analysableFields(describe)) {
      String name = field.getName();
      if (!requested.isEmpty() && !requested.contains(name.toLowerCase())) {
        continue;
      }
      fieldNames.add(name);
      Schema.DisplayType type = field.getType();
      if (type == Schema.DisplayType.BOOLEAN) {
        booleanFields.add(name);
        valueFields.add(name);
      } else if (type == Schema.DisplayType.PICKLIST) {
        valueFields.add(name);
      } else if (type == Schema.DisplayType.MULTIPICKLIST) {
        valueFields.add(name);
        multiFields.add(name);
      }
    }
    Boolean hasDates =
      allFields.containsKey('createddate') &&
      allFields.containsKey('lastmodifieddate');
    List<String> columns = new List<String>{ 'Id' };
    if (hasDates) {
      columns.add('CreatedDate');
      columns.add('LastModifiedDate');
    }
    for (String name : fieldNames) {
      if (!columns.contains(name)) {
        columns.add(name);
      }
    }
    Integer size = chunkSize == null
      ? MAX_CHUNK
      : Math.max(1, Math.min(MAX_CHUNK, chunkSize));
    Map<String, Object> binds = new Map<String, Object>();
    String soql =
      'SELECT ' +
      String.join(columns, ', ') +
      ' FROM ' +
      String.escapeSingleQuotes(describe.getName());
    if (String.isNotBlank(lastId)) {
      binds.put('lastId', Id.valueOf(lastId));
      soql += ' WHERE Id > :lastId';
    }
    soql += ' ORDER BY Id LIMIT ' + size;
    List<SObject> records = Database.queryWithBinds(
      soql,
      binds,
      AccessLevel.USER_MODE
    );

    ChunkResult result = new ChunkResult();
    for (String name : fieldNames) {
      result.stats.put(name, new FieldStats());
    }
    result.lastId = lastId;
    Integer processed = 0;
    for (SObject record : records) {
      if (processed > 0 && Limits.getCpuTime() > CPU_BUDGET_MS) {
        break; // la suite sera lue par l'appel suivant, à partir du dernier Id traité
      }
      processed++;
      result.records++;
      result.lastId = (String) record.Id;
      Datetime created = hasDates ? (Datetime) record.get('CreatedDate') : null;
      Datetime modified = hasDates
        ? (Datetime) record.get('LastModifiedDate')
        : null;
      Boolean recent =
        created != null &&
        recentSince != null &&
        created >= recentSince;
      if (recent) {
        result.recent++;
      }
      for (String name : fieldNames) {
        Object value = record.get(name);
        FieldStats stat = result.stats.get(name);
        Boolean isBoolean = booleanFields.contains(name);
        Boolean filled;
        if (isBoolean) {
          filled = value == true;
          if (!filled) {
            stat.falseCount++;
          }
        } else if (value instanceof String) {
          filled = String.isNotBlank((String) value);
        } else {
          filled = value != null;
        }
        if (filled) {
          stat.filled++;
          if (recent) {
            stat.recentFilled++;
          }
          if (
            modified != null &&
            (stat.lastFilledAt == null ||
            modified > stat.lastFilledAt)
          ) {
            stat.lastFilledAt = modified;
          }
        }
        if (filled || isBoolean) {
          trackValue(
            stat,
            value == null ? false : value,
            valueFields.contains(name),
            multiFields.contains(name)
          );
        }
      }
    }
    result.done = processed == records.size() && records.size() < size;
    return result;
  }

  /** Valeurs distinctes : libellé pour les listes de choix et cases, empreinte sinon. */
  private static void trackValue(
    FieldStats stat,
    Object value,
    Boolean isValueField,
    Boolean isMulti
  ) {
    List<String> keys = new List<String>();
    if (isMulti) {
      keys.addAll(String.valueOf(value).split(';'));
    } else if (isValueField) {
      keys.add(String.valueOf(value));
    } else {
      keys.add(String.valueOf(String.valueOf(value).hashCode()));
    }
    for (String key : keys) {
      if (stat.values.containsKey(key)) {
        stat.values.put(key, stat.values.get(key) + 1);
      } else if (stat.values.size() <= DISTINCT_CAP) {
        stat.values.put(key, 1);
      } else {
        stat.overflow = true;
      }
    }
  }

  // ---------- Tooling API ----------

  @TestVisible
  private static MetadataInfo collectMetadata(String objectName) {
    MetadataInfo meta = new MetadataInfo();
    OrgToolingGateway tooling = OrgToolingGateway.getInstance();
    try {
      if (!tooling.isConfigured()) {
        meta.notes.add(
          'Tooling API not configured: layouts, field creation dates, descriptions and dependencies were not checked.'
        );
        return meta;
      }
    } catch (Exception e) {
      meta.notes.add('Tooling API not available: ' + e.getMessage());
      return meta;
    }
    List<EntityDefinition> entities = [
      SELECT DurableId
      FROM EntityDefinition
      WHERE QualifiedApiName = :objectName
      LIMIT 1
    ];
    String tableId = entities.isEmpty() ? objectName : entities[0].DurableId;
    String table = String.escapeSingleQuotes(tableId);
    meta.toolingAvailable = true;

    // Définitions des champs personnalisés : date de création, description
    try {
      for (
        Map<String, Object> record : tooling.query(
          'SELECT Id, DeveloperName, NamespacePrefix, CreatedDate, Description FROM CustomField WHERE TableEnumOrId = \'' +
            table +
            '\''
        )
      ) {
        String ns = (String) record.get('NamespacePrefix');
        String apiName =
          (String.isBlank(ns) ? '' : ns + '__') +
          record.get('DeveloperName') +
          '__c';
        CustomFieldInfo info = new CustomFieldInfo();
        info.id = (String) record.get('Id');
        info.createdDate = record.get('CreatedDate') == null
          ? null
          : String.valueOf(record.get('CreatedDate'));
        info.description = (String) record.get('Description');
        meta.customFields.put(apiName.toLowerCase(), info);
      }
      meta.fieldsKnown = true;
    } catch (Exception e) {
      meta.toolingAvailable = false;
      meta.notes.add(
        'Tooling API not available (' +
          e.getMessage().abbreviate(200) +
          '): layouts and dependencies were not checked.'
      );
      return meta;
    }

    // Présentations de page puis pages Lightning (champs Dynamic Forms)
    try {
      List<Map<String, Object>> layouts = tooling.query(
        'SELECT Id, Name FROM Layout WHERE TableEnumOrId = \'' + table + '\''
      );
      List<Map<String, Object>> pages = new List<Map<String, Object>>();
      try {
        pages = tooling.query(
          'SELECT Id, MasterLabel FROM FlexiPage WHERE EntityDefinitionId = \'' +
            table +
            '\' AND Type = \'RecordPage\''
        );
      } catch (Exception e) {
        meta.notes.add('Lightning record pages not read: ' + e.getMessage());
      }
      Integer skipped = 0;
      for (Map<String, Object> layout : layouts) {
        if (!calloutsLeft()) {
          skipped++;
          continue;
        }
        String name = (String) layout.get('Name');
        List<Map<String, Object>> rows = tooling.query(
          'SELECT Metadata FROM Layout WHERE Id = \'' + layout.get('Id') + '\''
        );
        if (!rows.isEmpty()) {
          for (String field : layoutFields(rows[0].get('Metadata'))) {
            addLayout(meta, field, name);
          }
        }
        meta.layoutCount++;
      }
      for (Map<String, Object> page : pages) {
        if (!calloutsLeft()) {
          skipped++;
          continue;
        }
        String name = 'Lightning page: ' + page.get('MasterLabel');
        List<Map<String, Object>> rows = tooling.query(
          'SELECT Metadata FROM FlexiPage WHERE Id = \'' + page.get('Id') + '\''
        );
        Set<String> fields = rows.isEmpty()
          ? new Set<String>()
          : pageFields(rows[0].get('Metadata'));
        for (String field : fields) {
          addLayout(meta, field, name);
        }
        if (!fields.isEmpty()) {
          meta.layoutCount++;
        }
      }
      meta.layoutsKnown = true;
      if (skipped > 0) {
        meta.notes.add(
          skipped +
          ' layouts or pages were not read (callout limit): some fields may be shown on a layout not checked.'
        );
      }
    } catch (Exception e) {
      meta.notes.add('Layouts not read: ' + e.getMessage().abbreviate(200));
    }

    // Dépendances des champs personnalisés (flows, Apex, règles de validation, rapports…)
    try {
      Map<String, String> fieldById = new Map<String, String>();
      List<String> ids = new List<String>();
      for (String apiName : meta.customFields.keySet()) {
        String fieldId = meta.customFields.get(apiName).id;
        fieldById.put(fieldId.left(15), apiName);
        ids.add(fieldId);
      }
      for (Integer i = 0; i < ids.size(); i += DEPENDENCY_CHUNK) {
        if (!calloutsLeft()) {
          meta.notes.add(
            'Dependencies partially read (callout limit): some fields may look unreferenced.'
          );
          break;
        }
        List<String> chunk = new List<String>();
        for (
          Integer j = i; j < Math.min(i + DEPENDENCY_CHUNK, ids.size()); j++
        ) {
          chunk.add(ids[j]);
        }
        for (
          Map<String, Object> record : tooling.query(
            'SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (\'' +
              String.join(chunk, '\',\'') +
              '\')'
          )
        ) {
          String type = (String) record.get('MetadataComponentType');
          String refId = ((String) record.get('RefMetadataComponentId'))
            .left(15);
          String sourceId = (String) record.get('MetadataComponentId');
          if (
            type == 'Layout' ||
            type == 'FlexiPage' ||
            (sourceId != null &&
            sourceId.left(15) == refId)
          ) {
            continue; // présentations comptées à part ; référence à soi-même
          }
          String apiName = fieldById.get(refId);
          if (apiName == null) {
            continue;
          }
          if (!meta.dependenciesByField.containsKey(apiName)) {
            meta.dependenciesByField.put(
              apiName,
              new List<Map<String, String>>()
            );
          }
          meta.dependenciesByField.get(apiName)
            .add(
              new Map<String, String>{
                'name' => (String) record.get('MetadataComponentName'),
                'type' => type
              }
            );
        }
      }
      meta.dependenciesKnown = true;
    } catch (Exception e) {
      meta.notes.add(
        'Dependencies not read: ' + e.getMessage().abbreviate(200)
      );
    }
    return meta;
  }

  // ---------- 3. Statut de chaque champ (sans DML) ----------

  public static AnalysisResult finalizeAnalysis(
    String objectName,
    Integer recentDays,
    Integer recordCount,
    Integer recentCount,
    Map<String, FieldStats> stats,
    MetadataInfo meta
  ) {
    Schema.DescribeSObjectResult describe = describeObject(objectName);
    meta = meta == null ? new MetadataInfo() : meta;
    stats = stats == null ? new Map<String, FieldStats>() : stats;
    recordCount = recordCount == null ? 0 : recordCount;
    recentCount = recentCount == null ? 0 : recentCount;
    recentDays = recentDays == null ? DEFAULT_RECENT_DAYS : recentDays;
    AnalysisResult result = new AnalysisResult();
    Date today = Date.today();
    for (Schema.DescribeFieldResult field : analysableFields(describe)) {
      String name = field.getName();
      FieldStats stat = stats.get(name);
      if (stat == null) {
        continue;
      }
      stat.values = stat.values == null
        ? new Map<String, Integer>()
        : stat.values;
      stat.overflow = stat.overflow == true;
      Schema.DisplayType type = field.getType();
      Boolean isBoolean = type == Schema.DisplayType.BOOLEAN;
      Boolean isValueField =
        isBoolean ||
        type == Schema.DisplayType.PICKLIST ||
        type == Schema.DisplayType.MULTIPICKLIST;
      // isCreateable / isUpdateable dépendent des droits de l'utilisateur : non utilisés ici
      Boolean isCalculated = field.isCalculated() || field.isAutoNumber();
      Boolean isRequired =
        !isBoolean &&
        !isCalculated &&
        !field.isNillable() &&
        !field.isDefaultedOnCreate();
      String key = name.toLowerCase();
      CustomFieldInfo definition = meta.customFields == null
        ? null
        : meta.customFields.get(key);
      Date created;
      if (definition != null && definition.createdDate != null) {
        try {
          created = ((Datetime) JSON.deserialize(
              '"' + definition.createdDate + '"',
              Datetime.class
            ))
            .date();
        } catch (Exception e) {
          created = null;
        }
      }
      // Champ d'un champ composé (FirstName, MailingCity…) : la présentation porte le composé
      String compound = field.getCompoundFieldName() == null
        ? null
        : field.getCompoundFieldName().toLowerCase();
      Map<String, List<String>> layoutsByField = meta.layoutsByField == null
        ? new Map<String, List<String>>()
        : meta.layoutsByField;
      List<String> layouts = layoutsByField.containsKey(key)
        ? layoutsByField.get(key)
        : compound != null && layoutsByField.containsKey(compound)
            ? layoutsByField.get(compound)
            : new List<String>();
      List<Map<String, String>> dependencies = meta.dependenciesByField !=
        null && meta.dependenciesByField.containsKey(key)
        ? meta.dependenciesByField.get(key)
        : new List<Map<String, String>>();
      Boolean dependenciesKnown =
        meta.dependenciesKnown == true && field.isCustom();
      Boolean layoutsKnown = meta.layoutsKnown == true;

      // Valeurs dominantes (listes de choix et cases uniquement)
      List<Map<String, Object>> topValues = new List<Map<String, Object>>();
      Integer topCount = 0;
      for (String value : stat.values.keySet()) {
        topCount = Math.max(topCount, stat.values.get(value));
      }
      if (isValueField) {
        List<String> ordered = new List<String>(stat.values.keySet());
        ordered.sort();
        List<ValueCount> counts = new List<ValueCount>();
        for (String value : ordered) {
          counts.add(new ValueCount(value, stat.values.get(value)));
        }
        counts.sort();
        for (Integer i = 0; i < Math.min(TOP_VALUES, counts.size()); i++) {
          topValues.add(
            new Map<String, Object>{
              'value' => counts[i].value,
              'count' => counts[i].count
            }
          );
        }
      }

      Usage usage = new Usage();
      usage.recordCount = recordCount;
      usage.recentCount = recentCount;
      usage.recentDays = recentDays;
      usage.filled = nz(stat.filled);
      usage.recentFilled = nz(stat.recentFilled);
      usage.falseCount = nz(stat.falseCount);
      usage.isBoolean = isBoolean;
      usage.isCalculated = isCalculated;
      usage.isCustom = field.isCustom();
      usage.isManaged =
        field.isCustom() && name.removeEnd('__c').contains('__');
      usage.isRequired = isRequired;
      usage.isWritable = !isCalculated;
      usage.layoutsKnown = layoutsKnown;
      usage.layoutCount = layouts.size();
      usage.dependenciesKnown = dependenciesKnown;
      usage.dependencyCount = dependencies.size();
      usage.ageDays = created == null ? null : created.daysBetween(today);
      usage.documentationKnown = definition != null;
      usage.hasDescription =
        definition != null && String.isNotBlank(definition.description);
      usage.distinct = stat.values.size();
      usage.overflow = stat.overflow;
      usage.topShare = usage.filled == 0 || isBoolean
        ? 0
        : Decimal.valueOf(topCount) / usage.filled;
      evaluate(usage);

      FieldResult row = new FieldResult();
      row.id = name;
      row.apiName = name;
      row.label = field.getLabel();
      row.dataType = String.valueOf(type).abbreviate(40);
      row.isCustom = field.isCustom();
      row.isCalculated = isCalculated;
      row.isRequired = isRequired;
      row.filled = usage.filled;
      row.recentFilled = usage.recentFilled;
      row.distinctCount = stat.values.size();
      row.onLayout = !layouts.isEmpty();
      row.layoutCount = layoutsKnown ? layouts.size() : null;
      row.dependencyCount = dependenciesKnown ? dependencies.size() : null;
      row.fieldCreatedDate = created;
      row.lastFilledAt = stat.lastFilledAt;
      row.status = usage.status;
      row.details = new Map<String, Object>{
        'recommendation' => usage.recommendation,
        'topValues' => topValues,
        'falseCount' => isBoolean ? usage.falseCount : null,
        'distinctOverflow' => stat.overflow,
        'layouts' => layouts,
        'layoutsKnown' => layoutsKnown,
        'dependencies' => dependencies.size() > 100
          ? slice(dependencies, 100)
          : dependencies,
        'dependenciesTruncated' => dependencies.size() > 100,
        'dependenciesKnown' => dependenciesKnown,
        'description' => definition == null ? null : definition.description,
        'helpText' => field.getInlineHelpText(),
        'length' => field.getLength() > 0 ? field.getLength() : null,
        'referenceTo' => referenceTo(field),
        'picklistValueCount' => field.getPicklistValues().isEmpty()
          ? null
          : field.getPicklistValues().size(),
        'olderFillPercent' => usage.olderFillPercent,
        'managed' => usage.isManaged
      };
      result.fields.add(row);
      Integer current = result.statusCounts.get(usage.status);
      result.statusCounts.put(usage.status, current == null ? 1 : current + 1);
    }
    result.score = score(result.statusCounts);
    for (String status : ISSUE_STATUSES) {
      result.issueCount += result.statusCounts.containsKey(status)
        ? result.statusCounts.get(status)
        : 0;
    }
    result.unusedCount = result.statusCounts.containsKey(STATUS_UNUSED)
      ? result.statusCounts.get(STATUS_UNUSED)
      : 0;
    return result;
  }

  private static Integer nz(Integer value) {
    return value == null ? 0 : value;
  }

  private static List<Map<String, String>> slice(
    List<Map<String, String>> items,
    Integer size
  ) {
    List<Map<String, String>> result = new List<Map<String, String>>();
    for (Integer i = 0; i < Math.min(size, items.size()); i++) {
      result.add(items[i]);
    }
    return result;
  }

  private static String referenceTo(Schema.DescribeFieldResult field) {
    List<String> names = new List<String>();
    for (Schema.SObjectType type : field.getReferenceTo()) {
      names.add(String.valueOf(type));
    }
    return names.isEmpty() ? null : String.join(names, ', ');
  }

  private class ValueCount implements Comparable {
    String value;
    Integer count;
    ValueCount(String value, Integer count) {
      this.value = value;
      this.count = count;
    }
    public Integer compareTo(Object other) {
      return ((ValueCount) other).count - count;
    }
  }

  /** Entrées et sortie du calcul de statut d'un champ. */
  @TestVisible
  private class Usage {
    Integer recordCount;
    Integer recentCount;
    Integer recentDays;
    Integer filled;
    Integer recentFilled;
    Integer falseCount;
    Boolean isBoolean;
    Boolean isCalculated;
    Boolean isCustom;
    Boolean isManaged;
    Boolean isRequired;
    Boolean isWritable;
    Boolean layoutsKnown;
    Integer layoutCount;
    Boolean dependenciesKnown;
    Integer dependencyCount;
    Integer ageDays;
    Boolean documentationKnown;
    Boolean hasDescription;
    Integer distinct;
    Boolean overflow;
    Decimal topShare;
    Decimal olderFillPercent;
    String status;
    String recommendation;
  }

  private static Boolean calloutsLeft() {
    return Limits.getCallouts() < Limits.getLimitCallouts() - CALLOUT_RESERVE;
  }

  private static void addLayout(MetadataInfo meta, String field, String name) {
    String key = field.toLowerCase();
    if (!meta.layoutsByField.containsKey(key)) {
      meta.layoutsByField.put(key, new List<String>());
    }
    if (!meta.layoutsByField.get(key).contains(name)) {
      meta.layoutsByField.get(key).add(name);
    }
  }

  /** Champs d'une présentation : layoutSections › layoutColumns › layoutItems › field. */
  @TestVisible
  private static Set<String> layoutFields(Object metadata) {
    Set<String> fields = new Set<String>();
    for (Object section : asList(asMap(metadata).get('layoutSections'))) {
      for (Object column : asList(asMap(section).get('layoutColumns'))) {
        for (Object item : asList(asMap(column).get('layoutItems'))) {
          Object field = asMap(item).get('field');
          if (field != null) {
            fields.add(String.valueOf(field));
          }
        }
      }
    }
    return fields;
  }

  /** Champs Dynamic Forms d'une page Lightning (« Record.Champ__c »). */
  @TestVisible
  private static Set<String> pageFields(Object metadata) {
    Set<String> fields = new Set<String>();
    for (Object region : asList(asMap(metadata).get('flexiPageRegions'))) {
      for (Object instance : asList(asMap(region).get('itemInstances'))) {
        Object fieldItem = asMap(asMap(instance).get('fieldInstance'))
          .get('fieldItem');
        if (fieldItem != null) {
          String value = String.valueOf(fieldItem);
          fields.add(value.contains('.') ? value.substringAfter('.') : value);
        }
      }
    }
    return fields;
  }

  private static Map<String, Object> asMap(Object value) {
    return value instanceof Map<String, Object>
      ? (Map<String, Object>) value
      : new Map<String, Object>();
  }

  private static List<Object> asList(Object value) {
    return value instanceof List<Object>
      ? (List<Object>) value
      : new List<Object>();
  }

  /** Statut et recommandation, par ordre de priorité. */
  @TestVisible
  private static void evaluate(Usage u) {
    Decimal fill = u.recordCount == 0
      ? 0
      : (100.0 * u.filled / u.recordCount).setScale(1);
    String fillText = fill.format() + '%';
    Integer olderRecords = u.recordCount - u.recentCount;
    u.olderFillPercent = olderRecords > 0
      ? (100.0 * (u.filled - u.recentFilled) / olderRecords).setScale(1)
      : null;
    Boolean onLayout = u.layoutsKnown && u.layoutCount > 0;
    Boolean hidden = u.layoutsKnown && u.layoutCount == 0;
    Boolean referenced = u.dependenciesKnown && u.dependencyCount > 0;
    Boolean unreferenced = !u.dependenciesKnown || u.dependencyCount == 0;
    Boolean isNew = u.ageDays != null && u.ageDays < NEW_FIELD_DAYS;
    String layoutText = u.layoutCount == 1
      ? '1 layout'
      : u.layoutCount + ' layouts';
    String dependencyText = u.dependencyCount == 1
      ? '1 component'
      : u.dependencyCount + ' components';

    if (u.recordCount == 0) {
      assign(
        u,
        STATUS_NO_DATA,
        'The object has no record yet: usage cannot be judged.'
      );
    } else if (u.isCalculated) {
      if (
        u.isCustom &&
        hidden &&
        u.dependenciesKnown &&
        !referenced &&
        !isNew
      ) {
        assign(
          u,
          STATUS_UNUSED,
          'Calculated field shown on no layout and referenced nowhere: check it is still needed, then delete it.'
        );
      } else {
        assign(
          u,
          STATUS_CALCULATED,
          'Calculated or system field: its fill rate is not judged.'
        );
      }
    } else if (isNew) {
      assign(
        u,
        STATUS_NEW,
        'Created ' + u.ageDays + ' days ago: too recent to judge its usage.'
      );
    } else if (
      u.isBoolean &&
      u.recordCount >= MIN_RECORDS_CONSTANT &&
      (u.filled == 0 ||
      u.falseCount == 0)
    ) {
      String always = u.filled == 0 ? 'unchecked' : 'checked';
      if (u.filled == 0 && !onLayout && unreferenced && u.isCustom) {
        assign(
          u,
          STATUS_UNUSED,
          'Never checked, on no layout' +
            (u.dependenciesKnown ? ', referenced nowhere' : '') +
            (u.isManaged
              ? ': managed package field — it cannot be deleted, keep it off layouts and reports.'
              : ': candidate for deletion (export its definition first).')
        );
      } else {
        assign(
          u,
          STATUS_CONSTANT,
          'Always ' +
            always +
            ' on the ' +
            u.recordCount +
            ' records: remove it, or hide it until the process needs it.'
        );
      }
    } else if (!u.isBoolean && u.filled == 0) {
      if (onLayout) {
        assign(
          u,
          STATUS_EMPTY_ON_LAYOUT,
          'Shown on ' +
            layoutText +
            ' but never filled: remove it from the layouts or make it useful (help text, picklist, required).'
        );
      } else if (referenced) {
        assign(
          u,
          STATUS_NEVER_FILLED,
          'Never filled although referenced by ' +
            dependencyText +
            ': check the automation that should write it still works.'
        );
      } else if (u.isCustom) {
        assign(
          u,
          STATUS_UNUSED,
          'Never filled' +
            (u.layoutsKnown ? ', on no layout' : '') +
            (u.dependenciesKnown ? ', referenced nowhere' : '') +
            (u.isManaged
              ? ': managed package field — it cannot be deleted, keep it off layouts and reports.'
              : ': candidate for deletion (export its definition first).')
        );
      } else {
        assign(
          u,
          STATUS_UNUSED,
          'Standard field never filled' +
            (u.layoutsKnown ? ' and on no layout' : '') +
            ': remove it from list views and reports to simplify the screens.'
        );
      }
    } else if (
      !u.isBoolean &&
      u.recentCount >= MIN_RECENT_RECORDS &&
      u.recentFilled == 0 &&
      u.olderFillPercent != null &&
      u.olderFillPercent >= LOW_FILL_PERCENT
    ) {
      assign(
        u,
        STATUS_ABANDONED,
        'Filled on ' +
          u.olderFillPercent.format() +
          '% of older records but on none of the ' +
          u.recentCount +
          ' records created in the last ' +
          u.recentDays +
          ' days: the process changed — retire it or put it back on the layouts.'
      );
    } else if (!u.isBoolean && !u.isRequired && fill < LOW_FILL_PERCENT) {
      assign(
        u,
        STATUS_LOW_FILL,
        'Filled on only ' +
          fillText +
          ' of records (' +
          u.filled +
          '): check users need it, otherwise move it to a secondary section or retire it.'
      );
    } else if (
      !u.isBoolean &&
      !u.isRequired &&
      u.filled >= MIN_RECORDS_CONSTANT &&
      !u.overflow &&
      (u.distinct == 1 ||
      u.topShare >= CONSTANT_SHARE)
    ) {
      assign(
        u,
        STATUS_CONSTANT,
        (u.distinct == 1
          ? 'Always the same value'
          : 'The same value on ' +
            (u.topShare * 100).setScale(0).format() +
            '% of filled records') +
        ': set it as default value, or remove the field if it carries no information.'
      );
    } else if (hidden && u.isWritable && !u.isRequired && u.isCustom) {
      assign(
        u,
        STATUS_HIDDEN,
        'Filled on ' +
          fillText +
          ' but on no layout: written by automation or an integration — document it in the field description.'
      );
    } else if (
      u.isCustom &&
      !u.isManaged &&
      u.documentationKnown &&
      !u.hasDescription
    ) {
      assign(
        u,
        STATUS_UNDOCUMENTED,
        'Used (' +
          fillText +
          ') but without description: document its purpose and where its value comes from.'
      );
    } else {
      assign(
        u,
        STATUS_HEALTHY,
        'Filled on ' +
          fillText +
          (onLayout ? ' and shown on ' + layoutText : '') +
          '.'
      );
    }
  }

  private static void assign(Usage u, String status, String recommendation) {
    u.status = status;
    u.recommendation = recommendation;
  }
}
