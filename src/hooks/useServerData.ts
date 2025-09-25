import { useCallback, useEffect, useMemo, useSyncExternalStore, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import type { ManagedServer } from "./useServers";
import { listUserBlobs, type BlossomBlob } from "../lib/blossomClient";
import { listNip96Files } from "../lib/nip96Client";
import { listSatelliteFiles } from "../lib/satelliteClient";
import {
  mergeBlobsWithStoredMetadata,
  subscribeToBlobMetadataChanges,
  getBlobMetadataVersion,
} from "../utils/blobMetadataStore";

const filterHiddenBlobTypes = (blobs: BlossomBlob[]) =>
  blobs.filter(blob => (blob.type?.toLowerCase() ?? "") !== "inode/x-empty");

const CACHE_VERSION = 1;
const SERVER_CACHE_PREFIX = "bloom.serverSnapshot";
const MAX_CACHED_BLOBS = 150;

let snapshotStorageBlocked = false;
let snapshotStorageWarned = false;

const isQuotaExceededError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.code === 22 || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

type CachedSnapshotPayload = {
  version: number;
  updatedAt: number;
  blobs: BlossomBlob[];
};

const buildCacheKey = (url: string) => `${SERVER_CACHE_PREFIX}:${encodeURIComponent(url)}`;

const sanitizeCacheableBlob = (blob: BlossomBlob): BlossomBlob => ({
  sha256: blob.sha256,
  size: blob.size,
  type: blob.type,
  uploaded: blob.uploaded,
  url: blob.url,
  name: blob.name,
  serverUrl: blob.serverUrl,
  requiresAuth: blob.requiresAuth,
  serverType: blob.serverType,
  label: blob.label,
  infohash: blob.infohash,
  magnet: blob.magnet,
});

const loadCachedSnapshot = (url: string): BlossomBlob[] | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(buildCacheKey(url));
    if (!raw) return null;
    const payload = JSON.parse(raw) as CachedSnapshotPayload | null;
    if (!payload || payload.version !== CACHE_VERSION) return null;
    if (!Array.isArray(payload.blobs)) return null;
    return payload.blobs as BlossomBlob[];
  } catch (error) {
    console.warn("Unable to read cached server snapshot", error);
    return null;
  }
};

const persistSnapshotCache = (url: string, blobs: BlossomBlob[]) => {
  if (typeof window === "undefined" || snapshotStorageBlocked) return;
  try {
    window.localStorage.removeItem(buildCacheKey(url));
    const trimmed = blobs.slice(0, MAX_CACHED_BLOBS).map(sanitizeCacheableBlob);
    const payload: CachedSnapshotPayload = {
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      blobs: trimmed,
    };
    window.localStorage.setItem(buildCacheKey(url), JSON.stringify(payload));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      snapshotStorageBlocked = true;
      if (!snapshotStorageWarned) {
        snapshotStorageWarned = true;
        console.info("Snapshot caching disabled: storage quota exceeded.");
      }
      return;
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

  const [cachedSnapshots, setCachedSnapshots] = useState<Map<string, BlossomBlob[]>>(() => {
    const map = new Map<string, BlossomBlob[]>();
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
      return {
        queryKey: ["server-blobs", server.url, pubkey, server.type],
        enabled:
          isActive &&
          !!pubkey &&
          (!(server.type === "satellite" || server.requiresAuth) || !!signer),
        initialData: cached,
        staleTime: 1000 * 60,
        queryFn: async (): Promise<BlossomBlob[]> => {
          if (!pubkey) return cached ?? [];
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
            if (!signEventTemplate) throw new Error("Satellite servers require a connected signer.");
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
      const rawBlobs = (query?.data as BlossomBlob[] | undefined) ?? cached ?? [];
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
      if (areBlobListsEqual(cached, snapshot.blobs)) return;
      persistSnapshotCache(snapshot.server.url, snapshot.blobs);
      setCachedSnapshots(prev => {
        const existing = prev.get(snapshot.server.url);
        if (areBlobListsEqual(existing, snapshot.blobs)) return prev;
        const next = new Map(prev);
        next.set(snapshot.server.url, snapshot.blobs);
        return next;
      });
    });
  }, [snapshots, cachedSnapshots]);

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
