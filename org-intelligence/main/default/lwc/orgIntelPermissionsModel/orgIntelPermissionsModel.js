/**
 * Modèle pur de la section « Profiles & Permission Sets » (module Security) : index des
 * conteneurs de droits (profils, permission sets, groupes), droits objet, constats et
 * spécifications de recommandations. Aucun appel Apex ni accès au DOM : testable seul.
 *
 * Données d'entrée (gardées dans le navigateur) :
 * { overview, users, objectAccess: { <id PermissionSet>: ["Account:RCED", …] }, objectAccessComplete }
 * Lettres des droits objet : R lecture, C création, E modification, D suppression, V View All,
 * M Modify All ; FLS : R lecture, E modification.
 */

export const KIND_PROFILE = "Profile";
export const KIND_PERMISSION_SET = "PermissionSet";
export const KIND_GROUP = "PermissionSetGroup";
export const KIND_MUTING = "Muting";

export const KIND_LABELS = {
  Profile: "Profile",
  PermissionSet: "Permission set",
  PermissionSetGroup: "Permission set group",
  Muting: "Muting permission set"
};

export const OBJECT_FLAGS = [
  { letter: "R", label: "Read" },
  { letter: "C", label: "Create" },
  { letter: "E", label: "Edit" },
  { letter: "D", label: "Delete" },
  { letter: "V", label: "View All" },
  { letter: "M", label: "Modify All" }
];

/** Seuils des constats. */
export const THRESHOLDS = {
  /** Profils « quasi identiques » : part minimale de droits objet communs. */
  similarity: 0.95,
  /** Utilisateur avec trop de permission sets et groupes. */
  manyPermissionSets: 15,
  /** Profil puissant « à beaucoup d'utilisateurs » : au-delà de ce nombre et de cette part. */
  powerfulUsers: 5,
  powerfulShare: 0.05,
  /** Stratégie « profil minimal » : part des droits objet portée par les profils utilisés. */
  profileShare: 0.7
};

export const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export const SEVERITY_TONES = {
  Critical: "critical",
  High: "serious",
  Medium: "warning",
  Low: "low"
};

/** Règles des constats (code de règle SECURITY_PERM_<clé>). */
export const RULES = {
  UNUSED_PROFILE: {
    title: "Custom profile without active users",
    severity: "Low",
    advice:
      "Check that nobody needs it, then delete it to keep the list of profiles short."
  },
  UNASSIGNED_PS: {
    title: "Permission set never assigned",
    severity: "Low",
    advice:
      "Delete it if it is not planned for use, or add it to a permission set group."
  },
  INACTIVE_ONLY_PS: {
    title: "Permission set assigned only to inactive users",
    severity: "Low",
    advice:
      "Remove the assignments of inactive users, then delete the permission set if nobody needs it."
  },
  SIMILAR_PROFILES: {
    title: "Nearly identical profiles",
    severity: "Medium",
    advice:
      "Merge them into one profile and move the few differences to permission sets (use Compare)."
  },
  POWERFUL_PROFILE: {
    title: "Powerful profile given to many users",
    severity: "High",
    advice:
      "Keep administrator permissions on a few users: move them to a permission set assigned only to those who need it."
  },
  DUPLICATE_PS: {
    title: "Duplicate permission sets",
    severity: "Medium",
    advice:
      "Compare both, keep one and move its assignments: duplicates drift apart over time."
  },
  EMPTY_GROUP: {
    title: "Empty permission set group",
    severity: "Low",
    advice: "Add permission sets to it or delete it."
  },
  OUTDATED_GROUP: {
    title: "Permission set group not up to date",
    severity: "Medium",
    advice:
      "Open it in Setup and recalculate it: its users may not have the expected access."
  },
  MANY_PERMISSION_SETS: {
    title: "Users with many permission sets",
    severity: "Low",
    advice:
      "Bundle the permission sets often assigned together into permission set groups by job role."
  },
  PROFILE_CENTRIC: {
    title: "Access carried mostly by profiles",
    severity: "Medium",
    advice:
      "Salesforce recommends a minimal profile per license and access given by permission sets and groups: move object access out of the profiles step by step."
  }
};

// ---------- Index ----------

/** Droits objet d'un conteneur : { objet: lettres }. */
export function objectMap(entries) {
  const map = {};
  (entries || []).forEach((entry) => {
    const index = entry.lastIndexOf(":");
    if (index > 0) {
      map[entry.slice(0, index)] = entry.slice(index + 1);
    }
  });
  return map;
}

/** Libellés des permissions système clés : { champ: { label, powerful } }. */
export function permissionIndex(overview) {
  const index = {};
  ((overview && overview.keyPermissions) || []).forEach((p) => {
    index[p.field] = p;
  });
  return index;
}

export function containerIndex(overview) {
  const index = {};
  ((overview && overview.containers) || []).forEach((c) => {
    index[c.id] = c;
  });
  return index;
}

/** Index des groupes par Id de PermissionSetGroup. */
export function groupIndex(overview) {
  const index = {};
  ((overview && overview.containers) || []).forEach((c) => {
    if (c.kind === KIND_GROUP && c.groupId) {
      index[c.groupId] = c;
    }
  });
  return index;
}

export function powerfulPermissions(container, permissions) {
  return (container.permissions || []).filter(
    (field) => permissions[field] && permissions[field].powerful
  );
}

/** Conteneur fourni par un package (namespace) : ni supprimable ni modifiable. */
export function isPackaged(container) {
  return Boolean(container.namespace);
}

/** Permission set « classique » (ni groupe, ni muting, ni fourni par Salesforce). */
export function isRegularPermissionSet(container) {
  return (
    container.kind === KIND_PERMISSION_SET &&
    container.type !== "Standard" &&
    !isPackaged(container)
  );
}

/** Part de droits objet communs (Jaccard sur « objet:lettres »). */
export function similarity(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size && !b.size) {
    return 1;
  }
  let common = 0;
  a.forEach((entry) => {
    if (b.has(entry)) {
      common++;
    }
  });
  return common / (a.size + b.size - common);
}

function samePermissions(a, b) {
  const left = [...(a.permissions || [])].sort().join(",");
  const right = [...(b.permissions || [])].sort().join(",");
  return left === right;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function users(n) {
  return `${n} active user${n === 1 ? "" : "s"}`;
}

// ---------- Constats ----------

function finding(key, element, detail, extra = {}) {
  const rule = RULES[key];
  return {
    id: `${key}|${element}`,
    key,
    rule: `SECURITY_PERM_${key}`,
    title: rule.title,
    severity: extra.severity || rule.severity,
    advice: rule.advice,
    element,
    detail,
    containerIds: extra.containerIds || [],
    affected: extra.affected || []
  };
}

/**
 * Constats de l'analyse, du plus grave au moins grave. Les règles qui comparent les droits objet
 * (profils quasi identiques, doublons) ne sont évaluées que si les droits objet sont lus.
 */
export function computeFindings(analysis) {
  const overview = analysis && analysis.overview;
  if (!overview) {
    return [];
  }
  const containers = overview.containers || [];
  const permissions = permissionIndex(overview);
  const access = analysis.objectAccess || {};
  const hasAccess = Boolean(analysis.objectAccessComplete);
  const activeUsers = overview.activeUsers || 0;
  const results = [];

  const profiles = containers.filter((c) => c.kind === KIND_PROFILE);
  const permissionSets = containers.filter(isRegularPermissionSet);
  const groups = containers.filter(
    (c) => c.kind === KIND_GROUP && !isPackaged(c)
  );

  profiles.forEach((p) => {
    if (p.isCustom && !p.activeUsers) {
      results.push(
        finding(
          "UNUSED_PROFILE",
          p.name,
          `${p.license || "Unknown license"}${p.lastModified ? ` · last modified ${String(p.lastModified).slice(0, 10)}` : ""}`,
          { containerIds: [p.id] }
        )
      );
    }
    const powers = powerfulPermissions(p, permissions);
    const limit = Math.max(
      THRESHOLDS.powerfulUsers,
      Math.round(activeUsers * THRESHOLDS.powerfulShare)
    );
    if (powers.length && p.activeUsers > limit) {
      const labels = powers.map((field) => permissions[field].label);
      results.push(
        finding(
          "POWERFUL_PROFILE",
          p.name,
          `${users(p.activeUsers)} · ${labels.join(", ")}`,
          {
            containerIds: [p.id],
            severity: powers.includes("PermissionsModifyAllData")
              ? "High"
              : "Medium",
            affected: labels
          }
        )
      );
    }
  });

  permissionSets.forEach((ps) => {
    const inGroup = (ps.groups || []).length > 0;
    if (!ps.activeUsers && !ps.inactiveUsers && !inGroup) {
      results.push(
        finding(
          "UNASSIGNED_PS",
          ps.name,
          `${ps.apiName}${ps.license ? ` · ${ps.license}` : ""}`,
          { containerIds: [ps.id] }
        )
      );
    } else if (!ps.activeUsers && ps.inactiveUsers && !inGroup) {
      results.push(
        finding(
          "INACTIVE_ONLY_PS",
          ps.name,
          `${ps.inactiveUsers} inactive user(s), no active user`,
          { containerIds: [ps.id] }
        )
      );
    }
  });

  groups.forEach((g) => {
    if (!(g.components || []).length) {
      results.push(
        finding("EMPTY_GROUP", g.name, g.apiName, { containerIds: [g.id] })
      );
    } else if (g.status && g.status !== "Updated") {
      results.push(
        finding("OUTDATED_GROUP", g.name, `Status: ${g.status}`, {
          containerIds: [g.id]
        })
      );
    }
  });

  if (hasAccess) {
    // Profils quasi identiques : même licence, mêmes permissions clés, droits objet proches
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i];
        const b = profiles[j];
        if (
          (!a.isCustom && !b.isCustom) ||
          a.license !== b.license ||
          !samePermissions(a, b)
        ) {
          continue;
        }
        const score = similarity(access[a.id], access[b.id]);
        if (score >= THRESHOLDS.similarity) {
          const [first, second] = [a.name, b.name].sort();
          results.push(
            finding(
              "SIMILAR_PROFILES",
              `${first} ↔ ${second}`,
              `${percent(score)} identical object access · same key system permissions · ${a.license || "same license"}`,
              { containerIds: [a.id, b.id], affected: [first, second] }
            )
          );
        }
      }
    }
    // Permission sets en doublon : mêmes permissions clés et mêmes droits objet (non vides)
    const bySignature = {};
    permissionSets.forEach((ps) => {
      const entries = access[ps.id] || [];
      if (!entries.length) {
        return;
      }
      const signature = `${[...(ps.permissions || [])].sort().join(",")}|${[...entries].sort().join(",")}`;
      (bySignature[signature] = bySignature[signature] || []).push(ps);
    });
    Object.values(bySignature).forEach((list) => {
      if (list.length < 2) {
        return;
      }
      const names = list.map((ps) => ps.name).sort();
      results.push(
        finding(
          "DUPLICATE_PS",
          names.join(" ↔ "),
          `${list.length} permission sets with the same object access and key system permissions (field access not compared)`,
          { containerIds: list.map((ps) => ps.id), affected: names }
        )
      );
    });
  }

  const usersData = analysis.users;
  if (usersData) {
    const many = (usersData.top || []).filter(
      (u) =>
        (u.permissionSets || 0) + (u.groups || 0) >
        THRESHOLDS.manyPermissionSets
    );
    if (many.length) {
      results.push(
        finding(
          "MANY_PERMISSION_SETS",
          "Org",
          `${many.length} active user(s) with more than ${THRESHOLDS.manyPermissionSets} permission sets and groups`,
          {
            affected: many.map(
              (u) =>
                `${u.name} — ${u.permissionSets} permission set(s), ${u.groups} group(s)`
            )
          }
        )
      );
    }
  }

  const strategy = strategyMetrics(analysis);
  if (
    strategy.profileShare !== null &&
    strategy.profileShare >= THRESHOLDS.profileShare
  ) {
    results.push(
      finding(
        "PROFILE_CENTRIC",
        "Org",
        `${percent(strategy.profileShare)} of the object access of the containers in use comes from profiles${
          strategy.profileOnlyShare !== null
            ? ` · ${percent(strategy.profileOnlyShare)} of internal users have no permission set`
            : ""
        }`
      )
    );
  }

  return results.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.title.localeCompare(b.title) ||
      a.element.localeCompare(b.element)
  );
}

/**
 * Stratégie « profil minimal + permission sets » : part des droits objet portée par les profils
 * utilisés (au moins un utilisateur actif) face aux permission sets et groupes assignés, et part des
 * utilisateurs internes sans permission set.
 */
export function strategyMetrics(analysis) {
  const overview = analysis && analysis.overview;
  const containers = (overview && overview.containers) || [];
  let fromProfiles = 0;
  let fromSets = 0;
  containers.forEach((c) => {
    if (!c.activeUsers) {
      return;
    }
    if (c.kind === KIND_PROFILE) {
      fromProfiles += c.objectCount || 0;
    } else if (c.kind === KIND_PERMISSION_SET || c.kind === KIND_GROUP) {
      fromSets += c.objectCount || 0;
    }
  });
  const total = fromProfiles + fromSets;
  const usersData = analysis && analysis.users;
  const standard = (overview && overview.activeStandardUsers) || 0;
  return {
    fromProfiles,
    fromSets,
    profileShare: total ? fromProfiles / total : null,
    profileOnlyUsers: usersData ? usersData.profileOnlyUsers : null,
    profileOnlyShare:
      usersData && standard ? usersData.profileOnlyUsers / standard : null
  };
}

// ---------- Recommandations ----------

/** Comme String.abbreviate d'Apex. */
export function abbreviate(value, max) {
  const text = value || "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** Spécification d'OrgRecommendation__c d'un constat (empreinte = règle + élément). */
export function recommendationSpec(item, detectedAt) {
  const rule = abbreviate(item.rule, 40);
  return {
    Fingerprint__c: abbreviate(`${rule}|${item.element}`, 255),
    RuleCode__c: rule,
    Title__c: abbreviate(`Permissions: ${item.title} — ${item.element}`, 255),
    Description__c: item.detail,
    SuggestedAction__c: item.advice,
    Category__c: "Security",
    Confidence__c: "High",
    ComponentName__c: abbreviate(item.element, 255),
    AffectedComponents__c: (item.affected || []).join("\n"),
    LastDetectedAt__c: detectedAt,
    StillDetected__c: true,
    Severity__c: item.severity
  };
}

// ---------- Matrices ----------

/** Objets présents dans les droits objet lus, triés. */
export function objectNames(objectAccess) {
  const names = new Set();
  Object.values(objectAccess || {}).forEach((entries) => {
    (entries || []).forEach((entry) => {
      const index = entry.lastIndexOf(":");
      if (index > 0) {
        names.add(entry.slice(0, index));
      }
    });
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Lettres de droits d'un conteneur sur un objet (« » si aucun). */
export function objectFlags(objectAccess, containerId, objectName) {
  const prefix = `${objectName}:`;
  const entry = ((objectAccess || {})[containerId] || []).find((e) =>
    e.startsWith(prefix)
  );
  return entry ? entry.slice(prefix.length) : "";
}
