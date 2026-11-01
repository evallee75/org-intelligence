import { createElement } from "lwc";
import OrgIntelScanControl, {
  isScanFile,
  viewedScan,
  loadScoreContext
} from "c/orgIntelScanControl";
import getScannerState from "@salesforce/apex/OrgIntelligenceController.getScannerState";
import getRuleCatalog from "@salesforce/apex/OrgIntelligenceController.getRuleCatalog";
import {
  startScan,
  subscribe,
  isScanRunning,
  resumableScan,
  resumeScan,
  discardResumableScan
} from "c/orgIntelScanEngine";
import {
  importScan,
  loadLatestScan,
  loadLatestScanHeader,
  loadScanHistory
} from "c/orgIntelScanData";
import {
  recommendationsMode,
  loadLocalRecommendations
} from "c/orgIntelRecommendationStore";
import { downloadJson, loadValue, saveValue } from "c/orgIntelStore";

jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getScannerState",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getRuleCatalog",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

// Moteur de scan : les écouteurs sont gardés pour simuler la progression
const mockListeners = [];
jest.mock("c/orgIntelScanEngine", () => ({
  startScan: jest.fn(() => Promise.resolve()),
  subscribe: jest.fn((listener) => {
    mockListeners.push(listener);
    return () => {
      mockListeners.splice(mockListeners.indexOf(listener), 1);
    };
  }),
  isScanRunning: jest.fn(() => false),
  resumableScan: jest.fn(() => Promise.resolve(null)),
  resumeScan: jest.fn(() => Promise.resolve()),
  discardResumableScan: jest.fn(() => Promise.resolve())
}));
jest.mock("c/orgIntelScanData", () => ({
  importScan: jest.fn(() => Promise.resolve()),
  loadLatestScan: jest.fn(() => Promise.resolve(null)),
  loadLatestScanHeader: jest.fn(() => Promise.resolve(null)),
  loadScanHistory: jest.fn(() => Promise.resolve([]))
}));
jest.mock("c/orgIntelRecommendationStore", () => ({
  COLLABORATIVE_MODE: "collaborative",
  recommendationsMode: jest.fn(() => Promise.resolve("local")),
  loadLocalRecommendations: jest.fn(() => Promise.resolve({}))
}));
jest.mock("c/orgIntelStore", () => ({
  downloadJson: jest.fn(),
  loadValue: jest.fn(() => Promise.resolve(null)),
  saveValue: jest.fn(() => Promise.resolve()),
  readJsonEnvelope: jest.fn()
}));

const HISTORY = [
  {
    id: "scan-2",
    name: "SCAN-0002",
    status: "Completed",
    startedAt: "2026-10-30T10:00:00.000Z",
    findingCount: 12
  },
  {
    id: "scan-1",
    name: "SCAN-0001",
    status: "Failed",
    startedAt: "2026-10-29T10:00:00.000Z"
  }
];

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const query = (element, selector) => element.shadowRoot.querySelector(selector);
const buttonByLabel = (element, label) =>
  [...element.shadowRoot.querySelectorAll("lightning-button")].find(
    (button) => button.label === label
  );

async function render(props = {}) {
  const element = createElement("c-org-intel-scan-control", {
    is: OrgIntelScanControl
  });
  Object.assign(element, props);
  document.body.appendChild(element);
  await flushPromises();
  await flushPromises();
  return element;
}

describe("c-org-intel-scan-control", () => {
  beforeEach(() => {
    getScannerState.mockResolvedValue({
      canRunScan: true,
      tooling: { connected: false }
    });
    loadScanHistory.mockResolvedValue(HISTORY);
    loadLatestScanHeader.mockResolvedValue({ id: "scan-2" });
    loadValue.mockResolvedValue(null);
    resumableScan.mockResolvedValue(null);
    recommendationsMode.mockResolvedValue("local");
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    mockListeners.length = 0;
    jest.clearAllMocks();
  });

  it("offers the launcher and the recent scans to administrators", async () => {
    const element = await render({ showData: true });
    expect(query(element, '[data-id="new-scan"]')).not.toBeNull();
    expect(query(element, '[data-id="data-menu"]')).not.toBeNull();
    const items = element.shadowRoot.querySelectorAll("lightning-menu-item");
    // 2 scans + « All scans »
    expect(items).toHaveLength(3);
    expect(items[0].label).toContain("SCAN-0002 · Completed");
    expect(items[0].label).toContain("12 findings");
    expect(items[0].prefixIconName).toBe("utility:success");
    expect(items[1].prefixIconName).toBe("utility:error");
    expect(subscribe).toHaveBeenCalled();
  });

  it("hides the launcher without the scan permission", async () => {
    getScannerState.mockRejectedValue(new Error("no access"));
    const element = await render();
    expect(query(element, '[data-id="new-scan"]')).toBeNull();
  });

  it("does not ask the server for rights in read-only mode", async () => {
    const element = await render({ hideLauncher: true, hideHistory: true });
    expect(getScannerState).not.toHaveBeenCalled();
    expect(query(element, '[data-id="new-scan"]')).toBeNull();
    expect(query(element, "lightning-button-menu")).toBeNull();
  });

  it("opens the scope panel, remembers the choice and starts the scan", async () => {
    loadValue.mockResolvedValue(["ApexClass", "Flow", "Unknown"]);
    const element = await render();
    query(element, '[data-id="new-scan"]').click();
    await flushPromises();

    const checks = element.shadowRoot.querySelectorAll(".sc-scope-check");
    expect(checks).toHaveLength(7);
    expect(
      [...checks].filter((c) => c.checked).map((c) => c.dataset.value)
    ).toEqual(["ApexClass", "Flow"]);
    expect(element.shadowRoot.textContent).toContain("2 of 7 areas");
    // Tooling non connectée : les zones qui en dépendent sont signalées
    expect(element.shadowRoot.querySelectorAll(".sc-scope-tag")).toHaveLength(
      2
    );
    expect(element.shadowRoot.textContent).toContain(
      "Tooling API not connected"
    );

    const storage = [...checks].find((c) => c.dataset.value === "Storage");
    storage.checked = true;
    storage.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    expect(saveValue).toHaveBeenCalledWith("scan.scope", [
      "ApexClass",
      "Flow",
      "Storage"
    ]);

    const started = jest.fn();
    element.addEventListener("scanstarted", started);
    buttonByLabel(element, "Start scan").click();
    await flushPromises();
    expect(startScan).toHaveBeenCalledWith(["ApexClass", "Flow", "Storage"]);
    expect(started).toHaveBeenCalled();
    expect(query(element, ".sc-launch")).toBeNull();
  });

  it("toggles every area at once and disables the start without scope", async () => {
    const element = await render();
    element.openPanel();
    await flushPromises();
    const toggle = query(element, ".sc-panel-head .sc-link");
    expect(toggle.textContent.trim()).toBe("None");
    toggle.click();
    await flushPromises();
    expect(buttonByLabel(element, "Start scan").disabled).toBe(true);
    expect(toggle.textContent.trim()).toBe("All");
    toggle.click();
    await flushPromises();
    expect(element.shadowRoot.textContent).toContain("Everything");
    buttonByLabel(element, "Cancel").click();
    await flushPromises();
    expect(query(element, ".sc-launch")).toBeNull();
  });

  it("prefills the scope given by openPanel", async () => {
    const element = await render();
    element.openPanel(["Storage"]);
    await flushPromises();
    const checked = [
      ...element.shadowRoot.querySelectorAll(".sc-scope-check")
    ].filter((c) => c.checked);
    expect(checked.map((c) => c.dataset.value)).toEqual(["Storage"]);
  });

  it("explains that a scan requires the admin permission", async () => {
    getScannerState.mockResolvedValue({ canRunScan: false });
    const element = await render();
    element.openPanel();
    await flushPromises();
    expect(element.shadowRoot.textContent).toContain(
      "Org Intelligence - Admin"
    );
  });

  it("shows a toast when the scan cannot start", async () => {
    startScan.mockRejectedValueOnce({ body: { message: "Locked" } });
    const element = await render();
    const toast = jest.fn();
    element.addEventListener("lightning__showtoast", toast);
    element.openPanel();
    await flushPromises();
    buttonByLabel(element, "Start scan").click();
    await flushPromises();
    expect(toast).toHaveBeenCalled();
    expect(toast.mock.calls[0][0].detail.message).toBe("Locked");
  });

  it("announces the end of a scan followed through the engine", async () => {
    const element = await render();
    const finished = jest.fn();
    element.addEventListener("scanfinished", finished);
    mockListeners.forEach((listener) =>
      listener({ id: "scan-3", status: "Running" })
    );
    await flushPromises();
    expect(query(element, '[data-id="new-scan"]').disabled).toBe(true);
    mockListeners.forEach((listener) =>
      listener({ id: "scan-3", status: "Completed" })
    );
    await flushPromises();
    expect(finished.mock.calls[0][0].detail).toEqual({ scanId: "scan-3" });
  });

  it("navigates to a previous scan or to the whole history", async () => {
    const element = await render();
    const navigate = jest.fn();
    element.addEventListener("navigate", navigate);
    const menu = query(element, "lightning-button-menu");
    menu.dispatchEvent(
      new CustomEvent("select", { detail: { value: "scan-1" } })
    );
    menu.dispatchEvent(new CustomEvent("select", { detail: { value: "all" } }));
    expect(navigate.mock.calls[0][0].detail).toEqual({
      section: "scanner",
      scanId: "scan-1"
    });
    expect(navigate.mock.calls[1][0].detail.scanId).toBeNull();
  });

  it("resumes or discards an interrupted scan", async () => {
    resumableScan.mockResolvedValue({
      name: "SCAN-0003",
      progress: 42.4,
      currentStep: "Flows",
      savedAt: "2026-10-30T10:00:00.000Z"
    });
    const element = await render();
    const resume = query(element, '[data-id="resume"]');
    expect(resume.textContent).toContain("SCAN-0003 stopped at 42%");
    expect(resume.title).toContain('during "Flows"');

    const [resumeButton, discardButton] = resume.querySelectorAll("button");
    resumeButton.click();
    await flushPromises();
    expect(resumeScan).toHaveBeenCalled();
    expect(query(element, '[data-id="resume"]')).toBeNull();

    resumableScan.mockResolvedValue({ name: "SCAN-0003", progress: 10 });
    const second = await render();
    second.shadowRoot
      .querySelector('[data-id="resume"]')
      .querySelectorAll("button")[1]
      .click();
    await flushPromises();
    expect(discardResumableScan).toHaveBeenCalled();
    expect(discardButton).toBeDefined();
  });

  it("only informs when the interrupted scan runs in another tab", async () => {
    resumableScan.mockResolvedValue({
      name: "SCAN-0004",
      lockedByOtherTab: true
    });
    const element = await render();
    const resume = query(element, '[data-id="resume"]');
    expect(resume.textContent).toContain("running in another tab");
    expect(resume.querySelectorAll("button")).toHaveLength(0);
  });

  it("does not look for an interrupted scan while one is running", async () => {
    isScanRunning.mockReturnValue(true);
    const element = await render();
    expect(resumableScan).not.toHaveBeenCalled();
    expect(query(element, '[data-id="new-scan"]').disabled).toBe(true);
    isScanRunning.mockReturnValue(false);
  });

  it("saves the latest scan to a file", async () => {
    loadLatestScan.mockResolvedValue({ id: "scan-2", name: "SCAN-0002" });
    const element = await render({ showData: true });
    query(element, '[data-id="data-menu"]').dispatchEvent(
      new CustomEvent("save")
    );
    await flushPromises();
    expect(downloadJson).toHaveBeenCalledWith(
      "SCAN-0002.json",
      "scan",
      expect.objectContaining({ id: "scan-2" })
    );
  });

  it("opens a scan file in view-only mode or as the latest scan", async () => {
    const element = await render({ showData: true });
    const navigate = jest.fn();
    const finished = jest.fn();
    const toast = jest.fn();
    element.addEventListener("navigate", navigate);
    element.addEventListener("scanfinished", finished);
    element.addEventListener("lightning__showtoast", toast);
    const menu = query(element, '[data-id="data-menu"]');

    // Fichier sans scan : refusé
    menu.dispatchEvent(
      new CustomEvent("open", { detail: { data: { foo: 1 } } })
    );
    await flushPromises();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(query(element, ".sc-choice")).toBeNull();

    const fileScan = {
      id: "scan-old",
      name: "SCAN-OLD",
      startedAt: "2026-01-01T00:00:00.000Z",
      findings: [{ id: 1 }]
    };
    menu.dispatchEvent(
      new CustomEvent("open", {
        detail: {
          data: fileScan,
          fileName: "old.json",
          envelope: { sameOrg: false, orgName: "Acme", isSandbox: true }
        }
      })
    );
    await flushPromises();
    const choice = query(element, ".sc-choice");
    expect(choice.textContent).toContain("SCAN-OLD");
    expect(choice.textContent).toContain("comes from Acme (sandbox)");
    expect(choice.textContent).toContain("older than your latest scan");

    buttonByLabel(element, "View only").click();
    await flushPromises();
    expect(viewedScan("scan-old")).toBe(fileScan);
    expect(viewedScan("other")).toBeNull();
    expect(navigate.mock.calls[0][0].detail.scanId).toBe("scan-old");

    menu.dispatchEvent(new CustomEvent("open", { detail: { data: fileScan } }));
    await flushPromises();
    buttonByLabel(element, "Replace the latest scan").click();
    await flushPromises();
    await flushPromises();
    expect(importScan).toHaveBeenCalledWith(fileScan, { makeLatest: true });
    // Le scan consulté est remplacé par le scan gardé
    expect(viewedScan("scan-old")).toBeNull();
    expect(finished).toHaveBeenCalled();

    menu.dispatchEvent(new CustomEvent("open", { detail: { data: fileScan } }));
    await flushPromises();
    buttonByLabel(element, "Cancel").click();
    await flushPromises();
    expect(query(element, ".sc-choice")).toBeNull();

    menu.dispatchEvent(
      new CustomEvent("error", { detail: { message: "Bad JSON" } })
    );
    expect(toast.mock.calls.at(-1)[0].detail.message).toBe("Bad JSON");
  });
});

describe("scan control helpers", () => {
  afterEach(() => jest.clearAllMocks());

  it("recognises scan files", () => {
    expect(isScanFile(null)).toBe(false);
    expect(isScanFile({ id: "x" })).toBe(false);
    expect(isScanFile({ id: "x", findings: [] })).toBe(true);
  });

  it("loads the score preferences and the locally ignored recommendations", async () => {
    getRuleCatalog.mockResolvedValue(
      JSON.stringify({ scoreConfig: { preset: "Balanced" } })
    );
    loadLocalRecommendations.mockResolvedValue({
      a: { Status__c: "Ignored", Fingerprint__c: "F1" },
      b: { Status__c: "New", Fingerprint__c: "F2" }
    });
    expect(await loadScoreContext()).toEqual({
      scoreConfig: { preset: "Balanced" },
      ignoredFingerprints: ["F1"]
    });

    getRuleCatalog.mockRejectedValue(new Error("down"));
    recommendationsMode.mockResolvedValue("collaborative");
    expect(await loadScoreContext()).toEqual({
      scoreConfig: null,
      ignoredFingerprints: undefined
    });
  });
});
