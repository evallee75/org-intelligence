import {
  SIZES,
  applyFilters,
  buildRoadmap,
  defaultSize,
  defaultStart,
  periodStart,
  reasonOf,
  sizeDays,
  themesOf,
  toMarkdown,
  valueOf
} from "c/orgIntelRoadmapModel";

const TODAY = new Date(2026, 10, 2); // lundi 2 novembre 2026

const row = (id, extra = {}) => ({
  id,
  title: `Topic ${id}`,
  severity: "Medium",
  category: "Technical Debt",
  domain: "Apex",
  ruleCode: "APEX_SOQL_DML_IN_LOOP",
  isOpen: true,
  stillDetected: true,
  ...extra
});

describe("c-org-intel-roadmap-model", () => {
  describe("sizes and values", () => {
    it("maps sizes to days and falls back to M", () => {
      expect(SIZES).toHaveLength(5);
      expect(sizeDays("XS")).toBe(0.25);
      expect(sizeDays("XL")).toBe(5);
      expect(sizeDays("nope")).toBe(1);
    });

    it("derives a default size from the rule code", () => {
      expect(defaultSize({ ruleCode: "APEX_UNDOCUMENTED" })).toBe("XS");
      expect(defaultSize({ ruleCode: "field_usage_unused" })).toBe("XS");
      expect(defaultSize({ ruleCode: "APEX_HARDCODED_ID" })).toBe("S");
      expect(defaultSize({ ruleCode: "ADOPTION_CONTRACT_UNUSED" })).toBe("XS");
      expect(defaultSize({ ruleCode: "ADOPTION_LICENSE" })).toBe("S");
      expect(defaultSize({ ruleCode: "AUTOMATION_PROCESS_BUILDER" })).toBe("L");
      expect(defaultSize({ ruleCode: "ADOPTION_FEATURE_CASES" })).toBe("L");
      expect(defaultSize({ ruleCode: "APEX_LOW_COVERAGE" })).toBe("M");
      expect(defaultSize({ ruleCode: "SECURITY_MFA" })).toBe("L");
      expect(defaultSize({ ruleCode: "SECURITY_DEBUG_MODE" })).toBe("M");
      expect(defaultSize({ ruleCode: "STORAGE_DATA" })).toBe("M");
      expect(
        defaultSize({ ruleCode: "OTHER", category: "Documentation" })
      ).toBe("XS");
      expect(defaultSize({})).toBe("M");
    });

    it("weights value by severity, category and urgency", () => {
      expect(
        valueOf({ severity: "Critical", category: "Security" }, TODAY)
      ).toBe(15);
      expect(valueOf({ severity: "Unknown" }, TODAY)).toBe(1);
      expect(
        valueOf({ severity: "High", dueDate: "2026-10-01" }, TODAY)
      ).toBeCloseTo(7.8);
      expect(valueOf({ severity: "High", dueDate: "2026-12-01" }, TODAY)).toBe(
        6
      );
      expect(valueOf({ severity: "Low", stillDetected: false }, TODAY)).toBe(
        0.5
      );
      // date par défaut : aujourd'hui
      expect(valueOf({ severity: "Low" })).toBe(1);
    });

    it("explains the rank", () => {
      const item = {
        severity: null,
        category: null,
        size: "M",
        days: 1,
        value: 3,
        boost: 1
      };
      expect(reasonOf(item, "balanced")).toBe(
        "No severity · uncategorised · M (1 d) · value 3 · moved up by you"
      );
      expect(reasonOf({ ...item, boost: -1 }, "quickWins")).toContain(
        "moved down by you · 3 value per day"
      );
      expect(reasonOf({ ...item, boost: 0 }, "risk")).not.toContain("moved");
    });
  });

  describe("filters", () => {
    const rows = [
      row("1", { assignedToId: "005A", severity: "High" }),
      row("2", { isOpen: false }),
      row("3", { domain: null, category: "Security", componentName: "Foo" }),
      row("4", { name: "REC-0004", title: "Find me" })
    ];

    it("keeps open rows by default", () => {
      expect(applyFilters(rows, {}).map((r) => r.id)).toEqual(["1", "3", "4"]);
      expect(applyFilters(rows, { openOnly: false })).toHaveLength(4);
    });

    it("filters by domain, severity, category and assignee", () => {
      const ids = (filters) =>
        applyFilters(rows, filters, "005A").map((r) => r.id);
      expect(ids({ domains: ["Other"] })).toEqual(["3"]);
      expect(ids({ severities: ["High"] })).toEqual(["1"]);
      expect(ids({ categories: ["Security"] })).toEqual(["3"]);
      expect(ids({ assignee: "me" })).toEqual(["1"]);
      expect(ids({ assignee: "unassigned" })).toEqual(["3", "4"]);
    });

    it("searches title, component, rule and name", () => {
      const ids = (search) => applyFilters(rows, { search }).map((r) => r.id);
      expect(ids("  foo ")).toEqual(["3"]);
      expect(ids("rec-0004")).toEqual(["4"]);
      expect(ids("find")).toEqual(["4"]);
      expect(ids("dml_in_loop")).toEqual(["1", "3", "4"]);
    });
  });

  describe("dates", () => {
    it("computes period starts", () => {
      const start = new Date(2026, 0, 5);
      expect(periodStart(start, "week", 2)).toEqual(new Date(2026, 0, 19));
      expect(periodStart(start, "sprint", 1)).toEqual(new Date(2026, 0, 19));
      expect(periodStart(start, "month", 2)).toEqual(new Date(2026, 2, 1));
    });

    it("starts next Monday, or the first of next month", () => {
      expect(defaultStart("sprint", TODAY)).toEqual(new Date(2026, 10, 2));
      expect(defaultStart("week", new Date(2026, 10, 4))).toEqual(
        new Date(2026, 10, 9)
      );
      expect(defaultStart("week", new Date(2026, 10, 8))).toEqual(
        new Date(2026, 10, 9)
      );
      expect(defaultStart("month", TODAY)).toEqual(new Date(2026, 11, 1));
      expect(defaultStart("week")).toBeInstanceOf(Date);
    });
  });

  describe("buildRoadmap", () => {
    const rows = [
      row("low", { severity: "Low", ruleCode: "APEX_UNDOCUMENTED" }), // XS, 1
      row("crit", {
        severity: "Critical",
        ruleCode: "AUTOMATION_PROCESS_BUILDER", // L, 10
        domain: "Flows & Automation"
      }),
      row("high", { severity: "High", ruleCode: "APEX_HARDCODED_ID" }), // S, 6
      row("med", {
        severity: "Medium",
        ruleCode: "STORAGE_X",
        domain: "Storage"
      }) // M, 3
    ];

    it("orders by the balanced strategy and places topics on the timeline", () => {
      const roadmap = buildRoadmap(rows, {
        today: TODAY,
        settings: { capacity: 2, rhythm: "week" }
      });
      expect(roadmap.items.map((i) => i.id)).toEqual([
        "crit",
        "high",
        "med",
        "low"
      ]);
      const [crit, high] = roadmap.items;
      expect(crit).toMatchObject({
        rank: 1,
        startDay: 0,
        endDay: 3,
        period: 0,
        endPeriod: 1,
        span: 2,
        sizeIsDefault: true
      });
      expect(high).toMatchObject({ startDay: 3, endDay: 3.5, period: 1 });
      expect(roadmap.totalDays).toBe(4.75);
      expect(roadmap.periodCount).toBe(3);
      expect(roadmap.periods).toHaveLength(3);
      expect(roadmap.periods[0]).toMatchObject({
        label: "Week 1",
        used: 2,
        capacity: 2,
        start: new Date(2026, 10, 2),
        end: new Date(2026, 10, 8)
      });
      expect(roadmap.periods[1].items.map((i) => i.id)).toEqual([
        "high",
        "med"
      ]);
      expect(roadmap.periods[1].used).toBe(2);
      expect(roadmap.endDate).toEqual(new Date(2026, 10, 22));
      expect(roadmap.beyondHorizon).toHaveLength(0);
    });

    it("supports the risk and quick-wins strategies", () => {
      const ids = (strategy) =>
        buildRoadmap(rows, { today: TODAY, settings: { strategy } }).items.map(
          (i) => i.id
        );
      expect(ids("risk")).toEqual(["crit", "high", "med", "low"]);
      // valeur par jour : high 12, low 4, crit 3.33, med 3
      expect(ids("quickWins")).toEqual(["high", "low", "crit", "med"]);
    });

    it("applies overrides: size, boost and exclusion", () => {
      const roadmap = buildRoadmap(rows, {
        today: TODAY,
        overrides: {
          low: { boost: 1, size: "XL" },
          high: { excluded: true },
          med: { boost: -1 }
        }
      });
      expect(roadmap.items.map((i) => i.id)).toEqual(["low", "crit", "med"]);
      expect(roadmap.items[0]).toMatchObject({ days: 5, sizeIsDefault: false });
      expect(roadmap.excluded.map((i) => i.id)).toEqual(["high"]);
    });

    it("groups topics by theme when asked", () => {
      const roadmap = buildRoadmap(rows, {
        today: TODAY,
        settings: { byTheme: true, startDate: "2026-11-09" }
      });
      // Apex (high 6 + low 1 = 7) passe devant Storage (3) mais derrière Flows (10)
      expect(roadmap.items.map((i) => i.id)).toEqual([
        "crit",
        "high",
        "low",
        "med"
      ]);
      expect(roadmap.start).toEqual(new Date(2026, 10, 9));
      expect(themesOf(roadmap.items)).toEqual([
        "Flows & Automation",
        "Apex",
        "Storage"
      ]);
    });

    it("keeps topics beyond the horizon and handles bad settings", () => {
      const roadmap = buildRoadmap(rows, {
        today: TODAY,
        settings: { capacity: "abc", horizon: 0, rhythm: "month" }
      });
      expect(roadmap.settings.capacity).toBe(5);
      expect(roadmap.periods).toHaveLength(1);
      expect(roadmap.periods[0].label).toBe("Month 1");

      const tight = buildRoadmap(rows, {
        today: TODAY,
        settings: { capacity: 0.5, horizon: 2, rhythm: "unknown" }
      });
      expect(tight.periods).toHaveLength(2);
      expect(tight.periods[0].label).toBe("Sprint 1");
      expect(tight.beyondHorizon.length).toBeGreaterThan(0);
    });

    it("returns an empty roadmap without rows", () => {
      const roadmap = buildRoadmap([]);
      expect(roadmap.items).toEqual([]);
      expect(roadmap.periods).toEqual([]);
      expect(roadmap.endDate).toBeNull();
      expect(roadmap.totalDays).toBe(0);
    });
  });

  it("exports the roadmap as Markdown", () => {
    const rows = [
      row("a", {
        severity: "Critical",
        ruleCode: "AUTOMATION_WORKFLOW",
        assignedToName: "Jane"
      }),
      row("b", { severity: null, ruleCode: "APEX_HARDCODED" })
    ];
    const roadmap = buildRoadmap(rows, {
      today: TODAY,
      settings: { capacity: 1, horizon: 2, rhythm: "week" }
    });
    const md = toMarkdown(roadmap, (d) => d.toISOString().slice(0, 10));
    expect(md).toContain("# Salesforce remediation roadmap");
    expect(md).toContain("2 topics · 3.5 days of work · 1 days per period");
    expect(md).toContain("**Critical** · Topic a (Apex, L) — Jane");
    expect(md).toContain("## Week 2");
    expect(md).toContain("- (continuation of the previous topics)");
    expect(md).toContain("## Later (1 topics)");
    expect(md).toContain("- [ ] Topic b (Apex, S)");
  });
});
