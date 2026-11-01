@IsTest
private class OrgAdoptionFeaturesTest {
  /**
   * Quelques enregistrements récents pour que les mesures sortent du « Not used ». Les règles de
   * validation de l'org peuvent refuser une insertion : la mesure reste alors à zéro, sans échec.
   */
  private static void createActivity() {
    List<SObject> records = new List<SObject>();
    for (Integer i = 0; i < 12; i++) {
      records.add(new Lead(LastName = 'Lead ' + i, Company = 'Company ' + i));
    }
    tryInsert(records);
    Account account = new Account(Name = 'Adoption test');
    tryInsert(new List<SObject>{ account });
    if (account.Id != null) {
      List<SObject> deals = new List<SObject>();
      for (Integer i = 0; i < 3; i++) {
        deals.add(
          new Opportunity(
            Name = 'Deal ' + i,
            AccountId = account.Id,
            StageName = [
              SELECT ApiName
              FROM OpportunityStage
              WHERE IsActive = TRUE
              ORDER BY SortOrder
              LIMIT 1
            ]
            .ApiName,
            CloseDate = Date.today().addDays(30)
          )
        );
      }
      tryInsert(deals);
      tryInsert(
        new List<SObject>{
          new Case(Subject = 'Case', AccountId = account.Id, Origin = 'Web'),
          new Task(Subject = 'Call', WhatId = account.Id),
          new Campaign(Name = 'Campaign')
        }
      );
    }
  }

  private static void tryInsert(List<SObject> records) {
    Database.insert(records, false);
  }

  @IsTest
  static void evaluateMeasuresEveryFeature() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      createActivity();
      Test.startTest();
      OrgAdoptionLicenses.Result licenses = OrgAdoptionLicenses.collect();
      OrgAdoptionFeatures engine = new OrgAdoptionFeatures(licenses);
      List<OrgAdoptionFeatures.Feature> features = engine.evaluate();
      Map<String, OrgAdoptionFeatures.CloudSummary> clouds = engine.detectClouds(
        features
      );
      Integer score = OrgAdoptionFeatures.score(features, clouds);
      Test.stopTest();

      Assert.areEqual(OrgAdoptionFeatures.catalog().size(), features.size());
      Set<String> statuses = new Set<String>{
        OrgAdoptionFeatures.ADOPTED,
        OrgAdoptionFeatures.PARTIAL,
        OrgAdoptionFeatures.NOT_USED,
        OrgAdoptionFeatures.NOT_ENABLED,
        OrgAdoptionFeatures.UNKNOWN
      };
      for (OrgAdoptionFeatures.Feature feature : features) {
        Assert.isTrue(
          statuses.contains(feature.status),
          feature.key + ' : ' + feature.status
        );
        Assert.isNotNull(feature.metric, feature.key);
        Assert.isTrue(feature.learnUrl.startsWith('https://trailhead'));
      }
      Assert.areEqual(OrgAdoptionFeatures.CLOUD_ORDER.size(), clouds.size());
      Assert.isTrue(
        clouds.get(OrgAdoptionFeatures.PLATFORM).detected,
        'Platform toujours détectée'
      );
      Assert.isTrue(score == null || (score >= 0 && score <= 100));
    }
  }

  @IsTest
  static void detectCloudsFromLicensesAndUsage() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      OrgAdoptionLicenses.Result licenses = new OrgAdoptionLicenses.Result();
      licenses.userLicenses.add(
        OrgAdoptionTestSupport.userLicense(
          'Salesforce',
          'Active',
          10,
          5,
          0,
          false
        )
      );
      licenses.userLicenses.add(
        OrgAdoptionTestSupport.userLicense(
          'Customer Community',
          'Active',
          100,
          5,
          0,
          false
        )
      );
      licenses.addOns.add(
        OrgAdoptionTestSupport.addOn(
          'PSL:FS',
          'Field Service Mobile',
          'Permission set license',
          5,
          1,
          'In use',
          null
        )
      );
      OrgAdoptionLicenses.FeatureLicenseRow support = new OrgAdoptionLicenses.FeatureLicenseRow();
      support.key = 'UserPermissionsSupportUser';
      support.assigned = 3;
      licenses.featureLicenses.add(support);

      OrgAdoptionFeatures engine = new OrgAdoptionFeatures(licenses);
      Map<String, OrgAdoptionFeatures.CloudSummary> clouds = engine.detectClouds(
        new List<OrgAdoptionFeatures.Feature>()
      );
      for (String name : OrgAdoptionFeatures.CLOUD_ORDER) {
        Assert.isTrue(clouds.get(name).detected, name);
        Assert.isNotNull(clouds.get(name).signal, name);
      }
      Assert.areEqual(
        'Salesforce user licenses',
        clouds.get(OrgAdoptionFeatures.SALES).signal
      );

      // Sans licence : détection par l'usage
      engine = new OrgAdoptionFeatures(new OrgAdoptionLicenses.Result());
      clouds = engine.detectClouds(
        new List<OrgAdoptionFeatures.Feature>{
          OrgAdoptionTestSupport.feature(
            'LEADS',
            OrgAdoptionFeatures.SALES,
            2,
            OrgAdoptionFeatures.ADOPTED
          ),
          OrgAdoptionTestSupport.feature(
            'CASES',
            OrgAdoptionFeatures.SERVICE,
            2,
            OrgAdoptionFeatures.PARTIAL
          ),
          OrgAdoptionTestSupport.feature(
            'SITES',
            OrgAdoptionFeatures.EXPERIENCE,
            2,
            OrgAdoptionFeatures.NOT_USED
          ),
          OrgAdoptionTestSupport.feature(
            'SERVICE_APPOINTMENTS',
            OrgAdoptionFeatures.FIELD_SERVICE,
            2,
            OrgAdoptionFeatures.ADOPTED
          )
        }
      );
      Assert.areEqual(
        'Leads or opportunities in use',
        clouds.get(OrgAdoptionFeatures.SALES).signal
      );
      Assert.areEqual(
        'Cases, Knowledge or Omni-Channel in use',
        clouds.get(OrgAdoptionFeatures.SERVICE).signal
      );
      Assert.areEqual(
        'Digital Experiences enabled',
        clouds.get(OrgAdoptionFeatures.EXPERIENCE).signal
      );
      Assert.areEqual(
        'Service appointments in use',
        clouds.get(OrgAdoptionFeatures.FIELD_SERVICE).signal
      );

      clouds = engine.detectClouds(new List<OrgAdoptionFeatures.Feature>());
      Assert.isFalse(clouds.get(OrgAdoptionFeatures.SALES).detected);
      Assert.isFalse(clouds.get(OrgAdoptionFeatures.EXPERIENCE).detected);
    }
  }

  @IsTest
  static void scoreWeightsSelectedClouds() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Map<String, OrgAdoptionFeatures.CloudSummary> clouds = new Map<String, OrgAdoptionFeatures.CloudSummary>();
      for (String name : OrgAdoptionFeatures.CLOUD_ORDER) {
        OrgAdoptionFeatures.CloudSummary summary = new OrgAdoptionFeatures.CloudSummary();
        summary.name = name;
        summary.selected = name == OrgAdoptionFeatures.SALES;
        clouds.put(name, summary);
      }
      List<OrgAdoptionFeatures.Feature> features = new List<OrgAdoptionFeatures.Feature>{
        OrgAdoptionTestSupport.feature(
          'A',
          OrgAdoptionFeatures.SALES,
          2,
          OrgAdoptionFeatures.ADOPTED
        ),
        OrgAdoptionTestSupport.feature(
          'B',
          OrgAdoptionFeatures.SALES,
          1,
          OrgAdoptionFeatures.PARTIAL
        ),
        OrgAdoptionTestSupport.feature(
          'C',
          OrgAdoptionFeatures.SALES,
          1,
          OrgAdoptionFeatures.NOT_USED
        ),
        OrgAdoptionTestSupport.feature(
          'D',
          OrgAdoptionFeatures.SALES,
          1,
          OrgAdoptionFeatures.UNKNOWN
        ),
        OrgAdoptionTestSupport.feature(
          'E',
          OrgAdoptionFeatures.SERVICE,
          2,
          OrgAdoptionFeatures.NOT_ENABLED
        ),
        OrgAdoptionTestSupport.feature(
          'F',
          'Other cloud',
          1,
          OrgAdoptionFeatures.ADOPTED
        )
      };
      // (2 × 1 + 1 × 0,5 + 0) / 4 = 62,5 → 63
      Assert.areEqual(63, OrgAdoptionFeatures.score(features, clouds));
      Assert.areEqual(3, clouds.get(OrgAdoptionFeatures.SALES).evaluated);
      Assert.areEqual(1, clouds.get(OrgAdoptionFeatures.SALES).adopted);
      Assert.areEqual(1, clouds.get(OrgAdoptionFeatures.SALES).partial);
      Assert.areEqual(1, clouds.get(OrgAdoptionFeatures.SALES).unused);
      Assert.areEqual(1, clouds.get(OrgAdoptionFeatures.SERVICE).notEnabled);
      Assert.areEqual(0, clouds.get(OrgAdoptionFeatures.SERVICE).score);
      Assert.isNull(clouds.get(OrgAdoptionFeatures.PLATFORM).score);

      for (OrgAdoptionFeatures.CloudSummary summary : clouds.values()) {
        summary.selected = false;
      }
      Assert.isNull(
        OrgAdoptionFeatures.score(features, clouds),
        'aucun cloud retenu'
      );
    }
  }
}
