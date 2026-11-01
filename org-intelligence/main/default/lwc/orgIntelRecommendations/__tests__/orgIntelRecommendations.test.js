import { createElement } from "lwc";
import OrgIntelRecommendations from "c/orgIntelRecommendations";
import LightningConfirm from "lightning/confirm";
import invoke from "@salesforce/apex/OrgIntelModuleController.invoke";
import JiraExportModal from "c/orgIntelJiraExportModal";
import {
  applyLocalChanges,
  clearLocalRecommendations,
  countLocalRecommendations,
  deleteLocalRecommendations,
  exportLocalRecommendations,
  importLocalRecommendations,
  listLocalRecommendations,
  onLocalRecommendationsChange,
  pushDecisionsToShared,
  recommendationsMode
} from "c/orgIntelRecommendationStore";
import { downloadJson } from "c/orgIntelStore";
import { exportRows } from "c/orgIntelUtils";

jest.mock(
  "@salesforce/customPermission/OrgIntelligence_Admin",
  () => ({ default: true }),
  { virtual: true }
);
jest.mock(
  "@salesforce/apex/OrgIntelModuleController.invoke",
  () => ({ default: jest.fn() }),
  { virtual: true }
);
jest.mock("c/orgIntelJiraExportModal", () => ({
  __esModule: true,
  default: { open: jest.fn() }
}));
jest.mock("c/orgIntelRecommendationStore", () => {
  const actual = jest.requireActual("c/orgIntelRecommendationStore");
  return {
    LOCAL_MODE: actual.LOCAL_MODE,
    COLLABORATIVE_MODE: actual.COLLABORATIVE_MODE,
    RECOMMENDATIONS_FILE_KIND: actual.RECOMMENDATIONS_FILE_KIND,
    REASON_REQUIRED_STATUSES: actual.REASON_REQUIRED_STATUSES,
    isLocalId: actual.isLocalId,
    applyLocalChanges: jest.fn(),
    clearLocalRecommendations: jest.fn(() => Promise.resolve()),
    countLocalRecommendations: jest.fn(() => Promise.resolve(0)),
    deleteLocalRecommendations: jest.fn(),
    exportLocalRecommendations: jest.fn(),
    exportSharedRecommendations: jest.fn(),
    importLocalRecommendations: jest.fn(),
    listLocalRecommendations: jest.fn(),
    onLocalRecommendationsChange: jest.fn(() => () => {}),
    pushDecisionsToShared: jest.fn(),
    recommendationsMode: jest.fn(),
    getLocalRecommendation: jest.fn(() => new Promise(() => {}))
  };
});
jest.mock("c/orgIntelStore", () => ({
  ...jest.requireActual("c/orgIntelStore"),
  downloadJson: jest.fn(),
  readJsonEnvelope: jest.fn()
}));
jest.mock("c/orgIntelUtils", () => ({
  ...jest.requireActual("c/orgIntelUtils"),
  exportRows: jest.fn()
}));

function row(id, severity, status, extra = {}) {
  return {
    id,
    name: `REC-${id}`,
    title: `Title ${id}`,
    severity,
    status,
    isOpen: !["Resolved", "Ignored"].includes(status),
    category: "Maintainability",
    componentType: "ApexClass",
    componentName: `Class${id}`,
    ruleCode: "APEX_TEST",
    domain: "Apex",
    stillDetected: true,
    lastDetectedAt: "2026-10-30T10:00:00.000Z",
    commentCount: 0,
    ...extra
  };
}

const ROWS = [
  row("1", "Critical", "New"),
  row("2", "High", "Accepted", {
    domain: "Flows & Automation",
    ruleCode: "FLOW_X",
    category: "Performance",
    dueDate: "2020-01-01",
    owner: "Ada"
  }),
  row("3", "Medium", "To Review", { stillDetected: false }),
  row("4", "Low", "Resolved"),
  row("5", "High", "New", { jiraIssueKey: "OI-1" })
];

// eslint-disable-next-line @lwc/lwc/no-async-operation
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const all = (element, selector) => [
  ...element.shadowRoot.querySelectorAll(selector)
];
const rowsShown = (element) =>
  all(element, ".row").filter((el) => el.dataset.id);
const buttonByLabel = (element, label) =>
  all(element, "lightning-button").find((button) => button.label === label);

async function render({ mode = "local", rows = ROWS, props = {} } = {}) {
  recommendationsMode.mockResolvedValue(mode);
  listLocalRecommendations.mockResolvedValue({ currentUserId: null, rows });
  invoke.mockResolvedValue(
    JSON.stringify({ currentUserId: "005000000000001AAA", rows })
  );
  const element = createElement("c-org-intel-recommendations", {
    is: OrgIntelRecommendations
  });
  Object.assign(element, props);
  document.body.appendChild(element);
  await flushPromises();
  await flushPromises();
  return element;
}

async function selectRows(element, ids) {
  ids.forEach((id) => {
    const box = element.shadowRoot.querySelector(
      `input[type="checkbox"][data-id="${id}"]`
    );
    box.checked = true;
    box.dispatchEvent(new CustomEvent("change"));
  });
  await flushPromises();
}

describe("c-org-intel-recommendations", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.clearAllMocks();
  });

  it("lists the open recommendations of the browser, grouped by severity", async () => {
    const element = await render();
    expect(onLocalRecommendationsChange).toHaveBeenCalled();
    // Vue « Open » : la résolue est masquée
    expect(rowsShown(element).map((el) => el.dataset.id)).toEqual([
      "1",
      "2",
      "5",
      "3"
    ]);
    expect(all(element, ".group").length).toBe(3);
    // Édition locale : pas de vues liées à l'assignation
    const views = all(element, "[data-name]").map((el) => el.dataset.name);
    expect(views).not.toContain("mine");
    expect(views).toContain("overdue");
    expect(element.shadowRoot.textContent).toContain("No longer detected");
    expect(element.shadowRoot.textContent).toContain("OI-1");
  });

  it("filters by view, domain, severity and text", async () => {
    const element = await render();
    element.shadowRoot.querySelector('[data-name="all"]').click();
    await flushPromises();
    expect(rowsShown(element)).toHaveLength(5);

    element.shadowRoot.querySelector('[data-name="overdue"]').click();
    await flushPromises();
    expect(rowsShown(element).map((el) => el.dataset.id)).toEqual(["2"]);

    element.shadowRoot.querySelector('[data-name="open"]').click();
    await flushPromises();
    element.shadowRoot
      .querySelector('[data-value="Flows & Automation"]')
      .click();
    await flushPromises();
    expect(rowsShown(element).map((el) => el.dataset.id)).toEqual(["2"]);

    element.shadowRoot.querySelector('.domain[data-value=""]').click();
    await flushPromises();
    element.shadowRoot.querySelector('.chip[data-value="High"]').click();
    await flushPromises();
    expect(rowsShown(element)).toHaveLength(2);

    const search = all(element, "lightning-input").find(
      (input) => input.type === "search"
    );
    search.value = "class5";
    search.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    expect(rowsShown(element).map((el) => el.dataset.id)).toEqual(["5"]);

    buttonByLabel(element, "Reset").click();
    search.value = "";
    search.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    expect(rowsShown(element)).toHaveLength(4);
  });

  it("sorts without severity groups", async () => {
    const element = await render();
    const sort = all(element, "lightning-combobox").find(
      (box) => box.options && box.options.some((o) => o.value === "title")
    );
    sort.dispatchEvent(
      new CustomEvent("change", { detail: { value: "title" } })
    );
    await flushPromises();
    expect(all(element, ".group")).toHaveLength(0);
    expect(rowsShown(element).map((el) => el.dataset.id)).toEqual([
      "1",
      "2",
      "3",
      "5"
    ]);
  });

  it("applies bulk changes to the selected recommendations", async () => {
    applyLocalChanges.mockResolvedValue(2);
    const element = await render();
    const toast = jest.fn();
    element.addEventListener("lightning__showtoast", toast);
    await selectRows(element, ["1", "3"]);
    expect(element.shadowRoot.textContent).toContain("2 selected");

    const status = all(element, "lightning-combobox").find(
      (box) => box.options && box.options.some((o) => o.value === "Ignored")
    );
    status.dispatchEvent(
      new CustomEvent("change", { detail: { value: "Ignored" } })
    );
    await flushPromises();
    // Motif obligatoire pour Ignored
    expect(buttonByLabel(element, "Apply").disabled).toBe(true);
    const reason = all(element, "lightning-input, lightning-textarea").find(
      (input) => /reason/i.test(input.label || "")
    );
    reason.value = "False positive";
    reason.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    buttonByLabel(element, "Apply").click();
    await flushPromises();
    await flushPromises();
    expect(applyLocalChanges).toHaveBeenCalledWith(
      ["1", "3"],
      { status: "Ignored", decisionReason: "False positive" },
      expect.any(Object)
    );
    expect(toast.mock.calls[0][0].detail.variant).toBe("success");
    expect(listLocalRecommendations).toHaveBeenCalledTimes(2);
  });

  it("deletes local recommendations after confirmation", async () => {
    LightningConfirm.open = jest.fn(() => Promise.resolve(true));
    deleteLocalRecommendations.mockResolvedValue(1);
    const element = await render();
    await selectRows(element, ["1"]);
    all(element, "lightning-button-icon")
      .find((button) => button.iconName === "utility:delete")
      .click();
    await flushPromises();
    await flushPromises();
    expect(deleteLocalRecommendations).toHaveBeenCalledWith(["1"]);
  });

  it("opens the Jira export with the selection", async () => {
    JiraExportModal.open.mockResolvedValue({ exported: 1 });
    const element = await render();
    await selectRows(element, ["5"]);
    buttonByLabel(element, "Jira file").click();
    await flushPromises();
    await flushPromises();
    expect(JiraExportModal.open).toHaveBeenCalledWith(
      expect.objectContaining({ recordIds: ["5"], mode: "local" })
    );
  });

  it("exports the visible rows", async () => {
    const element = await render();
    element.shadowRoot
      .querySelector("c-org-intel-export-menu")
      .dispatchEvent(new CustomEvent("export", { detail: { format: "csv" } }));
    const call = exportRows.mock.calls[0][0];
    expect(call.rows).toHaveLength(4);
    call.columns.forEach((column) => column.value(call.rows[0]));
  });

  it("saves and imports recommendation files with the Data menu", async () => {
    exportLocalRecommendations.mockResolvedValue({ records: [] });
    importLocalRecommendations.mockResolvedValue({
      added: 2,
      updated: 1,
      removed: 0
    });
    LightningConfirm.open = jest.fn(() => Promise.resolve(true));
    const element = await render();
    const toast = jest.fn();
    element.addEventListener("lightning__showtoast", toast);
    const menu = element.shadowRoot.querySelector("c-org-intel-data-menu");
    menu.dispatchEvent(new CustomEvent("save"));
    await flushPromises();
    expect(downloadJson).toHaveBeenCalledWith(
      expect.stringMatching(/^org-intelligence-recommendations-/),
      "recommendations",
      { records: [] }
    );

    menu.dispatchEvent(
      new CustomEvent("open", {
        detail: {
          envelope: { sameOrg: false, orgName: "Acme", data: { records: [] } }
        }
      })
    );
    await flushPromises();
    await flushPromises();
    expect(LightningConfirm.open).toHaveBeenCalled();
    expect(importLocalRecommendations).toHaveBeenCalledWith({ records: [] });
    expect(toast.mock.calls.at(-1)[0].detail.message).toContain(
      "2 added, 1 merged"
    );

    menu.dispatchEvent(new CustomEvent("clear"));
    await flushPromises();
    expect(clearLocalRecommendations).toHaveBeenCalled();
  });

  it("uses the shared recommendations with the collaborative module", async () => {
    countLocalRecommendations.mockResolvedValue(3);
    pushDecisionsToShared.mockResolvedValue({
      created: 2,
      updated: 1,
      skipped: 0
    });
    LightningConfirm.open = jest.fn(() => Promise.resolve(true));
    const element = await render({ mode: "collaborative" });
    expect(listLocalRecommendations).not.toHaveBeenCalled();
    const views = all(element, "[data-name]").map((el) => el.dataset.name);
    expect(views).toContain("mine");
    expect(element.shadowRoot.textContent).toContain(
      "3 recommendations are still stored in this browser"
    );
    const push = all(element, "lightning-button").find((button) =>
      /push/i.test(button.label || "")
    );
    push.click();
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(pushDecisionsToShared).toHaveBeenCalledWith(null);
    expect(clearLocalRecommendations).toHaveBeenCalled();
  });

  it("opens the record given by the shell", async () => {
    const element = await render({ props: { recordId: "1" } });
    expect(
      element.shadowRoot.querySelector("c-org-intel-recommendation-panel")
    ).not.toBeNull();
    expect(element.recordId).toBe("1");
  });

  it("shows the empty state and the error panel", async () => {
    const empty = await render({ rows: [] });
    const navigate = jest.fn();
    empty.addEventListener("navigate", navigate);
    expect(
      empty.shadowRoot.querySelector("c-org-intel-empty-state")
    ).not.toBeNull();

    recommendationsMode.mockRejectedValue({ body: { message: "Denied" } });
    const element = createElement("c-org-intel-recommendations", {
      is: OrgIntelRecommendations
    });
    document.body.appendChild(element);
    await flushPromises();
    await flushPromises();
    expect(
      element.shadowRoot.querySelector("c-org-intel-error-panel")
    ).not.toBeNull();
  });
});
