import { createElement } from "lwc";
import OrgIntelSettings from "c/orgIntelSettings";
import getSettings from "@salesforce/apex/OrgAdminController.getSettings";
import updateRule from "@salesforce/apex/OrgAdminController.updateRule";
import updateRetention from "@salesforce/apex/OrgAdminController.updateRetention";
import updateScoreSettings from "@salesforce/apex/OrgAdminController.updateScoreSettings";
import runMaintenance from "@salesforce/apex/OrgAdminController.runMaintenance";
import invoke from "@salesforce/apex/OrgIntelModuleController.invoke";
import { loadValue, saveValue } from "c/orgIntelStore";
import { exportRows } from "c/orgIntelUtils";

jest.mock(
  "@salesforce/apex/OrgAdminController.getSettings",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgAdminController.updateRule",
  () => ({ default: jest.fn(() => Promise.resolve()) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgAdminController.updateRetention",
  () => ({ default: jest.fn(() => Promise.resolve()) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgAdminController.updateScoreSettings",
  () => ({ default: jest.fn(() => Promise.resolve()) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgAdminController.runMaintenance",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelModuleController.invoke",
  () => ({ default: jest.fn(() => Promise.resolve(null)) }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelModuleController.getTools",
  () => ({ default: jest.fn(() => Promise.resolve([])) }),
  { virtual: true }
);
jest.mock("c/orgIntelStore", () => ({
  ...jest.requireActual("c/orgIntelStore"),
  loadValue: jest.fn(),
  saveValue: jest.fn(() => Promise.resolve()),
  storageUsage: jest.fn(() => Promise.resolve([])),
  storageBackend: jest.fn(() => Promise.resolve("indexedDB")),
  storageEstimate: jest.fn(() => Promise.resolve(null)),
  storageStatus: jest.fn(() => Promise.resolve({ schemaVersion: 2 }))
}));
jest.mock("c/orgIntelUtils", () => ({
  ...jest.requireActual("c/orgIntelUtils"),
  exportRows: jest.fn()
}));

const BALANCED = {
  Critical: [10, 25],
  High: [5, 15],
  Medium: [2, 8],
  Low: [0.5, 4],
  Info: [0, 0]
};
const SETTINGS = {
  orgDomainUrl: "https://acme.my.salesforce.com",
  tooling: { configured: true, connected: true },
  retention: {
    apiLogRetentionDays: 30,
    logApiPayloads: true,
    namedCredential: "OrgIntelligenceTooling"
  },
  score: {
    preset: "Balanced",
    points: { Critical: 10, High: 5, Medium: 2, Low: 0.5, Info: 0 },
    caps: { Critical: 25, High: 15, Medium: 8, Low: 4, Info: 0 },
    domains: ["Apex", "Data Model"],
    excludeIgnored: true
  },
  scorePresets: {
    Strict: {
      Critical: [20, 40],
      High: [10, 25],
      Medium: [4, 12],
      Low: [1, 6],
      Info: [0, 0]
    },
    Balanced: BALANCED
  },
  scoreDomains: ["Apex", "Data Model", "Flows & Automation"],
  rules: [
    {
      code: "APEX_LOW_COVERAGE",
      label: "Low coverage",
      domain: "ApexClass",
      category: "Quality",
      enabled: true,
      severity: "High",
      threshold: 75
    },
    {
      code: "FLOW_NO_DESCRIPTION",
      label: "Flow without description",
      domain: "Flow",
      category: "Maintainability",
      enabled: false,
      severity: "Low",
      threshold: null
    }
  ],
  access: [
    {
      userId: "005A",
      name: "Ada",
      permissionSet: "OrgIntelligence_Admin",
      isActive: true
    },
    {
      userId: "005B",
      name: "Bob",
      permissionSet: "OrgIntelligence_User",
      isActive: false
    }
  ],
  volumes: [{ label: "API logs", count: 1200 }]
};

const LATEST_SCAN = {
  id: "scan-1",
  name: "SCAN-0001",
  healthScore: 80,
  findings: [
    {
      ruleCode: "APEX_LOW_COVERAGE",
      severity: "High",
      fingerprint: "F1",
      domain: "Apex"
    },
    {
      ruleCode: "APEX_LOW_COVERAGE",
      severity: "High",
      fingerprint: "F2",
      domain: "Apex"
    }
  ]
};

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const all = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];
const byLabel = (element, tag, label) =>
  all(element, tag).filter((item) => item.label === label);

async function render({ settings = SETTINGS, modules = [] } = {}) {
  if (settings instanceof Error) {
    getSettings.mockRejectedValue({ body: { message: settings.message } });
  } else {
    getSettings.mockResolvedValue(JSON.parse(JSON.stringify(settings)));
  }
  const element = createElement("c-org-intel-settings", {
    is: OrgIntelSettings
  });
  element.modules = modules;
  document.body.appendChild(element);
  await flushPromises();
  await flushPromises();
  return element;
}

describe("c-org-intel-settings", () => {
  beforeEach(() => {
    loadValue.mockImplementation((key, fallback) =>
      Promise.resolve(key === "scan.latest" ? LATEST_SCAN : fallback)
    );
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.clearAllMocks();
  });

  it("lists the sections available with the installed modules", async () => {
    const bare = await render();
    const keys = (element) =>
      all(element, ".nav-chip").map((chip) => chip.dataset.section);
    expect(keys(bare)).not.toContain("jira");
    expect(keys(bare)).not.toContain("retention");
    expect(bare.shadowRoot.textContent).toContain("1 of 2 rules enabled");

    const full = await render({
      modules: ["recommendations", "apiMonitoring"]
    });
    expect(keys(full)).toEqual(
      expect.arrayContaining(["jira", "retention", "uninstall"])
    );
    // Réglages Jira lus par le module Recommendations
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        module: "recommendations",
        action: "getJiraSettings"
      })
    );
  });

  it("previews the score with a preset, then saves and recalculates the latest scan", async () => {
    const element = await render();
    expect(element.shadowRoot.textContent).toContain("SCAN-0001");
    // Balanced : 2 constats High = 10 points (plafond 15) → 90
    expect(element.shadowRoot.textContent).toContain("90");
    expect(
      byLabel(element, "lightning-button", "Save preferences")[0].disabled
    ).toBe(true);

    element.shadowRoot.querySelector('[data-value="Strict"]').click();
    await flushPromises();
    // Strict : 2 × 10 = 20 (plafond 25) → 80
    expect(
      byLabel(element, "lightning-button", "Save preferences")[0].disabled
    ).toBe(false);

    byLabel(element, "lightning-button", "Save preferences")[0].click();
    await flushPromises();
    await flushPromises();
    const saved = JSON.parse(updateScoreSettings.mock.calls[0][0].scoreJson);
    expect(saved.preset).toBe("Strict");
    expect(saved.points.High).toBe(10);
    expect(saveValue).toHaveBeenCalledWith(
      "scan.latest",
      expect.objectContaining({ healthScore: 80 })
    );
  });

  it("switches to the Custom preset when a value is edited", async () => {
    const element = await render();
    const points = byLabel(element, "lightning-input", "Points per finding");
    const high = points.find((input) => input.dataset.severity === "High");
    high.value = "1";
    high.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    const custom = element.shadowRoot.querySelector('[data-value="Custom"]');
    expect(custom.className).toContain("preset-selected");

    // Aucun domaine retenu : enregistrement impossible
    all(element, 'input[type="checkbox"]').forEach((box) => {
      if (box.checked) {
        box.checked = false;
        box.dispatchEvent(new CustomEvent("change"));
      }
    });
    await flushPromises();
    expect(
      byLabel(element, "lightning-button", "Save preferences")[0].disabled
    ).toBe(true);

    byLabel(element, "lightning-button", "Cancel changes")[0].click();
    await flushPromises();
    expect(
      element.shadowRoot
        .querySelector('[data-value="Balanced"]')
        .className.includes("preset-selected")
    ).toBe(true);
  });

  it("saves a rule after editing it", async () => {
    const element = await render();
    const severity = all(element, "lightning-combobox").find(
      (box) => box.dataset.code === "APEX_LOW_COVERAGE"
    );
    severity.dispatchEvent(
      new CustomEvent("change", { detail: { value: "Critical" } })
    );
    const threshold = byLabel(element, "lightning-input", "Threshold")[0];
    threshold.value = "80";
    threshold.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    const save = byLabel(element, "lightning-button", "Save").find(
      (button) => button.dataset.code === "APEX_LOW_COVERAGE"
    );
    expect(save.disabled).toBe(false);
    save.click();
    await flushPromises();
    expect(updateRule).toHaveBeenCalledWith({
      code: "APEX_LOW_COVERAGE",
      enabled: true,
      severity: "Critical",
      threshold: 80
    });
  });

  it("filters and exports the rules", async () => {
    const element = await render();
    const filter = all(element, "lightning-input").find(
      (input) => input.type === "search"
    );
    filter.value = "flow";
    filter.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    expect(
      all(element, "lightning-combobox").filter((box) => box.dataset.code)
    ).toHaveLength(1);

    all(element, "c-org-intel-export-menu").forEach((menu) =>
      menu.dispatchEvent(
        new CustomEvent("export", { detail: { format: "csv" } })
      )
    );
    expect(exportRows).toHaveBeenCalled();
    exportRows.mock.calls.forEach(([options]) => {
      const sheets = options.sheets || [options];
      sheets.forEach((sheet) =>
        (sheet.rows || []).forEach((row) =>
          (sheet.columns || []).forEach((column) => column.value(row))
        )
      );
    });
  });

  it("saves the API log retention and runs the maintenance", async () => {
    runMaintenance.mockResolvedValue({
      apiLogsDeleted: 12,
      apiLogRetentionDays: 7
    });
    const element = await render({ modules: ["apiMonitoring"] });
    const days = byLabel(
      element,
      "lightning-input",
      "Keep the API log (days)"
    )[0];
    days.value = "7";
    days.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    const save = byLabel(element, "lightning-button", "Save").find(
      (button) => !button.dataset.code
    );
    save.click();
    await flushPromises();
    expect(updateRetention).toHaveBeenCalledWith({
      apiLogDays: 7,
      logPayloads: true
    });

    byLabel(element, "lightning-button", "Run maintenance now")[0].click();
    await flushPromises();
    await flushPromises();
    expect(element.shadowRoot.textContent).toContain(
      "12 API log entries older than 7 days deleted."
    );
  });

  it("collapses and expands the sections", async () => {
    const element = await render();
    const toggle = element.shadowRoot.querySelector("lightning-button-icon");
    expect(toggle.alternativeText).toBe("Expand all sections");
    toggle.click();
    await flushPromises();
    expect(toggle.alternativeText).toBe("Collapse all sections");
    toggle.click();
    await flushPromises();
    expect(
      byLabel(element, "lightning-button", "Save preferences")
    ).toHaveLength(0);

    // Lien du bandeau : rouvre la section repliée
    element.shadowRoot.querySelector('.nav-chip[data-section="score"]').click();
    await flushPromises();
    expect(
      byLabel(element, "lightning-button", "Save preferences")
    ).toHaveLength(1);
    element.shadowRoot
      .querySelector('.section-toggle[data-section="score"]')
      .click();
    await flushPromises();
    expect(
      byLabel(element, "lightning-button", "Save preferences")
    ).toHaveLength(0);
  });

  it("shows the error panel when the settings cannot be read", async () => {
    const element = await render({ settings: new Error("Admins only") });
    expect(
      element.shadowRoot.querySelector("c-org-intel-error-panel")
    ).not.toBeNull();
  });
});
