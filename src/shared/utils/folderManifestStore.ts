const DB_NAME = "bloom.folderManifest";
const DB_VERSION = 1;
const STORE_NAME = "views";
const INDEX_PUBKEY = "by_pubkey";
const INDEX_SCOPE = "by_pubkey_scope";
const BASE_MAX_VIEWS_PER_SCOPE = 24;

type JSONObject = Record<string, unknown>;

type StoredViewRecord = {
  id: string;
  pubkey: string;
  scopeKey: string;
  parentPath: string;
  updatedAt: number;
  items: JSONObject[];
  pubkeyScope: string;
};

const viewId = (pubkey: string, scopeKey: string, parentPath: string) =>
  `${pubkey}::${scopeKey}::${parentPath || ""}`;

export const scopePathKey = (scopeKey: string, parentPath: string) =>
  `${scopeKey}::${parentPath || ""}`;

export type ManifestStats = {
  viewCount: number;
  itemCount: number;
  approxBytes: number;
  lastUpdatedAt?: number;
};

let openDbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (openDbPromise) {
    return openDbPromise;
  }
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  openDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex(INDEX_PUBKEY, "pubkey", { unique: false });
        store.createIndex(INDEX_SCOPE, "pubkeyScope", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return openDbPromise;
};

const withDb = async <T>(callback: (db: IDBDatabase) => Promise<T>): Promise<T> => {
  const db = await openDb();
  return callback(db);
};

const supportsStructuredClone = typeof structuredClone === "function";

const cloneItem = (item: JSONObject): JSONObject => {
  if (supportsStructuredClone) {
    return structuredClone(item);
  }
  return JSON.parse(JSON.stringify(item)) as JSONObject;
};

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction error"));
  });

export const loadManifestViews = async (pubkey: string): Promise<Map<string, JSONObject[]>> => {
  return withDb(async db => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(INDEX_PUBKEY);
    const request = index.getAll(pubkey);
    const views = new Map<string, JSONObject[]>();
    const records: StoredViewRecord[] = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as StoredViewRecord[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    records.forEach(record => {
      const key = scopePathKey(record.scopeKey, record.parentPath);
      views.set(key, record.items.map(cloneItem));
    });
    await transactionDone(tx);
    return views;
  });
};

type ScopeUsageMetrics = {
  viewCount: number;
  totalItems: number;
  approxBytes: number;
};

const gatherScopeMetrics = async (
  index: IDBIndex,
  pubkeyScope: string,
): Promise<ScopeUsageMetrics> =>
  new Promise((resolve, reject) => {
    const metrics: ScopeUsageMetrics = {
      viewCount: 0,
      totalItems: 0,
      approxBytes: 0,
    };
    const cursor = index.openCursor(IDBKeyRange.only(pubkeyScope));
    cursor.onsuccess = () => {
      const result = cursor.result as IDBCursorWithValue | null;
      if (!result) {
        resolve(metrics);
        return;
      }
      const record = result.value as StoredViewRecord;
      metrics.viewCount += 1;
      if (Array.isArray(record.items)) {
        metrics.totalItems += record.items.length;
      }
      metrics.approxBytes += estimateSerializedBytes(record);
      result.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed"));
  });

const resolveMaxViewsForScope = (stats: ScopeUsageMetrics) => {
  const base = BASE_MAX_VIEWS_PER_SCOPE;
  if (stats.viewCount <= base) return base;
  const weightedSize = stats.approxBytes / Math.max(1, stats.viewCount);
  const sizeFactor = weightedSize > 6_000 ? 0.5 : weightedSize > 3_500 ? 0.75 : 1;
  const itemFactor =
    stats.totalItems / Math.max(1, stats.viewCount) > 40 ? 0.6 : stats.totalItems > 20 ? 0.8 : 1;
  const adaptive = Math.round(base * Math.min(sizeFactor, itemFactor));
  const upperBound = Math.max(base, Math.min(96, base + Math.floor(stats.viewCount / 3)));
  return Math.max(base, Math.min(upperBound, adaptive || base));
};

export const writeManifestView = async (
  pubkey: string,
  scopeKey: string,
  parentPath: string,
  items: JSONObject[],
): Promise<void> => {
  return withDb(async db => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const pubkeyScope = `${pubkey}::${scopeKey}`;
    const record: StoredViewRecord = {
      id: viewId(pubkey, scopeKey, parentPath),
      pubkey,
      scopeKey,
      parentPath,
      updatedAt: Date.now(),
      items: items.map(cloneItem),
      pubkeyScope,
    };
    store.put(record);
    const index = store.index(INDEX_SCOPE);
    const metrics = await gatherScopeMetrics(index, pubkeyScope);
    const limit = resolveMaxViewsForScope(metrics);
    if (metrics.viewCount > limit) {
      const allRequest = index.getAll(pubkeyScope);
      const records: StoredViewRecord[] = await new Promise((resolve, reject) => {
        allRequest.onsuccess = () => resolve((allRequest.result as StoredViewRecord[]) ?? []);
        allRequest.onerror = () => reject(allRequest.error ?? new Error("IndexedDB read failed"));
      });
      if (records.length > limit) {
        const sorted = records.sort((a, b) => b.updatedAt - a.updatedAt);
        const excess = sorted.slice(limit);
        excess.forEach(entry => store.delete(entry.id));
      }
    }
    await transactionDone(tx);
  });
};

export const clearManifestForPubkey = async (pubkey: string): Promise<void> => {
  return withDb(async db => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(INDEX_PUBKEY);
    const request = index.getAll(pubkey);
    const records: StoredViewRecord[] = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as StoredViewRecord[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    records.forEach(record => store.delete(record.id));
    await transactionDone(tx);
  });
};

export const resetManifestStore = async (): Promise<void> => {
  if (typeof indexedDB === "undefined") return;
  if (openDbPromise) {
    openDbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = () =>
      reject(deleteRequest.error ?? new Error("IndexedDB delete failed"));
  }).catch(() => {
    // Ignore delete failures; store may not exist.
  });
};

const estimateSerializedBytes = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === "string") {
    if (typeof Blob !== "undefined") {
      return new Blob([value]).size;
    }
    return value.length * 2;
  }
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    const json = JSON.stringify(value);
    if (json) {
      if (typeof Blob !== "undefined") {
        return new Blob([json]).size;
      }
      return json.length * 2;
    }
  } catch (error) {
    // Ignore serialization errors and fall through.
  }
  return 0;
};

export const getManifestStats = async (): Promise<ManifestStats | null> => {
  if (typeof indexedDB === "undefined") return null;
  try {
    return await withDb(async db => {
      const stats: ManifestStats = {
        viewCount: 0,
        itemCount: 0,
        approxBytes: 0,
      };
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result as IDBCursorWithValue | null;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as StoredViewRecord;
          stats.viewCount += 1;
          if (Array.isArray(record.items)) {
            stats.itemCount += record.items.length;
          }
          if (typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)) {
            stats.lastUpdatedAt = Math.max(stats.lastUpdatedAt ?? 0, record.updatedAt);
          }
          stats.approxBytes += estimateSerializedBytes(record);
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
      });
      await transactionDone(tx);
      return stats;
    });
  } catch (error) {
    return null;
  }
};
