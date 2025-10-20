import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCurrentPubkey, useNdk } from "../../../app/context/NdkContext";
import type { ManagedServer } from "../../../shared/types/servers";
import {
  listUserBlobs,
  type BlossomBlob,
  type PrivateBlobMetadata,
  type PrivateBlobEncryption,
} from "../../../shared/api/blossomClient";
import { listNip96Files } from "../../../shared/api/nip96Client";
import { listSatelliteFiles } from "../../../shared/api/satelliteClient";
import {
  mergeBlobsWithStoredMetadata,
  subscribeToBlobMetadataChanges,
  getBlobMetadataVersion,
} from "../../../shared/utils/blobMetadataStore";
import { getKv, setKv } from "../../../shared/utils/cacheDb";

const filterHiddenBlobTypes = (blobs: BlossomBlob[]) =>
  blobs.filter(blob => (blob.type?.toLowerCase() ?? "") !== "inode/x-empty");

const CACHE_VERSION = 2;
const SERVER_CACHE_PREFIX = "bloom.serverSnapshot";
const MAX_CACHED_BLOBS_PRIMARY = 120;
const MAX_CACHED_BLOBS_EMERGENCY = 40;

let snapshotStorageBlocked = false;

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
    return () => {
      win.cancelIdleCallback?.(handle);
    };
  }
  const timeout = window.setTimeout(work, 32);
  return () => window.clearTimeout(timeout);
};

const pendingSnapshotPersistCancels = new Map<string, () => void>();

type CachedBlobMetadata = Pick<PrivateBlobMetadata, "name" | "type">;

type CachedBlobSnapshot = Pick<
  BlossomBlob,
  "sha256" | "size" | "type" | "uploaded" | "name" | "url" | "requiresAuth" | "serverType"
> & {
  privateData?: {
    encryption: PrivateBlobEncryption;
    metadata?: CachedBlobMetadata;
  };
};

type CachedSnapshotPayload = {
  version: number;
  updatedAt: number;
  blobs: CachedBlobSnapshot[];
};

type CachedServerSnapshot = {
  blobs: BlossomBlob[];
  updatedAt?: number;
};

const buildCacheKey = (url: string) => `${SERVER_CACHE_PREFIX}:${encodeURIComponent(url)}`;

const sanitizeCacheableBlob = (blob: BlossomBlob): CachedBlobSnapshot => {
  const sanitized: CachedBlobSnapshot = {
    sha256: blob.sha256,
  };

  if (typeof blob.size === "number" && Number.isFinite(blob.size)) {
    sanitized.size = blob.size;
  }
  if (blob.type) {
    sanitized.type = blob.type;
  }
  if (typeof blob.uploaded === "number" && Number.isFinite(blob.uploaded)) {
    sanitized.uploaded = Math.trunc(blob.uploaded);
  }
  if (typeof blob.name === "string") {
    sanitized.name = blob.name;
  }
  if (typeof blob.url === "string") {
    sanitized.url = blob.url;
  }
  if (typeof blob.requiresAuth === "boolean") {
    sanitized.requiresAuth = blob.requiresAuth;
  }
  if (blob.serverType) {
    sanitized.serverType = blob.serverType;
  }

  const encryption = blob.privateData?.encryption;
  if (encryption) {
    const cachedEncryption: PrivateBlobEncryption = {
      algorithm: encryption.algorithm,
      key: encryption.key,
      iv: encryption.iv,
    };
    const sourceMeta = blob.privateData?.metadata;
    let cachedMetadata: CachedBlobMetadata | undefined;
    if (sourceMeta) {
      const metadata: CachedBlobMetadata = {};
      if (typeof sourceMeta.name === "string" && sourceMeta.name.trim()) {
        metadata.name = sourceMeta.name;
      }
      if (typeof sourceMeta.type === "string" && sourceMeta.type.trim()) {
        metadata.type = sourceMeta.type;
      }
      cachedMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    }
    sanitized.privateData = cachedMetadata
      ? { encryption: cachedEncryption, metadata: cachedMetadata }
      : { encryption: cachedEncryption };
  }

  return sanitized;
};

const decodeCachedBlob = (blob: CachedBlobSnapshot): BlossomBlob => {
  const decoded: BlossomBlob = {
    sha256: blob.sha256,
  };
  if (typeof blob.size === "number") decoded.size = blob.size;
  if (blob.type) decoded.type = blob.type;
  if (typeof blob.uploaded === "number") decoded.uploaded = blob.uploaded;
  if (typeof blob.name === "string") decoded.name = blob.name;
  if (typeof blob.url === "string") decoded.url = blob.url;
  if (typeof blob.requiresAuth === "boolean") decoded.requiresAuth = blob.requiresAuth;
  if (blob.serverType) decoded.serverType = blob.serverType;
  if (blob.privateData?.encryption) {
    decoded.privateData = blob.privateData.metadata
      ? { encryption: blob.privateData.encryption, metadata: blob.privateData.metadata }
      : { encryption: blob.privateData.encryption };
  }
  return decoded;
};

const migrateLegacySnapshot = (url: string): CachedServerSnapshot | null => {
  if (typeof window === "undefined") return null;
  try {
    const legacy = window.localStorage.getItem(buildCacheKey(url));
    if (!legacy) return null;
    const payload = JSON.parse(legacy) as Partial<CachedSnapshotPayload> | null;
    if (!payload || typeof payload.version !== "number" || !Array.isArray(payload.blobs)) {
      window.localStorage.removeItem(buildCacheKey(url));
      return null;
    }
    const updatedAt = typeof payload.updatedAt === "number" ? payload.updatedAt : undefined;
    let blobs: BlossomBlob[];
    if (payload.version !== CACHE_VERSION) {
      blobs = (payload.blobs as BlossomBlob[]).map(sanitizeCacheableBlob).map(decodeCachedBlob);
    } else {
      blobs = (payload.blobs as CachedBlobSnapshot[]).map(decodeCachedBlob);
    }
    try {
      void setKv(buildCacheKey(url), {
        version: CACHE_VERSION,
        updatedAt: updatedAt ?? Date.now(),
        blobs: blobs.map(sanitizeCacheableBlob),
      });
    } catch {
      // Ignore migration failures.
    }
    window.localStorage.removeItem(buildCacheKey(url));
    return { blobs, updatedAt };
  } catch (error) {
    window.localStorage.removeItem(buildCacheKey(url));
    return null;
  }
};

const loadCachedSnapshot = async (url: string): Promise<CachedServerSnapshot | null> => {
  if (typeof window === "undefined") return null;
  try {
    const payload = await getKv<CachedSnapshotPayload>(buildCacheKey(url));
    if (!payload || !Array.isArray(payload.blobs)) {
      return migrateLegacySnapshot(url);
    }
    const blobs = payload.blobs.map(decodeCachedBlob);
    return {
      blobs,
      updatedAt: typeof payload.updatedAt === "number" ? payload.updatedAt : undefined,
    };
  } catch (error) {
    return migrateLegacySnapshot(url);
  }
};

const persistSnapshotCacheNow = async (url: string, blobs: BlossomBlob[]) => {
  if (typeof window === "undefined") return;
  const trimmedLimit = (() => {
    if (snapshotStorageBlocked) return MAX_CACHED_BLOBS_EMERGENCY;
    return MAX_CACHED_BLOBS_PRIMARY;
  })();
  const trimmed = blobs.slice(0, trimmedLimit).map(sanitizeCacheableBlob);
  const payload: CachedSnapshotPayload = {
    version: CACHE_VERSION,
    updatedAt: Date.now(),
    blobs: trimmed,
  };
  try {
    await setKv(buildCacheKey(url), payload);
    snapshotStorageBlocked = false;
  } catch (error) {
    snapshotStorageBlocked = true;
    try {
      window.localStorage.removeItem(buildCacheKey(url));
      window.localStorage.setItem(buildCacheKey(url), JSON.stringify(payload));
    } catch {
      // Ignore localStorage fallback failures.
    }
  }
};

const persistSnapshotCache = (url: string, blobs: BlossomBlob[]) => {
  if (typeof window === "undefined") return;
  const cancelExisting = pendingSnapshotPersistCancels.get(url);
  if (cancelExisting) {
    cancelExisting();
    pendingSnapshotPersistCancels.delete(url);
  }
  const snapshot = blobs.slice();
  const cancel = scheduleIdleWork(() => {
    pendingSnapshotPersistCancels.delete(url);
    void persistSnapshotCacheNow(url, snapshot);
  });
  if (cancel) {
    pendingSnapshotPersistCancels.set(url, cancel);
  }
};

const areBlobListsEqual = (a: BlossomBlob[] | undefined, b: BlossomBlob[] | undefined) => {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]?.sha256 !== b[index]?.sha256) return false;
    if (a[index]?.uploaded !== b[index]?.uploaded) return false;
  }
  return true;
};

export type ServerSnapshot = {
  server: ManagedServer;
  blobs: BlossomBlob[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
};

export type BlobDistribution = {
  [sha: string]: { blob: BlossomBlob; servers: string[] };
};

type UseServerDataOptions = {
  prioritizedServerUrls?: string[];
  backgroundPrefetch?: boolean;
  backgroundPrefetchDelayMs?: number;
  maxConcurrentQueries?: number;
  foregroundServerUrl?: string | null;
  networkEnabled?: boolean;
};

const DEFAULT_BACKGROUND_DELAY_MS = 1200;
const DEFAULT_MAX_CONCURRENT = 2;

const buildServerMap = (servers: ManagedServer[]) => {
  const map = new Map<string, ManagedServer>();
  servers.forEach(server => {
    map.set(server.url, server);
  });
  return map;
};

export const useServerData = (servers: ManagedServer[], options?: UseServerDataOptions) => {
  const queryClient = useQueryClient();
  const pubkey = useCurrentPubkey();
  const { signer, signEventTemplate, status: ndkStatus, connectionError: ndkError } = useNdk();
  const metadataVersion = useSyncExternalStore(
    subscribeToBlobMetadataChanges,
    getBlobMetadataVersion,
    getBlobMetadataVersion
  );

  const {
    prioritizedServerUrls = [],
    backgroundPrefetch = true,
    backgroundPrefetchDelayMs = DEFAULT_BACKGROUND_DELAY_MS,
    maxConcurrentQueries = DEFAULT_MAX_CONCURRENT,
    foregroundServerUrl = null,
    networkEnabled = true,
  } = options ?? {};

  const normalizedPrioritizedUrls = useMemo(() => {
    const ordered: string[] = [];
    const serverMap = buildServerMap(servers);
    const push = (value?: string | null) => {
      if (!value) return;
      const server = serverMap.get(value);
      if (!server) return;
      if (ordered.includes(server.url)) return;
      ordered.push(server.url);
    };
    push(foregroundServerUrl ?? undefined);
    prioritizedServerUrls.forEach(push);
    return ordered;
  }, [servers, prioritizedServerUrls, foregroundServerUrl]);

  const [cachedSnapshots, setCachedSnapshots] = useState<Map<string, CachedServerSnapshot>>(new Map());

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      const map = new Map<string, CachedServerSnapshot>();
      for (const server of servers) {
        const cached = await loadCachedSnapshot(server.url);
        if (cached) {
          map.set(server.url, cached);
          const queryKey = ["server-blobs", server.url, pubkey, server.type];
          queryClient.setQueryData(queryKey, mergeBlobsWithStoredMetadata(server.url, cached.blobs));
        }
      }
      if (!cancelled) {
        setCachedSnapshots(map);
      }
    })().catch(() => {
      if (!cancelled) {
        setCachedSnapshots(new Map());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, queryClient, servers]);

  const [activeServerUrls, setActiveServerUrls] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    normalizedPrioritizedUrls.forEach(url => {
      if (initial.size < maxConcurrentQueries) {
        initial.add(url);
      }
    });
    return initial;
  });
  const [queuedServerUrls, setQueuedServerUrls] = useState<string[]>(() => {
    if (normalizedPrioritizedUrls.length <= maxConcurrentQueries) return [];
    return normalizedPrioritizedUrls.slice(maxConcurrentQueries);
  });

  const activateServer = useCallback(
    (url: string, priority = false) => {
      if (!url) return;
      let added = false;
      setActiveServerUrls(prev => {
        if (prev.has(url)) {
          added = true;
          return prev;
        }
        if (prev.size < maxConcurrentQueries) {
          const next = new Set(prev);
          next.add(url);
          added = true;
          return next;
        }
        return prev;
      });
      setQueuedServerUrls(prev => {
        const exists = prev.includes(url);
        if (added) {
          return exists ? prev.filter(entry => entry !== url) : prev;
        }
        if (exists) return prev;
        return priority ? [url, ...prev] : [...prev, url];
      });
    },
    [maxConcurrentQueries]
  );

  useEffect(() => {
    const allowed = buildServerMap(servers);
    const prioritized = normalizedPrioritizedUrls.filter(url => allowed.has(url));

    const nextActive = new Set<string>();
    prioritized.forEach(url => {
      if (nextActive.size < maxConcurrentQueries) {
        nextActive.add(url);
      }
    });
    activeServerUrls.forEach(url => {
      if (!allowed.has(url)) return;
      if (nextActive.size < maxConcurrentQueries) {
        nextActive.add(url);
      }
    });

    let activeChanged = nextActive.size !== activeServerUrls.size;
    if (!activeChanged) {
      activeServerUrls.forEach(url => {
        if (!nextActive.has(url)) {
          activeChanged = true;
        }
      });
    }
    if (activeChanged) {
      setActiveServerUrls(nextActive);
    }

    const nextQueue: string[] = [];
    prioritized.forEach(url => {
      if (!nextActive.has(url) && !nextQueue.includes(url)) {
        nextQueue.push(url);
      }
    });
    queuedServerUrls.forEach(url => {
      if (!allowed.has(url)) return;
      if (nextActive.has(url)) return;
      if (!nextQueue.includes(url)) {
        nextQueue.push(url);
      }
    });

    const queueChanged =
      nextQueue.length !== queuedServerUrls.length ||
      nextQueue.some((url, index) => queuedServerUrls[index] !== url);
    if (queueChanged) {
      setQueuedServerUrls(nextQueue);
    }
  }, [servers, normalizedPrioritizedUrls, maxConcurrentQueries, activeServerUrls, queuedServerUrls]);

  useEffect(() => {
    if (activeServerUrls.size >= maxConcurrentQueries) return;
    if (queuedServerUrls.length === 0) return;
    const nextActive = new Set(activeServerUrls);
    const nextQueue = [...queuedServerUrls];
    let changed = false;
    while (nextActive.size < maxConcurrentQueries && nextQueue.length > 0) {
      const url = nextQueue.shift();
      if (!url) continue;
      if (!nextActive.has(url)) {
        nextActive.add(url);
        changed = true;
      }
    }
    if (changed) {
      setActiveServerUrls(nextActive);
      setQueuedServerUrls(nextQueue);
    }
  }, [activeServerUrls, queuedServerUrls, maxConcurrentQueries]);

  useEffect(() => {
    normalizedPrioritizedUrls.forEach((url, index) => {
      activateServer(url, index === 0);
    });
  }, [normalizedPrioritizedUrls, activateServer]);

  useEffect(() => {
    if (!backgroundPrefetch) return;
    if (typeof window === "undefined") return;

    const tracked = new Set<string>();
    activeServerUrls.forEach(url => tracked.add(url));
    queuedServerUrls.forEach(url => tracked.add(url));
    const inactiveServers = servers.filter(server => !tracked.has(server.url));
    if (inactiveServers.length === 0) return;

    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    let visibilityListener: (() => void) | null = null;

    const win = window as typeof window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const scheduleActivation = () => {
      if (cancelled) return;
      const nextServer = inactiveServers[0];
      if (!nextServer) return;

      const activate = () => {
        if (cancelled) return;
        activateServer(nextServer.url);
      };

      const baseDelay = backgroundPrefetchDelayMs;
      const jitter = baseDelay > 0 ? baseDelay * (0.5 + Math.random()) : 0;
      const delay = Math.max(250, Math.round(jitter));

      if (typeof win.requestIdleCallback === "function") {
        idleHandle = win.requestIdleCallback(() => activate(), { timeout: delay });
      } else {
        timeoutHandle = window.setTimeout(activate, delay);
      }
    };

    const maybeSchedule = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        visibilityListener = () => {
          if (document.visibilityState === "visible" && !cancelled) {
            document.removeEventListener("visibilitychange", visibilityListener!);
            visibilityListener = null;
            scheduleActivation();
          }
        };
        document.addEventListener("visibilitychange", visibilityListener);
        return;
      }
      scheduleActivation();
    };

    maybeSchedule();

    return () => {
      cancelled = true;
      if (idleHandle !== null) {
        win.cancelIdleCallback?.(idleHandle);
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
      if (visibilityListener) {
        document.removeEventListener("visibilitychange", visibilityListener);
      }
    };
  }, [activateServer, activeServerUrls, queuedServerUrls, backgroundPrefetch, backgroundPrefetchDelayMs, servers]);

  const queries = useQueries({
    queries: servers.map(server => {
      const isActive = activeServerUrls.has(server.url);
      const cached = cachedSnapshots.get(server.url);
      const hasCachedData = Boolean(cached?.blobs?.length);
      return {
        queryKey: ["server-blobs", server.url, pubkey, server.type],
        enabled:
          networkEnabled &&
          isActive &&
          !!pubkey &&
          (server.type === "satellite"
            ? Boolean(signEventTemplate)
            : !server.requiresAuth || !!signer),
        placeholderData: cached ? () => cached.blobs : undefined,
        staleTime: 60_000,
        refetchOnMount: hasCachedData ? false : "always",
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        queryFn: async (): Promise<BlossomBlob[]> => {
          if (!pubkey) return cached?.blobs ?? [];
          if (server.type === "blossom") {
            const blobs = await listUserBlobs(
              server.url,
              pubkey,
              server.requiresAuth && signer ? { requiresAuth: true, signTemplate: signEventTemplate } : undefined
            );
            return filterHiddenBlobTypes(blobs);
          }
          if (server.type === "nip96") {
            const blobs = await listNip96Files(server.url, {
              requiresAuth: Boolean(server.requiresAuth),
              signTemplate: server.requiresAuth ? signEventTemplate : undefined,
            });
            return filterHiddenBlobTypes(blobs);
          }
          if (server.type === "satellite") {
            const blobs = await listSatelliteFiles(server.url, {
              signTemplate: signEventTemplate,
            });
            return filterHiddenBlobTypes(blobs);
          }
          return [];
        },
      };
    }),
  });

  const snapshots: ServerSnapshot[] = useMemo(() => {
    return servers.map((server, index) => {
      const query = queries[index];
      const cached = cachedSnapshots.get(server.url);
      const rawBlobs = (query?.data as BlossomBlob[] | undefined) ?? cached?.blobs ?? [];
      const fetchStatus = query?.fetchStatus;
      const isActive = activeServerUrls.has(server.url);
      return {
        server,
        blobs: mergeBlobsWithStoredMetadata(server.url, rawBlobs),
        isLoading: isActive && (fetchStatus === "fetching" || query?.isLoading || false),
        isError: query?.isError ?? false,
        error: query?.error ?? null,
      };
    });
  }, [servers, queries, metadataVersion, activeServerUrls, cachedSnapshots]);

  useEffect(() => {
    snapshots.forEach(snapshot => {
      if (snapshot.isError) return;
      if (!snapshot.blobs.length) return;
      const cached = cachedSnapshots.get(snapshot.server.url);
      if (areBlobListsEqual(cached?.blobs, snapshot.blobs)) return;
      persistSnapshotCache(snapshot.server.url, snapshot.blobs);
      setCachedSnapshots(prev => {
        const existing = prev.get(snapshot.server.url);
        if (areBlobListsEqual(existing?.blobs, snapshot.blobs)) return prev;
        const next = new Map(prev);
        next.set(snapshot.server.url, {
          blobs: snapshot.blobs,
          updatedAt: Date.now(),
        });
        return next;
      });
    });
  }, [snapshots, cachedSnapshots]);

  const lastMetadataVersionRef = useRef(metadataVersion);
  useEffect(() => {
    if (lastMetadataVersionRef.current === metadataVersion) return;
    lastMetadataVersionRef.current = metadataVersion;
    queryClient.invalidateQueries({ queryKey: ["server-blobs"] });
  }, [metadataVersion, queryClient]);

  const { distribution, aggregated } = useMemo(() => {
    const entryMap = new Map<string, { blob: BlossomBlob; servers: string[] }>();

    snapshots.forEach(snapshot => {
      snapshot.blobs.forEach(blob => {
        let entry = entryMap.get(blob.sha256);
        if (!entry) {
          entryMap.set(blob.sha256, {
            blob,
            servers: [snapshot.server.url],
          });
          return;
        }

        if (!entry.servers.includes(snapshot.server.url)) {
          entry.servers.push(snapshot.server.url);
        }

        const currentScore = (entry.blob.name ? 1 : 0) + (entry.blob.type ? 1 : 0);
        const incomingScore = (blob.name ? 1 : 0) + (blob.type ? 1 : 0);
        if (incomingScore > currentScore) {
          entry.blob = blob;
        }
      });
    });

    let totalSize = 0;
    let lastChange = 0;
    const aggregatedBlobs: BlossomBlob[] = [];
    const dict: BlobDistribution = {};

    entryMap.forEach((entry, sha) => {
      dict[sha] = entry;
      aggregatedBlobs.push(entry.blob);
      totalSize += entry.blob.size || 0;
      lastChange = Math.max(lastChange, entry.blob.uploaded || 0);
    });

    return {
      distribution: dict,
      aggregated: {
        count: aggregatedBlobs.length,
        size: totalSize,
        lastChange,
        blobs: aggregatedBlobs,
      },
    };
  }, [snapshots]);

  return { snapshots, distribution, aggregated, activateServer, ndkStatus, ndkError };
};
