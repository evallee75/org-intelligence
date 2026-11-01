/**
 * Analyse des profils, permission sets et permission set groups (section « Profiles & Permission
 * Sets » du module Security). Lecture seule, sans objet : le navigateur appelle les actions l'une
 * après l'autre, garde le résultat et calcule les constats (orgIntelPermissionsModel).
 *
 * Découpage en actions, chacune dans sa propre transaction (limites de lignes) :
 * - overview()          : profils, permission sets, groupes, permissions système clés, assignations
 *                         et nombre d'objets par conteneur (agrégats : une ligne par groupe) ;
 * - users()             : nombre de permission sets / groupes par utilisateur actif ;
 * - objectAccess(ids)   : droits objet d'une partie des conteneurs (le navigateur rappelle avec
 *                         les conteneurs restants tant que `pending` n'est pas vide) ;
 * - fieldAccess(objet)  : FLS d'un objet, à la demande ;
 * - compare(a, b)       : différences entre deux conteneurs (permissions système, objets, champs).
 *
 * Sans partage : les objets de configuration lus ici ne relèvent pas du partage, et les comptages
 * d'utilisateurs doivent porter sur toute l'org. Réservé aux administrateurs (contrôlé par l'appelant).
 */
public without sharing class OrgPermissionAnalysisService {
  public static final String KIND_PROFILE = 'Profile';
  public static final String KIND_PERMISSION_SET = 'PermissionSet';
  public static final String KIND_GROUP = 'PermissionSetGroup';
  public static final String KIND_MUTING = 'Muting';

  /** Lignes gardées en réserve dans chaque transaction (journal API, requêtes de fin). */
  private static final Integer RESERVED_ROWS = 2000;
  /** Lignes de droits objet lues au plus par appel (taille de la réponse et temps CPU). */
  private static final Integer OBJECT_ROWS_PER_CALL = 20000;
  /** Lignes de FLS lues au plus par appel. */
  private static final Integer FIELD_ROWS_PER_CALL = 40000;
  /** Conteneurs lus au plus (permission sets compris). */
  private static final Integer CONTAINER_CAP = 5000;
  /** Utilisateurs détaillés dans la liste « Users ». */
  private static final Integer USER_LIST_CAP = 300;

  /**
   * Permissions système affichées dans les listes (ordre d'affichage), filtrées sur celles qui
   * existent dans l'org. Les permissions d'administration de l'audit viennent en premier.
   */
  private static final List<String> KEY_PERMISSION_FIELDS = new List<String>{
    'PermissionsModifyAllData',
    'PermissionsViewAllData',
    'PermissionsManageUsers',
    'PermissionsCustomizeApplication',
    'PermissionsAuthorApex',
    'PermissionsModifyMetadata',
    'PermissionsManageProfilesPermissionsets',
    'PermissionsAssignPermissionSets',
    'PermissionsManageInternalUsers',
    'PermissionsResetPasswords',
    'PermissionsManageSharing',
    'PermissionsManageRoles',
    'PermissionsViewAllUsers',
    'PermissionsViewSetup',
    'PermissionsApiEnabled',
    'PermissionsExportReport',
    'PermissionsManageDataIntegrations',
    'PermissionsBulkApiHardDelete',
    'PermissionsTransferAnyEntity',
    'PermissionsViewEncryptedData',
    'PermissionsInstallPackaging',
    'PermissionsPasswordNeverExpires'
  };

  // ---------- Résultats ----------

  public class Permission {
    public String field;
    public String label;
    public Boolean powerful = false;
  }

  /** Profil, permission set, groupe ou muting permission set (« conteneur » de droits). */
  public class Container {
    /** Id du PermissionSet (celui du profil ou du groupe) : clé des droits objet et champ. */
    public Id id;
    public String kind;
    /** Type du PermissionSet : Profile, Regular, Session, Standard, Group, Muting. */
    public String type;
    public String name;
    public String apiName;
    public Id profileId;
    public Id groupId;
    public String license;
    public Boolean isCustom = false;
    public String namespace;
    public String description;
    public Datetime lastModified;
    public String lastModifiedBy;
    public String status;
    /** Profil : utilisateurs actifs ; autres : assignations à des utilisateurs actifs. */
    public Integer activeUsers = 0;
    public Integer inactiveUsers = 0;
    public List<String> permissions = new List<String>();
    public Integer objectCount = 0;
    public Integer modifyAllObjects = 0;
    public Integer viewAllObjects = 0;
    /** Permission set : groupes qui le contiennent (Id du groupe). Groupe : ses composants (Id de PermissionSet). */
    public List<Id> groups = new List<Id>();
    public List<Id> components = new List<Id>();
  }

  public class Overview {
    public Datetime generatedAt;
    public String runBy;
    public String orgName;
    public Boolean isSandbox;
    public Integer activeUsers = 0;
    public Integer activeStandardUsers = 0;
    public List<Permission> keyPermissions = new List<Permission>();
    public List<Container> containers = new List<Container>();
    public Boolean truncated = false;
    public Long durationMs;
  }

  public class UserRow {
    public Id id;
    public String name;
    public String username;
    public String profile;
    public String userType;
    public Datetime lastLogin;
    public Integer permissionSets = 0;
    public Integer groups = 0;
  }

  public class Users {
    public Integer activeUsers = 0;
    /** Utilisateurs actifs standard sans permission set ni groupe (droits portés par le profil seul). */
    public Integer profileOnlyUsers = 0;
    public List<UserRow> profileOnly = new List<UserRow>();
    /** Utilisateurs actifs triés par nombre de permission sets décroissant (borné). */
    public List<UserRow> top = new List<UserRow>();
    /** Répartition : nombre de permission sets + groupes → nombre d'utilisateurs. */
    public Map<Integer, Integer> distribution = new Map<Integer, Integer>();
    public Boolean truncated = false;
  }

  public class ObjectAccess {
    /** Conteneur → entrées « Objet:lettres » (R lecture, C création, E modification, D suppression, V View All, M Modify All). */
    public Map<Id, List<String>> entries = new Map<Id, List<String>>();
    /** Conteneurs pas encore lus : à renvoyer au prochain appel. */
    public List<Id> pending = new List<Id>();
  }

  public class FieldInfo {
    public String name;
    public String label;
    public String type;
    public Boolean custom = false;
    public Boolean required = false;
  }

  public class FieldAccess {
    public String objectName;
    public String objectLabel;
    public List<FieldInfo> fields = new List<FieldInfo>();
    /** Conteneur → entrées « Champ:lettres » (R lecture, E modification). */
    public Map<Id, List<String>> entries = new Map<Id, List<String>>();
    public Boolean truncated = false;
    public Datetime generatedAt;
  }

  public class Difference {
    public String area;
    public String item;
    public String label;
    public String left;
    public String right;
  }

  public class Comparison {
    public Id leftId;
    public Id rightId;
    public String leftName;
    public String rightName;
    public List<Difference> differences = new List<Difference>();
    public Integer systemDifferences = 0;
    public Integer objectDifferences = 0;
    public Integer fieldDifferences = 0;
    public Boolean truncated = false;
    public Datetime generatedAt;
  }

  // ---------- Vue d'ensemble ----------

  public static Overview overview() {
    Long started = System.currentTimeMillis();
    Overview result = new Overview();
    result.generatedAt = Datetime.now();
    result.runBy = UserInfo.getName();
    Organization org = [SELECT Name, IsSandbox FROM Organization LIMIT 1];
    result.orgName = org.Name;
    result.isSandbox = org.IsSandbox;
    result.keyPermissions = keyPermissions();

    List<String> fields = new List<String>();
    for (Permission p : result.keyPermissions) {
      fields.add(p.field);
    }
    Integer cap = Math.min(
      CONTAINER_CAP,
      OrgSecurityChecks.rowsLeft(RESERVED_ROWS)
    );
    List<PermissionSet> sets = Database.query(
      'SELECT Id, Name, Label, Type, IsOwnedByProfile, IsCustom, NamespacePrefix, Description, ' +
        'LastModifiedDate, LastModifiedBy.Name, ProfileId, Profile.Name, Profile.LastModifiedDate, ' +
        'Profile.LastModifiedBy.Name, Profile.UserType, License.Name, PermissionSetGroupId, ' +
        String.join(fields, ', ') +
        ' FROM PermissionSet ORDER BY Label LIMIT ' +
        cap
    );
    result.truncated = sets.size() >= cap;

    Map<Id, Container> byId = new Map<Id, Container>();
    Map<Id, Container> byGroupId = new Map<Id, Container>();
    for (PermissionSet ps : sets) {
      Container c = new Container();
      c.id = ps.Id;
      c.type = ps.Type;
      c.license = ps.License?.Name;
      c.isCustom = ps.IsCustom;
      c.namespace = ps.NamespacePrefix;
      c.description = ps.Description;
      if (ps.IsOwnedByProfile) {
        c.kind = KIND_PROFILE;
        c.profileId = ps.ProfileId;
        c.name = ps.Profile?.Name;
        c.apiName = ps.Profile?.Name;
        c.lastModified = ps.Profile?.LastModifiedDate;
        c.lastModifiedBy = ps.Profile?.LastModifiedBy?.Name;
      } else {
        c.kind = ps.Type == 'Group'
          ? KIND_GROUP
          : ps.Type == 'Muting' ? KIND_MUTING : KIND_PERMISSION_SET;
        c.name = ps.Label;
        c.apiName = ps.Name;
        c.lastModified = ps.LastModifiedDate;
        c.lastModifiedBy = ps.LastModifiedBy?.Name;
        c.groupId = ps.PermissionSetGroupId;
      }
      for (String field : fields) {
        if (ps.get(field) == true) {
          c.permissions.add(field);
        }
      }
      byId.put(c.id, c);
      if (c.kind == KIND_GROUP && c.groupId != null) {
        byGroupId.put(c.groupId, c);
      }
      result.containers.add(c);
    }

    loadGroups(byGroupId, byId);
    loadAssignments(byId);
    loadObjectCounts(byId);

    Map<Id, Integer> usersByProfile = OrgSecurityChecks.activeUsersByProfile();
    for (Container c : result.containers) {
      if (c.kind == KIND_PROFILE && usersByProfile.containsKey(c.profileId)) {
        c.activeUsers = usersByProfile.get(c.profileId);
      }
    }
    for (Integer n : usersByProfile.values()) {
      result.activeUsers += n;
    }
    for (AggregateResult row : [
      SELECT COUNT(Id) total
      FROM User
      WHERE IsActive = TRUE AND UserType = 'Standard'
    ]) {
      result.activeStandardUsers = (Integer) row.get('total');
    }
    result.durationMs = System.currentTimeMillis() - started;
    return result;
  }

  /** Permissions système clés présentes dans l'org, avec leur libellé Salesforce. */
  public static List<Permission> keyPermissions() {
    Map<String, Schema.SObjectField> describe = Schema.SObjectType.PermissionSet.fields.getMap();
    List<Permission> result = new List<Permission>();
    for (String field : KEY_PERMISSION_FIELDS) {
      Schema.SObjectField token = describe.get(field);
      if (token == null) {
        continue;
      }
      Permission p = new Permission();
      p.field = field;
      p.label = token.getDescribe().getLabel();
      p.powerful = OrgSecurityChecks.ADMIN_PERMISSIONS.containsKey(field);
      result.add(p);
    }
    return result;
  }

  /** Groupes : statut, composants (permission sets et muting) et rattachement inverse. */
  private static void loadGroups(
    Map<Id, Container> byGroupId,
    Map<Id, Container> byId
  ) {
    if (byGroupId.isEmpty()) {
      return;
    }
    for (PermissionSetGroup g : [
      SELECT
        Id,
        DeveloperName,
        MasterLabel,
        Status,
        NamespacePrefix,
        Description
      FROM PermissionSetGroup
      WHERE Id IN :byGroupId.keySet()
    ]) {
      Container c = byGroupId.get(g.Id);
      c.name = g.MasterLabel;
      c.apiName = g.DeveloperName;
      c.status = g.Status;
      c.namespace = g.NamespacePrefix;
      c.description = g.Description;
    }
    Integer cap = OrgSecurityChecks.rowsLeft(RESERVED_ROWS);
    for (
      PermissionSetGroupComponent component : Database.query(
        'SELECT PermissionSetGroupId, PermissionSetId FROM PermissionSetGroupComponent LIMIT ' +
        cap
      )
    ) {
      Container g = byGroupId.get(component.PermissionSetGroupId);
      Container ps = byId.get(component.PermissionSetId);
      if (g == null || ps == null) {
        continue;
      }
      g.components.add(ps.id);
      ps.groups.add(g.groupId);
    }
  }

  /** Assignations (hors profils) à des utilisateurs actifs et inactifs, par permission set. */
  private static void loadAssignments(Map<Id, Container> byId) {
    Integer cap = OrgSecurityChecks.rowsLeft(RESERVED_ROWS);
    for (
      AggregateResult row : Database.query(
        'SELECT PermissionSetId psId, Assignee.IsActive active, COUNT(Id) total ' +
          'FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false ' +
          'GROUP BY PermissionSetId, Assignee.IsActive LIMIT ' +
          cap
      )
    ) {
      Container c = byId.get((Id) row.get('psId'));
      if (c == null) {
        continue;
      }
      Integer total = (Integer) row.get('total');
      if (row.get('active') == true) {
        c.activeUsers += total;
      } else {
        c.inactiveUsers += total;
      }
    }
  }

  /** Nombre d'objets accessibles, et avec View All / Modify All, par conteneur (agrégats). */
  private static void loadObjectCounts(Map<Id, Container> byId) {
    Integer cap = OrgSecurityChecks.rowsLeft(RESERVED_ROWS);
    for (
      AggregateResult row : Database.query(
        'SELECT ParentId parentId, COUNT(Id) total FROM ObjectPermissions GROUP BY ParentId LIMIT ' +
        cap
      )
    ) {
      Container c = byId.get((Id) row.get('parentId'));
      if (c != null) {
        c.objectCount = (Integer) row.get('total');
      }
    }
    cap = OrgSecurityChecks.rowsLeft(RESERVED_ROWS);
    for (
      AggregateResult row : Database.query(
        'SELECT ParentId parentId, COUNT(Id) total FROM ObjectPermissions ' +
          'WHERE PermissionsModifyAllRecords = true GROUP BY ParentId LIMIT ' +
          cap
      )
    ) {
      Container c = byId.get((Id) row.get('parentId'));
      if (c != null) {
        c.modifyAllObjects = (Integer) row.get('total');
      }
    }
    cap = OrgSecurityChecks.rowsLeft(RESERVED_ROWS);
    for (
      AggregateResult row : Database.query(
        'SELECT ParentId parentId, COUNT(Id) total FROM ObjectPermissions ' +
          'WHERE PermissionsViewAllRecords = true GROUP BY ParentId LIMIT ' +
          cap
      )
    ) {
      Container c = byId.get((Id) row.get('parentId'));
      if (c != null) {
        c.viewAllObjects = (Integer) row.get('total');
      }
    }
  }

  // ---------- Utilisateurs ----------

  public static Users users() {
    Users result = new Users();
    Map<Id, UserRow> rows = new Map<Id, UserRow>();
    Integer cap = OrgSecurityChecks.rowsLeft(RESERVED_ROWS);
    // Une ligne de résultat par utilisateur et par type : borné aux lignes restantes
    List<AggregateResult> grouped = Database.query(
      'SELECT AssigneeId userId, PermissionSet.Type psType, COUNT(Id) total ' +
        'FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false ' +
        'AND Assignee.IsActive = true GROUP BY AssigneeId, PermissionSet.Type LIMIT ' +
        cap
    );
    result.truncated = grouped.size() >= cap;
    for (AggregateResult row : grouped) {
      Id userId = (Id) row.get('userId');
      UserRow u = rows.get(userId);
      if (u == null) {
        u = new UserRow();
        u.id = userId;
        rows.put(userId, u);
      }
      Integer total = (Integer) row.get('total');
      if (row.get('psType') == 'Group') {
        u.groups += total;
      } else if (row.get('psType') != 'Muting') {
        u.permissionSets += total;
      }
    }
    for (UserRow u : rows.values()) {
      Integer n = u.permissionSets + u.groups;
      result.distribution.put(
        n,
        (result.distribution.containsKey(n) ? result.distribution.get(n) : 0) +
        1
      );
    }

    // Les plus dotés d'abord : tri par nombre, puis lecture des utilisateurs retenus
    List<UserRow> sorted = rows.values();
    sorted.sort(new ByAssignments());
    List<UserRow> top = new List<UserRow>();
    for (Integer i = 0; i < Math.min(USER_LIST_CAP, sorted.size()); i++) {
      top.add(sorted[i]);
    }
    Map<Id, UserRow> topById = new Map<Id, UserRow>();
    for (UserRow u : top) {
      topById.put(u.id, u);
    }
    for (User u : [
      SELECT Id, Name, Username, Profile.Name, UserType, LastLoginDate
      FROM User
      WHERE Id IN :topById.keySet()
    ]) {
      fill(topById.get(u.Id), u);
    }
    result.top = top;

    for (AggregateResult row : [
      SELECT COUNT(Id) total
      FROM User
      WHERE IsActive = TRUE
    ]) {
      result.activeUsers = (Integer) row.get('total');
    }
    cap = Math.min(USER_LIST_CAP, OrgSecurityChecks.rowsLeft(RESERVED_ROWS));
    for (
      User u : Database.query(
        'SELECT Id, Name, Username, Profile.Name, UserType, LastLoginDate FROM User ' +
          'WHERE IsActive = true AND UserType = \'Standard\' AND Id NOT IN ' +
          '(SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false) ' +
          'ORDER BY Name LIMIT ' +
          cap
      )
    ) {
      UserRow row = new UserRow();
      fill(row, u);
      result.profileOnly.add(row);
    }
    for (AggregateResult row : [
      SELECT COUNT(Id) total
      FROM User
      WHERE
        IsActive = TRUE
        AND UserType = 'Standard'
        AND Id NOT IN (
          SELECT AssigneeId
          FROM PermissionSetAssignment
          WHERE PermissionSet.IsOwnedByProfile = FALSE
        )
    ]) {
      result.profileOnlyUsers = (Integer) row.get('total');
    }
    return result;
  }

  private static void fill(UserRow row, User u) {
    row.id = u.Id;
    row.name = u.Name;
    row.username = u.Username;
    row.profile = u.Profile?.Name;
    row.userType = u.UserType;
    row.lastLogin = u.LastLoginDate;
  }

  private class ByAssignments implements Comparator<UserRow> {
    public Integer compare(UserRow a, UserRow b) {
      return (b.permissionSets + b.groups) - (a.permissionSets + a.groups);
    }
  }

  // ---------- Droits objet ----------

  /**
   * Droits objet d'une liste de conteneurs, triés par conteneur. Si la limite de lignes de l'appel
   * est atteinte, le dernier conteneur (peut-être incomplet) et les suivants sont renvoyés dans
   * `pending` pour un nouvel appel.
   */
  public static ObjectAccess objectAccess(List<Id> containerIds) {
    ObjectAccess result = new ObjectAccess();
    if (containerIds == null || containerIds.isEmpty()) {
      return result;
    }
    Set<Id> ids = new Set<Id>(containerIds);
    Integer cap = Math.min(
      OBJECT_ROWS_PER_CALL,
      OrgSecurityChecks.rowsLeft(RESERVED_ROWS)
    );
    Integer read = 0;
    Id last;
    for (
      List<ObjectPermissions> batch : Database.query(
        'SELECT ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, ' +
          'PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords ' +
          'FROM ObjectPermissions WHERE ParentId IN :ids ORDER BY ParentId, SobjectType LIMIT ' +
          cap
      )
    ) {
      for (ObjectPermissions op : batch) {
        read++;
        last = op.ParentId;
        List<String> entries = result.entries.get(op.ParentId);
        if (entries == null) {
          entries = new List<String>();
          result.entries.put(op.ParentId, entries);
        }
        entries.add(op.SobjectType + ':' + objectFlags(op));
      }
    }
    if (read >= cap) {
      // Limite atteinte : le dernier conteneur est peut-être tronqué, il sera relu entièrement
      // avec ceux qui n'ont pas été lus (chaque appel progresse d'au moins un conteneur)
      if (last != null) {
        result.entries.remove(last);
      }
      for (Id id : containerIds) {
        if (!result.entries.containsKey(id)) {
          result.pending.add(id);
        }
      }
    } else {
      // Conteneurs sans aucun droit objet : liste vide (lus, rien à garder)
      for (Id id : containerIds) {
        if (!result.entries.containsKey(id)) {
          result.entries.put(id, new List<String>());
        }
      }
    }
    return result;
  }

  private static String objectFlags(ObjectPermissions op) {
    return (op.PermissionsRead ? 'R' : '') +
      (op.PermissionsCreate ? 'C' : '') +
      (op.PermissionsEdit ? 'E' : '') +
      (op.PermissionsDelete ? 'D' : '') +
      (op.PermissionsViewAllRecords ? 'V' : '') +
      (op.PermissionsModifyAllRecords ? 'M' : '');
  }

  // ---------- FLS ----------

  /** FLS de tous les conteneurs sur un objet (champ × conteneur, lecture / modification). */
  public static FieldAccess fieldAccess(String objectName) {
    Schema.DescribeSObjectResult describe = describeObject(objectName);
    FieldAccess result = new FieldAccess();
    result.generatedAt = Datetime.now();
    result.objectName = describe.getName();
    result.objectLabel = describe.getLabel();
    for (Schema.SObjectField token : describe.fields.getMap().values()) {
      Schema.DescribeFieldResult field = token.getDescribe();
      // Les champs sans FLS (Id, champs système, obligatoires) ne figurent pas dans FieldPermissions
      if (!field.isPermissionable()) {
        continue;
      }
      FieldInfo info = new FieldInfo();
      info.name = field.getName();
      info.label = field.getLabel();
      info.type = String.valueOf(field.getType());
      info.custom = field.isCustom();
      info.required = !field.isNillable() && field.isCreateable();
      result.fields.add(info);
    }
    String sobjectType = result.objectName;
    Integer cap = Math.min(
      FIELD_ROWS_PER_CALL,
      OrgSecurityChecks.rowsLeft(RESERVED_ROWS)
    );
    Integer read = 0;
    for (
      List<FieldPermissions> batch : Database.query(
        'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions ' +
          'WHERE SobjectType = :sobjectType LIMIT ' +
          cap
      )
    ) {
      for (FieldPermissions fp : batch) {
        read++;
        List<String> entries = result.entries.get(fp.ParentId);
        if (entries == null) {
          entries = new List<String>();
          result.entries.put(fp.ParentId, entries);
        }
        entries.add(fieldName(fp.Field) + ':' + fieldFlags(fp));
      }
    }
    result.truncated = read >= cap;
    return result;
  }

  /** « Account.Name » → « Name ». */
  private static String fieldName(String qualified) {
    return qualified == null ? '' : qualified.substringAfter('.');
  }

  private static String fieldFlags(FieldPermissions fp) {
    return (fp.PermissionsRead ? 'R' : '') + (fp.PermissionsEdit ? 'E' : '');
  }

  private static Schema.DescribeSObjectResult describeObject(
    String objectName
  ) {
    if (String.isBlank(objectName)) {
      throw OrgIntelAccess.error('Choose an object.');
    }
    try {
      return Schema.describeSObjects(new List<String>{ objectName.trim() })[0];
    } catch (Exception e) {
      throw OrgIntelAccess.error('Unknown object: ' + objectName);
    }
  }

  // ---------- Comparaison ----------

  /** Différences entre deux conteneurs : toutes les permissions système, droits objet et FLS. */
  public static Comparison compare(Id leftId, Id rightId) {
    if (leftId == null || rightId == null || leftId == rightId) {
      throw OrgIntelAccess.error(
        'Choose two different profiles or permission sets.'
      );
    }
    Comparison result = new Comparison();
    result.generatedAt = Datetime.now();
    result.leftId = leftId;
    result.rightId = rightId;

    Map<String, Schema.SObjectField> describe = Schema.SObjectType.PermissionSet.fields.getMap();
    List<String> fields = new List<String>();
    for (String key : describe.keySet()) {
      Schema.DescribeFieldResult field = describe.get(key).getDescribe();
      if (
        field.getName().startsWith('Permissions') &&
        field.getType() == Schema.DisplayType.BOOLEAN
      ) {
        fields.add(field.getName());
      }
    }
    Set<Id> ids = new Set<Id>{ leftId, rightId };
    Map<Id, PermissionSet> sets = new Map<Id, PermissionSet>(
      (List<PermissionSet>) Database.query(
        'SELECT Id, Label, IsOwnedByProfile, Profile.Name, ' +
          String.join(fields, ', ') +
          ' FROM PermissionSet WHERE Id IN :ids'
      )
    );
    PermissionSet left = sets.get(leftId);
    PermissionSet right = sets.get(rightId);
    if (left == null || right == null) {
      throw OrgIntelAccess.error(
        'One of the profiles or permission sets no longer exists.'
      );
    }
    result.leftName = left.IsOwnedByProfile ? left.Profile?.Name : left.Label;
    result.rightName = right.IsOwnedByProfile
      ? right.Profile?.Name
      : right.Label;

    fields.sort();
    for (String field : fields) {
      Boolean a = left.get(field) == true;
      Boolean b = right.get(field) == true;
      if (a != b) {
        addDifference(
          result,
          'System',
          field,
          describe.get(field).getDescribe().getLabel(),
          a ? 'Yes' : '',
          b ? 'Yes' : ''
        );
        result.systemDifferences++;
      }
    }

    ObjectAccess objects = objectAccess(new List<Id>{ leftId, rightId });
    Map<String, String> leftObjects = entryMap(objects.entries.get(leftId));
    Map<String, String> rightObjects = entryMap(objects.entries.get(rightId));
    result.truncated = !objects.pending.isEmpty();
    result.objectDifferences = diffEntries(
      result,
      'Object',
      leftObjects,
      rightObjects
    );

    Integer cap = Math.min(
      FIELD_ROWS_PER_CALL,
      OrgSecurityChecks.rowsLeft(RESERVED_ROWS)
    );
    Map<String, String> leftFields = new Map<String, String>();
    Map<String, String> rightFields = new Map<String, String>();
    Integer read = 0;
    for (
      List<FieldPermissions> batch : Database.query(
        'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions ' +
          'WHERE ParentId IN :ids LIMIT ' +
          cap
      )
    ) {
      for (FieldPermissions fp : batch) {
        read++;
        if (fp.ParentId == leftId) {
          leftFields.put(fp.Field, fieldFlags(fp));
        } else {
          rightFields.put(fp.Field, fieldFlags(fp));
        }
      }
    }
    result.truncated = result.truncated || read >= cap;
    result.fieldDifferences = diffEntries(
      result,
      'Field',
      leftFields,
      rightFields
    );
    return result;
  }

  private static Map<String, String> entryMap(List<String> entries) {
    Map<String, String> result = new Map<String, String>();
    for (String entry : entries == null ? new List<String>() : entries) {
      result.put(entry.substringBeforeLast(':'), entry.substringAfterLast(':'));
    }
    return result;
  }

  private static Integer diffEntries(
    Comparison result,
    String area,
    Map<String, String> left,
    Map<String, String> right
  ) {
    Set<String> keys = new Set<String>(left.keySet());
    keys.addAll(right.keySet());
    List<String> sorted = new List<String>(keys);
    sorted.sort();
    Integer count = 0;
    for (String key : sorted) {
      String a = left.containsKey(key) ? left.get(key) : '';
      String b = right.containsKey(key) ? right.get(key) : '';
      if (a != b) {
        addDifference(result, area, key, key, a, b);
        count++;
      }
    }
    return count;
  }

  private static void addDifference(
    Comparison result,
    String area,
    String item,
    String label,
    String left,
    String right
  ) {
    Difference d = new Difference();
    d.area = area;
    d.item = item;
    d.label = label;
    d.left = left;
    d.right = right;
    result.differences.add(d);
  }
}
