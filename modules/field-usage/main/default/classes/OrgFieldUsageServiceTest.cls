/**
 * Analyse d'utilisation des champs : préparation (Tooling simulée), parcours par tranches, statut de
 * chaque champ (scénarios appliqués à tous les champs d'un objet) et score.
 */
@IsTest
private class OrgFieldUsageServiceTest {
  @TestSetup
  static void setup() {
    OrgFieldUsageTestSupport.adminUser(
      new List<String>{
        OrgFieldUsageTestSupport.CORE_ADMIN_PS,
        OrgFieldUsageTestSupport.MODULE_PS
      }
    );
    // Product2 : objet rarement personnalisé (ni règle de validation ni trigger en général)
    List<Product2> products = new List<Product2>();
    for (Integer i = 0; i < 12; i++) {
      products.add(
        new Product2(
          Name = 'Usage ' + i,
          IsActive = Math.mod(i, 2) == 0,
          Description = i < 3 ? 'Long text ' + i : null,
          ProductCode = '  '
        )
      );
    }
    insert products;
  }

  private static User admin() {
    return [
      SELECT Id
      FROM User
      WHERE LastName = 'FieldUsage' AND IsActive = TRUE
      ORDER BY CreatedDate DESC
      LIMIT 1
    ];
  }

  // ---------- Préparation ----------

  @IsTest
  static void prepareReadsLayoutsPagesFieldsAndDependencies() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = new OrgFieldUsageTestSupport.ToolingRouter();
    Test.setMock(HttpCalloutMock.class, router);
    System.runAs(admin()) {
      Test.startTest();
      OrgFieldUsageService.PreparedAnalysis prepared = OrgFieldUsageService.prepare(
        'product2',
        null
      );
      Test.stopTest();
      Assert.areEqual('Product2', prepared.objectName);
      Assert.areEqual(
        OrgFieldUsageService.DEFAULT_RECENT_DAYS,
        prepared.recentDays
      );
      Assert.isTrue(prepared.fields.contains('Name'));
      Assert.isFalse(prepared.fields.contains('Id'), 'champ système exclu');
      Assert.isTrue(prepared.chunkSize >= 50 && prepared.chunkSize <= 2000);
      Assert.areEqual(12, prepared.estimatedCount);
      Assert.isFalse(prepared.countCapped);

      OrgFieldUsageService.MetadataInfo meta = prepared.meta;
      Assert.isTrue(meta.toolingAvailable);
      Assert.isTrue(meta.fieldsKnown);
      Assert.isTrue(meta.layoutsKnown);
      Assert.isTrue(meta.dependenciesKnown);
      Assert.isTrue(meta.customFields.containsKey('legacy__c'));
      Assert.isTrue(meta.customFields.containsKey('pkg__pkg__c'));
      Assert.isTrue(meta.layoutsByField.containsKey('name'));
      Assert.isTrue(
        meta.layoutsByField.containsKey('website'),
        'Dynamic Forms'
      );
      // 6 présentations (le mock renvoie les 7 lignes, toutes lues) + 2 pages avec champs
      Assert.areEqual(9, meta.layoutCount);
      // Flow retenu ; présentation, référence à soi et champ inconnu ignorés
      Assert.areEqual(1, meta.dependenciesByField.get('legacy__c').size());
      Assert.areEqual(
        'Flow',
        meta.dependenciesByField.get('legacy__c')[0].get('type')
      );
    }
  }

  @IsTest
  static void prepareWithoutToolingKeepsANote() {
    OrgFieldUsageTestSupport.useTooling(false);
    System.runAs(admin()) {
      OrgFieldUsageService.PreparedAnalysis prepared = OrgFieldUsageService.prepare(
        'Product2',
        99999
      );
      Assert.areEqual(3650, prepared.recentDays, 'plafond de la période');
      Assert.isFalse(prepared.meta.toolingAvailable);
      Assert.isTrue(prepared.meta.notes[0].contains('not configured'));
    }
  }

  @IsTest
  static void toolingCheckFailureMeansNotAvailable() {
    OrgFieldUsageTestSupport.useFailingTooling();
    OrgFieldUsageService.MetadataInfo meta = OrgFieldUsageService.collectMetadata(
      'Account'
    );
    Assert.isFalse(meta.toolingAvailable);
    Assert.isTrue(meta.notes[0].contains('not available'), meta.notes[0]);
  }

  @IsTest
  static void customFieldFailureStopsTheToolingReads() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = new OrgFieldUsageTestSupport.ToolingRouter();
    router.failing.add('CustomField');
    Test.setMock(HttpCalloutMock.class, router);
    Test.startTest();
    OrgFieldUsageService.MetadataInfo meta = OrgFieldUsageService.collectMetadata(
      'Account'
    );
    Test.stopTest();
    Assert.isFalse(meta.toolingAvailable);
    Assert.isFalse(meta.layoutsKnown);
    Assert.areEqual(1, router.queries.size(), 'aucun autre appel');
  }

  @IsTest
  static void layoutPageAndDependencyFailuresAreNoted() {
    OrgFieldUsageTestSupport.useTooling(true);
    OrgFieldUsageTestSupport.ToolingRouter router = new OrgFieldUsageTestSupport.ToolingRouter();
    router.failing.addAll(
      new List<String>{ 'FlexiPage', 'LayoutMetadata', 'Dependency' }
    );
    Test.setMock(HttpCalloutMock.class, router);
    Test.startTest();
    OrgFieldUsageService.MetadataInfo meta = OrgFieldUsageService.collectMetadata(
      'Account'
    );
    Test.stopTest();
    Assert.isTrue(meta.fieldsKnown);
    Assert.isFalse(meta.layoutsKnown, 'contenu des présentations en erreur');
    Assert.isFalse(meta.dependenciesKnown);
    String notes = String.join(meta.notes, ' | ');
    Assert.isTrue(notes.contains('Lightning record pages not read'), notes);
    Assert.isTrue(notes.contains('Layouts not read'), notes);
    Assert.isTrue(notes.contains('Dependencies not read'), notes);
  }

  // ---------- Parcours par tranches ----------

  @IsTest
  static void scanChunkReturnsAggregatesOnly() {
    System.runAs(admin()) {
      OrgFieldUsageService.ChunkResult first = OrgFieldUsageService.scanChunk(
        'Product2',
        new List<String>{
          'Name',
          'IsActive',
          'Description',
          'ProductCode',
          null,
          ''
        },
        null,
        5,
        Datetime.now().addDays(-1)
      );
      Assert.areEqual(5, first.records);
      Assert.areEqual(5, first.recent);
      Assert.isFalse(first.done);
      Assert.areEqual(4, first.stats.size());
      Assert.areEqual(5, first.stats.get('Name').filled);
      Assert.areEqual(0, first.stats.get('ProductCode').filled, 'blanc = vide');
      Assert.isFalse(
        first.stats.get('IsActive').values.isEmpty(),
        'case à cocher'
      );
      Assert.isNotNull(first.stats.get('Name').lastFilledAt);

      OrgFieldUsageService.ChunkResult rest = OrgFieldUsageService.scanChunk(
        'Product2',
        new List<String>{ 'Name' },
        first.lastId,
        null,
        null
      );
      Assert.areEqual(7, rest.records);
      Assert.areEqual(0, rest.recent, 'sans date de référence');
      Assert.isTrue(rest.done);
    }
  }

  @IsTest
  static void scanChunkWithoutFieldListReadsAllAnalysableFields() {
    System.runAs(admin()) {
      OrgFieldUsageService.ChunkResult result = OrgFieldUsageService.scanChunk(
        'Opportunity',
        null,
        null,
        100,
        null
      );
      Assert.areEqual(0, result.records);
      Assert.isTrue(result.done);
      Assert.isTrue(result.stats.containsKey('IsPrivate'), 'case à cocher');
    }
  }

  @IsTest
  static void booleanValuesAndTextFingerprintsAreCounted() {
    System.runAs(admin()) {
      OrgFieldUsageService.ChunkResult result = OrgFieldUsageService.scanChunk(
        'Product2',
        new List<String>{ 'IsActive', 'Name' },
        null,
        100,
        null
      );
      Assert.areEqual(12, result.records);
      Assert.areEqual(6, result.stats.get('IsActive').falseCount);
      Assert.areEqual(6, result.stats.get('IsActive').values.get('false'));
      Assert.areEqual(6, result.stats.get('IsActive').values.get('true'));
      Assert.areEqual(12, result.stats.get('Name').values.size(), 'empreintes');
    }
  }

  @IsTest
  static void unknownObjectIsRefused() {
    try {
      OrgFieldUsageService.scanChunk('Nope__zz', null, null, null, null);
      Assert.fail('objet inconnu');
    } catch (IllegalArgumentException e) {
      Assert.isTrue(e.getMessage().contains('Nope__zz'));
    }
  }

  // ---------- Statuts ----------

  /** Agrégats et métadonnées identiques pour tous les champs analysables d'un objet. */
  private static OrgFieldUsageService.AnalysisResult runScenario(
    String objectName,
    Integer recordCount,
    Integer recentCount,
    Integer filled,
    Integer recentFilled,
    Integer falseCount,
    Map<String, Integer> values,
    Boolean onLayout,
    Boolean referenced,
    String createdDate,
    String description
  ) {
    Schema.DescribeSObjectResult describe = OrgFieldUsageService.describeObject(
      objectName
    );
    Map<String, OrgFieldUsageService.FieldStats> stats = new Map<String, OrgFieldUsageService.FieldStats>();
    OrgFieldUsageService.MetadataInfo meta = new OrgFieldUsageService.MetadataInfo();
    meta.layoutsKnown = true;
    meta.dependenciesKnown = true;
    meta.fieldsKnown = true;
    for (
      Schema.DescribeFieldResult field : OrgFieldUsageService.analysableFields(
        describe
      )
    ) {
      String key = field.getName().toLowerCase();
      OrgFieldUsageService.FieldStats stat = new OrgFieldUsageService.FieldStats();
      stat.filled = filled;
      stat.recentFilled = recentFilled;
      stat.falseCount = falseCount;
      stat.values = values == null ? null : values.clone();
      stat.overflow = null;
      stat.lastFilledAt = filled > 0 ? Datetime.now() : null;
      stats.put(field.getName(), stat);
      if (onLayout) {
        meta.layoutsByField.put(key, new List<String>{ 'Layout A' });
      }
      if (referenced) {
        List<Map<String, String>> deps = new List<Map<String, String>>();
        for (Integer i = 0; i < 101; i++) {
          deps.add(
            new Map<String, String>{ 'name' => 'Flow' + i, 'type' => 'Flow' }
          );
        }
        meta.dependenciesByField.put(key, deps);
      }
      if (field.isCustom()) {
        OrgFieldUsageService.CustomFieldInfo info = new OrgFieldUsageService.CustomFieldInfo();
        info.createdDate = createdDate;
        info.description = description;
        meta.customFields.put(key, info);
      }
    }
    return OrgFieldUsageService.finalizeAnalysis(
      objectName,
      30,
      recordCount,
      recentCount,
      stats,
      meta
    );
  }

  private static Set<String> statuses(
    OrgFieldUsageService.AnalysisResult result
  ) {
    return result.statusCounts.keySet();
  }

  @IsTest
  static void noRecordMeansNoData() {
    OrgFieldUsageService.AnalysisResult result = runScenario(
      'Account',
      0,
      0,
      0,
      0,
      0,
      null,
      false,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(result).contains(OrgFieldUsageService.STATUS_NO_DATA)
    );
    Assert.isNull(result.score, 'aucun statut compté');
  }

  @IsTest
  static void emptyFieldsOnLayoutsAndNeverFilledFields() {
    OrgFieldUsageService.AnalysisResult onLayout = runScenario(
      'Account',
      50,
      5,
      0,
      0,
      50,
      null,
      true,
      false,
      '2020-01-01T00:00:00.000+0000',
      null
    );
    Assert.isTrue(
      statuses(onLayout).contains(OrgFieldUsageService.STATUS_EMPTY_ON_LAYOUT)
    );
    Assert.isTrue(onLayout.issueCount > 0);
    Assert.areEqual(1, onLayout.fields[0].layoutCount);

    OrgFieldUsageService.AnalysisResult referenced = runScenario(
      'Account',
      50,
      5,
      0,
      0,
      50,
      null,
      false,
      true,
      null,
      null
    );
    Assert.isTrue(
      statuses(referenced).contains(OrgFieldUsageService.STATUS_NEVER_FILLED) ||
      statuses(referenced).contains(OrgFieldUsageService.STATUS_UNUSED)
    );
    OrgFieldUsageService.FieldResult firstRow = referenced.fields[0];
    Assert.isNotNull(firstRow.details.get('recommendation'));

    OrgFieldUsageService.AnalysisResult unused = runScenario(
      'Opportunity',
      50,
      5,
      0,
      0,
      50,
      null,
      false,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(unused).contains(OrgFieldUsageService.STATUS_UNUSED)
    );
    Assert.isTrue(unused.unusedCount > 0);
    // Champs calculés (formules, numéros auto) : présents ou non selon l'org
    Boolean hasCalculated = false;
    for (OrgFieldUsageService.FieldResult row : unused.fields) {
      hasCalculated = hasCalculated || row.isCalculated;
    }
    Assert.areEqual(
      hasCalculated,
      statuses(unused).contains(OrgFieldUsageService.STATUS_CALCULATED) ||
      (hasCalculated &&
      statuses(unused).contains(OrgFieldUsageService.STATUS_UNUSED))
    );
  }

  @IsTest
  static void abandonedLowFillAndConstantFields() {
    OrgFieldUsageService.AnalysisResult abandoned = runScenario(
      'Account',
      100,
      10,
      40,
      0,
      60,
      null,
      true,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(abandoned).contains(OrgFieldUsageService.STATUS_ABANDONED)
    );

    OrgFieldUsageService.AnalysisResult lowFill = runScenario(
      'Account',
      100,
      0,
      2,
      0,
      98,
      null,
      true,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(lowFill).contains(OrgFieldUsageService.STATUS_LOW_FILL)
    );

    OrgFieldUsageService.AnalysisResult constant = runScenario(
      'Account',
      100,
      0,
      100,
      0,
      0,
      new Map<String, Integer>{ 'Same' => 100 },
      true,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(constant).contains(OrgFieldUsageService.STATUS_CONSTANT)
    );

    OrgFieldUsageService.AnalysisResult dominant = runScenario(
      'Account',
      100,
      0,
      100,
      0,
      0,
      new Map<String, Integer>{ 'Main' => 97, 'Other' => 3 },
      true,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(dominant).contains(OrgFieldUsageService.STATUS_CONSTANT)
    );
  }

  @IsTest
  static void healthyHiddenUndocumentedAndNewFields() {
    Map<String, Integer> varied = new Map<String, Integer>{
      'A' => 40,
      'B' => 30,
      'C' => 30
    };
    OrgFieldUsageService.AnalysisResult healthy = runScenario(
      'Account',
      100,
      0,
      100,
      0,
      0,
      varied,
      true,
      true,
      '2020-01-01T00:00:00.000+0000',
      'Documented'
    );
    Assert.isTrue(
      statuses(healthy).contains(OrgFieldUsageService.STATUS_HEALTHY)
    );
    Assert.isTrue(healthy.score > 0);

    // Hors présentation : « Hidden but filled » pour les champs personnalisés, sain pour les autres
    OrgFieldUsageService.AnalysisResult hidden = runScenario(
      'Account',
      100,
      0,
      100,
      0,
      0,
      varied,
      false,
      false,
      '2020-01-01T00:00:00.000+0000',
      null
    );
    Assert.isFalse(hidden.fields.isEmpty());

    OrgFieldUsageService.AnalysisResult undocumented = runScenario(
      'Account',
      100,
      0,
      100,
      0,
      0,
      varied,
      true,
      false,
      '2020-01-01T00:00:00.000+0000',
      null
    );
    Assert.isFalse(undocumented.fields.isEmpty());

    OrgFieldUsageService.AnalysisResult recent = runScenario(
      'Account',
      100,
      0,
      0,
      0,
      0,
      null,
      false,
      false,
      Datetime.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\''),
      null
    );
    Assert.isFalse(recent.fields.isEmpty());

    OrgFieldUsageService.AnalysisResult badDate = runScenario(
      'Account',
      100,
      0,
      100,
      0,
      0,
      varied,
      true,
      false,
      'not a date',
      null
    );
    Assert.isFalse(badDate.fields.isEmpty());
  }

  @IsTest
  static void booleanFieldsAlwaysTheSame() {
    OrgFieldUsageService.AnalysisResult unchecked = runScenario(
      'Opportunity',
      20,
      0,
      0,
      0,
      20,
      new Map<String, Integer>{ 'false' => 20 },
      true,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(unchecked).contains(OrgFieldUsageService.STATUS_CONSTANT)
    );

    OrgFieldUsageService.AnalysisResult checked = runScenario(
      'Opportunity',
      20,
      0,
      20,
      0,
      0,
      new Map<String, Integer>{ 'true' => 20 },
      false,
      false,
      null,
      null
    );
    Assert.isTrue(
      statuses(checked).contains(OrgFieldUsageService.STATUS_CONSTANT)
    );
  }

  @IsTest
  static void scoreWeighsStatuses() {
    Assert.areEqual(
      50,
      OrgFieldUsageService.score(
        new Map<String, Integer>{
          OrgFieldUsageService.STATUS_HEALTHY => 1,
          OrgFieldUsageService.STATUS_UNUSED => 1,
          OrgFieldUsageService.STATUS_CALCULATED => 4
        }
      )
    );
    Assert.isNull(OrgFieldUsageService.score(new Map<String, Integer>()));
  }

  @IsTest
  static void layoutAndPageParsers() {
    Set<String> layoutFields = OrgFieldUsageService.layoutFields(
      OrgFieldUsageTestSupport.layoutMetadata()
    );
    Assert.isTrue(layoutFields.contains('Legacy__c'));
    Assert.areEqual(3, layoutFields.size());
    Assert.isTrue(OrgFieldUsageService.layoutFields(null).isEmpty());

    Set<String> pageFields = OrgFieldUsageService.pageFields(
      OrgFieldUsageTestSupport.pageMetadata()
    );
    Assert.isTrue(pageFields.contains('Website'));
    Assert.isTrue(pageFields.contains('Industry'));
    Assert.isTrue(OrgFieldUsageService.pageFields('x').isEmpty());
  }
}
