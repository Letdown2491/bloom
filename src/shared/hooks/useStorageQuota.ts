import { useCallback, useEffect, useMemo, useState } from "react";

import {
  LOCAL_STORAGE_CRITICAL_THRESHOLD,
  LOCAL_STORAGE_WARN_THRESHOLD,
  checkLocalStorageQuota,
  clearBloomCacheStorage,
  clearBloomLocalStorage,
  estimateBloomCacheStorage,
  estimateOriginStorage,
  isCacheStorageAccessible,
  isLocalStorageAccessible,
  listBloomLocalStorageKeys,
  subscribeToQuotaChanges,
  type CacheStorageEstimate,
  type ClearCacheStorageResult,
  type OriginStorageEstimate,
  type StorageQuotaSnapshot,
} from "../utils/storageQuota";

const FALLBACK_CONTEXT = "settings:storage-quota";

const hasOriginEstimateSupport = (): boolean =>
  typeof navigator !== "undefined" && Boolean(navigator.storage?.estimate);

const createSnapshot = (context: string): StorageQuotaSnapshot => {
  if (!isLocalStorageAccessible()) {
    return {
      status: "normal",
      totalBytes: 0,
      context,
      measuredAt: Date.now(),
    };
  }
  return checkLocalStorageQuota(context, { log: false });
};

export type UseStorageQuotaResult = {
  snapshot: StorageQuotaSnapshot;
  warnThreshold: number;
  criticalThreshold: number;
  usagePercent: number;
  managedKeys: string[];
  refresh: (context?: string) => StorageQuotaSnapshot;
  clear: () => { removedKeys: string[]; failedKeys: string[] };
  isSupported: boolean;
  originUsage: number | null;
  originQuota: number | null;
  originSupported: boolean;
  approximateCacheUsage: number | null;
  originEstimate: OriginStorageEstimate | null;
  refreshOrigin: () => Promise<OriginStorageEstimate | null>;
  cacheSupported: boolean;
  cacheEstimate: CacheStorageEstimate | null;
  refreshCache: () => Promise<CacheStorageEstimate | null>;
  clearCache: () => Promise<ClearCacheStorageResult | null>;
};

export const useStorageQuota = (): UseStorageQuotaResult => {
  const [snapshot, setSnapshot] = useState<StorageQuotaSnapshot>(() =>
    createSnapshot(`${FALLBACK_CONTEXT}:init`),
  );
  const [managedKeys, setManagedKeys] = useState<string[]>(() =>
    isLocalStorageAccessible() ? listBloomLocalStorageKeys() : [],
  );
  const [originSupported, setOriginSupported] = useState<boolean>(() => hasOriginEstimateSupport());
  const [originEstimate, setOriginEstimate] = useState<OriginStorageEstimate | null>(null);
  const [cacheSupported, setCacheSupported] = useState<boolean>(() => isCacheStorageAccessible());
  const [cacheEstimate, setCacheEstimate] = useState<CacheStorageEstimate | null>(null);

  const updateOriginEstimate = useCallback(async () => {
    const supported = hasOriginEstimateSupport();
    setOriginSupported(supported);
    if (!supported) {
      setOriginEstimate(null);
      return null;
    }
    const estimate = await estimateOriginStorage();
    setOriginEstimate(estimate);
    return estimate;
  }, []);

  const updateCacheEstimate = useCallback(async () => {
    const supported = isCacheStorageAccessible();
    setCacheSupported(supported);
    if (!supported) {
      setCacheEstimate(null);
      return null;
    }
    const estimate = await estimateBloomCacheStorage();
    setCacheEstimate(estimate);
    return estimate;
  }, []);

  const clearCacheStorage = useCallback(async (): Promise<ClearCacheStorageResult | null> => {
    if (!isCacheStorageAccessible()) {
      setCacheSupported(false);
      setCacheEstimate(null);
      return null;
    }
    const result = await clearBloomCacheStorage();
    await Promise.all([updateCacheEstimate(), updateOriginEstimate()]);
    return result;
  }, [updateCacheEstimate, updateOriginEstimate]);

  const refresh = useCallback(
    (context?: string) => {
      const next = createSnapshot(context ?? `${FALLBACK_CONTEXT}:refresh`);
      setSnapshot(next);
      if (isLocalStorageAccessible()) {
        setManagedKeys(listBloomLocalStorageKeys());
      } else {
        setManagedKeys([]);
      }
      void updateOriginEstimate();
      void updateCacheEstimate();
      return next;
    },
    [updateCacheEstimate, updateOriginEstimate],
  );

  const clear = useCallback(() => {
    const result = clearBloomLocalStorage();
    if (isLocalStorageAccessible()) {
      setManagedKeys(listBloomLocalStorageKeys());
    } else {
      setManagedKeys([]);
    }
    void updateOriginEstimate();
    void updateCacheEstimate();
    return result;
  }, [updateCacheEstimate, updateOriginEstimate]);

  useEffect(() => {
    if (!isLocalStorageAccessible()) return;
    const unsubscribe = subscribeToQuotaChanges(next => {
      setSnapshot(next);
      setManagedKeys(listBloomLocalStorageKeys());
      void updateOriginEstimate();
      void updateCacheEstimate();
    });
    refresh(`${FALLBACK_CONTEXT}:mount`);
    void updateOriginEstimate();
    void updateCacheEstimate();
    return unsubscribe;
  }, [refresh, updateCacheEstimate, updateOriginEstimate]);

  useEffect(() => {
    if (!isLocalStorageAccessible()) return;
    const handleStorage = (event: StorageEvent) => {
      if (typeof window === "undefined") return;
      if (event.storageArea !== window.localStorage) return;
      refresh(`${FALLBACK_CONTEXT}:storage-event`);
      void updateOriginEstimate();
      void updateCacheEstimate();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [refresh, updateCacheEstimate, updateOriginEstimate]);

  useEffect(() => {
    void updateOriginEstimate();
  }, [updateOriginEstimate]);

  useEffect(() => {
    void updateCacheEstimate();
  }, [updateCacheEstimate]);

  const usagePercent = useMemo(() => {
    if (LOCAL_STORAGE_CRITICAL_THRESHOLD <= 0) return 0;
    return Math.max(0, Math.min(1, snapshot.totalBytes / LOCAL_STORAGE_CRITICAL_THRESHOLD));
  }, [snapshot.totalBytes]);

  const isSupported = isLocalStorageAccessible();
  const approximateCacheUsage = useMemo(() => {
    if (cacheEstimate) return cacheEstimate.totalBytes;
    if (!originEstimate || originEstimate.usage == null) return null;
    return Math.max(0, originEstimate.usage - snapshot.totalBytes);
  }, [cacheEstimate, originEstimate, snapshot.totalBytes]);

  const originUsage = originEstimate?.usage ?? null;
  const originQuota = originEstimate?.quota ?? null;

  return {
    snapshot,
    warnThreshold: LOCAL_STORAGE_WARN_THRESHOLD,
    criticalThreshold: LOCAL_STORAGE_CRITICAL_THRESHOLD,
    usagePercent,
    managedKeys,
    refresh,
    clear,
    isSupported,
    originUsage,
    originQuota,
    originSupported,
    approximateCacheUsage,
    originEstimate,
    refreshOrigin: updateOriginEstimate,
    cacheSupported,
    cacheEstimate,
    refreshCache: updateCacheEstimate,
    clearCache: clearCacheStorage,
  };
};
