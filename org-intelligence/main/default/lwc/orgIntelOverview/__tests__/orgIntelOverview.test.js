import { createElement } from "lwc";
import OrgIntelOverview from "c/orgIntelOverview";
import getOverview from "@salesforce/apex/OrgIntelligenceController.getOverview";
import invoke from "@salesforce/apex/OrgIntelModuleController.invoke";
import { loadLatestScan, loadScanHistory } from "c/orgIntelScanData";
import { loadLocalRecommendations } from "c/orgIntelRecommendationStore";
import { exportRows } from "c/orgIntelUtils";

jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getOverview",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getScannerState",
  () => ({ default: jest.fn(() => Promise.resolve({ canRunScan: true })) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelModuleController.invoke",
  () => ({ default: jest.fn() }),
  { virtual: true }
);

// Moteur de scan : les écouteurs sont gardés pour simuler la fin d'un scan
const mockListeners = [];
jest.mock("c/orgIntelScanEngine", () => ({
  startScan: jest.fn(() => Promise.resolve()),
  subscribe: jest.fn((listener) => {
    mockListeners.push(listener);
    return () => mockListeners.splice(mockListeners.indexOf(listener), 1);
  }),
  isScanRunning: jest.fn(() => false),
  resumableScan: jest.fn(() => Promise.resolve(null)),
  resumeScan: jest.fn(),
  discardResumableScan: jest.fn()
}));
// Scans et recommandations du navigateur : lecture simulée, calculs réels
jest.mock("c/orgIntelScanData", () => ({
  ...jest.requireActual("c/orgIntelScanData"),
  loadLatestScan: jest.fn(),
  loadLatestScanHeader: jest.fn(() => Promise.resolve(null)),
  loadScanHistory: jest.fn(),
  importScan: jest.fn()
}));
jest.mock("c/orgIntelRecommendationStore", () => ({
  ...jest.requireActual("c/orgIntelRecommendationStore"),
  loadLocalRecommendations: jest.fn(),
  recommendationsMode: jest.fn(() => Promise.resolve("local"))
}));
jest.mock("c/orgIntelStore", () => ({
  ...jest.requireActual("c/orgIntelStore"),
  loadValue: jest.fn(() => Promise.resolve(null)),
  saveValue: jest.fn(() => Promise.resolve())
}));
jest.mock("c/orgIntelUtils", () => ({
  ...jest.requireActual("c/orgIntelUtils"),
  exportRows: jest.fn()
}));

const SERVER = { canRunScan: true, recommendationsEnabled: false };

const COMPLETED = {
  id: "scan-1",
  name: "SCAN-0001",
  status: "Completed",
  startedAt: "2026-10-15T08:00:00.000Z",
  completedAt: "2026-10-15T08:02:00.000Z",
  componentCount: 412,
  findingCount: 23,
  collectionErrorCount: 1,
  healthScore: 64.5,
  domainCounts: { Apex: 10, Flows: 3 }
};
const PREVIOUS = {
  id: "scan-0",
  name: "SCAN-0000",
  status: "Completed",
  startedAt: "2026-10-14T08:00:00.000Z",
  completedAt: "2026-10-14T08:02:00.000Z",
  findingCount: 20,
  healthScore: 70,
  domainCounts: { Apex: 12, Storage: 1 }
};
const RUNNING = {
  id: "scan-2",
  name: "SCAN-0002",
  status: "Running",
  startedAt: "2026-10-15T09:00:00.000Z"
};

function localRec(fingerprint, severity, status, extra = {}) {
  return {
    Id: `local:${fingerprint}`,
    Name: `REC-${fingerprint}`,
    Fingerprint__c: fingerprint,
    Title__c: `Title ${fingerprint}`,
    Severity__c: severity,
    Status__c: status,
    ComponentName__c: `Component${fingerprint}`,
    StillDetected__c: true,
    ...extra
  };
}

const LOCAL = {
  F1: localRec("F1", "Critical", "New"),
  F2: localRec("F2", "High", "Accepted", { StillDetected__c: false }),
  F3: localRec("F3", "High", "To Review"),
  F4: localRec("F4", "Low", "Ignored"),
  F5: localRec("F5", "Medium", "New"),
  F6: localRec("F6", "Medium", "New"),
  F7: localRec("F7", "Medium", "New")
};

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const query = (element, id) =>
  element.shadowRoot.querySelector(`[data-id="${id}"]`);

async function render({
  server = SERVER,
  latest = null,
  history = [],
  local = {}
} = {}) {
  if (server instanceof Error) {
    getOverview.mockRejectedValue({ body: { message: server.message } });
  } else {
    getOverview.mockResolvedValue(server);
  }
  loadLatestScan.mockResolvedValue(latest);
  loadScanHistory.mockResolvedValue(history);
  loadLocalRecommendations.mockResolvedValue(local);
  const element = createElement("c-org-intel-overview", {
    is: OrgIntelOverview
  });
  document.body.appendChild(element);
  await flushPromises();
  await flushPromises();
  return element;
}

const WITH_DATA = {
  latest: RUNNING,
  history: [RUNNING, COMPLETED, PREVIOUS],
  local: LOCAL
};

describe("c-org-intel-overview", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    mockListeners.length = 0;
    jest.clearAllMocks();
  });

  it("shows an empty state with the scan launcher when no scan exists", async () => {
    const element = await render();
    const emptyState = element.shadowRoot.querySelector(
      "c-org-intel-empty-state"
    );
    expect(emptyState.title).toBe("No scan yet");
    expect(query(element, "run-first-scan")).not.toBeNull();
    expect(query(element, "ask-admin")).toBeNull();
    expect(query(element, "score-card")).toBeNull();
  });

  it("asks non-admins for a scan file", async () => {
    const element = await render({ server: { canRunScan: false } });
    expect(query(element, "ask-admin")).not.toBeNull();
  });

  it("forwards the navigation of the scan launcher", async () => {
    const element = await render();
    const handler = jest.fn();
    element.addEventListener("navigate", handler);
    query(element, "run-first-scan").dispatchEvent(
      new CustomEvent("navigate", {
        detail: { section: "scanner", scanId: "scan-1" }
      })
    );
    expect(handler.mock.calls[0][0].detail).toEqual({
      section: "scanner",
      scanId: "scan-1"
    });
  });

  it("renders indicators from the scans and recommendations of the browser", async () => {
    const element = await render(WITH_DATA);
    expect(query(element, "score-value").textContent).toBe("64.5");
    expect(element.shadowRoot.textContent).toContain("1 source not collected");

    // Constats par domaine, écart au scan terminé précédent
    const trend = query(element, "domain-trend");
    expect(trend.textContent).toContain("Apex");
    expect(trend.querySelector(".ov-domain-down").textContent).toBe("−2");
    expect(trend.querySelector(".ov-domain-up").textContent).toBe("+3");

    // 6 recommandations ouvertes (l'ignorée est exclue)
    expect(element.shadowRoot.textContent).toContain(
      "5 to decide · 1 accepted"
    );
    expect(query(element, "distribution").querySelectorAll("li")).toHaveLength(
      5
    );
    const priorities = query(element, "priorities");
    expect(priorities.querySelectorAll("li")).toHaveLength(5);
    expect(priorities.querySelector("a").textContent).toBe("Title F1");
    expect(priorities.textContent).toContain("No longer detected");
    // Édition locale : pas d'assignation affichée
    expect(priorities.textContent).not.toContain("Unassigned");
    expect(element.shadowRoot.textContent).toContain("Top 5 of 6");

    const rows = query(element, "recent-scans").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    // Scan en cours : constats non affichés
    expect(rows[0].textContent).toContain("—");
    // Activité d'équipe : seulement avec le module collaboratif
    expect(query(element, "activity")).toBeNull();
  });

  it("filters the priorities by severity and search", async () => {
    const element = await render(WITH_DATA);
    const high = query(element, "distribution").querySelector(
      'button[data-value="High"]'
    );
    high.click();
    await flushPromises();
    expect(query(element, "priorities").querySelectorAll("li")).toHaveLength(2);
    expect(element.shadowRoot.textContent).toContain(
      "Priority recommendations · High"
    );
    const navigate = jest.fn();
    element.addEventListener("navigate", navigate);
    element.shadowRoot.querySelector(".ov-card-link").click();
    expect(navigate.mock.calls[0][0].detail).toEqual({
      section: "recommendations",
      severity: "High",
      search: null
    });

    element.shadowRoot.querySelector(".filter-chip").click();
    await flushPromises();
    const search = element.shadowRoot.querySelector(".priority-search");
    search.value = "F5";
    search.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    expect(query(element, "priorities").querySelectorAll("li")).toHaveLength(1);
    const allChip = element.shadowRoot.querySelector(".ov-chip");
    expect(allChip.textContent).toContain("1");

    const mediumChip = element.shadowRoot.querySelector(
      '.ov-chip[data-value="Critical"]'
    );
    mediumChip.click();
    await flushPromises();
    expect(element.shadowRoot.textContent).toContain(
      "No open recommendation here."
    );
  });

  it("opens a recommendation, a scan and the indicators' sections", async () => {
    const element = await render(WITH_DATA);
    const navigate = jest.fn();
    element.addEventListener("navigate", navigate);
    query(element, "priorities").querySelector("a").click();
    expect(navigate.mock.calls[0][0].detail).toEqual({
      section: "recommendations",
      recordId: "local:F1"
    });
    query(element, "recent-scans").querySelector("a").click();
    expect(navigate.mock.calls[1][0].detail.section).toBe("scanner");

    const kpis = element.shadowRoot.querySelectorAll(".kpi-link");
    kpis[1].click();
    expect(navigate.mock.calls[2][0].detail).toEqual({
      section: "scanner",
      scanId: "scan-1"
    });
    kpis[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(navigate.mock.calls[3][0].detail).toEqual({ section: "reports" });
  });

  it("exports the visible lists", async () => {
    const element = await render(WITH_DATA);
    const menus = element.shadowRoot.querySelectorAll(
      "c-org-intel-export-menu"
    );
    menus.forEach((menu) =>
      menu.dispatchEvent(
        new CustomEvent("export", { detail: { format: "csv" } })
      )
    );
    const names = exportRows.mock.calls.map((call) => call[0].name);
    expect(names).toEqual(["priority-recommendations", "recent-scans"]);
    const priorityExport = exportRows.mock.calls[0][0];
    expect(priorityExport.rows).toHaveLength(6);
    expect(
      priorityExport.columns.map((column) =>
        column.value(priorityExport.rows[0])
      )
    ).toContain("Unassigned");
    const scanExport = exportRows.mock.calls[1][0];
    scanExport.columns.forEach((column) => column.value(scanExport.rows[1]));
  });

  it("shows the shared indicators and the team activity with the collaborative module", async () => {
    invoke.mockResolvedValue(
      JSON.stringify([
        {
          changedAt: "2026-10-15T08:00:00.000Z",
          changedByName: "Ada",
          recordName: "REC-00001",
          recordId: "a02000000000001AAA",
          fieldLabel: "Status",
          oldValue: "New",
          newValue: "Accepted"
        }
      ])
    );
    const element = await render({
      server: {
        canRunScan: true,
        recommendationsEnabled: true,
        openRecommendationCount: 1,
        toReviewCount: 0,
        acceptedCount: 1,
        severityDistribution: [{ severity: "High", count: 1 }],
        priorityRecommendations: [
          {
            id: "a02000000000001AAA",
            title: "Shared",
            severity: "High",
            status: "Accepted",
            componentName: "X",
            assignedToName: null,
            stillDetected: true
          }
        ]
      },
      latest: COMPLETED,
      history: [COMPLETED]
    });
    expect(query(element, "priorities").textContent).toContain("Unassigned");
    const activity = query(element, "activity");
    expect(activity.textContent).toContain("Status: New → Accepted");
    activity
      .querySelector("c-org-intel-export-menu")
      .dispatchEvent(new CustomEvent("export", { detail: { format: "xlsx" } }));
    const call = exportRows.mock.calls[0][0];
    expect(call.name).toBe("team-activity");
    call.columns.forEach((column) => column.value(call.rows[0]));
  });

  it("warns when the latest scan failed or could not update the recommendations", async () => {
    const failed = { ...RUNNING, status: "Failed" };
    const element = await render({
      latest: failed,
      history: [failed, { ...COMPLETED, recommendationsError: "Boom" }]
    });
    expect(query(element, "banner-failed").textContent).toContain(
      "SCAN-0002 failed"
    );
    expect(query(element, "banner-recommendations")).not.toBeNull();
  });

  it("reloads when a followed scan finishes", async () => {
    const element = await render(WITH_DATA);
    expect(getOverview).toHaveBeenCalledTimes(1);
    mockListeners.forEach((listener) => listener({ status: "Running" }));
    mockListeners.forEach((listener) => listener({ status: "Completed" }));
    await flushPromises();
    expect(getOverview.mock.calls.length).toBeGreaterThanOrEqual(2);
    element.shadowRoot
      .querySelector(".kpi-refresh")
      .dispatchEvent(new CustomEvent("click"));
    await flushPromises();
    expect(getOverview.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("shows an explicit error and retries", async () => {
    const element = await render({ server: new Error("Access denied") });
    const panel = element.shadowRoot.querySelector("c-org-intel-error-panel");
    expect(panel).not.toBeNull();

    getOverview.mockResolvedValue(SERVER);
    panel.dispatchEvent(new CustomEvent("retry"));
    await flushPromises();
    await flushPromises();
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(
      element.shadowRoot.querySelector("c-org-intel-empty-state")
    ).not.toBeNull();
  });
});
