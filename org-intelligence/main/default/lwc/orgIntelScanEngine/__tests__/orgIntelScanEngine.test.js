// Tests du moteur de scan : Apex, stockage du navigateur, recommandations et données de scan
// sont simulés ; le moteur garde un état de module, chaque test termine donc son scan.
import startScanApex from "@salesforce/apex/OrgIntelligenceController.startScan";
import runScanStepApex from "@salesforce/apex/OrgIntelligenceController.runScanStep";
import {
  saveValue,
  loadValue,
  removeValue,
  pushHistory
} from "c/orgIntelStore";
import {
  updateLocalRecommendations,
  mergeRecommendations,
  markNotDetected
} from "c/orgIntelRecommendationStore";
import { callModule, loadInstalledModulesStrict } from "c/orgIntelModuleApi";
import {
  saveLatestScan,
  saveFailedScan,
  loadFindingSnapshots,
  loadLatestScan,
  loadLatestScanHeader,
  addFindingSnapshot,
  markNewFindings,
  findingSnapshot,
  computeHealthScore
} from "c/orgIntelScanData";
import {
  subscribe,
  currentRun,
  isScanRunning,
  startScan,
  cancelScan,
  resumableScan,
  resumeScan,
  discardResumableScan
} from "c/orgIntelScanEngine";

jest.mock(
  "@salesforce/apex/OrgIntelligenceController.startScan",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelligenceController.runScanStep",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

// Stockage en mémoire (IndexedDB absent de jsdom)
const mockStore = new Map();
jest.mock("c/orgIntelStore", () => ({
  STORE_KEYS: { SCAN_HISTORY: "scan.history" },
  saveValue: jest.fn((key, value) => {
    mockStore.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }),
  loadValue: jest.fn((key, fallback) =>
    Promise.resolve(mockStore.has(key) ? mockStore.get(key) : fallback)
  ),
  removeValue: jest.fn((key) => {
    mockStore.delete(key);
    return Promise.resolve();
  }),
  pushHistory: jest.fn(() => Promise.resolve())
}));

jest.mock("c/orgIntelRecommendationStore", () => ({
  updateLocalRecommendations: jest.fn(),
  mergeRecommendations: jest.fn(() => ({ created: 1, updated: 0 })),
  markNotDetected: jest.fn(() => 2)
}));

jest.mock("c/orgIntelModuleApi", () => ({
  MODULES: { RECOMMENDATIONS: "recommendations" },
  callModule: jest.fn(),
  loadInstalledModulesStrict: jest.fn(() => Promise.resolve([]))
}));

jest.mock("c/orgIntelScanData", () => ({
  HISTORY_MAX: 30,
  PREVIOUS_FINDINGS_KEY: "scan.previousFindings",
  PREVIOUS_STORAGE_KEY: "scan.previousStorage",
  computeHealthScore: jest.fn(() => 88),
  summarizeScan: jest.fn((scan) => ({
    id: scan.id,
    name: scan.name,
    status: scan.status,
    healthScore: scan.healthScore,
    findingCount: scan.findings.length,
    componentCount: scan.components.length,
    recommendationsError: scan.recommendationsError
  })),
  findingToRecommendation: jest.fn((finding) => ({
    fingerprint: finding.fingerprint
  })),
  slimComponent: jest.fn((component) => ({
    componentType: component.componentType,
    apiName: component.apiName
  })),
  errorCount: jest.fn(
    (log) => (log || []).filter((entry) => entry.level === "error").length
  ),
  saveLatestScan: jest.fn(() => Promise.resolve()),
  saveFailedScan: jest.fn(() => Promise.resolve()),
  loadLatestScan: jest.fn(() => Promise.resolve(null)),
  loadLatestScanHeader: jest.fn(() => Promise.resolve(null)),
  loadFindingSnapshots: jest.fn(() => Promise.resolve([])),
  addFindingSnapshot: jest.fn(() => Promise.resolve()),
  findingSnapshot: jest.fn(() => ({ fingerprints: [] })),
  markNewFindings: jest.fn(),
  isFinished: jest.fn((status) => /^Completed/.test(status || ""))
}));

const RESUME_KEY = "scan.resume";
const LOCK_KEY = "scan.lock";

function started(steps, extra = {}) {
  return JSON.stringify({
    scope: ["apex", "flows"],
    scoreConfig: { preset: "Balanced" },
    rules: [{ code: "APEX_A" }, { code: "FLOW_B" }],
    inventoryNeeds: {},
    stepLabels: { APEX_CLASSES: "Apex classes", FLOW_ANALYSIS: "Flows" },
    state: { steps, stepIndex: 0, cursor: null },
    ...extra
  });
}

function stepResult(state, extra = {}) {
  return JSON.stringify({ state, ...extra });
}

const component = (key, componentType, details = {}) => ({
  key,
  componentType,
  apiName: key,
  details
});
const finding = (fingerprint, ruleCode) => ({ fingerprint, ruleCode });

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  loadInstalledModulesStrict.mockResolvedValue([]);
  updateLocalRecommendations.mockImplementation(async (mutate) => {
    const byFingerprint = {
      f1: { Id: "r1", Name: "REC-1", Status__c: "Ignored" },
      f2: { Id: "r2", Name: "REC-2", Status__c: "New" }
    };
    const result = mutate(byFingerprint);
    return result;
  });
});

describe("c-org-intel-scan-engine", () => {
  it("runs every step, keeps components and findings, and saves the scan locally", async () => {
    startScanApex.mockResolvedValue(
      started(["APEX_CLASSES", "FLOW_ANALYSIS"], {
        inventoryNeeds: { FLOW_ANALYSIS: ["Flow"] }
      })
    );
    runScanStepApex
      .mockResolvedValueOnce(
        stepResult(
          { steps: ["APEX_CLASSES", "FLOW_ANALYSIS"], stepIndex: 0, cursor: 2 },
          {
            total: 4,
            components: [component("A", "ApexClass")],
            findings: [finding("f1", "APEX_A")],
            log: [{ step: "Apex", level: "info", message: "page 1" }]
          }
        )
      )
      .mockResolvedValueOnce(
        stepResult(
          {
            steps: ["APEX_CLASSES", "FLOW_ANALYSIS"],
            stepIndex: 1,
            cursor: null,
            toolingAvailable: true
          },
          {
            components: [
              component("F", "Flow", { activeVersionId: "301A" }),
              component("A", "ApexClass", { lines: 10 })
            ],
            findings: [finding("f1", "APEX_A"), finding("f2", "APEX_A")],
            detailUpdates: { A: { coverage: 80 }, MISSING: { x: 1 } },
            dependencyUpdates: { A: ["F"], MISSING: [] },
            scanValues: { storage: { snapshot: { used: 1 } } },
            reliableRules: ["APEX_A"]
          }
        )
      )
      .mockResolvedValueOnce(
        stepResult({
          steps: ["APEX_CLASSES", "FLOW_ANALYSIS"],
          stepIndex: 2,
          evaluatedRules: ["APEX_A", "FLOW_B"],
          toolingAvailable: true
        })
      );
    loadLatestScanHeader.mockResolvedValue({
      id: "old",
      name: "SCAN-OLD",
      completedAt: "2026-10-01T00:00:00Z",
      storage: { snapshot: { used: 0 } }
    });
    const states = [];
    const unsubscribe = subscribe((state) => states.push(state));

    const scan = await startScan(["apex", "flows"]);
    unsubscribe();

    expect(scan.status).toBe("Completed");
    expect(scan.healthScore).toBe(88);
    expect(scan.components.map((c) => c.key).sort()).toEqual(["A", "F"]);
    expect(scan.components.find((c) => c.key === "A").details).toEqual({
      lines: 10,
      coverage: 80
    });
    expect(scan.components.find((c) => c.key === "A").dependencies).toEqual([
      "F"
    ]);
    expect(scan.findings.map((f) => f.fingerprint)).toEqual(["f1", "f2"]);
    expect(scan.storage).toEqual({ snapshot: { used: 1 } });
    expect(scan.toolingAvailable).toBe(true);
    expect(scan.evaluatedRules).toEqual(["APEX_A", "FLOW_B"]);
    // Inventaire du Flow Analysis : seules les versions sont envoyées
    const flowCall = JSON.parse(runScanStepApex.mock.calls[2][0].inventoryJson);
    expect(flowCall).toEqual([
      {
        componentType: "Flow",
        apiName: "F",
        parentName: undefined,
        isActive: undefined,
        details: { activeVersionId: "301A", latestVersionId: null }
      }
    ]);
    expect(runScanStepApex.mock.calls[0][0].inventoryJson).toBeNull();
    // Recommandations locales : la recommandation ignorée est exclue du score
    expect(mergeRecommendations).toHaveBeenCalled();
    expect(markNotDetected).toHaveBeenCalledWith(
      expect.any(Object),
      ["APEX_A"],
      ["f1", "f2"]
    );
    expect(scan.recommendationLinks.f1).toEqual({
      id: "r1",
      name: "REC-1",
      status: "Ignored"
    });
    expect(scan.ignoredFingerprints).toEqual(["f1"]);
    expect(computeHealthScore).toHaveBeenCalledWith(
      scan.findings,
      { preset: "Balanced" },
      ["f1"]
    );
    expect(markNewFindings).toHaveBeenCalled();
    expect(saveValue).toHaveBeenCalledWith(
      "scan.previousStorage",
      expect.objectContaining({ scanId: "old" })
    );
    expect(addFindingSnapshot).toHaveBeenCalledWith(scan);
    expect(saveLatestScan).toHaveBeenCalledWith(scan);
    expect(pushHistory).toHaveBeenCalled();
    // Progression publiée puis état final
    expect(states[0]).toBeNull();
    expect(states.some((s) => s && s.currentStep === "Apex classes")).toBe(
      true
    );
    expect(states.some((s) => s && s.stepPage === 2)).toBe(true);
    const last = currentRun();
    expect(last.progress).toBe(100);
    expect(last.canCancel).toBe(false);
    expect(isScanRunning()).toBe(false);
    // Verrou libéré, reprise supprimée
    expect(mockStore.has(LOCK_KEY)).toBe(false);
    expect(mockStore.has(RESUME_KEY)).toBe(false);
  });

  it("sends a slim inventory to the coverage step and other steps", async () => {
    startScanApex.mockResolvedValue(
      started(["APEX_CLASSES", "APEX_COVERAGE", "CROSS"], {
        inventoryNeeds: { APEX_COVERAGE: ["ApexClass"], CROSS: ["ApexClass"] }
      })
    );
    const steps = ["APEX_CLASSES", "APEX_COVERAGE", "CROSS"];
    runScanStepApex
      .mockResolvedValueOnce(
        stepResult(
          { steps, stepIndex: 1 },
          {
            components: [
              component("T", "ApexClass", { isTest: true }),
              component("C", "ApexClass")
            ]
          }
        )
      )
      .mockResolvedValueOnce(stepResult({ steps, stepIndex: 2 }))
      .mockResolvedValueOnce(stepResult({ steps, stepIndex: 3 }));

    await startScan(["apex"]);

    expect(JSON.parse(runScanStepApex.mock.calls[1][0].inventoryJson)).toEqual([
      { componentType: "ApexClass", apiName: "T", details: { isTest: true } },
      { componentType: "ApexClass", apiName: "C", details: { isTest: false } }
    ]);
    expect(JSON.parse(runScanStepApex.mock.calls[2][0].inventoryJson)).toEqual([
      { componentType: "ApexClass", apiName: "T" },
      { componentType: "ApexClass", apiName: "C" }
    ]);
  });

  it("refuses a second scan in the same tab", async () => {
    startScanApex.mockResolvedValue(started(["S"]));
    let release;
    runScanStepApex.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve(stepResult({ steps: ["S"], stepIndex: 1 }));
      })
    );
    const first = startScan([]);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(isScanRunning()).toBe(true);
    await expect(startScan([])).rejects.toThrow("already running");
    await expect(resumeScan()).rejects.toThrow("already running");
    release();
    await first;
  });

  it("refuses to start while another tab holds a fresh lock", async () => {
    mockStore.set(LOCK_KEY, {
      tabId: "other-tab",
      scanId: "x",
      heartbeat: new Date().toISOString()
    });
    await expect(startScan([])).rejects.toThrow("another tab");
    expect(currentRun()).toBeNull();
    expect(startScanApex).not.toHaveBeenCalled();
  });

  it("gives up when another tab takes the lock at the same time", async () => {
    saveValue.mockImplementationOnce((key) => {
      // un autre onglet écrit juste après nous
      mockStore.set(key, {
        tabId: "other-tab",
        heartbeat: new Date().toISOString()
      });
      return Promise.resolve();
    });
    await expect(startScan([])).rejects.toThrow("at the same time");
  });

  it("still scans when the lock cannot be stored", async () => {
    loadValue.mockRejectedValueOnce(new Error("quota"));
    startScanApex.mockResolvedValue(started(["S"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult({ steps: ["S"], stepIndex: 1 })
    );
    const scan = await startScan([]);
    expect(scan.status).toBe("Completed");
  });

  it("publishes a failure when the scan cannot start", async () => {
    startScanApex.mockRejectedValue({ body: { message: "No access" } });
    await expect(startScan([])).rejects.toBeTruthy();
    expect(currentRun()).toEqual(
      expect.objectContaining({ status: "Failed", error: "No access" })
    );
    expect(mockStore.has(LOCK_KEY)).toBe(false);
  });

  it("marks a step as failed after one platform error and drops its findings", async () => {
    const steps = ["APEX_CLASSES", "FLOW_ANALYSIS"];
    startScanApex.mockResolvedValue(started(steps));
    runScanStepApex
      .mockResolvedValueOnce(
        stepResult(
          { steps, stepIndex: 0, cursor: 5 },
          { findings: [finding("f1", "APEX_A"), finding("f3", "FLOW_B")] }
        )
      )
      .mockRejectedValueOnce({ body: { message: "Apex CPU time limit" } })
      .mockResolvedValueOnce(
        stepResult({
          steps,
          stepIndex: 2,
          failedSteps: ["APEX_CLASSES"],
          evaluatedRules: ["APEX_A", "FLOW_B"],
          ruleSteps: { APEX_A: "APEX_CLASSES", FLOW_B: "FLOW_ANALYSIS" }
        })
      );

    const scan = await startScan([]);

    expect(scan.status).toBe("Completed with errors");
    expect(scan.findings.map((f) => f.fingerprint)).toEqual(["f3"]);
    expect(scan.reliableRules).toEqual(["FLOW_B"]);
    expect(scan.failedSteps).toEqual(["APEX_CLASSES"]);
    // l'état renvoyé au serveur porte l'étape en échec
    const sent = JSON.parse(runScanStepApex.mock.calls[2][0].stateJson);
    expect(sent.failedSteps).toEqual(["APEX_CLASSES"]);
    expect(sent.stepIndex).toBe(1);
    expect(sent.cursor).toBeNull();
    expect(
      scan.log.some((entry) => /findings from failed steps/.test(entry.message))
    ).toBe(true);
  });

  it("stops after two failures in a row and keeps a resumable checkpoint", async () => {
    const steps = ["A", "B", "C"];
    startScanApex.mockResolvedValue(started(steps));
    runScanStepApex
      .mockResolvedValueOnce(
        stepResult(
          { steps, stepIndex: 1 },
          { components: [component("X", "ApexClass")] }
        )
      )
      .mockRejectedValueOnce({ body: { message: "boom" } })
      .mockRejectedValueOnce({ body: { message: "boom again" } });

    await expect(startScan([])).rejects.toThrow("2 scan calls failed");

    const run = currentRun();
    expect(run.status).toBe("Failed");
    expect(run.resumable).toBe(true);
    expect(run.cancelled).toBe(false);
    expect(saveFailedScan).toHaveBeenCalled();
    expect(saveLatestScan).not.toHaveBeenCalled();
    expect(mockStore.get(RESUME_KEY).final).toBe(true);

    const resumable = await resumableScan();
    expect(resumable).toEqual(
      expect.objectContaining({ id: run.id, lockedByOtherTab: false })
    );
  });

  it("stops on a lost connection and resumes from the checkpoint", async () => {
    const steps = ["A", "B"];
    startScanApex.mockResolvedValue(started(steps));
    runScanStepApex
      .mockResolvedValueOnce(
        stepResult(
          { steps, stepIndex: 1 },
          {
            components: [component("X", "ApexClass")],
            findings: [finding("f2", "APEX_A")]
          }
        )
      )
      .mockRejectedValueOnce({ status: 401, body: { message: "Session" } });

    await expect(startScan([])).rejects.toThrow("connection to Salesforce");
    const saved = mockStore.get(RESUME_KEY);
    expect(saved.calls).toBe(1);

    // un autre onglet tient le verrou : la reprise est signalée comme bloquée
    mockStore.set(LOCK_KEY, {
      tabId: "other-tab",
      heartbeat: new Date().toISOString()
    });
    expect((await resumableScan()).lockedByOtherTab).toBe(true);
    mockStore.delete(LOCK_KEY);

    runScanStepApex.mockResolvedValueOnce(
      stepResult(
        { steps, stepIndex: 2 },
        { findings: [finding("f2", "APEX_A")] }
      )
    );
    const seen = [];
    const off = subscribe((state) => seen.push(state));
    const scan = await resumeScan();
    off();
    expect(
      seen.some((s) => s && s.resumed && s.currentStep === "Resuming")
    ).toBe(true);
    expect(scan.status).toBe("Completed");
    expect(scan.components.map((c) => c.key)).toEqual(["X"]);
    expect(scan.findings).toHaveLength(1);
    expect(scan.log.some((e) => /resumed/.test(e.message))).toBe(true);
    expect(mockStore.has(RESUME_KEY)).toBe(false);
  });

  it("treats network messages as connection errors", async () => {
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockRejectedValueOnce(new Error("Failed to fetch"));
    await expect(startScan([])).rejects.toThrow("connection");
    expect(currentRun().resumable).toBe(true);
    await discardResumableScan();
  });

  it("cannot resume without a saved scan, and discards unreadable progress", async () => {
    expect(await resumableScan()).toBeNull();
    await expect(resumeScan()).rejects.toThrow("no interrupted scan");
    mockStore.set(RESUME_KEY, { scan: { id: "s" }, state: { steps: [] } });
    await expect(resumeScan()).rejects.toThrow("could not be read");
    expect(mockStore.has(RESUME_KEY)).toBe(false);
  });

  it("does not resume while another tab holds the lock", async () => {
    mockStore.set(RESUME_KEY, {
      scan: { id: "s", name: "SCAN", log: [], findings: [] },
      state: { steps: ["A"], stepIndex: 0 }
    });
    mockStore.set("scan.resume.findings", []);
    mockStore.set("scan.resume.components", []);
    mockStore.set(LOCK_KEY, {
      tabId: "other-tab",
      heartbeat: new Date().toISOString()
    });
    await expect(resumeScan()).rejects.toThrow("another tab");
    expect(currentRun()).toBeNull();
  });

  it("stops when the user cancels", async () => {
    const steps = ["A", "B"];
    startScanApex.mockResolvedValue(started(steps));
    runScanStepApex.mockImplementationOnce(async () => {
      cancelScan();
      return stepResult({ steps, stepIndex: 1 });
    });
    await expect(startScan([])).rejects.toThrow("cancelled");
    const run = currentRun();
    expect(run.cancelled).toBe(true);
    expect(run.resumable).toBe(false);
    expect(mockStore.has(RESUME_KEY)).toBe(false);
  });

  it("stops when the user cancels during the comparison phase", async () => {
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult({ steps: ["A"], stepIndex: 1 })
    );
    loadFindingSnapshots.mockImplementationOnce(async () => {
      cancelScan();
      return [];
    });
    await expect(startScan([])).rejects.toThrow("cancelled");
  });

  it("ignores cancel requests during the final phase", async () => {
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult({ steps: ["A"], stepIndex: 1 })
    );
    loadInstalledModulesStrict.mockImplementationOnce(async () => {
      cancelScan();
      return [];
    });
    const scan = await startScan([]);
    expect(scan.status).toBe("Completed");
  });

  it("uses the latest finished scan, then the previous findings, as the reference", async () => {
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValue(
      stepResult({ steps: ["A"], stepIndex: 1 })
    );
    loadLatestScan.mockResolvedValueOnce({
      status: "Completed",
      findings: []
    });
    await startScan([]);
    expect(findingSnapshot).toHaveBeenCalled();
    expect(markNewFindings).toHaveBeenLastCalledWith([], { fingerprints: [] });

    mockStore.set("scan.previousFindings", { fingerprints: ["old"] });
    await startScan([]);
    expect(markNewFindings).toHaveBeenLastCalledWith([], {
      fingerprints: ["old"]
    });

    loadFindingSnapshots.mockRejectedValueOnce(new Error("broken"));
    await startScan([]);
    expect(markNewFindings).toHaveBeenLastCalledWith([], null);
  });

  it("sends findings to the shared recommendations module by batches", async () => {
    loadInstalledModulesStrict.mockResolvedValue(["recommendations"]);
    const many = Array.from({ length: 501 }, (_, i) =>
      finding(`fp${i}`, "APEX_A")
    );
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult(
        { steps: ["A"], stepIndex: 1, evaluatedRules: ["APEX_A"] },
        { findings: many, reliableRules: ["APEX_A"] }
      )
    );
    callModule
      .mockResolvedValueOnce({
        created: 500,
        links: { fp0: { id: "r0", status: "Ignored" } }
      })
      .mockResolvedValueOnce({ updated: 1, notDetected: 3 });

    const scan = await startScan([]);

    expect(callModule).toHaveBeenCalledTimes(2);
    expect(callModule.mock.calls[0][2].findings).toHaveLength(500);
    expect(callModule.mock.calls[0][2].reliableRules).toEqual([]);
    expect(callModule.mock.calls[1][2].reliableRules).toEqual(["APEX_A"]);
    expect(scan.ignoredFingerprints).toEqual(["fp0"]);
    expect(
      scan.log.some((e) =>
        /500 created, 1 updated, 3 no longer detected \(2 batches\)/.test(
          e.message
        )
      )
    ).toBe(true);
    expect(updateLocalRecommendations).not.toHaveBeenCalled();
  });

  it("calls the shared module once even without findings", async () => {
    loadInstalledModulesStrict.mockResolvedValue(["recommendations"]);
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult({ steps: ["A"], stepIndex: 1 })
    );
    callModule.mockResolvedValueOnce(null);
    const scan = await startScan([]);
    expect(callModule).toHaveBeenCalledTimes(1);
    expect(scan.recommendationLinks).toEqual({});
  });

  it("exposes a recommendations failure without failing the scan", async () => {
    loadInstalledModulesStrict.mockRejectedValue(new Error("offline"));
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult({ steps: ["A"], stepIndex: 1 })
    );
    const scan = await startScan([]);
    expect(scan.recommendationsError).toBe("offline");
    expect(scan.status).toBe("Completed with errors");
  });

  it("logs non-blocking storage failures at the end of the scan", async () => {
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult(
        { steps: ["A"], stepIndex: 1 },
        { scanValues: { storage: { snapshot: {} } } }
      )
    );
    loadLatestScanHeader.mockRejectedValueOnce(new Error("h"));
    addFindingSnapshot.mockRejectedValueOnce(new Error("s"));
    pushHistory.mockRejectedValueOnce(new Error("p"));
    const scan = await startScan([]);
    const messages = scan.log.map((e) => e.message).join("\n");
    expect(messages).toMatch(/previous storage snapshot was not kept: h/);
    expect(messages).toMatch(/comparison history: s/);
    expect(messages).toMatch(/history was not updated: p/);
  });

  it("disables resuming when the progress cannot be saved", async () => {
    const steps = ["A", "B", "C"];
    startScanApex.mockResolvedValue(started(steps));
    saveValue.mockImplementation((key, value) => {
      if (key.startsWith("scan.resume")) {
        return Promise.reject(new Error("quota exceeded"));
      }
      mockStore.set(key, value);
      return Promise.resolve();
    });
    runScanStepApex
      .mockResolvedValueOnce(stepResult({ steps, stepIndex: 1 }))
      .mockRejectedValueOnce({ status: 0, body: { message: "x" } });
    await expect(startScan([])).rejects.toThrow("connection");
    const run = currentRun();
    expect(run.resumable).toBe(false);
    saveValue.mockImplementation((key, value) => {
      mockStore.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    });
  });

  it("stops a scan that never ends", async () => {
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockImplementation(async ({ stateJson }) => {
      const state = JSON.parse(stateJson);
      return stepResult({ ...state, cursor: (state.cursor || 0) + 1 });
    });
    await expect(startScan([])).rejects.toThrow("Too many scan steps");
    expect(runScanStepApex).toHaveBeenCalledTimes(400);
    runScanStepApex.mockReset();
  });

  it("keeps notifying other listeners when one throws", async () => {
    const good = jest.fn();
    const off1 = subscribe((state) => {
      if (state && state.status === "Running") {
        throw new Error("destroyed");
      }
    });
    const off2 = subscribe(good);
    startScanApex.mockResolvedValue(started(["A"]));
    runScanStepApex.mockResolvedValueOnce(
      stepResult({ steps: ["A"], stepIndex: 1 })
    );
    await startScan([]);
    off1();
    off2();
    expect(good.mock.calls.length).toBeGreaterThan(2);
    expect(removeValue).toHaveBeenCalledWith(LOCK_KEY);
  });
});
