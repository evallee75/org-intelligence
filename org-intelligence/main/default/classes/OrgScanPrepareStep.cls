/**
 * Première étape : disponibilité de la Tooling API et version d'API de référence de l'org.
 */
public inherited sharing class OrgScanPrepareStep implements OrgScanStep {
  public String run(OrgScanContext ctx, String cursor) {
    OrgToolingGateway.Status status = ctx.tooling.checkConnection();
    ctx.state.toolingAvailable = status.connected;
    if (status.connected) {
      ctx.info(status.message);
    } else {
      ctx.warning(
        status.message +
        ' The scan continues in degraded mode (SOQL and describe only).'
      );
    }

    // Version d'API la plus récente utilisée dans l'org (classes gérées comprises) : référence des
    // règles « version d'API ancienne », sans dépendre d'une valeur codée en dur.
    List<ApexClass> latest = [
      SELECT ApiVersion
      FROM ApexClass
      WITH USER_MODE
      ORDER BY ApiVersion DESC
      LIMIT 1
    ];
    ctx.state.referenceApiVersion = latest.isEmpty()
      ? null
      : latest[0].ApiVersion;
    if (ctx.state.referenceApiVersion != null) {
      ctx.info(
        'Reference API version: ' +
          ctx.state.referenceApiVersion.stripTrailingZeros().toPlainString() +
          ' (most recent version used by an Apex class in this org).'
      );
    }
    return null;
  }
}
