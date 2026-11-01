/**
 * Stockage navigateur d'Org Intelligence (édition sans objet personnalisé).
 *
 * Tout ce que l'application calcule (scans, audits, analyses, décisions) est gardé dans le
 * navigateur de l'utilisateur, jamais dans l'org : IndexedDB quand il est disponible (grand quota,
 * LWS), sinon localStorage (Locker, environ 5 Mo partagés par toute l'origine Salesforce).
 * Clés préfixées par l'utilisateur : deux comptes sur le même navigateur ne se voient pas.
 *
 * Partage entre administrateurs et historique long : export / import de fichiers JSON
 * (downloadJson, readJsonFile, readJsonEnvelope).
 *
 * API asynchrone dans tous les cas, pour pouvoir changer de support sans toucher aux écrans.
 *
 * Exports :
 * - loadValue(key, fallback) : valeur ou `fallback` si absente. Une valeur **illisible** (erreur du
 *   support) renvoie aussi `fallback`, mais la clé est alors protégée : tout saveValue sur cette clé
 *   lève une StoreError tant qu'une lecture n'a pas réussi (on n'écrase jamais des données qu'on n'a
 *   pas pu lire). Un JSON abîmé est mis de côté dans `<clé>.corrupt` puis la clé redevient libre.
 * - loadValueStrict(key, fallback) : idem mais lève une StoreError si la valeur est illisible.
 * - saveValue(key, value) → taille en octets ; StoreError (message selon la cause, `error.reason` =
 *   « quota » | « unreadable » | « closed » | « serialize » | « unknown »).
 * - removeValue, listKeys(prefix), clearAll(prefix), pushHistory(key, entry, max) (lecture stricte).
 * - storageBackend() : « indexedDB » | « localStorage ».
 * - storageStatus() → { backend, previousBackend, switched, migratedKeys, schemaVersion } :
 *   support actif, bascule détectée depuis la dernière session (données de l'autre support
 *   reprises quand c'est possible).
 * - storageUsage() → [{ key, size }] (octets, approximatif), storageEstimate() → { backend, usage,
 *   quota } (navigator.storage.estimate en IndexedDB, somme des clés × 2 en localStorage).
 * - SCHEMA_VERSION, et la clé `meta.schemaVersion` mise à jour par les migrations au démarrage.
 * - downloadJson(fileName, kind, data) → Promise : enveloppe { format, kind, version, exportedAt,
 *   orgId, orgName, isSandbox, data }.
 * - readJsonFile(file, kind) → data ; readJsonEnvelope(file, kind) → { data, kind, version,
 *   exportedAt, orgId, orgName, isSandbox, sameOrg } (sameOrg : true / false / null si inconnu) pour
 *   demander confirmation quand le fichier vient d'une autre org.
 * - currentOrgInfo() → { orgId, orgName, isSandbox } ou null.
 * - storageProtection() → { mode, message } : protection des données sensibles (ci-dessous).
 *
 * Données sensibles (audits Security, analyse des droits `security.*`, contrat et prix
 * `adoption.contract*`) : chiffrées au repos par AES-GCM 256 (Web Crypto), avec une clé générée
 * par utilisateur et par navigateur, **non extractible** (`CryptoKey`, jamais exportée ni lisible
 * par le code), gardée dans IndexedDB hors des clés de données. Chaque valeur a son propre vecteur
 * d'initialisation et est liée à son nom de clé (données additionnelles AES-GCM). Mode « encrypted ».
 * Sans Web Crypto ou sans IndexedDB (Locker), repli « session » : ces clés ne sont gardées que dans
 * sessionStorage (effacées à la fermeture de l'onglet), jamais en clair dans un stockage durable ;
 * `storageProtection().message` donne le texte à afficher. Une valeur qui ne peut plus être
 * déchiffrée (clé perdue : données du site effacées en partie) est supprimée et lue comme absente.
 * L'API (loadValue, saveValue…) ne change pas : le chiffrement est transparent pour les écrans.
 */
import userId from "@salesforce/user/Id";
import getOrgInfo from "@salesforce/apex/OrgIntelligenceController.getOrgInfo";
import { downloadText } from "c/orgIntelUtils";

const PREFIX = "orgIntelligence.store.v1";
const BACKEND_MARKER = `orgIntelligence.storeMeta.backend.${userId}`;
const DB_NAME = "orgIntelligence";
const DB_STORE = "values";
const SCHEMA_KEY = "meta.schemaVersion";

/** Version du format des données gardées (migrations au démarrage, cf. MIGRATIONS). */
export const SCHEMA_VERSION = 2;

/** Clés communes (une clé peut être suffixée, ex. `${STORE_KEYS.FIELD_USAGE}.Account`). */
export const STORE_KEYS = {
  LATEST_SCAN: "scan.latest",
  SCAN_HISTORY: "scan.history",
  RECOMMENDATIONS: "recommendations",
  SECURITY: "security.latest",
  SECURITY_HISTORY: "security.history",
  ADOPTION: "adoption.latest",
  ADOPTION_HISTORY: "adoption.history",
  ADOPTION_CONTRACT: "adoption.contract",
  FIELD_USAGE: "fieldUsage",
  CONTEXT_HUB: "contextHub"
};

export class StoreError extends Error {
  constructor(message, reason = "unknown") {
    super(message);
    this.name = "StoreError";
    this.reason = reason;
  }
}

function fullKey(key) {
  return `${PREFIX}.${userId}.${key}`;
}

function baseKey() {
  return fullKey("");
}

// ---------- Données sensibles : chiffrement ou session ----------

/** Préfixes des clés chiffrées au repos (ou gardées pour la session seulement). */
const PROTECTED_PREFIXES = ["security.", "adoption.contract"];
/** Clé AES de l'utilisateur dans IndexedDB : hors du préfixe des données (jamais listée ni exportée). */
const CRYPTO_KEY_ID = `orgIntelligence.storeKey.v1.${userId}`;
const ENCRYPTED_PREFIX = "oienc1:";

/** Protection des données sensibles : « encrypted » ou « session » (fixée au démarrage). */
const protection = { mode: null };

export const PROTECTION_MESSAGES = {
  encrypted:
    "Security and contract data are encrypted in this browser with a key that cannot be exported.",
  session:
    "Encryption is not available in this browser: security analyses are kept for this browser tab only, and the contract is stored unencrypted. Save them to a file if needed."
};

/**
 * Sans chiffrement possible (mode « session »), seules les analyses de sécurité (recalculables en
 * un clic) restent limitées à la session ; le contrat (saisie de l'utilisateur) reste durable, en
 * clair, avec un avertissement.
 */
const SESSION_FALLBACK_PREFIXES = ["security."];

function isSessionFallbackKey(key) {
  return (
    typeof key === "string" &&
    SESSION_FALLBACK_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function isProtectedKey(key) {
  return (
    typeof key === "string" &&
    PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** Erreur de déchiffrement : valeur irrécupérable (clé perdue ou valeur altérée). */
class DecryptError extends Error {}

function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return window.btoa(binary);
}

function fromBase64(text) {
  const binary = window.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function subtleCrypto() {
  try {
    const cryptoApi = window.crypto;
    return cryptoApi &&
      cryptoApi.subtle &&
      typeof cryptoApi.subtle.encrypt === "function" &&
      typeof cryptoApi.getRandomValues === "function"
      ? cryptoApi.subtle
      : null;
  } catch {
    return null;
  }
}

let cryptoKeyPromise;

/**
 * Clé AES-GCM de l'utilisateur : lue dans IndexedDB, sinon générée (non extractible) puis ajoutée
 * par `add` — si un autre onglet l'a créée entre-temps, l'ajout échoue et on relit la sienne.
 */
function loadCryptoKey(db) {
  if (!cryptoKeyPromise) {
    cryptoKeyPromise = (async () => {
      const subtle = subtleCrypto();
      if (!db || !subtle) {
        return null;
      }
      const existing = await idbGetRaw(db, CRYPTO_KEY_ID);
      if (existing) {
        return existing;
      }
      const generated = await subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      try {
        await idbRequest(db, "readwrite", (store) =>
          store.add(generated, CRYPTO_KEY_ID)
        );
        return generated;
      } catch (error) {
        const winner = await idbGetRaw(db, CRYPTO_KEY_ID);
        if (winner) {
          return winner;
        }
        throw error;
      }
    })().catch(() => {
      // CryptoKey non stockable (Locker, navigation privée…) : repli session
      cryptoKeyPromise = undefined;
      return null;
    });
  }
  return cryptoKeyPromise;
}

async function encryptText(cryptoKey, key, plain) {
  const subtle = subtleCrypto();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(fullKey(key)) },
    cryptoKey,
    encoder.encode(plain)
  );
  return `${ENCRYPTED_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

async function decryptText(cryptoKey, key, stored) {
  try {
    const [ivText, cipherText] = stored
      .substring(ENCRYPTED_PREFIX.length)
      .split(":");
    const plain = await subtleCrypto().decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(ivText),
        additionalData: new TextEncoder().encode(fullKey(key))
      },
      cryptoKey,
      fromBase64(cipherText)
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new DecryptError(`"${key}" cannot be decrypted`);
  }
}

/** sessionStorage, ou une table en mémoire si le navigateur le refuse. */
const memorySession = new Map();

function sessionGet(key) {
  try {
    return window.sessionStorage.getItem(fullKey(key));
  } catch {
    return memorySession.has(key) ? memorySession.get(key) : null;
  }
}

function sessionSet(key, value) {
  try {
    window.sessionStorage.setItem(fullKey(key), value);
  } catch (error) {
    if (error && error.name === "QuotaExceededError") {
      throw error;
    }
    memorySession.set(key, value);
  }
}

function sessionDelete(key) {
  memorySession.delete(key);
  try {
    window.sessionStorage.removeItem(fullKey(key));
  } catch {
    // sessionStorage indisponible
  }
}

function sessionKeys() {
  const keys = new Set(memorySession.keys());
  const base = baseKey();
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const full = window.sessionStorage.key(i);
      if (typeof full === "string" && full.startsWith(base)) {
        keys.add(full.substring(base.length));
      }
    }
  } catch {
    // sessionStorage indisponible
  }
  return [...keys];
}

/** Message lisible selon la cause de l'erreur du support. */
function storeErrorFrom(error, action) {
  const name = (error && error.name) || "";
  if (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    (error && error.code === 22)
  ) {
    return new StoreError(
      "Your browser storage is full: export your data to a file, then clear older results in Settings.",
      "quota"
    );
  }
  if (name === "InvalidStateError" || name === "TransactionInactiveError") {
    return new StoreError(
      `The browser database was closed while ${action}: reload the page and try again.`,
      "closed"
    );
  }
  if (name === "DataCloneError" || name === "TypeError") {
    return new StoreError(
      `This data could not be saved (${name}).`,
      "serialize"
    );
  }
  if (name === "AbortError") {
    return new StoreError(
      `The browser cancelled the operation while ${action}: reload the page and try again.`,
      "aborted"
    );
  }
  return new StoreError(
    `Browser storage error while ${action}${name ? ` (${name})` : ""}.`,
    "unknown"
  );
}

// ---------- IndexedDB ----------

let dbPromise;

/** Base IndexedDB, ou null si le navigateur ou Locker ne la fournit pas. */
function openDb() {
  if (dbPromise !== undefined) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    try {
      const factory = window.indexedDB;
      if (!factory || typeof factory.open !== "function") {
        resolve(null);
        return;
      }
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Une autre version ouverte ailleurs : on rend la main proprement
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/**
 * Requête dans une transaction : résout sur `oncomplete` (données réellement écrites), rejette sur
 * `onabort` / `onerror` (quota dépassé, annulation), qui arrivent après `request.onsuccess`.
 */
function idbRequest(db, mode, operation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    try {
      const transaction = db.transaction(DB_STORE, mode);
      const request = operation(transaction.objectStore(DB_STORE));
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      transaction.onabort = () =>
        fail(transaction.error || request.error || new Error("AbortError"));
      transaction.onerror = () => fail(transaction.error || request.error);
    } catch (error) {
      fail(error);
    }
  });
}

// ---------- Accès bruts (chaînes) ----------

/** Lecture IndexedDB par identifiant complet (clé AES comprise). */
async function idbGetRaw(db, id) {
  const value = await idbRequest(db, "readonly", (store) => store.get(id));
  return value === undefined ? null : value;
}

/** Clé sensible en mode session : jamais dans un stockage durable. */
function sessionOnly(key) {
  return protection.mode === "session" && isSessionFallbackKey(key);
}

async function rawGet(db, key) {
  if (sessionOnly(key)) {
    return sessionGet(key);
  }
  if (db) {
    return idbGetRaw(db, fullKey(key));
  }
  return window.localStorage.getItem(fullKey(key));
}

async function rawSet(db, key, serialized) {
  if (sessionOnly(key)) {
    sessionSet(key, serialized);
  } else if (db) {
    await idbRequest(db, "readwrite", (store) =>
      store.put(serialized, fullKey(key))
    );
  } else {
    window.localStorage.setItem(fullKey(key), serialized);
  }
}

/** Supprime la valeur du support durable (et de la session pour une clé sensible). */
async function rawDelete(db, key) {
  if (isProtectedKey(key)) {
    sessionDelete(key);
  }
  if (db) {
    await idbRequest(db, "readwrite", (store) => store.delete(fullKey(key)));
  } else {
    window.localStorage.removeItem(fullKey(key));
  }
}

/** Clés du support durable seul (sans la session). */
async function persistentKeys(db) {
  let keys;
  if (db) {
    keys = await idbRequest(db, "readonly", (store) => store.getAllKeys());
  } else {
    keys = localStorageKeys();
  }
  const base = baseKey();
  return keys
    .filter((key) => typeof key === "string" && key.startsWith(base))
    .map((key) => key.substring(base.length));
}

async function rawKeys(db) {
  const keys = await persistentKeys(db);
  if (protection.mode !== "session") {
    return keys;
  }
  // Mode session : les clés sensibles viennent de la session (les valeurs chiffrées d'une session
  // précédente restent dans le support durable, illisibles ici, et ne sont pas listées)
  return [
    ...keys.filter((key) => !isSessionFallbackKey(key)),
    ...sessionKeys().filter((key) => isSessionFallbackKey(key))
  ];
}

/** Lecture d'une valeur sérialisée, déchiffrée si besoin (DecryptError si irrécupérable). */
async function readSerialized(db, key) {
  const raw = await rawGet(db, key);
  if (
    raw === null ||
    raw === undefined ||
    typeof raw !== "string" ||
    !raw.startsWith(ENCRYPTED_PREFIX)
  ) {
    // Valeur en clair : données non sensibles, ou valeur sensible écrite avant le chiffrement
    // (rechiffrée au démarrage, cf. encryptLegacyValues)
    return raw;
  }
  const cryptoKey = await loadCryptoKey(db);
  if (!cryptoKey) {
    throw new DecryptError(`"${key}" cannot be decrypted in this session`);
  }
  return decryptText(cryptoKey, key, raw);
}

/** Écriture d'une valeur sérialisée, chiffrée si la clé est sensible. */
async function writeSerialized(db, key, serialized) {
  if (isProtectedKey(key) && protection.mode === "encrypted") {
    const cryptoKey = await loadCryptoKey(db);
    if (!cryptoKey) {
      throw new StoreError(
        "Encryption is no longer available: reload the page and try again.",
        "unknown"
      );
    }
    await rawSet(db, key, await encryptText(cryptoKey, key, serialized));
    return;
  }
  await rawSet(db, key, serialized);
}

function localStorageKeys() {
  const keys = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      keys.push(window.localStorage.key(i));
    }
  } catch {
    // localStorage refusé (navigation privée stricte)
  }
  return keys;
}

// ---------- Démarrage : support, bascule, migrations ----------

const status = {
  backend: null,
  previousBackend: null,
  switched: false,
  migratedKeys: 0,
  schemaVersion: SCHEMA_VERSION,
  protection: null
};

/**
 * Migrations du format, de la version N vers N + 1. Chaque migration est idempotente.
 * 1 → 2 : le dernier scan est découpé en plusieurs clés (orgIntelScanData) ; l'ancien format
 * (composants et constats dans `scan.latest`) reste lisible tel quel, rien à réécrire ici.
 */
const MIGRATIONS = {
  1: async () => {}
};

let readyPromise;

function ready() {
  if (!readyPromise) {
    readyPromise = initialize();
  }
  return readyPromise;
}

async function initialize() {
  const db = await openDb();
  status.backend = db ? "indexedDB" : "localStorage";
  try {
    status.previousBackend = window.localStorage.getItem(BACKEND_MARKER);
  } catch {
    status.previousBackend = null;
  }
  status.switched = Boolean(
    status.previousBackend && status.previousBackend !== status.backend
  );
  // Avant toute migration : décide où vont les clés sensibles
  protection.mode = (await loadCryptoKey(db)) ? "encrypted" : "session";
  status.protection = protection.mode;
  if (db) {
    // Données restées dans localStorage (session précédente sous Locker, IndexedDB bloqué…)
    status.migratedKeys = await migrateFromLocalStorage(db);
  }
  try {
    window.localStorage.setItem(BACKEND_MARKER, status.backend);
  } catch {
    // marqueur facultatif
  }
  await protectLegacyValues(db);
  await runSchemaMigrations(db);
  return db;
}

/**
 * Valeurs sensibles écrites en clair avant le chiffrement (ou par une session sans Web Crypto) :
 * chiffrées en mode « encrypted » ; en mode « session », déplacées du support durable vers la
 * session (rien de sensible ne reste en clair sur le disque). Idempotent.
 */
async function protectLegacyValues(db) {
  let keys;
  try {
    keys = (await persistentKeys(db)).filter(isProtectedKey);
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      const stored = db
        ? // eslint-disable-next-line no-await-in-loop
          await idbGetRaw(db, fullKey(key))
        : window.localStorage.getItem(fullKey(key));
      if (typeof stored !== "string" || stored.startsWith(ENCRYPTED_PREFIX)) {
        continue;
      }
      if (protection.mode === "encrypted") {
        // eslint-disable-next-line no-await-in-loop
        await writeSerialized(db, key, stored);
      } else if (isSessionFallbackKey(key)) {
        if (sessionGet(key) === null) {
          sessionSet(key, stored);
        }
        if (db) {
          // eslint-disable-next-line no-await-in-loop
          await idbRequest(db, "readwrite", (store) =>
            store.delete(fullKey(key))
          );
        } else {
          window.localStorage.removeItem(fullKey(key));
        }
      }
    } catch {
      // nouvelle tentative au prochain démarrage
    }
  }
}

async function migrateFromLocalStorage(db) {
  const base = baseKey();
  const legacy = localStorageKeys().filter(
    (key) => typeof key === "string" && key.startsWith(base)
  );
  let migrated = 0;
  for (const full of legacy) {
    const key = full.substring(base.length);
    try {
      // eslint-disable-next-line no-await-in-loop
      const existing = await rawGet(db, key);
      const value = window.localStorage.getItem(full);
      if (existing === null && value !== null) {
        // eslint-disable-next-line no-await-in-loop
        await rawSet(db, key, value);
        migrated++;
      }
      window.localStorage.removeItem(full);
    } catch {
      // clé laissée dans localStorage : nouvelle tentative au prochain démarrage
    }
  }
  return migrated;
}

async function runSchemaMigrations(db) {
  try {
    const raw = await rawGet(db, SCHEMA_KEY);
    let version = raw === null ? 1 : Number(JSON.parse(raw)) || 1;
    while (version < SCHEMA_VERSION) {
      const migrate = MIGRATIONS[version];
      if (migrate) {
        // eslint-disable-next-line no-await-in-loop
        await migrate(db);
      }
      version++;
    }
    // Données écrites par une version plus récente : jamais rétrogradées (la version reste notée)
    if (raw === null || Number(JSON.parse(raw)) < SCHEMA_VERSION) {
      await rawSet(db, SCHEMA_KEY, JSON.stringify(SCHEMA_VERSION));
    }
    status.schemaVersion = version;
  } catch {
    // migration rejouée au prochain démarrage
  }
}

/** Support utilisé : « indexedDB » ou « localStorage ». */
export async function storageBackend() {
  await ready();
  return status.backend;
}

/** Support actif, support de la session précédente et bascule éventuelle. */
export async function storageStatus() {
  await ready();
  return { ...status };
}

/**
 * Protection des données sensibles (`security.*`, `adoption.contract*`) :
 * { mode: « encrypted » | « session », message } — message à afficher discrètement à l'écran.
 */
export async function storageProtection() {
  await ready();
  return {
    mode: protection.mode,
    message: PROTECTION_MESSAGES[protection.mode] || ""
  };
}

// ---------- Lecture / écriture ----------

/** Clés dont la dernière lecture a échoué : jamais écrasées tant qu'une lecture n'a pas réussi. */
const unreadableKeys = new Set();

async function readValue(key, fallback, strict) {
  const db = await ready();
  let raw;
  try {
    raw = await readSerialized(db, key);
  } catch (error) {
    if (error instanceof DecryptError) {
      // Clé de chiffrement perdue ou valeur altérée : irrécupérable, la clé redevient libre
      try {
        await rawDelete(db, key);
      } catch {
        // suppression facultative
      }
      unreadableKeys.delete(key);
      return fallback;
    }
    unreadableKeys.add(key);
    if (strict) {
      throw storeErrorFrom(error, `reading "${key}"`);
    }
    return fallback;
  }
  unreadableKeys.delete(key);
  if (raw === null || raw === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Valeur abîmée : mise de côté pour analyse, la clé redevient libre
    try {
      await writeSerialized(
        db,
        `${key}.corrupt`,
        JSON.stringify(String(raw))
      );
    } catch {
      // copie facultative
    }
    if (strict) {
      throw new StoreError(
        `The data saved under "${key}" is damaged and was set aside.`,
        "unreadable"
      );
    }
    return fallback;
  }
}

export async function loadValue(key, fallback = null) {
  return readValue(key, fallback, false);
}

/** Comme loadValue, mais lève une StoreError si la valeur existe et ne peut pas être lue. */
export async function loadValueStrict(key, fallback = null) {
  return readValue(key, fallback, true);
}

/** Enregistre la valeur ; renvoie sa taille approximative en octets. */
export async function saveValue(key, value) {
  if (unreadableKeys.has(key)) {
    throw new StoreError(
      `The data saved under "${key}" could not be read: it was not overwritten. Reload the page and try again.`,
      "unreadable"
    );
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw storeErrorFrom(error, `preparing "${key}"`);
  }
  if (serialized === undefined) {
    throw new StoreError(`Nothing to save under "${key}".`, "serialize");
  }
  const db = await ready();
  try {
    await writeSerialized(db, key, serialized);
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    throw storeErrorFrom(error, `saving "${key}"`);
  }
  return serialized.length * 2;
}

export async function removeValue(key) {
  const db = await ready();
  try {
    await rawDelete(db, key);
    unreadableKeys.delete(key);
  } catch {
    // rien à supprimer
  }
}

/** Clés (sans préfixe) commençant par `prefix`. */
export async function listKeys(prefix = "") {
  const db = await ready();
  try {
    return (await rawKeys(db)).filter((key) => key.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Taille approximative (octets, chaînes UTF-16) des données gardées, par clé. */
export async function storageUsage() {
  const db = await ready();
  const keys = await listKeys("");
  const rows = [];
  for (const key of keys) {
    let size = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await rawGet(db, key);
      size = raw === null || raw === undefined ? 0 : String(raw).length * 2;
    } catch {
      size = 0;
    }
    rows.push({ key, size });
  }
  return rows.sort((a, b) => b.size - a.size);
}

/** Place utilisée et quota (octets, null si inconnus). */
export async function storageEstimate() {
  await ready();
  if (status.backend === "indexedDB") {
    try {
      if (
        navigator.storage &&
        typeof navigator.storage.estimate === "function"
      ) {
        const estimate = await navigator.storage.estimate();
        return {
          backend: status.backend,
          usage: estimate.usage === undefined ? null : estimate.usage,
          quota: estimate.quota === undefined ? null : estimate.quota
        };
      }
    } catch {
      // repli ci-dessous
    }
  }
  const usage = (await storageUsage()).reduce((sum, row) => sum + row.size, 0);
  return {
    backend: status.backend,
    usage,
    // environ 5 Mo de caractères UTF-16 par origine en localStorage
    quota: status.backend === "localStorage" ? 10 * 1024 * 1024 : null
  };
}

/** Supprime toutes les données Org Intelligence de l'utilisateur dans ce navigateur. */
export async function clearAll(prefix = "") {
  const keys = await listKeys(prefix);
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    await removeValue(key);
  }
  return keys.length;
}

/** Ajoute une entrée en tête d'un historique borné (refuse d'écrire si l'historique est illisible). */
export async function pushHistory(key, entry, max = 24) {
  const loaded = await loadValueStrict(key, []);
  const history = Array.isArray(loaded) ? loaded : [];
  history.unshift(entry);
  while (history.length > max) {
    history.pop();
  }
  await saveValue(key, history);
  return history;
}

// ---------- Org courante ----------

let orgInfo = null;
let orgInfoPromise;

function loadOrgInfo() {
  if (!orgInfoPromise) {
    orgInfoPromise = getOrgInfo()
      .then((info) => {
        orgInfo = info
          ? {
              orgId: info.orgId || null,
              orgName: info.orgName || null,
              isSandbox: info.isSandbox === true
            }
          : null;
        return orgInfo;
      })
      .catch(() => {
        orgInfoPromise = undefined; // nouvel essai au prochain export
        return null;
      });
  }
  return orgInfoPromise;
}

/** Identité de l'org courante (null tant qu'elle n'est pas chargée ou si l'appel échoue). */
export async function currentOrgInfo() {
  return orgInfo || loadOrgInfo();
}

// ---------- Fichiers ----------

export const FILE_FORMAT = "org-intelligence";
/** Version du format des fichiers exportés ; un fichier plus récent est refusé à l'import. */
export const FILE_VERSION = 2;

function writeJson(fileName, kind, data, info) {
  const payload = {
    format: FILE_FORMAT,
    kind,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    orgId: info ? info.orgId : null,
    orgName: info ? info.orgName : null,
    isSandbox: info ? info.isSandbox : null,
    data
  };
  downloadText(fileName, JSON.stringify(payload, null, 2), "application/json");
}

/**
 * Télécharge un fichier JSON enveloppé (type, version, date, org) pour le réimporter plus tard.
 * Téléchargement immédiat quand l'org est déjà connue ; sinon après son chargement (2 s au plus).
 */
export function downloadJson(fileName, kind, data) {
  if (orgInfo) {
    writeJson(fileName, kind, data, orgInfo);
    return Promise.resolve();
  }
  const timeout = new Promise((resolve) => {
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(() => resolve(null), 2000);
  });
  return Promise.race([loadOrgInfo(), timeout]).then((info) => {
    writeJson(fileName, kind, data, info);
  });
}

// Chargé tôt pour que le premier export soit immédiat
loadOrgInfo();

const STORE_KEY_PREFIXES = [
  "scan.",
  "app.",
  "recommendations",
  "security.",
  "adoption.",
  "fieldUsage",
  "contextHub",
  "meta.",
  "inventory",
  "roadmap"
];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Contrôle minimal d'un JSON brut (sans enveloppe) par type : seul un contenu de la bonne forme
 * est accepté, sinon n'importe quel fichier deviendrait des recommandations ou des clés.
 */
const RAW_VALIDATORS = {
  scan: (data) =>
    isObject(data) &&
    typeof data.id === "string" &&
    Array.isArray(data.findings),
  recommendations: (data) => {
    const list = Array.isArray(data)
      ? data
      : isObject(data) && data.recommendations;
    return (
      Array.isArray(list) &&
      list.length > 0 &&
      list.every(
        (rec) => isObject(rec) && typeof rec.Fingerprint__c === "string"
      )
    );
  },
  "security-audit": (data) => isObject(data) && isObject(data.audit),
  adoption: (data) =>
    isObject(data) &&
    (Array.isArray(data.contract) ||
      isObject(data.analysis) ||
      Array.isArray(data.history)),
  fieldUsage: (data) => isObject(data) && isObject(data.objects),
  browserData: (data) =>
    isObject(data) &&
    Object.keys(data).length > 0 &&
    Object.keys(data).every((key) =>
      STORE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    )
};

function parseEnvelope(text, expectedKind) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new StoreError("This file is not a valid JSON file.", "serialize");
  }
  if (payload && payload.format === FILE_FORMAT) {
    if (expectedKind && payload.kind !== expectedKind) {
      throw new StoreError(
        `This file contains "${payload.kind}", not "${expectedKind}".`,
        "kind"
      );
    }
    const version = Number(payload.version) || 1;
    if (version > FILE_VERSION) {
      throw new StoreError(
        "This file was exported by a newer version of Org Intelligence: update the application first.",
        "version"
      );
    }
    return {
      data: payload.data,
      kind: payload.kind,
      version,
      exportedAt: payload.exportedAt || null,
      orgId: payload.orgId || null,
      orgName: payload.orgName || null,
      isSandbox:
        payload.isSandbox === undefined || payload.isSandbox === null
          ? null
          : payload.isSandbox === true
    };
  }
  // JSON brut : accepté seulement s'il a la forme attendue pour ce type
  const validate = expectedKind ? RAW_VALIDATORS[expectedKind] : null;
  if (!validate || !validate(payload)) {
    throw new StoreError(
      expectedKind
        ? `This file was not exported by Org Intelligence and does not look like "${expectedKind}" data.`
        : "This file was not exported by Org Intelligence.",
      "kind"
    );
  }
  return {
    data: payload,
    kind: expectedKind,
    version: 0,
    exportedAt: null,
    orgId: null,
    orgName: null,
    isSandbox: null
  };
}

function readText(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new StoreError("Choose a file to import.", "file"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new StoreError("The file could not be read.", "file"));
    reader.readAsText(file);
  });
}

/**
 * Lit un fichier exporté et renvoie l'enveloppe complète : { data, kind, version, exportedAt,
 * orgId, orgName, isSandbox, sameOrg } — sameOrg vaut false si le fichier vient d'une autre org
 * (à faire confirmer par l'utilisateur), null si l'une des deux orgs est inconnue.
 */
export async function readJsonEnvelope(file, expectedKind) {
  const text = await readText(file);
  const envelope = parseEnvelope(text, expectedKind);
  const info = await currentOrgInfo();
  envelope.sameOrg =
    envelope.orgId && info && info.orgId
      ? envelope.orgId.substring(0, 15) === info.orgId.substring(0, 15)
      : null;
  return envelope;
}

/** Lit un fichier choisi par l'utilisateur (input type=file) et renvoie `data` s'il est du bon type. */
export async function readJsonFile(file, expectedKind) {
  const text = await readText(file);
  return parseEnvelope(text, expectedKind).data;
}
