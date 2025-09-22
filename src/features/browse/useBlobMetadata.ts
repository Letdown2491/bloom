import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlossomBlob, SignTemplate } from "../../lib/blossomClient";
import { buildAuthorizationHeader } from "../../lib/blossomClient";
import { buildNip98AuthHeader } from "../../lib/nip98";
import {
  getStoredBlobMetadata,
  isMetadataFresh,
  markBlobMetadataChecked,
  setStoredBlobMetadata,
} from "../../utils/blobMetadataStore";

type ServerType = "blossom" | "nip96" | "satellite";

export type BlobResolvedMeta = {
  type?: string;
  name?: string;
};

export type BlobMetadataState = {
  resolvedMeta: Record<string, BlobResolvedMeta>;
  detectedKinds: Record<string, "image" | "video">;
  requestMetadata: (sha: string) => void;
  reportDetectedKind: (sha: string, kind: "image" | "video") => void;
};

type MetadataOptions = {
  baseUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: ServerType;
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export const useBlobMetadata = (blobs: BlossomBlob[], options?: MetadataOptions): BlobMetadataState => {
  const {
    baseUrl,
    requiresAuth = false,
    signTemplate,
    serverType = "blossom",
    ttlMs = DEFAULT_TTL_MS,
  } = options ?? {};

  const [resolvedMeta, setResolvedMeta] = useState<Record<string, BlobResolvedMeta>>({});
  const [detectedKinds, setDetectedKinds] = useState<Record<string, "image" | "video">>({});
  const [visibilitySignal, setVisibilitySignal] = useState(0);

  const metadataSchedulerRef = useRef<{ running: number; queue: Array<() => void>; generation: number }>({
    running: 0,
    queue: [],
    generation: 0,
  });
  const metadataAbortControllers = useRef(new Map<string, AbortController>());
  const pendingLookups = useRef(new Set<string>());
  const attemptedLookups = useRef(new Set<string>());
  const visibleRequestsRef = useRef(new Set<string>());
  const passiveDetectors = useRef(new Map<string, () => void>());
  const isMountedRef = useRef(true);

  useEffect(() => () => {
    isMountedRef.current = false;
    passiveDetectors.current.forEach(cleanup => cleanup());
    passiveDetectors.current.clear();
    metadataAbortControllers.current.forEach(controller => controller.abort());
    metadataAbortControllers.current.clear();
  }, []);

  useEffect(() => {
    setResolvedMeta(prev => {
      const next: Record<string, BlobResolvedMeta> = {};
      blobs.forEach(blob => {
        const meta = prev[blob.sha256];
        if (meta) next[blob.sha256] = meta;
      });
      return next;
    });
    setDetectedKinds(prev => {
      const next: Record<string, "image" | "video"> = {};
      blobs.forEach(blob => {
        const kind = prev[blob.sha256];
        if (kind) next[blob.sha256] = kind;
      });
      return next;
    });

    const currentShas = new Set(blobs.map(blob => blob.sha256));
    pendingLookups.current.forEach(sha => {
      if (!currentShas.has(sha)) pendingLookups.current.delete(sha);
    });
    attemptedLookups.current.forEach(sha => {
      if (!currentShas.has(sha)) attemptedLookups.current.delete(sha);
    });
    visibleRequestsRef.current.forEach(sha => {
      if (!currentShas.has(sha)) visibleRequestsRef.current.delete(sha);
    });
    passiveDetectors.current.forEach((cleanup, sha) => {
      if (!currentShas.has(sha)) {
        cleanup();
        passiveDetectors.current.delete(sha);
      }
    });
  }, [blobs]);

  const requestMetadata = useCallback((sha: string) => {
    if (!sha) return;
    if (visibleRequestsRef.current.has(sha)) return;
    visibleRequestsRef.current.add(sha);
    setVisibilitySignal(signal => signal + 1);
  }, []);

  useEffect(() => {
    const scheduler = metadataSchedulerRef.current;
    scheduler.generation += 1;
    scheduler.queue = [];
    scheduler.running = 0;
    const generation = scheduler.generation;

    metadataAbortControllers.current.forEach(controller => controller.abort());
    metadataAbortControllers.current.clear();

    const enqueue = (task: () => Promise<void>) => {
      const execute = () => {
        if (metadataSchedulerRef.current.generation !== generation) return;
        metadataSchedulerRef.current.running += 1;
        task()
          .catch(() => undefined)
          .finally(() => {
            const sched = metadataSchedulerRef.current;
            sched.running = Math.max(0, sched.running - 1);
            if (sched.generation !== generation) return;
            const next = sched.queue.shift();
            if (next) next();
          });
      };

      if (metadataSchedulerRef.current.running < 4) execute();
      else metadataSchedulerRef.current.queue.push(execute);
    };

    const ensurePassiveProbe = (blob: BlossomBlob, resourceUrl: string) => {
      if (requiresAuth || passiveDetectors.current.has(blob.sha256) || detectedKinds[blob.sha256]) return;
      const img = new Image();
      img.decoding = "async";
      const cleanup = () => {
        img.onload = null;
        img.onerror = null;
        img.src = "";
        passiveDetectors.current.delete(blob.sha256);
      };
      img.onload = () => {
        if (isMountedRef.current) {
          setDetectedKinds(prev => (prev[blob.sha256] === "image" ? prev : { ...prev, [blob.sha256]: "image" }));
        }
        cleanup();
      };
      img.onerror = cleanup;
      passiveDetectors.current.set(blob.sha256, cleanup);
      img.src = resourceUrl;
    };

    const resolveMetadata = async (blob: BlossomBlob, resourceUrl: string) => {
      const controller = new AbortController();
      metadataAbortControllers.current.set(blob.sha256, controller);
      pendingLookups.current.add(blob.sha256);

      try {
        const headers: Record<string, string> = {};
        const effectiveType = blob.serverType ?? serverType;
        const needsAuthHeader = requiresAuth && effectiveType !== "satellite";
        const buildAuth = async (method: "HEAD" | "GET") => {
          if (!needsAuthHeader || !signTemplate) return undefined;
          if (effectiveType === "nip96") {
            return buildNip98AuthHeader(signTemplate, {
              url: resourceUrl,
              method,
            });
          }
          let resource: URL | null = null;
          try {
            resource = new URL(resourceUrl);
          } catch {
            resource = null;
          }
          return buildAuthorizationHeader(signTemplate, "get", {
            hash: blob.sha256,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 120,
          });
        };

        if (needsAuthHeader) {
          const auth = await buildAuth("HEAD");
          if (!auth) return;
          headers.Authorization = auth;
        }

        let response = await fetch(resourceUrl, {
          method: "HEAD",
          headers,
          mode: "cors",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 405 || response.status === 501) {
            const fallbackHeaders: Record<string, string> = { ...headers };
            if (needsAuthHeader) {
              const auth = await buildAuth("GET");
              if (!auth) return;
              fallbackHeaders.Authorization = auth;
            }
            response = await fetch(resourceUrl, {
              method: "GET",
              headers: fallbackHeaders,
              mode: "cors",
              signal: controller.signal,
            });
            if (!response.ok) return;
            if (response.body) {
              try {
                await response.body.cancel();
              } catch {}
            }
          } else {
            return;
          }
        }

        const mime = response.headers.get("content-type") || undefined;
        const disposition = response.headers.get("content-disposition") || undefined;
        const inferredName = deriveFilename(disposition);

        const nextType = mime && mime !== "application/octet-stream" ? mime : undefined;
        const nextName = inferredName || undefined;
        const storageServer = blob.serverUrl ?? baseUrl;

        if ((nextType || nextName) && storageServer) {
          setStoredBlobMetadata(storageServer, blob.sha256, {
            name: nextName,
            type: nextType,
            lastCheckedAt: Date.now(),
          });
        }

        if (isMountedRef.current) {
          if (nextType?.startsWith("image/")) {
            setDetectedKinds(prev => (prev[blob.sha256] === "image" ? prev : { ...prev, [blob.sha256]: "image" }));
          } else if (nextType?.startsWith("video/")) {
            setDetectedKinds(prev => (prev[blob.sha256] === "video" ? prev : { ...prev, [blob.sha256]: "video" }));
          }
        }

        if (!nextType && !nextName) {
          markBlobMetadataChecked(blob.serverUrl ?? baseUrl, blob.sha256);
          return;
        }

        if (!isMountedRef.current) return;

        setResolvedMeta(prev => {
          const current = prev[blob.sha256] ?? {};
          const updated: BlobResolvedMeta = {
            type: nextType ?? current.type,
            name: nextName ?? current.name,
          };
          if (current.type === updated.type && current.name === updated.name) return prev;
          return { ...prev, [blob.sha256]: updated };
        });
        markBlobMetadataChecked(blob.serverUrl ?? baseUrl, blob.sha256);
      } finally {
        pendingLookups.current.delete(blob.sha256);
        metadataAbortControllers.current.delete(blob.sha256);
      }
    };

    for (const blob of blobs) {
      const overrides = resolvedMeta[blob.sha256];
      const effectiveType = overrides?.type ?? blob.type;
      const effectiveName = overrides?.name ?? blob.name;
      const hasType = Boolean(effectiveType && effectiveType !== "application/octet-stream");
      const hasName = Boolean(effectiveName && effectiveName !== blob.sha256);
      const resourceUrl = blob.url || (() => {
        const fallback = blob.serverUrl ?? baseUrl;
        if (!fallback) return undefined;
        return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
      })();
      if (!resourceUrl) continue;
      const sameOrigin = isSameOrigin(resourceUrl);
      const alreadyAttempted = attemptedLookups.current.has(blob.sha256);
      const alreadyLoading = pendingLookups.current.has(blob.sha256);
      const canFetch = requiresAuth || sameOrigin;
      const storageServer = blob.serverUrl ?? baseUrl;
      const storedMetadata = getStoredBlobMetadata(storageServer, blob.sha256);
      const skipDueToFreshAttempt = isMetadataFresh(storedMetadata, ttlMs);
      const visibilityRequested = visibleRequestsRef.current.has(blob.sha256);

      if (hasType && hasName) {
        visibleRequestsRef.current.delete(blob.sha256);
        continue;
      }

      if (!visibilityRequested) {
        continue;
      }

      if (skipDueToFreshAttempt) {
        visibleRequestsRef.current.delete(blob.sha256);
        continue;
      }

      if (requiresAuth && !signTemplate) {
        continue;
      }

      if (!canFetch) {
        visibleRequestsRef.current.delete(blob.sha256);
        ensurePassiveProbe(blob, resourceUrl);
        continue;
      }

      if (alreadyAttempted || alreadyLoading) {
        visibleRequestsRef.current.delete(blob.sha256);
        continue;
      }

      attemptedLookups.current.add(blob.sha256);
      visibleRequestsRef.current.delete(blob.sha256);
      enqueue(() => resolveMetadata(blob, resourceUrl));
    }

    setVisibilitySignal(signal => signal);
  }, [baseUrl, blobs, detectedKinds, requiresAuth, resolvedMeta, serverType, signTemplate, ttlMs, visibilitySignal]);

  const reportDetectedKind = useCallback((sha: string, kind: "image" | "video") => {
    setDetectedKinds(prev => (prev[sha] === kind ? prev : { ...prev, [sha]: kind }));
  }, []);

  return useMemo(
    () => ({
      resolvedMeta,
      detectedKinds,
      requestMetadata,
      reportDetectedKind,
    }),
    [detectedKinds, reportDetectedKind, requestMetadata, resolvedMeta]
  );
};

function isSameOrigin(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin === window.location.origin;
  } catch (error) {
    return false;
  }
}

function deriveFilename(disposition?: string | null) {
  if (!disposition) return undefined;
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i) || disposition.match(/filename="?([^";]+)"?/i);
  if (!match) return undefined;
  const value = match[1];
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}
