// Org Intelligence — mise en place de la connexion Tooling API dans une org (sandbox ou prod).
//
// Crée : External Client App (OAuth) + Auth. Provider « Salesforce » + External Credential
// (principal par utilisateur) + Named Credential `OrgIntelligenceTooling` + permission set
// `OrgIntelligence_Tooling_Access` (accès au principal), puis l'assigne à l'utilisateur courant.
//
// La clé et le secret OAuth sont générés aléatoirement à chaque exécution et déployés depuis un
// dossier temporaire supprimé ensuite : ils ne sont jamais écrits dans le dépôt.
//
// Usage : node scripts/org-intelligence/setup-tooling.mjs --target-org "<alias>" [--contact email] [--reset]
//         [--namespace <ns>]
// --namespace : namespace du package géré installé (détecté automatiquement sinon) ; la Named
// Credential, locale à l'org, autorise alors ce namespace (« Allowed Namespaces for Callouts »).
// --reset : supprime d'abord une connexion existante (le secret d'un Auth. Provider ne peut pas être
// modifié par métadonnées : on recrée l'ensemble). Les utilisateurs devront refaire « Allow Access ».
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const targetOrg = option("target-org");
if (!targetOrg) {
  console.error(
    'Usage: node setup-tooling.mjs --target-org "<alias>" [--contact email]'
  );
  process.exit(1);
}

const sf = (commandArgs, cwd) =>
  JSON.parse(
    execFileSync("sf", [...commandArgs, "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
  );

const org = sf(["org", "display", "--target-org", targetOrg]).result;
const domain = org.instanceUrl.replace(/\/$/, "");
const contact = option(
  "contact",
  org.username.replace(/\.[^.@]+$/, "").includes("@")
    ? org.username.replace(/\.[^.@]+$/, "")
    : org.username
);
const NAME = "OrgIntelligenceTooling";
// Package géré : namespace de la classe OrgToolingGateway installée (vide depuis les sources)
const detectNamespace = () => {
  try {
    const records = sf([
      "data",
      "query",
      "--target-org",
      targetOrg,
      "--query",
      "SELECT NamespacePrefix FROM ApexClass WHERE Name = 'OrgToolingGateway' AND NamespacePrefix != null LIMIT 1"
    ]).result.records;
    return records[0]?.NamespacePrefix ?? "";
  } catch {
    return "";
  }
};
const namespace = option("namespace", null) ?? detectNamespace();
if (namespace && !/^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(namespace)) {
  console.error(`Invalid namespace: ${namespace}`);
  process.exit(1);
}
const allowedNamespace = namespace
  ? `
    <namedCredentialParameters>
        <parameterName>AllowedManagedPackageNamespaces</parameterName>
        <parameterType>AllowedManagedPackageNamespaces</parameterType>
        <parameterValue>${namespace}</parameterValue>
    </namedCredentialParameters>`
  : "";
const consumerKey = `OI_${crypto.randomBytes(30).toString("hex")}`;
const consumerSecret = crypto.randomBytes(32).toString("hex").toUpperCase();
const callback = `${domain}/services/authcallback/${NAME}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oi-tooling-"));
// Le dossier contient le secret OAuth : suppression garantie, même en cas d'erreur ou d'interruption
const cleanUp = () => fs.rmSync(root, { recursive: true, force: true });
process.on("exit", cleanUp);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
const write = (relative, content) => {
  const file = path.join(root, "force-app/main/default", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n${content.trim()}\n`
  );
};
fs.writeFileSync(
  path.join(root, "sfdx-project.json"),
  JSON.stringify({
    packageDirectories: [{ path: "force-app", default: true }],
    sourceApiVersion: "66.0"
  })
);
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

// 1. External Client App
write(
  `externalClientApps/${NAME}.eca-meta.xml`,
  `
<ExternalClientApplication ${NS}>
    <contactEmail>${contact}</contactEmail>
    <description>Org Intelligence: access to the Tooling API of this org, on behalf of each user.</description>
    <distributionState>Local</distributionState>
    <isProtected>false</isProtected>
    <label>Org Intelligence Tooling</label>
</ExternalClientApplication>`
);
write(
  `extlClntAppOauthSettings/${NAME}_oauth.ecaOauth-meta.xml`,
  `
<ExtlClntAppOauthSettings ${NS}>
    <commaSeparatedOauthScopes>Api, RefreshToken</commaSeparatedOauthScopes>
    <externalClientApplication>${NAME}</externalClientApplication>
    <label>${NAME}_oauth</label>
</ExtlClntAppOauthSettings>`
);
write(
  `extlClntAppGlobalOauthSets/${NAME}_glbloauth.ecaGlblOauth-meta.xml`,
  `
<ExtlClntAppGlobalOauthSettings ${NS}>
    <callbackUrl>${callback}</callbackUrl>
    <consumerKey>${consumerKey}</consumerKey>
    <consumerSecret>${consumerSecret}</consumerSecret>
    <externalClientApplication>${NAME}</externalClientApplication>
    <isConsumerSecretOptional>false</isConsumerSecretOptional>
    <isIntrospectAllTokens>false</isIntrospectAllTokens>
    <isPkceRequired>true</isPkceRequired>
    <isSecretRequiredForRefreshToken>true</isSecretRequiredForRefreshToken>
    <label>${NAME}_glbloauth</label>
</ExtlClntAppGlobalOauthSettings>`
);
// 2. Auth. Provider (type Salesforce, points d'accès de l'org elle-même)
write(
  `authproviders/${NAME}.authprovider-meta.xml`,
  `
<AuthProvider ${NS}>
    <authorizeUrl>${domain}/services/oauth2/authorize</authorizeUrl>
    <consumerKey>${consumerKey}</consumerKey>
    <consumerSecret>${consumerSecret}</consumerSecret>
    <defaultScopes>api refresh_token</defaultScopes>
    <friendlyName>Org Intelligence Tooling</friendlyName>
    <includeOrgIdInIdentifier>false</includeOrgIdInIdentifier>
    <isPkceEnabled>true</isPkceEnabled>
    <providerType>Salesforce</providerType>
    <sendAccessTokenInHeader>true</sendAccessTokenInHeader>
    <sendClientCredentialsInHeader>false</sendClientCredentialsInHeader>
    <sendSecretInApis>true</sendSecretInApis>
    <tokenUrl>${domain}/services/oauth2/token</tokenUrl>
    <userInfoUrl>${domain}/services/oauth2/userinfo</userInfoUrl>
</AuthProvider>`
);

// 3. External Credential (OAuth, principal par utilisateur) et 4. Named Credential
write(
  `externalCredentials/${NAME}.externalCredential-meta.xml`,
  `
<ExternalCredential ${NS}>
    <authenticationProtocol>Oauth</authenticationProtocol>
    <externalCredentialParameters>
        <authProvider>${NAME}</authProvider>
        <parameterName>AuthProvider</parameterName>
        <parameterType>AuthProvider</parameterType>
    </externalCredentialParameters>
    <externalCredentialParameters>
        <parameterName>Scope</parameterName>
        <parameterType>AuthParameter</parameterType>
        <parameterValue>api refresh_token</parameterValue>
    </externalCredentialParameters>
    <externalCredentialParameters>
        <parameterName>PerUser</parameterName>
        <parameterType>PerUserPrincipal</parameterType>
        <sequenceNumber>1</sequenceNumber>
    </externalCredentialParameters>
    <label>Org Intelligence Tooling</label>
</ExternalCredential>`
);
write(
  `namedCredentials/${NAME}.namedCredential-meta.xml`,
  `
<NamedCredential ${NS}>
    <allowMergeFieldsInBody>false</allowMergeFieldsInBody>
    <allowMergeFieldsInHeader>false</allowMergeFieldsInHeader>
    <calloutStatus>Enabled</calloutStatus>
    <generateAuthorizationHeader>true</generateAuthorizationHeader>
    <label>Org Intelligence Tooling</label>
    <namedCredentialParameters>
        <parameterName>Url</parameterName>
        <parameterType>Url</parameterType>
        <parameterValue>${domain}</parameterValue>
    </namedCredentialParameters>
    <namedCredentialParameters>
        <externalCredential>${NAME}</externalCredential>
        <parameterName>ExternalCredential</parameterName>
        <parameterType>Authentication</parameterType>
    </namedCredentialParameters>${allowedNamespace}
    <namedCredentialType>SecuredEndpoint</namedCredentialType>
</NamedCredential>`
);

// 5. Accès au principal (permission set dédié, propre à l'org)
write(
  `permissionsets/OrgIntelligence_Tooling_Access.permissionset-meta.xml`,
  `
<PermissionSet ${NS}>
    <description>Org Intelligence: access to the per-user principal of the Tooling API connection (created by setup-tooling.mjs).</description>
    <externalCredentialPrincipalAccesses>
        <enabled>true</enabled>
        <externalCredentialPrincipal>${NAME}-PerUser</externalCredentialPrincipal>
    </externalCredentialPrincipalAccesses>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Org Intelligence - Tooling Access</label>
</PermissionSet>`
);

// Suppression préalable (--reset), des éléments dépendants vers les éléments de base
if (args.includes("--reset")) {
  try {
    const assignments = sf([
      "data",
      "query",
      "--target-org",
      targetOrg,
      "--query",
      "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'OrgIntelligence_Tooling_Access'"
    ]).result.records;
    for (const assignment of assignments) {
      sf([
        "data",
        "delete",
        "record",
        "--sobject",
        "PermissionSetAssignment",
        "--record-id",
        assignment.Id,
        "--target-org",
        targetOrg
      ]);
    }
  } catch {
    // aucune assignation
  }
  const layers = [
    ["PermissionSet", ["OrgIntelligence_Tooling_Access"]],
    ["NamedCredential", [NAME]],
    ["ExternalCredential", [NAME]],
    ["AuthProvider", [NAME]],
    ["ExtlClntAppGlobalOauthSettings", [`${NAME}_glbloauth`]],
    ["ExtlClntAppOauthSettings", [`${NAME}_oauth`]],
    ["ExternalClientApplication", [NAME]]
  ];
  for (const [type, members] of layers) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-reset-"));
    fs.writeFileSync(
      path.join(dir, "package.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package ${NS}><version>66.0</version></Package>\n`
    );
    fs.writeFileSync(
      path.join(dir, "destructiveChanges.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package ${NS}><types>${members.map((m) => `<members>${m}</members>`).join("")}<name>${type}</name></types><version>66.0</version></Package>\n`
    );
    try {
      sf(
        [
          "project",
          "deploy",
          "start",
          "--target-org",
          targetOrg,
          "--metadata-dir",
          dir,
          "--wait",
          "20"
        ],
        root
      );
      console.log(`✔ Removed ${type}`);
    } catch {
      console.log(`• ${type}: nothing to remove`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const steps = [
  [
    "External Client App",
    [
      "externalClientApps",
      "extlClntAppOauthSettings",
      "extlClntAppGlobalOauthSets"
    ]
  ],
  ["Auth. Provider", ["authproviders"]],
  [
    "External Credential and Named Credential",
    ["externalCredentials", "namedCredentials"]
  ],
  ["Permission set", ["permissionsets"]]
];

let failed = false;
for (const [label, dirs] of steps) {
  const sourceDirs = dirs.flatMap((dir) => [
    "--source-dir",
    path.join("force-app/main/default", dir)
  ]);
  try {
    sf(
      [
        "project",
        "deploy",
        "start",
        "--target-org",
        targetOrg,
        "--wait",
        "20",
        ...sourceDirs
      ],
      root
    );
    console.log(`✔ ${label}`);
  } catch (error) {
    failed = true;
    let detail = error.stdout || error.message;
    try {
      const parsed = JSON.parse(error.stdout);
      const failures =
        parsed.result?.details?.componentFailures ??
        parsed.data?.details?.componentFailures ??
        [];
      detail =
        (Array.isArray(failures) ? failures : [failures])
          .map((f) => `${f.fullName}: ${f.problem}`)
          .join("\n") || parsed.message;
    } catch {
      // sortie non JSON
    }
    console.error(
      `✘ ${label}\n${detail.replaceAll(consumerSecret, "•••").replaceAll(consumerKey, "•••")}`
    );
    break;
  }
}

if (!failed) {
  try {
    sf([
      "org",
      "assign",
      "permset",
      "--name",
      "OrgIntelligence_Tooling_Access",
      "--target-org",
      targetOrg
    ]);
    console.log("✔ Permission set assigned to the current user");
  } catch {
    console.log("• Permission set already assigned (or to assign manually)");
  }
  if (namespace) {
    console.log(`✔ Named Credential open to the "${namespace}" namespace`);
  }
  console.log(
    `\nLast step, for each administrator: Org Intelligence > Settings > "Connect" (or avatar > Settings > External Credentials > "Org Intelligence Tooling" > Allow Access).`
  );
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
