import { BLOOM_PREVIEW_CACHE_NAME, checkLocalStorageQuota, estimateEntryBytes } from "./storageQuota";

const CACHE_NAME = BLOOM_PREVIEW_CACHE_NAME;
const LOCAL_STORAGE_PREFIX = "bloom:preview-cache:v1:";
const MAX_CACHE_BYTES = 4 * 1024 * 1024; // 4MB cap to avoid storing very large previews
const MAX_LOCAL_STORAGE_ENTRY_BYTES = 120 * 1024; // single preview cap (~120KB)
const MAX_LOCAL_STORAGE_TOTAL_BYTES = 400 * 1024; // total fallback cap (~400KB)
const LOCAL_STORAGE_INLINE_LIMIT_BYTES = 60 * 1024; // keep main-thread base64 work tiny
const LOCAL_STORAGE_META_KEY = `${LOCAL_STORAGE_PREFIX}__meta__`;
const LOCAL_STORAGE_META_VERSION = 1;

type PreviewMetaEntry = {
  size: number;
  updatedAt: number;
  lastAccessed: number;
};

type PreviewMetaRecord = {
  version: number;
  entries: Record<string, PreviewMetaEntry | undefined>;
};

let previewMetaCache: Map<string, PreviewMetaEntry> | null = null;
let previewMetaDirty = false;
let previewMetaPersistScheduled = false;

const scheduleIdleWork = (work: () => void) => {
  if (typeof window === "undefined") {
    work();
    return undefined;
  }
  const win = window as typeof window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(() => work(), { timeout: 150 });
    return () => win.cancelIdleCallback?.(handle);
  }
  const timeout = window.setTimeout(work, 32);
  return () => window.clearTimeout(timeout);
};

const pendingLocalStorageWriteCancels = new Map<string, () => void>();

function normalizeServerKey(serverUrl?: string) {
  if (!serverUrl) return "default";
  return serverUrl.replace(/\/+$/, "");
}

function buildCacheKey(serverUrl: string | undefined, sha256: string) {
  if (!sha256) return null;
  const serverKey = normalizeServerKey(serverUrl);
  return `${serverKey}|${sha256}`;
}

function buildCacheRequest(key: string) {
  if (typeof window === "undefined") return null;
  let origin: string | undefined;
  try {
    origin = window.location?.origin;
  } catch (error) {
    origin = undefined;
  }
  if (!origin) return null;
  const url = new URL(`/__bloom-preview-cache/${encodeURIComponent(key)}`, origin);
  return new Request(url.toString(), { method: "GET" });
}

async function readFromLocalStorage(key: string): Promise<Blob | null> {
  if (typeof window === "undefined") return null;
  const storageKey = `${LOCAL_STORAGE_PREFIX}${key}`;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch (error) {
    raw = null;
  }

  if (!raw) {
    removePreviewMetaEntry(key);
    return null;
  }

  try {
    const response = await fetch(raw);
    if (!response.ok) {
      deletePreviewStorageEntry(key);
      return null;
    }
    const blob = await response.blob();
    const now = Date.now();
    const meta = getPreviewMeta();
    const existing = meta.get(key);
    if (existing) {
      updatePreviewMetaEntry(key, { ...existing, lastAccessed: now });
    } else {
      const size = estimateEntryBytes(storageKey, raw);
      updatePreviewMetaEntry(key, { size, updatedAt: now, lastAccessed: now });
    }
    return blob;
  } catch (error) {
    deletePreviewStorageEntry(key);
    return null;
  }
}

async function writeToLocalStorage(key: string, blob: Blob) {
  if (typeof window === "undefined") return;
  if (blob.size === 0 || blob.size > LOCAL_STORAGE_INLINE_LIMIT_BYTES) return;
  await new Promise<void>(resolve => {
    const performWrite = async () => {
      try {
        const dataUrl = await new Promise<string>((resolveData, rejectData) => {
          const reader = new FileReader();
          reader.onerror = () => rejectData(reader.error);
          reader.onload = () => {
            const result = reader.result;
            if (typeof result === "string") resolveData(result);
            else rejectData(new Error("Failed to encode preview"));
          };
          reader.readAsDataURL(blob);
        });
        const storageKey = `${LOCAL_STORAGE_PREFIX}${key}`;
        const entrySize = estimateEntryBytes(storageKey, dataUrl);
        if (!ensurePreviewStorageCapacity(key, entrySize)) {
          resolve();
          return;
        }
        try {
          window.localStorage.setItem(storageKey, dataUrl);
          const now = Date.now();
          updatePreviewMetaEntry(key, { size: entrySize, updatedAt: now, lastAccessed: now });
          const quota = checkLocalStorageQuota("preview-cache");
          if (quota.status === "critical") {
            ensurePreviewStorageCapacity(key, 0);
          }
        } catch (error) {
          deletePreviewStorageEntry(key);
        }
      } catch (error) {
        deletePreviewStorageEntry(key);
      } finally {
        resolve();
      }
    };

    const cancelExisting = pendingLocalStorageWriteCancels.get(key);
    if (cancelExisting) {
      cancelExisting();
      pendingLocalStorageWriteCancels.delete(key);
    }

    const cancel = scheduleIdleWork(() => {
      pendingLocalStorageWriteCancels.delete(key);
      void performWrite();
    });

    if (cancel) {
      pendingLocalStorageWriteCancels.set(key, cancel);
    } else {
      void performWrite();
    }
  });
}

async function readFromCacheStorage(key: string): Promise<Blob | null> {
  if (typeof window === "undefined" || !("caches" in window)) return null;
  try {
    const request = buildCacheRequest(key);
    if (!request) return null;
    const cache = await window.caches.open(CACHE_NAME);
    const match = await cache.match(request);
    if (!match) return null;
    return await match.blob();
  } catch (error) {
    return null;
  }
}

async function writeToCacheStorage(key: string, blob: Blob) {
  if (typeof window === "undefined" || !("caches" in window)) return;
  if (blob.size === 0 || blob.size > MAX_CACHE_BYTES) return;
  try {
    const request = buildCacheRequest(key);
    if (!request) return;
    const cache = await window.caches.open(CACHE_NAME);
    const headers = new Headers();
    if (blob.type) headers.set("Content-Type", blob.type);
    headers.set("Content-Length", String(blob.size));
    const response = new Response(blob.slice(0, MAX_CACHE_BYTES), {
      headers,
    });
    await cache.put(request, response);
  } catch (error) {
    // Swallow cache write errors (quota, private mode, etc.).
  }
}

export async function getCachedPreviewBlob(serverUrl: string | undefined, sha256: string) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return null;
  const cacheHit = await readFromCacheStorage(key);
  if (cacheHit) return cacheHit;
  return await readFromLocalStorage(key);
}

export async function cachePreviewBlob(serverUrl: string | undefined, sha256: string, blob: Blob) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return;
  if (!blob.type?.startsWith("image/")) return; // only cache image previews
  await writeToCacheStorage(key, blob);
  await writeToLocalStorage(key, blob);
}

export async function invalidateCachedPreview(serverUrl: string | undefined, sha256: string) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return;
  if (typeof window !== "undefined" && "caches" in window) {
    try {
      const request = buildCacheRequest(key);
      if (request) {
        const cache = await window.caches.open(CACHE_NAME);
        await cache.delete(request);
      }
    } catch (error) {
      // Ignore cache deletion errors.
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    } catch (error) {
      // Ignore localStorage deletion errors.
    }
    removePreviewMetaEntry(key);
  }
}
const enqueueMicrotaskShim = (cb: () => void) => {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(cb);
  } else {
    Promise.resolve()
      .then(cb)
      .catch(() => undefined);
  }
};

const persistPreviewMeta = () => {
  previewMetaPersistScheduled = false;
  if (!previewMetaDirty || !previewMetaCache) return;
  if (typeof window === "undefined") return;
  try {
    const payload: PreviewMetaRecord = { version: LOCAL_STORAGE_META_VERSION, entries: {} };
    previewMetaCache.forEach((value, key) => {
      payload.entries[key] = value;
    });
    window.localStorage.setItem(LOCAL_STORAGE_META_KEY, JSON.stringify(payload));
    previewMetaDirty = false;
  } catch (error) {
    // Ignore persistence failures (quota, private mode, etc.).
  }
};

const schedulePreviewMetaPersist = () => {
  if (previewMetaPersistScheduled) return;
  if (!previewMetaDirty) return;
  previewMetaPersistScheduled = true;
  enqueueMicrotaskShim(persistPreviewMeta);
};

const getPreviewMeta = (): Map<string, PreviewMetaEntry> => {
  if (previewMetaCache) return previewMetaCache;
  previewMetaCache = new Map();
  if (typeof window === "undefined") {
    return previewMetaCache;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_META_KEY);
    if (!raw) return previewMetaCache;
    const parsed = JSON.parse(raw) as PreviewMetaRecord | null;
    if (!parsed || typeof parsed !== "object") return previewMetaCache;
    if (parsed.version !== LOCAL_STORAGE_META_VERSION) return previewMetaCache;
    const records = parsed.entries;
    if (!records || typeof records !== "object") return previewMetaCache;
    Object.entries(records).forEach(([key, value]) => {
      if (!key || !value) return;
      const size = typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0;
      if (size <= 0) return;
      const updatedAt =
        typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now();
      const lastAccessed =
        typeof value.lastAccessed === "number" && Number.isFinite(value.lastAccessed)
          ? value.lastAccessed
          : updatedAt;
      previewMetaCache!.set(key, { size, updatedAt, lastAccessed });
    });
  } catch (error) {
    previewMetaCache = new Map();
  }
  return previewMetaCache!;
};

const removePreviewMetaEntry = (key: string) => {
  const meta = getPreviewMeta();
  if (!meta.has(key)) return;
  meta.delete(key);
  previewMetaDirty = true;
  schedulePreviewMetaPersist();
};

const updatePreviewMetaEntry = (key: string, entry: PreviewMetaEntry) => {
  const meta = getPreviewMeta();
  meta.set(key, entry);
  previewMetaDirty = true;
  schedulePreviewMetaPersist();
};

const getPreviewMetaTotalSize = (meta: Map<string, PreviewMetaEntry>): number => {
  let total = 0;
  meta.forEach(entry => {
    total += entry.size;
  });
  return total;
};

const cleanupOrphanedPreviewEntries = () => {
  if (typeof window === "undefined") return;
  const meta = getPreviewMeta();
  let changed = false;
  meta.forEach((_value, key) => {
    if (!window.localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`)) {
      meta.delete(key);
      changed = true;
    }
  });
  if (changed) {
    previewMetaDirty = true;
    schedulePreviewMetaPersist();
  }
};

const enforcePreviewStorageBudget = () => {
  if (typeof window === "undefined") return;
  const meta = getPreviewMeta();
  let total = getPreviewMetaTotalSize(meta);
  if (total <= MAX_LOCAL_STORAGE_TOTAL_BYTES) return;
  const entries = Array.from(meta.entries()).sort((a, b) => {
    const aScore = (a[1].lastAccessed ?? a[1].updatedAt) || 0;
    const bScore = (b[1].lastAccessed ?? b[1].updatedAt) || 0;
    return aScore - bScore;
  });
  for (const [key, entry] of entries) {
    deletePreviewStorageEntry(key);
    total -= entry.size;
    if (total <= MAX_LOCAL_STORAGE_TOTAL_BYTES) {
      break;
    }
  }
};

cleanupOrphanedPreviewEntries();
enforcePreviewStorageBudget();

const deletePreviewStorageEntry = (key: string) => {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    } catch (error) {
      // Ignore removal errors.
    }
  }
  removePreviewMetaEntry(key);
};

const ensurePreviewStorageCapacity = (key: string, requiredBytes: number): boolean => {
  if (requiredBytes > MAX_LOCAL_STORAGE_ENTRY_BYTES) {
    return false;
  }
  if (typeof window === "undefined") return false;
  const meta = getPreviewMeta();
  const existing = meta.get(key);
  let total = getPreviewMetaTotalSize(meta);
  if (existing) {
    total -= existing.size;
  }
  if (total + requiredBytes <= MAX_LOCAL_STORAGE_TOTAL_BYTES) {
    return true;
  }

  const evictionCandidates = Array.from(meta.entries())
    .filter(([candidateKey]) => candidateKey !== key)
    .sort((a, b) => {
      const aScore = (a[1].lastAccessed ?? a[1].updatedAt) || 0;
      const bScore = (b[1].lastAccessed ?? b[1].updatedAt) || 0;
      return aScore - bScore;
    });

  for (const [candidateKey, entry] of evictionCandidates) {
    deletePreviewStorageEntry(candidateKey);
    total -= entry.size;
    if (total + requiredBytes <= MAX_LOCAL_STORAGE_TOTAL_BYTES) {
      break;
    }
  }

  if (total + requiredBytes > MAX_LOCAL_STORAGE_TOTAL_BYTES) {
    return false;
  }

  return true;
};
