/**
 * Vue Automation, partie serveur : erreurs d'exécution récentes des flows (lues en direct).
 * Les automatisations, boucles et constats viennent du dernier scan gardé dans le navigateur
 * (orgIntelScanData.buildAutomationView) ; le regroupement par objet, l'ordre d'exécution et les
 * conflits sont calculés dans l'interface.
 */
public inherited sharing class OrgAutomationService {
  /** Fenêtre des erreurs d'exécution affichées. */
  public static final Integer ERROR_DAYS = 30;
  private static final Integer ERROR_SAMPLES = 5;

  public class AutomationView {
    @AuraEnabled
    public String orgDomainUrl;
    @AuraEnabled
    public List<FlowErrorSummary> flowErrors;
    @AuraEnabled
    public Integer errorDays = ERROR_DAYS;
    /** Message si les erreurs n'ont pas pu être lues (droits). */
    @AuraEnabled
    public String flowErrorsMessage;
  }

  /** Erreurs d'exécution d'un flow sur la période (interviews en échec, journal des interviews). */
  public class FlowErrorSummary {
    @AuraEnabled
    public String flowApiName;
    @AuraEnabled
    public Integer count = 0;
    @AuraEnabled
    public Datetime lastAt;
    @AuraEnabled
    public List<FlowErrorSample> samples = new List<FlowErrorSample>();
  }

  public class FlowErrorSample {
    @AuraEnabled
    public Id interviewId;
    @AuraEnabled
    public Datetime occurredAt;
    @AuraEnabled
    public String element;
    @AuraEnabled
    public String message;
    @AuraEnabled
    public String userName;
    @AuraEnabled
    public String label;
    @AuraEnabled
    public Decimal versionNumber;
  }

  public static AutomationView getView() {
    AutomationView view = new AutomationView();
    view.orgDomainUrl = Url.getOrgDomainUrl().toExternalForm();
    // Les messages d'erreur des flows contiennent souvent des valeurs d'enregistrements : réservés
    // aux administrateurs Org Intelligence (lecture en mode système)
    if (OrgIntelAccess.isAdmin()) {
      loadFlowErrors(view);
    } else {
      view.flowErrors = new List<FlowErrorSummary>();
      view.flowErrorsMessage = 'Flow run errors are visible to Org Intelligence administrators only.';
    }
    return view;
  }

  /**
   * Erreurs d'exécution récentes : interviews en échec (« Failed Flow Interviews », conservées par
   * Salesforce) puis journal des interviews quand la journalisation est activée. Lecture en mode
   * utilisateur (« Manage Flows » requis : sinon l'exception est interceptée et la carte reste
   * vide) ; appelée seulement pour les administrateurs Org Intelligence.
   */
  private static void loadFlowErrors(AutomationView view) {
    view.flowErrors = new List<FlowErrorSummary>();
    Map<String, FlowErrorSummary> byFlow = new Map<String, FlowErrorSummary>();
    Datetime since = Datetime.now().addDays(-ERROR_DAYS);
    try {
      List<FlowInterview> interviews = [
        SELECT
          Id,
          InterviewLabel,
          CurrentElement,
          Error,
          CreatedDate,
          CreatedBy.Name,
          FlowVersionView.FlowDefinitionView.ApiName,
          FlowVersionView.VersionNumber
        FROM FlowInterview
        WHERE InterviewStatus = 'Error' AND CreatedDate >= :since
        WITH USER_MODE
        ORDER BY CreatedDate DESC
        LIMIT 2000
      ];
      addInterviews(byFlow, interviews);
      List<FlowInterviewLog> logs = [
        SELECT
          Id,
          FlowDeveloperName,
          FlowVersionNumber,
          InterviewStartTimestamp,
          CreatedDate,
          CreatedBy.Name
        FROM FlowInterviewLog
        WHERE InterviewStatus = 'Error' AND CreatedDate >= :since
        WITH USER_MODE
        ORDER BY CreatedDate DESC
        LIMIT 2000
      ];
      addLogs(byFlow, logs);
    } catch (Exception e) {
      view.flowErrorsMessage =
        'Flow errors could not be read: ' + e.getMessage();
    }
    view.flowErrors.addAll(byFlow.values());
  }

  @TestVisible
  private static void addInterviews(
    Map<String, FlowErrorSummary> byFlow,
    List<FlowInterview> interviews
  ) {
    for (FlowInterview interview : interviews) {
      String apiName = interview.FlowVersionView?.FlowDefinitionView?.ApiName;
      if (apiName == null) {
        continue;
      }
      FlowErrorSample sample = new FlowErrorSample();
      sample.interviewId = interview.Id;
      sample.occurredAt = interview.CreatedDate;
      sample.element = interview.CurrentElement;
      sample.message = interview.Error == null
        ? null
        : interview.Error.left(1000);
      sample.userName = interview.CreatedBy?.Name;
      sample.label = interview.InterviewLabel;
      sample.versionNumber = interview.FlowVersionView?.VersionNumber;
      addError(byFlow, apiName, sample);
    }
  }

  @TestVisible
  private static void addLogs(
    Map<String, FlowErrorSummary> byFlow,
    List<FlowInterviewLog> logs
  ) {
    for (FlowInterviewLog log : logs) {
      if (log.FlowDeveloperName == null) {
        continue;
      }
      FlowErrorSample sample = new FlowErrorSample();
      sample.occurredAt = log.InterviewStartTimestamp != null
        ? log.InterviewStartTimestamp
        : log.CreatedDate;
      sample.userName = log.CreatedBy?.Name;
      sample.versionNumber = log.FlowVersionNumber;
      addError(byFlow, log.FlowDeveloperName, sample);
    }
  }

  @TestVisible
  private static void addError(
    Map<String, FlowErrorSummary> byFlow,
    String apiName,
    FlowErrorSample sample
  ) {
    if (!byFlow.containsKey(apiName)) {
      FlowErrorSummary summary = new FlowErrorSummary();
      summary.flowApiName = apiName;
      byFlow.put(apiName, summary);
    }
    FlowErrorSummary summary = byFlow.get(apiName);
    summary.count++;
    if (summary.lastAt == null || sample.occurredAt > summary.lastAt) {
      summary.lastAt = sample.occurredAt;
    }
    if (summary.samples.size() < ERROR_SAMPLES) {
      summary.samples.add(sample);
    }
  }
}
