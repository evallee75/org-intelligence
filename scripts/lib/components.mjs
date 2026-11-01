// Org Intelligence — liste des composants du projet (socle + modules), pour la désinstallation.
//
// Utilisée par scripts/uninstall.mjs (désinstallation en ligne de commande) et par
// scripts/build-uninstall-manifest.mjs (manifeste embarqué dans l'application, lu par le bouton
// « Uninstall Org Intelligence » de Settings). Les composants enfants d'un objet du projet (champs,
// présentations, vues...) ne sont pas listés : ils partent avec l'objet.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Restes d'anciennes versions, absents du dépôt mais à supprimer s'ils existent — dont l'édition
 * avec objets d'avant le 2026-11-02 (scans, audits, analyses stockés dans l'org).
 */
export const LEGACY_COMPONENTS = [
  ["FlexiPage", "Org_Intelligence"],
  ["CustomObject", "OrgScan__c"],
  ["CustomObject", "OrgScanComponent__c"],
  ["CustomObject", "OrgScanFinding__c"],
  ["CustomObject", "OrgSecurityAudit__c"],
  ["CustomObject", "OrgAdoptionSnapshot__c"],
  ["CustomObject", "OrgAdoptionContractLine__c"],
  ["CustomObject", "OrgFieldUsageAnalysis__c"],
  ["CustomObject", "OrgFieldUsageResult__c"],
  ["CustomObject", "OrgContextExport__c"],
  ["CustomTab", "OrgScan__c"],
  ["ReportType", "OrgIntelScans"],
  ["ApexPage", "OrgIntelligenceSecurityReport"],
  ["ApexClass", "OrgScanJob"],
  ["ApexClass", "OrgScanJobFinalizer"],
  ["ApexClass", "OrgScanService"],
  ["ApexClass", "OrgScanFinalizeStep"],
  ["ApexClass", "OrgScanSkippedStep"],
  ["ApexClass", "OrgMaintenanceJob"],
  ["ApexClass", "OrgIntelTestData"],
  ["ApexClass", "OrgSecurityReportController"],
  ["ApexClass", "OrgFieldUsageBatch"],
  ["ApexClass", "OrgContextController"],
  ["ApexClass", "OrgScanJobTest"],
  ["ApexClass", "OrgScanServiceTest"],
  ["ApexClass", "OrgIntelligenceControllerTest"],
  ["ApexClass", "OrgRecommendationTriggerHandlerTest"],
  ["ApexClass", "OrgRecommendationTestData"]
];

/** Connexion Tooling API créée par setup-tooling.mjs (hors packages), dans l'ordre de suppression. */
export const TOOLING_COMPONENTS = [
  ["PermissionSet", "OrgIntelligence_Tooling_Access"],
  ["NamedCredential", "OrgIntelligenceTooling"],
  ["ExternalCredential", "OrgIntelligenceTooling"],
  ["AuthProvider", "OrgIntelligenceTooling"],
  ["ExtlClntAppGlobalOauthSettings", "OrgIntelligenceTooling_glbloauth"],
  ["ExtlClntAppOauthSettings", "OrgIntelligenceTooling_oauth"],
  ["ExternalClientApplication", "OrgIntelligenceTooling"]
];

/** Dossiers de paquets déclarés dans sfdx-project.json. */
export function packageDirectories(root) {
  const project = JSON.parse(
    fs.readFileSync(path.join(root, "sfdx-project.json"), "utf8")
  );
  return project.packageDirectories.map((dir) => dir.path);
}

/** Composants [type, nom] du dépôt (socle + modules) et restes connus, sans les enfants d'objets. */
export function projectComponents(root) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "oi-components-"));
  try {
    execFileSync(
      "sf",
      [
        "project",
        "generate",
        "manifest",
        "--output-dir",
        work,
        "--name",
        "source",
        ...packageDirectories(root).flatMap((dir) => ["--source-dir", dir])
      ],
      { cwd: root, stdio: "ignore" }
    );
    const manifest = fs.readFileSync(path.join(work, "source.xml"), "utf8");
    const components = [];
    for (const block of manifest.match(/<types>[\s\S]*?<\/types>/g) || []) {
      const type = block.match(/<name>(.*?)<\/name>/)[1];
      for (const member of block.matchAll(/<members>(.*?)<\/members>/g))
        components.push([type, member[1]]);
    }
    components.push(...LEGACY_COMPONENTS);
    const objects = new Set(
      components
        .filter(([type]) => type === "CustomObject")
        .map(([, name]) => name)
    );
    const isChild = ([type, name]) =>
      (type === "Layout" && objects.has(name.split("-")[0])) ||
      (!["CustomObject", "CustomMetadata"].includes(type) &&
        name.includes(".") &&
        objects.has(name.split(".")[0]));
    return components
      .filter((component) => !isChild(component))
      .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** package.xml vide et destructiveChanges.xml pour une liste de composants. */
export function destructivePackage(components, apiVersion = "66.0") {
  const ns = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
  const escape = (value) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const byType = new Map();
  for (const [type, member] of components)
    byType.set(type, [...(byType.get(type) || []), member]);
  return {
    packageXml: `<?xml version="1.0" encoding="UTF-8"?>\n<Package ${ns}><version>${apiVersion}</version></Package>\n`,
    destructiveXml: `<?xml version="1.0" encoding="UTF-8"?>\n<Package ${ns}>\n${[
      ...byType
    ]
      .map(
        ([type, members]) =>
          `<types>${members.map((m) => `<members>${escape(m)}</members>`).join("")}<name>${type}</name></types>`
      )
      .join("\n")}\n<version>${apiVersion}</version></Package>\n`
  };
}
