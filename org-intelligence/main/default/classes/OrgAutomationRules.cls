/**
 * Règles sur l'automatisation : triggers Apex, flows et Process Builder, et leur cumul par objet.
 */
public inherited sharing class OrgAutomationRules {
  public static void evaluateTriggers(
    List<OrgScanModels.Component> triggers,
    OrgScanContext ctx
  ) {
    Boolean hardcodedIds = ctx.beginRule('TRIGGER_HARDCODED_ID');
    Boolean inBody = ctx.beginRule('TRIGGER_LOGIC_IN_BODY');
    Boolean inactive = ctx.beginRule('TRIGGER_INACTIVE');
    Decimal maxLines = ctx.threshold('TRIGGER_LOGIC_IN_BODY', 25);

    Map<String, List<String>> activeByObject = new Map<String, List<String>>();
    for (OrgScanModels.Component component : triggers) {
      if (component.isActive) {
        if (!activeByObject.containsKey(component.parentName)) {
          activeByObject.put(component.parentName, new List<String>());
        }
        activeByObject.get(component.parentName).add(component.apiName);
      } else if (inactive) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'TRIGGER_INACTIVE',
          component,
          'Trigger ' + component.apiName + ' is inactive'
        );
        finding.evidence =
          'Status: Inactive (object ' +
          component.parentName +
          ').';
        ctx.addFinding(finding);
      }

      if (component.source == null) {
        continue;
      }
      OrgApexSourceAnalyzer analyzer = new OrgApexSourceAnalyzer(
        component.source
      );
      Integer lines = analyzer.codeLineCount();
      component.details.put('codeLines', lines);
      if (hardcodedIds) {
        OrgApexRules.addHardcodedIdFinding(
          'TRIGGER_HARDCODED_ID',
          component,
          analyzer,
          ctx
        );
      }
      if (inBody && lines > maxLines) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'TRIGGER_LOGIC_IN_BODY',
          component,
          'Trigger ' +
            component.apiName +
            ' contains ' +
            lines +
            ' lines of logic'
        );
        finding.evidence =
          lines +
          ' code lines in the trigger body (comments and blank lines excluded). Threshold: ' +
          maxLines.stripTrailingZeros().toPlainString() +
          '.';
        ctx.addFinding(finding);
      }
    }

    if (!ctx.beginRule('TRIGGER_MULTIPLE_PER_OBJECT')) {
      return;
    }
    Decimal maxPerObject = ctx.threshold('TRIGGER_MULTIPLE_PER_OBJECT', 1);
    for (String objectName : activeByObject.keySet()) {
      List<String> names = activeByObject.get(objectName);
      if (names.size() <= maxPerObject) {
        continue;
      }
      names.sort();
      OrgScanModels.Finding finding = ctx.newFinding(
        'TRIGGER_MULTIPLE_PER_OBJECT',
        'CustomObject',
        objectName,
        names.size() + ' active triggers on ' + objectName
      );
      finding.evidence =
        'Active triggers on ' +
        objectName +
        ': ' +
        String.join(names, ', ') +
        '.';
      finding.affectedComponents.addAll(names);
      ctx.addFinding(finding);
    }
  }

  public static void evaluateFlows(
    List<OrgScanModels.Component> flows,
    OrgScanContext ctx
  ) {
    Boolean processBuilder = ctx.beginRule('FLOW_PROCESS_BUILDER_ACTIVE');
    Boolean stale = ctx.beginRule('FLOW_INACTIVE_STALE');
    Boolean apiVersion = ctx.beginRule('FLOW_OLD_API_VERSION');
    Boolean versions = ctx.beginRule('FLOW_TOO_MANY_VERSIONS');
    Decimal staleDays = ctx.threshold('FLOW_INACTIVE_STALE', 180);
    Decimal maxLag = ctx.threshold('FLOW_OLD_API_VERSION', 10);
    Decimal maxVersions = ctx.threshold('FLOW_TOO_MANY_VERSIONS', 20);
    Datetime staleLimit = Datetime.now().addDays(-staleDays.intValue());

    for (OrgScanModels.Component flow : flows) {
      String processType = (String) flow.details.get('processType');
      if (processBuilder && flow.isActive && processType == 'Workflow') {
        OrgScanModels.Finding finding = ctx.newFinding(
          'FLOW_PROCESS_BUILDER_ACTIVE',
          flow,
          'Process Builder ' + flow.apiName + ' is still active'
        );
        finding.evidence =
          'Process type: Workflow (Process Builder), active' +
          (flow.parentName == null ? '' : ', on ' + flow.parentName) +
          '.';
        ctx.addFinding(finding);
      }
      if (
        stale &&
        !flow.isActive &&
        flow.lastModifiedDate != null &&
        flow.lastModifiedDate < staleLimit
      ) {
        Integer days = flow.lastModifiedDate.date().daysBetween(Date.today());
        OrgScanModels.Finding finding = ctx.newFinding(
          'FLOW_INACTIVE_STALE',
          flow,
          'Flow ' +
            flow.apiName +
            ' is inactive and unchanged for ' +
            days +
            ' days'
        );
        finding.evidence =
          'No active version. Last modified on ' +
          flow.lastModifiedDate.format('yyyy-MM-dd') +
          (flow.lastModifiedByName == null
            ? ''
            : ' by ' + flow.lastModifiedByName) +
          '. Threshold: ' +
          staleDays.stripTrailingZeros().toPlainString() +
          ' days.';
        ctx.addFinding(finding);
      }
      if (apiVersion && flow.isActive) {
        OrgApexRules.addApiVersionFinding(
          'FLOW_OLD_API_VERSION',
          flow,
          maxLag,
          ctx
        );
      }
      Integer versionCount = (Integer) flow.details.get('versionCount');
      if (versions && versionCount != null && versionCount > maxVersions) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'FLOW_TOO_MANY_VERSIONS',
          flow,
          'Flow ' + flow.apiName + ' keeps ' + versionCount + ' versions'
        );
        finding.evidence =
          versionCount +
          ' versions (platform limit: 50, threshold: ' +
          maxVersions.stripTrailingZeros().toPlainString() +
          ').';
        ctx.addFinding(finding);
      }
    }
  }

  /**
   * Cumul de technologies par objet, d'après l'inventaire du scan renvoyé par le navigateur (triggers et
   * flows). Évaluée seulement si les deux collectes ont réussi.
   */
  public static void evaluateMixedAutomation(OrgScanContext ctx) {
    if (
      !ctx.state.isStepSuccessful(OrgScanState.STEP_APEX_TRIGGERS) ||
      !ctx.state.isStepSuccessful(OrgScanState.STEP_FLOWS)
    ) {
      ctx.info(
        'Mixed automation rule skipped: it needs both the trigger and the flow inventories.'
      );
      return;
    }
    if (!ctx.beginRule('AUTOMATION_MIXED_ON_OBJECT')) {
      return;
    }
    Map<String, Map<String, List<String>>> byObject = new Map<String, Map<String, List<String>>>();
    for (
      OrgScanModels.Component component : ctx.inventoryOf(
        new Set<String>{ 'ApexTrigger', 'Flow' }
      )
    ) {
      if (component.isActive != true || component.parentName == null) {
        continue;
      }
      String kind = automationKind(component);
      if (kind == null) {
        continue;
      }
      if (!byObject.containsKey(component.parentName)) {
        byObject.put(component.parentName, new Map<String, List<String>>());
      }
      Map<String, List<String>> kinds = byObject.get(component.parentName);
      if (!kinds.containsKey(kind)) {
        kinds.put(kind, new List<String>());
      }
      kinds.get(kind).add(component.apiName);
    }

    for (String objectName : byObject.keySet()) {
      Map<String, List<String>> kinds = byObject.get(objectName);
      if (kinds.size() < 2) {
        continue;
      }
      List<String> parts = new List<String>();
      List<String> evidence = new List<String>();
      OrgScanModels.Finding finding = ctx.newFinding(
        'AUTOMATION_MIXED_ON_OBJECT',
        'CustomObject',
        objectName,
        null
      );
      List<String> kindNames = new List<String>(kinds.keySet());
      kindNames.sort();
      for (String kind : kindNames) {
        List<String> names = kinds.get(kind);
        names.sort();
        parts.add(names.size() + ' ' + kind + (names.size() > 1 ? 's' : ''));
        evidence.add(kind + 's: ' + String.join(names, ', '));
        finding.affectedComponents.addAll(names);
      }
      finding.title =
        objectName +
        ' is automated by ' +
        String.join(parts, ', ');
      finding.evidence = String.join(evidence, '\n');
      ctx.addFinding(finding);
    }
  }

  private static String automationKind(OrgScanModels.Component component) {
    if (component.componentType == 'ApexTrigger') {
      return 'Apex trigger';
    }
    Map<String, Object> details = component.details == null
      ? new Map<String, Object>()
      : component.details;
    if (details.get('processType') == 'Workflow') {
      return 'Process Builder process';
    }
    String triggerType = (String) details.get('triggerType');
    if (triggerType != null && triggerType.startsWith('Record')) {
      return 'record-triggered flow';
    }
    return null;
  }

  /**
   * Règles sur le graphe des flows analysés : plusieurs flows au même moment sans ordre défini, et
   * boucles entre objets (récursion possible).
   */
  public static void evaluateFlowGraph(OrgScanContext ctx) {
    List<OrgAutomationGraph.Automation> automations = OrgAutomationGraph.load(
      ctx.inventoryOf(new Set<String>{ 'Flow', 'ApexTrigger', 'ValidationRule' })
    );

    if (ctx.beginRule('FLOW_SAME_TIMING_NO_ORDER')) {
      Map<String, List<OrgAutomationGraph.Automation>> byObjectTiming = new Map<String, List<OrgAutomationGraph.Automation>>();
      for (OrgAutomationGraph.Automation automation : automations) {
        if (
          automation.model == null ||
          automation.isActive != true ||
          automation.objectName == null ||
          (automation.timing != 'Before save' &&
          automation.timing != 'After save')
        ) {
          continue;
        }
        String key = automation.objectName + '|' + automation.timing;
        if (!byObjectTiming.containsKey(key)) {
          byObjectTiming.put(key, new List<OrgAutomationGraph.Automation>());
        }
        byObjectTiming.get(key).add(automation);
      }
      for (String key : byObjectTiming.keySet()) {
        List<OrgAutomationGraph.Automation> flowGroup = byObjectTiming.get(key);
        List<String> unordered = new List<String>();
        for (OrgAutomationGraph.Automation automation : flowGroup) {
          if (automation.model.triggerOrder == null) {
            unordered.add(automation.apiName);
          }
        }
        if (flowGroup.size() < 2 || unordered.isEmpty()) {
          continue;
        }
        unordered.sort();
        String objectName = key.substringBefore('|');
        String timing = key.substringAfter('|');
        OrgScanModels.Finding finding = ctx.newFinding(
          'FLOW_SAME_TIMING_NO_ORDER',
          'CustomObject',
          objectName + ' (' + timing + ')',
          flowGroup.size() +
            ' ' +
            timing.toLowerCase() +
            ' flows on ' +
            objectName +
            ' without a defined order'
        );
        finding.evidence =
          'Flows without Trigger Order: ' +
          String.join(unordered, ', ') +
          '.';
        finding.affectedComponents.addAll(unordered);
        ctx.addFinding(finding);
      }
    }

    if (ctx.beginRule('AUTOMATION_RECURSION_RISK')) {
      for (
        OrgAutomationGraph.Cycle cycle : OrgAutomationGraph.findCycles(
          automations
        )
      ) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'AUTOMATION_RECURSION_RISK',
          'CustomObject',
          cycle.key.replace('>', ' / '),
          'Automation loop: ' + cycle.label
        );
        finding.evidence =
          'Each object of the chain is updated by an automation triggered on the previous one: ' +
          cycle.label +
          '. Automations involved: ' +
          String.join(cycle.automations, ', ') +
          '.';
        finding.affectedComponents.addAll(cycle.automations);
        ctx.addFinding(finding);
      }
    }
  }
}
