const DB_NAME = "bloom.cache";
const STORE_NAME = "kv";
const META_STORE_NAME = "meta";
const DB_VERSION = 2;
const CACHE_SCHEMA_VERSION = 2;
const META_SCHEMA_KEY = "schema";
const CACHE_ENTRY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const COMPACTION_INTERVAL_MS = 1000 * 60 * 60 * 6; // 6 hours

type KvRecord = {
  key: string;
  value: unknown;
  updatedAt: number;
};

type SchemaRecord = {
  key: typeof META_SCHEMA_KEY;
  version: number;
  lastCompactedAt?: number | null;
};

let openPromise: Promise<IDBDatabase> | null = null;
let lastCompactionCheck = 0;
let lastCompactedAt = 0;
let compactionInFlight = false;
let initialCompactionScheduled = false;

const initializeSchema = (db: IDBDatabase): Promise<void> =>
  new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Failed to open cache schema transaction"));
      return;
    }
    const metaStore = tx.objectStore(META_STORE_NAME);
    const getRequest = metaStore.get(META_SCHEMA_KEY);
    getRequest.onsuccess = () => {
      const record = (getRequest.result as SchemaRecord | undefined) ?? null;
      if (!record || record.version !== CACHE_SCHEMA_VERSION) {
        lastCompactedAt = 0;
        metaStore.put({
          key: META_SCHEMA_KEY,
          version: CACHE_SCHEMA_VERSION,
          lastCompactedAt,
        } satisfies SchemaRecord);
        tx.objectStore(STORE_NAME).clear();
      } else {
        lastCompactedAt =
          typeof record.lastCompactedAt === "number" && Number.isFinite(record.lastCompactedAt)
            ? record.lastCompactedAt
            : 0;
      }
    };
    getRequest.onerror = () =>
      reject(getRequest.error ?? new Error("IndexedDB schema read failed"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB schema transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB schema transaction aborted"));
  });

const scheduleInitialCompaction = () => {
  if (initialCompactionScheduled) return;
  initialCompactionScheduled = true;
  if (typeof window === "undefined") {
    triggerCompactionIfNeeded();
  } else {
    window.setTimeout(() => triggerCompactionIfNeeded(), 1500);
  }
};

const triggerCompactionIfNeeded = () => {
  const now = Date.now();
  if (compactionInFlight) return;
  if (now - lastCompactionCheck < COMPACTION_INTERVAL_MS) return;
  lastCompactionCheck = now;
  const cutoff = now - CACHE_ENTRY_MAX_AGE_MS;
  if (cutoff <= 0) return;
  if (lastCompactedAt && now - lastCompactedAt < COMPACTION_INTERVAL_MS) return;
  compactionInFlight = true;
  void (async () => {
    try {
      const db = await withDb();
      const result = await new Promise<number>((resolve, reject) => {
        try {
          const tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const metaStore = tx.objectStore(META_STORE_NAME);
          let removed = 0;
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result as IDBCursorWithValue | null;
            if (!current) {
              const nowTs = Date.now();
              metaStore.put({
                key: META_SCHEMA_KEY,
                version: CACHE_SCHEMA_VERSION,
                lastCompactedAt: nowTs,
              } satisfies SchemaRecord);
              return;
            }
            const record = current.value as KvRecord;
            if (typeof record.updatedAt === "number" && record.updatedAt < cutoff) {
              current.delete();
              removed += 1;
            }
            current.continue();
          };
          cursor.onerror = () =>
            reject(cursor.error ?? new Error("IndexedDB cursor failed during compaction"));
          tx.oncomplete = () => resolve(removed);
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB compaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB compaction aborted"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Failed to start compaction"));
        }
      });
      lastCompactedAt = Date.now();
      if (result > 0 && typeof console !== "undefined") {
        console.debug?.(`cacheDb: pruned ${result} stale entries`);
      }
    } catch (error) {
      // Ignore compaction errors; we'll retry later.
    } finally {
      compactionInFlight = false;
    }
  })();
};

const withDb = async (): Promise<IDBDatabase> => {
  if (openPromise) return openPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: "key" });
      }
      const upgradeTx = request.transaction;
      if (upgradeTx) {
        const metaStore = upgradeTx.objectStore(META_STORE_NAME);
        metaStore.put({
          key: META_SCHEMA_KEY,
          version: CACHE_SCHEMA_VERSION,
          lastCompactedAt: 0,
        } satisfies SchemaRecord);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      initializeSchema(db)
        .then(() => {
          scheduleInitialCompaction();
          resolve(db);
        })
        .catch(error => {
          try {
            db.close();
          } catch {
            // ignore close failures
          }
          reject(error);
        });
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => {
      // If blocked, we still resolve once existing connections close.
    };
  });
  return openPromise;
};

export const getKv = async <T = unknown>(key: string): Promise<T | undefined> => {
  if (!key) return undefined;
  try {
    const db = await withDb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as KvRecord | undefined;
        resolve(record?.value as T | undefined);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  } catch (error) {
    return undefined;
  }
};

export const setKv = async (key: string, value: unknown): Promise<void> => {
  if (!key) return;
  const db = await withDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const record: KvRecord = { key, value, updatedAt: Date.now() };
    const request = store.put(record);
    request.onsuccess = () => {
      resolve();
      triggerCompactionIfNeeded();
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
  });
};

export const deleteKv = async (key: string): Promise<void> => {
  if (!key) return;
  const db = await withDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(key);
    request.onsuccess = () => {
      resolve();
      triggerCompactionIfNeeded();
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
  });
};

export const getKvKeys = async (prefix?: string): Promise<string[]> => {
  try {
    const db = await withDb();
    return await new Promise<string[]>((resolve, reject) => {
      const keys: string[] = [];
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const record = cursor.value as KvRecord;
          if (!prefix || record.key.startsWith(prefix)) {
            keys.push(record.key);
          }
          cursor.continue();
        } else {
          resolve(keys);
        }
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
    });
  } catch (error) {
    return [];
  }
};

export type KvIteratorOptions = {
  prefix?: string;
  signal?: AbortSignal;
};

export const iterateKvEntries = async (
  callback: (entry: { key: string; value: unknown; updatedAt: number }) => void | Promise<void>,
  options?: KvIteratorOptions,
): Promise<void> => {
  const { prefix, signal } = options ?? {};
  const db = await withDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();
    const handleAbort = () => {
      tx.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
    }
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        if (signal) {
          signal.removeEventListener("abort", handleAbort);
        }
        resolve();
        return;
      }
      const record = cursor.value as KvRecord;
      if (!prefix || record.key.startsWith(prefix)) {
        void Promise.resolve(
          callback({ key: record.key, value: record.value, updatedAt: record.updatedAt }),
        )
          .then(() => {
            cursor.continue();
          })
          .catch(error => {
            tx.abort();
            reject(error);
          });
      } else {
        cursor.continue();
      }
    };
    request.onerror = () => {
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      reject(request.error ?? new Error("IndexedDB cursor failed"));
    };
  });
};

export const resetCacheDb = async (): Promise<void> => {
  if (typeof indexedDB === "undefined") return;
  if (openPromise) {
    openPromise
      .then(db => {
        try {
          db.close();
        } catch {
          // Ignore close errors.
        }
      })
      .catch(() => undefined);
    openPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = () =>
      reject(deleteRequest.error ?? new Error("IndexedDB delete failed"));
    deleteRequest.onblocked = () => resolve();
  }).catch(() => {
    // Ignore delete failures; database may not exist.
  });
  openPromise = null;
  lastCompactionCheck = 0;
  lastCompactedAt = 0;
  compactionInFlight = false;
  initialCompactionScheduled = false;
};
