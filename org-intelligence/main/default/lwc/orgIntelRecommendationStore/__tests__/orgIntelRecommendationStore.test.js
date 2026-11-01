/* eslint-disable @lwc/lwc/prefer-custom-event */
// Tests des recommandations de l'édition sans objet : fusion des détections, décisions,
// réconciliation, pierres tombales, import / export de fichiers, CSV Jira.
// Le stockage navigateur est remplacé par une Map en mémoire.

const mockValues = new Map();
const mockCallModule = jest.fn();
const mockLoadModules = jest.fn();

jest.mock("c/orgIntelStore", () => {
  class StoreError extends Error {
    constructor(message, reason = "unknown") {
      super(message);
      this.name = "StoreError";
      this.reason = reason;
    }
  }
  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  return {
    StoreError,
    STORE_KEYS: { RECOMMENDATIONS: "recommendations" },
    loadValue: jest.fn(async (key, fallback = null) => {
      return mockValues.has(key) ? clone(mockValues.get(key)) : fallback;
    }),
    saveValue: jest.fn(async (key, value) => {
      mockValues.set(key, clone(value));
      return 1;
    }),
    removeValue: jest.fn(async (key) => {
      mockValues.delete(key);
    })
  };
});
jest.mock("c/orgIntelModuleApi", () => ({
  MODULES: { RECOMMENDATIONS: "recommendations" },
  callModule: (...args) => mockCallModule(...args),
  loadInstalledModulesStrict: (...args) => mockLoadModules(...args)
}));
jest.mock("c/orgIntelUtils", () => ({
  reduceErrors: (error) => (error && error.message) || String(error)
}));

import userId from "@salesforce/user/Id";
import {
  applyChanges,
  applyLocalChanges,
  buildJiraCsv,
  clearLocalRecommendations,
  COLLABORATIVE_MODE,
  countLocalRecommendations,
  deleteLocalRecommendations,
  exportLocalRecommendations,
  exportSharedRecommendations,
  getLocalRecommendation,
  importLocalRecommendations,
  isLocalId,
  isOpenStatus,
  JIRA_PRIORITIES,
  jiraLabels,
  listLocalRecommendations,
  loadLocalByIds,
  loadLocalRecommendations,
  LOCAL_MODE,
  markJiraExported,
  markNotDetected,
  mergeImported,
  mergeRecommendations,
  onLocalRecommendationsChange,
  pushDecisionsToShared,
  recommendationDomain,
  recommendationName,
  recommendationsMode,
  saveLocalRecommendations,
  sendRecommendations,
  toRow,
  updateLocalRecommendations
} from "c/orgIntelRecommendationStore";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-02T10:00:00.000Z");

function spec(overrides = {}) {
  return {
    Fingerprint__c: "APEX_HARDCODED_ID|AccountHandler",
    RuleCode__c: "APEX_HARDCODED_ID",
    Title__c: "Hardcoded Id in AccountHandler",
    Severity__c: "High",
    Category__c: "Maintainability",
    ComponentType__c: "ApexClass",
    ComponentName__c: "AccountHandler",
    LastScanName__c: "SCAN-1",
    ...overrides
  };
}

function stored() {
  return mockValues.get("recommendations") || {};
}

beforeEach(async () => {
  mockValues.clear();
  mockCallModule.mockReset();
  mockLoadModules.mockReset();
  mockLoadModules.mockResolvedValue([]);
  // Cache du mode (30 s) : relu à chaque test
  await recommendationsMode({ refresh: true });
});

describe("helpers", () => {
  it("derives the domain from the rule prefix", () => {
    expect(recommendationDomain("APEX_X")).toBe("Apex");
    expect(recommendationDomain("TRIGGER_X")).toBe("Apex");
    expect(recommendationDomain("FLOW_X")).toBe("Flows & Automation");
    expect(recommendationDomain("FIELD_USAGE_X")).toBe("Data Model");
    expect(recommendationDomain("VR_X")).toBe("Data Quality");
    expect(recommendationDomain("STORAGE_X")).toBe("Storage");
    expect(recommendationDomain("ADOPTION_X")).toBe("Adoption");
    expect(recommendationDomain("SECURITY_X")).toBe("Security");
    expect(recommendationDomain("OTHER")).toBe("Other");
    expect(recommendationDomain(undefined)).toBe("Other");
  });

  it("knows open statuses and local ids", () => {
    expect(isOpenStatus(undefined)).toBe(true);
    expect(isOpenStatus("Accepted")).toBe(true);
    expect(isOpenStatus("Resolved")).toBe(false);
    expect(isLocalId("local:A")).toBe(true);
    expect(isLocalId("a02000000000001AAA")).toBe(false);
    expect(isLocalId(null)).toBe(false);
  });

  it("gives stable readable names and avoids collisions", () => {
    const name = recommendationName("A|B");
    expect(name).toMatch(/^REC-[0-9A-Z]{6}$/);
    expect(recommendationName("A|B")).toBe(name);
    const other = recommendationName("A|B", new Set([name]));
    expect(other).not.toBe(name);
    expect(other).toMatch(/^REC-[0-9A-Z]{6}$/);
  });

  it("maps a record to a list row", () => {
    const row = toRow({
      ...spec(),
      Name: "REC-1",
      AdjustedSeverity__c: "Critical",
      Owner__c: "Alex",
      Notes__c: "note",
      StillDetected__c: false
    });
    expect(row).toMatchObject({
      id: "local:APEX_HARDCODED_ID|AccountHandler",
      severity: "Critical",
      ruleSeverity: "High",
      severityAdjusted: true,
      status: "New",
      domain: "Apex",
      assignedToName: "Alex",
      hasNotes: true,
      stillDetected: false,
      occurrenceCount: 0,
      isOpen: true
    });
  });
});

describe("mergeRecommendations", () => {
  it("creates recommendations without copying decision fields", () => {
    const byFingerprint = {};
    const counts = mergeRecommendations(
      byFingerprint,
      [
        spec({ Status__c: "Ignored", Owner__c: "x" }),
        { Title__c: "no fp" },
        null
      ],
      null,
      NOW
    );
    expect(counts).toEqual({ created: 1, updated: 0 });
    const rec = byFingerprint["APEX_HARDCODED_ID|AccountHandler"];
    expect(rec).toMatchObject({
      Id: "local:APEX_HARDCODED_ID|AccountHandler",
      Status__c: "New",
      AdjustedSeverity__c: null,
      FirstDetectedAt__c: NOW.toISOString(),
      LastDetectedAt__c: NOW.toISOString(),
      StillDetected__c: true,
      OccurrenceCount__c: 1
    });
    expect(rec.Owner__c).toBeUndefined();
    expect(rec.Name).toMatch(/^REC-/);
  });

  it("updates the content but keeps the decisions, and counts distinct runs", () => {
    const byFingerprint = {};
    mergeRecommendations(byFingerprint, [spec()], null, NOW);
    const fp = "APEX_HARDCODED_ID|AccountHandler";
    applyChanges(byFingerprint, [fp], {
      status: "Accepted",
      owner: "Sam",
      severity: "Low"
    });
    const { Name } = byFingerprint[fp];

    mergeRecommendations(
      byFingerprint,
      [
        spec({ Title__c: "New title", Status__c: "New", Severity__c: "Medium" })
      ],
      null,
      LATER
    );
    let rec = byFingerprint[fp];
    expect(rec.Title__c).toBe("New title");
    expect(rec.Severity__c).toBe("Medium");
    expect(rec.Status__c).toBe("Accepted");
    expect(rec.Owner__c).toBe("Sam");
    expect(rec.AdjustedSeverity__c).toBe("Low");
    expect(rec.Name).toBe(Name);
    expect(rec.OccurrenceCount__c).toBe(1); // même scan

    mergeRecommendations(
      byFingerprint,
      [spec({ LastScanName__c: "SCAN-2", StillDetected__c: false })],
      null,
      LATER
    );
    rec = byFingerprint[fp];
    expect(rec.OccurrenceCount__c).toBe(2);
    expect(rec.StillDetected__c).toBe(false);
  });

  it("compares detection dates when the result has no scan name", () => {
    const byFingerprint = {};
    const base = spec({
      LastScanName__c: undefined,
      LastDetectedAt__c: "2026-10-01T00:00:00Z"
    });
    mergeRecommendations(byFingerprint, [base], null, NOW);
    mergeRecommendations(byFingerprint, [base], null, NOW);
    const fp = base.Fingerprint__c;
    expect(byFingerprint[fp].OccurrenceCount__c).toBe(1);
    mergeRecommendations(
      byFingerprint,
      [{ ...base, LastDetectedAt__c: "2026-10-02T00:00:00Z" }],
      null,
      NOW
    );
    expect(byFingerprint[fp].OccurrenceCount__c).toBe(2);
    mergeRecommendations(
      byFingerprint,
      [{ ...base, LastDetectedAt__c: undefined }],
      null,
      NOW
    );
    expect(byFingerprint[fp].OccurrenceCount__c).toBe(3);
  });

  it("reopens a resolved recommendation detected again by another run", () => {
    const byFingerprint = {};
    const fp = spec().Fingerprint__c;
    mergeRecommendations(byFingerprint, [spec()], null, NOW);
    applyChanges(
      byFingerprint,
      [fp],
      { status: "Resolved", decisionReason: "Fixed" },
      { now: NOW }
    );
    expect(byFingerprint[fp].ResolvedDate__c).toBe(NOW.toISOString());

    mergeRecommendations(
      byFingerprint,
      [spec({ LastScanName__c: "SCAN-2" })],
      "Detected again by SCAN-2",
      LATER
    );
    const rec = byFingerprint[fp];
    expect(rec.Status__c).toBe("To Review");
    expect(rec.DecisionReason__c).toBe("Detected again by SCAN-2");
    expect(rec.ResolvedDate__c).toBeNull();
    expect(rec.DecidedAt).toBe(LATER.toISOString());
    expect(rec.History[rec.History.length - 1]).toMatchObject({
      field: "Status__c",
      oldValue: "Resolved",
      newValue: "To Review",
      changedByName: "Detected again"
    });
  });

  it("keeps the previous reason when no reopen reason is given", () => {
    const fp = spec().Fingerprint__c;
    const byFingerprint = {
      [fp]: {
        ...spec(),
        Status__c: "Resolved",
        DecisionReason__c: "Fixed",
        AdjustedSeverity__c: null
      }
    };
    mergeRecommendations(
      byFingerprint,
      [spec({ LastScanName__c: "SCAN-9" })],
      undefined,
      LATER
    );
    expect(byFingerprint[fp].DecisionReason__c).toBe("Fixed");
    expect(byFingerprint[fp].History).toHaveLength(1);
  });

  it("turns a legacy manual severity change into the adjusted severity", () => {
    const fp = spec().Fingerprint__c;
    const byFingerprint = {
      [fp]: {
        ...spec(),
        Severity__c: "Low",
        History: [{ field: "Severity__c", newValue: "Low" }]
      },
      other: { Fingerprint__c: "other", Severity__c: "High" }
    };
    mergeRecommendations(byFingerprint, [spec()], null, NOW);
    expect(byFingerprint[fp].AdjustedSeverity__c).toBe("Low");
    expect(byFingerprint[fp].Severity__c).toBe("High");
  });

  it("handles a missing spec list", () => {
    expect(mergeRecommendations({}, null)).toEqual({ created: 0, updated: 0 });
  });
});

describe("markNotDetected", () => {
  it("flags only recommendations of reliable rules absent from the result", () => {
    const byFingerprint = {
      a: { Fingerprint__c: "a", RuleCode__c: "R1" },
      b: { Fingerprint__c: "b", RuleCode__c: "R1" },
      c: { Fingerprint__c: "c", RuleCode__c: "R2" },
      d: { Fingerprint__c: "d", RuleCode__c: "R1", StillDetected__c: false }
    };
    expect(markNotDetected(byFingerprint, ["R1"], ["a"])).toBe(1);
    expect(byFingerprint.b.StillDetected__c).toBe(false);
    expect(byFingerprint.a.StillDetected__c).toBeUndefined();
    expect(byFingerprint.c.StillDetected__c).toBeUndefined();
    expect(markNotDetected(byFingerprint, null, null)).toBe(0);
  });
});

describe("applyChanges", () => {
  function sample() {
    const byFingerprint = {};
    mergeRecommendations(
      byFingerprint,
      [
        spec(),
        spec({ Fingerprint__c: "FLOW_X|MyFlow", RuleCode__c: "FLOW_X" })
      ],
      null,
      NOW
    );
    return byFingerprint;
  }

  it("requires a selection and a reason for Ignored / Resolved", () => {
    expect(() => applyChanges({}, [], { status: "New" })).toThrow(
      "Select at least one recommendation."
    );
    expect(() =>
      applyChanges({}, ["x"], { status: "Ignored", decisionReason: "  " })
    ).toThrow(/reason is required/);
  });

  it("applies every field, records history and counts changed records", () => {
    const byFingerprint = sample();
    const fp = spec().Fingerprint__c;
    const longNotes = "n".repeat(100);
    const count = applyChanges(
      byFingerprint,
      [`local:${fp}`, "FLOW_X|MyFlow", "missing"],
      {
        status: "Ignored",
        decisionReason: " Not relevant ",
        dueDate: "2026-12-01",
        severity: "Low",
        owner: "  Robin ",
        notes: longNotes
      },
      { now: NOW, userName: "Admin" }
    );
    expect(count).toBe(2);
    const rec = byFingerprint[fp];
    expect(rec).toMatchObject({
      Status__c: "Ignored",
      DecisionReason__c: "Not relevant",
      DueDate__c: "2026-12-01",
      AdjustedSeverity__c: "Low",
      Owner__c: "Robin",
      Notes__c: longNotes,
      StatusChangedAt__c: NOW.toISOString(),
      ResolvedDate__c: null,
      DecidedAt: NOW.toISOString()
    });
    const notesEntry = rec.History.find((entry) => entry.field === "Notes__c");
    expect(notesEntry.newValue).toHaveLength(80);
    expect(notesEntry.newValue.endsWith("…")).toBe(true);
    expect(notesEntry.changedByName).toBe("Admin");
    expect(
      rec.History.find((entry) => entry.field === "AdjustedSeverity__c")
        .fieldLabel
    ).toBe("Severity");
  });

  it("does nothing when values are unchanged and clears empty values", () => {
    const byFingerprint = sample();
    const fp = spec().Fingerprint__c;
    expect(applyChanges(byFingerprint, [fp], { status: "New" })).toBe(0);
    applyChanges(byFingerprint, [fp], { owner: "A", notes: "x" });
    expect(
      applyChanges(byFingerprint, [fp], {
        owner: "",
        notes: "",
        dueDate: "",
        severity: "",
        decisionReason: ""
      })
    ).toBe(1);
    expect(byFingerprint[fp].Owner__c).toBeNull();
    expect(byFingerprint[fp].Notes__c).toBeNull();
  });

  it("appends dated notes", () => {
    const byFingerprint = sample();
    const fp = spec().Fingerprint__c;
    applyChanges(byFingerprint, [fp], { appendNote: "first" }, { now: NOW });
    applyChanges(
      byFingerprint,
      [fp],
      { appendNote: "second" },
      { now: LATER, userName: "Kim" }
    );
    expect(byFingerprint[fp].Notes__c).toBe(
      "2026-11-01: first\n2026-11-02 Kim: second"
    );
  });
});

describe("local storage of recommendations", () => {
  it("sends to the local store when the module is not installed", async () => {
    const result = await sendRecommendations([spec(), null], {
      reopenReason: "again"
    });
    expect(result).toEqual({ created: 1, updated: 0, mode: LOCAL_MODE });
    expect(await countLocalRecommendations()).toBe(1);
    const again = await sendRecommendations([spec()]);
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect(await sendRecommendations([])).toEqual({
      created: 0,
      updated: 0,
      mode: LOCAL_MODE
    });
  });

  it("sends to the collaborative module in batches", async () => {
    mockLoadModules.mockResolvedValue(["recommendations"]);
    expect(await recommendationsMode({ refresh: true })).toBe(
      COLLABORATIVE_MODE
    );
    mockCallModule.mockResolvedValue({ created: 2, updated: 1 });
    const specs = Array.from({ length: 4001 }, (_, i) =>
      spec({ Fingerprint__c: `R|${i}` })
    );
    const result = await sendRecommendations(specs, { reopenReason: "r" });
    expect(mockCallModule).toHaveBeenCalledTimes(2);
    expect(mockCallModule.mock.calls[0][1]).toBe("upsertExternal");
    expect(mockCallModule.mock.calls[0][2].recommendations).toHaveLength(4000);
    expect(result).toEqual({
      created: 4,
      updated: 2,
      mode: COLLABORATIVE_MODE
    });
    mockCallModule.mockResolvedValue(null);
    expect(await sendRecommendations([spec()])).toMatchObject({
      created: 0,
      updated: 0
    });
  });

  it("fails loudly when the module list cannot be read, then retries", async () => {
    mockLoadModules.mockRejectedValue(new Error("Session expired"));
    await expect(recommendationsMode({ refresh: true })).rejects.toThrow(
      /could not be read.*Session expired/
    );
    mockLoadModules.mockResolvedValue([]);
    expect(await recommendationsMode()).toBe(LOCAL_MODE);
    // Résultat mis en cache
    mockLoadModules.mockResolvedValue(["recommendations"]);
    expect(await recommendationsMode()).toBe(LOCAL_MODE);
  });

  it("lists, details and finds local recommendations", async () => {
    await sendRecommendations([
      spec({
        Description__c: "desc",
        Evidence__c: "proof",
        SuggestedAction__c: "fix",
        AffectedComponents__c: "A\n B \n\nC"
      }),
      spec({
        Fingerprint__c: "APEX_OTHER|AccountHandler",
        RuleCode__c: "APEX_OTHER"
      })
    ]);
    const list = await listLocalRecommendations();
    expect(list.rows).toHaveLength(2);
    expect(list.currentUserId).toBeNull();

    const fp = spec().Fingerprint__c;
    await applyLocalChanges([fp], { status: "Accepted" }, { userName: "Me" });
    const detail = await getLocalRecommendation(`local:${fp}`);
    expect(detail).toMatchObject({
      description: "desc",
      justification: "proof",
      suggestedAction: "fix",
      affectedComponents: ["A", "B", "C"],
      fingerprint: fp,
      canEdit: true
    });
    expect(detail.record.status).toBe("Accepted");
    expect(detail.relatedRecommendations).toHaveLength(1);
    expect(detail.history[0].field).toBe("Status__c");
    expect(detail.history[detail.history.length - 1].field).toBe("created");

    await expect(getLocalRecommendation("local:nope")).rejects.toThrow(
      /not stored in this browser/
    );
    await expect(getLocalRecommendation(null)).rejects.toThrow();

    const found = await loadLocalByIds([`local:${fp}`, "missing", fp]);
    expect(found).toHaveLength(2);
    expect(await loadLocalByIds(null)).toEqual([]);
  });

  it("finds a recommendation by its record id", async () => {
    mockValues.set("recommendations", {
      fp1: { Id: "custom-id", Fingerprint__c: "fp1", ComponentName__c: "X" }
    });
    const detail = await getLocalRecommendation("custom-id");
    expect(detail.affectedComponents).toEqual(["X"]);
    expect(detail.history).toEqual([]);
  });

  it("marks the Jira export date", async () => {
    await sendRecommendations([spec()]);
    const fp = spec().Fingerprint__c;
    await markJiraExported([`local:${fp}`, "missing"]);
    expect(stored()[fp].JiraExportedAt__c).toEqual(expect.any(String));
    await markJiraExported(null);
  });

  it("deletes with a tombstone and recreates on a new detection", async () => {
    await sendRecommendations([spec()]);
    const fp = spec().Fingerprint__c;
    expect(await deleteLocalRecommendations([fp, "missing"])).toBe(1);
    expect(stored()[fp]).toBeUndefined();
    expect(mockValues.get("recommendations.deleted")[fp]).toEqual(
      expect.any(String)
    );
    expect(await deleteLocalRecommendations(null)).toBe(0);

    await sendRecommendations([spec()]);
    expect(stored()[fp]).toBeDefined();
    expect(mockValues.has("recommendations.deleted")).toBe(false);
  });

  it("clears everything", async () => {
    await sendRecommendations([spec()]);
    await deleteLocalRecommendations([spec().Fingerprint__c]);
    await sendRecommendations([spec({ Fingerprint__c: "B|1" })]);
    await clearLocalRecommendations();
    expect(mockValues.size).toBe(0);
    expect(await countLocalRecommendations()).toBe(0);
  });

  it("refuses to write over an unreadable value", async () => {
    mockValues.set("recommendations", ["not", "an", "object"]);
    await expect(loadLocalRecommendations()).rejects.toMatchObject({
      name: "StoreError"
    });
    await expect(
      updateLocalRecommendations(() => undefined)
    ).rejects.toMatchObject({ name: "StoreError" });
    expect(mockValues.get("recommendations")).toEqual(["not", "an", "object"]);
    // La file reste utilisable après une erreur
    mockValues.delete("recommendations");
    await expect(updateLocalRecommendations(() => 7)).resolves.toBe(7);
  });

  it("ignores a damaged tombstone list", async () => {
    mockValues.set("recommendations.deleted", "broken");
    expect((await exportLocalRecommendations()).deleted).toEqual([]);
  });
});

describe("saveLocalRecommendations (reconciliation)", () => {
  it("rejects a non-object copy", async () => {
    await expect(saveLocalRecommendations(null)).rejects.toMatchObject({
      name: "StoreError"
    });
  });

  it("keeps decisions taken meanwhile and records created meanwhile", async () => {
    await sendRecommendations([spec()]);
    const fp = spec().Fingerprint__c;
    const copy = await loadLocalRecommendations();

    // Pendant ce temps (autre onglet) : décision et nouvelle recommandation
    await applyLocalChanges(
      [fp],
      { status: "Ignored", decisionReason: "Legacy" },
      { now: LATER }
    );
    await sendRecommendations([spec({ Fingerprint__c: "NEW|1" })]);

    copy[fp].Title__c = "Updated by scan";
    await saveLocalRecommendations(copy);
    const state = stored();
    expect(state[fp].Title__c).toBe("Updated by scan");
    expect(state[fp].Status__c).toBe("Ignored");
    expect(state[fp].DecisionReason__c).toBe("Legacy");
    expect(state[fp].History).toHaveLength(2);
    expect(state["NEW|1"]).toBeDefined();
    // L'appelant voit l'état écrit
    expect(copy["NEW|1"]).toBeDefined();
    expect(copy[fp].Status__c).toBe("Ignored");
  });

  it("keeps my decision when it is the most recent", async () => {
    await sendRecommendations([spec()]);
    const fp = spec().Fingerprint__c;
    const copy = await loadLocalRecommendations();
    applyChanges(copy, [fp], { status: "Accepted" }, { now: LATER });
    await saveLocalRecommendations(copy);
    expect(stored()[fp].Status__c).toBe("Accepted");
  });

  it("does not resurrect records deleted meanwhile, unless changed after", async () => {
    await sendRecommendations([spec(), spec({ Fingerprint__c: "B|1" })]);
    const copy = await loadLocalRecommendations();
    await deleteLocalRecommendations([spec().Fingerprint__c, "B|1"]);

    // B|1 décidée après l'effacement : gardée
    copy["B|1"].DecidedAt = "2999-01-01T00:00:00.000Z";
    await saveLocalRecommendations(copy);
    const state = stored();
    expect(state[spec().Fingerprint__c]).toBeUndefined();
    expect(state["B|1"]).toBeDefined();
    expect(copy[spec().Fingerprint__c]).toBeUndefined();
    const tombstones = mockValues.get("recommendations.deleted");
    expect(Object.keys(tombstones)).toEqual([spec().Fingerprint__c]);
  });

  it("drops a tombstone when the record still exists in storage", async () => {
    mockValues.set("recommendations", {
      A: { Fingerprint__c: "A", Id: "local:A" }
    });
    mockValues.set("recommendations.deleted", { A: "2026-01-01T00:00:00Z" });
    await saveLocalRecommendations({ A: { Fingerprint__c: "A" } });
    expect(stored().A).toBeDefined();
    expect(mockValues.has("recommendations.deleted")).toBe(false);
  });
});

describe("mergeImported", () => {
  it("adds new records with a free name and a local id", () => {
    const byFingerprint = {
      A: { Fingerprint__c: "A", Name: "REC-TAKEN" }
    };
    const counts = mergeImported(byFingerprint, [
      { Fingerprint__c: "B", Name: "REC-TAKEN", Id: "a02xx" },
      { Fingerprint__c: "C", Name: "REC-CCC" },
      { Fingerprint__c: "D" },
      { Title__c: "no fingerprint" },
      null
    ]);
    expect(counts).toEqual({ added: 3, updated: 0, removed: 0 });
    expect(byFingerprint.B.Name).not.toBe("REC-TAKEN");
    expect(byFingerprint.B.Id).toBe("local:B");
    expect(byFingerprint.C.Name).toBe("REC-CCC");
    expect(byFingerprint.D.Name).toMatch(/^REC-/);
    expect(mergeImported({}, null)).toEqual({
      added: 0,
      updated: 0,
      removed: 0
    });
  });

  it("keeps the most recent content and the most recent decision", () => {
    const byFingerprint = {
      A: {
        Fingerprint__c: "A",
        Id: "local:A",
        Name: "REC-A",
        Title__c: "old",
        LastDetectedAt__c: "2026-10-01T00:00:00Z",
        FirstDetectedAt__c: "2026-09-01T00:00:00Z",
        Status__c: "Accepted",
        DecidedAt: "2026-10-20T00:00:00Z",
        OccurrenceCount__c: 5,
        History: [
          {
            changedAt: "2026-10-20T00:00:00Z",
            field: "Status__c",
            newValue: "Accepted"
          }
        ]
      }
    };
    mergeImported(byFingerprint, [
      {
        Fingerprint__c: "A",
        Id: "a02remote",
        Name: "REC-REMOTE",
        Title__c: "new",
        LastDetectedAt__c: "2026-10-15T00:00:00Z",
        FirstDetectedAt__c: "2026-08-01T00:00:00Z",
        Status__c: "Ignored",
        DecidedAt: "2026-10-10T00:00:00Z",
        OccurrenceCount__c: 2,
        History: [
          {
            changedAt: "2026-10-10T00:00:00Z",
            field: "Status__c",
            newValue: "Ignored"
          },
          {
            changedAt: "2026-10-20T00:00:00Z",
            field: "Status__c",
            newValue: "Accepted"
          }
        ]
      }
    ]);
    const rec = byFingerprint.A;
    expect(rec.Title__c).toBe("new");
    expect(rec.Id).toBe("local:A");
    expect(rec.Name).toBe("REC-A");
    expect(rec.Status__c).toBe("Accepted");
    expect(rec.OccurrenceCount__c).toBe(5);
    expect(rec.FirstDetectedAt__c).toBe("2026-08-01T00:00:00Z");
    expect(rec.History.map((entry) => entry.newValue)).toEqual([
      "Ignored",
      "Accepted"
    ]);
  });

  it("takes the incoming decision when it is newer, keeping local content", () => {
    const byFingerprint = {
      A: {
        Fingerprint__c: "A",
        Title__c: "local",
        LastDetectedAt__c: "2026-10-15T00:00:00Z",
        Status__c: "New",
        DueDate__c: "2026-12-01"
      }
    };
    mergeImported(byFingerprint, [
      {
        Fingerprint__c: "A",
        Title__c: "remote",
        LastDetectedAt__c: "2026-10-01T00:00:00Z",
        Status__c: "Resolved",
        DecisionReason__c: "Done",
        DecidedAt: "2026-10-30T00:00:00Z"
      }
    ]);
    expect(byFingerprint.A).toMatchObject({
      Title__c: "local",
      Status__c: "Resolved",
      DecisionReason__c: "Done",
      DueDate__c: null
    });
  });

  it("applies the file tombstones newer than the last local change", () => {
    const tombstones = { Z: "2026-01-01T00:00:00Z" };
    const byFingerprint = {
      A: { Fingerprint__c: "A", LastDetectedAt__c: "2026-10-01T00:00:00Z" },
      B: { Fingerprint__c: "B", DecidedAt: "2026-11-01T00:00:00Z" }
    };
    const counts = mergeImported(byFingerprint, [], {
      tombstones,
      deleted: [
        { fingerprint: "A", deletedAt: "2026-10-05T00:00:00Z" },
        { fingerprint: "B", deletedAt: "2026-10-05T00:00:00Z" },
        { fingerprint: "Z", deletedAt: "2026-02-01T00:00:00Z" },
        { fingerprint: "Y" }
      ]
    });
    expect(counts.removed).toBe(1);
    expect(byFingerprint.A).toBeUndefined();
    expect(byFingerprint.B).toBeDefined();
    expect(tombstones).toEqual({
      A: "2026-10-05T00:00:00Z",
      Z: "2026-02-01T00:00:00Z"
    });
  });

  it("accepts tombstones as an object and skips records deleted locally", () => {
    const tombstones = { A: "2026-10-10T00:00:00Z" };
    const byFingerprint = {};
    const counts = mergeImported(
      byFingerprint,
      [
        { Fingerprint__c: "A", LastDetectedAt__c: "2026-10-01T00:00:00Z" },
        { Fingerprint__c: "B", DecidedAt: "2026-10-01T00:00:00Z" },
        { Fingerprint__c: "C", DecidedAt: "2026-10-30T00:00:00Z" }
      ],
      {
        tombstones,
        deleted: { B: "2026-10-05T00:00:00Z", C: "2026-10-05T00:00:00Z" }
      }
    );
    expect(counts.added).toBe(1);
    expect(Object.keys(byFingerprint)).toEqual(["C"]);
    expect(tombstones).toEqual({
      A: "2026-10-10T00:00:00Z",
      B: "2026-10-05T00:00:00Z"
    });
  });
});

describe("files and collaborative edition", () => {
  it("exports and re-imports local recommendations with tombstones", async () => {
    await sendRecommendations([spec(), spec({ Fingerprint__c: "B|1" })]);
    await deleteLocalRecommendations(["B|1"]);
    const file = await exportLocalRecommendations();
    expect(file.recommendations).toHaveLength(1);
    expect(file.deleted).toEqual([
      { fingerprint: "B|1", deletedAt: expect.any(String) }
    ]);

    mockValues.clear();
    const result = await importLocalRecommendations(file);
    expect(result).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
    expect(mockValues.get("recommendations.deleted")).toHaveProperty("B|1");

    const asList = await importLocalRecommendations(file.recommendations);
    expect(asList).toMatchObject({ added: 0, updated: 1, total: 1 });
  });

  it("rejects files without recommendations", async () => {
    await expect(importLocalRecommendations({ other: 1 })).rejects.toThrow(
      "This file does not contain recommendations."
    );
    await expect(
      importLocalRecommendations([{ Title__c: "x" }, { Fingerprint__c: "" }])
    ).rejects.toThrow(/no fingerprint/);
    await expect(importLocalRecommendations([])).resolves.toMatchObject({
      added: 0
    });
  });

  it("exports the shared recommendations", async () => {
    mockCallModule.mockResolvedValue([{ Fingerprint__c: "A" }]);
    expect(await exportSharedRecommendations()).toEqual({
      recommendations: [{ Fingerprint__c: "A" }],
      deleted: []
    });
    expect(mockCallModule).toHaveBeenCalledWith(
      "recommendations",
      "exportRecommendations",
      {}
    );
    mockCallModule.mockResolvedValue(null);
    expect((await exportSharedRecommendations()).recommendations).toEqual([]);
  });

  it("pushes decisions to the shared edition without local ids nor history", async () => {
    await sendRecommendations([spec()]);
    await applyLocalChanges([spec().Fingerprint__c], { status: "Accepted" });
    mockCallModule.mockResolvedValue({ created: 1, updated: 0, skipped: 0 });
    const totals = await pushDecisionsToShared();
    expect(totals).toEqual({ created: 1, updated: 0, skipped: 0, total: 1 });
    const sent = mockCallModule.mock.calls[0][2].recommendations[0];
    expect(mockCallModule.mock.calls[0][1]).toBe("importDecisions");
    expect(sent.Id).toBeUndefined();
    expect(sent.History).toBeUndefined();
    expect(sent.Status__c).toBe("Accepted");

    mockCallModule.mockReset();
    mockCallModule.mockResolvedValue(undefined);
    const fromFile = Array.from({ length: 501 }, (_, i) => ({
      Fingerprint__c: `F|${i}`
    }));
    const fileTotals = await pushDecisionsToShared({
      recommendations: fromFile
    });
    expect(mockCallModule).toHaveBeenCalledTimes(2);
    expect(fileTotals).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      total: 501
    });
  });
});

describe("Jira CSV", () => {
  it("builds labels without spaces", () => {
    expect(
      jiraLabels({
        ruleCode: "FLOW_X",
        severity: "High",
        category: "Best Practice"
      })
    ).toEqual([
      "org-intelligence",
      "flows-automation",
      "high",
      "best-practice"
    ]);
    expect(jiraLabels({ domain: "Apex" })).toEqual([
      "org-intelligence",
      "apex"
    ]);
  });

  it("builds an importable CSV with one Labels column per label", () => {
    const csv = buildJiraCsv(
      [
        {
          ...spec(),
          Name: "REC-1",
          Title__c: 'Say "hi", world',
          AdjustedSeverity__c: "Critical",
          Description__c: "Found",
          Justification__c: "Because",
          SuggestedAction__c: "Fix it",
          AffectedComponents__c: "A\nB"
        },
        {
          Fingerprint__c: "X",
          Name: "REC-2",
          Severity__c: "Unknown"
        }
      ],
      { issueType: "Bug" }
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Summary,Issue Type,Priority,Description,Labels,Labels,Labels,Labels"
    );
    expect(
      lines[1].startsWith(
        '"[REC-1] Say ""hi"", world",Bug,Highest,"h3. What was found\nFound'
      )
    ).toBe(true);
    expect(csv).toContain("h3. Why it matters · evidence\nBecause");
    expect(csv).toContain("h3. Suggested action\nFix it");
    expect(csv).toContain("h3. Affected components\n* A\n* B");
    expect(csv).toContain(
      "Rule APEX_HARDCODED_ID · ApexClass AccountHandler · REC-1 (Org Intelligence)"
    );
    expect(csv).toContain(",org-intelligence,apex,critical,maintainability");
    // Ligne sans détail : priorité par défaut, colonnes de labels complétées
    expect(lines[lines.length - 1]).toBe(
      "[REC-2] ,Bug,Medium,Rule — · REC-2 (Org Intelligence),org-intelligence,other,unknown,"
    );
    expect(JIRA_PRIORITIES.Info).toBe("Lowest");
  });

  it("builds a header-only CSV without records", () => {
    expect(buildJiraCsv(null)).toBe(
      "Summary,Issue Type,Priority,Description,Labels"
    );
  });
});

describe("change notifications", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    delete global.BroadcastChannel;
  });

  it("calls back on storage events of the recommendations key", () => {
    const callback = jest.fn();
    const unsubscribe = onLocalRecommendationsChange(callback);
    window.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: "orgIntelligence.store.v1.005000000000000AAA.other"
      })
    );
    jest.advanceTimersByTime(400);
    expect(callback).not.toHaveBeenCalled();

    const event = new Event("storage");
    Object.defineProperty(event, "key", {
      value: `orgIntelligence.store.v1.${userId}.recommendations`
    });
    window.dispatchEvent(event);
    window.dispatchEvent(event);
    jest.advanceTimersByTime(400);
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    window.dispatchEvent(event);
    jest.advanceTimersByTime(400);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("uses BroadcastChannel between tabs when available", async () => {
    const channels = [];
    global.BroadcastChannel = class {
      constructor(name) {
        this.name = name;
        this.close = jest.fn();
        this.postMessage = jest.fn((message) => {
          channels
            .filter((other) => other !== this && other.onmessage)
            .forEach((other) => other.onmessage({ data: message }));
        });
        channels.push(this);
      }
    };
    const callback = jest.fn();
    const unsubscribe = onLocalRecommendationsChange(callback);
    expect(channels[0].name).toMatch(/^orgIntelligence\.recommendations\./);
    channels[0].onmessage();
    jest.advanceTimersByTime(400);
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(channels[0].close).toHaveBeenCalled();
  });
});
