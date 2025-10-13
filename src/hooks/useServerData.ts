import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import type { ManagedServer } from "./useServers";
import {
  listUserBlobs,
  type BlossomBlob,
  type PrivateBlobMetadata,
  type PrivateBlobEncryption,
} from "../lib/blossomClient";
import { listNip96Files } from "../lib/nip96Client";
import { listSatelliteFiles } from "../lib/satelliteClient";
import {
  mergeBlobsWithStoredMetadata,
  subscribeToBlobMetadataChanges,
  getBlobMetadataVersion,
} from "../utils/blobMetadataStore";
import { checkLocalStorageQuota } from "../utils/storageQuota";

const filterHiddenBlobTypes = (blobs: BlossomBlob[]) =>
  blobs.filter(blob => (blob.type?.toLowerCase() ?? "") !== "inode/x-empty");

const CACHE_VERSION = 2;
const SERVER_CACHE_PREFIX = "bloom.serverSnapshot";
const MAX_CACHED_BLOBS_PRIMARY = 120;
const MAX_CACHED_BLOBS_SECONDARY = 60;
const MAX_CACHED_BLOBS_EMERGENCY = 40;

let snapshotStorageBlocked = false;
let snapshotStorageWarned = false;

const isQuotaExceededError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.code === 22 || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

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

const loadCachedSnapshot = (url: string): CachedServerSnapshot | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(buildCacheKey(url));
    if (!raw) return null;
    const payload = JSON.parse(raw) as Partial<CachedSnapshotPayload> | null;
    if (!payload || typeof payload.version !== "number") return null;
    if (!Array.isArray(payload.blobs)) return null;
    const updatedAt = typeof payload.updatedAt === "number" ? payload.updatedAt : undefined;
    let blobs: BlossomBlob[];
    if (payload.version !== CACHE_VERSION) {
      // Legacy payload: sanitize into the latest shape.
      blobs = (payload.blobs as BlossomBlob[]).map(sanitizeCacheableBlob).map(decodeCachedBlob);
      return { blobs, updatedAt };
    }
    blobs = (payload.blobs as CachedBlobSnapshot[]).map(decodeCachedBlob);
    return { blobs, updatedAt };
  } catch (error) {
    console.warn("Unable to read cached server snapshot", error);
    return null;
  }
};

const persistSnapshotCache = (url: string, blobs: BlossomBlob[]) => {
  if (typeof window === "undefined" || snapshotStorageBlocked) return;
  const key = buildCacheKey(url);
  const timestamp = Date.now();
  const attemptPersist = (limit: number) => {
    const trimmed = blobs.slice(0, limit).map(sanitizeCacheableBlob);
    const payload: CachedSnapshotPayload = {
      version: CACHE_VERSION,
      updatedAt: timestamp,
      blobs: trimmed,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  };

  const enforceQuotaAfterPersist = (limitUsed: number) => {
    let currentLimit = limitUsed;
    const quota = checkLocalStorageQuota("server-snapshot");
    if (quota.status !== "critical") return;
    const fallbackLimits: number[] = [];
    if (currentLimit > MAX_CACHED_BLOBS_SECONDARY) {
      fallbackLimits.push(MAX_CACHED_BLOBS_SECONDARY);
    }
    if (currentLimit > MAX_CACHED_BLOBS_EMERGENCY) {
      fallbackLimits.push(MAX_CACHED_BLOBS_EMERGENCY);
    }

    for (const fallback of fallbackLimits) {
      try {
        window.localStorage.removeItem(key);
        attemptPersist(fallback);
        const followUp = checkLocalStorageQuota(`server-snapshot-${fallback}`, { log: false });
        if (followUp.status !== "critical") {
          if (!snapshotStorageWarned && fallback < currentLimit) {
            snapshotStorageWarned = true;
            console.info("Snapshot caching reduced: storage quota pressure detected.");
          }
          return;
        }
        currentLimit = fallback;
      } catch (error) {
        if (isQuotaExceededError(error)) {
          currentLimit = fallback;
          continue;
        }
        console.warn("Unable to persist cached server snapshot", error);
        return;
      }
    }

    snapshotStorageBlocked = true;
    window.localStorage.removeItem(key);
    if (!snapshotStorageWarned) {
      snapshotStorageWarned = true;
      console.info("Snapshot caching disabled: storage quota exceeded.");
    }
  };

  try {
    window.localStorage.removeItem(key);
    attemptPersist(MAX_CACHED_BLOBS_PRIMARY);
    enforceQuotaAfterPersist(MAX_CACHED_BLOBS_PRIMARY);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      try {
        window.localStorage.removeItem(key);
        attemptPersist(MAX_CACHED_BLOBS_SECONDARY);
        if (!snapshotStorageWarned) {
          snapshotStorageWarned = true;
          console.info("Snapshot caching reduced: storage quota pressure detected.");
        }
        enforceQuotaAfterPersist(MAX_CACHED_BLOBS_SECONDARY);
        return;
      } catch (secondaryError) {
        if (isQuotaExceededError(secondaryError)) {
          snapshotStorageBlocked = true;
          if (!snapshotStorageWarned) {
            snapshotStorageWarned = true;
            console.info("Snapshot caching disabled: storage quota exceeded.");
          }
          return;
        }
        console.warn("Unable to persist cached server snapshot", secondaryError);
        return;
      }
    }
    console.warn("Unable to persist cached server snapshot", error);
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

  const [cachedSnapshots, setCachedSnapshots] = useState<Map<string, CachedServerSnapshot>>(() => {
    const map = new Map<string, CachedServerSnapshot>();
    if (typeof window === "undefined") return map;
    servers.forEach(server => {
      const cached = loadCachedSnapshot(server.url);
      if (cached) {
        map.set(server.url, cached);
      }
    });
    return map;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const allowed = buildServerMap(servers);
    setCachedSnapshots(prev => {
      let changed = false;
      const next = new Map(prev);
      next.forEach((_, url) => {
        if (!allowed.has(url)) {
          next.delete(url);
          changed = true;
        }
      });
      servers.forEach(server => {
        if (next.has(server.url)) return;
        const cached = loadCachedSnapshot(server.url);
        if (cached) {
          next.set(server.url, cached);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [servers]);

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
      const cachedBlobs = cached?.blobs;
      return {
        queryKey: ["server-blobs", server.url, pubkey, server.type],
        enabled:
          isActive &&
          !!pubkey &&
          (server.type === "satellite"
            ? Boolean(signEventTemplate)
            : !server.requiresAuth || !!signer),
        initialData: cachedBlobs,
        initialDataUpdatedAt: cached?.updatedAt,
        staleTime: 0,
        refetchOnMount: "always" as const,
        refetchOnWindowFocus: true,
        queryFn: async (): Promise<BlossomBlob[]> => {
          if (!pubkey) return cachedBlobs ?? [];
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
