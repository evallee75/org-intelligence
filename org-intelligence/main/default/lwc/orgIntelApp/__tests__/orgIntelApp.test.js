import { createElement } from "lwc";
import OrgIntelApp from "c/orgIntelApp";
import { CurrentPageReference } from "lightning/navigation";
import getModules from "@salesforce/apex/OrgIntelModuleController.getModules";
import { cancelScan } from "c/orgIntelScanEngine";
import { saveValue, loadValue } from "c/orgIntelStore";

jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getOverview",
  () => ({
    default: jest.fn(() =>
      Promise.resolve({ hasScans: false, canRunScan: false })
    )
  }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelModuleController.getModules",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

// Moteur de scan : les écouteurs sont gardés pour simuler la progression
const mockListeners = [];
jest.mock("c/orgIntelScanEngine", () => ({
  startScan: jest.fn(() => Promise.resolve()),
  cancelScan: jest.fn(),
  subscribe: jest.fn((listener) => {
    mockListeners.push(listener);
    return () => mockListeners.splice(mockListeners.indexOf(listener), 1);
  }),
  isScanRunning: jest.fn(() => false),
  resumableScan: jest.fn(() => Promise.resolve(null)),
  resumeScan: jest.fn(),
  discardResumableScan: jest.fn()
}));
jest.mock("c/orgIntelScanData", () => ({
  ...jest.requireActual("c/orgIntelScanData"),
  loadLatestScan: jest.fn(() => Promise.resolve(null)),
  loadLatestScanHeader: jest.fn(() => Promise.resolve(null)),
  loadScanHistory: jest.fn(() => Promise.resolve([]))
}));
jest.mock("c/orgIntelRecommendationStore", () => ({
  ...jest.requireActual("c/orgIntelRecommendationStore"),
  loadLocalRecommendations: jest.fn(() => Promise.resolve({})),
  recommendationsMode: jest.fn(() => Promise.resolve("local"))
}));
jest.mock("c/orgIntelStore", () => ({
  ...jest.requireActual("c/orgIntelStore"),
  loadValue: jest.fn(() => Promise.resolve(null)),
  saveValue: jest.fn(() => Promise.resolve())
}));

const PAGE = {
  type: "standard__navItemPage",
  attributes: { apiName: "Org_Intelligence" },
  state: {}
};
const ALL_MODULES = [
  "recommendations",
  "contextHub",
  "apiMonitoring",
  "fieldUsage",
  "adoption",
  "security",
  "inventory"
].map((key) => ({ key }));

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

async function render(state = {}) {
  const element = createElement("c-org-intel-app", { is: OrgIntelApp });
  document.body.appendChild(element);
  CurrentPageReference.emit({ ...PAGE, state });
  await flushPromises();
  await flushPromises();
  return element;
}

describe("c-org-intel-app", () => {
  beforeEach(() => {
    // Écran « Choose your modules » déjà vu dans ce navigateur
    window.localStorage.setItem("orgIntelligence.modulesSeen", "1");
    getModules.mockResolvedValue(ALL_MODULES);
    loadValue.mockResolvedValue(null);
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    window.localStorage.clear();
    mockListeners.length = 0;
    jest.clearAllMocks();
  });

  it("opens on the overview", async () => {
    const element = await render();
    expect(
      element.shadowRoot.querySelector("c-org-intel-overview")
    ).not.toBeNull();
    const current = element.shadowRoot.querySelector('a[aria-current="page"]');
    expect(current.dataset.section).toBe("overview");
  });

  it("opens the modules screen on the first launch of a new installation", async () => {
    window.localStorage.clear();
    getModules.mockResolvedValue([]);
    const element = await render();
    expect(
      element.shadowRoot.querySelector("c-org-intel-module-setup")
    ).not.toBeNull();
  });

  it("opens the section and the record given in the URL", async () => {
    const element = await render({
      c__section: "contextHub",
      c__recordId: "a02000000000001AAA"
    });
    expect(element.shadowRoot.querySelector("c-org-intel-overview")).toBeNull();
    const hub = element.shadowRoot.querySelector("c-org-intel-context-hub");
    expect(hub.recordId).toBe("a02000000000001AAA");
    expect(element.shadowRoot.querySelectorAll(".nav-soon")).toHaveLength(0);
  });

  it("explains how to get the section of a missing module", async () => {
    getModules.mockResolvedValue([]);
    const element = await render({ c__section: "contextHub" });
    const missing = element.shadowRoot.querySelector(
      '[data-id="module-missing"]'
    );
    expect(missing).not.toBeNull();
    expect(missing.message).toContain("from the Modules screen");
  });

  it("falls back to the overview for an unknown section", async () => {
    const element = await render({ c__section: "nope" });
    expect(
      element.shadowRoot.querySelector("c-org-intel-overview")
    ).not.toBeNull();
  });

  it("switches section from the navigation", async () => {
    const element = await render();
    element.shadowRoot.querySelector('a[data-section="settings"]').click();
    await flushPromises();
    expect(
      element.shadowRoot.querySelector("c-org-intel-settings")
    ).not.toBeNull();
  });

  it("hides sections from the menu and remembers the choice", async () => {
    const element = await render();
    const before = element.shadowRoot.querySelectorAll("a.nav-link").length;
    const customize = [
      ...element.shadowRoot.querySelectorAll("button, lightning-button")
    ].find((button) =>
      (button.label || button.textContent || "").includes("Customize menu")
    );
    customize.click();
    await flushPromises();
    const toggle = element.shadowRoot.querySelector(
      '[data-section="reports"]:not(a)'
    );
    toggle.click();
    await flushPromises();
    expect(saveValue).toHaveBeenCalledWith("app.hiddenSections", ["reports"]);
    customize.click();
    await flushPromises();
    expect(element.shadowRoot.querySelectorAll("a.nav-link")).toHaveLength(
      before - 1
    );
  });

  it("follows the running scan in the header and announces its end", async () => {
    const element = await render();
    const toast = jest.fn();
    element.addEventListener("lightning__showtoast", toast);
    mockListeners.forEach((listener) =>
      listener({
        id: "scan-1",
        name: "SCAN-0001",
        status: "Running",
        progress: 41.6,
        currentStep: "Flows"
      })
    );
    await flushPromises();
    const progress = element.shadowRoot.querySelector(
      '[data-id="scan-progress"]'
    );
    expect(progress.textContent).toContain("SCAN-0001 · 42% · Flows");

    const stop = [
      ...progress.querySelectorAll("button, lightning-button")
    ].find((button) => (button.label || button.textContent).includes("Stop"));
    stop.click();
    expect(cancelScan).toHaveBeenCalled();

    mockListeners.forEach((listener) =>
      listener({
        id: "scan-1",
        name: "SCAN-0001",
        status: "Completed",
        findingCount: 12,
        healthScore: 80
      })
    );
    await flushPromises();
    expect(
      element.shadowRoot.querySelector('[data-id="scan-progress"]')
    ).toBeNull();
    const detail = toast.mock.calls[0][0].detail;
    expect(detail.variant).toBe("success");
    expect(detail.message).toContain("12 findings, health score 80");
  });

  it("reports a failed scan as an error", async () => {
    const element = await render();
    const toast = jest.fn();
    element.addEventListener("lightning__showtoast", toast);
    mockListeners.forEach((listener) =>
      listener({ name: "SCAN-0002", status: "Running" })
    );
    mockListeners.forEach((listener) =>
      listener({
        name: "SCAN-0002",
        status: "Failed",
        error: "Session expired.",
        resumable: true
      })
    );
    await flushPromises();
    const detail = toast.mock.calls[0][0].detail;
    expect(detail.title).toBe("SCAN-0002 stopped");
    expect(detail.variant).toBe("error");
    expect(detail.message).toContain("You can resume it");
  });

  it("switches the theme", async () => {
    const element = await render();
    element.shadowRoot.querySelector('[data-value="dark"]').click();
    await flushPromises();
    expect(window.localStorage.getItem("orgIntelligence.theme")).toBe("dark");
    expect(element.shadowRoot.querySelector(".theme-dark")).not.toBeNull();
  });
});
