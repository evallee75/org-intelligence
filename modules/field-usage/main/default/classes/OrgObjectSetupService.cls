/**
 * Analyse de la configuration d'un objet (onglet « Object setup » de l'écran Objects & Fields),
 * en lecture seule et sans objet personnalisé : types d'enregistrement, présentations de page et
 * leurs assignations (profil × type d'enregistrement), pages Lightning d'enregistrement (Dynamic
 * Forms, Dynamic Actions, composants), présentations compactes, résumé (champs, règles de
 * validation, triggers, flows, partage) et constats. Le résultat est gardé par le navigateur.
 *
 * Tous les callouts (Tooling, REST) passent avant toute écriture ; la seule écriture possible est
 * le journal API (module API Monitoring), vidé en fin d'appel. Sans Tooling : ce que SOQL et le
 * describe permettent de lire, plus une note « Tooling API needed ».
 */
public with sharing class OrgObjectSetupService {
  /** Pages Lightning dont le contenu est lu (une requête Metadata par page). */
  private static final Integer MAX_PAGES = 25;
  /** Présentations dont le contenu est lu (une requête Metadata par présentation). */
  private static final Integer MAX_LAYOUT_DETAILS = 20;
  /** Types d'enregistrement dont on vérifie l'usage (une requête LIMIT 1 chacun). */
  private static final Integer MAX_RECORD_TYPE_CHECKS = 40;
  private static final Integer CALLOUT_RESERVE = 2;
  /** Seuils des constats. */
  public static final Integer MANY_LAYOUTS = 5;
  public static final Integer FRAGMENTED_LAYOUTS = 3;
  public static final Integer HEAVY_PAGE_COMPONENTS = 25;

  public class SetupResult {
    public String objectName;
    public String objectLabel;
    public Boolean isCustom;
    public Datetime analyzedAt;
    public String orgDomainUrl;
    public Boolean toolingAvailable = false;
    public List<String> notes = new List<String>();
    public Summary summary = new Summary();
    public List<RecordTypeInfo> recordTypes = new List<RecordTypeInfo>();
    public List<LayoutInfo> layouts = new List<LayoutInfo>();
    public Boolean assignmentsKnown = false;
    public List<ProfileRow> profiles = new List<ProfileRow>();
    public Boolean pagesKnown = false;
    public List<PageInfo> pages = new List<PageInfo>();
    public Boolean compactKnown = false;
    public List<CompactInfo> compactLayouts = new List<CompactInfo>();
    public String defaultCompactLayout;
    public Boolean systemDefaultCompact;
    public List<Finding> findings = new List<Finding>();
    public Integer score;
  }

  public class Summary {
    public Integer fieldCount;
    public Integer customFieldCount;
    public Integer validationRules;
    public Integer activeValidationRules;
    public Integer triggers;
    public Integer activeTriggers;
    public Integer recordTriggeredFlows;
    public String internalSharing;
    public String externalSharing;
  }

  public class RecordTypeInfo {
    public String id;
    public String name;
    public String developerName;
    public String description;
    public Boolean isActive;
    public String businessProcess;
    /** Par défaut / disponible pour l'utilisateur qui lance l'analyse (describe). */
    public Boolean defaultForMe;
    public Boolean availableForMe;
    /** null = non vérifié. */
    public Boolean hasRecords;
    public Integer layoutCount;
  }

  public class LayoutInfo {
    public String id;
    public String name;
    public String namespacePrefix;
    public Datetime lastModifiedDate;
    public String lastModifiedBy;
    public Integer fieldCount;
    public Integer sectionCount;
    public Integer relatedListCount;
    /** Assignations profil × type d'enregistrement (null si non lues). */
    public Integer assignmentCount;
    public Integer profileCount;
    public Integer activeUserProfiles;
  }

  /** Une ligne de la matrice : un profil, et la présentation par type d'enregistrement. */
  public class ProfileRow {
    public String profileId;
    public String profileName;
    public Integer activeUsers = 0;
    /** Id du type d'enregistrement (ou « master ») → nom de la présentation. */
    public Map<String, String> layoutByRecordType = new Map<String, String>();
  }

  public class PageInfo {
    public String id;
    public String name;
    public String developerName;
    public String namespacePrefix;
    public Datetime lastModifiedDate;
    public Boolean detailsRead = false;
    public String template;
    public Boolean dynamicForms;
    public Integer fieldCount;
    public Boolean usesRecordDetail;
    public Boolean dynamicActions;
    public Integer componentCount;
    public Integer customComponentCount;
    public Integer tabCount;
    public Integer visibilityRules;
  }

  public class CompactInfo {
    public String id;
    public String name;
    public String developerName;
    public Boolean isDefault = false;
    public List<String> recordTypes = new List<String>();
  }

  public class Finding {
    public String key;
    public String severity;
    public String theme;
    public String title;
    public String element;
    public String elementId;
    public String advice;
  }

  private SetupResult result;
  private String objectName;
  private String tableId;
  private OrgToolingGateway tooling;
  private Map<String, Integer> activeUsersByProfile = new Map<String, Integer>();
  /** Présentation par type d'enregistrement (profils avec utilisateurs actifs), pour la fragmentation. */
  private Map<String, Set<String>> activeLayoutsByRecordType = new Map<String, Set<String>>();

  public static SetupResult analyze(String objectName) {
    return new OrgObjectSetupService().run(objectName);
  }

  private SetupResult run(String requested) {
    Schema.DescribeSObjectResult describe = OrgFieldUsageService.describeObject(
      String.isBlank(requested) ? '' : requested.trim()
    );
    if (!describe.isAccessible()) {
      throw OrgIntelAccess.error(
        'You do not have access to ' + describe.getName() + '.'
      );
    }
    objectName = describe.getName();
    result = new SetupResult();
    result.objectName = objectName;
    result.objectLabel = describe.getLabel();
    result.isCustom = describe.isCustom();
    result.analyzedAt = Datetime.now();
    result.orgDomainUrl = Url.getOrgDomainUrl().toExternalForm();

    readEntity();
    readActiveUsers();
    readRecordTypes(describe);
    readSummary(describe);

    // Callouts (Tooling, REST) : tous avant la moindre écriture
    tooling = OrgToolingGateway.getInstance();
    if (toolingReady()) {
      readLayouts();
      readAssignments();
      readPages();
      readCompactLayouts();
      readValidationRules();
    }
    checkRecordTypeUsage(describe);
    buildFindings();
    OrgApiLogger.flush();
    return result;
  }

  // ---------- Lecture SOQL / describe ----------

  private void readEntity() {
    List<EntityDefinition> entities = [
      SELECT DurableId, InternalSharingModel, ExternalSharingModel
      FROM EntityDefinition
      WHERE QualifiedApiName = :objectName
      LIMIT 1
    ];
    tableId = entities.isEmpty() ? objectName : entities[0].DurableId;
    if (!entities.isEmpty()) {
      result.summary.internalSharing = entities[0].InternalSharingModel;
      result.summary.externalSharing = entities[0].ExternalSharingModel;
    }
  }

  private void readActiveUsers() {
    try {
      for (AggregateResult row : [
        SELECT ProfileId, COUNT(Id) total
        FROM User
        WHERE IsActive = TRUE
        GROUP BY ProfileId
      ]) {
        activeUsersByProfile.put(
          (String) row.get('ProfileId'),
          (Integer) row.get('total')
        );
      }
    } catch (Exception e) {
      result.notes.add('Active users per profile not read: ' + e.getMessage());
    }
  }

  private void readRecordTypes(Schema.DescribeSObjectResult describe) {
    Map<Id, Schema.RecordTypeInfo> infos = describe.getRecordTypeInfosById();
    Map<Id, String> processNames = new Map<Id, String>();
    try {
      for (BusinessProcess process : [
        SELECT Id, Name
        FROM BusinessProcess
        WHERE TableEnumOrId = :objectName
      ]) {
        processNames.put(process.Id, process.Name);
      }
    } catch (Exception e) {
      // processus métier illisibles : colonne vide
      processNames.clear();
    }
    for (RecordType rt : [
      SELECT Id, Name, DeveloperName, Description, IsActive, BusinessProcessId
      FROM RecordType
      WHERE SobjectType = :objectName
      ORDER BY Name
    ]) {
      RecordTypeInfo info = new RecordTypeInfo();
      info.id = rt.Id;
      info.name = rt.Name;
      info.developerName = rt.DeveloperName;
      info.description = rt.Description;
      info.isActive = rt.IsActive;
      info.businessProcess = rt.BusinessProcessId == null
        ? null
        : processNames.get(rt.BusinessProcessId);
      Schema.RecordTypeInfo mine = infos.get(rt.Id);
      info.defaultForMe = mine != null && mine.isDefaultRecordTypeMapping();
      info.availableForMe = mine != null && mine.isAvailable();
      result.recordTypes.add(info);
    }
  }

  private void readSummary(Schema.DescribeSObjectResult describe) {
    Integer custom = 0;
    Map<String, Schema.SObjectField> fields = describe.fields.getMap();
    for (Schema.SObjectField field : fields.values()) {
      if (field.getDescribe().isCustom()) {
        custom++;
      }
    }
    result.summary.fieldCount = fields.size();
    result.summary.customFieldCount = custom;
    try {
      Integer total = 0;
      Integer active = 0;
      for (ApexTrigger t : [
        SELECT Status
        FROM ApexTrigger
        WHERE TableEnumOrId = :objectName
      ]) {
        total++;
        if (t.Status == 'Active') {
          active++;
        }
      }
      result.summary.triggers = total;
      result.summary.activeTriggers = active;
    } catch (Exception e) {
      result.notes.add('Triggers not read: ' + e.getMessage());
    }
    try {
      Integer flows = 0;
      for (FlowDefinitionView flow : [
        SELECT TriggerType
        FROM FlowDefinitionView
        WHERE
          TriggerObjectOrEventId IN (:tableId, :objectName)
          AND IsActive = TRUE
      ]) {
        if (String.valueOf(flow.TriggerType)?.startsWith('Record') == true) {
          flows++;
        }
      }
      result.summary.recordTriggeredFlows = flows;
    } catch (Exception e) {
      result.notes.add('Flows not read: ' + e.getMessage());
    }
  }

  // ---------- Tooling API ----------

  private Boolean toolingReady() {
    try {
      if (!tooling.isConfigured()) {
        result.notes.add(
          'Tooling API needed: layouts, assignments, Lightning pages, compact layouts and validation rules were not read.'
        );
        return false;
      }
    } catch (Exception e) {
      result.notes.add('Tooling API needed: ' + e.getMessage());
      return false;
    }
    return true;
  }

  private String table() {
    return String.escapeSingleQuotes(tableId);
  }

  private static Boolean calloutsLeft() {
    return Limits.getCallouts() < Limits.getLimitCallouts() - CALLOUT_RESERVE;
  }

  private void readLayouts() {
    List<Map<String, Object>> rows;
    try {
      rows = tooling.query(
        'SELECT Id, Name, LayoutType, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM Layout WHERE TableEnumOrId = \'' +
          table() +
          '\' ORDER BY Name'
      );
      result.toolingAvailable = true;
    } catch (Exception e) {
      result.notes.add(
        'Tooling API needed (' +
          e.getMessage().abbreviate(200) +
          '): layouts, assignments, Lightning pages and compact layouts were not read.'
      );
      return;
    }
    Integer skipped = 0;
    for (Map<String, Object> row : rows) {
      String type = (String) row.get('LayoutType');
      if (String.isNotBlank(type) && type != 'Standard') {
        continue;
      }
      LayoutInfo layout = new LayoutInfo();
      layout.id = (String) row.get('Id');
      layout.name = (String) row.get('Name');
      layout.namespacePrefix = (String) row.get('NamespacePrefix');
      layout.lastModifiedDate = toDatetime(row.get('LastModifiedDate'));
      layout.lastModifiedBy = OrgToolingGateway.getString(
        row,
        'LastModifiedBy.Name'
      );
      if (result.layouts.size() < MAX_LAYOUT_DETAILS && calloutsLeft()) {
        try {
          List<Map<String, Object>> meta = tooling.query(
            'SELECT Metadata FROM Layout WHERE Id = \'' + layout.id + '\''
          );
          if (!meta.isEmpty()) {
            describeLayout(layout, asMap(meta[0].get('Metadata')));
          }
        } catch (Exception e) {
          skipped++;
        }
      } else {
        skipped++;
      }
      result.layouts.add(layout);
    }
    if (skipped > 0) {
      result.notes.add(
        skipped + ' layout(s) not opened (limit): their field count is unknown.'
      );
    }
  }

  private static void describeLayout(
    LayoutInfo layout,
    Map<String, Object> metadata
  ) {
    Integer fields = 0;
    Integer sections = 0;
    for (Object section : asList(metadata.get('layoutSections'))) {
      sections++;
      for (Object column : asList(asMap(section).get('layoutColumns'))) {
        for (Object item : asList(asMap(column).get('layoutItems'))) {
          if (asMap(item).get('field') != null) {
            fields++;
          }
        }
      }
    }
    layout.fieldCount = fields;
    layout.sectionCount = sections;
    layout.relatedListCount = asList(metadata.get('relatedLists')).size();
  }

  private void readAssignments() {
    if (!result.toolingAvailable || !calloutsLeft()) {
      return;
    }
    List<Map<String, Object>> rows;
    try {
      rows = tooling.query(
        'SELECT ProfileId, Profile.Name, RecordTypeId, LayoutId FROM ProfileLayout WHERE TableEnumOrId = \'' +
          table() +
          '\''
      );
    } catch (Exception e) {
      result.notes.add(
        'Layout assignments not read: ' + e.getMessage().abbreviate(200)
      );
      return;
    }
    result.assignmentsKnown = true;
    Boolean hasRecordTypes = !result.recordTypes.isEmpty();
    Map<String, LayoutInfo> layoutById = new Map<String, LayoutInfo>();
    for (LayoutInfo layout : result.layouts) {
      layout.assignmentCount = 0;
      layout.profileCount = 0;
      layout.activeUserProfiles = 0;
      layoutById.put(layout.id, layout);
    }
    Map<String, ProfileRow> profiles = new Map<String, ProfileRow>();
    Map<String, Set<String>> profilesByLayout = new Map<String, Set<String>>();
    Map<String, Set<String>> layoutsByRecordType = new Map<String, Set<String>>();
    for (Map<String, Object> row : rows) {
      String recordTypeId = (String) row.get('RecordTypeId');
      // Avec des types d'enregistrement, l'assignation « Master » ne sert qu'aux profils sans type
      if (hasRecordTypes && String.isBlank(recordTypeId)) {
        continue;
      }
      String rtKey = String.isBlank(recordTypeId)
        ? 'master'
        : recordTypeId.left(15);
      String profileId = (String) row.get('ProfileId');
      String layoutId = (String) row.get('LayoutId');
      LayoutInfo layout = layoutById.get(layoutId);
      if (layout == null) {
        continue;
      }
      ProfileRow profile = profiles.get(profileId);
      if (profile == null) {
        profile = new ProfileRow();
        profile.profileId = profileId;
        profile.profileName = OrgToolingGateway.getString(row, 'Profile.Name');
        Integer users = activeUsersByProfile.get(profileId);
        if (users == null && profileId != null) {
          users = activeUsersByProfile.get(profileId.left(15));
        }
        profile.activeUsers = users == null ? 0 : users;
        profiles.put(profileId, profile);
      }
      profile.layoutByRecordType.put(rtKey, layout.name);
      layout.assignmentCount++;
      if (!profilesByLayout.containsKey(layoutId)) {
        profilesByLayout.put(layoutId, new Set<String>());
      }
      profilesByLayout.get(layoutId).add(profileId);
      if (!layoutsByRecordType.containsKey(rtKey)) {
        layoutsByRecordType.put(rtKey, new Set<String>());
      }
      layoutsByRecordType.get(rtKey).add(layoutId);
      if (profile.activeUsers > 0) {
        if (!activeLayoutsByRecordType.containsKey(rtKey)) {
          activeLayoutsByRecordType.put(rtKey, new Set<String>());
        }
        activeLayoutsByRecordType.get(rtKey).add(layoutId);
      }
    }
    for (LayoutInfo layout : result.layouts) {
      Set<String> profileIds = profilesByLayout.get(layout.id);
      if (profileIds == null) {
        continue;
      }
      layout.profileCount = profileIds.size();
      for (String profileId : profileIds) {
        if (profiles.get(profileId).activeUsers > 0) {
          layout.activeUserProfiles++;
        }
      }
    }
    for (RecordTypeInfo rt : result.recordTypes) {
      Set<String> layouts = layoutsByRecordType.get(rt.id.left(15));
      rt.layoutCount = layouts == null ? 0 : layouts.size();
    }
    // La Tooling API ne renvoie pas toujours Profile.Name : complément par SOQL
    Set<String> unnamed = new Set<String>();
    for (ProfileRow profile : profiles.values()) {
      if (profile.profileName == null && profile.profileId != null) {
        unnamed.add(profile.profileId);
      }
    }
    if (!unnamed.isEmpty()) {
      for (Profile p : [SELECT Id, Name FROM Profile WHERE Id IN :unnamed]) {
        for (ProfileRow profile : profiles.values()) {
          if (
            profile.profileId != null &&
            p.Id == Id.valueOf(profile.profileId)
          ) {
            profile.profileName = p.Name;
          }
        }
      }
    }
    for (ProfileRow profile : profiles.values()) {
      if (profile.profileName == null) {
        profile.profileName = 'Hidden profile ' + profile.profileId;
      }
    }
    List<ProfileRow> sorted = profiles.values();
    // Profils avec utilisateurs d'abord, puis par nom
    List<String> keys = new List<String>();
    Map<String, ProfileRow> byKey = new Map<String, ProfileRow>();
    for (ProfileRow profile : sorted) {
      String key =
        (profile.activeUsers > 0 ? '0' : '1') +
        (profile.profileName == null
          ? '~'
          : profile.profileName.toLowerCase()) +
        '|' +
        profile.profileId;
      keys.add(key);
      byKey.put(key, profile);
    }
    keys.sort();
    for (String key : keys) {
      result.profiles.add(byKey.get(key));
    }
  }

  private void readPages() {
    if (!result.toolingAvailable || !calloutsLeft()) {
      return;
    }
    List<Map<String, Object>> rows;
    try {
      rows = tooling.query(
        'SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM FlexiPage WHERE EntityDefinitionId = \'' +
          table() +
          '\' AND Type = \'RecordPage\' ORDER BY MasterLabel'
      );
    } catch (Exception e) {
      result.notes.add(
        'Lightning record pages not read: ' + e.getMessage().abbreviate(200)
      );
      return;
    }
    result.pagesKnown = true;
    Integer skipped = 0;
    for (Map<String, Object> row : rows) {
      PageInfo page = new PageInfo();
      page.id = (String) row.get('Id');
      page.name = (String) row.get('MasterLabel');
      page.developerName = (String) row.get('DeveloperName');
      page.namespacePrefix = (String) row.get('NamespacePrefix');
      page.lastModifiedDate = toDatetime(row.get('LastModifiedDate'));
      if (result.pages.size() < MAX_PAGES && calloutsLeft()) {
        try {
          List<Map<String, Object>> meta = tooling.query(
            'SELECT Metadata FROM FlexiPage WHERE Id = \'' + page.id + '\''
          );
          if (!meta.isEmpty()) {
            describePage(page, asMap(meta[0].get('Metadata')));
          }
        } catch (Exception e) {
          skipped++;
        }
      } else {
        skipped++;
      }
      result.pages.add(page);
    }
    if (skipped > 0) {
      result.notes.add(
        skipped +
        ' Lightning page(s) not opened (limit): their content is unknown.'
      );
    }
  }

  /**
   * Contenu d'une page : champs Dynamic Forms (fieldInstance), composant « Record Detail »
   * (force:detailPanel, présentation classique), Dynamic Actions (panneau de surbrillance
   * configuré : enableActionsConfiguration ou actionNames), composants, onglets, règles de visibilité.
   */
  @TestVisible
  private static void describePage(
    PageInfo page,
    Map<String, Object> metadata
  ) {
    Integer fields = 0;
    Integer components = 0;
    Integer customComponents = 0;
    Integer tabs = 0;
    Integer visibility = 0;
    Boolean fieldSection = false;
    Boolean detail = false;
    Boolean actions = false;
    for (Object region : asList(metadata.get('flexiPageRegions'))) {
      for (Object item : asList(asMap(region).get('itemInstances'))) {
        Map<String, Object> field = asMap(asMap(item).get('fieldInstance'));
        if (!field.isEmpty()) {
          fields++;
          if (field.get('visibilityRule') != null) {
            visibility++;
          }
          continue;
        }
        Map<String, Object> component = asMap(
          asMap(item).get('componentInstance')
        );
        String name = (String) component.get('componentName');
        if (String.isBlank(name)) {
          continue;
        }
        if (component.get('visibilityRule') != null) {
          visibility++;
        }
        if (name == 'flexipage:tab') {
          tabs++;
          continue;
        }
        if (name == 'flexipage:fieldSection') {
          fieldSection = true;
          continue;
        }
        if (name == 'flexipage:column' || name == 'flexipage:tabset') {
          continue;
        }
        components++;
        if (name.startsWith('c:') || !name.contains(':')) {
          customComponents++;
        }
        if (name == 'force:detailPanel') {
          detail = true;
        }
        if (name == 'force:highlightsPanel') {
          for (
            Object property : asList(
              component.get('componentInstanceProperties')
            )
          ) {
            Map<String, Object> p = asMap(property);
            if (
              (p.get('name') == 'enableActionsConfiguration' &&
              p.get('value') == 'true') ||
              (p.get('name') == 'actionNames' &&
              p.get('valueList') != null)
            ) {
              actions = true;
            }
          }
        }
      }
    }
    page.detailsRead = true;
    page.template = (String) asMap(metadata.get('template')).get('name');
    page.fieldCount = fields;
    page.dynamicForms = fields > 0 || fieldSection;
    page.usesRecordDetail = detail;
    page.dynamicActions = actions;
    page.componentCount = components;
    page.customComponentCount = customComponents;
    page.tabCount = tabs;
    page.visibilityRules = visibility;
  }

  private void readCompactLayouts() {
    if (!result.toolingAvailable || !calloutsLeft()) {
      return;
    }
    Map<String, CompactInfo> byId = new Map<String, CompactInfo>();
    try {
      for (
        Map<String, Object> row : tooling.query(
          'SELECT Id, DeveloperName, MasterLabel FROM CompactLayout WHERE SobjectType = \'' +
            table() +
            '\' ORDER BY MasterLabel'
        )
      ) {
        CompactInfo info = new CompactInfo();
        info.id = (String) row.get('Id');
        info.name = (String) row.get('MasterLabel');
        info.developerName = (String) row.get('DeveloperName');
        byId.put(info.id.left(15), info);
        result.compactLayouts.add(info);
      }
    } catch (Exception e) {
      result.notes.add(
        'Compact layouts not read: ' + e.getMessage().abbreviate(200)
      );
      return;
    }
    if (!calloutsLeft()) {
      return;
    }
    try {
      // Présentation compacte par défaut et par type d'enregistrement (API REST, describe)
      Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(
        tooling.getRest(
          '/sobjects/' +
            EncodingUtil.urlEncode(objectName, 'UTF-8') +
            '/describe/compactLayouts'
        )
      );
      String defaultId = (String) body.get('defaultCompactLayoutId');
      CompactInfo byDefault = String.isBlank(defaultId)
        ? null
        : byId.get(defaultId.left(15));
      result.systemDefaultCompact = byDefault == null;
      if (byDefault != null) {
        byDefault.isDefault = true;
        result.defaultCompactLayout = byDefault.name;
      } else {
        result.defaultCompactLayout = 'System Default';
      }
      for (
        Object mapping : asList(body.get('recordTypeCompactLayoutMappings'))
      ) {
        Map<String, Object> m = asMap(mapping);
        String id = (String) m.get('compactLayoutId');
        CompactInfo info = String.isBlank(id) ? null : byId.get(id.left(15));
        if (info != null && m.get('recordTypeName') != null) {
          info.recordTypes.add((String) m.get('recordTypeName'));
        }
      }
      result.compactKnown = true;
    } catch (Exception e) {
      result.notes.add(
        'Default compact layout not read: ' + e.getMessage().abbreviate(200)
      );
    }
  }

  private void readValidationRules() {
    if (!result.toolingAvailable || !calloutsLeft()) {
      return;
    }
    try {
      Integer total = 0;
      Integer active = 0;
      for (
        Map<String, Object> row : tooling.query(
          'SELECT Id, Active FROM ValidationRule WHERE EntityDefinitionId = \'' +
            table() +
            '\''
        )
      ) {
        total++;
        if (row.get('Active') == true) {
          active++;
        }
      }
      result.summary.validationRules = total;
      result.summary.activeValidationRules = active;
    } catch (Exception e) {
      result.notes.add(
        'Validation rules not read: ' + e.getMessage().abbreviate(200)
      );
    }
  }

  /** Après les callouts : un enregistrement existe-t-il pour chaque type d'enregistrement actif ? */
  private void checkRecordTypeUsage(Schema.DescribeSObjectResult describe) {
    if (!describe.isQueryable() || result.recordTypes.isEmpty()) {
      return;
    }
    Integer checked = 0;
    for (RecordTypeInfo rt : result.recordTypes) {
      if (checked >= MAX_RECORD_TYPE_CHECKS || Limits.getQueries() > 80) {
        break;
      }
      checked++;
      try {
        rt.hasRecords = !Database.query(
            'SELECT Id FROM ' +
              String.escapeSingleQuotes(objectName) +
              ' WHERE RecordTypeId = \'' +
              String.escapeSingleQuotes(rt.id) +
              '\' LIMIT 1',
            AccessLevel.USER_MODE
          )
          .isEmpty();
      } catch (Exception e) {
        rt.hasRecords = null;
      }
    }
  }

  // ---------- Constats ----------

  private void buildFindings() {
    Map<String, String> recordTypeNames = new Map<String, String>();
    for (RecordTypeInfo rt : result.recordTypes) {
      recordTypeNames.put(rt.id.left(15), rt.name);
      if (!rt.isActive) {
        add(
          'RT_INACTIVE',
          'Low',
          'Record types',
          'Inactive record type',
          rt.name,
          rt.id,
          rt.hasRecords == true
            ? 'Records still use it: move them to an active record type, then delete it.'
            : 'No record uses it: delete it to simplify assignments.'
        );
      } else {
        if (rt.hasRecords == false) {
          add(
            'RT_NO_RECORD',
            'Low',
            'Record types',
            'Active record type with no record',
            rt.name,
            rt.id,
            'Check that it is still needed, otherwise deactivate it.'
          );
        }
        if (String.isBlank(rt.description)) {
          add(
            'RT_NO_DESCRIPTION',
            'Info',
            'Record types',
            'Record type without description',
            rt.name,
            rt.id,
            'Describe when to use it: users and admins pick it more reliably.'
          );
        }
      }
    }

    if (result.toolingAvailable) {
      if (result.layouts.size() > MANY_LAYOUTS) {
        add(
          'MANY_LAYOUTS',
          'Medium',
          'Layouts',
          'Many page layouts (' + result.layouts.size() + ')',
          result.objectName,
          null,
          'Each layout is maintained separately: merge them, or use one Lightning page with Dynamic Forms and visibility rules.'
        );
      }
      if (result.assignmentsKnown) {
        for (LayoutInfo layout : result.layouts) {
          Boolean packaged = String.isNotBlank(layout.namespacePrefix);
          if (layout.assignmentCount == 0) {
            add(
              'LAYOUT_UNASSIGNED',
              packaged ? 'Info' : 'Medium',
              'Layouts',
              'Layout assigned to no profile',
              layout.name,
              layout.id,
              packaged
                ? 'Package layout: it cannot be deleted, nothing to do unless you need it.'
                : 'Nobody sees it: delete it, or assign it if it is still needed.'
            );
          } else if (layout.activeUserProfiles == 0) {
            add(
              'LAYOUT_NO_ACTIVE_USER',
              'Low',
              'Layouts',
              'Layout used only by profiles without active users',
              layout.name,
              layout.id,
              'Nobody uses it today: check whether it can be removed.'
            );
          }
        }
        for (String rtKey : activeLayoutsByRecordType.keySet()) {
          Integer distinct = activeLayoutsByRecordType.get(rtKey).size();
          if (distinct >= FRAGMENTED_LAYOUTS) {
            String rtName = rtKey == 'master'
              ? 'Master'
              : recordTypeNames.get(rtKey);
            add(
              'FRAGMENTED_ASSIGNMENTS',
              'Medium',
              'Assignments',
              'Profiles see ' + distinct + ' different layouts',
              rtName == null ? rtKey : rtName,
              rtKey == 'master' ? null : rtKey,
              'Users of the same record type see different pages: align the profiles on fewer layouts, or move the differences to visibility rules.'
            );
          }
        }
      }
    }

    if (result.pagesKnown) {
      if (result.pages.isEmpty()) {
        add(
          'NO_LIGHTNING_PAGE',
          'Low',
          'Lightning pages',
          'No Lightning record page',
          result.objectName,
          null,
          'Records use the default page built from the layout: a Lightning page lets you add Dynamic Forms, related information and visibility rules.'
        );
      }
      for (PageInfo page : result.pages) {
        if (!page.detailsRead) {
          continue;
        }
        if (page.dynamicForms != true && result.layouts.size() >= 2) {
          add(
            'PAGE_NO_DYNAMIC_FORMS',
            'Low',
            'Lightning pages',
            'Lightning page without Dynamic Forms while several layouts exist',
            page.name,
            page.id,
            'Dynamic Forms with visibility rules can replace several layouts (Upgrade Now in the Lightning App Builder).'
          );
        }
        if (page.componentCount > HEAVY_PAGE_COMPONENTS) {
          add(
            'HEAVY_PAGE',
            'Low',
            'Lightning pages',
            'Heavy Lightning page (' + page.componentCount + ' components)',
            page.name,
            page.id,
            'Many components slow the page down: move secondary ones to tabs or remove the unused ones.'
          );
        }
      }
    }

    if (result.compactKnown && result.systemDefaultCompact == true) {
      add(
        'SYSTEM_COMPACT_LAYOUT',
        'Low',
        'Compact layouts',
        'Only the system default compact layout',
        result.objectName,
        null,
        'Create a compact layout with the key fields: it drives the highlights panel and the mobile header.'
      );
    }
    if (result.compactKnown) {
      for (CompactInfo info : result.compactLayouts) {
        if (!info.isDefault && info.recordTypes.isEmpty()) {
          add(
            'COMPACT_UNUSED',
            'Info',
            'Compact layouts',
            'Compact layout used nowhere',
            info.name,
            info.id,
            'Neither default nor assigned to a record type: delete it if it is not needed.'
          );
        }
      }
    }

    Integer penalty = 0;
    for (Finding f : result.findings) {
      penalty += f.severity == 'High'
        ? 10
        : f.severity == 'Medium' ? 5 : f.severity == 'Low' ? 2 : 0;
    }
    result.score = Math.max(0, 100 - penalty);
  }

  private void add(
    String key,
    String severity,
    String theme,
    String title,
    String element,
    String elementId,
    String advice
  ) {
    Finding f = new Finding();
    f.key = key;
    f.severity = severity;
    f.theme = theme;
    f.title = title;
    f.element = element;
    f.elementId = elementId;
    f.advice = advice;
    result.findings.add(f);
  }

  // ---------- Outils ----------

  private static Datetime toDatetime(Object value) {
    if (value == null) {
      return null;
    }
    try {
      return (Datetime) JSON.deserialize(
        '"' + String.valueOf(value) + '"',
        Datetime.class
      );
    } catch (Exception e) {
      return null;
    }
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
}
