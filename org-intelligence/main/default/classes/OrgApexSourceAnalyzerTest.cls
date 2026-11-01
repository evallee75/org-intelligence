@IsTest
private class OrgApexSourceAnalyzerTest {
  @IsTest
  static void commentsAndStringsAreIgnoredByTheRules() {
    OrgApexSourceAnalyzer analyzer = new OrgApexSourceAnalyzer(
      'public class A {\n' +
        '  // for (X x : xs) { insert x; }\n' +
        '  /* while (true) { [SELECT Id FROM Account]; } */\n' +
        '  String s = \'for (a) { update b; }\';\n' +
        '}'
    );
    Assert.isTrue(
      analyzer.queriesOrDmlInLoops().isEmpty(),
      'Nothing outside comments and strings'
    );
    Assert.areEqual(1, analyzer.literals.size());
    Assert.areEqual(
      5,
      analyzer.code.split('\n').size(),
      'Line breaks are kept'
    );
    Assert.areEqual(
      3,
      analyzer.codeLineCount(),
      'Comment-only lines are not code'
    );
  }

  @IsTest
  static void recognisesRecordIds() {
    String id18 = String.valueOf(UserInfo.getUserId());
    Assert.isTrue(
      OrgApexSourceAnalyzer.looksLikeRecordId(id18),
      'A real 18-character Id'
    );
    Assert.isTrue(
      OrgApexSourceAnalyzer.looksLikeRecordId(id18.left(15)),
      'A real 15-character Id'
    );
    Assert.isFalse(
      OrgApexSourceAnalyzer.looksLikeRecordId(id18.left(15) + 'ZZZ'),
      'Wrong checksum'
    );
    Assert.isFalse(
      OrgApexSourceAnalyzer.looksLikeRecordId('003000000000000AAA'),
      'Fake test Id'
    );
    Assert.isFalse(
      OrgApexSourceAnalyzer.looksLikeRecordId('ContactLogsTests'),
      'Not an Id'
    );
    Assert.isFalse(OrgApexSourceAnalyzer.looksLikeRecordId(null));

    OrgApexSourceAnalyzer analyzer = new OrgApexSourceAnalyzer(
      'class A {\n Id a = \'' + id18 + '\';\n Id b = \'' + id18 + '\';\n}'
    );
    List<OrgApexSourceAnalyzer.Literal> ids = analyzer.hardcodedIds();
    Assert.areEqual(1, ids.size(), 'Each value is reported once');
    Assert.areEqual(2, ids[0].line);
  }

  @IsTest
  static void findsQueriesAndDmlInsideLoopBodies() {
    OrgApexSourceAnalyzer analyzer = new OrgApexSourceAnalyzer(
      'class A {\n' +
        '  void run(List<Account> accounts) {\n' +
        '    for (Account a : [SELECT Id FROM Account]) {\n' + // en-tête : pas un constat
        '      update a;\n' +
        '    }\n' +
        '    while (true) {\n' +
        '      List<Contact> c = [SELECT Id FROM Contact];\n' +
        '      Database.insert(c);\n' +
        '    }\n' +
        '    do {\n' +
        '      delete accounts;\n' +
        '    } while (false);\n' +
        '    insert accounts;\n' +
        '  }\n' +
        '}'
    );
    List<OrgApexSourceAnalyzer.LoopHit> hits = analyzer.queriesOrDmlInLoops();
    Assert.areEqual(4, hits.size(), 'update, SOQL, Database.insert and delete');
    Assert.areEqual(4, hits[0].line);
    Assert.areEqual('DML statement', hits[0].kind);
    Assert.areEqual(7, hits[1].line);
    Assert.areEqual('SOQL query', hits[1].kind);
    Assert.areEqual('Database method', hits[2].kind);
    Assert.areEqual(11, hits[3].line);
  }

  @IsTest
  static void readsTheClassDeclaration() {
    OrgApexSourceAnalyzer controller = new OrgApexSourceAnalyzer(
      'public without sharing class Ctrl {\n @AuraEnabled\n public static String go() { return null; }\n}'
    );
    Assert.areEqual('without', controller.sharingDeclaration());
    Assert.areEqual(
      new List<String>{ '@AuraEnabled' },
      controller.entryPointMarkers()
    );

    OrgApexSourceAnalyzer dto = new OrgApexSourceAnalyzer(
      'public without sharing class Service {\n public class Row {\n @AuraEnabled\n public String name;\n }\n}'
    );
    Assert.isTrue(
      dto.entryPointMarkers().isEmpty(),
      '@AuraEnabled on a property does not expose the class'
    );

    OrgApexSourceAnalyzer rest = new OrgApexSourceAnalyzer(
      '@RestResource(urlMapping=\'/x/*\')\nglobal inherited sharing class R { webservice static void a() {} }'
    );
    Assert.areEqual('inherited', rest.sharingDeclaration());
    Assert.areEqual(
      new List<String>{ '@RestResource', 'webservice' },
      rest.entryPointMarkers()
    );

    Assert.isNull(
      new OrgApexSourceAnalyzer('public class Plain {}').sharingDeclaration()
    );
  }

  @IsTest
  static void detectsTestClassesWithoutAssertions() {
    OrgApexSourceAnalyzer withoutAssert = new OrgApexSourceAnalyzer(
      '@IsTest\nprivate class T {\n @IsTest static void a() { new A().run(); }\n}'
    );
    Assert.isTrue(withoutAssert.isTestClass());
    Assert.isTrue(withoutAssert.hasTestMethods());
    Assert.isFalse(withoutAssert.hasAssertions());

    OrgApexSourceAnalyzer withAssert = new OrgApexSourceAnalyzer(
      '@isTest\nprivate class T {\n static testMethod void a() { System.assertEquals(1, 1); }\n}'
    );
    Assert.isTrue(withAssert.hasAssertions());

    OrgApexSourceAnalyzer factory = new OrgApexSourceAnalyzer(
      '@IsTest\npublic class Factory {\n public static void make() {}\n}'
    );
    Assert.isFalse(
      factory.hasTestMethods(),
      'A test data factory has no test method'
    );
  }
}
