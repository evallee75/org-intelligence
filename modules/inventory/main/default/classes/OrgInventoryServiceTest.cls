/**
 * Tests du service d'inventaire : chaque jeu de données avec la Tooling API simulée, en mode
 * dégradé (sans Tooling) et avec des pannes de l'API. Les données créables en test (rôles,
 * groupes, modèles d'e-mail, documents) le sont ; le reste est vérifié par des assertions robustes.
 */
@IsTest
private class OrgInventoryServiceTest {
  private static final List<String> TOOLING_DATASETS = new List<String>{
    'lwc',
    'lightningPages',
    'customTabs',
    'customLabels',
    'webLinks',
    'pageLayouts',
    'workflowRules'
  };

  private static User admin() {
    return OrgInventoryTestSupport.adminWith(
      OrgInventoryTestSupport.fullAccess()
    );
  }

  private static OrgInventoryService.Item find(
    OrgInventoryService.Dataset d,
    String name
  ) {
    for (OrgInventoryService.Item item : d.items) {
      if (item.name == name) {
        return item;
      }
    }
    return null;
  }

  @IsTest
  static void everyDatasetLoadsWithTooling() {
    User u = admin();
    OrgInventoryTestSupport.ToolingRouter router = new OrgInventoryTestSupport.ToolingRouter();
    System.runAs(u) {
      OrgInventoryTestSupport.useTooling(true, router);
      Test.startTest();
      for (String name : OrgInventoryService.DATASETS.keySet()) {
        OrgInventoryService.Dataset d = new OrgInventoryService().load(name);
        Assert.areEqual(name, d.name);
        Assert.isTrue(d.toolingAvailable);
        Assert.areEqual(d.items.size(), d.total);
        Assert.isTrue(d.withIssues <= d.total);
      }
      Test.stopTest();
    }
    Assert.isFalse(router.endpoints.isEmpty(), 'Tooling interrogée');
  }

  @IsTest
  static void lightningComponentsAreChecked() {
    System.runAs(admin()) {
      OrgInventoryTestSupport.useTooling(
        true,
        new OrgInventoryTestSupport.ToolingRouter()
      );
      Test.startTest();
      OrgInventoryService.Dataset d = new OrgInventoryService().load('lwc');
      Test.stopTest();

      Assert.isTrue(d.dependenciesAvailable);
      Assert.areEqual(3, d.total);
      OrgInventoryService.Item used = find(d, 'UsedComponent');
      Assert.areEqual(2, used.usedBy);
      Assert.isTrue(used.issues.contains('No description'));
      Assert.isTrue(used.issues[0].startsWith('API version too old'));
      Assert.isNotNull(used.lastModified);

      OrgInventoryService.Item exposed = find(d, 'exposedCard');
      Assert.areEqual('Exposed in App Builder', exposed.detail);
      Assert.isTrue(exposed.issues.isEmpty(), String.valueOf(exposed.issues));
      Assert.isNull(exposed.lastModified, 'date illisible ignorée');

      Assert.isTrue(find(d, 'pkgCmp').issues.isEmpty(), 'package ignoré');
    }
  }

  @IsTest
  static void labelsLinksLayoutsAndWorkflowsAreChecked() {
    System.runAs(admin()) {
      OrgInventoryTestSupport.useTooling(
        true,
        new OrgInventoryTestSupport.ToolingRouter()
      );
      Test.startTest();
      OrgInventoryService service = new OrgInventoryService();
      OrgInventoryService.Dataset labels = service.load('customLabels');
      OrgInventoryService.Dataset links = service.load('webLinks');
      OrgInventoryService.Dataset layouts = service.load('pageLayouts');
      OrgInventoryService.Dataset workflows = service.load('workflowRules');
      OrgInventoryService.Dataset pages = service.load('lightningPages');
      OrgInventoryService.Dataset tabs = service.load('customTabs');
      Test.stopTest();

      Assert.areEqual(1, find(labels, 'Used_Label').usedBy);
      OrgInventoryService.Item orphan = find(labels, 'Orphan_Label');
      Assert.isTrue(orphan.issues.contains('Not referenced anywhere'));
      Assert.isTrue(orphan.issues.contains('Hard-coded Salesforce URL'));
      Assert.isTrue(orphan.issues.contains('Hard-coded Salesforce Id'));

      OrgInventoryService.Item button = find(links, 'Old_Button');
      Assert.isTrue(button.issues.contains('No description'));
      Assert.isTrue(
        button.issues.contains(
          'JavaScript button: not supported in Lightning Experience'
        )
      );
      Assert.isTrue(button.issues.contains('Hard-coded Salesforce Id'));
      Assert.isTrue(find(links, 'Doc_Link').issues.isEmpty());

      Assert.isTrue(
        find(layouts, 'Account Layout').issues.isEmpty(),
        'présentation attribuée (Id à 15 caractères)'
      );
      Assert.isTrue(
        find(layouts, 'Account Unused')
          .issues.contains('Not assigned to any profile')
      );

      Assert.areEqual(1, find(workflows, 'Legacy rule').issues.size());
      Assert.isTrue(find(workflows, 'Pkg rule').issues.isEmpty());

      Assert.isTrue(
        find(pages, 'Account_Page').issues.contains('No description')
      );
      Assert.isTrue(find(pages, 'Home').issues.isEmpty());
      Assert.isTrue(find(tabs, 'My_Tab').issues.contains('No description'));
      Assert.isTrue(find(tabs, 'Pkg_Tab').issues.isEmpty());
    }
  }

  @IsTest
  static void installedPackagesComeFromTooling() {
    System.runAs(admin()) {
      OrgInventoryTestSupport.useTooling(
        true,
        new OrgInventoryTestSupport.ToolingRouter()
      );
      Test.startTest();
      OrgInventoryService.Dataset d = new OrgInventoryService()
        .load('packages');
      Test.stopTest();
      Assert.areEqual(2, d.total);
      OrgInventoryService.Item beta = find(d, 'Beta App');
      Assert.areEqual('Version 1.2 (Spring)', beta.detail);
      Assert.isTrue(beta.issues.contains('Beta version installed'));
      Assert.isTrue(find(d, 'Stable App').issues.isEmpty());
    }
  }

  @IsTest
  static void toolingFailuresBecomeWarnings() {
    OrgInventoryTestSupport.ToolingRouter router = new OrgInventoryTestSupport.ToolingRouter();
    router.failing.addAll(
      new Set<String>{
        'MetadataComponentDependency',
        'LightningComponentBundle',
        'ProfileLayout',
        'InstalledSubscriberPackage'
      }
    );
    System.runAs(admin()) {
      OrgInventoryTestSupport.useTooling(true, router);
      Test.startTest();
      OrgInventoryService service = new OrgInventoryService();
      OrgInventoryService.Dataset lwc = service.load('lwc');
      OrgInventoryService.Dataset layouts = service.load('pageLayouts');
      OrgInventoryService.Dataset packages = service.load('packages');
      OrgInventoryService.Dataset pages = service.load('vfPages');
      Test.stopTest();

      Assert.areEqual(0, lwc.total);
      Assert.isFalse(lwc.dependenciesAvailable);
      Assert.areEqual(2, lwc.warnings.size(), String.valueOf(lwc.warnings));
      Assert.isTrue(
        layouts.warnings[0].startsWith('Layout assignments could not be read')
      );
      Assert.isTrue(
        find(layouts, 'Account Unused').issues.isEmpty(),
        'attributions inconnues : pas de constat'
      );
      Assert.isTrue(
        packages.warnings[0].startsWith('Installed packages could not be read')
      );
      Assert.isTrue(
        pages.warnings[0].startsWith('References could not be read')
      );
    }
  }

  @IsTest
  static void datasetsDegradeWithoutTooling() {
    System.runAs(admin()) {
      OrgInventoryTestSupport.useTooling(false, null);
      Test.startTest();
      OrgInventoryService service = new OrgInventoryService();
      for (String name : TOOLING_DATASETS) {
        OrgInventoryService.Dataset d = service.load(name);
        Assert.isFalse(d.toolingAvailable);
        Assert.areEqual(0, d.total, name);
        Assert.areEqual(1, d.warnings.size(), name);
      }
      OrgInventoryService.Dataset pages = service.load('vfPages');
      OrgInventoryService.Dataset packages = service.load('packages');
      Test.stopTest();
      Assert.isFalse(pages.dependenciesAvailable);
      for (OrgInventoryService.Item item : pages.items) {
        Assert.isNull(item.usedBy, 'références inconnues sans Tooling');
      }
      for (OrgInventoryService.Item item : packages.items) {
        Assert.areEqual('Licensed package', item.kind);
      }
    }
  }

  @IsTest
  static void rolesAreListedAsATree() {
    User u = admin();
    List<UserRole> chain = new List<UserRole>();
    System.runAs(u) {
      Id parentId = null;
      for (Integer i = 1; i <= 8; i++) {
        UserRole role = new UserRole(
          Name = 'OI Test Role ' + i,
          DeveloperName = 'OI_Test_Role_' + i + '_' + DateTime.now().getTime(),
          ParentRoleId = parentId
        );
        insert role;
        chain.add(role);
        parentId = role.Id;
      }
    }
    System.runAs(u) {
      OrgInventoryTestSupport.useTooling(false, null);
      Test.startTest();
      OrgInventoryService.Dataset d = new OrgInventoryService().load('roles');
      Test.stopTest();
      Map<Id, OrgInventoryService.Item> byId = new Map<Id, OrgInventoryService.Item>();
      for (OrgInventoryService.Item item : d.items) {
        byId.put(item.id, item);
      }
      OrgInventoryService.Item top = byId.get(chain[0].Id);
      OrgInventoryService.Item deepest = byId.get(chain[7].Id);
      Assert.isNotNull(top);
      Assert.isTrue(top.issues.contains('Role with no active users'));
      Assert.areEqual(top.level + 7, deepest.level);
      Assert.isTrue(deepest.issues.contains('Role at level 7 or deeper'));
      Assert.isTrue(top.detail.contains('1 sub-role(s)'), top.detail);
    }
  }

  @IsTest
  static void groupsCountTheirMembers() {
    User u = admin();
    Group filled = new Group(
      Name = 'OI Test Group',
      DeveloperName = 'OI_Test_Group_' + DateTime.now().getTime(),
      Type = 'Regular'
    );
    Group nested = new Group(
      Name = 'OI Test Nested',
      DeveloperName = 'OI_Test_Nested_' + DateTime.now().getTime(),
      Type = 'Regular'
    );
    Group empty = new Group(
      Name = 'OI Test Queue',
      DeveloperName = 'OI_Test_Queue_' + DateTime.now().getTime(),
      Type = 'Queue'
    );
    System.runAs(u) {
      insert new List<Group>{ filled, nested, empty };
      insert new List<GroupMember>{
        new GroupMember(GroupId = filled.Id, UserOrGroupId = u.Id),
        new GroupMember(GroupId = filled.Id, UserOrGroupId = nested.Id)
      };
    }
    System.runAs(u) {
      OrgInventoryTestSupport.useTooling(false, null);
      Test.startTest();
      OrgInventoryService.Dataset d = new OrgInventoryService().load('groups');
      Test.stopTest();
      Map<Id, OrgInventoryService.Item> byId = new Map<Id, OrgInventoryService.Item>();
      for (OrgInventoryService.Item item : d.items) {
        byId.put(item.id, item);
      }
      OrgInventoryService.Item groupItem = byId.get(filled.Id);
      Assert.areEqual(2, groupItem.usedBy);
      Assert.areEqual('Public group', groupItem.kind);
      Assert.isTrue(groupItem.issues.isEmpty());
      OrgInventoryService.Item queueItem = byId.get(empty.Id);
      Assert.areEqual('Queue', queueItem.kind);
      Assert.isTrue(queueItem.issues.contains('No direct member'));
    }
  }

  @IsTest
  static void templatesAndDocumentsAreChecked() {
    User u = admin();
    EmailTemplate template = new EmailTemplate(
      Name = 'OI Test Template',
      DeveloperName = 'OI_Test_Template_' + DateTime.now().getTime(),
      TemplateType = 'text',
      FolderId = u.Id,
      IsActive = false,
      Subject = 'Hello',
      Body = 'Hello'
    );
    System.runAs(u) {
      insert template;
    }
    Document document = new Document(
      Name = 'OI Test Document',
      DeveloperName = 'OI_Test_Document_' + DateTime.now().getTime(),
      FolderId = u.Id,
      Body = Blob.valueOf('content'),
      IsPublic = true
    );
    System.runAs(u) {
      insert document;
      OrgInventoryTestSupport.useTooling(false, null);
      Test.startTest();
      OrgInventoryService service = new OrgInventoryService();
      OrgInventoryService.Dataset templates = service.load('emailTemplates');
      OrgInventoryService.Dataset documents = service.load('documents');
      OrgInventoryService.Dataset reports = service.load('reports');
      OrgInventoryService.Dataset dashboards = service.load('dashboards');
      Test.stopTest();

      OrgInventoryService.Item templateItem = find(
        templates,
        template.DeveloperName
      );
      Assert.isNotNull(templateItem);
      Assert.isTrue(templateItem.issues.contains('Never used'));
      Assert.isTrue(templateItem.issues.contains('Inactive'));
      Assert.isTrue(templateItem.detail.contains('never used'));

      OrgInventoryService.Item documentItem = find(
        documents,
        document.DeveloperName
      );
      Assert.isNotNull(documentItem);
      Assert.isTrue(documentItem.detail.contains('externally available'));
      Assert.areEqual(1, documentItem.issues.size());
      Assert.isNotNull(reports.items);
      Assert.isNotNull(dashboards.items);
    }
  }

  @IsTest
  static void browserVersionsAreJudged() {
    Assert.areEqual(
      'Unsupported by Salesforce',
      OrgInventoryService.browserIssue('IE 11')
    );
    Assert.areEqual(
      'Unsupported by Salesforce',
      OrgInventoryService.browserIssue('Internet Explorer')
    );
    Assert.areEqual(
      'Out-of-date version: update the browser',
      OrgInventoryService.browserIssue('Chrome 99')
    );
    Assert.isNull(OrgInventoryService.browserIssue('Firefox 130'));
    Assert.isNull(OrgInventoryService.browserIssue('Opera'));
  }

  @IsTest
  static void unknownDatasetIsRefused() {
    System.runAs(admin()) {
      OrgInventoryTestSupport.useTooling(false, null);
      try {
        new OrgInventoryService().load('nope');
        Assert.fail('jeu inconnu');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('nope'));
      }
    }
  }
}
