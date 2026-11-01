/**
 * Étape d'un scan. `run` traite une page de travail et renvoie le curseur de la page suivante, ou
 * null quand l'étape est terminée. Les appels Tooling (callouts) doivent précéder toute écriture :
 * le contexte n'enregistre composants et constats qu'après `run`.
 */
public interface OrgScanStep {
  String run(OrgScanContext ctx, String cursor);
}
