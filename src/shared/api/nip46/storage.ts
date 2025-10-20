import { SessionSnapshot } from "./session";

export interface StorageAdapter {
  load: () => Promise<SessionSnapshot | null>;
  save: (snapshot: SessionSnapshot) => Promise<void>;
}

const STORAGE_KEY = "bloom.nip46.sessions.v1";
const IDB_DB_NAME = "bloom.nip46.sessions";
const IDB_STORE_NAME = "snapshots";
const IDB_DB_VERSION = 1;
const IDB_SNAPSHOT_KEY = "snapshot";

type SnapshotRecord = {
  key: typeof IDB_SNAPSHOT_KEY;
  snapshot: SessionSnapshot;
  updatedAt: number;
};

let idbPromise: Promise<IDBDatabase> | null = null;

const isQuotaExceededError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.code === 22 || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

const cloneSnapshot = (snapshot: SessionSnapshot): SessionSnapshot => {
  if (typeof structuredClone === "function") {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot)) as SessionSnapshot;
};

const openIndexedDb = (): Promise<IDBDatabase> => {
  if (idbPromise) return idbPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  idbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error ?? new Error("Failed to open IndexedDB session store");
      idbPromise = null;
      reject(error);
    };
    request.onblocked = () => {
      // If blocked, fall back to localStorage for this session.
    };
  });
  return idbPromise;
};

const withIndexedDb = async <T>(callback: (db: IDBDatabase) => Promise<T>): Promise<T> => {
  const db = await openIndexedDb();
  return callback(db);
};

export class LocalStorageAdapter implements StorageAdapter {
  private blocked = false;
  private lastBlockedTime = 0;
  private readonly RETRY_INTERVAL_MS = 60_000; // Retry after 1 minute

  async load(): Promise<SessionSnapshot | null> {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const snapshot = parsed as SessionSnapshot;
      if (!Array.isArray(snapshot.sessions)) return null;
      return snapshot;
    } catch (error) {
      console.warn("Failed to load NIP-46 sessions", error);
      return null;
    }
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    if (typeof window === "undefined") return;

    // Allow retry if enough time has passed since last quota error
    if (this.blocked && Date.now() - this.lastBlockedTime > this.RETRY_INTERVAL_MS) {
      this.blocked = false;
    }

    if (this.blocked) return;

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      // Clear blocked state on successful save
      if (this.lastBlockedTime > 0) {
        this.lastBlockedTime = 0;
      }
    } catch (error) {
      if (isQuotaExceededError(error)) {
        this.blocked = true;
        this.lastBlockedTime = Date.now();
        console.warn("NIP-46 session persistence blocked due to storage quota. Will retry in 1 minute.");
        return;
      }
      console.warn("Failed to persist NIP-46 sessions", error);
    }
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private snapshot: SessionSnapshot | null = null;

  async load(): Promise<SessionSnapshot | null> {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot);
  }
}

export class IndexedDbStorageAdapter implements StorageAdapter {
  private initialized: Promise<void>;

  constructor() {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB unavailable");
    }
    this.initialized = openIndexedDb().then(() => undefined);
  }

  async load(): Promise<SessionSnapshot | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      await this.initialized;
      return await withIndexedDb(async db => {
        const tx = db.transaction(IDB_STORE_NAME, "readonly");
        const store = tx.objectStore(IDB_STORE_NAME);
        const record = await new Promise<SnapshotRecord | undefined>((resolve, reject) => {
          const request = store.get(IDB_SNAPSHOT_KEY);
          request.onsuccess = () => resolve((request.result as SnapshotRecord | undefined) ?? undefined);
          request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
        });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
        if (!record) return null;
        return cloneSnapshot(record.snapshot);
      });
    } catch (error) {
      console.warn("Failed to load NIP-46 sessions from IndexedDB", error);
      return null;
    }
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    try {
      await this.initialized;
      const payload = cloneSnapshot(snapshot);
      await withIndexedDb(async db => {
        const tx = db.transaction(IDB_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_STORE_NAME);
        await new Promise<void>((resolve, reject) => {
          const request = store.put({
            key: IDB_SNAPSHOT_KEY,
            snapshot: payload,
            updatedAt: Date.now(),
          } satisfies SnapshotRecord);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
        });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
      });
    } catch (error) {
      console.warn("Failed to persist NIP-46 sessions to IndexedDB", error);
    }
  }
}

export const createStorageAdapter = async (): Promise<StorageAdapter> => {
  if (typeof window === "undefined") {
    return new MemoryStorageAdapter();
  }
  if (typeof indexedDB !== "undefined") {
    try {
      const adapter = new IndexedDbStorageAdapter();
      await openIndexedDb();
      return adapter;
    } catch (error) {
      console.warn("IndexedDB storage unavailable for NIP-46 sessions", error);
    }
  }
  return new LocalStorageAdapter();
};
