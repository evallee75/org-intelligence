@IsTest
private class OrgAdoptionContractTest {
  private static Map<String, OrgAdoptionContract.LineView> byId(
    OrgAdoptionContract.Summary summary
  ) {
    Map<String, OrgAdoptionContract.LineView> lines = new Map<String, OrgAdoptionContract.LineView>();
    for (OrgAdoptionContract.LineView line : summary.lines) {
      lines.put(line.id, line);
    }
    return lines;
  }

  @IsTest
  static void parseLinesSkipsInvalidEntries() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      List<OrgAdoptionContract.Line> lines = OrgAdoptionContract.parseLines(
        OrgAdoptionTestSupport.contractLines()
      );
      Assert.areEqual(
        6,
        lines.size(),
        'lignes sans produit et non-maps ignorées'
      );
      Assert.isTrue(lines[0].quantity == 30);
      Assert.areEqual(Date.newInstance(2026, 1, 1), lines[0].startDate);
      Assert.areEqual(OrgAdoptionContract.TYPE_USER_LICENSE, lines[1].lineType);
      Assert.areEqual(OrgAdoptionContract.PER_YEAR, lines[1].pricePeriod);
      Assert.isNull(lines[3].quantity, 'nombre illisible');
      Assert.isNull(lines[3].unitPrice, 'nombre négatif');
      Assert.isNull(lines[3].endDate, 'date illisible');
      Assert.areEqual(OrgAdoptionContract.PER_MONTH, lines[3].pricePeriod);
      Assert.isTrue(OrgAdoptionContract.parseLines(null).isEmpty());
      Assert.isTrue(OrgAdoptionContract.parseLines('text').isEmpty());
      Assert.areEqual(
        new List<String>{ OrgAdoptionFeatures.SALES },
        OrgAdoptionContract.contractClouds(lines)
      );
    }
  }

  @IsTest
  static void compareComputesVerdictsAndCosts() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      OrgAdoptionContract.Summary summary = OrgAdoptionContract.compare(
        OrgAdoptionContract.parseLines(OrgAdoptionTestSupport.contractLines()),
        OrgAdoptionTestSupport.analysis()
      );
      Assert.isTrue(summary.hasAnalysis);
      Assert.isTrue(summary.priced);
      Assert.isFalse(summary.licenseOptions.isEmpty());
      Map<String, OrgAdoptionContract.LineView> lines = byId(summary);

      OrgAdoptionContract.LineView sales = lines.get('L1');
      Assert.areEqual('Unused licenses', sales.verdict);
      Assert.isTrue(sales.unused == 15, String.valueOf(sales.unused));
      Assert.isTrue(
        sales.annualWaste == 29700,
        String.valueOf(sales.annualWaste)
      );
      Assert.areEqual(40, sales.cloudScore);
      Assert.areEqual('Check quantity', lines.get('L2').verdict);
      Assert.areEqual('Over limit', lines.get('L3').verdict);
      Assert.isNull(lines.get('L3').unused);
      Assert.areEqual('Not matched', lines.get('L4').verdict);
      Assert.areEqual('No quantity', lines.get('L5').verdict);
      Assert.areEqual('Not matched', lines.get('L6').verdict);
      Assert.isTrue(lines.get('L6').detail.contains('not found'));

      Assert.areEqual(Date.today().addDays(60), summary.nextRenewal);
      Assert.areEqual(60, summary.nextRenewalDays);
      Assert.isTrue(summary.annualWaste >= 29700);
      Assert.isTrue(summary.unusedLicenses >= 15);
      Assert.areEqual(
        new List<String>{ OrgAdoptionFeatures.SALES },
        summary.clouds
      );
    }
  }

  @IsTest
  static void sharedLicenseSplitsTheUsage() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      List<Object> raw = new List<Object>{
        new Map<String, Object>{
          'id' => 'A',
          'product' => 'Sales Cloud',
          'quantity' => 15,
          'matchedKey' => 'USER:Salesforce'
        },
        new Map<String, Object>{
          'id' => 'B',
          'product' => 'Service Cloud',
          'quantity' => 15,
          'matchedKey' => 'USER:Salesforce'
        },
        new Map<String, Object>{
          'id' => 'C',
          'product' => 'Entitlement in use',
          'lineType' => OrgAdoptionContract.TYPE_ENTITLEMENT,
          'quantity' => 5000,
          'matchedKey' => 'ENT:ApiCalls'
        }
      };
      Map<String, OrgAdoptionContract.LineView> lines = byId(
        OrgAdoptionContract.compare(
          OrgAdoptionContract.parseLines(raw),
          OrgAdoptionTestSupport.analysis()
        )
      );
      Assert.areEqual(1, lines.get('A').sharedWith);
      Assert.isTrue(lines.get('A').detail.contains('shared with'));
      Assert.areEqual('Fully used', lines.get('C').verdict);
    }
  }

  @IsTest
  static void compareWithoutAnalysisKeepsTheLines() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      OrgAdoptionContract.Summary summary = OrgAdoptionContract.compare(
        OrgAdoptionContract.parseLines(OrgAdoptionTestSupport.contractLines()),
        null
      );
      Assert.isFalse(summary.hasAnalysis);
      Assert.areEqual(6, summary.lines.size());
      for (OrgAdoptionContract.LineView line : summary.lines) {
        Assert.areEqual('Not matched', line.verdict);
      }
      OrgAdoptionService.Analysis empty = new OrgAdoptionService.Analysis();
      Assert.isTrue(
        OrgAdoptionContract.compare(new List<OrgAdoptionContract.Line>(), empty)
          .licenseOptions.isEmpty()
      );
    }
  }

  @IsTest
  static void prefillProposesPaidUserLicenses() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      OrgAdoptionService.Analysis analysis = OrgAdoptionTestSupport.analysis();
      List<OrgAdoptionContract.Line> created = OrgAdoptionContract.prefill(
        analysis,
        new List<OrgAdoptionContract.Line>()
      );
      // Salesforce et Salesforce Platform ; pas Chatter Free (incluse) ni la licence désactivée
      Assert.areEqual(2, created.size());
      Assert.areEqual(OrgAdoptionFeatures.SALES, created[0].cloud);
      Assert.areEqual(OrgAdoptionFeatures.PLATFORM, created[1].cloud);

      // Licence déjà rattachée : ignorée ; cloud Service repris de l'analyse
      analysis.selectedClouds = new List<String>{ OrgAdoptionFeatures.SERVICE };
      OrgAdoptionContract.Line existing = new OrgAdoptionContract.Line();
      existing.matchedKey = 'USER:Salesforce Platform';
      created = OrgAdoptionContract.prefill(
        analysis,
        new List<OrgAdoptionContract.Line>{ existing }
      );
      Assert.areEqual(1, created.size());
      Assert.areEqual(OrgAdoptionFeatures.SERVICE, created[0].cloud);

      analysis.selectedClouds = null;
      Assert.isNull(
        OrgAdoptionContract.prefill(
            analysis,
            new List<OrgAdoptionContract.Line>{ existing }
          )[0]
          .cloud
      );

      try {
        OrgAdoptionContract.prefill(null, new List<OrgAdoptionContract.Line>());
        Assert.fail('analyse requise');
      } catch (IllegalArgumentException e) {
        Assert.isTrue(e.getMessage().contains('Run an adoption analysis'));
      }
    }
  }

  @IsTest
  static void guessCloudFromProductNames() {
    User admin = OrgAdoptionTestSupport.adminUser();
    System.runAs(admin) {
      Assert.areEqual(
        OrgAdoptionFeatures.FIELD_SERVICE,
        OrgAdoptionContract.guessCloud('Field Service Technician')
      );
      Assert.areEqual(
        OrgAdoptionFeatures.SERVICE,
        OrgAdoptionContract.guessCloud('Service Cloud Unlimited')
      );
      Assert.areEqual(
        OrgAdoptionFeatures.SALES,
        OrgAdoptionContract.guessCloud('Sales Cloud Enterprise')
      );
      Assert.areEqual(
        OrgAdoptionFeatures.EXPERIENCE,
        OrgAdoptionContract.guessCloud('Customer Community Plus')
      );
      Assert.areEqual(
        OrgAdoptionFeatures.PLATFORM,
        OrgAdoptionContract.guessCloud('Lightning Platform Starter')
      );
      Assert.isNull(OrgAdoptionContract.guessCloud(null));
      Assert.areEqual(
        'USER:Salesforce',
        OrgAdoptionContract.userLicenseKey('Salesforce')
      );
    }
  }
}
