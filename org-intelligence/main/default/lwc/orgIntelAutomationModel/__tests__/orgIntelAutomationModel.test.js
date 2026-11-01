import {
  CONFLICT_TYPE_KEYS,
  STAGES,
  buildAutomationData,
  buildOrgGraph,
  conflictsFor,
  findingsFor,
  kindMeta,
  layoutOrgGraph,
  nodeLines,
  parseAutomations,
  placeSegments,
  stagesFor,
  truncate
} from "c/orgIntelAutomationModel";

const model = (value) => JSON.stringify(value);
const update = (fields, extra = {}) => ({
  sameRecord: true,
  operation: "Update",
  fields,
  ...extra
});

const VIEW = {
  scanId: "a00",
  scanName: "SCAN-0001",
  flowLogicAnalysed: true,
  automations: [
    {
      id: "1",
      apiName: "Account_Before",
      label: "Account before",
      kind: "Flow",
      timing: "Before save",
      objectName: "Account",
      isActive: true,
      events: ["Create", "Update"],
      modelJson: model({ writes: [update(["Name", "Rating"])] })
    },
    {
      id: "2",
      apiName: "Account_After",
      label: "Account after",
      kind: "Flow",
      timing: "After save",
      objectName: "Account",
      isActive: true,
      events: ["Update"],
      modelJson: model({
        triggerOrder: 10,
        writes: [
          update(["Rating"]),
          { objectName: "Contact", operation: "Create" }
        ],
        subflows: ["Sub_Flow"],
        otherActions: ["flow: Other_Flow", 42, "email"]
      })
    },
    {
      id: "3",
      apiName: "Account_PB",
      kind: "Process Builder",
      objectName: "Account",
      isActive: true,
      events: [],
      modelJson: model({ writes: [update(["Name"])] })
    },
    {
      id: "4",
      apiName: "AccountTrigger",
      kind: "Apex trigger",
      objectName: "Account",
      isActive: true,
      events: ["before update", "after insert"]
    },
    {
      id: "5",
      apiName: "AccountTrigger2",
      kind: "Apex trigger",
      objectName: "Account",
      isActive: true,
      events: ["before update"]
    },
    {
      id: "6",
      apiName: "Sub_Flow",
      label: "Sub flow",
      kind: "Flow",
      isActive: true,
      modelJson: model({
        writes: [{ objectName: "Opportunity", operation: "Delete" }]
      })
    },
    {
      id: "7",
      apiName: "Other_Flow",
      kind: "Flow",
      isActive: true,
      modelJson: "{not json"
    },
    {
      id: "8",
      apiName: "Contact_After",
      kind: "Flow",
      timing: "After save",
      objectName: "Contact",
      isActive: true,
      modelJson: model({
        writes: [{ objectName: "Account", operation: "Update", fields: ["X"] }]
      })
    },
    {
      id: "9",
      apiName: "Old_Flow",
      kind: "Flow",
      timing: "Before delete",
      objectName: "Account",
      isActive: false
    },
    {
      id: "10",
      apiName: "Lead_Flow",
      kind: "Flow",
      timing: "Before save",
      objectName: "Lead",
      isActive: true
    }
  ],
  findings: [
    { componentName: "Account_After", ruleCode: "FLOW_X" },
    { componentName: "Other", affectedComponents: "Foo\nAccountTrigger" }
  ],
  cycles: [
    {
      key: "c1",
      label: "Account ↔ Contact",
      objects: ["Account", "Contact"],
      automations: ["Account_After", "Contact_After"]
    }
  ],
  flowErrors: [
    { flowApiName: "Account_After", count: 3 },
    { flowApiName: "AccountTrigger", count: 9 },
    { flowApiName: "Missing" }
  ]
};

describe("c-org-intel-automation-model", () => {
  it("describes kinds and truncates text", () => {
    expect(kindMeta("Flow").key).toBe("flow");
    expect(kindMeta("Workflow")).toMatchObject({
      key: "other",
      label: "Workflow"
    });
    expect(kindMeta(undefined).label).toBe("Automation");
    expect(truncate(null, 5)).toBe("");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(CONFLICT_TYPE_KEYS[0]).toBe("loop");
    expect(STAGES.find((s) => s.system).key).toBe("systemSave");
  });

  it("parses the view: model, name, called flows and re-saves", () => {
    const automations = parseAutomations(VIEW);
    const byApi = Object.fromEntries(automations.map((a) => [a.apiName, a]));
    expect(byApi.Account_After.name).toBe("Account after");
    expect(byApi.Account_PB.name).toBe("Account_PB");
    expect(byApi.Account_After.calls.sort()).toEqual([
      "Other_Flow",
      "Sub_Flow"
    ]);
    expect(byApi.Account_After.resaves).toBe(true);
    expect(byApi.Account_PB.resaves).toBe(true);
    expect(byApi.Account_Before.resaves).toBe(false);
    expect(byApi.Other_Flow.model).toBeNull();
    expect(byApi.AccountTrigger.model).toBeNull();
    expect(parseAutomations(null)).toEqual([]);
  });

  it("finds the findings of an automation", () => {
    const [, after, , trigger] = parseAutomations(VIEW);
    expect(findingsFor(after, VIEW.findings)).toHaveLength(1);
    expect(findingsFor(trigger, VIEW.findings)).toHaveLength(1);
    expect(findingsFor(trigger, null)).toEqual([]);
  });

  describe("order of execution", () => {
    const automations = parseAutomations(VIEW);

    it("lists the non-empty stages with the system step", () => {
      const keys = stagesFor(automations, "Account", "").map((s) => s.key);
      expect(keys).toEqual([
        "beforeSave",
        "beforeTrigger",
        "systemSave",
        "afterTrigger",
        "processBuilder",
        "afterSave"
      ]);
    });

    it("filters by event", () => {
      const create = stagesFor(automations, "Account", "Create");
      expect(create.map((s) => s.key)).toEqual([
        "beforeSave",
        "systemSave",
        "afterTrigger",
        "processBuilder"
      ]);
      expect(
        create.find((s) => s.key === "afterTrigger").items[0].apiName
      ).toBe("AccountTrigger");
      // Process Builder sans événement : retenu ; flows de création absents à la suppression
      expect(stagesFor(automations, "Account", "Delete")).toEqual([]);
      expect(stagesFor(automations, "Nothing", "")).toEqual([]);
    });

    it("sorts by trigger order then by name", () => {
      const list = [
        {
          name: "B",
          kind: "Flow",
          timing: "After save",
          objectName: "X",
          isActive: true,
          model: { triggerOrder: 1 }
        },
        {
          name: "A",
          kind: "Flow",
          timing: "After save",
          objectName: "X",
          isActive: true
        },
        {
          name: "C",
          kind: "Flow",
          timing: "After save",
          objectName: "X",
          isActive: true
        }
      ];
      const stage = stagesFor(list, "X", "").find((s) => s.key === "afterSave");
      expect(stage.items.map((a) => a.name)).toEqual(["B", "A", "C"]);
    });
  });

  describe("conflicts", () => {
    const automations = parseAutomations(VIEW);
    const conflicts = conflictsFor(automations, "Account", "", VIEW.cycles);
    const ofType = (type) => conflicts.filter((c) => c.type === type);

    it("sorts conflicts from the most serious", () => {
      expect(conflicts[0].type).toBe("loop");
      expect(conflicts.every((c) => c.objectName === "Account")).toBe(true);
    });

    it("detects a loop between objects", () => {
      const [loop] = ofType("loop");
      expect(loop).toMatchObject({ key: "loop-c1", severity: "Critical" });
      expect(loop.automations.map((a) => a.apiName)).toEqual([
        "Account_After",
        "Contact_After"
      ]);
    });

    it("detects fields written by several automations", () => {
      const fields = ofType("field");
      const titles = fields.map((c) => c.title);
      expect(titles).toContain("Name written by 2 automations");
      expect(titles).toContain("Rating written by 2 automations");
      const rating = fields.find((c) => c.fields.includes("Rating"));
      expect(rating.detail).toContain("Account after (after-save flows)");
    });

    it("detects an order that is not guaranteed", () => {
      const titles = ofType("order").map((c) => c.title);
      expect(titles).toEqual([
        "2 apex before triggers run in no guaranteed order"
      ]);
    });

    it("detects re-saves and mixed tools", () => {
      expect(
        ofType("resave")
          .map((c) => c.key)
          .sort()
      ).toEqual(["resave-2", "resave-3"]);
      const mixed = ofType("mixed").map((c) => c.key);
      expect(mixed).toEqual(["mixed-pb-Account", "mixed-apex-Account"]);
    });

    it("flags a single unordered flow when others are ordered", () => {
      const list = [
        {
          id: "a",
          name: "A",
          kind: "Flow",
          timing: "Before save",
          objectName: "X",
          isActive: true,
          model: { triggerOrder: 1 }
        },
        {
          id: "b",
          name: "B",
          kind: "Flow",
          timing: "Before save",
          objectName: "X",
          isActive: true
        }
      ];
      const [order] = conflictsFor(list, "X", "", null);
      expect(order.title).toBe(
        "1 before-save flows run in no guaranteed order"
      );
    });
  });

  describe("section data", () => {
    const data = buildAutomationData(VIEW);

    it("computes objects and indicators", () => {
      expect(data.objects.map((o) => o.name)).toEqual([
        "Account",
        "Contact",
        "Lead"
      ]);
      const account = data.objects[0];
      expect(account.counts).toEqual({ flow: 2, pb: 1, apex: 2 });
      expect(account.issues).toBe(2);
      expect(account.errors).toBe(3); // les erreurs ne s'appliquent pas aux triggers
      expect(account.resaves).toBe(2);
      expect(account.worstTone).toBe("critical");
      expect(account.inLoop).toBe(true);
      expect(data.objects[2]).toMatchObject({
        conflictCount: 0,
        worstTone: null
      });
      expect(data.kpis).toMatchObject({
        objects: 3,
        active: 9,
        inactive: 1,
        loops: 1,
        failedRuns: 12,
        flowCount: 6,
        pbCount: 1,
        apexCount: 2
      });
      expect(data.errorDays).toBe(30);
      expect(data.flowLogicAnalysed).toBe(true);
    });

    it("deduplicates conflicts shared by several objects", () => {
      expect(data.allConflicts.filter((c) => c.key === "loop-c1")).toHaveLength(
        1
      );
      expect(data.kpis.mixedNotes).toBe(2);
      expect(data.kpis.conflicts).toBe(data.allConflicts.length - 2);
    });

    it("handles an empty view", () => {
      const empty = buildAutomationData(undefined);
      expect(empty.objects).toEqual([]);
      expect(empty.graph).toEqual({ nodes: [], edges: [] });
      expect(empty.orgDomainUrl).toBe("");
    });
  });

  describe("org graph", () => {
    const data = buildAutomationData(VIEW);
    const { graph } = data;
    const edge = (from, to) =>
      graph.edges.find((e) => e.from === from && e.to === to);

    it("creates object and launched flow nodes", () => {
      const keys = graph.nodes.map((n) => n.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          "o:Account",
          "o:Contact",
          "o:Lead",
          "o:Opportunity",
          "f:Sub_Flow"
        ])
      );
      // Flow lancé sans écriture mais appelé : présent comme cible
      expect(keys).toContain("f:Other_Flow");
      expect(graph.nodes.find((n) => n.key === "o:Opportunity").automated).toBe(
        false
      );
    });

    it("aggregates edges by operation and marks loops", () => {
      expect(edge("o:Account", "o:Contact")).toMatchObject({
        operation: "create",
        loop: true
      });
      expect(edge("o:Contact", "o:Account")).toMatchObject({
        operation: "update",
        loop: true
      });
      expect(edge("o:Account", "f:Sub_Flow").operation).toBe("calls");
      expect(edge("f:Sub_Flow", "o:Opportunity")).toMatchObject({
        operation: "delete",
        loop: false
      });
    });

    it("merges several automations on one edge", () => {
      const automations = [
        {
          id: "a",
          name: "A",
          apiName: "A",
          kind: "Flow",
          objectName: "X",
          isActive: true,
          model: {
            writes: [
              { objectName: "Y", operation: "Update" },
              { objectName: "Y", operation: "Update" }
            ]
          }
        },
        {
          id: "b",
          name: "B",
          apiName: "B",
          kind: "Flow",
          objectName: "X",
          isActive: true,
          model: { writes: [{ objectName: "Y", operation: "Update" }] }
        }
      ];
      const result = buildOrgGraph(automations, [], [{ objects: ["Z"] }]);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].automations.map((a) => a.id)).toEqual(["a", "b"]);
    });
  });

  describe("map layout", () => {
    const { graph } = buildAutomationData(VIEW);

    it("places connected nodes in layers and isolated ones in a grid", () => {
      const layout = layoutOrgGraph(graph);
      expect(layout.connectedCount).toBe(5);
      expect(layout.isolatedCount).toBe(1);
      expect(layout.hasIsolated).toBe(true);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBeGreaterThan(0);
      const account = layout.nodes.find((n) => n.key === "o:Account");
      const opportunity = layout.nodes.find((n) => n.key === "o:Opportunity");
      expect(opportunity.x).toBeGreaterThan(account.x);
      for (const e of layout.edges) {
        expect(e.path).toMatch(/^M /);
        expect(e.head.split(" ")).toHaveLength(3);
        expect(e.label).toMatch(/creates|updates|deletes|calls/);
      }
      // Arête de retour du cycle Account ↔ Contact
      expect(layout.edges.filter((e) => e.isBack)).toHaveLength(1);
    });

    it("routes long edges through intermediate columns and labels counts", () => {
      const nodes = ["A", "B", "C"].map((name) => ({
        key: name,
        name,
        automationCount: 1
      }));
      const auto = (id) => ({ id, name: id });
      const edges = [
        {
          key: "AB",
          from: "A",
          to: "B",
          operation: "update",
          automations: [auto("1")]
        },
        {
          key: "BC",
          from: "B",
          to: "C",
          operation: "update",
          automations: [auto("2")]
        },
        {
          key: "AC",
          from: "A",
          to: "C",
          operation: "create",
          automations: [auto("3"), auto("4")]
        },
        {
          key: "AC2",
          from: "A",
          to: "C",
          operation: "zap",
          automations: [auto("5")]
        }
      ];
      const layout = layoutOrgGraph({ nodes, edges });
      const long = layout.edges.find((e) => e.key === "AC");
      expect(long.path).toContain(" L ");
      expect(long.label).toBe("creates ×2");
      expect(long.width).toBeCloseTo(2.3);
      expect(layout.edges.find((e) => e.key === "AC2").label).toBe("zap");
      expect(layout.hasIsolated).toBe(false);
    });

    it("can be restricted to some nodes, or contain only isolated ones", () => {
      const only = layoutOrgGraph(graph, { onlyKeys: new Set(["o:Lead"]) });
      expect(only.nodes).toHaveLength(1);
      expect(only.edges).toHaveLength(0);
      expect(only.connectedCount).toBe(0);
      expect(only.hasIsolated).toBe(false);
      const none = layoutOrgGraph({ nodes: [], edges: [] });
      expect(none.nodes).toEqual([]);
    });
  });

  it("describes a map card", () => {
    expect(nodeLines({ type: "flow" }).counts[0].text).toBe(
      "Autolaunched flow"
    );
    expect(nodeLines({ type: "object", automated: false })).toEqual({
      counts: [{ key: "none", text: "No automation of its own", color: null }],
      status: []
    });
    expect(
      nodeLines({ type: "object", automated: true, counts: { flow: 1 } }).status
    ).toEqual([{ key: "ok", text: "No conflict", tone: "good" }]);
    const busy = nodeLines({
      type: "object",
      automated: true,
      counts: { flow: 2, pb: 1, apex: 3 },
      inLoop: true,
      conflictCount: 2,
      worstTone: "serious",
      errors: 4,
      resaves: 1
    });
    expect(busy.counts.map((c) => c.text)).toEqual([
      "2 Flow",
      "1 PB",
      "3 Apex"
    ]);
    expect(busy.status.map((s) => s.text)).toEqual([
      "Loop",
      "2 conflicts",
      "4 failed",
      "↻ 1 re-save"
    ]);
    expect(
      nodeLines({
        type: "object",
        automated: true,
        counts: {},
        conflictCount: 1,
        worstTone: "critical"
      }).status[0]
    ).toEqual({ key: "conflicts", text: "1 conflict", tone: "critical" });
  });

  it("places text segments", () => {
    const placed = placeSegments([{ text: "ab" }, { text: "c" }], 10, {
      charWidth: 5,
      gap: 2,
      dot: 3
    });
    expect(placed).toEqual([
      { text: "ab", x: 10, textX: 13 },
      { text: "c", x: 25, textX: 28 }
    ]);
    expect(placeSegments([{ text: "a" }], 0)[0].textX).toBe(0);
  });
});
