/**
 * Tests du module Recommendations par sa classe d'entrée (invoke) : liste, détail, décisions,
 * collaboration, synchronisation des scans, recommandations externes, reprise des décisions
 * locales, indicateurs du socle et contrôles d'accès.
 */
@IsTest
private class OrgIntelRecommendationsModuleTest {
  private static final String ADMIN = 'recadm';
  private static final String READER = 'recrd';
  private static final String OUTSIDER = 'recout';

  @TestSetup
  static void setup() {
    User admin = OrgRecommendationsTestData.createAdmin(ADMIN);
    OrgRecommendationsTestData.createReader(READER);
    OrgRecommendationsTestData.createOutsider(OUTSIDER);
    System.runAs(admin) {
      insert new List<OrgRecommendation__c>{
        OrgRecommendationsTestData.recommendation('FP-1', 'Critical'),
        OrgRecommendationsTestData.recommendation('FP-2', 'High'),
        OrgRecommendationsTestData.recommendation('FP-3', 'Medium')
      };
    }
  }

  private static OrgIntelRecommendationsModule module() {
    return new OrgIntelRecommendationsModule();
  }

  private static Id idOf(String fingerprint) {
    return [
      SELECT Id
      FROM OrgRecommendation__c
      WHERE Fingerprint__c = :fingerprint
    ]
    .Id;
  }

  @IsTest
  static void listAndDetailThroughInvoke() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    Id recordId = idOf('FP-1');
    ConnectApi.ChatterFeeds.setTestGetFeedElementsFromFeed(
      null,
      ConnectApi.FeedType.Record,
      recordId,
      null,
      50,
      ConnectApi.FeedSortOrder.CreatedDateDesc,
      fakeFeed(admin.Id)
    );
    System.runAs(admin) {
      Test.startTest();
      Assert.areEqual(OrgIntelModules.RECOMMENDATIONS, module().key());
      Assert.isTrue(module().isAccessible());
      OrgRecommendationService.RecommendationList result = (OrgRecommendationService.RecommendationList) module()
        .invoke('listRecommendations', new Map<String, Object>());
      OrgRecommendationService.Detail detail = (OrgRecommendationService.Detail) module()
        .invoke(
          'getRecommendation',
          new Map<String, Object>{ 'recordId' => recordId }
        );
      Test.stopTest();
      Assert.areEqual(3, result.rows.size());
      Assert.areEqual(admin.Id, result.currentUserId);
      Assert.isFalse(result.truncated);
      Assert.areEqual('Critical', result.rows[0].severity);
      Assert.areEqual('FP-1', detail.fingerprint);
      Assert.areEqual(2, detail.affectedComponents.size());
      Assert.areEqual(2, detail.relatedRecommendations.size());
      Assert.isNotNull(detail.rule, 'Rule APEX_HARDCODED_ID from the catalog');
      Assert.isTrue(detail.canEdit);
      Assert.isFalse(detail.isFollowing);
      Assert.areEqual(1, detail.comments.size());
      OrgRecommendationService.Comment comment = detail.comments[0];
      Assert.areEqual('Admin', comment.authorName);
      Assert.areEqual(1, comment.replies.size());
      Assert.areEqual(
        'Hello @Someone',
        OrgRecommendationService.plainText(comment)
      );
    }
  }

  @IsTest
  static void detailOfMissingRecordFails() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    Id recordId = idOf('FP-3');
    System.runAs(admin) {
      delete new OrgRecommendation__c(Id = recordId);
      try {
        module()
          .invoke(
            'getRecommendation',
            new Map<String, Object>{ 'recordId' => recordId }
          );
        Assert.fail('A deleted recommendation cannot be loaded');
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('could not be loaded'));
      }
    }
  }

  @IsTest
  static void decisionsAndAssignment() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    User reader = OrgRecommendationsTestData.userNamed(READER);
    Id first = idOf('FP-1');
    Id second = idOf('FP-2');
    System.runAs(reader) {
      Test.startTest();
      Integer updated = (Integer) module()
        .invoke(
          'updateRecommendations',
          new Map<String, Object>{
            'recordIds' => new List<Object>{ first, second },
            'changesJson' => JSON.serialize(
              new Map<String, Object>{
                'status' => 'Accepted',
                'assignedToId' => admin.Id,
                'dueDate' => '2030-01-31',
                'decisionReason' => 'Planned'
              }
            )
          }
        );
      Assert.areEqual(2, updated);
      // Gravité : réservée aux administrateurs
      assertFails(
        'updateRecommendations',
        new Map<String, Object>{
          'recordIds' => new List<Object>{ first },
          'changesJson' => '{"severity":"Low"}'
        },
        'severity'
      );
      // Motif obligatoire pour Ignored / Resolved
      assertFails(
        'updateRecommendations',
        new Map<String, Object>{
          'recordIds' => new List<Object>{ first },
          'changesJson' => '{"status":"Ignored"}'
        },
        'reason'
      );
      assertFails(
        'updateRecommendations',
        new Map<String, Object>{
          'recordIds' => new List<Object>(),
          'changesJson' => '{"status":"Accepted"}'
        },
        'at least one'
      );
      assertFails(
        'updateRecommendations',
        new Map<String, Object>{
          'recordIds' => new List<Object>{ first },
          'changesJson' => ''
        },
        'Nothing to change'
      );
      Test.stopTest();
    }
    OrgRecommendation__c record = [
      SELECT
        Status__c,
        AssignedTo__c,
        DueDate__c,
        StatusChangedAt__c,
        ResolvedDate__c
      FROM OrgRecommendation__c
      WHERE Id = :first
    ];
    Assert.areEqual('Accepted', record.Status__c);
    Assert.areEqual(admin.Id, record.AssignedTo__c);
    Assert.areEqual(Date.newInstance(2030, 1, 31), record.DueDate__c);
    Assert.isNotNull(record.StatusChangedAt__c);
    Assert.isNull(record.ResolvedDate__c);
    // L'assigné suit la recommandation (trigger)
    Assert.areEqual(
      1,
      [
        SELECT COUNT()
        FROM EntitySubscription
        WHERE ParentId = :first AND SubscriberId = :admin.Id
      ]
    );

    System.runAs(admin) {
      module()
        .invoke(
          'updateRecommendations',
          new Map<String, Object>{
            'recordIds' => new List<Object>{ first },
            'changesJson' => '{"severity":"Low","status":"Resolved","decisionReason":"Fixed","assignedToId":"","dueDate":""}'
          }
        );
      assertFails(
        'updateRecommendations',
        new Map<String, Object>{
          'recordIds' => new List<Object>{ first },
          'changesJson' => '{"severity":"Huge"}'
        },
        'Unknown severity'
      );
    }
    record = [
      SELECT Severity__c, Status__c, ResolvedDate__c, AssignedTo__c
      FROM OrgRecommendation__c
      WHERE Id = :first
    ];
    Assert.areEqual('Low', record.Severity__c);
    Assert.isNotNull(record.ResolvedDate__c);
    Assert.isNull(record.AssignedTo__c);
  }

  @IsTest
  static void collaborationActions() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    User reader = OrgRecommendationsTestData.userNamed(READER);
    Id recordId = idOf('FP-2');
    System.runAs(reader) {
      Test.startTest();
      Assert.isTrue(
        (Boolean) module()
          .invoke(
            'setFollowing',
            new Map<String, Object>{ 'recordId' => recordId, 'follow' => true }
          )
      );
      Assert.isTrue(OrgRecommendationService.isFollowing(recordId));
      Assert.isFalse(
        (Boolean) module()
          .invoke(
            'setFollowing',
            new Map<String, Object>{ 'recordId' => recordId, 'follow' => false }
          )
      );
      Assert.isFalse(OrgRecommendationService.isFollowing(recordId));
      // Pas d'abonnement sur un autre type d'enregistrement
      assertFails(
        'setFollowing',
        new Map<String, Object>{ 'recordId' => admin.Id, 'follow' => true },
        'not a recommendation'
      );

      List<OrgRecommendationService.UserOption> users = (List<OrgRecommendationService.UserOption>) module()
        .invoke('searchUsers', new Map<String, Object>{ 'term' => 'Test rec' });
      Assert.isFalse(users.isEmpty());

      // Commentaire : vide refusé ; ConnectApi indisponible dans un test isolé → erreur lisible
      assertFails(
        'postComment',
        new Map<String, Object>{ 'recordId' => recordId, 'text' => ' ' },
        'could not be posted'
      );
      try {
        module()
          .invoke(
            'postComment',
            new Map<String, Object>{
              'recordId' => recordId,
              'text' => 'Please check @' + admin.Name,
              'mentionsJson' => JSON.serialize(
                new List<Object>{
                  new Map<String, Object>{
                    'id' => admin.Id,
                    'name' => admin.Name
                  }
                }
              ),
              'parentCommentId' => null
            }
          );
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('could not be posted'));
      }
      try {
        module()
          .invoke(
            'postComment',
            new Map<String, Object>{
              'recordId' => recordId,
              'text' => 'A reply',
              'parentCommentId' => '0D5000000000001'
            }
          );
      } catch (AuraHandledException e) {
        Assert.isTrue(e.getMessage().contains('could not be posted'));
      }
      Test.stopTest();
    }
  }

  @IsTest
  static void bodyWithMentions() {
    OrgRecommendationService.MentionInput ann = new OrgRecommendationService.MentionInput();
    ann.id = UserInfo.getUserId();
    ann.name = 'Ann';
    OrgRecommendationService.MentionInput empty = new OrgRecommendationService.MentionInput();
    ConnectApi.MessageBodyInput body = OrgRecommendationService.buildBody(
      'Hi @Ann, see @Ann again',
      new List<OrgRecommendationService.MentionInput>{ empty, ann }
    );
    // « Hi », @Ann, « , see », @Ann, « again »
    Assert.areEqual(5, body.messageSegments.size());
    Assert.isTrue(
      body.messageSegments[1] instanceof ConnectApi.MentionSegmentInput
    );
    Assert.areEqual(
      1,
      OrgRecommendationService.buildBody('No mention', null)
        .messageSegments.size()
    );
  }

  @IsTest
  static void syncScanAndLinks() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    System.runAs(admin) {
      update new OrgRecommendation__c(
        Id = idOf('FP-1'),
        Status__c = 'Resolved',
        DecisionReason__c = 'Fixed'
      );
      Test.startTest();
      Map<String, Object> result = (Map<String, Object>) module()
        .invoke(
          'syncScan',
          new Map<String, Object>{
            'findings' => new List<Object>{
              finding('FP-1', 'Critical'),
              finding('FP-4', 'Low'),
              finding('FP-4', 'Low'),
              new Map<String, Object>{ 'title' => 'No fingerprint' },
              'not a map'
            },
            'reliableRules' => new List<Object>{ 'APEX_HARDCODED_ID', '' },
            'scanName' => 'Scan 2',
            'completedAt' => '2026-11-01T10:00:00.000Z'
          }
        );
      Map<String, Object> links = (Map<String, Object>) module()
        .invoke(
          'linksForFingerprints',
          new Map<String, Object>{
            'fingerprints' => new List<Object>{ 'FP-1', 'FP-4', '', 'NONE' }
          }
        );
      Test.stopTest();
      Assert.areEqual(1, result.get('created'));
      Assert.areEqual(1, result.get('updated'));
      Assert.areEqual(2, result.get('notDetected'));
      Assert.areEqual(2, links.size());
    }
    OrgRecommendation__c reopened = [
      SELECT Status__c, OccurrenceCount__c, DecisionReason__c, LastScanName__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c = 'FP-1'
    ];
    Assert.areEqual('To Review', reopened.Status__c);
    Assert.areEqual(2, reopened.OccurrenceCount__c);
    Assert.areEqual('Scan 2', reopened.LastScanName__c);
    OrgRecommendation__c created = [
      SELECT Status__c, Justification__c, AffectedComponents__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c = 'FP-4'
    ];
    Assert.areEqual('New', created.Status__c);
    Assert.isTrue(created.Justification__c.contains('Evidence'));
    Assert.areEqual('A\nB', created.AffectedComponents__c);
    Assert.isFalse(
      [
        SELECT StillDetected__c
        FROM OrgRecommendation__c
        WHERE Fingerprint__c = 'FP-2'
      ]
      .StillDetected__c
    );
  }

  @IsTest
  static void syncScanWithoutNameAndTooManyFindings() {
    List<Object> many = new List<Object>();
    for (Integer i = 0; i <= OrgRecommendationSync.MAX_FINDINGS; i++) {
      many.add(new Map<String, Object>{ 'fingerprint' => 'X' + i });
    }
    System.runAs(OrgRecommendationsTestData.userNamed(ADMIN)) {
      Map<String, Object> result = OrgRecommendationSync.syncScan(
        new List<Object>{ finding('FP-9', 'Info') },
        null,
        null,
        null
      );
      Assert.areEqual(1, result.get('created'));
      Assert.areEqual(0, result.get('notDetected'));
      try {
        OrgRecommendationSync.syncScan(many, null, 'Big', null);
        Assert.fail('Too many findings must be refused');
      } catch (OrgRecommendationSync.SyncException e) {
        Assert.isTrue(e.getMessage().contains('batches'));
      }
      Assert.isTrue(OrgRecommendationSync.linksForFingerprints(null).isEmpty());
    }
  }

  @IsTest
  static void externalRecommendations() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    System.runAs(admin) {
      update new OrgRecommendation__c(
        Id = idOf('FP-2'),
        Status__c = 'Resolved',
        DecisionReason__c = 'Done'
      );
      Test.startTest();
      Map<String, Object> result = (Map<String, Object>) module()
        .invoke(
          'upsertExternal',
          new Map<String, Object>{
            'recommendations' => new List<Object>{
              new Map<String, Object>{
                'Fingerprint__c' => 'SECURITY_MFA',
                'RuleCode__c' => 'SECURITY_MFA',
                'Title__c' => 'MFA is not enforced',
                'Severity__c' => 'High',
                'Category__c' => 'Security',
                'LastDetectedAt__c' => '2026-11-01T08:00:00.000Z',
                'StillDetected__c' => 'true',
                'Description__c' => null,
                'Status__c' => 'Ignored',
                'Domain__c' => 'Ignored formula',
                'Unknown__c' => 'ignored',
                '' => 'blank'
              },
              new Map<String, Object>{
                'Fingerprint__c' => 'FP-2',
                'Severity__c' => 'Info',
                'LastScanName__c' => 'Security audit',
                'LastDetectedAt__c' => Datetime.now()
              },
              new Map<String, Object>{ 'Title__c' => 'No fingerprint' },
              'not a map'
            },
            'reopenReason' => 'Detected again by the security audit.'
          }
        );
      // Renvoi de la même analyse : pas de nouvelle occurrence
      module()
        .invoke(
          'upsertExternal',
          new Map<String, Object>{
            'recommendations' => new List<Object>{
              new Map<String, Object>{
                'Fingerprint__c' => 'FP-2',
                'LastScanName__c' => 'Security audit'
              },
              new Map<String, Object>{
                'Fingerprint__c' => 'SECURITY_MFA',
                'LastDetectedAt__c' => '2026-11-01T08:00:00.000Z'
              }
            }
          }
        );
      Test.stopTest();
      Assert.areEqual(1, result.get('created'));
      Assert.areEqual(1, result.get('updated'));
    }
    OrgRecommendation__c external = [
      SELECT Status__c, StillDetected__c, OccurrenceCount__c, Severity__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c = 'SECURITY_MFA'
    ];
    Assert.areEqual('New', external.Status__c, 'Status is protected');
    Assert.isTrue(external.StillDetected__c);
    Assert.areEqual(1, external.OccurrenceCount__c);
    OrgRecommendation__c reopened = [
      SELECT Status__c, Severity__c, OccurrenceCount__c, DecisionReason__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c = 'FP-2'
    ];
    Assert.areEqual('To Review', reopened.Status__c);
    Assert.areEqual(
      'High',
      reopened.Severity__c,
      'Severity is never overwritten'
    );
    Assert.areEqual(2, reopened.OccurrenceCount__c);
    Assert.areEqual(
      'Detected again by the security audit.',
      reopened.DecisionReason__c
    );

    List<Object> tooMany = new List<Object>();
    for (Integer i = 0; i <= OrgRecommendationService.MAX_BATCH; i++) {
      tooMany.add(null);
    }
    try {
      OrgRecommendationService.upsertExternal(tooMany, null);
      Assert.fail('Too many recommendations must be refused');
    } catch (OrgRecommendationService.RecommendationException e) {
      Assert.isTrue(e.getMessage().contains('batches'));
    }
  }

  @IsTest
  static void importAndExportDecisions() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    System.runAs(admin) {
      Test.startTest();
      Map<String, Object> result = (Map<String, Object>) module()
        .invoke(
          'importDecisions',
          new Map<String, Object>{
            'recommendations' => new List<Object>{
              // Nouvelle, décidée dans le navigateur sans motif
              new Map<String, Object>{
                'Fingerprint__c' => 'LOCAL-1',
                'Title__c' => 'Local recommendation',
                'RuleCode__c' => 'APEX_LOW_COVERAGE',
                'Severity__c' => 'Medium',
                'Status__c' => 'Ignored',
                'DecidedAt' => '2026-10-01T10:00:00.000Z',
                'FirstDetectedAt__c' => '2026-09-01T10:00:00.000Z',
                'OccurrenceCount__c' => 3,
                'DueDate__c' => '2030-05-01T00:00:00.000Z',
                'AdjustedSeverity__c' => 'Low',
                'Owner__c' => 'Ann',
                'Notes__c' => 'Check with the team'
              },
              // Décision locale plus récente que la décision partagée
              new Map<String, Object>{
                'Fingerprint__c' => 'FP-1',
                'Status__c' => 'Accepted',
                'DecisionReason__c' => 'Planned in sprint 3',
                'DecidedAt' => Datetime.now().addDays(1),
                'Notes__c' => 'Sprint 3'
              },
              // Décision locale plus ancienne : ignorée
              new Map<String, Object>{
                'Fingerprint__c' => 'FP-2',
                'Status__c' => 'Ignored',
                'DecidedAt' => '2000-01-01T00:00:00.000Z'
              },
              new Map<String, Object>{
                'Fingerprint__c' => 'FP-3',
                'DecidedAt' => 'not a date'
              },
              new Map<String, Object>{ 'Title__c' => 'No fingerprint' }
            }
          }
        );
      List<Map<String, Object>> exported = (List<Map<String, Object>>) module()
        .invoke('exportRecommendations', new Map<String, Object>());
      Test.stopTest();
      Assert.areEqual(1, result.get('created'));
      Assert.areEqual(1, result.get('updated'));
      Assert.areEqual(2, result.get('skipped'));
      Assert.areEqual(4, exported.size());
    }
    OrgRecommendation__c local = [
      SELECT
        Status__c,
        DecisionReason__c,
        Severity__c,
        OccurrenceCount__c,
        DueDate__c
      FROM OrgRecommendation__c
      WHERE Fingerprint__c = 'LOCAL-1'
    ];
    Assert.areEqual('Ignored', local.Status__c);
    Assert.isNotNull(local.DecisionReason__c);
    Assert.areEqual('Low', local.Severity__c);
    Assert.areEqual(3, local.OccurrenceCount__c);
    Assert.areEqual(Date.newInstance(2030, 5, 1), local.DueDate__c);
    Assert.areEqual(
      'Accepted',
      [SELECT Status__c FROM OrgRecommendation__c WHERE Fingerprint__c = 'FP-1']
      .Status__c
    );
  }

  @IsTest
  static void insightsForTheCore() {
    User admin = OrgRecommendationsTestData.userNamed(ADMIN);
    System.runAs(admin) {
      update new OrgRecommendation__c(
        Id = idOf('FP-3'),
        Status__c = 'Resolved',
        DecisionReason__c = 'Fixed'
      );
      update new OrgRecommendation__c(
        Id = idOf('FP-2'),
        Status__c = 'Accepted'
      );
      Test.startTest();
      OrgIntelRecommendationsModule source = module();
      Map<String, Object> overview = source.overviewData();
      Map<String, Object> reports = source.reportsData();
      Map<String, Integer> byRule = source.openCountByRule();
      Map<String, Integer> counts = source.recordCounts();
      List<OrgRecommendationService.Activity> activity = (List<OrgRecommendationService.Activity>) source.invoke(
        'recentActivity',
        new Map<String, Object>()
      );
      Test.stopTest();
      Assert.areEqual(1, overview.get('toReviewCount'));
      Assert.areEqual(1, overview.get('acceptedCount'));
      Assert.areEqual(
        2,
        ((List<Object>) overview.get('priorityRecommendations')).size()
      );
      Assert.areEqual(2, reports.get('openCount'));
      Assert.areEqual(1, reports.get('resolvedLast90Days'));
      Assert.areEqual(3, reports.get('createdLast90Days'));
      Assert.areEqual(
        6,
        ((List<Object>) reports.get('resolutionTrend')).size()
      );
      Assert.areEqual(2, byRule.get('APEX_HARDCODED_ID'));
      Assert.areEqual(3, counts.get('Recommendations'));
      Assert.isNotNull(activity, 'Field history is not written in tests');
    }
  }

  @IsTest
  static void accessIsChecked() {
    User reader = OrgRecommendationsTestData.userNamed(READER);
    User outsider = OrgRecommendationsTestData.userNamed(OUTSIDER);
    System.runAs(outsider) {
      Assert.isFalse(module().isAccessible(), 'No module permission set');
      assertFails('listRecommendations', new Map<String, Object>(), 'access');
      assertFails(
        'recentActivity',
        new Map<String, Object>(),
        'do not have access'
      );
    }
    System.runAs(reader) {
      Assert.isTrue(module().isAccessible());
      // Actions d'administration refusées à un simple utilisateur
      for (
        String action : new List<String>{
          'syncScan',
          'upsertExternal',
          'importDecisions',
          'getJiraSettings',
          'previewJiraExport',
          'exportToJira',
          'testJiraConnection',
          'saveJiraSettings'
        }
      ) {
        assertFails(action, new Map<String, Object>(), 'administrators');
      }
      try {
        module().invoke('doesNotExist', new Map<String, Object>());
        Assert.fail('Unknown action');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('doesNotExist'));
      }
    }
  }

  // ---------- Outils ----------

  private static void assertFails(
    String action,
    Map<String, Object> params,
    String expected
  ) {
    try {
      module().invoke(action, params);
      Assert.fail(action + ' should fail');
    } catch (AuraHandledException e) {
      Assert.isTrue(
        e.getMessage().containsIgnoreCase(expected),
        action + ': ' + e.getMessage()
      );
    }
  }

  private static Map<String, Object> finding(
    String fingerprint,
    String severity
  ) {
    return new Map<String, Object>{
      'fingerprint' => fingerprint,
      'ruleCode' => 'APEX_HARDCODED_ID',
      'componentType' => 'ApexClass',
      'componentName' => 'MyClass',
      'title' => 'Hard-coded Id',
      'description' => 'Found an Id',
      'evidence' => 'line 12',
      'affectedComponents' => new List<Object>{ 'A', '', null, 'B' },
      'severity' => severity,
      'category' => 'Reliability',
      'confidence' => 'High'
    };
  }

  /** Fil Chatter simulé : une publication texte avec mention et une réponse. */
  private static ConnectApi.FeedElementPage fakeFeed(Id authorId) {
    ConnectApi.UserSummary actor = new ConnectApi.UserSummary();
    actor.id = authorId;
    actor.displayName = 'Admin';
    actor.photo = new ConnectApi.Photo();
    actor.photo.smallPhotoUrl = '/photo.png';

    ConnectApi.TextSegment hello = new ConnectApi.TextSegment();
    hello.text = 'Hello ';
    ConnectApi.MentionSegment mention = new ConnectApi.MentionSegment();
    mention.name = 'Someone';
    ConnectApi.FeedBody body = new ConnectApi.FeedBody();
    body.messageSegments = new List<ConnectApi.MessageSegment>{
      hello,
      new ConnectApi.MarkupBeginSegment(),
      mention,
      new ConnectApi.MarkupEndSegment()
    };

    ConnectApi.Comment reply = new ConnectApi.Comment();
    reply.id = '0D7000000000001';
    reply.createdDate = Datetime.now();
    reply.user = actor;
    ConnectApi.FeedBody replyBody = new ConnectApi.FeedBody();
    ConnectApi.TextSegment replyText = new ConnectApi.TextSegment();
    replyText.text = 'Done';
    replyBody.messageSegments = new List<ConnectApi.MessageSegment>{
      replyText
    };
    reply.body = replyBody;

    ConnectApi.FeedItem item = new ConnectApi.FeedItem();
    item.id = '0D5000000000001';
    item.type = ConnectApi.FeedItemType.TextPost;
    item.createdDate = Datetime.now();
    item.actor = actor;
    item.body = body;
    item.capabilities = new ConnectApi.FeedElementCapabilities();
    item.capabilities.comments = new ConnectApi.CommentsCapability();
    item.capabilities.comments.page = new ConnectApi.CommentPage();
    item.capabilities.comments.page.items = new List<ConnectApi.Comment>{
      reply
    };

    ConnectApi.FeedItem other = new ConnectApi.FeedItem();
    other.type = ConnectApi.FeedItemType.TrackedChange;

    ConnectApi.FeedElementPage page = new ConnectApi.FeedElementPage();
    page.elements = new List<ConnectApi.FeedElement>{ item, other };
    return page;
  }
}
