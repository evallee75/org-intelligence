#!/usr/bin/env node
// Org Intelligence — installeur depuis les sources (sans package) : choix de l'org et des modules,
// déploiement, attribution des permission sets à l'utilisateur connecté, connexion Tooling API.
//
// Usage interactif : node scripts/install.mjs
// Sans questions   : node scripts/install.mjs --target-org <alias> --modules all|none|recommendations,field-usage
//                    [--tooling | --no-tooling] [--no-uninstall-tool] [--allow-production] [--yes]
//
// En production, le déploiement lance uniquement les tests Apex d'Org Intelligence
// (RunSpecifiedTests : chaque classe déployée doit être couverte à 75 %), jamais ceux de l'org.
//
// Les messages sont en anglais (produit destiné à être partagé), les commentaires en français.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);

const MODULES = [
  {
    folder: "recommendations",
    label: "Recommendations (collaborative edition)",
    description:
      "shared records: assignment, Chatter comments, Jira API export, reports and dashboard (without it, recommendations stay in the browser)",
    permissionSet: "OrgIntelligence_Recommendations_Admin"
  },
  {
    folder: "context-hub",
    label: "Context Hub",
    description:
      "export the context of findings and recommendations to an external AI assistant",
    permissionSet: "OrgIntelligence_ContextHub_Admin"
  },
  {
    folder: "api-monitoring",
    label: "API Monitoring",
    description:
      "log of API calls, org API usage and alerts (stores its log in the org)",
    permissionSet: "OrgIntelligence_ApiMonitoring_Admin"
  },
  {
    folder: "field-usage",
    label: "Field Usage",
    description: "fill rate and usage of the fields of an object",
    permissionSet: "OrgIntelligence_FieldUsage_Admin"
  },
  {
    folder: "adoption",
    label: "Adoption",
    description:
      "licenses paid versus used and native features used or ignored",
    permissionSet: "OrgIntelligence_Adoption_Admin"
  },
  {
    folder: "security",
    label: "Security",
    description: "security audit of the org with a printable report",
    permissionSet: "OrgIntelligence_Security_Admin"
  },
  {
    folder: "inventory",
    label: "Inventory",
    description: "metadata inventory with clean-up hints",
    permissionSet: "OrgIntelligence_Inventory_Admin"
  }
];

// ---------- Options ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
if (flag("help") || flag("h")) {
  console.log(`Org Intelligence installer

  node scripts/install.mjs                       interactive
  node scripts/install.mjs --target-org <alias> --modules all --tooling --yes

Options
  --target-org <alias>   org to install into (a Salesforce CLI alias or username)
  --modules <list>       all | none | comma-separated folders (${MODULES.map((m) => m.folder).join(", ")})
  --tooling / --no-tooling   set up (or skip) the Tooling API connection
  --no-uninstall-tool    do not deploy the in-app uninstall tool (source-tools folder)
  --allow-production     install into a production org without asking (runs the Org Intelligence Apex tests)
  --yes                  do not ask for confirmation`);
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
const ask = async (question, fallback = "") => {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
};
const confirm = async (question, defaultYes = true) => {
  const answer = (
    await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)
  ).toLowerCase();
  return answer ? answer.startsWith("y") || answer.startsWith("o") : defaultYes;
};
const fail = (message) => {
  console.error(`\n✖ ${message}`);
  rl.close();
  process.exit(1);
};

const sfJson = (commandArgs) => {
  try {
    const output = execFileSync("sf", [...commandArgs, "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return JSON.parse(output);
  } catch (error) {
    const output = error.stdout?.toString() || "";
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(error.stderr?.toString() || error.message);
    }
  }
};
const sfRun = (commandArgs) =>
  spawnSync("sf", commandArgs, { cwd: root, stdio: "inherit" }).status === 0;

// ---------- 1. Salesforce CLI ----------

console.log("\nOrg Intelligence installer\n");
try {
  execFileSync("sf", ["--version"], { stdio: "ignore" });
} catch {
  fail(
    "The Salesforce CLI (sf) is not installed. Install it from https://developer.salesforce.com/tools/salesforcecli and run this script again."
  );
}

// ---------- 2. Org cible ----------

let targetOrg = option("target-org");
if (!targetOrg) {
  const orgs = sfJson(["org", "list"]).result || {};
  const known = [
    ...(orgs.sandboxes || []),
    ...(orgs.nonScratchOrgs || []),
    ...(orgs.scratchOrgs || [])
  ];
  const unique = [...new Map(known.map((org) => [org.username, org])).values()];
  if (unique.length) {
    console.log("Connected orgs:");
    unique.forEach((org, index) => {
      const kind = org.isSandbox
        ? "sandbox"
        : org.isScratch
          ? "scratch"
          : "production / developer";
      console.log(
        `  ${index + 1}. ${org.alias || "(no alias)"}  ${org.username}  [${kind}]`
      );
    });
  }
  const answer = await ask(
    `\nOrg to install into: number above, alias, or "new" to log in to a sandbox${unique.length ? "" : " (default: new)"}: `,
    unique.length ? "" : "new"
  );
  if (!answer) fail("No org selected.");
  if (answer.toLowerCase() === "new") {
    const alias = await ask(
      "Alias for this org (e.g. my-sandbox): ",
      "org-intelligence-sandbox"
    );
    const sandbox = await confirm(
      "Is it a sandbox (login via test.salesforce.com)?",
      true
    );
    if (
      !sfRun([
        "org",
        "login",
        "web",
        "--alias",
        alias,
        "--instance-url",
        sandbox ? "https://test.salesforce.com" : "https://login.salesforce.com"
      ])
    ) {
      fail("Login failed.");
    }
    targetOrg = alias;
  } else if (/^\d+$/.test(answer) && unique[Number(answer) - 1]) {
    const org = unique[Number(answer) - 1];
    targetOrg = org.alias || org.username;
  } else {
    targetOrg = answer;
  }
}

let orgInfo;
try {
  orgInfo = sfJson([
    "data",
    "query",
    "--target-org",
    targetOrg,
    "--query",
    "SELECT Name, IsSandbox, OrganizationType FROM Organization"
  ]).result?.records?.[0];
} catch (error) {
  fail(`Cannot reach the org "${targetOrg}": ${error.message}`);
}
if (!orgInfo)
  fail(
    `Cannot reach the org "${targetOrg}". Log in with: sf org login web --alias ${targetOrg}`
  );
const isProduction =
  !orgInfo.IsSandbox && orgInfo.OrganizationType !== "Developer Edition";
console.log(
  `\nTarget org: ${orgInfo.Name} (${orgInfo.IsSandbox ? "sandbox" : orgInfo.OrganizationType})`
);
if (isProduction) {
  console.log(
    "\n  This is a PRODUCTION org. Try Org Intelligence in a sandbox first." +
      "\n  The deployment runs the Org Intelligence Apex tests only (a few minutes); none of your own code is touched." +
      "\n  The in-app uninstall button is not deployed: uninstall with node scripts/uninstall.mjs --allow-production."
  );
  if (!flag("allow-production")) {
    if (flag("yes"))
      fail("Production org: add --allow-production to install without asking.");
    if (!(await confirm("  Install into this production org?", false))) {
      rl.close();
      process.exit(0);
    }
  }
}

// ---------- 3. Modules ----------

let selected;
const modulesOption = option("modules");
if (modulesOption) {
  selected =
    modulesOption === "all"
      ? MODULES.map((m) => m.folder)
      : modulesOption === "none"
        ? []
        : modulesOption
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
  const unknown = selected.filter(
    (folder) => !MODULES.some((m) => m.folder === folder)
  );
  if (unknown.length) fail(`Unknown module(s): ${unknown.join(", ")}`);
} else {
  console.log(
    "\nThe core (scanner, health score, automation map, storage, recommendations, settings) is always installed."
  );
  console.log(
    "Nothing is stored in the org: results stay in each user's browser. Only Recommendations (collaborative edition)\n" +
      "and API Monitoring add custom objects. You can add a module later by running this script again.\n"
  );
  selected = [];
  for (const module of MODULES) {
    if (module.requires && !selected.includes(module.requires)) {
      console.log(
        `  - ${module.label}: skipped (requires ${MODULES.find((m) => m.folder === module.requires).label})`
      );
      continue;
    }
    if (
      await confirm(`  Install ${module.label} (${module.description})?`, true)
    ) {
      selected.push(module.folder);
    }
  }
}
for (const folder of selected) {
  const module = MODULES.find((m) => m.folder === folder);
  if (module.requires && !selected.includes(module.requires)) {
    fail(
      `${module.label} requires the ${MODULES.find((m) => m.folder === module.requires).label} module.`
    );
  }
}

const tooling = flag("tooling") ? true : flag("no-tooling") ? false : null;

console.log("\nSummary");
console.log(`  Org      : ${targetOrg}`);
console.log(`  Core     : yes`);
// Le bouton de désinstallation de l'application est refusé en production : inutile de le déployer.
const uninstallTool = !flag("no-uninstall-tool") && !isProduction;
console.log(
  `  Uninstall: ${uninstallTool ? "in-app button (Settings › Uninstall)" : "command line only"}`
);
console.log(
  `  Modules  : ${selected.length ? selected.map((f) => MODULES.find((m) => m.folder === f).label).join(", ") : "none"}`
);
if (!flag("yes") && !(await confirm("\nDeploy now?", true))) {
  rl.close();
  process.exit(0);
}

// ---------- 4. Déploiement ----------

// Deux temps : d'abord tout sauf les rapports et le tableau de bord (objets, code, écrans), puis
// ceux-ci. Après une désinstallation récente, Salesforce peut garder réservés les noms des rapports
// supprimés : leur échec ne doit pas bloquer l'installation de l'application.
// source-tools/ : outils propres à l'installation depuis les sources (désinstallation complète
// depuis Settings), hors de tout package — un package se désinstalle depuis Setup.
const sourceDirs = [
  "org-intelligence",
  ...selected.map((folder) => `modules/${folder}`),
  ...(uninstallTool ? ["source-tools"] : [])
];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "oi-install-"));
sfJson([
  "project",
  "generate",
  "manifest",
  "--output-dir",
  work,
  "--name",
  "all",
  ...sourceDirs.flatMap((dir) => ["--source-dir", dir])
]);
const manifest = fs.readFileSync(path.join(work, "all.xml"), "utf8");
const analyticsBlock =
  /<types>(?:(?!<\/types>)[\s\S])*?<name>(?:Report|Dashboard)<\/name>\s*<\/types>\s*/g;
const analytics = manifest.match(analyticsBlock) || [];
fs.writeFileSync(
  path.join(work, "app.xml"),
  manifest.replace(analyticsBlock, "")
);
// Production : seuls les tests des dossiers déployés (classes *Test.cls), jamais ceux de l'org.
const listTests = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTests(full);
    return /^[^ ]+Test\.cls$/.test(entry.name)
      ? [entry.name.replace(/\.cls$/, "")]
      : [];
  });
const testClasses = isProduction
  ? sourceDirs.flatMap((dir) => listTests(path.join(root, dir)))
  : [];
const testOptions = testClasses.length
  ? [
      "--test-level",
      "RunSpecifiedTests",
      ...testClasses.flatMap((name) => ["--tests", name])
    ]
  : [];
fs.writeFileSync(
  path.join(work, "analytics.xml"),
  manifest.replace(/<types>[\s\S]*<\/types>\s*/, analytics.join(""))
);

console.log(
  isProduction
    ? `\nDeploying the application and running ${testClasses.length} Org Intelligence test classes (5 to 15 minutes)...\n`
    : "\nDeploying the application (a few minutes)...\n"
);
if (
  !sfRun([
    "project",
    "deploy",
    "start",
    "--target-org",
    targetOrg,
    "--wait",
    "90",
    ...testOptions,
    "--manifest",
    path.join(work, "app.xml")
  ])
) {
  fail(
    "The deployment failed (see above).\n" +
      "  - Upgrade blocked by scheduled jobs? In Org Intelligence › API Monitoring › Alerts, turn off the schedule, deploy, then turn it on again.\n" +
      "  - Missing feature? Chatter must be enabled for the Recommendations module." +
      (isProduction
        ? "\n  - Production: a failing Org Intelligence test or a class under 75 % coverage blocks the deployment; nothing was changed. Please open an issue on GitHub with the message above."
        : "")
  );
}
let reportsInstalled = true;
if (analytics.length) {
  console.log("\nDeploying the native reports and dashboard...\n");
  reportsInstalled = sfRun([
    "project",
    "deploy",
    "start",
    "--target-org",
    targetOrg,
    "--wait",
    "30",
    "--manifest",
    path.join(work, "analytics.xml")
  ]);
  if (!reportsInstalled) {
    console.log(
      "\n  ! The native reports and dashboard could not be installed (the app works without them).\n" +
        "    After a recent uninstall, Salesforce keeps the names of deleted reports reserved for a while.\n" +
        `    Retry later with: sf project deploy start --target-org "${targetOrg}" --manifest <reports manifest> (or rerun this script).`
    );
  }
}
fs.rmSync(work, { recursive: true, force: true });

// ---------- 5. Permission sets ----------

const permissionSets = [
  "OrgIntelligence_Admin",
  ...selected.map(
    (folder) => MODULES.find((m) => m.folder === folder).permissionSet
  )
];
console.log("\nAssigning the permission sets to you...");
const assigned = sfJson([
  "org",
  "assign",
  "permset",
  "--target-org",
  targetOrg,
  ...permissionSets.flatMap((name) => ["--name", name])
]);
const failures = (assigned.result?.failures || []).filter(
  (f) => !/duplicate/i.test(f.message || "")
);
if (failures.length) {
  console.log(
    `  ! Some permission sets were not assigned: ${failures.map((f) => `${f.name} (${f.message})`).join("; ")}`
  );
} else {
  console.log(`  ✔ ${permissionSets.join(", ")}`);
}

// ---------- 6. Tooling API ----------

let setupTooling = tooling;
if (setupTooling === null) {
  console.log(
    "\nThe Tooling API connection lets the scanner read code coverage, flow logic, validation rules and dependencies." +
      "\nWithout it, the scanner runs in a degraded mode (and says so)."
  );
  setupTooling = await confirm("Set up the Tooling API connection now?", true);
}
if (setupTooling) {
  const ok =
    spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/org-intelligence/setup-tooling.mjs"),
        "--target-org",
        targetOrg
      ],
      {
        cwd: root,
        stdio: "inherit"
      }
    ).status === 0;
  if (!ok)
    console.log(
      "  ! The Tooling API setup failed: rerun node scripts/org-intelligence/setup-tooling.mjs --target-org " +
        targetOrg
    );
}

// ---------- 7. Suite ----------

console.log(`
✔ Org Intelligence is installed.

Next steps
  1. Open the app:      sf org open --target-org "${targetOrg}" --path /lightning/n/Org_Intelligence
  2. ${setupTooling ? 'Allow the Tooling API access: your avatar › Settings › External Credentials › "Org Intelligence Tooling" › Allow Access.' : "Optional: set up the Tooling API later with node scripts/org-intelligence/setup-tooling.mjs."}
  3. Overview › New scan.
  4. Give access to other users: "Org Intelligence - User" (read, decide) or "Org Intelligence - Admin",
     plus the matching module permission sets (e.g. "Org Intelligence - Recommendations User").
`);
rl.close();
