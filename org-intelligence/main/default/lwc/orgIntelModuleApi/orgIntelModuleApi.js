/**
 * Appels Apex des modules optionnels (Recommendations, Context Hub, API Monitoring, Field Usage, Adoption, Security, Inventory).
 *
 * Les écrans des modules sont livrés avec le socle mais ne peuvent pas importer directement les
 * classes d'un module : absent de l'org, le composant ne se déploierait pas. Ils passent par le
 * contrôleur générique du socle (OrgIntelModuleController.invoke), qui transmet l'action au module
 * installé et renvoie le résultat en JSON.
 *
 * Usage : const listRecommendations = moduleAction("recommendations", "listRecommendations");
 *         puis listRecommendations({ ... }) comme une méthode Apex importée.
 *
 * loadInstalledModules() renvoie une liste vide en cas d'erreur (affichage) ;
 * loadInstalledModulesStrict() propage l'erreur : à utiliser pour toute décision qui écrit des
 * données (mode des recommandations), pour ne jamais basculer en local sur une coupure réseau ou
 * une session expirée.
 *
 * Namespace : le même code tourne sans namespace (installation depuis les sources) et dans un
 * package géré (ex. « orgintel »). Les clés JSON des champs renvoyées par les modules sont toujours
 * sans préfixe (« Title__c ») ; les noms cités en texte (page Visualforce, onglet, objet pour la
 * navigation) passent par qualifyName / visualforceUrl, après loadNamespace().
 *
 * Outils hors package (installation depuis les sources) : loadTools() renvoie leurs clés
 * (ex. TOOLS.UNINSTALL) ; ils s'appellent comme un module, par moduleAction(TOOLS.UNINSTALL, ...).
 */
import invoke from "@salesforce/apex/OrgIntelModuleController.invoke";
import getModules from "@salesforce/apex/OrgIntelModuleController.getModules";
import getTools from "@salesforce/apex/OrgIntelModuleController.getTools";
import getNamespace from "@salesforce/apex/OrgIntelModuleController.getNamespace";

export const MODULES = {
  RECOMMENDATIONS: "recommendations",
  CONTEXT_HUB: "contextHub",
  API_MONITORING: "apiMonitoring",
  FIELD_USAGE: "fieldUsage",
  ADOPTION: "adoption",
  SECURITY: "security",
  INVENTORY: "inventory"
};

/** Outils présents seulement après une installation depuis les sources (dossier source-tools/). */
export const TOOLS = {
  UNINSTALL: "uninstall"
};

let namespacePromise;

/** Namespace du package (« orgintel »), ou "" sans namespace ou en cas d'erreur. Mis en cache. */
export function loadNamespace() {
  if (!namespacePromise) {
    namespacePromise = getNamespace()
      .then((namespace) => namespace || "")
      .catch(() => {
        namespacePromise = undefined;
        return "";
      });
  }
  return namespacePromise;
}

/**
 * Nom d'API d'un composant du package préfixé par le namespace (« OrgRecommendation__c » →
 * « orgintel__OrgRecommendation__c ») ; inchangé sans namespace ou s'il est déjà préfixé.
 */
export function qualifyName(namespace, name) {
  if (!namespace || !name) {
    return name;
  }
  const prefix = `${namespace}__`;
  const core = name.replace(/__(c|r|mdt|e|x)$/, "");
  return name.startsWith(prefix) || core.includes("__") ? name : prefix + name;
}

/** URL d'une page Visualforce du package (« /apex/orgintel__Page » en package géré). */
export async function visualforceUrl(page, params) {
  const namespace = await loadNamespace();
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  return `/apex/${qualifyName(namespace, page)}${query}`;
}

/** Clés des outils hors package présents et accessibles (liste vide en cas d'erreur). */
export async function loadTools() {
  try {
    return (await getTools()) || [];
  } catch {
    return [];
  }
}

export async function callModule(module, action, params = {}) {
  const result = await invoke({
    module,
    action,
    paramsJson: JSON.stringify(params || {})
  });
  return result === null || result === undefined ? result : JSON.parse(result);
}

/** Fonction d'appel d'une action, utilisable comme une méthode Apex importée. */
export function moduleAction(module, action) {
  return (params) => callModule(module, action, params);
}

/** Clés des modules installés et accessibles à l'utilisateur (liste vide en cas d'erreur). */
export async function loadInstalledModules() {
  try {
    const modules = await getModules();
    return (modules || []).map((module) => module.key);
  } catch {
    return [];
  }
}

/** Clés des modules installés et accessibles ; lève l'erreur de l'appel au lieu de renvoyer []. */
export async function loadInstalledModulesStrict() {
  const modules = await getModules();
  if (!Array.isArray(modules)) {
    throw new Error("The list of installed modules could not be read.");
  }
  return modules.map((module) => module.key);
}
