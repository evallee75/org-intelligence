/**
 * Étape « Storage » : stockage données et fichiers (OrgLimits), nombre d'enregistrements par objet
 * (API REST Record Count, à défaut COUNT() SOQL), fichiers (ContentVersion, Attachment).
 *
 * La taille par objet est une estimation : 2 Ko par enregistrement (8 Ko pour une campagne,
 * 4 Ko pour un article), règle de calcul de Salesforce. L'utilisation exacte par objet n'est
 * consultable que dans Setup › Storage Usage. La photographie est renvoyée au navigateur avec le
 * scan (valeur « storage ») pour suivre l'évolution d'un scan à l'autre.
 */
public inherited sharing class OrgStorageStep implements OrgScanStep {
  private static final Map<String, Integer> RECORD_SIZE_KB = new Map<String, Integer>{
    'Campaign' => 8,
    'KnowledgeArticleVersion' => 4
  };
  private static final Pattern LOG_LIKE = Pattern.compile(
    '(?i)(log|history|histo|snapshot|error|event|trace|archive|audit|journal)'
  );
  private static final List<String> ACTIVITY_OBJECTS = new List<String>{
    'Task',
    'Event',
    'EmailMessage'
  };
  private static final Integer FALLBACK_OBJECTS = 80;
  /** Lignes gardées pour la suite de l'étape (fichiers, objets) après les comptages SOQL. */
  private static final Integer RESERVED_QUERY_ROWS = 5000;
  private static final Integer MIN_COUNT_ROWS = 1000;

  public String run(OrgScanContext ctx, String cursor) {
    // 1. Comptages (callout éventuel avant toute écriture)
    Map<String, Integer> counts = new Map<String, Integer>();
    String countSource;
    if (ctx.state.toolingAvailable) {
      try {
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(
          ctx.tooling.getRest('/limits/recordCount')
        );
        for (Object item : (List<Object>) body.get('sObjects')) {
          Map<String, Object> row = (Map<String, Object>) item;
          counts.put(
            (String) row.get('name'),
            Integer.valueOf(row.get('count'))
          );
        }
        countSource = 'Record Count API';
      } catch (Exception e) {
        ctx.warning(
          'Record counts API not available (' +
            e.getMessage().abbreviate(150) +
            '): falling back to SOQL counts.'
        );
      }
    }

    // Objets « données » : personnalisables (les objets de configuration ne consomment pas le stockage données)
    // Liste lue en une fois : une boucle for sur la requête lirait par paquets de 200 (queryMore),
    // non supporté par EntityDefinition au-delà de 200 objets
    Map<String, EntityDefinition> entities = new Map<String, EntityDefinition>();
    List<EntityDefinition> customizable = [
      SELECT QualifiedApiName, Label, NamespacePrefix, IsCustomSetting
      FROM EntityDefinition
      WHERE IsCustomizable = TRUE
      WITH USER_MODE
      LIMIT 2000
    ];
    for (EntityDefinition entity : customizable) {
      if (!entity.IsCustomSetting) {
        entities.put(entity.QualifiedApiName, entity);
      }
    }
    if (countSource == null) {
      countSource = 'SOQL COUNT()';
      Integer queries = 0;
      List<String> capped = new List<String>();
      List<String> names = new List<String>(entities.keySet());
      names.sort();
      for (String name : names) {
        // Chaque enregistrement compté par COUNT() s'impute sur la limite de lignes de la
        // transaction (LimitException non interceptable) : LIMIT borné aux lignes restantes
        Integer rowsLeft =
          Limits.getLimitQueryRows() -
          Limits.getQueryRows() -
          RESERVED_QUERY_ROWS;
        if (
          queries >= FALLBACK_OBJECTS ||
          rowsLeft < MIN_COUNT_ROWS ||
          Limits.getQueries() > Limits.getLimitQueries() - 20
        ) {
          ctx.warning(
            'Record counts limited to ' +
              queries +
              ' objects without the Tooling API connection.'
          );
          break;
        }
        try {
          Integer count = Database.countQuery(
            'SELECT COUNT() FROM ' +
              String.escapeSingleQuotes(name) +
              ' LIMIT ' +
              rowsLeft,
            AccessLevel.USER_MODE
          );
          counts.put(name, count);
          if (count >= rowsLeft) {
            capped.add(name);
          }
        } catch (Exception e) {
          // objet non interrogeable avec les droits de l'utilisateur
          System.debug(LoggingLevel.FINE, e.getMessage());
        }
        queries++;
      }
      if (!capped.isEmpty()) {
        ctx.warning(
          'Record counts are lower bounds for ' +
            String.join(capped, ', ') +
            ' (query row limit reached without the Tooling API connection).'
        );
      }
    }

    // 2. Objets : taille estimée
    Map<String, System.OrgLimit> limits = OrgLimits.getMap();
    Integer dataUsed = limits.containsKey('DataStorageMB')
      ? limits.get('DataStorageMB').getValue()
      : null;
    Integer dataMax = limits.containsKey('DataStorageMB')
      ? limits.get('DataStorageMB').getLimit()
      : null;
    Integer fileUsed = limits.containsKey('FileStorageMB')
      ? limits.get('FileStorageMB').getValue()
      : null;
    Integer fileMax = limits.containsKey('FileStorageMB')
      ? limits.get('FileStorageMB').getLimit()
      : null;

    List<Map<String, Object>> objects = new List<Map<String, Object>>();
    Decimal estimatedTotalMb = 0;
    for (String name : counts.keySet()) {
      EntityDefinition entity = entities.get(name);
      Integer count = counts.get(name);
      if (entity == null || count == null || count == 0) {
        continue;
      }
      Decimal sizeMb = (Decimal.valueOf(count) *
        (RECORD_SIZE_KB.containsKey(name) ? RECORD_SIZE_KB.get(name) : 2) /
        1024)
        .setScale(2);
      estimatedTotalMb += sizeMb;
      objects.add(
        new Map<String, Object>{
          'name' => name,
          'label' => entity.Label,
          'custom' => name.endsWith('__c'),
          'managed' => entity.NamespacePrefix != null,
          'count' => count,
          'sizeMb' => sizeMb
        }
      );
    }

    // 3. Fichiers
    Map<String, Object> files = loadFiles(ctx);

    // 4. Règles
    evaluate(
      ctx,
      dataUsed,
      dataMax,
      fileUsed,
      fileMax,
      objects,
      estimatedTotalMb,
      files,
      counts
    );

    // 5. Photographie du scan
    Map<String, Object> snapshot = new Map<String, Object>{
      'countSource' => countSource,
      'estimatedDataMb' => estimatedTotalMb,
      'objects' => objects,
      'files' => files
    };
    // Photographie limitée : le navigateur la garde avec le scan
    while (objects.size() > 300) {
      objects.remove(objects.size() - 1);
    }
    ctx.setScanValue(
      'storage',
      new Map<String, Object>{
        'dataUsedMb' => dataUsed,
        'dataMaxMb' => dataMax,
        'fileUsedMb' => fileUsed,
        'fileMaxMb' => fileMax,
        'snapshot' => snapshot
      }
    );
    ctx.info(
      'Storage: data ' +
        dataUsed +
        ' / ' +
        dataMax +
        ' MB, files ' +
        fileUsed +
        ' / ' +
        fileMax +
        ' MB; ' +
        objects.size() +
        ' objects with records (' +
        countSource +
        ').'
    );
    return null;
  }

  private static Map<String, Object> loadFiles(OrgScanContext ctx) {
    Map<String, Object> files = new Map<String, Object>();
    try {
      List<Map<String, Object>> byType = new List<Map<String, Object>>();
      for (AggregateResult row : [
        SELECT FileType type, COUNT(Id) total, SUM(ContentSize) size
        FROM ContentVersion
        WHERE IsLatest = TRUE
        WITH USER_MODE
        GROUP BY FileType
        ORDER BY SUM(ContentSize) DESC
        LIMIT 20
      ]) {
        byType.add(
          new Map<String, Object>{
            'type' => row.get('type') == null ? 'Unknown' : row.get('type'),
            'count' => row.get('total'),
            'sizeMb' => toMb(row.get('size'))
          }
        );
      }
      files.put('byType', byType);

      AggregateResult latest = [
        SELECT COUNT(Id) total, SUM(ContentSize) size
        FROM ContentVersion
        WHERE IsLatest = TRUE
        WITH USER_MODE
      ];
      files.put('fileCount', latest.get('total'));
      files.put('fileSizeMb', toMb(latest.get('size')));
      AggregateResult old = [
        SELECT COUNT(Id) total, SUM(ContentSize) size
        FROM ContentVersion
        WHERE IsLatest = FALSE
        WITH USER_MODE
      ];
      files.put('oldVersionCount', old.get('total'));
      files.put('oldVersionSizeMb', toMb(old.get('size')));

      List<Map<String, Object>> largest = new List<Map<String, Object>>();
      for (ContentVersion version : [
        SELECT
          Title,
          FileExtension,
          ContentSize,
          CreatedDate,
          ContentDocumentId,
          Owner.Name
        FROM ContentVersion
        WHERE IsLatest = TRUE
        WITH USER_MODE
        ORDER BY ContentSize DESC
        LIMIT 15
      ]) {
        largest.add(
          new Map<String, Object>{
            'title' => version.Title,
            'extension' => version.FileExtension,
            'sizeMb' => toMb(version.ContentSize),
            'createdDate' => version.CreatedDate,
            'documentId' => version.ContentDocumentId,
            'owner' => version.Owner?.Name
          }
        );
      }
      files.put('largest', largest);
    } catch (Exception e) {
      ctx.warning('Files not analysed: ' + e.getMessage().abbreviate(150));
    }
    try {
      AggregateResult attachments = [
        SELECT COUNT(Id) total, SUM(BodyLength) size
        FROM Attachment
        WITH USER_MODE
      ];
      files.put('attachmentCount', attachments.get('total'));
      files.put('attachmentSizeMb', toMb(attachments.get('size')));
    } catch (Exception e) {
      files.put('attachmentCount', null);
    }
    return files;
  }

  private static Decimal toMb(Object bytes) {
    return bytes == null
      ? 0
      : (Decimal.valueOf(String.valueOf(bytes)) / 1048576).setScale(2);
  }

  private static void evaluate(
    OrgScanContext ctx,
    Integer dataUsed,
    Integer dataMax,
    Integer fileUsed,
    Integer fileMax,
    List<Map<String, Object>> objects,
    Decimal estimatedTotalMb,
    Map<String, Object> files,
    Map<String, Integer> counts
  ) {
    if (
      ctx.beginRule('STORAGE_DATA_NEAR_LIMIT') &&
      dataMax != null &&
      dataMax > 0
    ) {
      Decimal percent = 100.0 * dataUsed / dataMax;
      Decimal threshold = ctx.threshold('STORAGE_DATA_NEAR_LIMIT', 80);
      if (percent >= threshold) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'STORAGE_DATA_NEAR_LIMIT',
          'CustomObject',
          'Data storage',
          'Data storage is ' + percent.setScale(0) + '% full'
        );
        finding.evidence =
          dataUsed +
          ' MB used of ' +
          dataMax +
          ' MB (threshold ' +
          threshold +
          '%).';
        ctx.addFinding(finding);
      }
    }
    if (
      ctx.beginRule('STORAGE_FILE_NEAR_LIMIT') &&
      fileMax != null &&
      fileMax > 0
    ) {
      Decimal percent = 100.0 * fileUsed / fileMax;
      Decimal threshold = ctx.threshold('STORAGE_FILE_NEAR_LIMIT', 80);
      if (percent >= threshold) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'STORAGE_FILE_NEAR_LIMIT',
          'CustomObject',
          'File storage',
          'File storage is ' + percent.setScale(0) + '% full'
        );
        finding.evidence =
          fileUsed +
          ' MB used of ' +
          fileMax +
          ' MB (threshold ' +
          threshold +
          '%).';
        ctx.addFinding(finding);
      }
    }
    if (ctx.beginRule('STORAGE_LARGE_OBJECT') && estimatedTotalMb > 0) {
      Decimal threshold = ctx.threshold('STORAGE_LARGE_OBJECT', 20);
      for (Map<String, Object> item : objects) {
        Decimal share = 100 * (Decimal) item.get('sizeMb') / estimatedTotalMb;
        if (share >= threshold && (Decimal) item.get('sizeMb') >= 10) {
          OrgScanModels.Finding finding = ctx.newFinding(
            'STORAGE_LARGE_OBJECT',
            'CustomObject',
            (String) item.get('name'),
            item.get('name') +
              ' holds about ' +
              share.setScale(0) +
              '% of the data storage'
          );
          finding.evidence =
            item.get('count') +
            ' records, about ' +
            item.get('sizeMb') +
            ' MB (estimate: 2 KB per record) out of ' +
            estimatedTotalMb.setScale(0) +
            ' MB estimated for all objects.';
          ctx.addFinding(finding);
        }
      }
    }
    if (ctx.beginRule('STORAGE_LOG_OBJECT_GROWTH')) {
      Decimal threshold = ctx.threshold('STORAGE_LOG_OBJECT_GROWTH', 10000);
      for (Map<String, Object> item : objects) {
        String name = (String) item.get('name');
        if (
          (Boolean) item.get('custom') &&
          (Integer) item.get('count') >= threshold &&
          LOG_LIKE.matcher(name).find()
        ) {
          OrgScanModels.Finding finding = ctx.newFinding(
            'STORAGE_LOG_OBJECT_GROWTH',
            'CustomObject',
            name,
            name + ' keeps ' + item.get('count') + ' records'
          );
          finding.evidence =
            'Technical object (log, history, snapshot…) with ' +
            item.get('count') +
            ' records, about ' +
            item.get('sizeMb') +
            ' MB. Threshold: ' +
            threshold.setScale(0) +
            ' records.';
          ctx.addFinding(finding);
        }
      }
    }
    if (ctx.beginRule('STORAGE_OLD_FILE_VERSIONS')) {
      Decimal threshold = ctx.threshold('STORAGE_OLD_FILE_VERSIONS', 100);
      Decimal oldSize = (Decimal) files.get('oldVersionSizeMb');
      if (oldSize != null && oldSize >= threshold) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'STORAGE_OLD_FILE_VERSIONS',
          'CustomObject',
          'File versions',
          'Old file versions use ' + oldSize.setScale(0) + ' MB'
        );
        finding.evidence =
          files.get('oldVersionCount') +
          ' previous versions of files, ' +
          oldSize +
          ' MB (threshold ' +
          threshold +
          ' MB).';
        ctx.addFinding(finding);
      }
    }
    if (ctx.beginRule('STORAGE_LARGE_FILES')) {
      Decimal threshold = ctx.threshold('STORAGE_LARGE_FILES', 25);
      List<String> large = new List<String>();
      for (
        Object raw : (List<Object>) (files.containsKey('largest')
          ? files.get('largest')
          : new List<Object>())
      ) {
        Map<String, Object> file = (Map<String, Object>) raw;
        if ((Decimal) file.get('sizeMb') >= threshold) {
          large.add(file.get('title') + ' (' + file.get('sizeMb') + ' MB)');
        }
      }
      if (!large.isEmpty()) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'STORAGE_LARGE_FILES',
          'CustomObject',
          'Large files',
          large.size() + ' files larger than ' + threshold.setScale(0) + ' MB'
        );
        finding.evidence = String.join(large, '\n');
        ctx.addFinding(finding);
      }
    }
    if (ctx.beginRule('STORAGE_ACTIVITY_VOLUME')) {
      Decimal threshold = ctx.threshold('STORAGE_ACTIVITY_VOLUME', 100000);
      Integer total = 0;
      List<String> parts = new List<String>();
      for (String name : ACTIVITY_OBJECTS) {
        if (counts.containsKey(name)) {
          total += counts.get(name);
          parts.add(name + ': ' + counts.get(name));
        }
      }
      if (total >= threshold) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'STORAGE_ACTIVITY_VOLUME',
          'CustomObject',
          'Activities',
          total + ' activity and email records'
        );
        finding.evidence =
          String.join(parts, ', ') +
          ' (threshold ' +
          threshold.setScale(0) +
          ').';
        ctx.addFinding(finding);
      }
    }
  }
}
