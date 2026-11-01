/**
 * Recommandations : liste, détail, décisions, assignation et collaboration.
 *
 * La collaboration s'appuie sur les mécanismes natifs : fil Chatter de l'enregistrement (commentaires,
 * @mentions et leurs notifications), abonnements (suivre une recommandation) et historique des
 * champs (décisions). Toutes les lectures et écritures se font avec les droits de l'utilisateur.
 */
public inherited sharing class OrgRecommendationService {
  @TestVisible
  private static final Integer LIST_LIMIT = 2000;
  private static final Integer FEED_PAGE_SIZE = 50;
  private static final Set<String> DECISION_STATUSES = new Set<String>{
    OrgIntelligenceConstants.REC_IGNORED,
    OrgIntelligenceConstants.REC_RESOLVED
  };

  public class RecommendationException extends Exception {
  }

  // ---------- Liste ----------

  public static RecommendationList listRecommendations() {
    RecommendationList result = new RecommendationList();
    result.currentUserId = UserInfo.getUserId();
    result.rows = new List<Row>();
    List<OrgRecommendation__c> records = [
      SELECT
        Id,
        Name,
        Title__c,
        Severity__c,
        SeverityRank__c,
        Category__c,
        Confidence__c,
        Status__c,
        ComponentType__c,
        ComponentName__c,
        RuleCode__c,
        Domain__c,
        Fingerprint__c,
        JiraIssueKey__c,
        JiraIssueUrl__c,
        AssignedTo__c,
        AssignedTo__r.Name,
        DueDate__c,
        LastDetectedAt__c,
        StillDetected__c,
        OccurrenceCount__c,
        IsOpen__c,
        StatusChangedAt__c,
        CreatedDate,
        LastModifiedDate
      FROM OrgRecommendation__c
      WITH USER_MODE
      ORDER BY
        IsOpen__c DESC,
        SeverityRank__c ASC,
        LastDetectedAt__c DESC NULLS LAST
      LIMIT :LIST_LIMIT
    ];
    Map<Id, Integer> comments = commentCounts(
      new Map<Id, OrgRecommendation__c>(records).keySet()
    );
    for (OrgRecommendation__c record : records) {
      Row row = new Row(record);
      row.commentCount = comments.containsKey(record.Id)
        ? comments.get(record.Id)
        : 0;
      result.rows.add(row);
    }
    result.truncated = records.size() == LIST_LIMIT;
    return result;
  }

  private static Map<Id, Integer> commentCounts(Set<Id> recordIds) {
    Map<Id, Integer> result = new Map<Id, Integer>();
    if (recordIds.isEmpty()) {
      return result;
    }
    try {
      for (FeedItem item : [
        SELECT ParentId
        FROM FeedItem
        WHERE ParentId IN :recordIds AND Type = 'TextPost'
        WITH USER_MODE
        LIMIT 10000
      ]) {
        result.put(
          item.ParentId,
          (result.containsKey(item.ParentId) ? result.get(item.ParentId) : 0) +
          1
        );
      }
    } catch (Exception e) {
      // Chatter désactivé ou non accessible : compteur non affiché
      System.debug(LoggingLevel.FINE, e.getMessage());
    }
    return result;
  }

  // ---------- Détail ----------

  public static Detail getDetail(Id recordId) {
    List<OrgRecommendation__c> records = [
      SELECT
        Id,
        Name,
        Title__c,
        Description__c,
        Justification__c,
        SuggestedAction__c,
        AffectedComponents__c,
        Severity__c,
        Category__c,
        Confidence__c,
        Status__c,
        DecisionReason__c,
        RuleCode__c,
        Domain__c,
        JiraIssueKey__c,
        JiraIssueUrl__c,
        Fingerprint__c,
        ComponentType__c,
        ComponentName__c,
        AssignedTo__c,
        AssignedTo__r.Name,
        DueDate__c,
        FirstDetectedAt__c,
        LastDetectedAt__c,
        LastScanName__c,
        StillDetected__c,
        OccurrenceCount__c,
        StatusChangedAt__c,
        ResolvedDate__c,
        IsOpen__c,
        DaysToResolve__c,
        CreatedDate,
        CreatedBy.Name,
        LastModifiedDate
      FROM OrgRecommendation__c
      WHERE Id = :recordId
      WITH USER_MODE
    ];
    if (records.isEmpty()) {
      throw new RecommendationException(
        'This recommendation does not exist or you cannot access it.'
      );
    }
    OrgRecommendation__c record = records[0];
    Detail detail = new Detail();
    detail.record = new Row(record);
    detail.description = record.Description__c;
    detail.justification = record.Justification__c;
    detail.suggestedAction = record.SuggestedAction__c;
    detail.affectedComponents = String.isBlank(record.AffectedComponents__c)
      ? new List<String>()
      : record.AffectedComponents__c.split('\n');
    detail.decisionReason = record.DecisionReason__c;
    detail.fingerprint = record.Fingerprint__c;
    detail.firstDetectedAt = record.FirstDetectedAt__c;
    detail.lastDetectedScanName = record.LastScanName__c;
    detail.resolvedDate = record.ResolvedDate__c;
    detail.daysToResolve = record.DaysToResolve__c;
    detail.createdByName = record.CreatedBy?.Name;
    detail.rule = loadRule(record.RuleCode__c);
    detail.history = loadHistory(recordId);
    detail.relatedRecommendations = loadRelated(record);
    detail.canEdit = hasEditAccess(recordId);
    detail.isFollowing = isFollowing(recordId);
    detail.comments = loadComments(recordId);
    // Exports de contexte : module Context Hub, s'il est installé
    return detail;
  }

  private static RuleInfo loadRule(String code) {
    if (String.isBlank(code)) {
      return null;
    }
    List<OrgScanRule__mdt> rules = [
      SELECT
        DeveloperName,
        MasterLabel,
        Description__c,
        Threshold__c,
        IsEnabled__c
      FROM OrgScanRule__mdt
      WHERE DeveloperName = :code
    ];
    if (rules.isEmpty()) {
      return null;
    }
    RuleInfo info = new RuleInfo();
    info.code = rules[0].DeveloperName;
    info.label = rules[0].MasterLabel;
    info.description = rules[0].Description__c;
    // Activation et seuil : catalogue fusionné avec les surcharges de Settings (OrgIntelSettings)
    OrgScanRule__mdt effective = OrgIntelSettings.rule(code);
    info.threshold = effective != null
      ? effective.Threshold__c
      : rules[0].Threshold__c;
    info.enabled = effective != null
      ? effective.IsEnabled__c
      : rules[0].IsEnabled__c;
    return info;
  }

  private static final Map<String, String> HISTORY_LABELS = new Map<String, String>{
    'Status__c' => 'Status',
    'Severity__c' => 'Severity',
    'AssignedTo__c' => 'Assigned to',
    'DecisionReason__c' => 'Decision reason',
    'DueDate__c' => 'Due date',
    'created' => 'Created'
  };

  /** Historique des champs (les lignes « Id » des lookups sont doublées par des lignes « nom »). */
  public static List<HistoryEntry> loadHistory(Id recordId) {
    List<HistoryEntry> result = new List<HistoryEntry>();
    for (OrgRecommendation__History row : [
      SELECT
        Field,
        DataType,
        OldValue,
        NewValue,
        CreatedDate,
        CreatedById,
        CreatedBy.Name
      FROM OrgRecommendation__History
      WHERE ParentId = :recordId
      WITH USER_MODE
      ORDER BY CreatedDate DESC
      LIMIT 200
    ]) {
      if (row.DataType == 'EntityId') {
        continue;
      }
      HistoryEntry entry = new HistoryEntry();
      entry.field = row.Field;
      entry.fieldLabel = HISTORY_LABELS.containsKey(row.Field)
        ? HISTORY_LABELS.get(row.Field)
        : row.Field;
      entry.oldValue = row.OldValue == null
        ? null
        : String.valueOf(row.OldValue);
      entry.newValue = row.NewValue == null
        ? null
        : String.valueOf(row.NewValue);
      entry.changedAt = row.CreatedDate;
      entry.changedById = row.CreatedById;
      entry.changedByName = row.CreatedBy?.Name;
      result.add(entry);
    }
    return result;
  }

  private static List<Row> loadRelated(OrgRecommendation__c record) {
    List<Row> result = new List<Row>();
    if (String.isBlank(record.ComponentName__c)) {
      return result;
    }
    for (OrgRecommendation__c related : [
      SELECT
        Id,
        Name,
        Title__c,
        Severity__c,
        SeverityRank__c,
        Category__c,
        Confidence__c,
        Status__c,
        ComponentType__c,
        ComponentName__c,
        RuleCode__c,
        Domain__c,
        Fingerprint__c,
        JiraIssueKey__c,
        JiraIssueUrl__c,
        AssignedTo__c,
        AssignedTo__r.Name,
        DueDate__c,
        LastDetectedAt__c,
        StillDetected__c,
        OccurrenceCount__c,
        IsOpen__c,
        StatusChangedAt__c,
        CreatedDate,
        LastModifiedDate
      FROM OrgRecommendation__c
      WHERE ComponentName__c = :record.ComponentName__c AND Id != :record.Id
      WITH USER_MODE
      ORDER BY SeverityRank__c
      LIMIT 20
    ]) {
      result.add(new Row(related));
    }
    return result;
  }

  private static Boolean hasEditAccess(Id recordId) {
    List<UserRecordAccess> access = [
      SELECT RecordId, HasEditAccess
      FROM UserRecordAccess
      WHERE UserId = :UserInfo.getUserId() AND RecordId = :recordId
    ];
    return !access.isEmpty() &&
      access[0].HasEditAccess &&
      Schema.SObjectType.OrgRecommendation__c.isUpdateable();
  }

  // ---------- Décisions et assignation ----------

  /**
   * Applique les changements demandés (seules les clés présentes sont modifiées) à une ou plusieurs
   * recommandations : status, decisionReason, assignedToId, dueDate, severity.
   */
  public static Integer applyChanges(
    List<Id> recordIds,
    Map<String, Object> changes
  ) {
    if (recordIds == null || recordIds.isEmpty()) {
      throw new RecommendationException('Select at least one recommendation.');
    }
    if (changes == null || changes.isEmpty()) {
      throw new RecommendationException('Nothing to change.');
    }
    String status = (String) changes.get('status');
    String reason = (String) changes.get('decisionReason');
    if (DECISION_STATUSES.contains(status) && String.isBlank(reason)) {
      throw new RecommendationException(
        'Explain the decision: a reason is required to mark a recommendation ' +
          status +
          '.'
      );
    }
    List<OrgRecommendation__c> updates = new List<OrgRecommendation__c>();
    for (Id recordId : recordIds) {
      OrgRecommendation__c record = new OrgRecommendation__c(Id = recordId);
      if (changes.containsKey('status')) {
        record.Status__c = status;
      }
      if (changes.containsKey('decisionReason')) {
        record.DecisionReason__c = String.isBlank(reason)
          ? null
          : reason.abbreviate(255);
      }
      if (changes.containsKey('assignedToId')) {
        String assignee = (String) changes.get('assignedToId');
        record.AssignedTo__c = String.isBlank(assignee)
          ? null
          : Id.valueOf(assignee);
      }
      if (changes.containsKey('dueDate')) {
        String due = (String) changes.get('dueDate');
        record.DueDate__c = String.isBlank(due) ? null : Date.valueOf(due);
      }
      if (changes.containsKey('severity')) {
        record.Severity__c = (String) changes.get('severity');
      }
      updates.add(record);
    }
    if (
      changes.containsKey('severity') &&
      !OrgIntelligenceConstants.SEVERITIES.contains(
        (String) changes.get('severity')
      )
    ) {
      throw new RecommendationException(
        'Unknown severity: ' + changes.get('severity') + '.'
      );
    }
    Database.update(updates, AccessLevel.USER_MODE);
    return updates.size();
  }

  // ---------- Commentaires (Chatter) ----------

  public class MentionInput {
    @AuraEnabled
    public String id { get; set; }
    @AuraEnabled
    public String name { get; set; }
  }

  /**
   * Publie un commentaire sur la recommandation (ou une réponse à un commentaire). Les @mentions
   * deviennent de vraies mentions Chatter : la personne citée est notifiée par Salesforce.
   */
  public static void postComment(
    Id recordId,
    String text,
    List<MentionInput> mentions,
    String parentCommentId
  ) {
    assertRecommendation(recordId);
    if (String.isBlank(text)) {
      throw new RecommendationException('The comment is empty.');
    }
    ConnectApi.MessageBodyInput body = buildBody(text.trim(), mentions);
    if (String.isNotBlank(parentCommentId)) {
      ConnectApi.CommentInput comment = new ConnectApi.CommentInput();
      comment.body = body;
      ConnectApi.ChatterFeeds.postCommentToFeedElement(
        Network.getNetworkId(),
        parentCommentId,
        comment,
        null
      );
    } else {
      ConnectApi.FeedItemInput item = new ConnectApi.FeedItemInput();
      item.subjectId = recordId;
      item.feedElementType = ConnectApi.FeedElementType.FeedItem;
      item.body = body;
      ConnectApi.ChatterFeeds.postFeedElement(Network.getNetworkId(), item);
    }
  }

  /** Découpe le texte en segments texte / mention, dans l'ordre d'apparition des « @Nom ». */
  @TestVisible
  private static ConnectApi.MessageBodyInput buildBody(
    String text,
    List<MentionInput> mentions
  ) {
    ConnectApi.MessageBodyInput body = new ConnectApi.MessageBodyInput();
    body.messageSegments = new List<ConnectApi.MessageSegmentInput>();
    List<MentionInput> pending = mentions == null
      ? new List<MentionInput>()
      : mentions;
    String remaining = text;
    while (remaining.length() > 0) {
      Integer bestIndex = -1;
      MentionInput best;
      for (MentionInput mention : pending) {
        if (String.isBlank(mention?.name) || String.isBlank(mention.id)) {
          continue;
        }
        Integer index = remaining.indexOf('@' + mention.name);
        if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
          bestIndex = index;
          best = mention;
        }
      }
      if (best == null) {
        addText(body, remaining);
        break;
      }
      addText(body, remaining.substring(0, bestIndex));
      ConnectApi.MentionSegmentInput mention = new ConnectApi.MentionSegmentInput();
      mention.id = best.id;
      body.messageSegments.add(mention);
      remaining = remaining.substring(bestIndex + best.name.length() + 1);
    }
    return body;
  }

  private static void addText(ConnectApi.MessageBodyInput body, String text) {
    if (String.isEmpty(text)) {
      return;
    }
    ConnectApi.TextSegmentInput segment = new ConnectApi.TextSegmentInput();
    segment.text = text;
    body.messageSegments.add(segment);
  }

  /** Commentaires (publications texte) du fil de la recommandation, avec leurs réponses. */
  public static List<Comment> loadComments(Id recordId) {
    List<Comment> result = new List<Comment>();
    ConnectApi.FeedElementPage page;
    try {
      page = ConnectApi.ChatterFeeds.getFeedElementsFromFeed(
        Network.getNetworkId(),
        ConnectApi.FeedType.Record,
        recordId,
        null,
        FEED_PAGE_SIZE,
        ConnectApi.FeedSortOrder.CreatedDateDesc
      );
    } catch (Exception e) {
      return result; // Chatter indisponible : pas de commentaires
    }
    for (ConnectApi.FeedElement element : page.elements) {
      if (!(element instanceof ConnectApi.FeedItem)) {
        continue;
      }
      ConnectApi.FeedItem item = (ConnectApi.FeedItem) element;
      if (item.type != ConnectApi.FeedItemType.TextPost) {
        continue;
      }
      Comment comment = new Comment();
      comment.id = item.id;
      comment.createdDate = item.createdDate;
      fillAuthor(comment, item.actor);
      comment.segments = toSegments(item.body);
      comment.replies = new List<Comment>();
      if (item.capabilities?.comments?.page?.items != null) {
        for (ConnectApi.Comment reply : item.capabilities.comments.page.items) {
          Comment child = new Comment();
          child.id = reply.id;
          child.createdDate = reply.createdDate;
          fillAuthor(child, reply.user);
          child.segments = toSegments(reply.body);
          comment.replies.add(child);
        }
      }
      result.add(comment);
    }
    return result;
  }

  private static void fillAuthor(Comment comment, Object actor) {
    if (actor instanceof ConnectApi.UserSummary) {
      ConnectApi.UserSummary user = (ConnectApi.UserSummary) actor;
      comment.authorId = user.id;
      comment.authorName = user.displayName;
      comment.authorPhotoUrl = user.photo?.smallPhotoUrl;
    } else if (actor instanceof ConnectApi.ActorWithId) {
      comment.authorId = ((ConnectApi.ActorWithId) actor).id;
      comment.authorName = ((ConnectApi.ActorWithId) actor).name;
    }
  }

  private static List<Segment> toSegments(ConnectApi.FeedBody body) {
    List<Segment> result = new List<Segment>();
    if (body?.messageSegments == null) {
      return result;
    }
    for (ConnectApi.MessageSegment raw : body.messageSegments) {
      Segment segment = new Segment();
      if (raw instanceof ConnectApi.MentionSegment) {
        ConnectApi.MentionSegment mention = (ConnectApi.MentionSegment) raw;
        segment.type = 'mention';
        segment.text = '@' + mention.name;
        segment.recordId = mention.record?.id;
      } else if (
        raw instanceof ConnectApi.MarkupBeginSegment ||
        raw instanceof ConnectApi.MarkupEndSegment
      ) {
        continue;
      } else {
        segment.type = 'text';
        segment.text = raw.text;
      }
      result.add(segment);
    }
    return result;
  }

  /** Texte brut d'un commentaire (export de contexte). */
  public static String plainText(Comment comment) {
    List<String> parts = new List<String>();
    for (Segment segment : comment.segments) {
      parts.add(segment.text == null ? '' : segment.text);
    }
    return String.join(parts, '');
  }

  // ---------- Suivi (abonnements Chatter) ----------

  public static Boolean isFollowing(Id recordId) {
    try {
      return ![
          SELECT Id
          FROM EntitySubscription
          WHERE ParentId = :recordId AND SubscriberId = :UserInfo.getUserId()
          WITH USER_MODE
          LIMIT 1
        ]
        .isEmpty();
    } catch (Exception e) {
      return false;
    }
  }

  /** Commentaires et abonnements : réservés aux recommandations (pas à n'importe quel enregistrement). */
  private static void assertRecommendation(Id recordId) {
    if (
      recordId == null ||
      recordId.getSObjectType() != OrgRecommendation__c.SObjectType
    ) {
      throw new RecommendationException('This is not a recommendation.');
    }
  }

  public static Boolean setFollowing(Id recordId, Boolean follow) {
    assertRecommendation(recordId);
    follow = follow == true;
    List<EntitySubscription> existing = [
      SELECT Id
      FROM EntitySubscription
      WHERE ParentId = :recordId AND SubscriberId = :UserInfo.getUserId()
      WITH USER_MODE
      LIMIT 1
    ];
    // Suivre / ne plus suivre concerne l'utilisateur courant : droits de l'utilisateur
    if (follow && existing.isEmpty()) {
      Database.insert(
        new EntitySubscription(
          ParentId = recordId,
          SubscriberId = UserInfo.getUserId()
        ),
        AccessLevel.USER_MODE
      );
    } else if (!follow && !existing.isEmpty()) {
      Database.delete(existing, AccessLevel.USER_MODE);
    }
    return follow;
  }

  // ---------- Utilisateurs (assignation, @mentions) ----------

  public static List<UserOption> searchUsers(String term) {
    List<UserOption> result = new List<UserOption>();
    String pattern =
      (String.isBlank(term)
        ? ''
        : term.trim().replace('%', '').replace('_', '\\_')) + '%';
    String anywhere = '% ' + pattern;
    for (User user : [
      SELECT Id, Name, Title, SmallPhotoUrl
      FROM User
      WHERE
        IsActive = TRUE
        AND UserType = 'Standard'
        AND (Name LIKE :pattern
        OR Name LIKE :anywhere
        OR Email LIKE :pattern)
      WITH USER_MODE
      ORDER BY Name
      LIMIT 8
    ]) {
      UserOption option = new UserOption();
      option.id = user.Id;
      option.name = user.Name;
      option.title = user.Title;
      option.photoUrl = user.SmallPhotoUrl;
      result.add(option);
    }
    return result;
  }

  // ---------- Activité récente (vue d'ensemble) ----------

  public static List<Activity> recentActivity(Integer size) {
    List<Activity> result = new List<Activity>();
    for (OrgRecommendation__History row : [
      SELECT
        ParentId,
        Parent.Name,
        Parent.Title__c,
        Field,
        DataType,
        OldValue,
        NewValue,
        CreatedDate,
        CreatedBy.Name
      FROM OrgRecommendation__History
      WHERE DataType != 'EntityId' AND Field != 'created'
      WITH USER_MODE
      ORDER BY CreatedDate DESC
      LIMIT :size
    ]) {
      Activity activity = new Activity();
      activity.recordId = row.ParentId;
      activity.recordName = row.Parent?.Name;
      activity.title = row.Parent?.Title__c;
      activity.fieldLabel = HISTORY_LABELS.containsKey(row.Field)
        ? HISTORY_LABELS.get(row.Field)
        : row.Field;
      activity.oldValue = row.OldValue == null
        ? null
        : String.valueOf(row.OldValue);
      activity.newValue = row.NewValue == null
        ? null
        : String.valueOf(row.NewValue);
      activity.changedAt = row.CreatedDate;
      activity.changedByName = row.CreatedBy?.Name;
      result.add(activity);
    }
    return result;
  }

  // ---------- DTO ----------

  public class RecommendationList {
    @AuraEnabled
    public Id currentUserId;
    @AuraEnabled
    public List<Row> rows;
    @AuraEnabled
    public Boolean truncated;
  }

  public class Row {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String fingerprint;
    @AuraEnabled
    public String title;
    @AuraEnabled
    public String severity;
    @AuraEnabled
    public String category;
    @AuraEnabled
    public String confidence;
    @AuraEnabled
    public String status;
    @AuraEnabled
    public String componentType;
    @AuraEnabled
    public String componentName;
    @AuraEnabled
    public String ruleCode;
    @AuraEnabled
    public String domain;
    @AuraEnabled
    public String jiraIssueKey;
    @AuraEnabled
    public String jiraIssueUrl;
    @AuraEnabled
    public Id assignedToId;
    @AuraEnabled
    public String assignedToName;
    @AuraEnabled
    public Date dueDate;
    @AuraEnabled
    public Datetime lastDetectedAt;
    @AuraEnabled
    public Boolean stillDetected;
    @AuraEnabled
    public Integer occurrenceCount;
    @AuraEnabled
    public Boolean isOpen;
    @AuraEnabled
    public Datetime statusChangedAt;
    @AuraEnabled
    public Datetime createdDate;
    @AuraEnabled
    public Datetime lastModifiedDate;
    @AuraEnabled
    public Integer commentCount;

    public Row(OrgRecommendation__c record) {
      id = record.Id;
      name = record.Name;
      fingerprint = record.isSet('Fingerprint__c')
        ? record.Fingerprint__c
        : null;
      title = record.Title__c;
      severity = record.Severity__c;
      category = record.Category__c;
      confidence = record.Confidence__c;
      status = record.Status__c;
      componentType = record.ComponentType__c;
      componentName = record.ComponentName__c;
      ruleCode = record.RuleCode__c;
      domain = record.Domain__c;
      jiraIssueKey = record.JiraIssueKey__c;
      jiraIssueUrl = record.JiraIssueUrl__c;
      assignedToId = record.AssignedTo__c;
      assignedToName = record.AssignedTo__r?.Name;
      dueDate = record.DueDate__c;
      lastDetectedAt = record.LastDetectedAt__c;
      stillDetected = record.StillDetected__c;
      occurrenceCount = record.OccurrenceCount__c == null
        ? 0
        : record.OccurrenceCount__c.intValue();
      isOpen = record.IsOpen__c;
      statusChangedAt = record.StatusChangedAt__c;
      createdDate = record.CreatedDate;
      lastModifiedDate = record.LastModifiedDate;
    }
  }

  public class Detail {
    @AuraEnabled
    public Row record;
    @AuraEnabled
    public String description;
    @AuraEnabled
    public String justification;
    @AuraEnabled
    public String suggestedAction;
    @AuraEnabled
    public List<String> affectedComponents;
    @AuraEnabled
    public String decisionReason;
    @AuraEnabled
    public String fingerprint;
    @AuraEnabled
    public Datetime firstDetectedAt;
    @AuraEnabled
    public String lastDetectedScanName;
    @AuraEnabled
    public Datetime resolvedDate;
    @AuraEnabled
    public Decimal daysToResolve;
    @AuraEnabled
    public String createdByName;
    @AuraEnabled
    public RuleInfo rule;
    @AuraEnabled
    public List<HistoryEntry> history;
    @AuraEnabled
    public List<Row> relatedRecommendations;
    @AuraEnabled
    public List<Comment> comments;
    @AuraEnabled
    public Boolean canEdit;
    @AuraEnabled
    public Boolean isFollowing;
  }

  public class RuleInfo {
    @AuraEnabled
    public String code;
    @AuraEnabled
    public String label;
    @AuraEnabled
    public String description;
    @AuraEnabled
    public Decimal threshold;
    @AuraEnabled
    public Boolean enabled;
  }

  public class HistoryEntry {
    @AuraEnabled
    public String field;
    @AuraEnabled
    public String fieldLabel;
    @AuraEnabled
    public String oldValue;
    @AuraEnabled
    public String newValue;
    @AuraEnabled
    public Datetime changedAt;
    @AuraEnabled
    public Id changedById;
    @AuraEnabled
    public String changedByName;
  }

  public class Comment {
    @AuraEnabled
    public String id;
    @AuraEnabled
    public Datetime createdDate;
    @AuraEnabled
    public String authorId;
    @AuraEnabled
    public String authorName;
    @AuraEnabled
    public String authorPhotoUrl;
    @AuraEnabled
    public List<Segment> segments;
    @AuraEnabled
    public List<Comment> replies;
  }

  public class Segment {
    @AuraEnabled
    public String type;
    @AuraEnabled
    public String text;
    @AuraEnabled
    public String recordId;
  }

  public class UserOption {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String title;
    @AuraEnabled
    public String photoUrl;
  }

  public class Activity {
    @AuraEnabled
    public Id recordId;
    @AuraEnabled
    public String recordName;
    @AuraEnabled
    public String title;
    @AuraEnabled
    public String fieldLabel;
    @AuraEnabled
    public String oldValue;
    @AuraEnabled
    public String newValue;
    @AuraEnabled
    public Datetime changedAt;
    @AuraEnabled
    public String changedByName;
  }

  // ---------- Recommandations venant d'autres modules (ex. Field Usage) ----------

  /**
   * Crée ou actualise des recommandations par empreinte (Fingerprint__c). Chaque élément donne les
   * valeurs des champs à écrire (nom d'API → valeur). Les décisions déjà prises (statut, assignation,
   * gravité ajustée) ne sont jamais écrasées ; une recommandation résolue qui revient repasse
   * « To Review » avec le motif fourni.
   *
   * @return created et updated (nombre de recommandations créées et mises à jour)
   */
  public static Map<String, Object> upsertExternal(
    List<Object> specs,
    String reopenReason
  ) {
    assertBatchSize(specs);
    Map<String, OrgRecommendation__c> byFingerprint = new Map<String, OrgRecommendation__c>();
    Map<String, Schema.SObjectField> fields = Schema.SObjectType.OrgRecommendation__c.fields.getMap();
    for (Object spec : specs == null ? new List<Object>() : specs) {
      if (!(spec instanceof Map<String, Object>)) {
        continue;
      }
      OrgRecommendation__c rec = new OrgRecommendation__c();
      Map<String, Object> values = (Map<String, Object>) spec;
      for (String field : values.keySet()) {
        putValue(rec, fields, field, values.get(field));
      }
      if (String.isNotBlank(rec.Fingerprint__c)) {
        byFingerprint.put(rec.Fingerprint__c, rec);
      }
    }
    Map<String, OrgRecommendation__c> existing = new Map<String, OrgRecommendation__c>();
    for (OrgRecommendation__c rec : [
      SELECT
        Id,
        Fingerprint__c,
        Status__c,
        OccurrenceCount__c,
        LastScanName__c,
        LastDetectedAt__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c IN :byFingerprint.keySet()
      WITH USER_MODE
    ]) {
      existing.put(rec.Fingerprint__c, rec);
    }
    List<OrgRecommendation__c> toInsert = new List<OrgRecommendation__c>();
    List<OrgRecommendation__c> toUpdate = new List<OrgRecommendation__c>();
    for (String fingerprint : byFingerprint.keySet()) {
      OrgRecommendation__c rec = byFingerprint.get(fingerprint);
      OrgRecommendation__c current = existing.get(fingerprint);
      if (current == null) {
        rec.Status__c = OrgIntelligenceConstants.REC_NEW;
        rec.FirstDetectedAt__c = Datetime.now();
        rec.OccurrenceCount__c = 1;
        toInsert.add(rec);
      } else {
        rec.Id = current.Id;
        // Une occurrence par analyse distincte : renvoyer la même analyse ne compte pas
        Boolean sameRun = isSameRun(rec, current);
        rec.OccurrenceCount__c =
          (current.OccurrenceCount__c == null
            ? 0
            : current.OccurrenceCount__c) + (sameRun ? 0 : 1);
        if (
          !sameRun && current.Status__c == OrgIntelligenceConstants.REC_RESOLVED
        ) {
          rec.Status__c = OrgIntelligenceConstants.REC_TO_REVIEW;
          rec.DecisionReason__c = reopenReason;
        }
        toUpdate.add(rec);
      }
    }
    Database.insert(toInsert, AccessLevel.USER_MODE);
    // Mise à jour sans la gravité : une gravité ajustée à la main est conservée
    List<OrgRecommendation__c> cleaned = new List<OrgRecommendation__c>();
    for (OrgRecommendation__c rec : toUpdate) {
      OrgRecommendation__c copy = new OrgRecommendation__c(Id = rec.Id);
      for (String field : rec.getPopulatedFieldsAsMap().keySet()) {
        if (field != 'Severity__c' && field != 'Id') {
          copy.put(field, rec.get(field));
        }
      }
      cleaned.add(copy);
    }
    Database.update(cleaned, AccessLevel.USER_MODE);
    return new Map<String, Object>{
      'created' => toInsert.size(),
      'updated' => cleaned.size()
    };
  }

  /** Plafond par appel (10 000 lignes DML par transaction) : le navigateur découpe au-delà. */
  public static final Integer MAX_BATCH = 4000;

  private static void assertBatchSize(List<Object> specs) {
    if (specs != null && specs.size() > MAX_BATCH) {
      throw new RecommendationException(
        'Too many recommendations in one call (' +
          specs.size() +
          ', maximum ' +
          MAX_BATCH +
          '): send them in batches.'
      );
    }
  }

  /** Même analyse : même nom de scan, ou à défaut même date de détection. */
  private static Boolean isSameRun(
    OrgRecommendation__c incoming,
    OrgRecommendation__c current
  ) {
    if (String.isNotBlank(incoming.LastScanName__c)) {
      return incoming.LastScanName__c == current.LastScanName__c;
    }
    return incoming.LastDetectedAt__c != null &&
      incoming.LastDetectedAt__c == current.LastDetectedAt__c;
  }

  // ---------- Passage de l'édition locale à l'édition collaborative ----------

  private static final Set<String> STATUSES = new Set<String>{
    OrgIntelligenceConstants.REC_NEW,
    OrgIntelligenceConstants.REC_TO_REVIEW,
    OrgIntelligenceConstants.REC_ACCEPTED,
    OrgIntelligenceConstants.REC_IGNORED,
    OrgIntelligenceConstants.REC_RESOLVED
  };

  /**
   * Reprend des recommandations gardées dans un navigateur (édition sans objet, ou fichier
   * partagé) : création par empreinte si elle n'existe pas encore, puis application des décisions
   * locales (statut, motif, échéance, gravité ajustée) quand elles sont plus récentes que la
   * dernière décision partagée (le plus récent gagne). Le responsable et les notes locales, sans
   * champ dans l'objet, deviennent une publication Chatter sur la recommandation.
   *
   * @param records objets aux noms de champs d'OrgRecommendation__c (Fingerprint__c obligatoire),
   *                plus DecidedAt, AdjustedSeverity__c, Owner__c et Notes__c de l'édition locale
   * @return created, updated (décisions appliquées) et skipped (décision partagée plus récente)
   */
  public static Map<String, Object> importDecisions(List<Object> records) {
    assertBatchSize(records);
    Map<String, Schema.SObjectField> fields = Schema.SObjectType.OrgRecommendation__c.fields.getMap();
    Map<String, Map<String, Object>> byFingerprint = new Map<String, Map<String, Object>>();
    for (Object raw : records == null ? new List<Object>() : records) {
      if (raw instanceof Map<String, Object>) {
        Map<String, Object> values = (Map<String, Object>) raw;
        String fingerprint = values.get('Fingerprint__c') == null
          ? null
          : String.valueOf(values.get('Fingerprint__c'));
        if (String.isNotBlank(fingerprint)) {
          byFingerprint.put(fingerprint, values);
        }
      }
    }
    Map<String, OrgRecommendation__c> existing = new Map<String, OrgRecommendation__c>();
    for (OrgRecommendation__c rec : [
      SELECT Id, Fingerprint__c, Status__c, StatusChangedAt__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c IN :byFingerprint.keySet()
      WITH USER_MODE
    ]) {
      existing.put(rec.Fingerprint__c, rec);
    }
    List<OrgRecommendation__c> toInsert = new List<OrgRecommendation__c>();
    List<OrgRecommendation__c> toUpdate = new List<OrgRecommendation__c>();
    Map<String, String> notesByFingerprint = new Map<String, String>();
    Integer skipped = 0;
    for (String fingerprint : byFingerprint.keySet()) {
      Map<String, Object> values = byFingerprint.get(fingerprint);
      OrgRecommendation__c current = existing.get(fingerprint);
      Datetime decidedAt = toDatetime(values.get('DecidedAt'));
      if (current == null) {
        OrgRecommendation__c rec = new OrgRecommendation__c();
        for (String field : values.keySet()) {
          putValue(rec, fields, field, values.get(field));
        }
        rec.Fingerprint__c = fingerprint;
        rec.Status__c = OrgIntelligenceConstants.REC_NEW;
        Datetime first = toDatetime(values.get('FirstDetectedAt__c'));
        rec.FirstDetectedAt__c = first == null ? Datetime.now() : first;
        Object occurrences = values.get('OccurrenceCount__c');
        rec.OccurrenceCount__c = occurrences == null
          ? 1
          : Decimal.valueOf(String.valueOf(occurrences));
        applyDecision(rec, values);
        toInsert.add(rec);
      } else if (
        decidedAt != null &&
        (current.StatusChangedAt__c == null ||
        decidedAt > current.StatusChangedAt__c)
      ) {
        OrgRecommendation__c rec = new OrgRecommendation__c(Id = current.Id);
        applyDecision(rec, values);
        toUpdate.add(rec);
      } else {
        skipped++;
        continue;
      }
      String note = noteOf(values);
      if (note != null) {
        notesByFingerprint.put(fingerprint, note);
      }
    }
    Database.insert(toInsert, AccessLevel.USER_MODE);
    Database.update(toUpdate, AccessLevel.USER_MODE);
    postImportNotes(toInsert, toUpdate, existing, notesByFingerprint);
    return new Map<String, Object>{
      'created' => toInsert.size(),
      'updated' => toUpdate.size(),
      'skipped' => skipped
    };
  }

  /** Décision locale : statut, motif (exigé pour Ignored / Resolved), échéance, gravité ajustée. */
  private static void applyDecision(
    OrgRecommendation__c rec,
    Map<String, Object> values
  ) {
    String status = values.get('Status__c') == null
      ? null
      : String.valueOf(values.get('Status__c'));
    if (STATUSES.contains(status)) {
      rec.Status__c = status;
    }
    String reason = values.get('DecisionReason__c') == null
      ? null
      : String.valueOf(values.get('DecisionReason__c'));
    if (String.isBlank(reason) && DECISION_STATUSES.contains(rec.Status__c)) {
      reason = 'Decision taken in a browser before the shared edition.';
    }
    rec.DecisionReason__c = String.isBlank(reason)
      ? null
      : reason.abbreviate(255);
    Object due = values.get('DueDate__c');
    rec.DueDate__c = due == null || String.isBlank(String.valueOf(due))
      ? null
      : Date.valueOf(String.valueOf(due).left(10));
    // Gravité ajustée de l'édition locale (Severity__c porte la gravité ajustée dans l'objet)
    Object adjusted = values.get('AdjustedSeverity__c');
    if (
      adjusted != null &&
      OrgIntelligenceConstants.SEVERITIES.contains(String.valueOf(adjusted))
    ) {
      rec.Severity__c = String.valueOf(adjusted);
    }
  }

  private static String noteOf(Map<String, Object> values) {
    List<String> parts = new List<String>();
    Object owner = values.get('Owner__c');
    if (owner != null && String.isNotBlank(String.valueOf(owner))) {
      parts.add('Owner (browser edition): ' + String.valueOf(owner));
    }
    Object notes = values.get('Notes__c');
    if (notes != null && String.isNotBlank(String.valueOf(notes))) {
      parts.add('Notes: ' + String.valueOf(notes));
    }
    return parts.isEmpty() ? null : String.join(parts, '\n').abbreviate(9000);
  }

  /** Publie le responsable et les notes locales dans le fil (sans bloquer si Chatter est absent). */
  private static void postImportNotes(
    List<OrgRecommendation__c> inserted,
    List<OrgRecommendation__c> updated,
    Map<String, OrgRecommendation__c> existing,
    Map<String, String> notesByFingerprint
  ) {
    if (notesByFingerprint.isEmpty()) {
      return;
    }
    Map<Id, String> fingerprintById = new Map<Id, String>();
    for (OrgRecommendation__c rec : inserted) {
      fingerprintById.put(rec.Id, rec.Fingerprint__c);
    }
    for (String fingerprint : existing.keySet()) {
      fingerprintById.put(existing.get(fingerprint).Id, fingerprint);
    }
    List<FeedItem> posts = new List<FeedItem>();
    List<OrgRecommendation__c> touched = new List<OrgRecommendation__c>(
      inserted
    );
    touched.addAll(updated);
    for (OrgRecommendation__c rec : touched) {
      String note = notesByFingerprint.get(fingerprintById.get(rec.Id));
      if (note != null) {
        posts.add(
          new FeedItem(ParentId = rec.Id, Type = 'TextPost', Body = note)
        );
      }
    }
    try {
      Database.insert(posts, false, AccessLevel.USER_MODE);
    } catch (Exception e) {
      // Chatter désactivé : les notes locales ne sont pas reprises
      System.debug(LoggingLevel.FINE, e.getMessage());
    }
  }

  private static Datetime toDatetime(Object value) {
    if (value == null || String.isBlank(String.valueOf(value))) {
      return null;
    }
    if (value instanceof Datetime) {
      return (Datetime) value;
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

  /**
   * Recommandations partagées au format du fichier de l'édition locale (noms de champs
   * d'OrgRecommendation__c), pour les garder ou les partager hors de l'org.
   */
  public static List<Map<String, Object>> exportRecommendations() {
    List<Map<String, Object>> result = new List<Map<String, Object>>();
    for (OrgRecommendation__c rec : [
      SELECT
        Name,
        Fingerprint__c,
        Title__c,
        Description__c,
        Justification__c,
        SuggestedAction__c,
        AffectedComponents__c,
        Severity__c,
        Category__c,
        Confidence__c,
        Status__c,
        DecisionReason__c,
        RuleCode__c,
        ComponentType__c,
        ComponentName__c,
        AssignedTo__r.Name,
        DueDate__c,
        FirstDetectedAt__c,
        LastDetectedAt__c,
        LastScanName__c,
        StillDetected__c,
        OccurrenceCount__c,
        StatusChangedAt__c,
        ResolvedDate__c,
        JiraIssueKey__c,
        CreatedDate
      FROM OrgRecommendation__c
      WITH USER_MODE
      ORDER BY SeverityRank__c, Name
      LIMIT :LIST_LIMIT
    ]) {
      result.add(
        new Map<String, Object>{
          'Name' => rec.Name,
          'Fingerprint__c' => rec.Fingerprint__c,
          'Title__c' => rec.Title__c,
          'Description__c' => rec.Description__c,
          'Justification__c' => rec.Justification__c,
          'SuggestedAction__c' => rec.SuggestedAction__c,
          'AffectedComponents__c' => rec.AffectedComponents__c,
          'Severity__c' => rec.Severity__c,
          'Category__c' => rec.Category__c,
          'Confidence__c' => rec.Confidence__c,
          'Status__c' => rec.Status__c,
          'DecisionReason__c' => rec.DecisionReason__c,
          'RuleCode__c' => rec.RuleCode__c,
          'ComponentType__c' => rec.ComponentType__c,
          'ComponentName__c' => rec.ComponentName__c,
          'Owner__c' => rec.AssignedTo__r?.Name,
          'DueDate__c' => rec.DueDate__c,
          'FirstDetectedAt__c' => rec.FirstDetectedAt__c,
          'LastDetectedAt__c' => rec.LastDetectedAt__c,
          'LastScanName__c' => rec.LastScanName__c,
          'StillDetected__c' => rec.StillDetected__c,
          'OccurrenceCount__c' => rec.OccurrenceCount__c,
          'StatusChangedAt__c' => rec.StatusChangedAt__c,
          'ResolvedDate__c' => rec.ResolvedDate__c,
          'DecidedAt' => rec.StatusChangedAt__c,
          'JiraIssueKey__c' => rec.JiraIssueKey__c,
          'CreatedDate' => rec.CreatedDate
        }
      );
    }
    return result;
  }

  /** Champs que les analyses ne peuvent pas écrire (décisions, suivi, système). */
  private static final Set<String> PROTECTED_FIELDS = new Set<String>{
    'id',
    'name',
    'ownerid',
    'status__c',
    'decisionreason__c',
    'assignedto__c',
    'duedate__c',
    'firstdetectedat__c',
    'occurrencecount__c',
    'jiraissuekey__c',
    'jiraissueurl__c',
    'jiraexportedat__c'
  };

  /**
   * Écrit une valeur venue du navigateur (JSON) : champs inconnus, calculés ou protégés ignorés,
   * dates et nombres convertis, textes tronqués à la longueur du champ.
   */
  private static void putValue(
    OrgRecommendation__c rec,
    Map<String, Schema.SObjectField> fields,
    String name,
    Object value
  ) {
    if (String.isBlank(name) || PROTECTED_FIELDS.contains(name.toLowerCase())) {
      return;
    }
    Schema.SObjectField field = fields.get(name.toLowerCase());
    if (field == null) {
      return;
    }
    Schema.DescribeFieldResult describe = field.getDescribe();
    if (
      describe.isCalculated() ||
      describe.isAutoNumber() ||
      !describe.isCustom()
    ) {
      return;
    }
    if (value == null) {
      rec.put(field, null);
      return;
    }
    String raw = String.valueOf(value);
    switch on describe.getType() {
      when DATETIME {
        rec.put(
          field,
          value instanceof Datetime
            ? value
            : (Object) JSON.deserialize('"' + raw + '"', Datetime.class)
        );
      }
      when DATE {
        rec.put(
          field,
          value instanceof Date ? value : (Object) Date.valueOf(raw.left(10))
        );
      }
      when BOOLEAN {
        rec.put(field, value instanceof Boolean ? value : Boolean.valueOf(raw));
      }
      when DOUBLE, CURRENCY, PERCENT, INTEGER {
        rec.put(field, Decimal.valueOf(raw));
      }
      when STRING, TEXTAREA, URL, EMAIL, PHONE {
        rec.put(field, raw.abbreviate(describe.getLength()));
      }
      when else {
        rec.put(field, value);
      }
    }
  }
}
