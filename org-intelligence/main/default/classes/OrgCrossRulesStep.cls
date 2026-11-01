/**
 * Règles qui croisent plusieurs inventaires du scan, évaluées sur les composants déjà inventoriés
 * (renvoyés par le navigateur).
 */
public inherited sharing class OrgCrossRulesStep implements OrgScanStep {
  public String run(OrgScanContext ctx, String cursor) {
    if (
      ctx.state.hasStep(OrgScanState.STEP_APEX_TRIGGERS) &&
      ctx.state.hasStep(OrgScanState.STEP_FLOWS)
    ) {
      OrgAutomationRules.evaluateMixedAutomation(ctx);
    }
    if (
      ctx.state.toolingAvailable &&
      ctx.state.isStepSuccessful(OrgScanState.STEP_FLOW_ANALYSIS)
    ) {
      OrgAutomationRules.evaluateFlowGraph(ctx);
    }
    if (
      ctx.state.toolingAvailable &&
      ctx.state.isStepSuccessful(OrgScanState.STEP_VALIDATION_RULES)
    ) {
      OrgDataModelRules.evaluateBypass(loadValidationRules(ctx), ctx);
    }
    return null;
  }

  /** Règles de validation renvoyées par le navigateur, formule remise en source. */
  private static List<OrgScanModels.Component> loadValidationRules(
    OrgScanContext ctx
  ) {
    List<OrgScanModels.Component> rules = ctx.inventoryOf('ValidationRule');
    for (OrgScanModels.Component rule : rules) {
      Object formula = rule.details?.get('formula');
      rule.source = formula == null ? null : String.valueOf(formula);
    }
    return rules;
  }
}
