#!/usr/bin/env node
// Org Intelligence — test de fumée après installation : modules détectés, actions des écrans de chaque
// module installé, services du socle (vue d'ensemble, reports, paramètres), journal API, puis (option
// --scan) un scan complet, étape par étape comme l'interface. Lecture seule (le scan n'écrit rien
// dans l'org), hormis une écriture de journal annulée (savepoint).
//
// Usage : node scripts/smoke-test.mjs --target-org <alias> [--scan] [--timeout 900] [--uninstall-dry-run]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const targetOrg = option("target-org");
if (!targetOrg) {
  console.log(
    "Usage: node scripts/smoke-test.mjs --target-org <alias> [--scan] [--timeout 900]"
  );
  process.exit(1);
}
const runScan = args.includes("--scan");
const timeoutSeconds = Number(option("timeout", "900"));

const sf = (commandArgs) => {
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
    try {
      return JSON.parse(error.stdout?.toString() || "");
    } catch {
      throw new Error(error.stderr?.toString() || error.message);
    }
  }
};

/** Exécute de l'Apex anonyme et renvoie les lignes « OIT|... » écrites par System.debug. */
const decode = (text) =>
  text
    .replace(/&#124;/g, "|")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const runApex = (code) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-smoke-"));
  const file = path.join(dir, "script.apex");
  fs.writeFileSync(file, code);
  const result = sf(["apex", "run", "--target-org", targetOrg, "--file", file]);
  fs.rmSync(dir, { recursive: true, force: true });
  const lines = decode(result.result?.logs || "")
    .split("\n")
    .filter((line) => line.includes("|USER_DEBUG|") && line.includes("OIT|"))
    .map((line) => line.slice(line.indexOf("OIT|") + 4));
  if (!result.result?.success) {
    lines.push(
      `KO|apex|${result.result?.exceptionMessage || result.result?.compileProblem || result.message}`
    );
  }
  return lines;
};

let failures = 0;
const report = (lines) => {
  for (const line of lines) {
    const [status, label, ...detail] = line.split("|");
    if (status === "KO") failures++;
    console.log(
      `  ${status === "OK" ? "✔" : status === "KO" ? "✖" : "•"} ${label}${detail.length ? `: ${detail.join("|")}` : ""}`
    );
  }
};

// Une action en lecture par module installé (les cas d'erreur ne sont pas testables en Apex anonyme :
// AuraHandledException n'est levée qu'en contexte Aura/LWC)
const MODULE_ACTIONS = {
  recommendations: [
    ["listRecommendations", null],
    ["recentActivity", null],
    ["getJiraSettings", null]
  ],
  contextHub: [["prepareContext", '{"content":"token=abc123 smoke test"}']],
  apiMonitoring: [
    ["getApiLogs", '{"days":7}'],
    ["getApiAlerts", null]
  ],
  fieldUsage: [["getObjects", null]],
  adoption: [["runAnalysis", null]],
  security: [["runAudit", null]],
  inventory: [
    ["getDataset", '{"name":"staticResources"}'],
    ["getDataset", '{"name":"groups"}']
  ]
};

console.log(`\nOrg Intelligence smoke test — ${targetOrg}\n`);
console.log("Modules and screens");
const moduleLines = runApex(`
List<OrgIntelModuleController.ModuleInfo> modules = OrgIntelModuleController.getModules();
List<String> keys = new List<String>();
for (OrgIntelModuleController.ModuleInfo m : modules) keys.add(m.key);
System.debug(LoggingLevel.ERROR, 'OIT|INFO|installed modules|' + (keys.isEmpty() ? 'none (core only)' : String.join(keys, ', ')));
System.debug(LoggingLevel.ERROR, 'OIT|KEYS|' + String.join(keys, ','));
`);
const keysLine = moduleLines.find((line) => line.startsWith("KEYS|"));
const installed = keysLine ? keysLine.slice(5).split(",").filter(Boolean) : [];
report(moduleLines.filter((line) => !line.startsWith("KEYS|")));

// Une transaction par module : toutes les actions ensemble dépasseraient les 100 requêtes SOQL
for (const key of installed) {
  const actions = MODULE_ACTIONS[key] || [];
  if (!actions.length) continue;
  report(
    runApex(
      actions
        .map(
          ([action, params]) => `
try {
  String r = OrgIntelModuleController.invoke('${key}', '${action}', ${params ? `'${params}'` : "null"});
  System.debug(LoggingLevel.ERROR, 'OIT|OK|${key}.${action}|' + (r == null ? 'null' : r.length() + ' chars'));
} catch (Exception e) {
  System.debug(LoggingLevel.ERROR, 'OIT|KO|${key}.${action}|' + e.getMessage());
}`
        )
        .join("\n")
    )
  );
}

console.log("\nCore services");
report(
  runApex(`
try {
  OrgOverviewService.Overview o = OrgIntelligenceController.getOverview();
  System.debug(LoggingLevel.ERROR, 'OIT|OK|overview|recommendations module=' + o.recommendationsEnabled + ', priority rows=' + (o.priorityRecommendations == null ? 0 : o.priorityRecommendations.size()));
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|overview|' + e.getMessage()); }
try {
  OrgReportsService.ReportsView v = OrgIntelligenceController.getReportsView();
  System.debug(LoggingLevel.ERROR, 'OIT|OK|reports|' + v.reports.size() + ' native reports, dashboard=' + (v.dashboardId != null));
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|reports|' + e.getMessage()); }
try {
  OrgSettingsService.SettingsView s = OrgAdminController.getSettings();
  System.debug(LoggingLevel.ERROR, 'OIT|OK|settings|' + s.rules.size() + ' rules, tooling=' + s.tooling?.connected + ', users with access=' + s.access.size());
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|settings|' + e.getMessage()); }
try {
  OrgIntelligenceController.ScannerState st = OrgIntelligenceController.getScannerState();
  System.debug(LoggingLevel.ERROR, 'OIT|OK|scanner|can run a scan=' + st.canRunScan);
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|scanner|' + e.getMessage()); }
Savepoint sp = Database.setSavepoint();
try {
  OrgApiLogger.Entry entry = new OrgApiLogger.Entry();
  entry.systemName = 'Smoke test';
  entry.statusCode = 200;
  OrgApiLogger.logNow(entry);
  System.debug(LoggingLevel.ERROR, 'OIT|OK|API logger|' + (OrgIntelModules.apiLogSink() == null ? 'no API Monitoring module: entries ignored' : 'entry written'));
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|API logger|' + e.getMessage()); }
Database.rollback(sp);
`)
);

// Garde-fous : masquage des secrets sur un long texte sans séparateur (coût linéaire), réglages de
// conservation réduits au journal API. Le refus des paramètres JSON mal formés (invoke) lève une
// AuraHandledException, impossible à lever en Apex anonyme : vérifié à l'écran seulement.
console.log("\nGuards");
report(
  runApex(`
try {
  String text = 'a'.repeat(400000) + ' token=abc123';
  Integer cpu = Limits.getCpuTime();
  String masked = OrgApiLogger.redact(text);
  System.debug(LoggingLevel.ERROR, 'OIT|' + (masked.contains('abc123') ? 'KO' : 'OK') + '|redact 400 KB without separator|' + (Limits.getCpuTime() - cpu) + ' ms CPU');
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|redact|' + e.getMessage()); }
try {
  OrgSettingsService.SettingsView s = OrgAdminController.getSettings();
  System.debug(LoggingLevel.ERROR, 'OIT|OK|retention settings|API log ' + s.retention.apiLogRetentionDays + ' days, payloads=' + s.retention.logApiPayloads);
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|retention settings|' + e.getMessage()); }
`)
);

// ---------- Scan complet ----------

if (runScan) {
  // Le scan est piloté par le navigateur (édition sans objet) : le test enchaîne les étapes comme
  // l'interface, une transaction Apex anonyme par page d'étape, l'état passant de l'une à l'autre.
  // Les étapes qui ont besoin de l'inventaire (couverture, logique des flows, règles croisées)
  // tournent ici sans lui : elles sont vérifiées pour l'absence d'erreur, pas pour leurs constats.
  console.log("\nFull scan (browser-driven steps, nothing stored in the org)");
  const startLines = runApex(`
try {
  String started = OrgIntelligenceController.startScan(new List<String>{ 'ApexClass', 'ApexTrigger', 'Flow', 'CustomObject', 'ValidationRule', 'Dependency', 'Storage' });
  Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(started);
  System.debug(LoggingLevel.ERROR, 'OIT|STATE|' + EncodingUtil.base64Encode(Blob.valueOf(JSON.serialize(body.get('state')))));
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|start scan|' + e.getMessage()); }
`);
  report(startLines.filter((line) => !line.startsWith("STATE|")));
  let stateLine = startLines.find((line) => line.startsWith("STATE|"));
  const deadline = Date.now() + timeoutSeconds * 1000;
  let components = 0;
  let findings = 0;
  let errors = 0;
  let calls = 0;
  while (stateLine && Date.now() < deadline && calls < 300) {
    calls++;
    const stateB64 = stateLine.slice(6);
    const lines = runApex(`
try {
  String stateJson = EncodingUtil.base64Decode('${stateB64}').toString();
  Map<String, Object> r = (Map<String, Object>) JSON.deserializeUntyped(OrgIntelligenceController.runScanStep(stateJson, null));
  Integer stepErrors = 0;
  for (Object entry : (List<Object>) r.get('log')) {
    if (((Map<String, Object>) entry).get('level') == 'error') { stepErrors++; System.debug(LoggingLevel.ERROR, 'OIT|INFO|' + r.get('stepLabel') + '|' + ((Map<String, Object>) entry).get('message')); }
  }
  System.debug(LoggingLevel.ERROR, 'OIT|STEP|' + r.get('stepLabel') + '|' + ((List<Object>) r.get('components')).size() + '|' + ((List<Object>) r.get('findings')).size() + '|' + stepErrors + '|' + r.get('finished'));
  System.debug(LoggingLevel.ERROR, 'OIT|STATE|' + EncodingUtil.base64Encode(Blob.valueOf(JSON.serialize(r.get('state')))));
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|scan step|' + e.getMessage()); }
`);
    report(
      lines.filter((line) => line.startsWith("KO|") || line.startsWith("INFO|"))
    );
    const step = lines.find((line) => line.startsWith("STEP|"));
    if (!step) break;
    const [, label, c, f, e, finished] = step.split("|");
    components += Number(c);
    findings += Number(f);
    errors += Number(e);
    console.log(
      `  • ${label}: ${c} components, ${f} findings${Number(e) ? `, ${e} errors` : ""}`
    );
    if (finished === "true") {
      stateLine = null;
      break;
    }
    stateLine = lines.find((line) => line.startsWith("STATE|"));
  }
  const ok = !stateLine && calls > 0;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "✔" : "✖"} scan ${ok ? "finished" : "not finished"} in ${calls} step calls — ${components} components, ${findings} findings, ${errors} collection errors`
  );
}

// ---------- Désinstallation (simulation) ----------

if (args.includes("--uninstall-dry-run")) {
  console.log("\nUninstall from the app (dry run, nothing is deleted)");
  // Deux transactions : getStatus écrit le journal API, et un callout est refusé après une écriture
  // Outil hors package (source-tools/) : présent seulement après une installation depuis les sources
  const statusLines = runApex(`
System.debug(LoggingLevel.ERROR, 'OIT|' + (OrgIntelModuleController.getTools().contains('uninstall') ? 'OK' : 'KO') + '|uninstall tool discovered (source-tools)|');
try {
  OrgUninstallService.UninstallStatus st = OrgUninstallService.getStatus();
  System.debug(LoggingLevel.ERROR, 'OIT|' + (st.canUninstall ? 'OK' : 'KO') + '|uninstall status|mode=' + st.mode + ', components=' + st.componentCount + (st.reason == null ? '' : ', ' + st.reason));
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|uninstall status|' + e.getMessage()); }
`);
  const lines = statusLines.some((line) =>
    line.startsWith("OK|uninstall status")
  )
    ? statusLines.concat(
        runApex(`
try {
  System.debug(LoggingLevel.ERROR, 'OIT|DEPLOY|' + OrgUninstallService.validate());
} catch (Exception e) { System.debug(LoggingLevel.ERROR, 'OIT|KO|uninstall dry run|' + e.getMessage()); }
`)
      )
    : statusLines;
  report(lines.filter((line) => !line.startsWith("DEPLOY|")));
  const deployLine = lines.find((line) => line.startsWith("DEPLOY|"));
  if (deployLine) {
    const deployId = deployLine.slice(7);
    let result;
    for (let i = 0; i < 60; i++) {
      result = sf([
        "project",
        "deploy",
        "report",
        "--target-org",
        targetOrg,
        "--job-id",
        deployId
      ]).result;
      if (result?.done) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    let componentFailures = result?.details?.componentFailures || [];
    if (!Array.isArray(componentFailures))
      componentFailures = [componentFailures];
    componentFailures = componentFailures.filter(
      (failure) => failure.problemType !== "Warning"
    );
    const ok = result?.status === "Succeeded";
    if (!ok) failures++;
    console.log(
      `  ${ok ? "✔" : "✖"} destructive deployment validated: ${result?.status} (${result?.numberComponentsDeployed ?? 0} components)${result?.errorMessage ? ` — ${result.errorMessage}` : ""}`
    );
    for (const failure of componentFailures.slice(0, 15))
      console.log(
        `    - ${failure.componentType} ${failure.fullName}: ${failure.problem}`
      );
  }
}

console.log(
  failures ? `\n✖ ${failures} check(s) failed.` : "\n✔ All checks passed."
);
process.exit(failures ? 1 : 0);
