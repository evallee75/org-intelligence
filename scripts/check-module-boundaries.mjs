#!/usr/bin/env node
// Org Intelligence — contrôle des frontières entre le socle et les modules.
//
// 1. Dépendances : le socle (org-intelligence/) doit pouvoir être installé seul : il ne doit
//    référencer statiquement aucune classe, aucun objet ni aucun champ d'un module. Un module ne peut
//    référencer que le socle et les modules dont il dépend (sfdx-project.json). Les noms cités dans
//    les commentaires et les chaînes (découverte dynamique par Type.forName) sont autorisés.
//    Un dossier sans « package » (source-tools/ : outils de l'installation depuis les sources) peut
//    tout référencer, mais aucun paquet ne doit le référencer.
//
// 2. @NamespaceAccessible : en package géré, les paquets partagent un namespace mais le code `public`
//    d'un paquet n'est visible des autres que s'il porte @NamespaceAccessible (classe ET membre ; une
//    interface annotée couvre ses méthodes). Tout membre d'un autre paquet utilisé par un module doit
//    donc être annoté. Un membre @AuraEnabled ne peut pas l'être (refus du compilateur) : passer par des
//    données simples (Map, List) ou une méthode annotée. Les classes d'entrée des modules (étendent
//    OrgIntelModule, chargées par Type.forName) doivent aussi être annotées.
//    Les accès d'instance (variable.membre) sont repérés par heuristique : `.membre` dans le code d'un
//    paquet qui cite le type.
//
// Usage : node scripts/check-module-boundaries.mjs   (code de sortie 1 en cas de violation)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const project = JSON.parse(
  fs.readFileSync(path.join(root, "sfdx-project.json"), "utf8")
);

// Paquets : chemin → nom et dépendances (noms de paquets du projet). Un dossier sans « package »
// (outils hors package) dépend de tout le projet.
const declared = project.packageDirectories.map((dir) => ({
  name: dir.package || dir.path,
  path: dir.path,
  unpackaged: !dir.package,
  dependencies: (dir.dependencies || []).map((dep) =>
    dep.package.replace(/@.*$/, "")
  )
}));
const packages = declared.map((pkg) =>
  pkg.unpackaged
    ? {
        ...pkg,
        dependencies: declared
          .filter((other) => other !== pkg && !other.unpackaged)
          .map((other) => other.name)
      }
    : pkg
);
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
          return entry.name === "__tests__" || / \d+$/.test(entry.name)
            ? []
            : walk(full);
        return / \d+\./.test(entry.name) ? [] : [full]; // doublons iCloud « fichier 2.js »
      })
    : [];

// Symboles définis par chaque paquet : classes Apex, objets créés, champs ajoutés à d'autres objets
const symbolsOf = (pkg) => {
  const symbols = new Set();
  for (const file of walk(path.join(root, pkg.path))) {
    const base = path.basename(file);
    if (base.endsWith(".cls")) symbols.add(base.replace(/\.cls$/, ""));
    if (base.endsWith(".object-meta.xml"))
      symbols.add(base.replace(/\.object-meta\.xml$/, ""));
    if (base.endsWith(".field-meta.xml")) {
      const object = path.basename(path.dirname(path.dirname(file)));
      const ownsObject = fs.existsSync(
        path.join(path.dirname(path.dirname(file)), `${object}.object-meta.xml`)
      );
      if (!ownsObject) {
        // champ ajouté par le module à un objet d'un autre paquet : Recommendation__c → Recommendation__r aussi
        const field = base.replace(/\.field-meta\.xml$/, "");
        symbols.add(field);
        symbols.add(field.replace(/__c$/, "__r"));
      }
    }
  }
  return symbols;
};
const symbols = new Map(packages.map((pkg) => [pkg.name, symbolsOf(pkg)]));

/**
 * Apex sans commentaires ni contenu des chaînes (lecture caractère par caractère : un « // » dans
 * une chaîne, ex. 'https://', n'est pas un commentaire).
 */
const stripApex = (source) => {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
    } else if (char === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== "'")
        j += source[j] === "\\" ? 2 : 1;
      out += "''";
      i = j;
    } else {
      out += char;
    }
  }
  return out;
};

const allowedFor = (pkg) => {
  const allowed = new Set([pkg.name]);
  const visit = (name) => {
    for (const dep of byName.get(name)?.dependencies || []) {
      if (!allowed.has(dep)) {
        allowed.add(dep);
        visit(dep);
      }
    }
  };
  visit(pkg.name);
  return allowed;
};

const violations = [];
const apexSources = new Map(); // fichier → source neutralisée
const strippedApex = (file) => {
  if (!apexSources.has(file))
    apexSources.set(file, stripApex(fs.readFileSync(file, "utf8")));
  return apexSources.get(file);
};

// ---------- 1. Dépendances entre paquets ----------

for (const pkg of packages) {
  const allowed = allowedFor(pkg);
  const forbidden = [];
  for (const [name, set] of symbols) {
    if (!allowed.has(name))
      for (const symbol of set) forbidden.push([symbol, name]);
  }
  for (const file of walk(path.join(root, pkg.path))) {
    const relative = path.relative(root, file);
    let text;
    if (/\.(cls|trigger)$/.test(file)) {
      text = strippedApex(file);
    } else if (/\/lwc\/.*\.js$/.test(file)) {
      // LWC : seuls les imports Apex / schéma comptent (ils doivent exister au déploiement)
      text = (
        fs
          .readFileSync(file, "utf8")
          .match(/@salesforce\/(?:apex|schema)\/[\w.]+/g) || []
      ).join("\n");
    } else if (/\.(xml)$/.test(file)) {
      text = fs
        .readFileSync(file, "utf8")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<description>[\s\S]*?<\/description>/g, " ");
    } else {
      continue;
    }
    for (const [symbol, owner] of forbidden) {
      if (
        new RegExp(
          `(?<![\\w])${symbol.replace(/[.$]/g, "\\$&")}(?![\\w])`
        ).test(text)
      ) {
        violations.push(
          `${relative}: references ${symbol} (package ${owner}, not a dependency of ${pkg.name})`
        );
      }
    }
  }
}

// ---------- 2. @NamespaceAccessible entre paquets ----------

const ANNOTATION = /@NamespaceAccessible\b/i;
const AURA = /@AuraEnabled\b/i;

/**
 * Modèle d'une classe Apex : classe (annotée ?, global ?), membres publics / protégés et classes
 * internes. Analyse par profondeur d'accolades sur la source neutralisée.
 */
const parseApexClass = (source) => {
  const top = { name: null, members: new Map(), inner: new Map() };
  const stack = []; // contextes : { kind: 'type' | 'block', model }
  let buffer = "";
  const current = () => stack[stack.length - 1];
  const visibility = (text) =>
    /\bglobal\b/i.test(text)
      ? "global"
      : /\b(public|protected)\b/i.test(text)
        ? "public"
        : null;
  const typeOf = (text) => text.match(/\b(class|interface|enum)\s+(\w+)/i);
  const addMember = (model, text, isBlock) => {
    const vis = visibility(text);
    const isInterfaceMember = model.kind === "interface";
    if (!vis && !isInterfaceMember) return;
    const head = text.split("=")[0];
    const method = head.match(/(\w+)\s*\(/);
    let name;
    if (method) name = method[1];
    else {
      const words = head.replace(/<[^>]*>/g, " ").match(/\w+/g) || [];
      name = words[words.length - 1];
    }
    if (!name || /^(get|set)$/i.test(name)) return;
    model.members.set(name, {
      name,
      annotated: ANNOTATION.test(text) || vis === "global",
      aura: AURA.test(text),
      isStatic: /\bstatic\b/i.test(text),
      constructor: name === model.name,
      isBlock
    });
  };
  for (const char of source) {
    if (char === "{") {
      const ctx = current();
      const type = typeOf(buffer);
      if (type) {
        const model = {
          name: type[2],
          kind: type[1].toLowerCase(),
          annotated: ANNOTATION.test(buffer) || /\bglobal\b/i.test(buffer),
          visible: !!visibility(buffer),
          members: new Map(),
          inner: new Map()
        };
        if (!ctx) Object.assign(top, model);
        else if (ctx.kind === "type") ctx.model.inner.set(model.name, model);
        stack.push({ kind: "type", model: ctx ? model : top });
      } else {
        if (ctx?.kind === "type") addMember(ctx.model, buffer, true);
        stack.push({ kind: "block" });
      }
      buffer = "";
    } else if (char === "}") {
      stack.pop();
      buffer = "";
    } else if (char === ";") {
      const ctx = current();
      if (ctx?.kind === "type") addMember(ctx.model, buffer, false);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return top;
};

// Classes Apex de chaque paquet
const classOwner = new Map(); // nom de classe → { pkg, model, file }
for (const pkg of packages) {
  for (const file of walk(path.join(root, pkg.path))) {
    if (!file.endsWith(".cls")) continue;
    const name = path.basename(file, ".cls");
    classOwner.set(name, {
      pkg: pkg.name,
      file: path.relative(root, file),
      model: parseApexClass(strippedApex(file))
    });
  }
}

const memberProblem = (member) =>
  member.aura
    ? "is @AuraEnabled, so it cannot be @NamespaceAccessible: exchange plain data (Map, List) or add an annotated method"
    : "is not @NamespaceAccessible";

const report = (file, message) =>
  violations.push(`${file}: ${message} (managed package, same namespace)`);

for (const pkg of packages) {
  if (pkg.unpackaged) continue; // outils hors package : jamais dans un package géré
  for (const file of walk(path.join(root, pkg.path))) {
    if (!/\.(cls|trigger)$/.test(file)) continue;
    const relative = path.relative(root, file);
    const text = strippedApex(file);
    const seen = new Set();
    const once = (key, message) => {
      if (!seen.has(key)) {
        seen.add(key);
        report(relative, message);
      }
    };

    // Classe d'entrée d'un module : chargée par le socle (Type.forName) depuis un autre paquet
    const own = classOwner.get(path.basename(file, ".cls"));
    if (
      own &&
      /\bextends\s+OrgIntelModule\b/.test(text) &&
      classOwner.get("OrgIntelModule")?.pkg !== pkg.name &&
      !own.model.annotated
    ) {
      once(
        "entry",
        `${own.model.name} extends OrgIntelModule and is loaded by Type.forName from the core: annotate the class with @NamespaceAccessible`
      );
    }

    for (const [className, owner] of classOwner) {
      if (owner.pkg === pkg.name) continue;
      const reference = new RegExp(
        `(?<![\\w.])${className}\\b((?:\\s*\\.\\s*\\w+){0,2})`,
        "g"
      );
      let match;
      const usedTypes = new Set();
      while ((match = reference.exec(text))) {
        const model = owner.model;
        if (!model.annotated) {
          once(
            className,
            `uses ${className} (package ${owner.pkg}): the class is not @NamespaceAccessible`
          );
        }
        usedTypes.add(model);
        const parts = (match[1] || "")
          .split(".")
          .map((part) => part.trim())
          .filter(Boolean);
        if (!parts.length || parts[0] === "class") continue;
        const inner = model.inner.get(parts[0]);
        if (inner) {
          usedTypes.add(inner);
          if (!inner.annotated)
            once(
              `${className}.${parts[0]}`,
              `uses ${className}.${parts[0]}: the inner type is not @NamespaceAccessible`
            );
          const member = parts[1] && inner.members.get(parts[1]);
          if (member && !member.annotated && inner.kind !== "interface")
            once(
              `${className}.${parts[0]}.${parts[1]}`,
              `uses ${className}.${parts[0]}.${parts[1]}, which ${memberProblem(member)}`
            );
          continue;
        }
        const member = model.members.get(parts[0]);
        if (member && !member.annotated && model.kind !== "interface")
          once(
            `${className}.${parts[0]}`,
            `uses ${className}.${parts[0]}, which ${memberProblem(member)}`
          );
      }

      // Héritage : la sous-classe utilise directement les membres publics / protégés de sa base
      if (new RegExp(`\\bextends\\s+${className}\\b`).test(text)) {
        for (const member of owner.model.members.values()) {
          if (!member.annotated && !member.constructor)
            once(
              `${className}#${member.name}`,
              `extends ${className}, whose member ${member.name} ${memberProblem(member)}`
            );
        }
      }

      // Accès d'instance (heuristique) : « .membre » sur un type cité
      for (const model of usedTypes) {
        if (model.kind === "interface") continue;
        for (const member of model.members.values()) {
          if (member.annotated || member.isStatic || member.constructor)
            continue;
          if (new RegExp(`\\.\\s*${member.name}\\b`).test(text))
            once(
              `${model.name}#${member.name}`,
              `probably uses ${model.name}.${member.name} on an instance (package ${owner.pkg}), which ${memberProblem(member)}`
            );
        }
      }
    }
  }
}

if (violations.length) {
  console.error(`✖ ${violations.length} module boundary violation(s):`);
  for (const line of violations) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(
  `✔ Module boundaries respected, @NamespaceAccessible complete (${packages.map((pkg) => pkg.name).join(", ")})`
);
