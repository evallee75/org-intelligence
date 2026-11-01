/**
 * Étape « Flow logic » : lit la définition de chaque flow non géré (Tooling API, une requête par
 * version) et renvoie son modèle (OrgFlowAnalyzer) dans les détails du composant. Évalue les
 * règles sur la logique des flows actifs. 30 flows par page, sous la limite de 100 callouts.
 */
public inherited sharing class OrgFlowAnalysisStep implements OrgScanStep {
  @TestVisible
  private static Integer flowsPerPage = 30;
  private static final Integer MAX_DETAILS = 32000;

  public String run(OrgScanContext ctx, String cursor) {
    if (!ctx.state.toolingAvailable) {
      ctx.warning('Flow logic not analysed: the Tooling API is not available.');
      return null;
    }
    if (!ctx.state.isStepSuccessful(OrgScanState.STEP_FLOWS)) {
      ctx.warning('Flow logic skipped: the flow inventory failed.');
      return null;
    }
    // Flows inventoriés par l'étape FLOWS, renvoyés par le navigateur, dans un ordre stable
    Map<String, OrgScanModels.Component> byName = new Map<String, OrgScanModels.Component>();
    for (OrgScanModels.Component component : ctx.inventoryOf('Flow')) {
      byName.put(component.apiName, component);
    }
    List<String> names = new List<String>(byName.keySet());
    names.sort();
    List<OrgScanModels.Component> flows = new List<OrgScanModels.Component>();
    for (String name : names) {
      flows.add(byName.get(name));
    }
    Integer start = cursor == null ? 0 : Integer.valueOf(cursor);
    Integer stop = Math.min(start + flowsPerPage, flows.size());

    Boolean dmlInLoop = ctx.beginRule('FLOW_DML_IN_LOOP');
    Boolean sameRecord = ctx.beginRule('FLOW_AFTER_SAVE_SAME_RECORD');
    Boolean noCriteria = ctx.beginRule('FLOW_NO_ENTRY_CRITERIA');
    Boolean faultPaths = ctx.beginRule('FLOW_MISSING_FAULT_PATH');
    Boolean hardcodedIds = ctx.beginRule('FLOW_HARDCODED_ID');

    Integer unreadable = 0;
    for (Integer i = start; i < stop; i++) {
      OrgScanModels.Component flow = flows[i];
      Map<String, Object> details = flow.details == null
        ? new Map<String, Object>()
        : new Map<String, Object>(flow.details);
      String versionId = (String) (details.get('activeVersionId') != null
        ? details.get('activeVersionId')
        : details.get('latestVersionId'));
      if (versionId == null) {
        continue;
      }
      OrgFlowAnalyzer.FlowModel model;
      try {
        List<Map<String, Object>> rows = ctx.tooling.query(
          'SELECT Id, Metadata FROM Flow WHERE Id = \'' +
            String.escapeSingleQuotes(versionId) +
            '\''
        );
        if (rows.isEmpty()) {
          unreadable++;
          continue;
        }
        Map<String, Object> metadata = (Map<String, Object>) rows[0]
          .get('Metadata');
        model = new OrgFlowAnalyzer(metadata, JSON.serialize(metadata)).model;
      } catch (Exception e) {
        unreadable++;
        continue;
      }
      // Règles évaluées sur le modèle complet, avant toute réduction des détails
      if (flow.isActive == true) {
        evaluateRules(
          ctx,
          flow,
          model,
          dmlInLoop,
          sameRecord,
          noCriteria,
          faultPaths,
          hardcodedIds
        );
      }
      details.put('model', model);
      details.put('analysedVersionId', versionId);
      try {
        ctx.updateDetails(flow.key(), fitDetails(details));
      } catch (Exception e) {
        unreadable++;
      }
    }
    if (unreadable > 0) {
      ctx.warning(
        unreadable +
        ' flow definitions could not be read: their logic was not analysed.'
      );
    }
    if (stop >= flows.size()) {
      ctx.info('Flow logic analysed for ' + flows.size() + ' flows.');
      return null;
    }
    return String.valueOf(stop);
  }

  private void evaluateRules(
    OrgScanContext ctx,
    OrgScanModels.Component flow,
    OrgFlowAnalyzer.FlowModel model,
    Boolean dmlInLoop,
    Boolean sameRecord,
    Boolean noCriteria,
    Boolean faultPaths,
    Boolean hardcodedIds
  ) {
    OrgScanModels.Component component = new OrgScanModels.Component(
      'Flow',
      flow.apiName
    );
    if (dmlInLoop && !model.costlyInLoop.isEmpty()) {
      OrgScanModels.Finding finding = ctx.newFinding(
        'FLOW_DML_IN_LOOP',
        component,
        'Flow ' + flow.apiName + ' queries or writes data inside a loop'
      );
      finding.evidence = String.join(model.costlyInLoop, '\n');
      ctx.addFinding(finding);
    }
    if (
      sameRecord &&
      (model.timing == 'After save' ||
      model.timing == 'Process Builder')
    ) {
      List<String> elements = new List<String>();
      for (OrgFlowAnalyzer.DataAccess access : model.writes) {
        if (access.sameRecord && access.operation == 'Update') {
          elements.add(access.element);
        }
      }
      if (!elements.isEmpty()) {
        OrgScanModels.Finding finding = ctx.newFinding(
          'FLOW_AFTER_SAVE_SAME_RECORD',
          component,
          (model.timing == 'Process Builder'
              ? 'Process Builder '
              : 'After-save flow ') +
            flow.apiName +
            ' updates the record that triggered it'
        );
        finding.evidence =
          'Update elements on the triggering ' +
          model.triggerObject +
          ': ' +
          String.join(elements, ', ') +
          '. Each one saves the record again and re-runs its automation.';
        ctx.addFinding(finding);
      }
    }
    if (
      noCriteria &&
      model.isRecordTriggered &&
      model.timing != 'Process Builder' &&
      !model.hasEntryCriteria &&
      model.triggerEvent != null &&
      model.triggerEvent.contains('Update')
    ) {
      OrgScanModels.Finding finding = ctx.newFinding(
        'FLOW_NO_ENTRY_CRITERIA',
        component,
        'Flow ' + flow.apiName + ' runs on every save of ' + model.triggerObject
      );
      finding.evidence =
        model.timing +
        ' flow on ' +
        model.triggerObject +
        ' (' +
        model.triggerEvent +
        ') without entry conditions: it starts at every update, even when nothing relevant changed.';
      ctx.addFinding(finding);
    }
    if (faultPaths && !model.missingFaultPaths.isEmpty()) {
      OrgScanModels.Finding finding = ctx.newFinding(
        'FLOW_MISSING_FAULT_PATH',
        component,
        model.missingFaultPaths.size() +
          ' elements without fault path in flow ' +
          flow.apiName
      );
      finding.evidence =
        'Data and action elements without fault connector: ' +
        String.join(model.missingFaultPaths, ', ') +
        '.';
      ctx.addFinding(finding);
    }
    if (hardcodedIds && !model.hardcodedIds.isEmpty()) {
      OrgScanModels.Finding finding = ctx.newFinding(
        'FLOW_HARDCODED_ID',
        component,
        'Hardcoded record Id in flow ' + flow.apiName
      );
      finding.evidence =
        'Id-like values: ' +
        String.join(model.hardcodedIds, ', ') +
        '.';
      ctx.addFinding(finding);
    }
  }

  /**
   * Ramène les détails sous MAX_DETAILS caractères en retirant des clés du modèle, des moins utiles
   * aux plus utiles — jamais en coupant le JSON (il serait invalide). Les listes de constats sont
   * remplacées par leur nombre en dernier recours.
   */
  @TestVisible
  private static Map<String, Object> fitDetails(Map<String, Object> details) {
    Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
      JSON.serialize(details)
    );
    if (JSON.serialize(result).length() <= MAX_DETAILS) {
      return result;
    }
    Map<String, Object> model = (Map<String, Object>) result.get('model');
    if (model == null) {
      return result;
    }
    model.put('truncated', true);
    List<String> removable = new List<String>{
      'nodes',
      'edges',
      'inputs',
      'outputs',
      'writes.fields',
      'reads',
      'elementCounts',
      'otherActions',
      'apexActions',
      'subflows',
      'entryCriteria',
      'hardcodedIds',
      'costlyInLoop',
      'missingFaultPaths',
      'writes'
    };
    for (String key : removable) {
      if (key == 'writes.fields') {
        Object writes = model.get('writes');
        if (writes instanceof List<Object>) {
          for (Object access : (List<Object>) writes) {
            if (access instanceof Map<String, Object>) {
              ((Map<String, Object>) access).remove('fields');
            }
          }
        }
      } else if (model.get(key) instanceof List<Object>) {
        Integer size = ((List<Object>) model.get(key)).size();
        model.remove(key);
        model.put(key + 'Count', size);
      } else {
        model.remove(key);
      }
      if (JSON.serialize(result).length() <= MAX_DETAILS) {
        return result;
      }
    }
    // Dernier recours : le modèle est retiré, le reste des détails est conservé
    result.remove('model');
    result.put('modelOmitted', true);
    return result;
  }
}
