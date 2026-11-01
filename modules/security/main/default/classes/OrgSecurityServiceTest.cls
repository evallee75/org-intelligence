/**
 * Tests de l'audit de sécurité (OrgSecurityService) : exécution complète avec le Health Check
 * simulé, mode dégradé sans Tooling, panne Tooling, calcul du score et de la note.
 */
@IsTest
private class OrgSecurityServiceTest {
  private static OrgSecurityChecks.Check find(
    OrgSecurityService.Audit audit,
    String key
  ) {
    for (OrgSecurityChecks.Check check : audit.checks) {
      if (check.key == key) {
        return check;
      }
    }
    return null;
  }

  @IsTest
  static void auditReadsTheHealthCheck() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    OrgSecurityTestSupport.HealthCheckMock mock = new OrgSecurityTestSupport.HealthCheckMock();
    OrgSecurityService.Audit audit;
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(true, mock);
      Test.startTest();
      audit = OrgSecurityService.run();
      Test.stopTest();
    }
    Assert.areEqual(26, audit.checks.size(), 'tous les contrôles sont rendus');
    Assert.areEqual(72, audit.healthCheckScore);
    Assert.isTrue(audit.score >= 0 && audit.score <= 100);
    Assert.isNotNull(audit.grade);
    Assert.isNotNull(audit.orgId);
    Assert.isTrue(audit.activeUsers >= 1);
    OrgSecurityChecks.Check health = find(audit, 'HEALTH_CHECK');
    Assert.areEqual(OrgSecurityChecks.WARNING, health.status);
    Assert.areEqual(2, health.count, 'risques élevés et moyens seulement');
    Assert.areEqual(2, mock.endpoints.size());
    for (OrgSecurityChecks.Check check : audit.checks) {
      Assert.isNotNull(check.status, check.key);
      Assert.isNotNull(check.title, check.key);
      Assert.isNotNull(check.category, check.key);
    }
  }

  @IsTest
  static void lowHealthCheckScoreFails() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    OrgSecurityTestSupport.HealthCheckMock mock = new OrgSecurityTestSupport.HealthCheckMock();
    mock.score = '45';
    OrgSecurityService.Audit audit;
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(true, mock);
      Test.startTest();
      audit = OrgSecurityService.run();
      Test.stopTest();
    }
    Assert.areEqual(OrgSecurityChecks.FAIL, find(audit, 'HEALTH_CHECK').status);
  }

  @IsTest
  static void auditWithoutToolingSkipsTheHealthCheck() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    OrgSecurityService.Audit audit;
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(false, null);
      audit = OrgSecurityService.run();
    }
    OrgSecurityChecks.Check health = find(audit, 'HEALTH_CHECK');
    Assert.areEqual(OrgSecurityChecks.NOT_EVALUATED, health.status);
    Assert.isTrue(health.metric.contains('not configured'), health.metric);
    Assert.isNull(audit.healthCheckScore);
    Assert.isTrue(audit.notEvaluated >= 1);
  }

  @IsTest
  static void toolingFailureIsReported() {
    User admin = OrgSecurityTestSupport.adminWith(
      OrgSecurityTestSupport.fullAccess()
    );
    OrgSecurityTestSupport.HealthCheckMock mock = new OrgSecurityTestSupport.HealthCheckMock();
    mock.statusCode = 500;
    OrgSecurityChecks engine = new OrgSecurityChecks(false);
    System.runAs(admin) {
      OrgSecurityTestSupport.useTooling(true, mock);
      Test.startTest();
      engine.loadHealthCheck();
      Test.stopTest();
    }
    Assert.isNull(engine.healthCheck.score);
    Assert.isTrue(
      engine.healthCheck.message.contains('could not be read'),
      engine.healthCheck.message
    );
  }

  private static OrgSecurityChecks.Check check(String severity, String status) {
    OrgSecurityChecks.Check c = new OrgSecurityChecks.Check();
    c.severity = severity;
    c.status = status;
    return c;
  }

  @IsTest
  static void scoreSubtractsPenalties() {
    OrgSecurityService.Audit audit = new OrgSecurityService.Audit();
    audit.checks.add(check(OrgSecurityChecks.CRITICAL, OrgSecurityChecks.FAIL));
    audit.checks.add(check(OrgSecurityChecks.HIGH, OrgSecurityChecks.WARNING));
    audit.checks.add(check(OrgSecurityChecks.LOW, OrgSecurityChecks.PASS));
    audit.checks.add(
      check(OrgSecurityChecks.MEDIUM, OrgSecurityChecks.NOT_EVALUATED)
    );
    audit.checks.add(check(OrgSecurityChecks.LOW, OrgSecurityChecks.INFO));
    OrgSecurityService.summarise(audit);
    Assert.areEqual(75, audit.score); // 100 - 20 - 10 / 2
    Assert.areEqual('B', audit.grade);
    Assert.areEqual(1, audit.failedBySeverity.get(OrgSecurityChecks.CRITICAL));
    Assert.areEqual(1, audit.warnings);
    Assert.areEqual(1, audit.passed);
    Assert.areEqual(1, audit.notEvaluated);
  }

  @IsTest
  static void scoreNeverGoesBelowZero() {
    OrgSecurityService.Audit audit = new OrgSecurityService.Audit();
    for (Integer i = 0; i < 8; i++) {
      audit.checks.add(
        check(OrgSecurityChecks.CRITICAL, OrgSecurityChecks.FAIL)
      );
    }
    OrgSecurityService.summarise(audit);
    Assert.areEqual(0, audit.score);
    Assert.areEqual('E', audit.grade);
  }

  @IsTest
  static void gradesFollowTheThresholds() {
    Assert.isNull(OrgSecurityService.grade(null));
    Assert.areEqual('A', OrgSecurityService.grade(95));
    Assert.areEqual('B', OrgSecurityService.grade(80));
    Assert.areEqual('C', OrgSecurityService.grade(60));
    Assert.areEqual('D', OrgSecurityService.grade(45));
    Assert.areEqual('E', OrgSecurityService.grade(10));
  }
}
