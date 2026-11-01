/**
 * Inventaire de l'org à la manière d'Org Check, sans objet personnalisé : chaque jeu de données est
 * calculé à la demande et renvoyé à l'écran, qui le garde dans le cache du navigateur. Rien n'est
 * écrit dans l'org.
 *
 * Jeux de données : pages et composants Visualforce, composants Aura et LWC, pages Lightning, onglets,
 * ressources statiques, étiquettes personnalisées, liens personnalisés, modèles d'e-mail, documents,
 * présentations, types d'enregistrement, règles de workflow, rapports, tableaux de bord, rôles,
 * groupes publics et files d'attente, packages installés, navigateurs utilisés.
 *
 * Chaque élément porte ses constats (version d'API trop ancienne, sans description, jamais utilisé,
 * URL ou Id en dur...). Les références (« utilisé par ») viennent de la Tooling API
 * (MetadataComponentDependency) quand la connexion est configurée ; sinon, mode dégradé.
 * Callouts uniquement : aucune écriture, donc aucune contrainte d'ordre.
 */
public with sharing class OrgInventoryService {
  /** Versions d'API de plus de 3 ans (9 versions) signalées comme trop anciennes. */
  @TestVisible
  private static final Integer API_AGE_LIMIT = 9;

  private static final Integer ROW_LIMIT = 2000;

  private static final Pattern HARDCODED_URL = Pattern.compile(
    '(?i)https?://[a-z0-9.-]*(salesforce\\.com|force\\.com|visualforce\\.com|salesforce-sites\\.com|lightning\\.com)'
  );
  private static final Pattern HARDCODED_ID = Pattern.compile(
    '[\'"/=]((001|003|005|006|00G|00E|00e|012|015|01p|01I|02i|0PS|00D|500|00Q|701|a0[0-9A-Za-z])[0-9A-Za-z]{12}([0-9A-Za-z]{3})?)[\'"&?/ ]'
  );

  public class Item {
    public String id;
    public String name;
    public String label;
    public String kind;
    public String parent;
    public String namespace;
    public Decimal apiVersion;
    public String description;
    public Datetime lastModified;
    public Integer usedBy;
    public Integer level;
    public String detail;
    public List<String> issues = new List<String>();
    public String setupUrl;
  }

  public class Dataset {
    public String name;
    public Datetime generatedAt = Datetime.now();
    public Boolean toolingAvailable = false;
    public Boolean dependenciesAvailable = false;
    public Integer total = 0;
    public Integer withIssues = 0;
    public List<Item> items = new List<Item>();
    public List<String> warnings = new List<String>();
  }

  /** Catalogue des jeux de données (clé → libellé), dans l'ordre d'affichage. */
  public static final Map<String, String> DATASETS = new Map<String, String>{
    'vfPages' => 'Visualforce pages',
    'vfComponents' => 'Visualforce components',
    'auraComponents' => 'Aura components',
    'lwc' => 'Lightning web components',
    'lightningPages' => 'Lightning pages',
    'customTabs' => 'Custom tabs',
    'staticResources' => 'Static resources',
    'customLabels' => 'Custom labels',
    'webLinks' => 'Custom buttons and links',
    'emailTemplates' => 'Email templates',
    'documents' => 'Documents',
    'pageLayouts' => 'Page layouts',
    'recordTypes' => 'Record types',
    'workflowRules' => 'Workflow rules',
    'reports' => 'Reports',
    'dashboards' => 'Dashboards',
    'roles' => 'Role hierarchy',
    'groups' => 'Public groups and queues',
    'packages' => 'Installed packages',
    'browsers' => 'Browsers'
  };

  private OrgToolingGateway gateway;
  private Boolean tooling;
  private Integer minApi;

  public OrgInventoryService() {
    gateway = OrgToolingGateway.getInstance();
    tooling = gateway.isConfigured();
    Integer current = Integer.valueOf(
      OrgToolingGateway.API_VERSION.removeStart('v').substringBefore('.')
    );
    minApi = current - API_AGE_LIMIT;
  }

  public Dataset load(String name) {
    if (!DATASETS.containsKey(name)) {
      throw new IllegalArgumentException('Unknown dataset ' + name);
    }
    Dataset dataset = new Dataset();
    dataset.name = name;
    dataset.toolingAvailable = tooling;
    switch on name {
      when 'vfPages' {
        vfPages(dataset);
      }
      when 'vfComponents' {
        vfComponents(dataset);
      }
      when 'auraComponents' {
        auraComponents(dataset);
      }
      when 'lwc' {
        lightningWebComponents(dataset);
      }
      when 'lightningPages' {
        lightningPages(dataset);
      }
      when 'customTabs' {
        customTabs(dataset);
      }
      when 'staticResources' {
        staticResources(dataset);
      }
      when 'customLabels' {
        customLabels(dataset);
      }
      when 'webLinks' {
        webLinks(dataset);
      }
      when 'emailTemplates' {
        emailTemplates(dataset);
      }
      when 'documents' {
        documents(dataset);
      }
      when 'pageLayouts' {
        pageLayouts(dataset);
      }
      when 'recordTypes' {
        recordTypes(dataset);
      }
      when 'workflowRules' {
        workflowRules(dataset);
      }
      when 'reports' {
        reports(dataset);
      }
      when 'dashboards' {
        dashboards(dataset);
      }
      when 'roles' {
        roles(dataset);
      }
      when 'groups' {
        groups(dataset);
      }
      when 'packages' {
        packages(dataset);
      }
      when 'browsers' {
        browsers(dataset);
      }
      when else {
        throw new IllegalArgumentException('Unknown dataset ' + name);
      }
    }
    dataset.total = dataset.items.size();
    for (Item item : dataset.items) {
      if (!item.issues.isEmpty()) {
        dataset.withIssues++;
      }
    }
    OrgApiLogger.flush();
    return dataset;
  }

  // ---------- Interface utilisateur ----------

  private void vfPages(Dataset d) {
    Map<String, Integer> refs = references(d, 'ApexPage');
    for (ApexPage page : [
      SELECT
        Id,
        Name,
        MasterLabel,
        ApiVersion,
        Description,
        NamespacePrefix,
        LastModifiedDate,
        Markup
      FROM ApexPage
      ORDER BY Name
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        page.Id,
        page.Name,
        page.MasterLabel,
        'Visualforce page',
        page.NamespacePrefix
      );
      item.apiVersion = page.ApiVersion;
      item.description = page.Description;
      item.lastModified = page.LastModifiedDate;
      item.setupUrl = '/lightning/setup/ApexPages/page?address=%2F' + page.Id;
      commonChecks(item, refs, page.Name, d);
      scanSource(item, page.NamespacePrefix == null ? page.Markup : null);
      d.items.add(item);
    }
  }

  private void vfComponents(Dataset d) {
    Map<String, Integer> refs = references(d, 'ApexComponent');
    for (ApexComponent component : [
      SELECT
        Id,
        Name,
        MasterLabel,
        ApiVersion,
        Description,
        NamespacePrefix,
        LastModifiedDate,
        Markup
      FROM ApexComponent
      ORDER BY Name
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        component.Id,
        component.Name,
        component.MasterLabel,
        'Visualforce component',
        component.NamespacePrefix
      );
      item.apiVersion = component.ApiVersion;
      item.description = component.Description;
      item.lastModified = component.LastModifiedDate;
      item.setupUrl =
        '/lightning/setup/ApexComponents/page?address=%2F' + component.Id;
      commonChecks(item, refs, component.Name, d);
      scanSource(
        item,
        component.NamespacePrefix == null ? component.Markup : null
      );
      d.items.add(item);
    }
  }

  private void auraComponents(Dataset d) {
    Map<String, Integer> refs = references(d, 'AuraDefinitionBundle');
    for (AuraDefinitionBundle bundle : [
      SELECT
        Id,
        DeveloperName,
        MasterLabel,
        ApiVersion,
        Description,
        NamespacePrefix,
        LastModifiedDate
      FROM AuraDefinitionBundle
      ORDER BY DeveloperName
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        bundle.Id,
        bundle.DeveloperName,
        bundle.MasterLabel,
        'Aura component',
        bundle.NamespacePrefix
      );
      item.apiVersion = bundle.ApiVersion;
      item.description = bundle.Description;
      item.lastModified = bundle.LastModifiedDate;
      item.setupUrl = '/lightning/setup/LightningComponentBundles/home';
      commonChecks(item, refs, bundle.DeveloperName, d);
      if (bundle.NamespacePrefix == null) {
        item.issues.add(
          'Aura component: consider migrating to a Lightning web component'
        );
      }
      d.items.add(item);
    }
  }

  private void lightningWebComponents(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    Map<String, Integer> refs = references(d, 'LightningComponentBundle');
    for (
      Map<String, Object> row : toolingQuery(
        d,
        'SELECT Id, DeveloperName, MasterLabel, ApiVersion, Description, NamespacePrefix, IsExposed, LastModifiedDate FROM LightningComponentBundle ORDER BY DeveloperName'
      )
    ) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'DeveloperName'),
        text(row, 'MasterLabel'),
        'Lightning web component',
        text(row, 'NamespacePrefix')
      );
      item.apiVersion = decimalValue(row, 'ApiVersion');
      item.description = text(row, 'Description');
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.detail = row.get('IsExposed') == true
        ? 'Exposed in App Builder'
        : 'Not exposed';
      item.setupUrl = '/lightning/setup/LightningComponentBundles/home';
      // Un composant exposé peut être utilisé sur une page sans référence de dépendance
      commonChecks(
        item,
        row.get('IsExposed') == true ? null : refs,
        item.name,
        d
      );
      d.items.add(item);
    }
  }

  private void lightningPages(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    for (
      Map<String, Object> row : toolingQuery(
        d,
        'SELECT Id, DeveloperName, MasterLabel, Type, Description, NamespacePrefix, EntityDefinitionId, LastModifiedDate FROM FlexiPage ORDER BY DeveloperName'
      )
    ) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'DeveloperName'),
        text(row, 'MasterLabel'),
        'Lightning page',
        text(row, 'NamespacePrefix')
      );
      item.description = text(row, 'Description');
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.parent = text(row, 'EntityDefinitionId');
      item.detail = text(row, 'Type');
      item.setupUrl = '/lightning/setup/FlexiPageList/home';
      if (item.namespace == null && String.isBlank(item.description)) {
        item.issues.add('No description');
      }
      d.items.add(item);
    }
  }

  private void customTabs(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    for (
      Map<String, Object> row : toolingQuery(
        d,
        'SELECT Id, DeveloperName, MasterLabel, Type, Description, NamespacePrefix, LastModifiedDate FROM CustomTab ORDER BY DeveloperName'
      )
    ) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'DeveloperName'),
        text(row, 'MasterLabel'),
        'Custom tab',
        text(row, 'NamespacePrefix')
      );
      item.description = text(row, 'Description');
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.detail = text(row, 'Type');
      item.setupUrl = '/lightning/setup/CustomTabs/home';
      if (item.namespace == null && String.isBlank(item.description)) {
        item.issues.add('No description');
      }
      d.items.add(item);
    }
  }

  private void staticResources(Dataset d) {
    Map<String, Integer> refs = references(d, 'StaticResource');
    for (StaticResource resource : [
      SELECT
        Id,
        Name,
        ContentType,
        BodyLength,
        Description,
        NamespacePrefix,
        LastModifiedDate,
        CacheControl
      FROM StaticResource
      ORDER BY Name
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        resource.Id,
        resource.Name,
        resource.Name,
        'Static resource',
        resource.NamespacePrefix
      );
      item.description = resource.Description;
      item.lastModified = resource.LastModifiedDate;
      item.detail =
        resource.ContentType +
        ' · ' +
        size(resource.BodyLength) +
        ' · ' +
        resource.CacheControl;
      item.setupUrl =
        '/lightning/setup/StaticResources/page?address=%2F' + resource.Id;
      commonChecks(item, refs, resource.Name, d);
      if (
        resource.NamespacePrefix == null &&
        resource.BodyLength > 4 * 1024 * 1024
      ) {
        item.issues.add('Large static resource (> 4 MB)');
      }
      d.items.add(item);
    }
  }

  private void customLabels(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    Map<String, Integer> refs = references(d, 'CustomLabel');
    for (
      Map<String, Object> row : toolingQuery(
        d,
        'SELECT Id, Name, MasterLabel, Value, Category, Language, NamespacePrefix, LastModifiedDate FROM ExternalString ORDER BY Name'
      )
    ) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'Name'),
        text(row, 'MasterLabel'),
        'Custom label',
        text(row, 'NamespacePrefix')
      );
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.detail =
        (text(row, 'Value') == null ? '' : text(row, 'Value').abbreviate(120)) +
        (String.isBlank(text(row, 'Category'))
          ? ''
          : ' · ' + text(row, 'Category'));
      item.description = text(row, 'Category');
      item.setupUrl =
        '/lightning/setup/ExternalStrings/page?address=%2F' + item.id;
      if (
        item.namespace == null &&
        refs != null &&
        !refs.containsKey(item.name.toLowerCase())
      ) {
        item.usedBy = 0;
        item.issues.add('Not referenced anywhere');
      } else if (refs != null) {
        item.usedBy = refs.get(item.name.toLowerCase());
      }
      scanSource(item, text(row, 'Value'));
      d.items.add(item);
    }
  }

  private void webLinks(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    for (
      Map<String, Object> row : toolingQuery(
        d,
        'SELECT Id, Name, EntityDefinitionId, LinkType, Url, Description, NamespacePrefix, LastModifiedDate FROM WebLink ORDER BY Name'
      )
    ) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'Name'),
        text(row, 'Name'),
        'Custom button or link',
        text(row, 'NamespacePrefix')
      );
      item.description = text(row, 'Description');
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.parent = text(row, 'EntityDefinitionId');
      item.detail = text(row, 'LinkType');
      if (item.namespace == null) {
        if (String.isBlank(item.description)) {
          item.issues.add('No description');
        }
        if (text(row, 'LinkType') == 'javascript') {
          item.issues.add(
            'JavaScript button: not supported in Lightning Experience'
          );
        }
        scanSource(item, text(row, 'Url'));
      }
      d.items.add(item);
    }
  }

  private void emailTemplates(Dataset d) {
    Datetime yearAgo = Datetime.now().addYears(-1);
    for (EmailTemplate template : [
      SELECT
        Id,
        Name,
        DeveloperName,
        TemplateType,
        UiType,
        IsActive,
        TimesUsed,
        LastUsedDate,
        Folder.Name,
        Description,
        NamespacePrefix,
        LastModifiedDate
      FROM EmailTemplate
      WITH USER_MODE
      ORDER BY Name
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        template.Id,
        template.DeveloperName,
        template.Name,
        'Email template',
        template.NamespacePrefix
      );
      item.description = template.Description;
      item.lastModified = template.LastModifiedDate;
      item.usedBy = template.TimesUsed;
      item.parent = template.Folder?.Name;
      item.detail =
        template.TemplateType +
        (template.UiType == 'SFX' ? ' · Lightning' : ' · Classic') +
        (template.LastUsedDate == null
          ? ' · never used'
          : ' · last used ' + template.LastUsedDate.date().format());
      item.setupUrl = '/' + template.Id;
      if (template.NamespacePrefix == null) {
        if (template.TimesUsed == null || template.TimesUsed == 0) {
          item.issues.add('Never used');
        } else if (
          template.LastUsedDate != null &&
          template.LastUsedDate < yearAgo
        ) {
          item.issues.add('Not used for more than a year');
        }
        if (!template.IsActive) {
          item.issues.add('Inactive');
        }
      }
      d.items.add(item);
    }
  }

  private void documents(Dataset d) {
    for (Document document : [
      SELECT
        Id,
        Name,
        DeveloperName,
        Type,
        BodyLength,
        Url,
        Description,
        Folder.Name,
        NamespacePrefix,
        LastModifiedDate,
        IsPublic
      FROM Document
      WITH USER_MODE
      ORDER BY Name
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        document.Id,
        document.DeveloperName,
        document.Name,
        'Document',
        document.NamespacePrefix
      );
      item.description = document.Description;
      item.lastModified = document.LastModifiedDate;
      item.parent = document.Folder?.Name;
      item.detail =
        (document.Type == null ? '' : document.Type + ' · ') +
        size(document.BodyLength) +
        (document.IsPublic ? ' · externally available' : '');
      item.setupUrl = '/' + document.Id;
      if (document.NamespacePrefix == null) {
        if (
          document.BodyLength != null &&
          document.BodyLength > 5 * 1024 * 1024
        ) {
          item.issues.add(
            'Large document (> 5 MB): store it as a file instead'
          );
        }
        if (document.IsPublic) {
          item.issues.add(
            'Externally available image or document: check it is meant to be public'
          );
        }
        scanSource(item, document.Url);
      }
      d.items.add(item);
    }
  }

  // ---------- Modèle de données et automatisation ----------

  private void pageLayouts(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    Set<String> assigned = new Set<String>();
    Boolean assignmentKnown = true;
    try {
      for (
        Map<String, Object> row : gateway.query(
          'SELECT LayoutId FROM ProfileLayout'
        )
      ) {
        assigned.add(text(row, 'LayoutId'));
      }
    } catch (Exception e) {
      assignmentKnown = false;
      d.warnings.add('Layout assignments could not be read: ' + e.getMessage());
    }
    Map<String, Integer> perObject = new Map<String, Integer>();
    List<Map<String, Object>> rows = toolingQuery(
      d,
      'SELECT Id, Name, TableEnumOrId, LayoutType, NamespacePrefix, LastModifiedDate FROM Layout ORDER BY TableEnumOrId, Name'
    );
    for (Map<String, Object> row : rows) {
      String objectName = text(row, 'TableEnumOrId');
      perObject.put(
        objectName,
        (perObject.containsKey(objectName) ? perObject.get(objectName) : 0) + 1
      );
    }
    for (Map<String, Object> row : rows) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'Name'),
        text(row, 'Name'),
        'Page layout',
        text(row, 'NamespacePrefix')
      );
      item.parent = text(row, 'TableEnumOrId');
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.detail = text(row, 'LayoutType');
      item.setupUrl = '/lightning/setup/ObjectManager/home';
      if (
        assignmentKnown &&
        item.namespace == null &&
        !assigned.contains(item.id) &&
        !assigned.contains(item.id.left(15))
      ) {
        item.issues.add('Not assigned to any profile');
      }
      if (perObject.get(item.parent) > 15) {
        item.issues.add('Object with more than 15 page layouts');
      }
      d.items.add(item);
    }
  }

  private void recordTypes(Dataset d) {
    for (RecordType recordType : [
      SELECT
        Id,
        Name,
        DeveloperName,
        SobjectType,
        IsActive,
        Description,
        NamespacePrefix,
        LastModifiedDate
      FROM RecordType
      ORDER BY SobjectType, Name
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        recordType.Id,
        recordType.DeveloperName,
        recordType.Name,
        'Record type',
        recordType.NamespacePrefix
      );
      item.parent = recordType.SobjectType;
      item.description = recordType.Description;
      item.lastModified = recordType.LastModifiedDate;
      item.detail = recordType.IsActive ? 'Active' : 'Inactive';
      item.setupUrl =
        '/lightning/setup/ObjectManager/' +
        recordType.SobjectType +
        '/RecordTypes/view';
      if (recordType.NamespacePrefix == null) {
        if (!recordType.IsActive) {
          item.issues.add('Inactive record type');
        }
        if (String.isBlank(recordType.Description)) {
          item.issues.add('No description');
        }
      }
      d.items.add(item);
    }
  }

  private void workflowRules(Dataset d) {
    if (!requireTooling(d)) {
      return;
    }
    Map<String, Integer> perObject = new Map<String, Integer>();
    List<Map<String, Object>> rows = toolingQuery(
      d,
      'SELECT Id, Name, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM WorkflowRule ORDER BY TableEnumOrId, Name'
    );
    for (Map<String, Object> row : rows) {
      String objectName = text(row, 'TableEnumOrId');
      perObject.put(
        objectName,
        (perObject.containsKey(objectName) ? perObject.get(objectName) : 0) + 1
      );
    }
    for (Map<String, Object> row : rows) {
      Item item = item(
        text(row, 'Id'),
        text(row, 'Name'),
        text(row, 'Name'),
        'Workflow rule',
        text(row, 'NamespacePrefix')
      );
      item.parent = text(row, 'TableEnumOrId');
      item.lastModified = datetimeValue(row, 'LastModifiedDate');
      item.setupUrl = '/lightning/setup/WorkflowRules/home';
      if (item.namespace == null) {
        item.issues.add(
          'Workflow rules are retired: migrate to a record-triggered flow'
        );
      }
      if (perObject.get(item.parent) > 20) {
        item.issues.add('Object with more than 20 workflow rules');
      }
      d.items.add(item);
    }
  }

  // ---------- Analytique ----------

  private void reports(Dataset d) {
    Datetime yearAgo = Datetime.now().addYears(-1);
    Set<Id> inactiveOwners = inactiveUserIds();
    for (Report report : [
      SELECT
        Id,
        Name,
        DeveloperName,
        FolderName,
        Format,
        LastRunDate,
        LastModifiedDate,
        Description,
        NamespacePrefix,
        OwnerId
      FROM Report
      WITH USER_MODE
      ORDER BY LastRunDate ASC NULLS FIRST
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        report.Id,
        report.DeveloperName,
        report.Name,
        'Report',
        report.NamespacePrefix
      );
      item.parent = report.FolderName;
      item.description = report.Description;
      item.lastModified = report.LastModifiedDate;
      item.detail =
        report.Format +
        (report.LastRunDate == null
          ? ' · never run'
          : ' · last run ' + report.LastRunDate.date().format());
      item.setupUrl = '/lightning/r/Report/' + report.Id + '/view';
      if (report.NamespacePrefix == null) {
        if (report.LastRunDate == null) {
          item.issues.add('Never run');
        } else if (report.LastRunDate < yearAgo) {
          item.issues.add('Not run for more than a year');
        }
        if (inactiveOwners.contains(report.OwnerId)) {
          item.issues.add('Owned by an inactive user');
        }
      }
      d.items.add(item);
    }
    if (d.items.size() >= ROW_LIMIT) {
      d.warnings.add(
        'Only the ' + ROW_LIMIT + ' least recently run reports are listed.'
      );
    }
  }

  private void dashboards(Dataset d) {
    Datetime yearAgo = Datetime.now().addYears(-1);
    Set<Id> inactiveUsers = inactiveUserIds();
    for (Dashboard dashboard : [
      SELECT
        Id,
        Title,
        DeveloperName,
        FolderName,
        Type,
        RunningUserId,
        LastModifiedDate,
        LastReferencedDate,
        Description,
        NamespacePrefix
      FROM Dashboard
      WITH USER_MODE
      ORDER BY Title
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        dashboard.Id,
        dashboard.DeveloperName,
        dashboard.Title,
        'Dashboard',
        dashboard.NamespacePrefix
      );
      item.parent = dashboard.FolderName;
      item.description = dashboard.Description;
      item.lastModified = dashboard.LastModifiedDate;
      item.detail = dashboard.Type == 'LoggedInUser'
        ? 'Dynamic (viewer)'
        : dashboard.Type == 'MyTeamUser'
            ? 'Dynamic (team)'
            : 'Runs as a specific user';
      item.setupUrl = '/lightning/r/Dashboard/' + dashboard.Id + '/view';
      if (dashboard.NamespacePrefix == null) {
        if (
          dashboard.Type == 'SpecifiedUser' &&
          inactiveUsers.contains(dashboard.RunningUserId)
        ) {
          item.issues.add(
            'Running user is inactive: the dashboard no longer refreshes'
          );
        }
        if (
          dashboard.LastModifiedDate < yearAgo &&
          (dashboard.LastReferencedDate == null ||
          dashboard.LastReferencedDate < yearAgo)
        ) {
          item.issues.add('Not modified or viewed for more than a year');
        }
      }
      d.items.add(item);
    }
  }

  // ---------- Accès ----------

  private void roles(Dataset d) {
    Map<Id, UserRole> roles = new Map<Id, UserRole>(
      [
        SELECT
          Id,
          Name,
          DeveloperName,
          ParentRoleId,
          PortalType,
          LastModifiedDate
        FROM UserRole
        WHERE PortalType = 'None'
        LIMIT :ROW_LIMIT
      ]
    );
    Map<Id, Integer> usersPerRole = new Map<Id, Integer>();
    for (AggregateResult row : [
      SELECT UserRoleId roleId, COUNT(Id) total
      FROM User
      WHERE IsActive = TRUE AND UserRoleId IN :roles.keySet()
      GROUP BY UserRoleId
    ]) {
      usersPerRole.put((Id) row.get('roleId'), (Integer) row.get('total'));
    }
    Map<Id, List<UserRole>> children = new Map<Id, List<UserRole>>();
    List<UserRole> tops = new List<UserRole>();
    for (UserRole role : roles.values()) {
      if (role.ParentRoleId == null || !roles.containsKey(role.ParentRoleId)) {
        tops.add(role);
      } else {
        if (!children.containsKey(role.ParentRoleId)) {
          children.put(role.ParentRoleId, new List<UserRole>());
        }
        children.get(role.ParentRoleId).add(role);
      }
    }
    // Parcours en profondeur : l'écran affiche l'arbre dans cet ordre, indenté par niveau
    List<Object[]> stack = new List<Object[]>();
    for (Integer i = tops.size() - 1; i >= 0; i--) {
      stack.add(new List<Object>{ tops[i], 1 });
    }
    while (!stack.isEmpty()) {
      Object[] current = stack.remove(stack.size() - 1);
      UserRole role = (UserRole) current[0];
      Integer level = (Integer) current[1];
      Integer users = usersPerRole.containsKey(role.Id)
        ? usersPerRole.get(role.Id)
        : 0;
      List<UserRole> kids = children.containsKey(role.Id)
        ? children.get(role.Id)
        : new List<UserRole>();
      Item item = item(role.Id, role.DeveloperName, role.Name, 'Role', null);
      item.level = level;
      item.usedBy = users;
      item.lastModified = role.LastModifiedDate;
      item.detail = users + ' active user(s) · ' + kids.size() + ' sub-role(s)';
      item.setupUrl = '/lightning/setup/Roles/page?address=%2F' + role.Id;
      if (users == 0) {
        item.issues.add('Role with no active users');
      }
      if (level >= 7) {
        item.issues.add('Role at level 7 or deeper');
      }
      d.items.add(item);
      for (Integer i = kids.size() - 1; i >= 0; i--) {
        stack.add(new List<Object>{ kids[i], level + 1 });
      }
    }
  }

  private void groups(Dataset d) {
    Map<Id, Group> groups = new Map<Id, Group>(
      [
        SELECT
          Id,
          Name,
          DeveloperName,
          Type,
          DoesIncludeBosses,
          LastModifiedDate
        FROM Group
        WHERE Type IN ('Regular', 'Queue')
        ORDER BY Type, Name
        LIMIT :ROW_LIMIT
      ]
    );
    Map<Id, Integer> users = new Map<Id, Integer>();
    Map<Id, Integer> nested = new Map<Id, Integer>();
    // LIMIT borné aux lignes restantes de la transaction (LimitException non interceptable)
    Integer rowsLeft = Limits.getLimitQueryRows() - Limits.getQueryRows();
    List<GroupMember> members = rowsLeft <= 0
      ? new List<GroupMember>()
      : [
          SELECT GroupId, UserOrGroupId
          FROM GroupMember
          WHERE GroupId IN :groups.keySet()
          LIMIT :rowsLeft
        ];
    if (members.size() >= rowsLeft) {
      d.warnings.add(
        'Member counts are incomplete: the query row limit was reached after ' +
          members.size() +
          ' group members.'
      );
    }
    for (GroupMember member : members) {
      Map<Id, Integer> target = String.valueOf(member.UserOrGroupId)
          .startsWith('005')
        ? users
        : nested;
      target.put(
        member.GroupId,
        (target.containsKey(member.GroupId) ? target.get(member.GroupId) : 0) +
        1
      );
    }
    for (Group g : groups.values()) {
      Integer userCount = users.containsKey(g.Id) ? users.get(g.Id) : 0;
      Integer groupCount = nested.containsKey(g.Id) ? nested.get(g.Id) : 0;
      Item item = item(
        g.Id,
        g.DeveloperName,
        g.Name,
        g.Type == 'Queue' ? 'Queue' : 'Public group',
        null
      );
      item.usedBy = userCount + groupCount;
      item.lastModified = g.LastModifiedDate;
      item.detail =
        userCount +
        ' user(s) · ' +
        groupCount +
        ' group(s) or role(s)';
      item.setupUrl = g.Type == 'Queue'
        ? '/lightning/setup/Queues/page?address=%2F' + g.Id
        : '/lightning/setup/PublicGroups/page?address=%2F' + g.Id;
      if (userCount + groupCount == 0) {
        item.issues.add('No direct member');
      }
      d.items.add(item);
    }
  }

  // ---------- Org ----------

  private void packages(Dataset d) {
    if (tooling) {
      try {
        for (
          Map<String, Object> row : gateway.query(
            'SELECT Id, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackageVersion.Name, ' +
            'SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.IsBeta FROM InstalledSubscriberPackage'
          )
        ) {
          String namespace = OrgToolingGateway.getString(
            row,
            'SubscriberPackage.NamespacePrefix'
          );
          Item item = item(
            text(row, 'Id'),
            OrgToolingGateway.getString(row, 'SubscriberPackage.Name'),
            OrgToolingGateway.getString(row, 'SubscriberPackage.Name'),
            'Installed package',
            namespace
          );
          item.detail =
            'Version ' +
            OrgToolingGateway.getString(
              row,
              'SubscriberPackageVersion.MajorVersion'
            ) +
            '.' +
            OrgToolingGateway.getString(
              row,
              'SubscriberPackageVersion.MinorVersion'
            ) +
            ' (' +
            OrgToolingGateway.getString(row, 'SubscriberPackageVersion.Name') +
            ')';
          item.setupUrl = '/lightning/setup/ImportedPackage/home';
          if (
            OrgToolingGateway.getValue(
              row,
              'SubscriberPackageVersion.IsBeta'
            ) == true
          ) {
            item.issues.add('Beta version installed');
          }
          d.items.add(item);
        }
        return;
      } catch (Exception e) {
        d.warnings.add(
          'Installed packages could not be read with the Tooling API: ' +
          e.getMessage()
        );
      }
    }
    for (PackageLicense license : [
      SELECT
        Id,
        NamespacePrefix,
        Status,
        AllowedLicenses,
        UsedLicenses,
        ExpirationDate
      FROM PackageLicense
      LIMIT :ROW_LIMIT
    ]) {
      Item item = item(
        license.Id,
        license.NamespacePrefix,
        license.NamespacePrefix,
        'Licensed package',
        license.NamespacePrefix
      );
      item.detail =
        license.Status +
        (license.AllowedLicenses < 0
          ? ' · site-wide'
          : ' · ' +
            license.UsedLicenses +
            ' / ' +
            license.AllowedLicenses +
            ' licenses');
      item.setupUrl = '/lightning/setup/ImportedPackage/home';
      if (
        license.ExpirationDate != null &&
        license.ExpirationDate < Datetime.now()
      ) {
        item.issues.add('License expired');
      }
      d.items.add(item);
    }
  }

  /** Navigateurs des connexions des 30 derniers jours (5 000 dernières), versions obsolètes signalées. */
  private void browsers(Dataset d) {
    Map<String, Integer> logins = new Map<String, Integer>();
    Map<String, Set<Id>> people = new Map<String, Set<Id>>();
    for (LoginHistory login : [
      SELECT Browser, UserId
      FROM LoginHistory
      WHERE LoginTime = LAST_N_DAYS:30
      ORDER BY LoginTime DESC
      LIMIT 5000
    ]) {
      String browser = String.isBlank(login.Browser)
        ? 'Unknown'
        : login.Browser;
      if (browser == 'Unknown') {
        continue; // connexions API, sans navigateur
      }
      logins.put(
        browser,
        (logins.containsKey(browser) ? logins.get(browser) : 0) + 1
      );
      if (!people.containsKey(browser)) {
        people.put(browser, new Set<Id>());
      }
      people.get(browser).add(login.UserId);
    }
    for (String browser : logins.keySet()) {
      Item item = item(browser, browser, browser, 'Browser', null);
      item.usedBy = people.get(browser).size();
      item.detail =
        logins.get(browser) +
        ' login(s) by ' +
        people.get(browser).size() +
        ' user(s) in the last 30 days';
      String issue = browserIssue(browser);
      if (issue != null) {
        item.issues.add(issue);
      }
      d.items.add(item);
    }
  }

  @TestVisible
  private static String browserIssue(String browser) {
    String lower = browser.toLowerCase();
    if (
      lower.contains('ie ') ||
      lower.contains('internet explorer') ||
      lower.startsWith('ie')
    ) {
      return 'Unsupported by Salesforce';
    }
    Matcher m = Pattern.compile('(chrome|firefox|edge|safari)\\s*([0-9]+)')
      .matcher(lower);
    if (!m.find()) {
      return null;
    }
    Integer version = Integer.valueOf(m.group(2));
    Map<String, Integer> minimum = new Map<String, Integer>{
      'chrome' => 120,
      'edge' => 120,
      'firefox' => 115,
      'safari' => 16
    };
    return version < minimum.get(m.group(1))
      ? 'Out-of-date version: update the browser'
      : null;
  }

  // ---------- Contrôles communs ----------

  private Item item(
    String id,
    String name,
    String label,
    String kind,
    String namespace
  ) {
    Item item = new Item();
    item.id = id;
    item.name = name;
    item.label = label;
    item.kind = kind;
    item.namespace = namespace;
    return item;
  }

  /** Version d'API, description, références (null = références inconnues). */
  private void commonChecks(
    Item item,
    Map<String, Integer> refs,
    String name,
    Dataset d
  ) {
    if (item.namespace != null) {
      return; // composants de packages gérés : hors de votre contrôle
    }
    if (item.apiVersion != null && item.apiVersion < minApi) {
      item.issues.add(
        'API version too old (' + item.apiVersion.setScale(1) + ')'
      );
    }
    if (String.isBlank(item.description)) {
      item.issues.add('No description');
    }
    if (refs != null) {
      Integer count = refs.get(name == null ? '' : name.toLowerCase());
      item.usedBy = count == null ? 0 : count;
      if (count == null) {
        item.issues.add('Not referenced anywhere');
      }
    }
  }

  private static void scanSource(Item item, String source) {
    if (String.isBlank(source)) {
      return;
    }
    if (HARDCODED_URL.matcher(source).find()) {
      item.issues.add('Hard-coded Salesforce URL');
    }
    if (HARDCODED_ID.matcher(source).find()) {
      item.issues.add('Hard-coded Salesforce Id');
    }
  }

  /**
   * Nombre de références par nom de composant (Tooling MetadataComponentDependency, 2 000 lignes au
   * plus) ; null si la Tooling API n'est pas disponible ou si l'API a échoué.
   */
  private Map<String, Integer> references(Dataset d, String refType) {
    if (!tooling) {
      return null;
    }
    try {
      Map<String, Integer> counts = new Map<String, Integer>();
      List<Map<String, Object>> rows = gateway.query(
        'SELECT RefMetadataComponentName FROM MetadataComponentDependency WHERE RefMetadataComponentType = \'' +
          refType +
          '\' LIMIT 2000'
      );
      for (Map<String, Object> row : rows) {
        String name = text(row, 'RefMetadataComponentName');
        if (name != null) {
          name = name.toLowerCase();
          counts.put(
            name,
            (counts.containsKey(name) ? counts.get(name) : 0) + 1
          );
        }
      }
      d.dependenciesAvailable = true;
      if (rows.size() >= 2000) {
        d.warnings.add(
          'The dependency API returned its maximum of 2,000 references: some items may wrongly appear as not referenced.'
        );
      }
      return counts;
    } catch (Exception e) {
      d.warnings.add(
        'References could not be read (dependency API): ' + e.getMessage()
      );
      return null;
    }
  }

  private Boolean requireTooling(Dataset d) {
    if (!tooling) {
      d.warnings.add(
        'This list needs the Tooling API connection (Settings › Tooling API).'
      );
      return false;
    }
    return true;
  }

  private List<Map<String, Object>> toolingQuery(Dataset d, String soql) {
    try {
      return gateway.query(soql);
    } catch (Exception e) {
      d.warnings.add('The Tooling API query failed: ' + e.getMessage());
      return new List<Map<String, Object>>();
    }
  }

  private static Set<Id> inactiveUserIds() {
    return new Map<Id, User>(
        [SELECT Id FROM User WHERE IsActive = FALSE LIMIT 20000]
      )
      .keySet();
  }

  private static String text(Map<String, Object> row, String field) {
    Object value = row.get(field);
    return value == null ? null : String.valueOf(value);
  }

  private static Decimal decimalValue(Map<String, Object> row, String field) {
    Object value = row.get(field);
    return value == null ? null : Decimal.valueOf(String.valueOf(value));
  }

  private static Datetime datetimeValue(Map<String, Object> row, String field) {
    String value = text(row, field);
    if (String.isBlank(value)) {
      return null;
    }
    try {
      return (Datetime) JSON.deserialize('"' + value + '"', Datetime.class);
    } catch (Exception e) {
      return null;
    }
  }

  private static String size(Integer bytes) {
    if (bytes == null) {
      return '—';
    }
    if (bytes < 1024 * 1024) {
      return (Decimal.valueOf(bytes) / 1024).setScale(0) + ' KB';
    }
    return (Decimal.valueOf(bytes) / (1024 * 1024)).setScale(1) + ' MB';
  }
}
