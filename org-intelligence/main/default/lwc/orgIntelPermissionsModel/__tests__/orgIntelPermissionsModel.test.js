import {
  KIND_GROUP,
  KIND_LABELS,
  KIND_PERMISSION_SET,
  KIND_PROFILE,
  OBJECT_FLAGS,
  RULES,
  SEVERITY_TONES,
  abbreviate,
  computeFindings,
  containerIndex,
  groupIndex,
  isPackaged,
  isRegularPermissionSet,
  objectFlags,
  objectMap,
  objectNames,
  permissionIndex,
  powerfulPermissions,
  recommendationSpec,
  similarity,
  strategyMetrics
} from "c/orgIntelPermissionsModel";

const KEY_PERMISSIONS = [
  {
    field: "PermissionsModifyAllData",
    label: "Modify All Data",
    powerful: true
  },
  { field: "PermissionsViewSetup", label: "View Setup", powerful: true },
  { field: "PermissionsApiEnabled", label: "API Enabled", powerful: false }
];

function profile(id, extra = {}) {
  return {
    id,
    kind: KIND_PROFILE,
    name: id,
    license: "Salesforce",
    isCustom: true,
    activeUsers: 1,
    objectCount: 10,
    permissions: [],
    ...extra
  };
}

function permissionSet(id, extra = {}) {
  return {
    id,
    kind: KIND_PERMISSION_SET,
    name: id,
    apiName: `${id}_Api`,
    type: "Regular",
    activeUsers: 1,
    objectCount: 5,
    permissions: [],
    ...extra
  };
}

function ids(findings, key) {
  return findings.filter((f) => f.key === key).map((f) => f.element);
}

describe("c-org-intel-permissions-model", () => {
  it("exposes the reference values", () => {
    expect(KIND_LABELS[KIND_GROUP]).toBe("Permission set group");
    expect(OBJECT_FLAGS.map((flag) => flag.letter).join("")).toBe("RCEDVM");
    expect(SEVERITY_TONES.High).toBe("serious");
    expect(Object.keys(RULES)).toHaveLength(10);
  });

  it("indexes object access, permissions, containers and groups", () => {
    expect(objectMap(["Account:RCED", "My:Obj__c:R", "bad", ":X"])).toEqual({
      Account: "RCED",
      "My:Obj__c": "R"
    });
    expect(objectMap(null)).toEqual({});

    const overview = {
      keyPermissions: KEY_PERMISSIONS,
      containers: [
        profile("P1"),
        { id: "G1", kind: KIND_GROUP, groupId: "0PG1" },
        { id: "G2", kind: KIND_GROUP }
      ]
    };
    expect(permissionIndex(overview).PermissionsViewSetup.label).toBe(
      "View Setup"
    );
    expect(permissionIndex(null)).toEqual({});
    expect(Object.keys(containerIndex(overview))).toEqual(["P1", "G1", "G2"]);
    expect(containerIndex(undefined)).toEqual({});
    expect(Object.keys(groupIndex(overview))).toEqual(["0PG1"]);
    expect(groupIndex(null)).toEqual({});

    const permissions = permissionIndex(overview);
    expect(
      powerfulPermissions(
        {
          permissions: [
            "PermissionsModifyAllData",
            "PermissionsApiEnabled",
            "PermissionsUnknown"
          ]
        },
        permissions
      )
    ).toEqual(["PermissionsModifyAllData"]);
    expect(powerfulPermissions({}, permissions)).toEqual([]);
  });

  it("recognises packaged and regular permission sets", () => {
    expect(isPackaged({ namespace: "abc" })).toBe(true);
    expect(isPackaged({})).toBe(false);
    expect(isRegularPermissionSet(permissionSet("PS"))).toBe(true);
    expect(
      isRegularPermissionSet(permissionSet("PS", { type: "Standard" }))
    ).toBe(false);
    expect(
      isRegularPermissionSet(permissionSet("PS", { namespace: "pkg" }))
    ).toBe(false);
    expect(isRegularPermissionSet(profile("P"))).toBe(false);
  });

  it("measures the similarity of object access", () => {
    expect(similarity([], [])).toBe(1);
    expect(similarity(null, undefined)).toBe(1);
    expect(similarity(["A:R"], [])).toBe(0);
    expect(similarity(["A:R", "B:R"], ["A:R", "C:R"])).toBeCloseTo(1 / 3);
    expect(similarity(["A:R"], ["A:R"])).toBe(1);
  });

  it("returns no finding without an overview", () => {
    expect(computeFindings(null)).toEqual([]);
    expect(computeFindings({})).toEqual([]);
  });

  it("finds unused profiles, unassigned sets and group issues", () => {
    const findings = computeFindings({
      overview: {
        activeUsers: 10,
        keyPermissions: KEY_PERMISSIONS,
        containers: [
          profile("Unused", {
            activeUsers: 0,
            lastModified: "2025-01-02T10:00:00Z"
          }),
          profile("UnusedNoLicense", { activeUsers: 0, license: null }),
          profile("Standard", { activeUsers: 0, isCustom: false }),
          permissionSet("Never", { activeUsers: 0, license: "Sales" }),
          permissionSet("NeverNoLicense", { activeUsers: 0 }),
          permissionSet("InGroup", { activeUsers: 0, groups: ["G"] }),
          permissionSet("Inactive", { activeUsers: 0, inactiveUsers: 2 }),
          permissionSet("Packaged", { activeUsers: 0, namespace: "pkg" }),
          { id: "G1", kind: KIND_GROUP, name: "Empty", apiName: "Empty_Api" },
          {
            id: "G2",
            kind: KIND_GROUP,
            name: "Outdated",
            components: ["x"],
            status: "Outdated"
          },
          {
            id: "G3",
            kind: KIND_GROUP,
            name: "Fine",
            components: ["x"],
            status: "Updated"
          },
          { id: "G4", kind: KIND_GROUP, name: "Pkg", namespace: "pkg" }
        ]
      }
    });
    expect(ids(findings, "UNUSED_PROFILE").sort()).toEqual([
      "Unused",
      "UnusedNoLicense"
    ]);
    const unused = findings.find((f) => f.element === "Unused");
    expect(unused.detail).toBe("Salesforce · last modified 2025-01-02");
    expect(unused.rule).toBe("SECURITY_PERM_UNUSED_PROFILE");
    expect(unused.id).toBe("UNUSED_PROFILE|Unused");
    expect(findings.find((f) => f.element === "UnusedNoLicense").detail).toBe(
      "Unknown license"
    );
    expect(ids(findings, "UNASSIGNED_PS").sort()).toEqual([
      "Never",
      "NeverNoLicense"
    ]);
    expect(findings.find((f) => f.element === "Never").detail).toBe(
      "Never_Api · Sales"
    );
    expect(ids(findings, "INACTIVE_ONLY_PS")).toEqual(["Inactive"]);
    expect(ids(findings, "EMPTY_GROUP")).toEqual(["Empty"]);
    expect(ids(findings, "OUTDATED_GROUP")).toEqual(["Outdated"]);
    // Trié par gravité : les constats Medium avant les Low
    expect(findings[0].severity).toBe("Medium");
    expect(findings[findings.length - 1].severity).toBe("Low");
  });

  it("flags powerful profiles given to many users", () => {
    const findings = computeFindings({
      overview: {
        activeUsers: 200,
        keyPermissions: KEY_PERMISSIONS,
        containers: [
          profile("Admin", {
            activeUsers: 11,
            permissions: ["PermissionsModifyAllData", "PermissionsViewSetup"]
          }),
          profile("Setup", {
            activeUsers: 11,
            permissions: ["PermissionsViewSetup"]
          }),
          // Seuil = max(5, 5 % de 200 = 10) : 10 utilisateurs ne suffisent pas
          profile("Few", {
            activeUsers: 10,
            permissions: ["PermissionsModifyAllData"]
          })
        ]
      }
    });
    const powerful = findings.filter((f) => f.key === "POWERFUL_PROFILE");
    expect(powerful.map((f) => [f.element, f.severity])).toEqual([
      ["Admin", "High"],
      ["Setup", "Medium"]
    ]);
    expect(powerful[0].detail).toBe(
      "11 active users · Modify All Data, View Setup"
    );
    expect(powerful[0].affected).toEqual(["Modify All Data", "View Setup"]);
  });

  it("compares object access only when it is complete", () => {
    const containers = [
      profile("Sales A", { permissions: ["PermissionsApiEnabled"] }),
      profile("Sales B", { permissions: ["PermissionsApiEnabled"] }),
      profile("Other license", { license: "Platform" }),
      profile("Std 1", { isCustom: false }),
      profile("Std 2", { isCustom: false }),
      permissionSet("Dup 1", { permissions: ["PermissionsApiEnabled"] }),
      permissionSet("Dup 2", { permissions: ["PermissionsApiEnabled"] }),
      permissionSet("Unique"),
      permissionSet("No access")
    ];
    const objectAccess = {
      "Sales A": ["Account:RCED", "Contact:R"],
      "Sales B": ["Contact:R", "Account:RCED"],
      "Other license": ["Account:RCED", "Contact:R"],
      "Std 1": ["Account:R"],
      "Std 2": ["Account:R"],
      "Dup 1": ["Case:R", "Lead:RC"],
      "Dup 2": ["Lead:RC", "Case:R"],
      Unique: ["Case:R"]
    };
    const overview = { activeUsers: 50, containers };

    expect(
      computeFindings({
        overview,
        objectAccess,
        objectAccessComplete: false
      }).filter((f) => ["SIMILAR_PROFILES", "DUPLICATE_PS"].includes(f.key))
    ).toEqual([]);

    const findings = computeFindings({
      overview,
      objectAccess,
      objectAccessComplete: true
    });
    const similar = findings.filter((f) => f.key === "SIMILAR_PROFILES");
    expect(similar).toHaveLength(1);
    expect(similar[0].element).toBe("Sales A ↔ Sales B");
    expect(similar[0].detail).toContain("100% identical object access");
    expect(similar[0].containerIds).toEqual(["Sales A", "Sales B"]);
    const duplicates = findings.filter((f) => f.key === "DUPLICATE_PS");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].element).toBe("Dup 1 ↔ Dup 2");
    expect(duplicates[0].affected).toEqual(["Dup 1", "Dup 2"]);
  });

  it("flags users with many permission sets", () => {
    const findings = computeFindings({
      overview: { containers: [] },
      users: {
        top: [
          { name: "Busy", permissionSets: 12, groups: 4 },
          { name: "Calm", permissionSets: 10, groups: 5 },
          { name: "Empty" }
        ]
      }
    });
    const many = findings.find((f) => f.key === "MANY_PERMISSION_SETS");
    expect(many.element).toBe("Org");
    expect(many.affected).toEqual(["Busy — 12 permission set(s), 4 group(s)"]);
    expect(
      computeFindings({ overview: { containers: [] }, users: {} })
    ).toEqual([]);
  });

  it("measures the profile-centric strategy", () => {
    const analysis = {
      overview: {
        activeStandardUsers: 20,
        containers: [
          profile("P", { activeUsers: 5, objectCount: 80 }),
          profile("Idle", { activeUsers: 0, objectCount: 500 }),
          permissionSet("PS", { activeUsers: 3, objectCount: 15 }),
          { id: "G", kind: KIND_GROUP, activeUsers: 2, objectCount: 5 },
          { id: "M", kind: "Muting", activeUsers: 2, objectCount: 99 },
          permissionSet("NoCount", { activeUsers: 1, objectCount: undefined })
        ]
      },
      users: { profileOnlyUsers: 5 }
    };
    expect(strategyMetrics(analysis)).toEqual({
      fromProfiles: 80,
      fromSets: 20,
      profileShare: 0.8,
      profileOnlyUsers: 5,
      profileOnlyShare: 0.25
    });
    const centric = computeFindings(analysis).find(
      (f) => f.key === "PROFILE_CENTRIC"
    );
    expect(centric.detail).toBe(
      "80% of the object access of the containers in use comes from profiles · 25% of internal users have no permission set"
    );

    const withoutUsers = computeFindings({ overview: analysis.overview }).find(
      (f) => f.key === "PROFILE_CENTRIC"
    );
    expect(withoutUsers.detail).not.toContain("internal users");

    expect(strategyMetrics(null)).toEqual({
      fromProfiles: 0,
      fromSets: 0,
      profileShare: null,
      profileOnlyUsers: null,
      profileOnlyShare: null
    });
  });

  it("builds recommendation specs like Apex String.abbreviate", () => {
    expect(abbreviate("abcdef", 6)).toBe("abcdef");
    expect(abbreviate("abcdefg", 6)).toBe("abc...");
    expect(abbreviate(null, 5)).toBe("");

    const item = {
      rule: "SECURITY_PERM_UNUSED_PROFILE",
      title: "Custom profile without active users",
      element: "Old profile",
      detail: "Salesforce",
      advice: "Delete it",
      severity: "Low",
      affected: ["A", "B"]
    };
    expect(recommendationSpec(item, "2026-11-02T10:00:00Z")).toEqual({
      Fingerprint__c: "SECURITY_PERM_UNUSED_PROFILE|Old profile",
      RuleCode__c: "SECURITY_PERM_UNUSED_PROFILE",
      Title__c:
        "Permissions: Custom profile without active users — Old profile",
      Description__c: "Salesforce",
      SuggestedAction__c: "Delete it",
      Category__c: "Security",
      Confidence__c: "High",
      ComponentName__c: "Old profile",
      AffectedComponents__c: "A\nB",
      LastDetectedAt__c: "2026-11-02T10:00:00Z",
      StillDetected__c: true,
      Severity__c: "Low"
    });
    const long = recommendationSpec(
      { ...item, element: "x".repeat(300), affected: undefined },
      null
    );
    expect(long.Fingerprint__c).toHaveLength(255);
    expect(long.ComponentName__c.endsWith("...")).toBe(true);
    expect(long.AffectedComponents__c).toBe("");
  });

  it("lists objects and reads the flags of a container", () => {
    const access = {
      P1: ["Contact:R", "Account:RCED", "broken"],
      P2: ["Account:R", "Case:RE"],
      P3: null
    };
    expect(objectNames(access)).toEqual(["Account", "Case", "Contact"]);
    expect(objectNames(undefined)).toEqual([]);
    expect(objectFlags(access, "P1", "Account")).toBe("RCED");
    expect(objectFlags(access, "P1", "Case")).toBe("");
    expect(objectFlags(access, "Missing", "Account")).toBe("");
    expect(objectFlags(null, "P1", "Account")).toBe("");
  });
});
