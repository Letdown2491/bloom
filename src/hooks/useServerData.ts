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
};

const DEFAULT_BACKGROUND_DELAY_MS = 1200;

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

  const { prioritizedServerUrls = [], backgroundPrefetch = true, backgroundPrefetchDelayMs = DEFAULT_BACKGROUND_DELAY_MS } = options ?? {};

  const normalizedPrioritizedUrls = useMemo(() => {
    const knownServers = buildServerMap(servers);
    const unique = new Set<string>();
    prioritizedServerUrls.forEach(url => {
      if (!url) return;
      const server = knownServers.get(url);
      if (!server) return;
      unique.add(server.url);
    });
    return Array.from(unique);
  }, [servers, prioritizedServerUrls]);

  const [activeServerUrls, setActiveServerUrls] = useState<Set<string>>(() => new Set(normalizedPrioritizedUrls));

  const activateServer = useCallback((url: string) => {
    if (!url) return;
    setActiveServerUrls(prev => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  useEffect(() => {
    const allowed = buildServerMap(servers);
    setActiveServerUrls(prev => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach(url => {
        if (allowed.has(url)) {
          next.add(url);
        } else {
          changed = true;
        }
      });
      normalizedPrioritizedUrls.forEach(url => {
        if (!allowed.has(url)) return;
        if (!next.has(url)) {
          next.add(url);
          changed = true;
        }
      });
      if (!changed && next.size === prev.size) {
        return prev;
      }
      return next;
    });
  }, [servers, normalizedPrioritizedUrls]);

  useEffect(() => {
    if (!backgroundPrefetch) return;
    if (typeof window === "undefined") return;

    const inactiveServers = servers.filter(server => !activeServerUrls.has(server.url));
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
  }, [activateServer, activeServerUrls, backgroundPrefetch, backgroundPrefetchDelayMs, servers]);

  const queries = useQueries({
    queries: servers.map(server => {
      const isActive = activeServerUrls.has(server.url);
      return {
        queryKey: ["server-blobs", server.url, pubkey, server.type],
        enabled:
          isActive &&
          !!pubkey &&
          (!(server.type === "satellite" || server.requiresAuth) || !!signer),
        queryFn: async (): Promise<BlossomBlob[]> => {
          if (!pubkey) return [];
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
        staleTime: 1000 * 60,
      };
    }),
  });

  const snapshots: ServerSnapshot[] = useMemo(() => {
    return servers.map((server, index) => {
      const query = queries[index];
      return {
        server,
        blobs: mergeBlobsWithStoredMetadata(server.url, query?.data ?? []),
        isLoading: activeServerUrls.has(server.url) ? query?.isLoading ?? false : false,
        isError: query?.isError ?? false,
        error: query?.error ?? null,
      };
    });
  }, [servers, queries, metadataVersion, activeServerUrls]);

  const { distribution, aggregated } = useMemo(() => {
    const dict: BlobDistribution = {};
    const aggregatedShas: string[] = [];

    snapshots.forEach(snapshot => {
      snapshot.blobs.forEach(blob => {
        let entry = dict[blob.sha256];
        if (!entry) {
          entry = { blob, servers: [snapshot.server.url] };
          dict[blob.sha256] = entry;
          aggregatedShas.push(blob.sha256);
          return;
        }

        if (!entry.servers.includes(snapshot.server.url)) {
          entry.servers.push(snapshot.server.url);
        }

        // Prefer the blob with richer metadata (name/type) when encountering duplicates.
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
    aggregatedShas.forEach(sha => {
      const entry = dict[sha];
      if (!entry) return;
      const blob = entry.blob;
      aggregatedBlobs.push(blob);
      totalSize += blob.size || 0;
      lastChange = Math.max(lastChange, blob.uploaded || 0);
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
