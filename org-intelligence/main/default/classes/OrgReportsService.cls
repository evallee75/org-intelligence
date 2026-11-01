/**
 * Reports : catalogue des rapports et du tableau de bord natifs (module Recommendations
 * collaboratif) et tendances de résolution des recommandations partagées
 * (OrgIntelRecommendationSource.fillReports). Les tendances des scans sont calculées par
 * l'interface à partir de l'historique gardé dans le navigateur.
 */
public inherited sharing class OrgReportsService {
  /** Dossiers des rapports livrés par les modules (« Org Intelligence - ... ») ; le socle n'en livre plus. */
  private static final String MODULE_FOLDER_PATTERN = 'Org Intelligence - %';
  public static final String DASHBOARD = 'Org_Intelligence_Overview';

  public class ReportsView {
    @AuraEnabled
    public List<ReportRow> reports;
    @AuraEnabled
    public Id dashboardId;
    @AuraEnabled
    public String dashboardTitle;
    @AuraEnabled
    public List<MonthPoint> resolutionTrend;
    @AuraEnabled
    public Integer resolvedLast90Days = 0;
    @AuraEnabled
    public Decimal averageDaysToResolve;
    @AuraEnabled
    public Integer openCount = 0;
    @AuraEnabled
    public Integer createdLast90Days = 0;
    @AuraEnabled
    public List<TypeCount> openByCategory;
    /** Module Recommendations installé : sinon les tendances de résolution sont masquées. */
    @AuraEnabled
    public Boolean recommendationsEnabled = false;
  }

  public class ReportRow {
    @AuraEnabled
    public Id id;
    @AuraEnabled
    public String name;
    @AuraEnabled
    public String developerName;
    @AuraEnabled
    public String description;
    @AuraEnabled
    public Datetime lastRunDate;
  }

  public class TypeCount {
    @AuraEnabled
    public String componentType;
    @AuraEnabled
    public Integer count;

    public TypeCount(String componentType, Integer count) {
      this.componentType = componentType;
      this.count = count;
    }
  }

  public class MonthPoint {
    @AuraEnabled
    public String month;
    @AuraEnabled
    public Integer created = 0;
    @AuraEnabled
    public Integer resolved = 0;
  }

  public static ReportsView getView() {
    ReportsView view = new ReportsView();
    view.reports = new List<ReportRow>();
    for (Report report : [
      SELECT Id, Name, DeveloperName, Description, LastRunDate
      FROM Report
      WHERE FolderName LIKE :MODULE_FOLDER_PATTERN
      WITH USER_MODE
      ORDER BY Name
      LIMIT 50
    ]) {
      ReportRow row = new ReportRow();
      row.id = report.Id;
      row.name = report.Name;
      row.developerName = report.DeveloperName;
      row.description = report.Description;
      row.lastRunDate = report.LastRunDate;
      view.reports.add(row);
    }
    List<Dashboard> dashboards = [
      SELECT Id, Title
      FROM Dashboard
      WHERE DeveloperName = :DASHBOARD
      WITH USER_MODE
      LIMIT 1
    ];
    if (!dashboards.isEmpty()) {
      view.dashboardId = dashboards[0].Id;
      view.dashboardTitle = dashboards[0].Title;
    }

    view.resolutionTrend = new List<MonthPoint>();
    view.openByCategory = new List<TypeCount>();
    OrgIntelRecommendationSource recommendations = OrgIntelModules.recommendations();
    if (recommendations != null) {
      view.recommendationsEnabled = true;
      fillFromModule(view, recommendations.reportsData());
    }
    return view;
  }

  /** Recopie les tendances du module Recommendations (données simples, cf. contrat). */
  @TestVisible
  private static void fillFromModule(
    ReportsView view,
    Map<String, Object> data
  ) {
    if (data == null) {
      return;
    }
    view.resolvedLast90Days = toInteger(data.get('resolvedLast90Days'));
    view.createdLast90Days = toInteger(data.get('createdLast90Days'));
    view.openCount = toInteger(data.get('openCount'));
    Object average = data.get('averageDaysToResolve');
    view.averageDaysToResolve = average == null
      ? null
      : Decimal.valueOf(String.valueOf(average));
    for (Object item : toList(data.get('resolutionTrend'))) {
      Map<String, Object> source = (Map<String, Object>) item;
      MonthPoint point = new MonthPoint();
      point.month = (String) source.get('month');
      point.created = toInteger(source.get('created'));
      point.resolved = toInteger(source.get('resolved'));
      view.resolutionTrend.add(point);
    }
    for (Object item : toList(data.get('openByCategory'))) {
      Map<String, Object> source = (Map<String, Object>) item;
      view.openByCategory.add(
        new TypeCount(
          (String) source.get('componentType'),
          toInteger(source.get('count'))
        )
      );
    }
  }

  private static Integer toInteger(Object value) {
    return value == null ? 0 : Integer.valueOf(value);
  }

  private static List<Object> toList(Object value) {
    return value instanceof List<Object>
      ? (List<Object>) value
      : new List<Object>();
  }
}
