/**
 * Export des recommandations vers Jira Cloud (API REST v3, création groupée).
 *
 * Connexion : Named Credential OrgIntelligenceJira (External Credential « Custom », en-tête
 * Basic e-mail + jeton d'API). Les identifiants sont saisis dans Settings et stockés chiffrés par
 * Salesforce (API ConnectApi.NamedCredentials) : jamais dans le code ni dans les journaux.
 *
 * Un ticket par recommandation : titre, description structurée (constat, preuves, action, lien
 * retour vers Salesforce), priorité selon la gravité, étiquettes. La clé du ticket est enregistrée
 * sur la recommandation (historisée). Chaque appel est tracé dans le journal API.
 */
public with sharing class OrgJiraService {
  public static final String NAMED_CREDENTIAL = 'OrgIntelligenceJira';
  public static final String EXTERNAL_CREDENTIAL = 'OrgIntelligenceJira';
  public static final String PRINCIPAL = 'JiraUser';
  public static final String PLACEHOLDER_URL = 'https://your-site.atlassian.net';
  /** Nombre maximal de recommandations par export (au-delà : message clair plutôt qu'une coupure muette). */
  public static final Integer MAX_EXPORT = 500;
  private static final Integer BATCH_SIZE = 50;
  private static final Map<String, String> PRIORITIES = new Map<String, String>{
    'Critical' => 'Highest',
    'High' => 'High',
    'Medium' => 'Medium',
    'Low' => 'Low',
    'Info' => 'Lowest'
  };

  public class JiraException extends Exception {
  }

  // ---------- Paramètres et état ----------

  public class JiraStatus {
    @AuraEnabled
    public Boolean configured = false;
    @AuraEnabled
    public Boolean connected;
    @AuraEnabled
    public String siteUrl;
    @AuraEnabled
    public String projectKey;
    @AuraEnabled
    public String issueType;
    @AuraEnabled
    public String accountName;
    @AuraEnabled
    public String projectName;
    @AuraEnabled
    public String message;
  }

  public static JiraStatus status() {
    JiraStatus status = new JiraStatus();
    status.projectKey = OrgIntelSettings.jiraProjectKey();
    status.issueType = OrgIntelSettings.jiraIssueType();
    status.siteUrl = siteUrl();
    status.configured =
      String.isNotBlank(status.siteUrl) &&
      status.siteUrl != PLACEHOLDER_URL &&
      String.isNotBlank(status.projectKey);
    status.message = status.configured
      ? 'Jira is configured.'
      : 'Jira is not configured yet: an administrator must enter the site, the account and the project in Settings.';
    return status;
  }

  /** Tests : URL de la Named Credential (non modifiable dans un test). */
  @TestVisible
  private static String siteUrlOverride;

  private static String siteUrl() {
    if (siteUrlOverride != null) {
      return siteUrlOverride;
    }
    try {
      return ConnectApi.NamedCredentials.getNamedCredential(
          OrgIntelNamespace.qualify(NAMED_CREDENTIAL)
        )
        .calloutUrl;
    } catch (Exception e) {
      List<NamedCredential> credentials = [
        SELECT Endpoint
        FROM NamedCredential
        WHERE
          DeveloperName = :NAMED_CREDENTIAL
          AND NamespacePrefix = :OrgIntelNamespace.namespaceFilter()
        LIMIT 1
      ];
      return credentials.isEmpty() ? null : credentials[0].Endpoint;
    }
  }

  /** Vérifie le compte (myself) et le projet ; fait des appels HTTP, aucune écriture avant. */
  public static JiraStatus testConnection() {
    JiraStatus status = status();
    if (!status.configured) {
      return status;
    }
    try {
      Map<String, Object> me = (Map<String, Object>) JSON.deserializeUntyped(
        send('GET', '/rest/api/3/myself', null, 'Check account')
      );
      status.accountName = (String) me.get('displayName');
      Map<String, Object> project = (Map<String, Object>) JSON.deserializeUntyped(
        send(
          'GET',
          '/rest/api/3/project/' +
          EncodingUtil.urlEncode(status.projectKey, 'UTF-8'),
          null,
          'Check project'
        )
      );
      status.projectName = (String) project.get('name');
      status.connected = true;
      status.message =
        'Connected as ' +
        status.accountName +
        ' to the project ' +
        status.projectName +
        ' (' +
        status.projectKey +
        ').';
    } catch (Exception e) {
      status.connected = false;
      status.message = e.getMessage();
    }
    OrgApiLogger.flush();
    return status;
  }

  /**
   * Enregistre le site, le compte et le projet. Le jeton n'est remplacé que s'il est fourni ; il est
   * stocké chiffré dans l'External Credential.
   */
  public static void saveSettings(
    String siteUrlValue,
    String email,
    String apiToken,
    String projectKey,
    String issueType
  ) {
    String site = siteUrlValue == null
      ? ''
      : siteUrlValue.trim().removeEnd('/');
    // Jira Cloud uniquement : l'export ne peut viser qu'un site Atlassian (pas un serveur quelconque)
    if (!isJiraCloudSite(site)) {
      throw new JiraException(
        'Enter a Jira Cloud site as https://your-site.atlassian.net (other servers are not supported).'
      );
    }
    if (
      String.isBlank(projectKey) ||
      !Pattern.matches('[A-Za-z][A-Za-z0-9_]{0,29}', projectKey.trim())
    ) {
      throw new JiraException(
        'Enter a valid Jira project key (for example ORG).'
      );
    }

    // URL de la Named Credential
    // Noms qualifiés par le namespace en package géré (credentials livrées par le package)
    String namedCredential = OrgIntelNamespace.qualify(NAMED_CREDENTIAL);
    String externalCredential = OrgIntelNamespace.qualify(EXTERNAL_CREDENTIAL);
    ConnectApi.NamedCredential current = ConnectApi.NamedCredentials.getNamedCredential(
      namedCredential
    );
    ConnectApi.NamedCredentialInput input = new ConnectApi.NamedCredentialInput();
    input.developerName = namedCredential;
    input.masterLabel = current.masterLabel;
    input.type = ConnectApi.NamedCredentialType.SecuredEndpoint;
    input.calloutUrl = site;
    ConnectApi.ExternalCredentialInput external = new ConnectApi.ExternalCredentialInput();
    external.developerName = externalCredential;
    input.externalCredentials = new List<ConnectApi.ExternalCredentialInput>{
      external
    };
    ConnectApi.NamedCredentialCalloutOptionsInput options = new ConnectApi.NamedCredentialCalloutOptionsInput();
    options.allowMergeFieldsInBody = false;
    options.allowMergeFieldsInHeader = true;
    options.generateAuthorizationHeader = false;
    input.calloutOptions = options;
    ConnectApi.NamedCredentials.updateNamedCredential(namedCredential, input);

    // Identifiants (chiffrés pour le jeton)
    if (String.isNotBlank(email) || String.isNotBlank(apiToken)) {
      ConnectApi.CredentialInput credential = new ConnectApi.CredentialInput();
      credential.externalCredential = externalCredential;
      credential.principalName = PRINCIPAL;
      credential.principalType = ConnectApi.CredentialPrincipalType.NamedPrincipal;
      credential.authenticationProtocol = ConnectApi.CredentialAuthenticationProtocol.Custom;
      credential.credentials = new Map<String, ConnectApi.CredentialValueInput>();
      if (String.isNotBlank(email)) {
        ConnectApi.CredentialValueInput emailValue = new ConnectApi.CredentialValueInput();
        emailValue.value = email.trim();
        emailValue.encrypted = false;
        credential.credentials.put('Email', emailValue);
      }
      if (String.isNotBlank(apiToken)) {
        ConnectApi.CredentialValueInput tokenValue = new ConnectApi.CredentialValueInput();
        tokenValue.value = apiToken.trim();
        tokenValue.encrypted = true;
        credential.credentials.put('ApiToken', tokenValue);
      }
      try {
        ConnectApi.NamedCredentials.updateCredential(credential);
      } catch (Exception e) {
        ConnectApi.NamedCredentials.createCredential(credential);
      }
    }

    // Projet et type de ticket (custom setting OrgIntelSettings__c, enregistrement immédiat)
    OrgSettingsService.updateJira(
      projectKey.trim().toUpperCase(),
      String.isBlank(issueType) ? 'Task' : issueType.trim()
    );
  }

  /** Site Jira Cloud : https://<nom>.atlassian.net, sans chemin ni port. */
  @TestVisible
  private static Boolean isJiraCloudSite(String site) {
    return site != null &&
      Pattern.matches('https://[a-zA-Z0-9-]+\\.atlassian\\.net', site);
  }

  // ---------- Export ----------

  public class ExportResult {
    @AuraEnabled
    public Id recommendationId;
    @AuraEnabled
    public String recommendationName;
    @AuraEnabled
    public String title;
    @AuraEnabled
    public String issueKey;
    @AuraEnabled
    public String issueUrl;
    @AuraEnabled
    public String error;
    @AuraEnabled
    public Boolean skipped = false;
  }

  public class PreviewItem {
    @AuraEnabled
    public Id recommendationId;
    @AuraEnabled
    public String recommendationName;
    @AuraEnabled
    public String summary;
    @AuraEnabled
    public String priority;
    @AuraEnabled
    public List<String> labels;
    @AuraEnabled
    public String existingKey;
    @AuraEnabled
    public String existingUrl;
  }

  public class Preview {
    @AuraEnabled
    public JiraStatus status;
    @AuraEnabled
    public List<PreviewItem> items;
    @AuraEnabled
    public String samplePayload;
  }

  public static Preview preview(List<Id> recordIds) {
    Preview result = new Preview();
    result.status = status();
    result.items = new List<PreviewItem>();
    List<OrgRecommendation__c> records = load(recordIds);
    for (OrgRecommendation__c rec : records) {
      PreviewItem item = new PreviewItem();
      item.recommendationId = rec.Id;
      item.recommendationName = rec.Name;
      item.summary = summaryOf(rec);
      item.priority = PRIORITIES.get(rec.Severity__c);
      item.labels = labelsOf(rec);
      item.existingKey = rec.JiraIssueKey__c;
      item.existingUrl = rec.JiraIssueUrl__c;
      result.items.add(item);
    }
    if (!records.isEmpty()) {
      result.samplePayload = JSON.serializePretty(
        issueFields(records[0], result.status, true)
      );
    }
    return result;
  }

  public static List<ExportResult> export(
    List<Id> recordIds,
    Boolean includeExported
  ) {
    JiraStatus status = status();
    if (!status.configured) {
      throw new JiraException(status.message);
    }
    List<OrgRecommendation__c> records = load(recordIds);
    List<ExportResult> results = new List<ExportResult>();
    List<OrgRecommendation__c> toExport = new List<OrgRecommendation__c>();
    for (OrgRecommendation__c rec : records) {
      if (String.isNotBlank(rec.JiraIssueKey__c) && includeExported != true) {
        ExportResult skipped = resultOf(rec);
        skipped.skipped = true;
        skipped.issueKey = rec.JiraIssueKey__c;
        skipped.issueUrl = rec.JiraIssueUrl__c;
        results.add(skipped);
      } else {
        toExport.add(rec);
      }
    }

    // Appels HTTP (aucune écriture avant)
    Map<Id, ExportResult> created = new Map<Id, ExportResult>();
    for (Integer start = 0; start < toExport.size(); start += BATCH_SIZE) {
      List<OrgRecommendation__c> batch = new List<OrgRecommendation__c>();
      for (
        Integer i = start;
        i < Math.min(start + BATCH_SIZE, toExport.size());
        i++
      ) {
        batch.add(toExport[i]);
      }
      List<ExportResult> batchResults = createIssues(batch, status, true);
      // Projet sans champ Priorité : nouvel essai sans priorité pour les tickets refusés pour cette raison
      List<OrgRecommendation__c> retry = new List<OrgRecommendation__c>();
      for (Integer i = 0; i < batch.size(); i++) {
        ExportResult outcome = batchResults[i];
        if (
          outcome.error != null && outcome.error.containsIgnoreCase('priority')
        ) {
          retry.add(batch[i]);
        } else {
          created.put(batch[i].Id, outcome);
        }
      }
      if (!retry.isEmpty()) {
        List<ExportResult> retried = createIssues(retry, status, false);
        for (Integer i = 0; i < retry.size(); i++) {
          created.put(retry[i].Id, retried[i]);
        }
      }
    }

    // Écritures : clé du ticket sur la recommandation
    List<OrgRecommendation__c> updates = new List<OrgRecommendation__c>();
    for (OrgRecommendation__c rec : toExport) {
      ExportResult outcome = created.get(rec.Id);
      results.add(outcome);
      if (outcome.issueKey != null) {
        updates.add(
          new OrgRecommendation__c(
            Id = rec.Id,
            JiraIssueKey__c = outcome.issueKey,
            JiraIssueUrl__c = outcome.issueUrl,
            JiraExportedAt__c = Datetime.now()
          )
        );
      }
    }
    OrgApiLogger.flush();
    Database.update(updates, AccessLevel.USER_MODE);
    return results;
  }

  private static List<ExportResult> createIssues(
    List<OrgRecommendation__c> batch,
    JiraStatus status,
    Boolean withPriority
  ) {
    List<Object> issueUpdates = new List<Object>();
    for (OrgRecommendation__c rec : batch) {
      issueUpdates.add(
        new Map<String, Object>{
          'fields' => issueFields(rec, status, withPriority)
        }
      );
    }
    List<ExportResult> results = new List<ExportResult>();
    for (OrgRecommendation__c rec : batch) {
      results.add(resultOf(rec));
    }
    String body;
    try {
      body = send(
        'POST',
        '/rest/api/3/issue/bulk',
        JSON.serialize(
          new Map<String, Object>{ 'issueUpdates' => issueUpdates }
        ),
        'Create ' + batch.size() + ' issue(s)'
      );
    } catch (Exception e) {
      for (ExportResult result : results) {
        result.error = e.getMessage();
      }
      return results;
    }
    Map<String, Object> response = (Map<String, Object>) JSON.deserializeUntyped(
      body
    );
    // Jira renvoie les tickets créés dans l'ordre, et les échecs avec leur position
    Set<Integer> failed = new Set<Integer>();
    for (
      Object raw : response.get('errors') instanceof List<Object>
        ? (List<Object>) response.get('errors')
        : new List<Object>()
    ) {
      Map<String, Object> failure = (Map<String, Object>) raw;
      Integer index = Integer.valueOf(failure.get('failedElementNumber'));
      failed.add(index);
      results[index].error = describeErrors(failure.get('elementErrors'));
    }
    List<Object> issues = response.get('issues') instanceof List<Object>
      ? (List<Object>) response.get('issues')
      : new List<Object>();
    Integer issueIndex = 0;
    for (Integer i = 0; i < results.size(); i++) {
      if (failed.contains(i) || issueIndex >= issues.size()) {
        continue;
      }
      Map<String, Object> issue = (Map<String, Object>) issues[issueIndex++];
      results[i].issueKey = (String) issue.get('key');
      results[i].issueUrl = status.siteUrl + '/browse/' + results[i].issueKey;
    }
    return results;
  }

  // ---------- Contenu des tickets ----------

  private static List<OrgRecommendation__c> load(List<Id> recordIds) {
    if (recordIds == null || recordIds.isEmpty()) {
      throw new JiraException('Select at least one recommendation.');
    }
    if (recordIds.size() > MAX_EXPORT) {
      throw new JiraException(
        'Too many recommendations selected (' +
          recordIds.size() +
          '): export at most ' +
          MAX_EXPORT +
          ' at a time.'
      );
    }
    return [
      SELECT
        Id,
        Name,
        Title__c,
        Description__c,
        Justification__c,
        SuggestedAction__c,
        Severity__c,
        Category__c,
        Confidence__c,
        Domain__c,
        Status__c,
        ComponentType__c,
        ComponentName__c,
        AffectedComponents__c,
        RuleCode__c,
        AssignedTo__r.Name,
        DueDate__c,
        JiraIssueKey__c,
        JiraIssueUrl__c
      FROM OrgRecommendation__c
      WHERE Id IN :recordIds
      WITH USER_MODE
      ORDER BY SeverityRank__c, Name
      LIMIT :MAX_EXPORT
    ];
  }

  private static ExportResult resultOf(OrgRecommendation__c rec) {
    ExportResult result = new ExportResult();
    result.recommendationId = rec.Id;
    result.recommendationName = rec.Name;
    result.title = rec.Title__c;
    return result;
  }

  private static String summaryOf(OrgRecommendation__c rec) {
    return ('[' + rec.Name + '] ' + rec.Title__c).abbreviate(250);
  }

  private static List<String> labelsOf(OrgRecommendation__c rec) {
    List<String> labels = new List<String>{ 'org-intelligence' };
    for (
      String value : new List<String>{
        rec.Domain__c,
        rec.Severity__c,
        rec.Category__c
      }
    ) {
      if (String.isNotBlank(value)) {
        labels.add(
          value.toLowerCase().replaceAll('[^a-z0-9]+', '-').removeEnd('-')
        );
      }
    }
    return labels;
  }

  private static Map<String, Object> issueFields(
    OrgRecommendation__c rec,
    JiraStatus status,
    Boolean withPriority
  ) {
    Map<String, Object> fields = new Map<String, Object>{
      'project' => new Map<String, Object>{ 'key' => status.projectKey },
      'issuetype' => new Map<String, Object>{ 'name' => status.issueType },
      'summary' => summaryOf(rec),
      'labels' => labelsOf(rec),
      'description' => description(rec)
    };
    if (withPriority && PRIORITIES.containsKey(rec.Severity__c)) {
      fields.put(
        'priority',
        new Map<String, Object>{ 'name' => PRIORITIES.get(rec.Severity__c) }
      );
    }
    if (rec.DueDate__c != null) {
      fields.put('duedate', String.valueOf(rec.DueDate__c));
    }
    return fields;
  }

  /** Description au format Atlassian Document Format (ADF). Les secrets éventuels sont masqués. */
  private static Map<String, Object> description(OrgRecommendation__c rec) {
    List<Object> content = new List<Object>();
    content.add(
      paragraph(
        new List<Object>{
          text('Severity: ', true),
          text(rec.Severity__c + '  ', false),
          text('Domain: ', true),
          text(rec.Domain__c + '  ', false),
          text('Confidence: ', true),
          text(rec.Confidence__c, false)
        }
      )
    );
    content.add(
      paragraph(
        new List<Object>{
          text('Component: ', true),
          text(rec.ComponentName__c + ' (' + rec.ComponentType__c + ')', false)
        }
      )
    );
    addSection(content, 'What was found', rec.Description__c);
    addSection(content, 'Why it matters · evidence', rec.Justification__c);
    addSection(content, 'Suggested action', rec.SuggestedAction__c);
    if (String.isNotBlank(rec.AffectedComponents__c)) {
      content.add(heading('Affected components'));
      List<Object> items = new List<Object>();
      for (String component : rec.AffectedComponents__c.split('\n')) {
        if (items.size() == 40) {
          break;
        }
        items.add(
          new Map<String, Object>{
            'type' => 'listItem',
            'content' => new List<Object>{
              paragraph(new List<Object>{ text(component, false) })
            }
          }
        );
      }
      content.add(
        new Map<String, Object>{ 'type' => 'bulletList', 'content' => items }
      );
    }
    String link =
      Url.getOrgDomainUrl().toExternalForm() +
      '/lightning/r/' +
      OrgRecommendation__c.SObjectType.getDescribe().getName() +
      '/' +
      rec.Id +
      '/view';
    content.add(
      paragraph(
        new List<Object>{
          text('Created by Org Intelligence from ', false),
          new Map<String, Object>{
            'type' => 'text',
            'text' => rec.Name + ' in Salesforce',
            'marks' => new List<Object>{
              new Map<String, Object>{
                'type' => 'link',
                'attrs' => new Map<String, Object>{ 'href' => link }
              }
            }
          },
          text(' (rule ' + rec.RuleCode__c + ').', false)
        }
      )
    );
    return new Map<String, Object>{
      'type' => 'doc',
      'version' => 1,
      'content' => content
    };
  }

  private static void addSection(
    List<Object> content,
    String title,
    String body
  ) {
    if (String.isBlank(body)) {
      return;
    }
    content.add(heading(title));
    for (String line : OrgApiLogger.redact(body).abbreviate(8000).split('\n')) {
      if (String.isNotBlank(line)) {
        content.add(paragraph(new List<Object>{ text(line, false) }));
      }
    }
  }

  private static Map<String, Object> heading(String title) {
    return new Map<String, Object>{
      'type' => 'heading',
      'attrs' => new Map<String, Object>{ 'level' => 3 },
      'content' => new List<Object>{ text(title, false) }
    };
  }

  private static Map<String, Object> paragraph(List<Object> nodes) {
    return new Map<String, Object>{ 'type' => 'paragraph', 'content' => nodes };
  }

  private static Map<String, Object> text(String value, Boolean strong) {
    Map<String, Object> node = new Map<String, Object>{
      'type' => 'text',
      'text' => String.isBlank(value) ? '—' : value
    };
    if (strong) {
      node.put(
        'marks',
        new List<Object>{ new Map<String, Object>{ 'type' => 'strong' } }
      );
    }
    return node;
  }

  // ---------- HTTP ----------

  private static String send(
    String method,
    String path,
    String body,
    String operation
  ) {
    HttpRequest request = new HttpRequest();
    request.setEndpoint(OrgIntelNamespace.callout(NAMED_CREDENTIAL) + path);
    request.setMethod(method);
    request.setTimeout(60000);
    request.setHeader('Accept', 'application/json');
    if (body != null) {
      request.setHeader('Content-Type', 'application/json');
      request.setBody(body);
    }
    OrgApiLogger.Entry entry = new OrgApiLogger.Entry();
    entry.systemName = 'Jira';
    entry.method = method;
    entry.endpoint = path;
    entry.operation = 'Jira: ' + operation;
    entry.requestBody = body;
    Long started = System.currentTimeMillis();
    HttpResponse response;
    try {
      response = new Http().send(request);
    } catch (CalloutException e) {
      entry.durationMs = System.currentTimeMillis() - started;
      entry.success = false;
      entry.errorMessage = e.getMessage();
      OrgApiLogger.log(entry);
      throw new JiraException('Jira is unreachable: ' + e.getMessage());
    }
    entry.durationMs = System.currentTimeMillis() - started;
    entry.statusCode = response.getStatusCode();
    entry.responseBody = response.getBody();
    Integer code = response.getStatusCode();
    if (code == 401 || code == 403) {
      entry.errorMessage = 'Authentication refused';
      OrgApiLogger.log(entry);
      throw new JiraException(
        'Jira refused the credentials (' +
          code +
          '): check the e-mail and the API token in Settings.'
      );
    }
    if (code >= 300 && code != 207) {
      entry.errorMessage = readError(response.getBody());
      OrgApiLogger.log(entry);
      throw new JiraException(
        'Jira error (' + code + '): ' + entry.errorMessage
      );
    }
    if (
      code == 207 ||
      (response.getBody() != null &&
      response.getBody().contains('"failedElementNumber"'))
    ) {
      entry.success = false;
      entry.errorMessage = 'Some issues were not created';
    }
    OrgApiLogger.log(entry);
    return response.getBody();
  }

  private static String readError(String body) {
    try {
      Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(
        body
      );
      List<String> messages = new List<String>();
      for (
        Object message : parsed.get('errorMessages') instanceof List<Object>
          ? (List<Object>) parsed.get('errorMessages')
          : new List<Object>()
      ) {
        messages.add(String.valueOf(message));
      }
      if (parsed.get('errors') instanceof Map<String, Object>) {
        Map<String, Object> errors = (Map<String, Object>) parsed.get('errors');
        for (String field : errors.keySet()) {
          messages.add(field + ': ' + errors.get(field));
        }
      }
      return messages.isEmpty()
        ? 'unexpected response'
        : String.join(messages, ' ').abbreviate(400);
    } catch (Exception e) {
      return 'unexpected response';
    }
  }

  private static String describeErrors(Object elementErrors) {
    return elementErrors instanceof Map<String, Object>
      ? readError(JSON.serialize(elementErrors))
      : 'Not created';
  }
}
