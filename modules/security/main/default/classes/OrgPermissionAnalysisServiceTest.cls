/**
 * Tests de l'analyse des profils et permission sets (OrgPermissionAnalysisService) : vue d'ensemble,
 * utilisateurs, droits objet, FLS et comparaison, sur des permission sets créés dans le test.
 */
@IsTest
private class OrgPermissionAnalysisServiceTest {
  private static PermissionSet editor;
  private static PermissionSet reader;

  /** Deux permission sets : l'un modifie Account (et sa description), l'autre le lit seulement. */
  private static void setupPermissionSets() {
    editor = new PermissionSet(
      Name = 'OiPermEditor',
      Label = 'OI Perm Editor',
      PermissionsApiEnabled = true
    );
    reader = new PermissionSet(Name = 'OiPermReader', Label = 'OI Perm Reader');
    insert new List<PermissionSet>{ editor, reader };
    insert new List<ObjectPermissions>{
      new ObjectPermissions(
        ParentId = editor.Id,
        SobjectType = 'Account',
        PermissionsRead = true,
        PermissionsCreate = true,
        PermissionsEdit = true
      ),
      new ObjectPermissions(
        ParentId = reader.Id,
        SobjectType = 'Account',
        PermissionsRead = true
      )
    };
    insert new List<FieldPermissions>{
      new FieldPermissions(
        ParentId = editor.Id,
        SobjectType = 'Account',
        Field = 'Account.Description',
        PermissionsRead = true,
        PermissionsEdit = true
      ),
      new FieldPermissions(
        ParentId = reader.Id,
        SobjectType = 'Account',
        Field = 'Account.Description',
        PermissionsRead = true
      )
    };
    PermissionSetGroup psGroup = new PermissionSetGroup(
      DeveloperName = 'OiPermGroup',
      MasterLabel = 'OI Perm Group'
    );
    insert psGroup;
    insert new PermissionSetGroupComponent(
      PermissionSetGroupId = psGroup.Id,
      PermissionSetId = editor.Id
    );
  }

  private static User admin() {
    User u = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    OrgSecurityTestSupport.assign(u.Id, new List<String>{ 'OiPermEditor' });
    return u;
  }

  @IsTest
  static void overviewListsContainersAndKeyPermissions() {
    setupPermissionSets();
    User u = admin();
    OrgPermissionAnalysisService.Overview overview;
    System.runAs(u) {
      overview = OrgPermissionAnalysisService.overview();
    }
    Assert.isTrue(overview.activeUsers >= 1);
    Assert.isFalse(overview.keyPermissions.isEmpty());
    Assert.isNotNull(overview.durationMs);
    Boolean editorFound = false;
    Boolean groupFound = false;
    for (OrgPermissionAnalysisService.Container c : overview.containers) {
      String json = JSON.serialize(c);
      if (json.contains('OI Perm Editor')) {
        editorFound = true;
      }
      if (json.contains('OI Perm Group')) {
        groupFound = true;
      }
    }
    Assert.isTrue(editorFound, 'permission set de test listé');
    Assert.isTrue(groupFound, 'groupe de test listé');
    Assert.isFalse(OrgPermissionAnalysisService.keyPermissions().isEmpty());
  }

  @IsTest
  static void usersCountsAssignments() {
    setupPermissionSets();
    User u = admin();
    OrgPermissionAnalysisService.Users result;
    System.runAs(u) {
      result = OrgPermissionAnalysisService.users();
    }
    Assert.isTrue(result.activeUsers >= 1);
    Assert.isFalse(result.distribution.isEmpty());
    Boolean found = false;
    for (OrgPermissionAnalysisService.UserRow row : result.top) {
      if (row.id == u.Id) {
        found = true;
        Assert.isTrue(row.permissionSets >= 3, 'socle, module et éditeur');
      }
    }
    Assert.isTrue(found || result.top.size() >= 300);
  }

  @IsTest
  static void objectAccessReadsEachContainer() {
    setupPermissionSets();
    OrgPermissionAnalysisService.ObjectAccess empty = OrgPermissionAnalysisService.objectAccess(
      new List<Id>()
    );
    Assert.isTrue(empty.entries.isEmpty());

    PermissionSet blank = new PermissionSet(
      Name = 'OiPermBlank',
      Label = 'OI Perm Blank'
    );
    insert blank;
    OrgPermissionAnalysisService.ObjectAccess result = OrgPermissionAnalysisService.objectAccess(
      new List<Id>{ editor.Id, reader.Id, blank.Id }
    );
    Assert.isTrue(result.pending.isEmpty());
    Assert.isTrue(result.entries.get(editor.Id).contains('Account:RCE'));
    Assert.isTrue(result.entries.get(reader.Id).contains('Account:R'));
    Assert.isTrue(result.entries.get(blank.Id).isEmpty());
  }

  @IsTest
  static void fieldAccessReadsTheFieldPermissions() {
    setupPermissionSets();
    OrgPermissionAnalysisService.FieldAccess result = OrgPermissionAnalysisService.fieldAccess(
      ' Account '
    );
    Assert.areEqual('Account', result.objectName);
    Assert.isFalse(result.fields.isEmpty());
    Assert.isTrue(result.entries.get(editor.Id).contains('Description:RE'));
    Assert.isTrue(result.entries.get(reader.Id).contains('Description:R'));
  }

  @IsTest
  static void fieldAccessRejectsInvalidObjects() {
    for (String name : new List<String>{ '', 'Not_An_Object__zz' }) {
      try {
        OrgPermissionAnalysisService.fieldAccess(name);
        Assert.fail('objet refusé : ' + name);
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('object'), e.getMessage());
      }
    }
  }

  @IsTest
  static void compareListsTheDifferences() {
    setupPermissionSets();
    OrgPermissionAnalysisService.Comparison result = OrgPermissionAnalysisService.compare(
      editor.Id,
      reader.Id
    );
    Assert.areEqual('OI Perm Editor', result.leftName);
    Assert.areEqual('OI Perm Reader', result.rightName);
    Assert.isTrue(result.systemDifferences >= 1, 'API Enabled');
    Assert.areEqual(1, result.objectDifferences);
    Assert.areEqual(1, result.fieldDifferences);
    Assert.isFalse(result.truncated);
    Assert.isFalse(result.differences.isEmpty());
  }

  @IsTest
  static void compareWithAProfile() {
    setupPermissionSets();
    PermissionSet profileSet = [
      SELECT Id
      FROM PermissionSet
      WHERE IsOwnedByProfile = TRUE
      LIMIT 1
    ];
    OrgPermissionAnalysisService.Comparison result = OrgPermissionAnalysisService.compare(
      profileSet.Id,
      reader.Id
    );
    Assert.isNotNull(result.leftName);
  }

  @IsTest
  static void compareRejectsInvalidPairs() {
    setupPermissionSets();
    List<List<Id>> pairs = new List<List<Id>>{
      new List<Id>{ editor.Id, editor.Id },
      new List<Id>{ editor.Id, null }
    };
    for (List<Id> pair : pairs) {
      try {
        OrgPermissionAnalysisService.compare(pair[0], pair[1]);
        Assert.fail('paire refusée');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('two different'));
      }
    }
    Id removed = reader.Id;
    delete [SELECT Id FROM FieldPermissions WHERE ParentId = :removed];
    delete [SELECT Id FROM ObjectPermissions WHERE ParentId = :removed];
    delete new PermissionSet(Id = removed);
    try {
      OrgPermissionAnalysisService.compare(editor.Id, removed);
      Assert.fail('permission set supprimé');
    } catch (AuraHandledException e) {
      Assert.isTrue(e.getMessage().contains('no longer exists'));
    }
  }
}
