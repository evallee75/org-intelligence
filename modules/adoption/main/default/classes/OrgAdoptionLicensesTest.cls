@IsTest
private class OrgAdoptionLicensesTest {
  @IsTest
  static void collectReadsTheOrgLicenses() {
    User admin = OrgAdoptionTestSupport.adminUser();
    // Utilisateur jamais connecté : compté comme inactif
    OrgAdoptionTestSupport.userWithoutModule();
    System.runAs(admin) {
      Test.startTest();
      OrgAdoptionLicenses.Result result = OrgAdoptionLicenses.collect();
      Test.stopTest();
      // Les licences dépendent de l'org : contrôles robustes
      Assert.isNotNull(result);
      Assert.isTrue(result.activeInternalUsers >= 1);
      Assert.isTrue(
        result.neverLoggedIn >= 1,
        'utilisateurs de test jamais connectés'
      );
      Assert.isTrue(result.paidSeats >= 0);
      Assert.isFalse(
        result.userLicenses.isEmpty(),
        'au moins la licence Salesforce'
      );
      for (OrgAdoptionLicenses.UserLicenseRow row : result.userLicenses) {
        Assert.isNotNull(row.verdict);
      }
      for (OrgAdoptionLicenses.AddOnRow row : result.addOns) {
        Assert.isNotNull(row.verdict);
      }
      Assert.isNotNull(OrgAdoptionLicenses.licenseNames(result));
    }
  }

  @IsTest
  static void includedLicensesAreRecognised() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Assert.isTrue(OrgAdoptionLicenses.isIncluded('Chatter Free'));
      Assert.isTrue(OrgAdoptionLicenses.isIncluded('Guest User License'));
      Assert.isFalse(OrgAdoptionLicenses.isIncluded('Salesforce'));
      Assert.isFalse(OrgAdoptionLicenses.isIncluded(null));
    }
  }

  @IsTest
  static void userLicenseVerdicts() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Assert.areEqual(
        'Inactive',
        OrgAdoptionTestSupport.userLicense('X', 'Disabled', 5, 1, 0, false)
          .verdict
      );
      Assert.areEqual(
        'Included',
        OrgAdoptionTestSupport.userLicense('X', 'Active', 5, 1, 0, true).verdict
      );
      Assert.areEqual(
        'Over-allocated',
        OrgAdoptionTestSupport.userLicense('X', 'Active', 5, 6, 0, false)
          .verdict
      );
      Assert.areEqual(
        'Seats to reclaim',
        OrgAdoptionTestSupport.userLicense('X', 'Active', 20, 15, 1, false)
          .verdict
      );
      Assert.areEqual(
        'OK',
        OrgAdoptionTestSupport.userLicense('X', 'Active', 100, 99, 0, false)
          .verdict
      );
    }
  }

  @IsTest
  static void addOnVerdicts() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Date soon = Date.today().addDays(90);
      OrgAdoptionLicenses.AddOnRow row = OrgAdoptionTestSupport.addOn(
        'PSL:A',
        'A',
        'Permission set license',
        10,
        0,
        null,
        null
      );
      Assert.areEqual(
        'Never assigned',
        OrgAdoptionLicenses.addOnVerdict(row, soon)
      );

      row.used = 2;
      row.utilization = 20;
      Assert.areEqual('Low use', OrgAdoptionLicenses.addOnVerdict(row, soon));

      row.used = 9;
      row.utilization = 90;
      Assert.areEqual('In use', OrgAdoptionLicenses.addOnVerdict(row, soon));

      row.expirationDate = Date.today().addDays(30);
      Assert.areEqual(
        'Expiring soon',
        OrgAdoptionLicenses.addOnVerdict(row, soon)
      );

      row.expirationDate = Date.today().addDays(-1);
      Assert.areEqual('Expired', OrgAdoptionLicenses.addOnVerdict(row, soon));

      row.expirationDate = Date.today().addDays(365);
      Assert.areEqual('In use', OrgAdoptionLicenses.addOnVerdict(row, soon));

      row.status = 'Disabled';
      Assert.areEqual('Inactive', OrgAdoptionLicenses.addOnVerdict(row, soon));
      row.expirationDate = Date.today().addDays(-10);
      Assert.areEqual('Expired', OrgAdoptionLicenses.addOnVerdict(row, soon));
    }
  }

  @IsTest
  static void licenseNamesAndFeatureCounts() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      OrgAdoptionLicenses.Result result = OrgAdoptionTestSupport.analysis()
        .licenses;
      OrgAdoptionLicenses.FeatureLicenseRow support = new OrgAdoptionLicenses.FeatureLicenseRow();
      support.key = 'UserPermissionsSupportUser';
      support.assigned = 4;
      result.featureLicenses.add(support);

      Set<String> names = OrgAdoptionLicenses.licenseNames(result);
      Assert.isTrue(names.contains('salesforce'));
      Assert.isFalse(names.contains('chatter free'), 'licence incluse exclue');
      Assert.isFalse(names.contains('old license'), 'licence inactive exclue');
      Assert.isTrue(names.contains('cpq'));
      Assert.isFalse(names.contains('api calls'), 'droit d\'usage exclu');
      Assert.areEqual(
        4,
        OrgAdoptionLicenses.featureLicenseCount(
          result,
          'UserPermissionsSupportUser'
        )
      );
      Assert.areEqual(
        0,
        OrgAdoptionLicenses.featureLicenseCount(
          result,
          'UserPermissionsMarketingUser'
        )
      );
    }
  }
}
