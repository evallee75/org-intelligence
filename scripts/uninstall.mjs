#!/usr/bin/env node
// Org Intelligence — désinstallation complète d'une org installée depuis les sources (pas par package).
//
// Arrête les jobs planifiés et en file, retire les assignations des permission sets Org Intelligence,
// puis supprime définitivement (purge, sans corbeille) tous les composants du socle et des modules
// présents dans le dépôt, l'ancienne FlexiPage, et la connexion Tooling API (sauf --keep-tooling).
// Les données (scans, recommandations, journal...) sont supprimées avec les objets.
//
// Production (--allow-production) : pas de purge (les objets supprimés restent 15 jours dans
// Setup › Deleted Objects) et Salesforce lance les tests Apex locaux de l'org (RunLocalTests).
//
// Usage : node scripts/uninstall.mjs --target-org <alias> [--keep-tooling] [--allow-production] [--yes]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import {
  destructivePackage,
  projectComponents,
  TOOLING_COMPONENTS
} from "./lib/components.mjs";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const targetOrg = option("target-org");
if (!targetOrg || flag("help")) {
  console.log(
    "Usage: node scripts/uninstall.mjs --target-org <alias> [--keep-tooling] [--allow-production] [--yes]"
  );
  process.exit(targetOrg ? 0 : 1);
}

const sf = (commandArgs, { allowFailure = false } = {}) => {
  try {
    return JSON.parse(
      execFileSync("sf", [...commandArgs, "--json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024
      })
    );
  } catch (error) {
    const output = error.stdout?.toString() || "";
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = null;
    }
    if (allowFailure && parsed) return parsed;
    throw new Error(
      parsed?.message || error.stderr?.toString() || error.message
    );
  }
};

const decode = (text) =>
  text
    .replace(/&#124;/g, "|")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const runApex = (code) => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "oi-apex-")),
    "script.apex"
  );
  fs.writeFileSync(file, code);
  const result = sf(
    ["apex", "run", "--target-org", targetOrg, "--file", file],
    { allowFailure: true }
  );
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  if (!result.result?.success) {
    throw new Error(
      result.result?.exceptionMessage ||
        result.result?.compileProblem ||
        result.message ||
        "Anonymous Apex failed"
    );
  }
  return decode(result.result.logs || "")
    .split("\n")
    .filter((line) => line.includes("|USER_DEBUG|"))
    .map((line) =>
      line.replace(/^.*\|DEBUG\|/, "").replace(/^.*\|ERROR\|/, "")
    );
};

// ---------- 1. Org et confirmation ----------

const org = sf([
  "data",
  "query",
  "--target-org",
  targetOrg,
  "--query",
  "SELECT Name, IsSandbox, OrganizationType FROM Organization"
]).result.records[0];
const purgeAllowed =
  org.IsSandbox || org.OrganizationType === "Developer Edition";
console.log(
  `\nOrg Intelligence uninstaller — target: ${org.Name} (${org.IsSandbox ? "sandbox" : org.OrganizationType})`
);
if (!purgeAllowed) {
  if (!flag("allow-production")) {
    console.error(
      "✖ This is a production org: rerun with --allow-production.\n" +
        "  In production, Salesforce runs all the local Apex tests of the org during the removal, and deleted\n" +
        "  objects stay 15 days in Setup › Deleted Objects (erase them there to reinstall sooner)."
    );
    process.exit(1);
  }
  console.log(
    "Production org: the removal runs the local Apex tests of the org (it may take a while)."
  );
}
console.log(
  "This permanently deletes every Org Intelligence component of this repository from the org, with ALL its data" +
    " (scans, findings, recommendations, API log, alert rules, field usage analyses)" +
    (flag("keep-tooling") ? "." : ", and the Tooling API connection.")
);
if (!flag("yes")) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const answer = (
    await rl.question(`Type the org alias (${targetOrg}) to confirm: `)
  ).trim();
  rl.close();
  if (answer !== targetOrg) {
    console.log("Cancelled.");
    process.exit(0);
  }
}

// ---------- 2. Jobs et assignations ----------

console.log("\n1/3 Stopping jobs and removing permission set assignments...");
const classNames = [
  ...fs.readdirSync(path.join(root, "org-intelligence/main/default/classes")),
  ...fs.readdirSync(path.join(root, "modules")).flatMap((module) => {
    const dir = path.join(root, "modules", module, "main/default/classes");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  })
]
  .filter((name) => name.endsWith(".cls"))
  .map((name) => `'${name.replace(/\.cls$/, "")}'`);
const logs = runApex(`
Integer jobs = 0;
for (CronTrigger job : [SELECT Id FROM CronTrigger WHERE CronJobDetail.Name LIKE 'Org Intelligence%']) {
  System.abortJob(job.Id);
  jobs++;
}
for (AsyncApexJob job : [
  SELECT Id FROM AsyncApexJob
  WHERE Status IN ('Holding', 'Queued', 'Preparing', 'Processing') AND ApexClass.Name IN (${classNames.join(",")})
]) {
  System.abortJob(job.Id);
  jobs++;
}
List<PermissionSetAssignment> assignments = [
  SELECT Id FROM PermissionSetAssignment
  WHERE PermissionSet.Name LIKE 'OrgIntelligence%' AND PermissionSet.IsOwnedByProfile = FALSE
];
delete assignments;
System.debug(LoggingLevel.ERROR, 'OI|' + jobs + '|' + assignments.size());
`);
const [, jobs, assignments] = (
  logs.find((line) => line.startsWith("OI|")) || "OI|0|0"
).split("|");
console.log(`  ✔ ${jobs} job(s) stopped, ${assignments} assignment(s) removed`);

// ---------- 2 bis. Rapports et tableaux de bord ----------

// Supprimés par un déploiement, les rapports gardent leur nom réservé (ni corbeille ni purge) et la
// réinstallation échoue. On les supprime donc avant, par l'API Analytics (corbeille), puis on vide la
// corbeille pour eux. Tous les rapports des dossiers Org Intelligence sont concernés.
console.log(
  "   Deleting the reports and dashboards of the Org Intelligence folders..."
);
const auth = sf(["org", "display", "--target-org", targetOrg]).result;
const analyticsIds = sf([
  "data",
  "query",
  "--target-org",
  targetOrg,
  "--query",
  "SELECT Id FROM Report WHERE OwnerId IN (SELECT Id FROM Folder WHERE Type = 'Report' AND DeveloperName LIKE 'OrgIntelligence%')"
])
  .result.records.map((record) => ["reports", record.Id])
  .concat(
    sf([
      "data",
      "query",
      "--target-org",
      targetOrg,
      "--query",
      "SELECT Id FROM Dashboard WHERE FolderId IN (SELECT Id FROM Folder WHERE Type = 'Dashboard' AND DeveloperName LIKE 'OrgIntelligence%')"
    ]).result.records.map((record) => ["dashboards", record.Id])
  );
const deletedIds = [];
for (const [kind, id] of analyticsIds) {
  const response = await fetch(
    `${auth.instanceUrl}/services/data/v66.0/analytics/${kind}/${id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth.accessToken}` }
    }
  );
  if (response.ok) deletedIds.push(id);
  else console.log(`  ! ${kind} ${id} not deleted (${response.status})`);
}
if (deletedIds.length) {
  runApex(
    `Database.emptyRecycleBin(new List<Id>{ '${deletedIds.join("', '")}' });`
  );
}
console.log(`  ✔ ${deletedIds.length} report(s) and dashboard(s) deleted`);

// ---------- 3. Liste des composants ----------

console.log("2/3 Listing the components...");
let components = projectComponents(root);
// Sans le socle (déjà désinstallé), les enregistrements de métadonnées personnalisées ne peuvent pas
// être nommés (la plateforme lève une exception) : on les retire de la liste.
const coreInstalled =
  sf([
    "data",
    "query",
    "--use-tooling-api",
    "--target-org",
    targetOrg,
    "--query",
    "SELECT Id FROM CustomObject WHERE DeveloperName = 'OrgScanRule' AND NamespacePrefix = null"
  ]).result?.totalSize > 0;
if (!coreInstalled)
  components = components.filter(([type]) => type !== "CustomMetadata");
console.log(
  `  ✔ ${components.length} components${coreInstalled ? "" : " (core already removed)"}`
);

// ---------- 4. Suppression ----------

// Un seul déploiement destructif : la plateforme ordonne elle-même les dépendances. Purge (sans
// corbeille) pour pouvoir réinstaller les mêmes objets ; avertissements ignorés pour les composants
// déjà absents (module non installé, reste d'ancienne version).
const work = fs.mkdtempSync(path.join(os.tmpdir(), "oi-uninstall-"));
const deleteComponents = (label, group, purge) => {
  const dir = fs.mkdtempSync(path.join(work, "deploy-"));
  const { packageXml, destructiveXml } = destructivePackage(group);
  fs.writeFileSync(path.join(dir, "package.xml"), packageXml);
  fs.writeFileSync(path.join(dir, "destructiveChanges.xml"), destructiveXml);
  const result = sf(
    [
      "project",
      "deploy",
      "start",
      "--target-org",
      targetOrg,
      "--metadata-dir",
      dir,
      ...(purge && purgeAllowed ? ["--purge-on-delete"] : []),
      // Production : tests exigés dès qu'on supprime du code Apex
      ...(!purgeAllowed &&
      group.some(([type]) => type === "ApexClass" || type === "ApexTrigger")
        ? ["--test-level", "RunLocalTests"]
        : []),
      "--ignore-warnings",
      "--wait",
      purgeAllowed ? "60" : "120"
    ],
    { allowFailure: true }
  );
  const status = result.result?.status;
  if (status === "Succeeded") {
    console.log(
      `  ✔ ${label}: ${result.result.numberComponentsDeployed ?? group.length} processed`
    );
    return true;
  }
  let failures = result.result?.details?.componentFailures || [];
  if (!Array.isArray(failures)) failures = [failures];
  failures = failures.filter((failure) => failure.problemType !== "Warning");
  console.error(
    `  ✖ ${label}: ${result.result?.errorMessage || result.message || status || "failed"}`
  );
  for (const failure of failures)
    console.error(
      `    - ${failure.componentType} ${failure.fullName}: ${failure.problem}`
    );
  return false;
};

console.log("3/3 Deleting...");
let ok = deleteComponents(
  "Org Intelligence (core and modules)",
  components,
  true
);
if (ok && !flag("keep-tooling")) {
  // Connexion Tooling : un élément après l'autre (dépendances successives), sans purge
  for (const component of TOOLING_COMPONENTS) {
    ok =
      deleteComponents(
        `Tooling connection: ${component[0]} ${component[1]}`,
        [component],
        false
      ) && ok;
  }
}
fs.rmSync(work, { recursive: true, force: true });
if (!ok) {
  console.error(
    "\n✖ The uninstall is incomplete (see above). Nothing was deleted by a failed step; fix the cause and run the script again."
  );
  process.exit(1);
}
console.log("\n✔ Org Intelligence has been removed from the org.");
