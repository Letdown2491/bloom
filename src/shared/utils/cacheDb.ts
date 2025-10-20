const DB_NAME = "bloom.cache";
const STORE_NAME = "kv";
const DB_VERSION = 1;

type KvRecord = {
  key: string;
  value: unknown;
  updatedAt: number;
};

let openPromise: Promise<IDBDatabase> | null = null;

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
    };
    request.onsuccess = () => resolve(request.result);
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
  try {
    const db = await withDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const record: KvRecord = { key, value, updatedAt: Date.now() };
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
    });
  } catch (error) {
    throw error;
  }
};

export const deleteKv = async (key: string): Promise<void> => {
  if (!key) return;
  try {
    const db = await withDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
    });
  } catch (error) {
    throw error;
  }
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
    deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error("IndexedDB delete failed"));
    deleteRequest.onblocked = () => resolve();
  }).catch(() => {
    // Ignore delete failures; database may not exist.
  });
};
