import {
  loadLatestScanHeader,
  loadLatestScan,
  loadScanHistory,
  loadPreviousFindings,
  loadPreviousStorage,
  loadLastFailedScan,
  isFinished,
  saveLatestScan,
  saveFailedScan,
  loadFindingSnapshots,
  findingSnapshot,
  addFindingSnapshot,
  compareFindings,
  markNewFindings,
  domainOf,
  scoreBreakdown,
  scoreFromBreakdown,
  computeHealthScore,
  currentScore,
  domainCounts,
  severityCounts,
  severityCountList,
  componentCounts,
  errorCount,
  summarizeScan,
  findingRows,
  findingsWithPrefix,
  filterComponents,
  minimalFindings,
  compareWithPrevious,
  buildAutomations,
  findCycles,
  buildAutomationView,
  buildStorageView,
  findingToRecommendation,
  slimComponent,
  compactScan,
  importScan,
  PREVIOUS_FINDINGS_KEY,
  PREVIOUS_STORAGE_KEY,
  LAST_FAILED_KEY,
  SNAPSHOTS_KEY,
  SNAPSHOT_MAX
} from "c/orgIntelScanData";
import * as store from "c/orgIntelStore";

// Stockage en mémoire : `__setQuota(fn)` fait échouer l'écriture (raison « quota ») quand
// fn(key, value) renvoie true.
jest.mock("c/orgIntelStore", () => {
  class StoreError extends Error {
    constructor(message, reason = "unknown") {
      super(message);
      this.name = "StoreError";
      this.reason = reason;
    }
  }
  const data = new Map();
  let quota = null;
  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  async function read(key, fallback) {
    return data.has(key) ? clone(data.get(key)) : fallback;
  }
  return {
    StoreError,
    STORE_KEYS: {
      LATEST_SCAN: "scan.latest",
      SCAN_HISTORY: "scan.history"
    },
    loadValue: jest.fn(read),
    loadValueStrict: jest.fn(read),
    saveValue: jest.fn(async (key, value) => {
      if (quota && quota(key, value)) {
        throw new StoreError("full", "quota");
      }
      data.set(key, clone(value));
    }),
    removeValue: jest.fn(async (key) => {
      data.delete(key);
    }),
    listKeys: jest.fn(async (prefix) =>
      [...data.keys()].filter((key) => key.startsWith(prefix))
    ),
    __data: data,
    __setQuota: (fn) => {
      quota = fn;
    }
  };
});

const SCORE_CONFIG = {
  domains: ["Apex", "Flows & Automation", "Data Model", "Data Quality"],
  excludeIgnored: true,
  points: { Critical: 10, High: 5, Medium: 2, Low: 0.5, Info: 0 },
  caps: { Critical: 25, High: 15, Medium: 8, Low: 4, Info: 0 }
};

function finding(overrides = {}) {
  return {
    fingerprint: "APEX_HARDCODED_ID|ApexClass|AccountHandler",
    ruleCode: "APEX_HARDCODED_ID",
    componentType: "ApexClass",
    componentName: "AccountHandler",
    title: "Hardcoded record Id in AccountHandler",
    description: "A record Id is written in the code.",
    evidence: "Line 12: '001000000000001'",
    affectedComponents: ["AccountHandler"],
    severity: "High",
    category: "Maintainability",
    confidence: "High",
    ...overrides
  };
}

function flowComponent(apiName, overrides = {}) {
  return {
    key: `Flow:${apiName}`,
    componentType: "Flow",
    apiName,
    parentName: null,
    isActive: true,
    apiVersion: 60,
    details: { label: apiName },
    ...overrides
  };
}

function sampleScan(overrides = {}) {
  return {
    id: "scan-2",
    name: "SCAN-0002",
    status: "Completed",
    scope: ["Apex", "Flow"],
    startedAt: "2026-11-01T10:00:00.000Z",
    completedAt: "2026-11-01T10:05:00.000Z",
    toolingAvailable: true,
    healthScore: 80,
    log: [{ step: "Apex", level: "error", message: "boom" }],
    components: [
      {
        key: "ApexClass:AccountHandler",
        componentType: "ApexClass",
        apiName: "AccountHandler",
        apiVersion: 50,
        details: { lines: 120 },
        dependencies: { uses: ["Account"], usedBy: [] }
      },
      flowComponent("Account_Update", {
        details: {
          label: "Account update",
          model: {
            triggerObject: "Account",
            timing: "After save",
            triggerEvent: "Update",
            nodes: [{ id: "n1" }],
            edges: [],
            writes: []
          }
        }
      })
    ],
    findings: [
      finding(),
      finding({
        fingerprint: "FLOW_NO_FAULT|Flow|Account_Update",
        ruleCode: "FLOW_NO_FAULT",
        componentType: "Flow",
        componentName: "Account_Update",
        title: "Missing fault path",
        severity: "Medium"
      })
    ],
    evaluatedRules: ["APEX_HARDCODED_ID", "FLOW_NO_FAULT"],
    ...overrides
  };
}

beforeEach(() => {
  store.__data.clear();
  store.__setQuota(null);
  jest.clearAllMocks();
});

describe("lecture simple", () => {
  it("returns defaults when nothing is stored", async () => {
    expect(await loadLatestScanHeader()).toBeNull();
    expect(await loadLatestScan()).toBeNull();
    expect(await loadScanHistory()).toEqual([]);
    expect(await loadPreviousStorage()).toBeNull();
    expect(await loadLastFailedScan()).toBeNull();
    expect(await loadFindingSnapshots()).toEqual([]);
  });

  it("reads the legacy format as is", async () => {
    const legacy = sampleScan();
    store.__data.set("scan.latest", legacy);
    const loaded = await loadLatestScan();
    expect(loaded.components).toHaveLength(2);
    expect(loaded.findings).toHaveLength(2);
  });

  it("ignores a snapshot list that is not an array", async () => {
    store.__data.set(SNAPSHOTS_KEY, { broken: true });
    expect(await loadFindingSnapshots()).toEqual([]);
  });

  it("knows finished statuses", () => {
    expect(isFinished("Completed")).toBe(true);
    expect(isFinished("Completed with errors")).toBe(true);
    expect(isFinished("Failed")).toBe(false);
  });
});

describe("saveLatestScan / loadLatestScan", () => {
  it("splits the scan into parts and reassembles it", async () => {
    const scan = sampleScan();
    const result = await saveLatestScan(scan);
    expect(result).toEqual({
      inventoryKept: true,
      compacted: 0,
      droppedComponentTypes: [],
      warnings: []
    });
    const header = store.__data.get("scan.latest");
    expect(header.components).toBeUndefined();
    expect(header.findings).toBeUndefined();
    expect(header.storageFormat).toBe(2);
    expect(header.componentTotal).toBe(2);
    expect(header.findingCount).toBe(2);
    expect(header.parts.findings).toBe("scan.parts.scan-2.findings");
    expect(Object.keys(header.parts.components).sort()).toEqual([
      "ApexClass",
      "Flow"
    ]);
    // Les logigrammes sont gardés à part
    const flowRows = store.__data.get(header.parts.components.Flow);
    expect(flowRows[0].details.model).toBeUndefined();

    const loaded = await loadLatestScan();
    expect(loaded.parts).toBeUndefined();
    expect(loaded.findings).toHaveLength(2);
    expect(loaded.components).toHaveLength(2);
    const flow = loaded.components.find((c) => c.componentType === "Flow");
    expect(flow.details.model.triggerObject).toBe("Account");
    expect(flow.details.label).toBe("Account update");
  });

  it("removes the parts of the previous scan", async () => {
    await saveLatestScan(sampleScan({ id: "scan-1" }));
    await saveLatestScan(sampleScan({ id: "scan-2" }));
    const keys = [...store.__data.keys()].filter((k) =>
      k.startsWith("scan.parts.")
    );
    expect(keys.every((k) => k.startsWith("scan.parts.scan-2."))).toBe(true);
  });

  it("marks the inventory as partial when a part is missing", async () => {
    await saveLatestScan(sampleScan());
    const header = store.__data.get("scan.latest");
    store.__data.delete(header.parts.components.ApexClass);
    store.__data.delete(header.parts.findings);
    store.__data.set(header.parts.flowModels, "not an object");
    const loaded = await loadLatestScan();
    expect(loaded.inventoryKept).toBe("partial");
    expect(loaded.findings).toEqual([]);
    expect(loaded.findingsMissing).toBe(true);
    expect(loaded.components).toHaveLength(1);
  });

  it("shortens long finding texts when the storage is almost full", async () => {
    const long = "x".repeat(2500);
    const scan = sampleScan({
      components: [],
      findings: [finding({ description: long, evidence: long })]
    });
    store.__setQuota(
      (key, value) =>
        key.endsWith(".findings") && value[0].description.length > 2001
    );
    const result = await saveLatestScan(scan);
    expect(result.warnings[0]).toMatch(/shortened/);
    const saved = store.__data.get("scan.parts.scan-2.findings");
    expect(saved[0].description).toHaveLength(2001);
    expect(scan.log.some((entry) => entry.level === "warning")).toBe(true);
  });

  it("throws when the findings cannot be kept, leaving the previous scan", async () => {
    await saveLatestScan(sampleScan({ id: "scan-1" }));
    store.__setQuota((key) => key.startsWith("scan.parts.scan-2.findings"));
    await expect(saveLatestScan(sampleScan())).rejects.toMatchObject({
      reason: "quota"
    });
    expect(store.__data.get("scan.latest").id).toBe("scan-1");
  });

  it("frees the old parts first, then retries", async () => {
    await saveLatestScan(sampleScan({ id: "scan-1" }));
    let failures = 0;
    store.__setQuota((key) => {
      if (key === "scan.parts.scan-2.findings" && failures === 0) {
        failures++;
        return true;
      }
      return false;
    });
    const result = await saveLatestScan(sampleScan());
    expect(result.warnings).toEqual([]);
    expect(store.removeValue).toHaveBeenCalledWith(
      "scan.parts.scan-1.findings"
    );
  });

  it("drops component details, then whole types, when space runs out", async () => {
    const scan = sampleScan();
    // Apex : seule la variante sans détails passe ; Flow et logigrammes : jamais
    store.__setQuota((key, value) => {
      if (key.endsWith("components.ApexClass")) {
        return value[0].details !== undefined;
      }
      return key.endsWith("components.Flow") || key.endsWith("flowModels");
    });
    const result = await saveLatestScan(scan);
    expect(result.inventoryKept).toBe("partial");
    expect(result.compacted).toBe(2);
    expect(result.droppedComponentTypes.sort()).toEqual(["Flow", "flowModels"]);
    expect(result.warnings[0]).toMatch(/part of the inventory/);
  });

  it("reports a compacted inventory when only details were trimmed", async () => {
    store.__setQuota(
      (key, value) =>
        key.endsWith("components.ApexClass") &&
        value[0].dependencies !== undefined
    );
    const result = await saveLatestScan(sampleScan());
    expect(result.inventoryKept).toBe(true);
    expect(result.compacted).toBe(1);
    expect(result.warnings[0]).toMatch(/component details/);
  });

  it("uses the slim flow models when the full ones do not fit", async () => {
    store.__setQuota(
      (key, value) =>
        key.endsWith("flowModels") &&
        value["Flow:Account_Update"].nodes !== undefined
    );
    await saveLatestScan(sampleScan());
    const models = store.__data.get("scan.parts.scan-2.flowModels");
    expect(models["Flow:Account_Update"].nodes).toBeUndefined();
    expect(models["Flow:Account_Update"].timing).toBe("After save");
  });

  it("says the whole inventory was lost when no type fits", async () => {
    store.__setQuota(
      (key) => key.includes(".components.") || key.endsWith("flowModels")
    );
    const result = await saveLatestScan(sampleScan());
    expect(result.inventoryKept).toBe(false);
    expect(result.compacted).toBe(3);
    expect(result.warnings[0]).toMatch(/was not kept/);
  });

  it("rethrows errors that are not about the quota", async () => {
    store.saveValue.mockRejectedValueOnce(new Error("disk"));
    await expect(saveLatestScan(sampleScan())).rejects.toThrow("disk");
  });
});

describe("saveFailedScan", () => {
  it("keeps the header without inventory", async () => {
    await saveFailedScan(sampleScan({ status: "Failed" }));
    const saved = store.__data.get(LAST_FAILED_KEY);
    expect(saved.components).toBeUndefined();
    expect(saved.findings).toEqual([]);
    expect(saved.findingCount).toBe(2);
    expect(saved.componentTotal).toBe(2);
    expect((await loadLastFailedScan()).status).toBe("Failed");
  });
});

describe("empreintes", () => {
  it("builds a snapshot with shortened titles", () => {
    const snap = findingSnapshot(
      sampleScan({
        reliableRules: ["APEX_HARDCODED_ID"],
        findings: [finding({ title: "t".repeat(130) })]
      })
    );
    expect(snap.rules).toEqual(["APEX_HARDCODED_ID"]);
    expect(snap.findings[0].title).toHaveLength(121);
    expect(snap.findings[0].description).toBeUndefined();
    expect(findingSnapshot({ id: "x" })).toMatchObject({
      scope: [],
      rules: [],
      findings: []
    });
  });

  it("adds, replaces and sorts snapshots, keeping the latest ones", async () => {
    for (let i = 0; i < SNAPSHOT_MAX + 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      await addFindingSnapshot(
        sampleScan({
          id: `scan-${i}`,
          completedAt: `2026-10-${String(i + 10).padStart(2, "0")}T00:00:00Z`
        })
      );
    }
    let list = await loadFindingSnapshots();
    expect(list).toHaveLength(SNAPSHOT_MAX);
    expect(list[0].scanId).toBe("scan-11");
    await addFindingSnapshot(
      sampleScan({ id: "scan-11", completedAt: "2026-10-21T00:00:00Z" })
    );
    list = await loadFindingSnapshots();
    expect(list.filter((s) => s.scanId === "scan-11")).toHaveLength(1);
  });

  it("drops the oldest snapshots when the storage is full", async () => {
    store.__data.set(SNAPSHOTS_KEY, [
      { scanId: "a", completedAt: "2026-10-01" },
      { scanId: "b", completedAt: "2026-10-02" }
    ]);
    store.__setQuota((key, value) => key === SNAPSHOTS_KEY && value.length > 1);
    const list = await addFindingSnapshot(sampleScan());
    expect(list.map((s) => s.scanId)).toEqual(["scan-2"]);
  });

  it("gives up when even one snapshot does not fit", async () => {
    store.__setQuota((key) => key === SNAPSHOTS_KEY);
    await expect(addFindingSnapshot(sampleScan())).rejects.toMatchObject({
      reason: "quota"
    });
  });

  it("finds the previous findings from snapshots, or the legacy key", async () => {
    store.__data.set(PREVIOUS_FINDINGS_KEY, { scanId: "legacy" });
    expect((await loadPreviousFindings()).scanId).toBe("legacy");

    store.__data.set("scan.latest", {
      id: "scan-2",
      completedAt: "2026-11-01T10:05:00Z"
    });
    store.__data.set(SNAPSHOTS_KEY, [
      { scanId: "scan-2", completedAt: "2026-11-01T10:05:00Z" },
      { scanId: "scan-1", completedAt: "2026-10-30T10:05:00Z" }
    ]);
    expect((await loadPreviousFindings()).scanId).toBe("scan-1");

    store.__data.set(SNAPSHOTS_KEY, [
      { scanId: "scan-2", completedAt: "2026-11-01T10:05:00Z" }
    ]);
    expect((await loadPreviousFindings()).scanId).toBe("legacy");
  });

  it("reads the previous storage", async () => {
    store.__data.set(PREVIOUS_STORAGE_KEY, { scanName: "SCAN-0001" });
    expect((await loadPreviousStorage()).scanName).toBe("SCAN-0001");
  });
});

describe("comparaisons", () => {
  const a = { fingerprint: "a" };
  const b = { fingerprint: "b" };
  const c = { fingerprint: "c" };

  it("compares by fingerprint, from lists or snapshots", () => {
    expect(compareFindings([a, b], { findings: [b, c] })).toEqual({
      added: [a],
      removed: [c],
      unchanged: [b]
    });
    expect(compareFindings(null, undefined)).toEqual({
      added: [],
      removed: [],
      unchanged: []
    });
  });

  it("marks new findings only on rules evaluated in both scans", () => {
    const findings = [
      { fingerprint: "a", ruleCode: "R1" },
      { fingerprint: "x", ruleCode: "R1" },
      { fingerprint: "y", ruleCode: "R2" }
    ];
    markNewFindings(findings, { rules: ["R1"], findings: [a] });
    expect(findings.map((f) => f.isNew)).toEqual([false, true, false]);
    markNewFindings(findings, { findings: [a] });
    expect(findings.map((f) => f.isNew)).toEqual([false, true, true]);
    markNewFindings(findings, null);
    expect(findings.every((f) => f.isNew === false)).toBe(true);
    expect(markNewFindings(null, null)).toBeNull();
  });

  it("compares with the previous scan", () => {
    const scan = {
      id: "scan-2",
      findings: [{ fingerprint: "a", isNew: true }]
    };
    const previous = {
      scanId: "scan-1",
      scanName: "SCAN-0001",
      findings: [
        { fingerprint: "a" },
        { fingerprint: "b", severity: "Low", title: "Low one" },
        { fingerprint: "c", severity: "Critical", title: "Critical one" }
      ]
    };
    const result = compareWithPrevious(scan, previous);
    expect(result.newFindingCount).toBe(1);
    expect(result.disappearedCount).toBe(2);
    expect(result.disappeared).toEqual([
      "[Critical] Critical one",
      "[Low] Low one"
    ]);
    expect(result.previousScanName).toBe("SCAN-0001");
    expect(
      compareWithPrevious(scan, { ...previous, scanId: "scan-2" })
        .previousScanId
    ).toBeNull();
    expect(compareWithPrevious(null, null).newFindingCount).toBe(0);
  });

  it("keeps minimal findings", () => {
    const min = minimalFindings(sampleScan());
    expect(min.scanId).toBe("scan-2");
    expect(Object.keys(min.findings[0]).sort()).toEqual([
      "fingerprint",
      "ruleCode",
      "severity",
      "title"
    ]);
    expect(minimalFindings({ id: "x" }).findings).toEqual([]);
  });
});

describe("score", () => {
  it("maps rule prefixes to domains", () => {
    expect(domainOf("APEX_X")).toBe("Apex");
    expect(domainOf("TRIGGER_X")).toBe("Apex");
    expect(domainOf("FLOW_X")).toBe("Flows & Automation");
    expect(domainOf("AUTOMATION_X")).toBe("Flows & Automation");
    expect(domainOf("OBJECT_X")).toBe("Data Model");
    expect(domainOf("FIELD_X")).toBe("Data Model");
    expect(domainOf("VR_X")).toBe("Data Quality");
    expect(domainOf("STORAGE_X")).toBe("Storage");
    expect(domainOf("SECURITY_X")).toBe("Other");
    expect(domainOf(null)).toBe("Other");
  });

  it("groups findings by rule and counts the ignored ones", () => {
    const rows = scoreBreakdown(
      [
        finding({ fingerprint: "1" }),
        finding({ fingerprint: "2" }),
        finding({ fingerprint: "3", ruleCode: "VR_X", domain: "Custom" })
      ],
      ["2"]
    );
    expect(rows).toEqual([
      {
        ruleCode: "APEX_HARDCODED_ID",
        severity: "High",
        domain: "Apex",
        count: 2,
        ignoredCount: 1
      },
      {
        ruleCode: "VR_X",
        severity: "High",
        domain: "Custom",
        count: 1,
        ignoredCount: 0
      }
    ]);
    expect(scoreBreakdown(null, null)).toEqual([]);
  });

  it("applies points, caps, domains and ignored findings", () => {
    const rules = [
      // 4 × 10 = 40, plafonné à 25
      {
        ruleCode: "APEX_A",
        severity: "Critical",
        domain: "Apex",
        count: 4,
        ignoredCount: 0
      },
      // 3 − 1 ignoré = 2 × 5 = 10
      {
        ruleCode: "FLOW_A",
        severity: "High",
        domain: "Flows & Automation",
        count: 3,
        ignoredCount: 1
      },
      // domaine non compté
      {
        ruleCode: "STORAGE_A",
        severity: "High",
        domain: "Storage",
        count: 5,
        ignoredCount: 0
      },
      // « Other » toujours compté : 1 × 0,5
      {
        ruleCode: "X",
        severity: "Low",
        domain: "Other",
        count: 1,
        ignoredCount: 0
      },
      // tout ignoré
      {
        ruleCode: "VR_A",
        severity: "Medium",
        domain: "Data Quality",
        count: 1,
        ignoredCount: 1
      }
    ];
    expect(scoreFromBreakdown(rules, SCORE_CONFIG)).toBe(64.5);
    expect(
      scoreFromBreakdown(rules, { ...SCORE_CONFIG, excludeIgnored: false })
    ).toBe(57.5);
    expect(scoreFromBreakdown(rules, { ...SCORE_CONFIG, caps: null })).toBe(
      49.5
    );
    expect(scoreFromBreakdown(rules, null)).toBeNull();
    expect(scoreFromBreakdown(rules, { domains: ["Apex"] })).toBe(100);
    expect(
      scoreFromBreakdown(
        [
          {
            severity: "Critical",
            domain: "Apex",
            count: 50,
            ignoredCount: 0
          }
        ],
        { ...SCORE_CONFIG, caps: {} }
      )
    ).toBe(0);
  });

  it("computes the health score from findings", () => {
    expect(computeHealthScore(sampleScan().findings, SCORE_CONFIG)).toBe(93);
  });

  it("picks the right source for the current score", () => {
    const scan = sampleScan();
    expect(currentScore(null, SCORE_CONFIG)).toBeNull();
    expect(currentScore(scan, null)).toBe(80);
    expect(currentScore({ id: "x" }, null)).toBeNull();
    expect(currentScore(scan, SCORE_CONFIG)).toBe(93);
    expect(
      currentScore(
        { ...scan, ignoredFingerprints: [scan.findings[0].fingerprint] },
        SCORE_CONFIG
      )
    ).toBe(98);
    expect(currentScore(scan, SCORE_CONFIG, [])).toBe(93);
    // Configuration enregistrée sur le scan
    expect(currentScore({ ...scan, scoreConfig: SCORE_CONFIG }, null)).toBe(93);
    // Résumé d'historique
    const summary = summarizeScan(scan);
    delete summary.findings;
    expect(currentScore(summary, SCORE_CONFIG)).toBe(93);
    // Constats perdus sans breakdown : score enregistré
    expect(currentScore({ ...scan, findingsMissing: true }, SCORE_CONFIG)).toBe(
      80
    );
  });
});

describe("résumés", () => {
  it("counts severities, domains, components and errors", () => {
    const findings = [
      finding(),
      finding({ severity: "Critical" }),
      finding({ severity: "Weird", ruleCode: "VR_A" })
    ];
    expect(severityCounts(findings)).toEqual({
      Critical: 1,
      High: 1,
      Medium: 0,
      Low: 0,
      Info: 0
    });
    expect(severityCountList(null)[0]).toEqual({
      severity: "Critical",
      count: 0
    });
    expect(domainCounts(findings)).toEqual({ Apex: 2, "Data Quality": 1 });
    expect(domainCounts(null)).toEqual({});
    expect(
      componentCounts([
        { componentType: "Flow" },
        { componentType: "ApexClass" },
        { componentType: "Flow" }
      ])
    ).toEqual([
      { componentType: "ApexClass", count: 1 },
      { componentType: "Flow", count: 2 }
    ]);
    expect(componentCounts(null)).toEqual([]);
    expect(errorCount([{ level: "error" }, { level: "info" }])).toBe(1);
    expect(errorCount(null)).toBe(0);
  });

  it("summarizes a full scan", () => {
    const summary = summarizeScan(
      sampleScan({
        storage: {
          dataUsedMb: 10,
          dataMaxMb: 100,
          fileUsedMb: 2,
          fileMaxMb: 50,
          snapshot: { big: true }
        }
      })
    );
    expect(summary).toMatchObject({
      id: "scan-2",
      componentCount: 2,
      findingCount: 2,
      collectionErrorCount: 1,
      toolingApiAvailable: true,
      progress: 100,
      currentStep: null,
      high: 1,
      medium: 1,
      inventoryKept: true,
      compacted: 0,
      failedSteps: [],
      recommendationsError: null,
      domainCounts: { Apex: 1, "Flows & Automation": 1 },
      storage: { dataUsedMb: 10, dataMaxMb: 100, fileUsedMb: 2, fileMaxMb: 50 }
    });
    expect(summary.storage.snapshot).toBeUndefined();
    expect(summary.breakdown).toHaveLength(2);
    expect(summarizeScan(null)).toBeNull();
  });

  it("summarizes a stored header without components nor findings", () => {
    const summary = summarizeScan({
      id: "h",
      componentTotal: 300,
      findingCount: 7,
      findingsMissing: true,
      findings: [],
      componentCounts: [{ componentType: "Flow", count: 300 }],
      domainCounts: { Apex: 7 },
      breakdown: [{ ruleCode: "APEX_A" }],
      progress: 40,
      currentStep: "Flows",
      inventoryKept: "partial",
      compacted: 2
    });
    expect(summary).toMatchObject({
      componentCount: 300,
      findingCount: 7,
      componentCounts: [{ componentType: "Flow", count: 300 }],
      domainCounts: { Apex: 7 },
      breakdown: [{ ruleCode: "APEX_A" }],
      progress: 40,
      currentStep: "Flows",
      inventoryKept: "partial",
      compacted: 2,
      storage: null
    });
    const bare = summarizeScan({ id: "b" });
    expect(bare.findingCount).toBe(0);
    expect(bare.breakdown).toBeNull();
    expect(bare.domainCounts).toEqual({});
  });
});

describe("constats et composants", () => {
  it("builds finding rows with recommendation links", () => {
    const scan = sampleScan({
      recommendationLinks: {
        "APEX_HARDCODED_ID|ApexClass|AccountHandler": {
          id: "rec-1",
          name: "REC-0001",
          status: "New"
        }
      }
    });
    scan.findings[0].isNew = true;
    const rows = findingRows(scan);
    expect(rows[0]).toMatchObject({
      id: "APEX_HARDCODED_ID|ApexClass|AccountHandler",
      name: "F-0001",
      affectedComponents: "AccountHandler",
      domain: "Apex",
      isNew: true,
      recommendationId: "rec-1",
      recommendationName: "REC-0001",
      recommendationStatus: "New"
    });
    expect(rows[1]).toMatchObject({
      name: "F-0002",
      isNew: false,
      recommendationId: null
    });
    expect(findingRows(null)).toEqual([]);
    expect(findingsWithPrefix(scan, ["FLOW_"]).map((r) => r.ruleCode)).toEqual([
      "FLOW_NO_FAULT"
    ]);
  });

  it("filters, sorts and pages components", () => {
    const scan = {
      components: [
        {
          key: "3",
          componentType: "Flow",
          apiName: "B_Flow"
        },
        {
          key: "1",
          componentType: "CustomField",
          apiName: "Siret__c",
          parentName: "Account",
          dependencies: { uses: ["a", "b"] }
        },
        { key: "2", componentType: "Flow", apiName: "A_Flow" }
      ]
    };
    const all = filterComponents(scan);
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(all.rows[0].dependencyCount).toBe(2);
    expect(all.rows[1].dependencyCount).toBeNull();
    expect(filterComponents(scan, "Flow").total).toBe(2);
    expect(filterComponents(scan, null, " account ").rows[0].id).toBe("1");
    expect(filterComponents(scan, null, "a_flow").total).toBe(1);
    const page = filterComponents(scan, null, "", 1);
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(filterComponents(null).total).toBe(0);
  });
});

describe("automation", () => {
  const components = [
    {
      key: "T",
      componentType: "ApexTrigger",
      apiName: "AccountTrigger",
      parentName: "Account",
      isActive: true,
      details: { events: ["BeforeInsert"] }
    },
    {
      key: "T2",
      componentType: "ApexTrigger",
      apiName: "CaseTrigger",
      parentName: "Case"
    },
    {
      key: "V",
      componentType: "ValidationRule",
      apiName: "Account.Siret_Required",
      parentName: "Account"
    },
    flowComponent("PB_Old", {
      details: { processType: "Workflow", triggerType: "RecordAfterSave" }
    }),
    flowComponent("Screen_Flow", {
      details: { triggerType: "Screen", activeVersionId: "301A" }
    }),
    flowComponent("Account_To_Contact", {
      parentName: "Account",
      details: {
        label: "Account to contact",
        analysedVersionId: "301B",
        modelOmitted: true,
        model: {
          triggerObject: "Account",
          timing: "After save",
          triggerEvent: "CreateAndUpdate",
          writes: [{ objectName: "Contact", operation: "Update" }]
        }
      }
    }),
    { key: "C", componentType: "ApexClass", apiName: "Ignored" }
  ];

  it("builds automations of each kind", () => {
    const automations = buildAutomations(components);
    // Tri localeCompare : la ponctuation passe après le « _ »
    expect(automations.map((a) => a.apiName)).toEqual([
      "Account_To_Contact",
      "Account.Siret_Required",
      "AccountTrigger",
      "CaseTrigger",
      "PB_Old",
      "Screen_Flow"
    ]);
    const byName = Object.fromEntries(automations.map((a) => [a.apiName, a]));
    expect(byName.AccountTrigger).toMatchObject({
      kind: "Apex trigger",
      timing: "Trigger",
      events: ["BeforeInsert"],
      objectName: "Account"
    });
    expect(byName.CaseTrigger.events).toEqual([]);
    expect(byName["Account.Siret_Required"]).toMatchObject({
      kind: "Validation rule",
      label: "Siret_Required",
      events: ["Create", "Update"]
    });
    expect(byName.PB_Old).toMatchObject({
      kind: "Process Builder",
      timing: "Process Builder"
    });
    expect(byName.Screen_Flow).toMatchObject({
      kind: "Flow",
      timing: "Screen",
      versionId: "301A",
      modelOmitted: false
    });
    expect(byName.Account_To_Contact).toMatchObject({
      kind: "Flow",
      timing: "After save",
      events: ["Create", "Update"],
      versionId: "301B",
      modelOmitted: true
    });
    expect(JSON.parse(byName.Account_To_Contact.modelJson).triggerObject).toBe(
      "Account"
    );
    expect(buildAutomations(null)).toEqual([]);
  });

  it("maps every trigger event", () => {
    const events = ["Create", "Update", "Delete", "Other"].map(
      (triggerEvent) =>
        buildAutomations([
          flowComponent("F", { details: { model: { triggerEvent } } })
        ])[0].events
    );
    expect(events).toEqual([["Create"], ["Update"], ["Delete"], []]);
  });

  it("finds cycles between objects", () => {
    const auto = (apiName, objectName, writes, isActive = true) => ({
      apiName,
      objectName,
      isActive,
      model: { writes }
    });
    const cycles = findCycles([
      auto("A_to_C", "Account", [
        { objectName: "Contact", operation: "Update" }
      ]),
      auto("C_to_A", "Contact", [
        { objectName: "Account", operation: "Update" },
        { objectName: "Contact", operation: "Update" },
        { objectName: "Case", operation: "Delete" },
        { operation: "Update" }
      ]),
      auto("C_to_A_bis", "Contact", [
        { objectName: "Account", operation: "Create" }
      ]),
      auto("Inactive", "Case", [{ objectName: "Account" }], false),
      { apiName: "NoModel", objectName: "Case", isActive: true }
    ]);
    expect(cycles).toEqual([
      {
        key: "Account>Contact",
        objects: ["Account", "Contact"],
        automations: ["A_to_C", "C_to_A", "C_to_A_bis"],
        label: "Account → Contact → Account"
      }
    ]);
    expect(findCycles(null)).toEqual([]);
  });

  it("finds a three-object cycle once", () => {
    const auto = (apiName, objectName, target) => ({
      apiName,
      objectName,
      isActive: true,
      model: { writes: [{ objectName: target, operation: "Update" }] }
    });
    const cycles = findCycles([
      auto("1", "A", "B"),
      auto("2", "B", "C"),
      auto("3", "C", "A")
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].label).toBe("A → B → C → A");
  });

  it("builds the automation view", () => {
    expect(buildAutomationView(null).automations).toEqual([]);
    expect(buildAutomationView({ scope: ["Apex"] }).scanId).toBeNull();
    const scan = sampleScan({
      components,
      findings: [
        finding({ ruleCode: "FLOW_A", severity: "Low" }),
        finding({ ruleCode: "TRIGGER_A", severity: "Critical" }),
        finding({ ruleCode: "APEX_A" })
      ]
    });
    const view = buildAutomationView(scan);
    expect(view.scanId).toBe("scan-2");
    expect(view.flowLogicAnalysed).toBe(true);
    expect(view.automations.some((a) => a.kind === "Validation rule")).toBe(
      false
    );
    expect(view.findings.map((f) => f.ruleCode)).toEqual([
      "TRIGGER_A",
      "FLOW_A"
    ]);
  });
});

describe("storage", () => {
  it("builds the storage view with trend and previous snapshot", () => {
    const history = [
      { id: "3", name: "S3", storage: { dataUsedMb: 30, fileUsedMb: 3 } },
      { id: "2", name: "S2", storage: null },
      { id: "1", name: "S1", storage: { dataUsedMb: 10, fileUsedMb: 1 } }
    ];
    const scan = sampleScan({
      storage: { snapshot: { objects: [] } },
      findings: [finding({ ruleCode: "STORAGE_DATA_HIGH" }), finding()]
    });
    const view = buildStorageView(
      scan,
      { scanName: "S1", snapshot: { objects: [1] } },
      history
    );
    expect(view.trend.map((t) => t.scanId)).toEqual(["1", "3"]);
    expect(view.snapshotJson).toBe('{"objects":[]}');
    expect(view.findings).toHaveLength(1);
    expect(view.previousScanName).toBe("S1");
    expect(view.previousSnapshotJson).toBe('{"objects":[1]}');

    const empty = buildStorageView(null, null, null);
    expect(empty).toMatchObject({
      scanId: null,
      snapshotJson: null,
      trend: [],
      findings: []
    });
  });
});

describe("recommandations et allègement", () => {
  it("turns a finding into a recommendation", () => {
    const rec = findingToRecommendation(
      finding(),
      { rationale: "Ids differ between orgs.", suggestedAction: "Use a CMDT." },
      "SCAN-0002",
      "2026-11-01T10:05:00Z"
    );
    expect(rec).toMatchObject({
      Fingerprint__c: "APEX_HARDCODED_ID|ApexClass|AccountHandler",
      Justification__c:
        "Ids differ between orgs.\n\nEvidence:\nLine 12: '001000000000001'",
      SuggestedAction__c: "Use a CMDT.",
      AffectedComponents__c: "AccountHandler",
      LastScanName__c: "SCAN-0002",
      StillDetected__c: true
    });
    const bare = findingToRecommendation(
      finding({ evidence: null, affectedComponents: null }),
      null,
      "S",
      "d"
    );
    expect(bare.Justification__c).toBeNull();
    expect(bare.SuggestedAction__c).toBeNull();
    expect(bare.AffectedComponents__c).toBe("AccountHandler");
    expect(
      findingToRecommendation(finding({ evidence: "E" }), null, "S", "d")
        .Justification__c
    ).toBe("Evidence:\nE");
  });

  it("slims components and compacts a scan", () => {
    const [apex, flow] = sampleScan().components;
    const slim = slimComponent(flow);
    expect(slim.details.model.nodes).toBeUndefined();
    expect(slim.details.model.timing).toBe("After save");
    expect(flow.details.model.nodes).toHaveLength(1);
    expect(slimComponent({ apiName: "X" }).details).toEqual({});

    const level1 = compactScan(sampleScan(), 1);
    expect(level1.compacted).toBe(1);
    expect(level1.components[1].details.model.nodes).toBeUndefined();
    expect(level1.components[0].dependencies).toEqual(apex.dependencies);
    const level2 = compactScan(sampleScan(), 2);
    expect(level2.components[0].details).toBeUndefined();
    expect(level2.components[0].dependencies).toBeUndefined();
    expect(compactScan({}, 2).components).toEqual([]);
  });
});

describe("importScan", () => {
  it("rejects a file that is not a scan", async () => {
    await expect(importScan(null)).rejects.toThrow(/does not contain/);
    await expect(importScan({ id: 1, findings: [] })).rejects.toThrow();
    await expect(importScan({ id: "x" })).rejects.toThrow();
  });

  it("makes the imported scan the latest when none exists", async () => {
    const result = await importScan(
      sampleScan({ status: undefined, components: undefined })
    );
    expect(result.madeLatest).toBe(true);
    expect(result.summary.status).toBe("Completed");
    expect(store.__data.get("scan.latest").id).toBe("scan-2");
    expect(await loadScanHistory()).toHaveLength(1);
    expect(await loadFindingSnapshots()).toHaveLength(1);
  });

  it("only adds an older scan to the history", async () => {
    await importScan(sampleScan());
    const older = sampleScan({
      id: "scan-1",
      startedAt: "2026-10-01T10:00:00Z",
      completedAt: "2026-10-01T10:05:00Z"
    });
    const result = await importScan(older);
    expect(result.madeLatest).toBe(false);
    expect(store.__data.get("scan.latest").id).toBe("scan-2");
    expect((await loadScanHistory()).map((s) => s.id)).toEqual([
      "scan-2",
      "scan-1"
    ]);
    // Réimport du même scan : pas de doublon
    await importScan(older, { makeLatest: false });
    expect(await loadScanHistory()).toHaveLength(2);
  });

  it("forces the latest scan, but only for a finished scan", async () => {
    await importScan(sampleScan());
    await importScan(
      sampleScan({ id: "scan-1", completedAt: "2026-10-01T00:00:00Z" }),
      { makeLatest: true }
    );
    expect(store.__data.get("scan.latest").id).toBe("scan-1");
    await expect(
      importScan(sampleScan({ id: "scan-9", status: "Failed" }), {
        makeLatest: true
      })
    ).rejects.toThrow(/finished scan/);
  });

  it("keeps a failed scan out of the snapshots", async () => {
    await importScan(sampleScan({ id: "failed", status: "Failed" }), {
      makeLatest: false
    });
    expect(await loadScanHistory()).toHaveLength(1);
    expect(await loadFindingSnapshots()).toEqual([]);
  });
});
