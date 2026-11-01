/* eslint-disable @lwc/lwc/no-async-operation */
// Tests du stockage navigateur : localStorage (jsdom) et un faux IndexedDB minimal.
// Le module garde un état (base ouverte, démarrage, clés illisibles) : chaque test le recharge.

const mockGetOrgInfo = jest.fn();
const mockDownloadText = jest.fn();

jest.mock(
  "@salesforce/apex/OrgIntelligenceController.getOrgInfo",
  () => ({ default: (...args) => mockGetOrgInfo(...args) }),
  { virtual: true }
);
jest.mock("c/orgIntelUtils", () => ({
  downloadText: (...args) => mockDownloadText(...args)
}));

const ORG = {
  orgId: "00D000000000001AAA",
  orgName: "Acme",
  isSandbox: true
};

function loadStore() {
  let store;
  jest.isolateModules(() => {
    store = require("c/orgIntelStore");
  });
  return store;
}

/** Faux IndexedDB : requêtes et transactions asynchrones, pannes injectables par opération. */
function fakeIndexedDB({ openFails = false } = {}) {
  const data = new Map();
  const failures = {};
  const db = {
    close: jest.fn(),
    createObjectStore: jest.fn(),
    transaction() {
      const transaction = {};
      const request = (operation, fn) => {
        const req = {};
        setTimeout(() => {
          let failure = failures[operation];
          if (!failure) {
            try {
              req.result = fn();
            } catch (error) {
              failure = error;
            }
          }
          if (failure) {
            req.error = failure;
            transaction.error = failure;
            if (req.onerror) req.onerror();
            if (transaction.onabort) transaction.onabort();
            return;
          }
          if (req.onsuccess) req.onsuccess();
          setTimeout(() => {
            if (transaction.oncomplete) transaction.oncomplete();
          }, 0);
        }, 0);
        return req;
      };
      transaction.objectStore = () => ({
        get: (key) => request("get", () => data.get(key)),
        put: (value, key) => request("put", () => data.set(key, value)),
        delete: (key) => request("delete", () => data.delete(key)),
        add: (value, key) =>
          request("add", () => {
            if (data.has(key)) {
              throw Object.assign(new Error("exists"), {
                name: "ConstraintError"
              });
            }
            data.set(key, value);
          }),
        getAllKeys: () => request("getAllKeys", () => [...data.keys()])
      });
      return transaction;
    }
  };
  const factory = {
    open: jest.fn(() => {
      const req = {};
      setTimeout(() => {
        if (openFails) {
          req.onerror();
          return;
        }
        req.result = db;
        req.onupgradeneeded();
        req.onsuccess();
      }, 0);
      return req;
    })
  };
  return { data, db, failures, factory };
}

function fileOf(content) {
  return new File(
    [typeof content === "string" ? content : JSON.stringify(content)],
    "data.json",
    { type: "application/json" }
  );
}

function storedKey(suffix) {
  return Object.keys(window.localStorage).find(
    (key) => key.startsWith("orgIntelligence.store.v1.") && key.endsWith(suffix)
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.indexedDB;
  mockGetOrgInfo.mockReset();
  mockGetOrgInfo.mockResolvedValue(ORG);
  mockDownloadText.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete window.indexedDB;
});

describe("c-org-intel-store — localStorage", () => {
  it("saves and reads values under a key prefixed by the user", async () => {
    const store = loadStore();
    expect(await store.loadValue("scan.latest", "none")).toBe("none");
    const size = await store.saveValue("scan.latest", { id: "S1" });
    expect(size).toBe(JSON.stringify({ id: "S1" }).length * 2);
    expect(await store.loadValue("scan.latest")).toEqual({ id: "S1" });
    expect(storedKey(".scan.latest")).toBeDefined();
    expect(await store.storageBackend()).toBe("localStorage");
  });

  it("reports the backend, the switch and writes the schema version", async () => {
    const store = loadStore();
    const status = await store.storageStatus();
    expect(status).toMatchObject({
      backend: "localStorage",
      switched: false,
      migratedKeys: 0,
      schemaVersion: store.SCHEMA_VERSION
    });
    expect(await store.loadValue("meta.schemaVersion")).toBe(
      store.SCHEMA_VERSION
    );
  });

  it("detects a switch from IndexedDB in a previous session", async () => {
    const first = loadStore();
    await first.storageBackend();
    const marker = Object.keys(window.localStorage).find((key) =>
      key.startsWith("orgIntelligence.storeMeta.backend.")
    );
    window.localStorage.setItem(marker, "indexedDB");
    const store = loadStore();
    const status = await store.storageStatus();
    expect(status.previousBackend).toBe("indexedDB");
    expect(status.switched).toBe(true);
  });

  it("migrates an old schema version", async () => {
    const first = loadStore();
    await first.saveValue("meta.schemaVersion", 1);
    const store = loadStore();
    expect((await store.storageStatus()).schemaVersion).toBe(2);
    expect(await store.loadValue("meta.schemaVersion")).toBe(2);
  });

  it("sets a damaged JSON value aside and frees the key", async () => {
    const first = loadStore();
    await first.saveValue("scan.latest", 1);
    window.localStorage.setItem(storedKey(".scan.latest"), "{not json");
    const store = loadStore();
    expect(await store.loadValue("scan.latest", "fb")).toBe("fb");
    expect(await store.loadValue("scan.latest.corrupt")).toBe("{not json");
    await expect(store.loadValueStrict("scan.latest")).rejects.toMatchObject({
      name: "StoreError",
      reason: "unreadable"
    });
    // La clé reste libre : on peut réécrire par-dessus
    await store.saveValue("scan.latest", { ok: true });
    expect(await store.loadValue("scan.latest")).toEqual({ ok: true });
  });

  it("never overwrites a value it could not read", async () => {
    const store = loadStore();
    await store.storageBackend();
    const spy = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    expect(await store.loadValue("recommendations", "fb")).toBe("fb");
    await expect(
      store.loadValueStrict("recommendations")
    ).rejects.toMatchObject({ reason: "unknown" });
    await expect(store.saveValue("recommendations", {})).rejects.toMatchObject({
      reason: "unreadable"
    });
    spy.mockRestore();
    expect(await store.loadValue("recommendations", null)).toBeNull();
    await expect(store.saveValue("recommendations", {})).resolves.toBe(4);
  });

  it("frees an unreadable key once it is removed", async () => {
    const store = loadStore();
    await store.storageBackend();
    const spy = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    await store.loadValue("k");
    spy.mockRestore();
    await store.removeValue("k");
    await expect(store.saveValue("k", 1)).resolves.toBe(2);
  });

  it("refuses values that cannot be serialized", async () => {
    const store = loadStore();
    await expect(store.saveValue("k", undefined)).rejects.toMatchObject({
      reason: "serialize"
    });
    const circular = {};
    circular.self = circular;
    await expect(store.saveValue("k", circular)).rejects.toMatchObject({
      reason: "serialize"
    });
  });

  it.each([
    [{ name: "QuotaExceededError" }, "quota"],
    [{ name: "NS_ERROR_DOM_QUOTA_REACHED" }, "quota"],
    [{ name: "Other", code: 22 }, "quota"],
    [{ name: "InvalidStateError" }, "closed"],
    [{ name: "TransactionInactiveError" }, "closed"],
    [{ name: "DataCloneError" }, "serialize"],
    [{ name: "AbortError" }, "aborted"],
    [{ name: "Weird" }, "unknown"],
    [{}, "unknown"]
  ])("maps storage error %p to %s", async (error, reason) => {
    const store = loadStore();
    await store.storageBackend();
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw error;
    });
    const failure = await store.saveValue("k", 1).catch((e) => e);
    expect(failure).toBeInstanceOf(store.StoreError);
    expect(failure.reason).toBe(reason);
    expect(failure.message.length).toBeGreaterThan(10);
  });

  it("lists, measures and clears the user's keys", async () => {
    const store = loadStore();
    await store.saveValue("scan.latest", { id: "S1" });
    await store.saveValue("scan.history", [1, 2, 3]);
    await store.saveValue("adoption.latest", "a long text value");
    window.localStorage.setItem("someone.else", "x");

    const scanKeys = await store.listKeys("scan.");
    expect(scanKeys.sort()).toEqual(["scan.history", "scan.latest"]);

    const usage = await store.storageUsage();
    expect(usage.map((row) => row.key)).toContain("adoption.latest");
    expect(usage[0].size).toBeGreaterThanOrEqual(usage[usage.length - 1].size);

    const estimate = await store.storageEstimate();
    expect(estimate.backend).toBe("localStorage");
    expect(estimate.quota).toBe(10 * 1024 * 1024);
    expect(estimate.usage).toBe(usage.reduce((sum, row) => sum + row.size, 0));

    expect(await store.clearAll("scan.")).toBe(2);
    expect(await store.listKeys("scan.")).toEqual([]);
    expect(await store.loadValue("adoption.latest")).toBe("a long text value");
    expect(window.localStorage.getItem("someone.else")).toBe("x");
  });

  it("keeps a bounded history, newest first", async () => {
    const store = loadStore();
    await store.pushHistory("h", 1, 2);
    await store.pushHistory("h", 2, 2);
    const history = await store.pushHistory("h", 3, 2);
    expect(history).toEqual([3, 2]);
    expect(await store.loadValue("h")).toEqual([3, 2]);
  });

  it("restarts a history that is not a list", async () => {
    const store = loadStore();
    await store.saveValue("h", { not: "a list" });
    expect(await store.pushHistory("h", "x")).toEqual(["x"]);
  });

  it("returns no key when localStorage cannot be enumerated", async () => {
    const store = loadStore();
    await store.storageBackend();
    jest.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(await store.listKeys()).toEqual([]);
  });

  it("exposes the store keys", () => {
    const store = loadStore();
    expect(store.STORE_KEYS.RECOMMENDATIONS).toBe("recommendations");
    expect(store.FILE_FORMAT).toBe("org-intelligence");
  });
});

describe("c-org-intel-store — IndexedDB", () => {
  it("uses IndexedDB and moves the values left in localStorage", async () => {
    const legacy = loadStore();
    await legacy.saveValue("scan.latest", { id: "OLD" });
    await legacy.saveValue("adoption.latest", { id: "SEC" });

    const fake = fakeIndexedDB();
    const existingKey = storedKey(".adoption.latest");
    fake.data.set(existingKey, JSON.stringify({ id: "NEWER" }));
    window.indexedDB = fake.factory;
    const store = loadStore();

    const status = await store.storageStatus();
    expect(status.backend).toBe("indexedDB");
    expect(status.previousBackend).toBe("localStorage");
    expect(status.switched).toBe(true);
    // scan.latest et meta.schemaVersion déplacés ; adoption.latest déjà présent dans IndexedDB, gardé
    expect(status.migratedKeys).toBe(2);
    expect(storedKey(".adoption.latest")).toBeUndefined();
    expect(storedKey(".scan.latest")).toBeUndefined();
    expect(await store.loadValue("scan.latest")).toEqual({ id: "OLD" });
    expect(await store.loadValue("adoption.latest")).toEqual({ id: "NEWER" });
    expect(fake.db.createObjectStore).toHaveBeenCalledWith("values");

    fake.db.onversionchange();
    expect(fake.db.close).toHaveBeenCalled();
  });

  it("saves, lists, measures and removes values", async () => {
    const fake = fakeIndexedDB();
    window.indexedDB = fake.factory;
    const store = loadStore();
    expect(await store.loadValue("absent", "fb")).toBe("fb");
    await store.saveValue("scan.latest", { id: "S1" });
    await store.saveValue("scan.history", []);
    expect(await store.loadValue("scan.latest")).toEqual({ id: "S1" });
    expect((await store.listKeys("scan.")).sort()).toEqual([
      "scan.history",
      "scan.latest"
    ]);
    const usage = await store.storageUsage();
    expect(usage.find((row) => row.key === "scan.latest").size).toBe(
      JSON.stringify({ id: "S1" }).length * 2
    );
    await store.removeValue("scan.latest");
    expect(await store.loadValue("scan.latest")).toBeNull();
  });

  it("turns an aborted write into a quota error", async () => {
    const fake = fakeIndexedDB();
    window.indexedDB = fake.factory;
    const store = loadStore();
    await store.storageBackend();
    fake.failures.put = { name: "QuotaExceededError" };
    await expect(store.saveValue("k", "v")).rejects.toMatchObject({
      reason: "quota"
    });
  });

  it("protects a key whose read failed", async () => {
    const fake = fakeIndexedDB();
    window.indexedDB = fake.factory;
    const store = loadStore();
    await store.saveValue("k", 1);
    fake.failures.get = { name: "InvalidStateError" };
    await expect(store.loadValueStrict("k")).rejects.toMatchObject({
      reason: "closed"
    });
    expect((await store.storageUsage()).find((r) => r.key === "k").size).toBe(
      0
    );
    await expect(store.saveValue("k", 2)).rejects.toMatchObject({
      reason: "unreadable"
    });
    fake.failures.getAllKeys = new Error("broken");
    expect(await store.listKeys()).toEqual([]);
    fake.failures.delete = new Error("broken");
    await expect(store.removeValue("k")).resolves.toBeUndefined();
  });

  it("estimates the usage with navigator.storage when available", async () => {
    window.indexedDB = fakeIndexedDB().factory;
    const store = loadStore();
    const original = navigator.storage;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: () => Promise.resolve({ usage: 10, quota: 100 }) }
    });
    expect(await store.storageEstimate()).toEqual({
      backend: "indexedDB",
      usage: 10,
      quota: 100
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: () => Promise.resolve({}) }
    });
    expect(await store.storageEstimate()).toEqual({
      backend: "indexedDB",
      usage: null,
      quota: null
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: () => Promise.reject(new Error("nope")) }
    });
    expect(await store.storageEstimate()).toMatchObject({
      backend: "indexedDB",
      quota: null
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: original
    });
  });

  it("falls back to localStorage when the database cannot be opened", async () => {
    window.indexedDB = fakeIndexedDB({ openFails: true }).factory;
    const store = loadStore();
    expect(await store.storageBackend()).toBe("localStorage");
  });

  it("falls back to localStorage when opening throws", async () => {
    window.indexedDB = {
      open: () => {
        throw new Error("SecurityError");
      }
    };
    const store = loadStore();
    expect(await store.storageBackend()).toBe("localStorage");
  });
});

describe("c-org-intel-store — files", () => {
  it("downloads an envelope with the current org", async () => {
    const store = loadStore();
    expect(await store.currentOrgInfo()).toEqual(ORG);
    await store.downloadJson("export.json", "scan", { id: "S1" });
    expect(mockDownloadText).toHaveBeenCalledTimes(1);
    const [fileName, content, mime] = mockDownloadText.mock.calls[0];
    expect(fileName).toBe("export.json");
    expect(mime).toBe("application/json");
    expect(JSON.parse(content)).toMatchObject({
      format: "org-intelligence",
      kind: "scan",
      version: store.FILE_VERSION,
      orgId: ORG.orgId,
      orgName: "Acme",
      isSandbox: true,
      data: { id: "S1" }
    });
  });

  it("waits for the org before downloading, and downloads without it on failure", async () => {
    mockGetOrgInfo.mockRejectedValue(new Error("offline"));
    const store = loadStore();
    await store.downloadJson("a.json", "scan", {});
    const payload = JSON.parse(mockDownloadText.mock.calls[0][1]);
    expect(payload.orgId).toBeNull();
    expect(payload.isSandbox).toBeNull();

    // Nouvel essai au prochain export
    mockGetOrgInfo.mockResolvedValue({ orgId: "00D1", isSandbox: false });
    await store.downloadJson("b.json", "scan", {});
    const second = JSON.parse(mockDownloadText.mock.calls[1][1]);
    expect(second).toMatchObject({
      orgId: "00D1",
      orgName: null,
      isSandbox: false
    });
  });

  it("keeps a null org when the server returns nothing", async () => {
    mockGetOrgInfo.mockResolvedValue(null);
    const store = loadStore();
    expect(await store.currentOrgInfo()).toBeNull();
  });

  it("reads an exported envelope and compares the orgs", async () => {
    const store = loadStore();
    const envelope = await store.readJsonEnvelope(
      fileOf({
        format: "org-intelligence",
        kind: "scan",
        version: 2,
        exportedAt: "2026-11-01T00:00:00.000Z",
        orgId: "00D000000000001XYZ",
        orgName: "Acme",
        isSandbox: false,
        data: { id: "S1", findings: [] }
      }),
      "scan"
    );
    expect(envelope).toMatchObject({
      data: { id: "S1", findings: [] },
      kind: "scan",
      version: 2,
      orgName: "Acme",
      isSandbox: false,
      sameOrg: true
    });

    const other = await store.readJsonEnvelope(
      fileOf({
        format: "org-intelligence",
        kind: "scan",
        orgId: "00D000000000009AAA",
        data: {}
      })
    );
    expect(other.sameOrg).toBe(false);
    expect(other.version).toBe(1);
    expect(other.isSandbox).toBeNull();

    const unknown = await store.readJsonEnvelope(
      fileOf({ format: "org-intelligence", kind: "scan", data: {} })
    );
    expect(unknown.sameOrg).toBeNull();
  });

  it("rejects files of another kind, newer version or invalid JSON", async () => {
    const store = loadStore();
    await expect(
      store.readJsonFile(
        fileOf({ format: "org-intelligence", kind: "adoption", data: {} }),
        "scan"
      )
    ).rejects.toMatchObject({ reason: "kind" });
    await expect(
      store.readJsonFile(
        fileOf({ format: "org-intelligence", kind: "scan", version: 99 }),
        "scan"
      )
    ).rejects.toMatchObject({ reason: "version" });
    await expect(
      store.readJsonFile(fileOf("{oops"), "scan")
    ).rejects.toMatchObject({ reason: "serialize" });
    await expect(store.readJsonFile(null, "scan")).rejects.toMatchObject({
      reason: "file"
    });
    await expect(store.readJsonFile(fileOf({ a: 1 }))).rejects.toMatchObject({
      reason: "kind"
    });
  });

  it("reports a file that cannot be read", async () => {
    const store = loadStore();
    const original = window.FileReader;
    window.FileReader = class {
      readAsText() {
        setTimeout(() => this.onerror(), 0);
      }
    };
    await expect(
      store.readJsonFile(fileOf("{}"), "scan")
    ).rejects.toMatchObject({ reason: "file" });
    window.FileReader = original;
  });

  it.each([
    ["scan", { id: "S1", findings: [] }, { id: 1 }],
    [
      "recommendations",
      [{ Fingerprint__c: "A|B" }],
      [{ Title__c: "no fingerprint" }]
    ],
    [
      "recommendations",
      { recommendations: [{ Fingerprint__c: "A|B" }] },
      { recommendations: [] }
    ],
    ["security-audit", { audit: {} }, { audit: [] }],
    ["adoption", { contract: [] }, { other: 1 }],
    ["adoption", { analysis: {} }, []],
    ["adoption", { history: [] }, null],
    ["fieldUsage", { objects: {} }, { objects: [] }],
    [
      "browserData",
      { "scan.latest": {}, roadmap: {} },
      { "scan.latest": {}, "unknown.key": 1 }
    ],
    ["browserData", { "meta.x": 1 }, {}]
  ])(
    "accepts raw %s data only in the expected shape",
    async (kind, valid, invalid) => {
      const store = loadStore();
      await expect(store.readJsonFile(fileOf(valid), kind)).resolves.toEqual(
        valid
      );
      await expect(
        store.readJsonFile(fileOf(invalid), kind)
      ).rejects.toMatchObject({ reason: "kind" });
    }
  );

  it("rejects raw data for a kind without validator", async () => {
    const store = loadStore();
    await expect(
      store.readJsonEnvelope(fileOf({ a: 1 }), "inventory")
    ).rejects.toMatchObject({ reason: "kind" });
    const raw = await store.readJsonEnvelope(
      fileOf({ objects: {} }),
      "fieldUsage"
    );
    expect(raw).toMatchObject({
      version: 0,
      kind: "fieldUsage",
      sameOrg: null
    });
  });
});

describe("c-org-intel-store — sensitive data", () => {
  const util = require("util");
  const nodeCrypto = require("crypto").webcrypto;
  let originalCrypto;

  function enableWebCrypto() {
    originalCrypto = Object.getOwnPropertyDescriptor(window, "crypto");
    Object.defineProperty(window, "crypto", {
      configurable: true,
      value: nodeCrypto
    });
    global.TextEncoder = util.TextEncoder;
    global.TextDecoder = util.TextDecoder;
  }

  beforeEach(() => window.sessionStorage.clear());

  afterEach(() => {
    if (originalCrypto) {
      Object.defineProperty(window, "crypto", originalCrypto);
      originalCrypto = undefined;
    }
  });

  it("keeps sensitive keys for the session only without Web Crypto", async () => {
    const first = loadStore();
    await first.saveValue("adoption.latest", 1);
    const prefix = storedKey(".adoption.latest").replace(
      /adoption\.latest$/,
      ""
    );
    window.localStorage.setItem(
      `${prefix}security.latest`,
      JSON.stringify({ grade: "B" })
    );

    const store = loadStore();
    expect(await store.storageProtection()).toEqual({
      mode: "session",
      message: store.PROTECTION_MESSAGES.session
    });
    // Déplacée du disque vers la session
    expect(window.localStorage.getItem(`${prefix}security.latest`)).toBeNull();
    expect(await store.loadValue("security.latest")).toEqual({ grade: "B" });

    // Le contrat (saisie de l'utilisateur) reste durable, en clair, sans chiffrement possible
    await store.saveValue("adoption.contract", [{ price: 10 }]);
    expect(
      window.sessionStorage.getItem(`${prefix}adoption.contract`)
    ).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem(`${prefix}adoption.contract`))
    ).toEqual([{ price: 10 }]);
    expect(await store.loadValue("adoption.contract")).toEqual([{ price: 10 }]);
    // Seules les clés security.* vont en session
    expect(
      window.sessionStorage.getItem(`${prefix}security.latest`)
    ).not.toBeNull();
    expect((await store.listKeys()).sort()).toEqual(
      expect.arrayContaining([
        "adoption.contract",
        "adoption.latest",
        "security.latest"
      ])
    );
    await store.removeValue("adoption.contract");
    expect(await store.loadValue("adoption.contract")).toBeNull();
  });

  it("falls back to memory when sessionStorage is refused", async () => {
    const store = loadStore();
    await store.storageBackend();
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await store.saveValue("security.latest", { a: 1 });
    expect(await store.loadValue("security.latest")).toEqual({ a: 1 });
    jest.restoreAllMocks();
    jest.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(await store.listKeys("security.")).toEqual(["security.latest"]);
    jest.restoreAllMocks();
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await store.removeValue("security.latest");
    jest.restoreAllMocks();
    expect(await store.loadValue("security.latest")).toBeNull();
  });

  it("reports a full session storage as a quota error", async () => {
    const store = loadStore();
    await store.storageBackend();
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    });
    await expect(store.saveValue("security.latest", 1)).rejects.toMatchObject({
      reason: "quota"
    });
  });

  it("encrypts sensitive keys at rest with a non-extractable key", async () => {
    enableWebCrypto();
    const fake = fakeIndexedDB();
    window.indexedDB = fake.factory;
    const store = loadStore();
    expect((await store.storageProtection()).mode).toBe("encrypted");
    expect((await store.storageStatus()).protection).toBe("encrypted");

    await store.saveValue("security.latest", { grade: "A" });
    await store.saveValue("scan.latest", { id: "S1" });
    const full = [...fake.data.keys()].find((key) =>
      key.endsWith(".security.latest")
    );
    expect(fake.data.get(full).startsWith("oienc1:")).toBe(true);
    expect(fake.data.get(full)).not.toContain("grade");
    expect(
      fake.data.get(
        [...fake.data.keys()].find((k) => k.endsWith(".scan.latest"))
      )
    ).toBe(JSON.stringify({ id: "S1" }));
    expect(await store.loadValue("security.latest")).toEqual({ grade: "A" });
    // La clé AES n'est jamais listée
    expect(await store.listKeys()).not.toContain(
      expect.stringContaining("storeKey")
    );

    // Nouvelle session : même clé, relue dans IndexedDB
    const next = loadStore();
    expect(await next.loadValue("security.latest")).toEqual({ grade: "A" });
  });

  it("encrypts legacy clear values and drops values that cannot be decrypted", async () => {
    enableWebCrypto();
    const fake = fakeIndexedDB();
    window.indexedDB = fake.factory;
    const first = loadStore();
    await first.saveValue("scan.latest", 1);
    const prefix = [...fake.data.keys()]
      .find((key) => key.endsWith(".scan.latest"))
      .replace(/scan\.latest$/, "");
    fake.data.set(`${prefix}adoption.contract`, JSON.stringify([{ q: 3 }]));
    fake.data.set(`${prefix}security.history`, "oienc1:AAAA:BBBB");

    const store = loadStore();
    expect(await store.loadValue("adoption.contract")).toEqual([{ q: 3 }]);
    expect(
      fake.data.get(`${prefix}adoption.contract`).startsWith("oienc1:")
    ).toBe(true);

    // Valeur altérée : lue comme absente, supprimée, clé de nouveau libre
    expect(await store.loadValue("security.history", "none")).toBe("none");
    expect(fake.data.has(`${prefix}security.history`)).toBe(false);
    await expect(store.saveValue("security.history", [])).resolves.toBe(4);
  });

  it("falls back to the session when the key cannot be stored", async () => {
    enableWebCrypto();
    const fake = fakeIndexedDB();
    fake.failures.add = new Error("DataCloneError");
    window.indexedDB = fake.factory;
    const store = loadStore();
    expect((await store.storageProtection()).mode).toBe("session");
  });
});
