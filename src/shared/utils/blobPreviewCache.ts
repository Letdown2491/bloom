import { BLOOM_PREVIEW_CACHE_NAME, estimateEntryBytes } from "./storageQuota";
import { getKv, setKv, deleteKv, getKvKeys } from "./cacheDb";

const CACHE_NAME = BLOOM_PREVIEW_CACHE_NAME;
const INLINE_DATA_PREFIX = "preview:inline:v1:";
const LOCAL_STORAGE_PREFIX = "bloom:preview-cache:v1:";
const MAX_CACHE_BYTES = 4 * 1024 * 1024; // 4MB cap to avoid storing very large previews
const MAX_LOCAL_STORAGE_ENTRY_BYTES = 120 * 1024; // single preview cap (~120KB)
const MAX_LOCAL_STORAGE_TOTAL_BYTES = 400 * 1024; // total fallback cap (~400KB)
const LOCAL_STORAGE_INLINE_LIMIT_BYTES = 60 * 1024; // keep main-thread base64 work tiny
const LOCAL_STORAGE_META_KEY = `${LOCAL_STORAGE_PREFIX}__meta__`;
const LOCAL_STORAGE_META_VERSION = 1;
const PREVIEW_META_KV_KEY = "preview:meta:v1";

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
let previewStorageDisabled = false;
let previewMetaLoadPromise: Promise<void> | null = null;

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

const buildInlineStorageKey = (key: string) => `${INLINE_DATA_PREFIX}${key}`;
const buildLegacyStorageKey = (key: string) => `${LOCAL_STORAGE_PREFIX}${key}`;

async function readFromInlineStore(key: string): Promise<Blob | null> {
  if (typeof window === "undefined") return null;
  const inlineKey = buildInlineStorageKey(key);
  let raw: string | null = null;

  if (!previewStorageDisabled) {
    try {
      raw = (await getKv<string>(inlineKey)) ?? null;
    } catch (error) {
      previewStorageDisabled = true;
      raw = null;
    }
  }

  if (!raw) {
    try {
      raw = window.localStorage.getItem(buildLegacyStorageKey(key));
      if (raw) {
        if (!previewStorageDisabled) {
          void setKv(inlineKey, raw).catch(() => {
            previewStorageDisabled = true;
          });
        }
        window.localStorage.removeItem(buildLegacyStorageKey(key));
      }
    } catch (error) {
      raw = null;
    }
  }

  if (!raw) {
    removePreviewMetaEntry(key);
    return null;
  }

  try {
    const response = await fetch(raw);
    if (!response.ok) {
      await deleteKv(inlineKey).catch(() => undefined);
      removePreviewMetaEntry(key);
      return null;
    }
    const blob = await response.blob();
    const now = Date.now();
    const meta = getPreviewMeta();
    const existing = meta.get(key);
    const size = existing?.size ?? estimateEntryBytes(inlineKey, raw);
    updatePreviewMetaEntry(key, { size, updatedAt: now, lastAccessed: now });
    return blob;
  } catch (error) {
    await deleteKv(inlineKey).catch(() => undefined);
    removePreviewMetaEntry(key);
    return null;
  }
}

async function writeToInlineStore(key: string, blob: Blob) {
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
        const entrySize = estimateEntryBytes(buildInlineStorageKey(key), dataUrl);
        if (!ensurePreviewStorageCapacity(key, entrySize)) {
          resolve();
          return;
        }
        let stored = false;
        if (!previewStorageDisabled) {
          try {
            await setKv(buildInlineStorageKey(key), dataUrl);
            stored = true;
            window.localStorage.removeItem(buildLegacyStorageKey(key));
          } catch (error) {
            previewStorageDisabled = true;
          }
        }
        if (!stored) {
          try {
            window.localStorage.setItem(buildLegacyStorageKey(key), dataUrl);
            stored = true;
          } catch (error) {
            stored = false;
          }
        }
        if (!stored) {
          deletePreviewStorageEntry(key);
          resolve();
          return;
        }
        const now = Date.now();
        updatePreviewMetaEntry(key, { size: entrySize, updatedAt: now, lastAccessed: now });
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
  return await readFromInlineStore(key);
}

export async function cachePreviewBlob(serverUrl: string | undefined, sha256: string, blob: Blob) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return;
  if (!blob.type?.startsWith("image/")) return; // only cache image previews
  await writeToCacheStorage(key, blob);
  await writeToInlineStore(key, blob);
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

const readLegacyMetaRecord = (): PreviewMetaRecord | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreviewMetaRecord | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== LOCAL_STORAGE_META_VERSION) return null;
    return parsed;
  } catch (error) {
    return null;
  }
};

const populatePreviewMeta = (record: PreviewMetaRecord) => {
  previewMetaCache = new Map();
  const entries = record.entries ?? {};
  Object.entries(entries).forEach(([key, value]) => {
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
  previewMetaDirty = false;
};

const ensurePreviewMetaLoaded = () => {
  if (previewMetaCache) return previewMetaCache;
  previewMetaCache = new Map();
  if (typeof window === "undefined") {
    return previewMetaCache;
  }
  if (!previewMetaLoadPromise) {
    previewMetaLoadPromise = (async () => {
      let record: PreviewMetaRecord | null = null;
      if (!previewStorageDisabled) {
        try {
          const stored = await getKv<PreviewMetaRecord>(PREVIEW_META_KV_KEY);
          if (stored && typeof stored === "object") {
            record = stored;
          }
        } catch (error) {
          previewStorageDisabled = true;
        }
      }
      if (!record) {
        record = readLegacyMetaRecord();
        if (record && !previewStorageDisabled) {
          try {
            await setKv(PREVIEW_META_KV_KEY, record);
            window.localStorage.removeItem(LOCAL_STORAGE_META_KEY);
          } catch (error) {
            previewStorageDisabled = true;
          }
        }
      }
      if (record) {
        populatePreviewMeta(record);
      }
    })().finally(() => {
      previewMetaLoadPromise = null;
    });
  }
  return previewMetaCache;
};

const persistPreviewMeta = () => {
  previewMetaPersistScheduled = false;
  if (!previewMetaDirty || !previewMetaCache) return;
  if (typeof window === "undefined") return;
  const payload: PreviewMetaRecord = { version: LOCAL_STORAGE_META_VERSION, entries: {} };
  previewMetaCache.forEach((value, key) => {
    payload.entries[key] = value;
  });

  const persistLegacy = () => {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_META_KEY, JSON.stringify(payload));
      previewMetaDirty = false;
    } catch (error) {
      // Ignore legacy persistence failures.
    }
  };

  if (previewStorageDisabled) {
    persistLegacy();
    return;
  }

  void (async () => {
    try {
      await setKv(PREVIEW_META_KV_KEY, payload);
      previewMetaDirty = false;
      window.localStorage.removeItem(LOCAL_STORAGE_META_KEY);
    } catch (error) {
      previewStorageDisabled = true;
      persistLegacy();
    }
  })();
};

const schedulePreviewMetaPersist = () => {
  if (previewMetaPersistScheduled) return;
  if (!previewMetaDirty) return;
  previewMetaPersistScheduled = true;
  enqueueMicrotaskShim(persistPreviewMeta);
};

const getPreviewMeta = (): Map<string, PreviewMetaEntry> => ensurePreviewMetaLoaded();

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
  if (meta.size === 0) return;
  void (async () => {
    const removals: string[] = [];
    for (const key of meta.keys()) {
      let exists = false;
      if (!previewStorageDisabled) {
        try {
          const stored = await getKv<string>(buildInlineStorageKey(key));
          exists = typeof stored === "string" && stored.length > 0;
        } catch (error) {
          previewStorageDisabled = true;
        }
      }
      if (!exists) {
        try {
          const legacy = window.localStorage.getItem(buildLegacyStorageKey(key));
          exists = typeof legacy === "string" && legacy.length > 0;
          if (!exists) {
            window.localStorage.removeItem(buildLegacyStorageKey(key));
          }
        } catch (error) {
          exists = false;
        }
      }
      if (!exists) {
        removals.push(key);
      }
    }
    if (removals.length > 0) {
      removals.forEach(candidate => {
        meta.delete(candidate);
      });
      previewMetaDirty = true;
      schedulePreviewMetaPersist();
    }
  })();
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

export type ClearPreviewInlineResult = {
  inlineRemoved: number;
  legacyRemoved: number;
  metaCleared: boolean;
  failures: number;
};

export const clearPreviewInlineStorage = async (): Promise<ClearPreviewInlineResult> => {
  let inlineRemoved = 0;
  let legacyRemoved = 0;
  let failures = 0;
  let metaCleared = false;

  if (!previewStorageDisabled) {
    try {
      const inlineKeys = await getKvKeys(INLINE_DATA_PREFIX);
      await Promise.all(
        inlineKeys.map(async key => {
          try {
            await deleteKv(key);
            inlineRemoved += 1;
          } catch (error) {
            failures += 1;
            previewStorageDisabled = true;
          }
        })
      );
    } catch (error) {
      previewStorageDisabled = true;
    }
  }

  if (typeof window !== "undefined") {
    try {
      const storage = window.localStorage;
      const pendingRemoval: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith(LOCAL_STORAGE_PREFIX)) {
          pendingRemoval.push(key);
        }
      }
      pendingRemoval.forEach(key => {
        try {
          storage.removeItem(key);
          legacyRemoved += 1;
        } catch (error) {
          failures += 1;
        }
      });
      try {
        storage.removeItem(LOCAL_STORAGE_META_KEY);
        metaCleared = true;
      } catch (error) {
        // Ignore meta removal failures.
      }
    } catch (error) {
      // Ignore localStorage enumeration failures.
    }
  }

  if (!previewStorageDisabled) {
    try {
      await deleteKv(PREVIEW_META_KV_KEY);
      metaCleared = true;
    } catch (error) {
      previewStorageDisabled = true;
      failures += 1;
    }
  }

  previewMetaCache = new Map();
  previewMetaDirty = false;
  previewMetaPersistScheduled = false;
  previewMetaLoadPromise = null;
  pendingLocalStorageWriteCancels.forEach(cancel => cancel());
  pendingLocalStorageWriteCancels.clear();

  return {
    inlineRemoved,
    legacyRemoved,
    metaCleared,
    failures,
  };
};

const deletePreviewStorageEntry = (key: string) => {
  if (!previewStorageDisabled) {
    void deleteKv(buildInlineStorageKey(key)).catch(() => undefined);
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(buildLegacyStorageKey(key));
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
