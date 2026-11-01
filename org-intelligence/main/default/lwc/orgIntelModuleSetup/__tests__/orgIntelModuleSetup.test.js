import { createElement } from "lwc";
import OrgIntelModuleSetup, { MODULES_SEEN_KEY } from "c/orgIntelModuleSetup";
import getModuleCatalog from "@salesforce/apex/OrgIntelModuleController.getModuleCatalog";
import grantModuleAccess from "@salesforce/apex/OrgIntelModuleController.grantModuleAccess";
import getScannerState from "@salesforce/apex/OrgIntelligenceController.getScannerState";
import { loadScanHistory } from "c/orgIntelScanData";
import { visualforceUrl } from "c/orgIntelModuleApi";

jest.mock(
  "@salesforce/apex/OrgIntelModuleController.getModuleCatalog",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelModuleController.grantModuleAccess",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getScannerState",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock("c/orgIntelScanEngine", () => ({
  startScan: jest.fn(),
  subscribe: jest.fn(() => () => {}),
  isScanRunning: jest.fn(() => false),
  resumableScan: jest.fn(() => Promise.resolve(null)),
  resumeScan: jest.fn(),
  discardResumableScan: jest.fn()
}));
jest.mock("c/orgIntelScanData", () => ({
  ...jest.requireActual("c/orgIntelScanData"),
  loadScanHistory: jest.fn(),
  loadLatestScanHeader: jest.fn(() => Promise.resolve(null))
}));
jest.mock("c/orgIntelStore", () => ({
  ...jest.requireActual("c/orgIntelStore"),
  loadValue: jest.fn(() => Promise.resolve(null)),
  saveValue: jest.fn(() => Promise.resolve())
}));
jest.mock("c/orgIntelModuleApi", () => ({
  ...jest.requireActual("c/orgIntelModuleApi"),
  visualforceUrl: jest.fn(() =>
    Promise.resolve("/apex/OrgIntelligenceToolingSetup")
  )
}));

const CATALOG = {
  isAdmin: false,
  canAssign: true,
  installBaseUrl:
    "https://acme.my.salesforce.com/packaging/installPackage.apexp?p0=",
  modules: [
    {
      key: "core",
      installed: true,
      accessible: true,
      permissionSet: "OrgIntelligence_Admin",
      permissionSetFound: true,
      assigned: false
    },
    {
      key: "recommendations",
      installed: true,
      accessible: true,
      permissionSetFound: true
    },
    {
      key: "apiMonitoring",
      installed: true,
      accessible: false,
      permissionSet: "OrgIntelligence_ApiMonitoring_Admin",
      permissionSetFound: true
    },
    { key: "contextHub", installed: false, accessible: false }
  ]
};

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const buttons = (element, label) =>
  [...element.shadowRoot.querySelectorAll("lightning-button")].filter(
    (button) => button.label === label
  );

async function render(catalog = CATALOG) {
  if (catalog instanceof Error) {
    getModuleCatalog.mockRejectedValue({ body: { message: catalog.message } });
  } else {
    getModuleCatalog.mockResolvedValue(catalog);
  }
  const element = createElement("c-org-intel-module-setup", {
    is: OrgIntelModuleSetup
  });
  document.body.appendChild(element);
  await flushPromises();
  await flushPromises();
  return element;
}

describe("c-org-intel-module-setup", () => {
  beforeEach(() => {
    getScannerState.mockResolvedValue({ tooling: { connected: false } });
    loadScanHistory.mockResolvedValue([]);
    window.open = jest.fn();
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    window.localStorage.clear();
    jest.clearAllMocks();
  });

  it("remembers that the screen was seen and shows the progress", async () => {
    const element = await render();
    expect(window.localStorage.getItem(MODULES_SEEN_KEY)).toBe("true");
    // Socle sans accès admin (ni profil ni permission set) : étape 1 à faire
    expect(
      element.shadowRoot.querySelector('[data-id="setup-progress"]').textContent
    ).toBe("1 of 4 steps done");
    expect(element.shadowRoot.textContent).toContain(
      "2 of 7 optional modules installed"
    );
  });

  it("offers the right action for each module", async () => {
    const element = await render();
    // Socle sans accès admin, et API Monitoring installé sans accès
    expect(buttons(element, "Give me admin access")).toHaveLength(1);
    expect(
      buttons(element, "Give me access").map((button) => button.dataset.key)
    ).toEqual(["apiMonitoring"]);
    expect(buttons(element, "Open").map((b) => b.dataset.section)).toEqual([
      "recommendations"
    ]);
    // Pas encore de version publiée : lien vers le guide d'installation
    const howTo = buttons(element, "How to install");
    expect(howTo.length).toBeGreaterThan(0);
    howTo[0].click();
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining("github.com"),
      "_blank",
      "noopener"
    );
  });

  it("grants access and tells the shell to reload its sections", async () => {
    grantModuleAccess.mockResolvedValue(null);
    const element = await render();
    const changed = jest.fn();
    const toast = jest.fn();
    element.addEventListener("modulechange", changed);
    element.addEventListener("lightning__showtoast", toast);
    buttons(element, "Give me access")
      .find((button) => button.dataset.key === "apiMonitoring")
      .click();
    await flushPromises();
    await flushPromises();
    expect(grantModuleAccess).toHaveBeenCalledWith({ key: "apiMonitoring" });
    expect(toast.mock.calls[0][0].detail.variant).toBe("success");
    expect(changed).toHaveBeenCalled();
  });

  it("asks an administrator when the user cannot assign permission sets", async () => {
    const element = await render({ ...CATALOG, canAssign: false });
    expect(buttons(element, "Give me access")).toHaveLength(0);
  });

  it("counts every step once everything is set up", async () => {
    getScannerState.mockResolvedValue({ tooling: { connected: true } });
    loadScanHistory.mockResolvedValue([{ id: "scan-1" }]);
    const element = await render({ ...CATALOG, isAdmin: true });
    expect(
      element.shadowRoot.querySelector('[data-id="setup-progress"]').textContent
    ).toBe("All set: every step is done.");
  });

  it("opens the Tooling setup page and the settings", async () => {
    const tab = { location: {} };
    window.open = jest.fn(() => tab);
    const element = await render();
    const navigate = jest.fn();
    element.addEventListener("navigate", navigate);
    buttons(element, "Set up the connection")[0].click();
    await flushPromises();
    expect(visualforceUrl).toHaveBeenCalledWith("OrgIntelligenceToolingSetup");
    expect(tab.location.href).toBe("/apex/OrgIntelligenceToolingSetup");
    expect(tab.opener).toBeNull();
    buttons(element, "Check it in Settings")[0].click();
    expect(navigate.mock.calls[0][0].detail).toEqual({ section: "settings" });
  });

  it("tells the shell when a refresh finds a newly installed module", async () => {
    const element = await render();
    const changed = jest.fn();
    element.addEventListener("modulechange", changed);
    const ready = { key: "contextHub", installed: true, accessible: true };
    getModuleCatalog.mockResolvedValue({
      ...CATALOG,
      modules: [...CATALOG.modules.slice(0, 3), ready]
    });
    element.shadowRoot
      .querySelector("lightning-button-icon")
      .dispatchEvent(new CustomEvent("click"));
    await flushPromises();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(buttons(element, "Open")).toHaveLength(2);
  });

  it("shows the error panel when the catalog cannot be read", async () => {
    const element = await render(new Error("Denied"));
    expect(
      element.shadowRoot.querySelector("c-org-intel-error-panel")
    ).not.toBeNull();
  });
});
