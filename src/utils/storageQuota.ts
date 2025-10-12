const WARN_THRESHOLD_BYTES = 3 * 1024 * 1024; // ~3MB
const CRITICAL_THRESHOLD_BYTES = 4.5 * 1024 * 1024; // ~4.5MB

export type QuotaStatus = "normal" | "warn" | "critical";

const KB = 1024;
const MB = KB * 1024;
const BYTES_PER_UTF16_CODE_UNIT = 2;
const BLOOM_LOCAL_STORAGE_PREFIX = "bloom";

export const BLOOM_PREVIEW_CACHE_NAME = "bloom:preview-cache:v1";
const BLOOM_CACHE_NAMES: readonly string[] = [BLOOM_PREVIEW_CACHE_NAME];

export type StorageQuotaSnapshot = {
  status: QuotaStatus;
  totalBytes: number;
  context: string;
  measuredAt: number;
};

export type OriginStorageEstimate = {
  usage: number | null;
  quota: number | null;
  measuredAt: number;
};

export type CacheStorageEstimate = {
  totalBytes: number;
  entryCount: number;
  measuredAt: number;
};

export type ClearCacheStorageResult = {
  cleared: string[];
  failed: string[];
};

type QuotaChangeListener = (snapshot: StorageQuotaSnapshot) => void;

const quotaListeners = new Set<QuotaChangeListener>();

const notifyQuotaListeners = (snapshot: StorageQuotaSnapshot) => {
  for (const listener of Array.from(quotaListeners)) {
    try {
      listener(snapshot);
    } catch (error) {
      // Ignore listener errors to keep quota tracking resilient.
    }
  }
};

export const subscribeToQuotaChanges = (listener: QuotaChangeListener): (() => void) => {
  quotaListeners.add(listener);
  return () => {
    quotaListeners.delete(listener);
  };
};

const clampNumber = (value: number) => (Number.isFinite(value) ? value : 0);

// localStorage persists UTF-16 strings, so count each code unit as two bytes.
const estimateStringBytes = (text: string): number => text.length * BYTES_PER_UTF16_CODE_UNIT;

const getLocalStorage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch (error) {
    return null;
  }
};

export const estimateLocalStorageUsage = (): number => {
  const storage = getLocalStorage();
  if (!storage) return 0;
  let total = 0;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const value = storage.getItem(key) ?? "";
      total += estimateStringBytes(key) + estimateStringBytes(value);
    }
  } catch (error) {
    // Some browsers throw when storage is inaccessible; fall back to zero.
    return 0;
  }
  return total;
};

export const estimateEntryBytes = (key: string, value: string | null | undefined): number => {
  return estimateStringBytes(key) + (value == null ? 0 : estimateStringBytes(value));
};

const classifyQuotaStatus = (bytes: number): QuotaStatus => {
  if (bytes >= CRITICAL_THRESHOLD_BYTES) return "critical";
  if (bytes >= WARN_THRESHOLD_BYTES) return "warn";
  return "normal";
};

export const formatBytes = (bytes: number): string => {
  const normalized = clampNumber(bytes);
  if (normalized >= MB) {
    return `${(normalized / MB).toFixed(2)}MB`;
  }
  if (normalized >= KB) {
    return `${(normalized / KB).toFixed(1)}KB`;
  }
  return `${normalized}B`;
};

export const checkLocalStorageQuota = (
  context: string,
  _options?: { log?: boolean }
): StorageQuotaSnapshot => {
  const totalBytes = estimateLocalStorageUsage();
  const status = classifyQuotaStatus(totalBytes);
  const snapshot: StorageQuotaSnapshot = {
    status,
    totalBytes,
    context,
    measuredAt: Date.now(),
  };
  notifyQuotaListeners(snapshot);
  return snapshot;
};

export const LOCAL_STORAGE_WARN_THRESHOLD = WARN_THRESHOLD_BYTES;
export const LOCAL_STORAGE_CRITICAL_THRESHOLD = CRITICAL_THRESHOLD_BYTES;

const listLocalStorageKeys = (): string[] => {
  const storage = getLocalStorage();
  if (!storage) return [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  } catch (error) {
    return [];
  }
};

const isBloomLocalStorageKey = (key: string): boolean => key.toLowerCase().startsWith(BLOOM_LOCAL_STORAGE_PREFIX);

export const listBloomLocalStorageKeys = (): string[] => listLocalStorageKeys().filter(isBloomLocalStorageKey);

export type ClearLocalStorageResult = {
  removedKeys: string[];
  failedKeys: string[];
};

export const clearBloomLocalStorage = (): ClearLocalStorageResult => {
  const storage = getLocalStorage();
  if (!storage) return { removedKeys: [], failedKeys: [] };
  const removedKeys: string[] = [];
  const failedKeys: string[] = [];
  const keys = listBloomLocalStorageKeys();
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removedKeys.push(key);
    } catch (error) {
      failedKeys.push(key);
    }
  }
  checkLocalStorageQuota("clear-local-storage");
  return { removedKeys, failedKeys };
};

export const isLocalStorageAccessible = (): boolean => getLocalStorage() !== null;

const hasCacheStorage = (): boolean => typeof window !== "undefined" && "caches" in window;

export const isCacheStorageAccessible = (): boolean => hasCacheStorage();

const parseContentLengthHeader = (response: Response): number | null => {
  const header = response.headers.get("content-length");
  if (!header) return null;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

const measureResponseBytes = async (response: Response): Promise<number> => {
  const headerSize = parseContentLengthHeader(response);
  if (headerSize != null) return headerSize;
  try {
    const blob = await response.clone().blob();
    return blob.size;
  } catch (error) {
    return 0;
  }
};

export const estimateBloomCacheStorage = async (): Promise<CacheStorageEstimate | null> => {
  if (!isCacheStorageAccessible()) return null;
  try {
    const cacheNames = await window.caches.keys();
    const relevantNames = cacheNames.filter(name => BLOOM_CACHE_NAMES.includes(name));
    let totalBytes = 0;
    let entryCount = 0;
    for (const cacheName of relevantNames) {
      const cache = await window.caches.open(cacheName);
      const requests = await cache.keys();
      entryCount += requests.length;
      for (const request of requests) {
        const response = await cache.match(request);
        if (!response) continue;
        totalBytes += await measureResponseBytes(response);
      }
    }
    return {
      totalBytes,
      entryCount,
      measuredAt: Date.now(),
    };
  } catch (error) {
    return null;
  }
};

export const clearBloomCacheStorage = async (): Promise<ClearCacheStorageResult> => {
  if (!isCacheStorageAccessible()) return { cleared: [], failed: BLOOM_CACHE_NAMES.slice() };
  const cleared: string[] = [];
  const failed: string[] = [];
  for (const cacheName of BLOOM_CACHE_NAMES) {
    try {
      await window.caches.delete(cacheName);
      cleared.push(cacheName);
    } catch (error) {
      failed.push(cacheName);
    }
  }
  return { cleared, failed };
};

export const estimateOriginStorage = async (): Promise<OriginStorageEstimate | null> => {
  if (typeof navigator === "undefined") return null;
  if (!navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    const usage =
      typeof estimate.usage === "number" && Number.isFinite(estimate.usage) ? Math.max(0, estimate.usage) : null;
    const quota =
      typeof estimate.quota === "number" && Number.isFinite(estimate.quota) ? Math.max(0, estimate.quota) : null;
    return {
      usage,
      quota,
      measuredAt: Date.now(),
    };
  } catch (error) {
    return null;
  }
};
