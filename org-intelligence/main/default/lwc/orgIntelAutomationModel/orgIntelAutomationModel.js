/**
 * Modèle de la section Automation, en fonctions pures (sans dépendance à la plateforme) :
 * lecture de la vue Apex, ordre d'exécution par objet, conflits (par objet et pour toute l'org),
 * graphe et mise en page de la carte des objets. Partagé par les composants Automation et par
 * les exports (rapport HTML, SVG, Mermaid, CSV).
 */

/** Types d'automatisation : couleur fixe (lisible en clair comme en sombre) et libellés. */
export const KINDS = {
  Flow: {
    key: "flow",
    label: "Flow",
    plural: "Flows",
    color: "#7c5cdb",
    icon: "utility:flow"
  },
  "Process Builder": {
    key: "pb",
    label: "Process Builder",
    plural: "Process Builders",
    short: "PB",
    color: "#d9822b",
    icon: "utility:process"
  },
  "Apex trigger": {
    key: "apex",
    label: "Apex trigger",
    plural: "Apex triggers",
    short: "Apex",
    color: "#2f6fd1",
    icon: "utility:apex"
  }
};

export function kindMeta(kind) {
  return (
    KINDS[kind] || {
      key: "other",
      label: kind || "Automation",
      plural: kind || "Automations",
      color: "#8a919c",
      icon: "utility:settings"
    }
  );
}

const TRIGGER_EVENTS = {
  Create: ["insert"],
  Update: ["update"],
  Delete: ["delete", "undelete"]
};

function triggerMatches(automation, moment, event) {
  return (automation.events || []).some(
    (item) =>
      item.startsWith(moment) &&
      (!event || (TRIGGER_EVENTS[event] || []).some((e) => item.endsWith(e)))
  );
}

/** Étapes de l'ordre d'exécution Salesforce (sans les règles de validation). */
export const STAGES = [
  {
    key: "beforeDelete",
    title: "Before-delete flows",
    subtitle: "Run just before the record is deleted.",
    events: ["Delete"],
    match: (a) => a.kind === "Flow" && a.timing === "Before delete"
  },
  {
    key: "beforeSave",
    title: "Before-save flows",
    subtitle: "Fast field updates on the record itself, no extra save.",
    match: (a) => a.kind === "Flow" && a.timing === "Before save"
  },
  {
    key: "beforeTrigger",
    title: "Apex before triggers",
    subtitle: "Code run before the record is written.",
    match: (a, e) => a.kind === "Apex trigger" && triggerMatches(a, "before", e)
  },
  {
    key: "systemSave",
    system: true,
    title: "Salesforce saves the record",
    subtitle:
      "System and custom validation rules, duplicate rules, then the record is written (not committed yet)."
  },
  {
    key: "afterTrigger",
    title: "Apex after triggers",
    subtitle: "Code run once the record has an Id.",
    match: (a, e) => a.kind === "Apex trigger" && triggerMatches(a, "after", e)
  },
  {
    key: "processBuilder",
    title: "Process Builder",
    subtitle: "Legacy processes, retired by Salesforce: migrate to flows.",
    events: ["Create", "Update"],
    match: (a) => a.kind === "Process Builder"
  },
  {
    key: "afterSave",
    title: "After-save flows",
    subtitle: "Record-triggered flows that can update other records.",
    match: (a) => a.kind === "Flow" && a.timing === "After save"
  }
];

/** Types de conflit, du plus grave au moins grave. */
export const CONFLICT_TYPES = {
  loop: {
    label: "Loop",
    tone: "critical",
    severity: "Critical",
    order: 0,
    advice:
      "Break the cycle: add entry criteria so each automation only runs when its own fields change, or move the logic into one place."
  },
  field: {
    label: "Same field",
    tone: "serious",
    severity: "High",
    order: 1,
    advice:
      "Keep a single owner for each field: merge the logic or make the entry criteria exclusive."
  },
  resave: {
    label: "Saves again",
    tone: "serious",
    severity: "High",
    order: 2,
    advice:
      "Update the triggering record in a before-save flow instead: no second save, much faster."
  },
  order: {
    label: "Order",
    tone: "warning",
    severity: "Medium",
    order: 3,
    advice:
      "Set a Trigger Order on each flow, or merge the triggers into one trigger and a handler."
  },
  mixed: {
    label: "Mixed tools",
    tone: "low",
    severity: "Low",
    order: 4,
    advice:
      "Consolidate the logic of the object in one tool (one trigger + handler, or flows)."
  }
};

export const CONFLICT_TYPE_KEYS = Object.keys(CONFLICT_TYPES);

export function truncate(text, max) {
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- Lecture de la vue ----------

/** Flows appelés par une automatisation (sous-flows et actions « flow: X »). */
function calledFlows(model) {
  const names = new Set(model?.subflows || []);
  for (const action of model?.otherActions || []) {
    if (typeof action === "string" && action.startsWith("flow: ")) {
      names.add(action.slice(6).trim());
    }
  }
  return [...names];
}

export function parseAutomations(view) {
  return (view?.automations || []).map((automation) => {
    let model = null;
    try {
      model = automation.modelJson ? JSON.parse(automation.modelJson) : null;
    } catch {
      model = null;
    }
    const meta = kindMeta(automation.kind);
    return {
      ...automation,
      model,
      name: automation.label || automation.apiName,
      kindKey: meta.key,
      calls: calledFlows(model),
      resaves:
        (model?.writes || []).some(
          (w) => w.sameRecord && w.operation === "Update"
        ) &&
        (automation.timing === "After save" ||
          automation.kind === "Process Builder")
    };
  });
}

export function findingsFor(automation, findings) {
  return (findings || []).filter(
    (finding) =>
      finding.componentName === automation.apiName ||
      (finding.affectedComponents || "")
        .split("\n")
        .includes(automation.apiName)
  );
}

// ---------- Ordre d'exécution ----------

/** Étapes non vides pour un objet et un événement (« » = création ou modification). */
export function stagesFor(automations, objectName, event) {
  const items = automations.filter(
    (a) => a.objectName === objectName && a.isActive
  );
  const stages = STAGES.filter(
    (stage) => !event || !stage.events || stage.events.includes(event)
  ).map((stage) => ({
    ...stage,
    items: stage.system
      ? []
      : items
          .filter((a) => stage.match(a, event))
          .filter(
            (a) =>
              !event ||
              a.kind === "Apex trigger" ||
              !(a.events || []).length ||
              a.events.includes(event)
          )
          .sort(
            (a, b) =>
              (a.model?.triggerOrder ?? 9999) -
                (b.model?.triggerOrder ?? 9999) || a.name.localeCompare(b.name)
          )
  }));
  if (!stages.some((stage) => stage.items.length)) {
    return [];
  }
  return stages.filter((stage) => stage.system || stage.items.length > 0);
}

// ---------- Conflits ----------

function ref(automation, stage) {
  return {
    id: automation.id,
    name: automation.name,
    apiName: automation.apiName,
    kind: automation.kind,
    stage: stage?.title
  };
}

function conflict(type, fields) {
  const meta = CONFLICT_TYPES[type];
  return {
    type,
    label: meta.label,
    tone: meta.tone,
    severity: meta.severity,
    advice: meta.advice,
    automations: [],
    ...fields
  };
}

/**
 * Conflits entre les automatisations d'un objet pour un événement : champ écrit par plusieurs
 * automatisations (la dernière gagne), ordre non garanti, nouvelle sauvegarde de
 * l'enregistrement, boucles entre objets, outils mélangés.
 */
export function conflictsFor(automations, objectName, event, cycles) {
  const stages = stagesFor(automations, objectName, event).filter(
    (stage) => !stage.system
  );
  const conflicts = [];

  // Même champ écrit par plusieurs automatisations
  const writersByField = new Map();
  stages.forEach((stage) =>
    stage.items.forEach((automation) => {
      for (const write of automation.model?.writes || []) {
        if (!write.sameRecord || write.operation !== "Update") {
          continue;
        }
        for (const field of write.fields || []) {
          const writers = writersByField.get(field) || [];
          if (!writers.some((w) => w.id === automation.id)) {
            writers.push(ref(automation, stage));
          }
          writersByField.set(field, writers);
        }
      }
    })
  );
  const groups = new Map();
  for (const [field, writers] of writersByField) {
    if (writers.length < 2) {
      continue;
    }
    const key = writers.map((w) => w.id).join("|");
    const group = groups.get(key) || { writers, fields: [] };
    group.fields.push(field);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const last = group.writers[group.writers.length - 1];
    conflicts.push(
      conflict("field", {
        key: `field-${objectName}-${key}`,
        title: `${group.fields.sort().join(", ")} written by ${group.writers.length} automations`,
        detail: `Each one overwrites the previous value; ${last.name} (${(last.stage || "").toLowerCase()}) runs last and wins.`,
        fields: group.fields,
        automations: group.writers,
        chain: true
      })
    );
  }

  // Ordre non garanti au sein d'une même étape
  for (const stage of stages) {
    const items = stage.items;
    if (items.length < 2) {
      continue;
    }
    const isApex = stage.key.endsWith("Trigger");
    const sharesEvent = (a) =>
      items.some(
        (b) =>
          b !== a && (a.events || []).some((e) => (b.events || []).includes(e))
      );
    const unordered = isApex
      ? items.filter(sharesEvent)
      : items.filter((a) => a.model?.triggerOrder == null);
    if (unordered.length > 1 || (unordered.length === 1 && !isApex)) {
      conflicts.push(
        conflict("order", {
          key: `order-${objectName}-${stage.key}`,
          title: `${unordered.length} ${stage.title.toLowerCase()} run in no guaranteed order`,
          detail: isApex
            ? "Salesforce does not guarantee the order of several triggers on the same event: merge them into one trigger and a handler."
            : "Set a Trigger Order on each flow in Flow Builder, or merge them.",
          automations: unordered.map((a) => ref(a, stage))
        })
      );
    }
  }

  // Nouvelle sauvegarde du même enregistrement
  for (const stage of stages) {
    for (const automation of stage.items) {
      if (automation.resaves) {
        conflicts.push(
          conflict("resave", {
            key: `resave-${automation.id}`,
            title: `${automation.name} updates the ${objectName} record that triggered it`,
            detail:
              "The whole order of execution runs a second time (before-save flows, triggers, other flows).",
            automations: [ref(automation, stage)]
          })
        );
      }
    }
  }

  // Boucles entre objets
  for (const cycle of (cycles || []).filter((c) =>
    (c.objects || []).includes(objectName)
  )) {
    conflicts.push(
      conflict("loop", {
        key: `loop-${cycle.key}`,
        title: cycle.label,
        detail:
          "These objects update each other: risk of recursion and of hitting governor limits.",
        objects: cycle.objects,
        automations: automations
          .filter((a) => (cycle.automations || []).includes(a.apiName))
          .map((a) => ref(a))
      })
    );
  }

  // Outils mélangés
  const present = new Set(
    stages.flatMap((stage) => stage.items.map((a) => a.kind))
  );
  if (present.has("Process Builder") && present.has("Flow")) {
    conflicts.push(
      conflict("mixed", {
        key: `mixed-pb-${objectName}`,
        title: "Process Builder and flows both run on this object",
        detail:
          "Process Builder is retired: migrate it into the flows so the logic lives in one place.",
        automations: stages
          .flatMap((stage) => stage.items)
          .filter((a) => a.kind === "Process Builder")
          .map((a) => ref(a))
      })
    );
  }
  if (present.has("Apex trigger") && present.size > 1) {
    conflicts.push(
      conflict("mixed", {
        key: `mixed-apex-${objectName}`,
        title:
          "Apex triggers and declarative automation both run on this object",
        detail:
          "Check they do not update the same fields: the fields written by Apex are not analyzed.",
        automations: []
      })
    );
  }

  return conflicts
    .map((item) => ({ ...item, objectName }))
    .sort(
      (a, b) => CONFLICT_TYPES[a.type].order - CONFLICT_TYPES[b.type].order
    );
}

// ---------- Données de la section ----------

/**
 * Tout ce que la section affiche, calculé une fois au chargement : automatisations lues, objets,
 * conflits par objet et pour l'org (boucles dédoublonnées), graphe et indicateurs.
 */
export function buildAutomationData(view) {
  const automations = parseAutomations(view);
  const findings = view?.findings || [];
  const cycles = view?.cycles || [];
  const errorsByFlow = new Map(
    (view?.flowErrors || []).map((summary) => [summary.flowApiName, summary])
  );
  const errorsFor = (automation) => {
    if (automation.kind === "Apex trigger") {
      return null;
    }
    return errorsByFlow.get(automation.apiName) || null;
  };

  const enriched = automations.map((automation) => ({
    ...automation,
    findings: findingsFor(automation, findings),
    errors: errorsFor(automation)
  }));
  const active = enriched.filter((a) => a.isActive);

  const objectNames = [
    ...new Set(active.filter((a) => a.objectName).map((a) => a.objectName))
  ].sort((a, b) => a.localeCompare(b));
  const conflictsByObject = {};
  for (const name of objectNames) {
    conflictsByObject[name] = conflictsFor(enriched, name, "", cycles);
  }

  const seen = new Set();
  const allConflicts = [];
  for (const name of objectNames) {
    for (const item of conflictsByObject[name]) {
      if (seen.has(item.key)) {
        continue;
      }
      seen.add(item.key);
      allConflicts.push(item);
    }
  }
  allConflicts.sort(
    (a, b) =>
      CONFLICT_TYPES[a.type].order - CONFLICT_TYPES[b.type].order ||
      a.objectName.localeCompare(b.objectName)
  );

  const objects = objectNames.map((name) => {
    const items = active.filter((a) => a.objectName === name);
    const counts = { flow: 0, pb: 0, apex: 0 };
    for (const a of items) {
      counts[a.kindKey] = (counts[a.kindKey] || 0) + 1;
    }
    const conflicts = conflictsByObject[name];
    return {
      name,
      automations: items,
      automationCount: items.length,
      counts,
      issues: items.reduce((sum, a) => sum + a.findings.length, 0),
      errors: items.reduce((sum, a) => sum + (a.errors?.count || 0), 0),
      resaves: items.filter((a) => a.resaves).length,
      conflictCount: conflicts.filter((c) => c.type !== "mixed").length,
      worstTone: conflicts[0]?.tone || null,
      inLoop: cycles.some((c) => (c.objects || []).includes(name))
    };
  });

  const failedRuns = (view?.flowErrors || []).reduce(
    (sum, s) => sum + (s.count || 0),
    0
  );
  const graph = buildOrgGraph(enriched, objects, cycles);

  return {
    scanId: view?.scanId,
    scanName: view?.scanName,
    scanCompletedAt: view?.scanCompletedAt,
    orgDomainUrl: view?.orgDomainUrl || "",
    errorDays: view?.errorDays || 30,
    flowErrorsMessage: view?.flowErrorsMessage,
    flowLogicAnalysed: !!view?.flowLogicAnalysed,
    automations: enriched,
    findings,
    cycles,
    objects,
    conflictsByObject,
    allConflicts,
    graph,
    kpis: {
      objects: objectNames.length,
      active: active.length,
      inactive: enriched.length - active.length,
      conflicts: allConflicts.filter((c) => c.type !== "mixed").length,
      mixedNotes: allConflicts.filter((c) => c.type === "mixed").length,
      loops: cycles.length,
      failedRuns,
      flowCount: active.filter((a) => a.kindKey === "flow").length,
      pbCount: active.filter((a) => a.kindKey === "pb").length,
      apexCount: active.filter((a) => a.kindKey === "apex").length
    }
  };
}

// ---------- Graphe de l'org ----------

function operationClass(operation) {
  if (operation === "Create") {
    return "create";
  }
  if (operation === "Delete") {
    return "delete";
  }
  if (operation === "Calls") {
    return "calls";
  }
  return "update";
}

/**
 * Graphe des objets : nœud par objet automatisé ou écrit par une automatisation, nœud par flow
 * lancé (autolaunched) appelé ou écrivant ; arête = écriture d'un autre objet ou appel d'un flow,
 * agrégée par type d'opération. Les écritures des triggers Apex ne sont pas connues.
 */
export function buildOrgGraph(automations, objects, cycles) {
  const nodes = new Map();
  const objectByName = new Map(objects.map((o) => [o.name, o]));
  const ensureObject = (name) => {
    const key = `o:${name}`;
    if (!nodes.has(key)) {
      const info = objectByName.get(name);
      nodes.set(key, {
        key,
        name,
        type: "object",
        automated: !!info,
        counts: info?.counts || { flow: 0, pb: 0, apex: 0 },
        automationCount: info?.automationCount || 0,
        conflictCount: info?.conflictCount || 0,
        errors: info?.errors || 0,
        issues: info?.issues || 0,
        resaves: info?.resaves || 0,
        worstTone: info?.worstTone || null,
        inLoop: !!info?.inLoop
      });
    }
    return nodes.get(key);
  };
  const byApiName = new Map(automations.map((a) => [a.apiName, a]));
  const ensureFlow = (automation) => {
    const key = `f:${automation.apiName}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        name: automation.name,
        apiName: automation.apiName,
        automationId: automation.id,
        type: "flow",
        automated: true,
        counts: { flow: 1, pb: 0, apex: 0 },
        automationCount: 1,
        conflictCount: 0,
        errors: automation.errors?.count || 0,
        issues: automation.findings?.length || 0,
        resaves: 0,
        worstTone: null,
        inLoop: false
      });
    }
    return nodes.get(key);
  };

  objects.forEach((o) => ensureObject(o.name));

  const edges = new Map();
  const addEdge = (from, to, operation, automation) => {
    const op = operationClass(operation);
    const key = `${from.key}>${to.key}>${op}`;
    if (!edges.has(key)) {
      edges.set(key, {
        key,
        from: from.key,
        to: to.key,
        operation: op,
        automations: []
      });
    }
    const edge = edges.get(key);
    if (!edge.automations.some((a) => a.id === automation.id)) {
      edge.automations.push({ id: automation.id, name: automation.name });
    }
  };

  const active = automations.filter((a) => a.isActive);
  const isLaunched = (a) => !a.objectName && a.kind === "Flow";
  const calledNames = new Set(active.flatMap((a) => a.calls || []));

  for (const automation of active) {
    let source = null;
    if (automation.objectName) {
      source = ensureObject(automation.objectName);
    } else if (
      isLaunched(automation) &&
      ((automation.model?.writes || []).some((w) => w.objectName) ||
        calledNames.has(automation.apiName))
    ) {
      source = ensureFlow(automation);
    }
    if (!source) {
      continue;
    }
    for (const write of automation.model?.writes || []) {
      if (!write.objectName || write.objectName === automation.objectName) {
        continue;
      }
      addEdge(
        source,
        ensureObject(write.objectName),
        write.operation,
        automation
      );
    }
    for (const name of automation.calls || []) {
      const target = byApiName.get(name);
      if (target && isLaunched(target)) {
        addEdge(source, ensureFlow(target), "Calls", automation);
      }
    }
  }

  // Boucles : objets et arêtes concernés
  const loopPairs = new Set();
  for (const cycle of cycles || []) {
    const list = cycle.objects || [];
    list.forEach((name, index) => {
      const next = list[(index + 1) % list.length];
      loopPairs.add(`o:${name}>o:${next}`);
      const node = nodes.get(`o:${name}`);
      if (node) {
        node.inLoop = true;
      }
    });
  }
  for (const edge of edges.values()) {
    edge.loop =
      loopPairs.has(`${edge.from}>${edge.to}`) && edge.operation !== "delete";
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ---------- Mise en page de la carte ----------

export const MAP = {
  nodeWidth: 214,
  nodeHeight: 78,
  columnGap: 120,
  rowGap: 26,
  margin: 28,
  gridGap: 18,
  sectionGap: 54
};

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y
  };
}

function arrowHead(from, tip, size = 9) {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const px = -uy * (size * 0.5);
  const py = ux * (size * 0.5);
  const r = (n) => Math.round(n * 10) / 10;
  return `${r(tip.x)},${r(tip.y)} ${r(bx + px)},${r(by + py)} ${r(bx - px)},${r(by - py)}`;
}

/**
 * Mise en page en couches de gauche à droite : rang = plus long chemin depuis les sources (arêtes
 * de retour des cycles ignorées), ordre dans chaque colonne par barycentre des voisins, puis les
 * objets sans écriture croisée en grille sous le graphe.
 */
export function layoutOrgGraph(graph, { onlyKeys = null } = {}) {
  const { nodeWidth: W, nodeHeight: H, columnGap, rowGap, margin } = MAP;
  const nodes = graph.nodes.filter((n) => !onlyKeys || onlyKeys.has(n.key));
  const keys = new Set(nodes.map((n) => n.key));
  const edges = graph.edges.filter((e) => keys.has(e.from) && keys.has(e.to));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const outgoing = new Map(nodes.map((n) => [n.key, []]));
  const incoming = new Map(nodes.map((n) => [n.key, []]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }
  const connected = nodes.filter(
    (n) => outgoing.get(n.key).length || incoming.get(n.key).length
  );
  const isolated = nodes
    .filter((n) => !outgoing.get(n.key).length && !incoming.get(n.key).length)
    .sort(
      (a, b) =>
        b.automationCount - a.automationCount || a.name.localeCompare(b.name)
    );

  // Arêtes de retour (parcours en profondeur) : ignorées pour le calcul des rangs
  const back = new Set();
  const state = new Map();
  const visit = (key) => {
    state.set(key, 1);
    for (const edge of outgoing.get(key)) {
      const s = state.get(edge.to);
      if (s === 1) {
        back.add(edge.key);
      } else if (!s) {
        visit(edge.to);
      }
    }
    state.set(key, 2);
  };
  [...connected]
    .sort(
      (a, b) =>
        incoming.get(a.key).length - incoming.get(b.key).length ||
        a.name.localeCompare(b.name)
    )
    .forEach((n) => {
      if (!state.get(n.key)) {
        visit(n.key);
      }
    });

  const rank = new Map();
  const rankOf = (key, guard = new Set()) => {
    if (rank.has(key)) {
      return rank.get(key);
    }
    if (guard.has(key)) {
      return 0;
    }
    guard.add(key);
    let value = 0;
    for (const edge of incoming.get(key)) {
      if (!back.has(edge.key)) {
        value = Math.max(value, rankOf(edge.from, guard) + 1);
      }
    }
    rank.set(key, value);
    return value;
  };
  connected.forEach((n) => rankOf(n.key));

  const columns = [];
  // Couche de chaque élément : nœuds réels et points de passage des arêtes longues
  const items = new Map();
  const lin = new Map();
  const lout = new Map();
  const addItem = (key, r, isDummy) => {
    items.set(key, { key, rank: r, isDummy });
    lin.set(key, []);
    lout.set(key, []);
    columns[r] = columns[r] || [];
    columns[r].push(key);
  };
  for (const node of connected) {
    addItem(node.key, rank.get(node.key), false);
  }
  const hops = new Map();
  for (const edge of edges) {
    if (back.has(edge.key)) {
      continue;
    }
    const r1 = rank.get(edge.from);
    const r2 = rank.get(edge.to);
    const chain = [edge.from];
    for (let r = r1 + 1; r < r2; r++) {
      const key = `d:${edge.key}:${r}`;
      addItem(key, r, true);
      chain.push(key);
    }
    chain.push(edge.to);
    for (let i = 0; i < chain.length - 1; i++) {
      lout.get(chain[i]).push(chain[i + 1]);
      lin.get(chain[i + 1]).push(chain[i]);
    }
    hops.set(edge.key, chain);
  }
  const nameOf = (key) => {
    return items.get(key).isDummy ? `~${key}` : byKey.get(key).name;
  };
  for (let r = 0; r < columns.length; r++) {
    columns[r] = (columns[r] || []).sort((a, b) =>
      nameOf(a).localeCompare(nameOf(b))
    );
  }
  const position = new Map();
  columns.forEach((column) => column.forEach((key, i) => position.set(key, i)));
  for (let sweep = 0; sweep < 8; sweep++) {
    const downward = sweep % 2 === 0;
    const order = downward
      ? columns.map((_, i) => i)
      : columns.map((_, i) => columns.length - 1 - i);
    for (const r of order) {
      const column = columns[r];
      const weight = new Map();
      for (const key of column) {
        const neighbours = downward ? lin.get(key) : lout.get(key);
        const values = neighbours.map((k) => position.get(k));
        weight.set(
          key,
          values.length
            ? values.reduce((s, v) => s + v, 0) / values.length
            : position.get(key)
        );
      }
      column.sort((a, b) => weight.get(a) - weight.get(b));
      column.forEach((key, i) => position.set(key, i));
    }
  }

  const DUMMY = 14;
  const GAP = rowGap + 18;
  const itemHeight = (key) => (items.get(key).isDummy ? DUMMY : H);
  const columnHeight = (column) =>
    column.reduce((sum, key) => sum + itemHeight(key), 0) +
    Math.max(0, column.length - 1) * GAP;
  const graphHeight = Math.max(0, ...columns.map((c) => columnHeight(c)));
  const positions = new Map();
  columns.forEach((column, r) => {
    let y = margin + (graphHeight - columnHeight(column)) / 2;
    for (const key of column) {
      positions.set(key, { x: margin + r * (W + columnGap), y });
      y += itemHeight(key) + GAP;
    }
  });
  const layeredWidth = columns.length
    ? margin * 2 + columns.length * W + (columns.length - 1) * columnGap
    : 0;

  // Grille des objets isolés
  const width = Math.max(layeredWidth, margin * 2 + 4 * W + 3 * MAP.gridGap);
  const perRow = Math.max(
    1,
    Math.floor((width - margin * 2 + MAP.gridGap) / (W + MAP.gridGap))
  );
  let gridTop = margin + (graphHeight ? graphHeight + MAP.sectionGap : 0);
  const gridLabelY = gridTop - 14;
  if (isolated.length) {
    gridTop += graphHeight ? 8 : 18;
  }
  isolated.forEach((node, i) => {
    positions.set(node.key, {
      x: margin + (i % perRow) * (W + MAP.gridGap),
      y: gridTop + Math.floor(i / perRow) * (H + MAP.gridGap)
    });
  });
  const gridRows = Math.ceil(isolated.length / perRow);
  const height =
    (isolated.length
      ? gridTop + gridRows * H + (gridRows - 1) * MAP.gridGap
      : margin + graphHeight) + margin;

  // Centre vertical d'un élément (nœud ou point de passage)
  const centerY = (key) => positions.get(key).y + itemHeight(key) / 2;

  // Ports : arêtes réparties le long des côtés pour limiter les chevauchements
  const port = (list, key) => {
    const index = list.indexOf(key);
    const count = list.length;
    const spacing = Math.min(14, (H - 20) / Math.max(1, count - 1));
    return H / 2 + (index - (count - 1) / 2) * spacing;
  };
  const outPorts = new Map();
  const inPorts = new Map();
  for (const node of connected) {
    const outs = outgoing
      .get(node.key)
      .filter((e) => hops.has(e.key))
      .sort((a, b) => centerY(hops.get(a.key)[1]) - centerY(hops.get(b.key)[1]))
      .map((e) => e.key);
    const ins = incoming
      .get(node.key)
      .filter((e) => hops.has(e.key))
      .sort((a, b) => {
        const ha = hops.get(a.key);
        const hb = hops.get(b.key);
        return centerY(ha[ha.length - 2]) - centerY(hb[hb.length - 2]);
      })
      .map((e) => e.key);
    outs.forEach((k) => outPorts.set(k, port(outs, k)));
    ins.forEach((k) => inPorts.set(k, port(ins, k)));
  }

  const r1 = (n) => Math.round(n * 10) / 10;
  let bottom = height;
  const laidEdges = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const count = edge.automations.length;
    let path;
    let head;
    let mid;
    const chain = hops.get(edge.key);
    if (chain) {
      // segments : sortie du nœud source, traversée des colonnes intermédiaires, entrée du nœud cible
      const points = [
        { x: from.x + W, y: from.y + (outPorts.get(edge.key) ?? H / 2) }
      ];
      for (const key of chain.slice(1, -1)) {
        const p = positions.get(key);
        points.push({ x: p.x, y: centerY(key), through: true });
      }
      points.push({ x: to.x - 2, y: to.y + (inPorts.get(edge.key) ?? H / 2) });
      const parts = [`M ${r1(points[0].x)} ${r1(points[0].y)}`];
      const segments = [];
      let start = points[0];
      for (let i = 1; i < points.length; i++) {
        const end = points[i];
        const bend = Math.max(40, (end.x - start.x) * 0.5);
        const c1 = { x: start.x + bend, y: start.y };
        const c2 = { x: end.x - bend, y: end.y };
        parts.push(
          `C ${r1(c1.x)} ${r1(c1.y)}, ${r1(c2.x)} ${r1(c2.y)}, ${r1(end.x)} ${r1(end.y)}`
        );
        segments.push([start, c1, c2, end]);
        if (end.through) {
          parts.push(`L ${r1(end.x + W)} ${r1(end.y)}`);
          start = { x: end.x + W, y: end.y };
        } else {
          start = end;
        }
      }
      path = parts.join(" ");
      const last = segments[segments.length - 1];
      head = arrowHead(last[2], last[3]);
      if (segments.length > 1) {
        // libellé sur la première traversée de colonne, à l'écart des nœuds
        const through = points[1];
        mid = { x: through.x + W / 2, y: through.y };
      } else {
        mid = bezierPoint(...segments[0], 0.5);
      }
    } else {
      // retour : par-dessous les deux nœuds
      const p0 = { x: from.x + W / 2 + 12, y: from.y + H };
      const p3 = { x: to.x + W / 2 - 12, y: to.y + H + 2 };
      const dip = Math.max(p0.y, p3.y) + 46 + Math.abs(p0.x - p3.x) * 0.08;
      bottom = Math.max(bottom, dip + 10);
      const p1 = { x: p0.x, y: dip };
      const p2 = { x: p3.x, y: dip };
      path = `M ${r1(p0.x)} ${r1(p0.y)} C ${r1(p1.x)} ${r1(p1.y)}, ${r1(p2.x)} ${r1(p2.y)}, ${r1(p3.x)} ${r1(p3.y)}`;
      head = arrowHead(p2, p3);
      mid = bezierPoint(p0, p1, p2, p3, 0.5);
    }
    return {
      ...edge,
      isBack: !chain,
      count,
      width: Math.min(5, 1.4 + (count - 1) * 0.9),
      path,
      head,
      labelX: r1(mid.x),
      labelY: r1(mid.y),
      label: edgeLabel(edge)
    };
  });

  // Libellés : décalés verticalement quand ils se chevauchent
  const placed = [];
  for (const edge of laidEdges) {
    const w = edge.label.length * 5.8 + 12;
    let guard = 0;
    while (
      guard < 12 &&
      placed.some(
        (o) =>
          Math.abs(o.x - edge.labelX) < (o.w + w) / 2 + 4 &&
          Math.abs(o.y - edge.labelY) < 18
      )
    ) {
      edge.labelY += 19;
      guard++;
    }
    placed.push({ x: edge.labelX, y: edge.labelY, w });
    edge.labelWidth = w;
  }

  return {
    width: Math.round(width),
    height: Math.round(Math.max(bottom, height)),
    nodes: nodes.map((n) => ({
      ...n,
      ...positions.get(n.key),
      width: W,
      height: H
    })),
    edges: laidEdges,
    hasIsolated: isolated.length > 0 && connected.length > 0,
    gridLabelY,
    isolatedCount: isolated.length,
    connectedCount: connected.length
  };
}

const OPERATION_LABELS = {
  create: "creates",
  update: "updates",
  delete: "deletes",
  calls: "calls"
};

function edgeLabel(edge) {
  const verb = OPERATION_LABELS[edge.operation] || edge.operation;
  return edge.automations.length > 1
    ? `${verb} ×${edge.automations.length}`
    : verb;
}

/** Couleurs de la carte exportée (thème clair, valeurs en dur). */
export const EXPORT_PALETTE = {
  background: "#f7f8fb",
  dot: "#e3e8ef",
  surface: "#ffffff",
  border: "#c9d4e3",
  text: "#181818",
  muted: "#5c6470",
  accent: "#0b5cab",
  create: "#12a150",
  update: "#3b7dd8",
  calls: "#7c5cdb",
  delete: "#8a919c",
  loop: "#d03b3b",
  critical: "#d03b3b",
  serious: "#e0703f",
  warning: "#c98a00",
  low: "#3b7dd8",
  good: "#2e7d32"
};

/** Lignes de texte d'une carte d'objet (comptes par type, état), partagées écran / export. */
export function nodeLines(node) {
  const counts = [];
  if (node.type === "flow") {
    counts.push({
      key: "kind",
      text: "Autolaunched flow",
      color: KINDS.Flow.color
    });
  } else if (!node.automated) {
    counts.push({ key: "none", text: "No automation of its own", color: null });
  } else {
    for (const kind of Object.values(KINDS)) {
      const value = node.counts[kind.key] || 0;
      if (value) {
        counts.push({
          key: kind.key,
          text: `${value} ${kind.short || kind.label}`,
          color: kind.color
        });
      }
    }
  }
  const status = [];
  if (node.inLoop) {
    status.push({ key: "loop", text: "Loop", tone: "critical" });
  }
  if (node.conflictCount) {
    status.push({
      key: "conflicts",
      text: `${node.conflictCount} conflict${node.conflictCount > 1 ? "s" : ""}`,
      tone: node.worstTone === "critical" ? "critical" : "serious"
    });
  }
  if (node.errors) {
    status.push({
      key: "errors",
      text: `${node.errors} failed`,
      tone: "critical"
    });
  }
  if (node.resaves) {
    status.push({
      key: "resaves",
      text: `↻ ${node.resaves} re-save`,
      tone: "warning"
    });
  }
  if (!status.length && node.automated && node.type === "object") {
    status.push({ key: "ok", text: "No conflict", tone: "good" });
  }
  return { counts, status };
}

/** Position horizontale approximative des segments d'une ligne de texte SVG. */
export function placeSegments(
  segments,
  startX,
  { charWidth = 6.1, gap = 18, dot = 0 } = {}
) {
  let x = startX;
  return segments.map((segment) => {
    const placed = { ...segment, x, textX: x + dot };
    x += dot + segment.text.length * charWidth + gap;
    return placed;
  });
}
