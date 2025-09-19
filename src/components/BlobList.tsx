import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prettyBytes, prettyDate } from "../utils/format";
import { buildAuthorizationHeader, type BlossomBlob, type SignTemplate } from "../lib/blossomClient";
import { buildNip98AuthHeader } from "../lib/nip98";
import { CopyIcon, DownloadIcon, FileTypeIcon, TrashIcon } from "./icons";
import { setStoredBlobMetadata } from "../utils/blobMetadataStore";
import { cachePreviewBlob, getCachedPreviewBlob } from "../utils/blobPreviewCache";
import { useInViewport } from "../hooks/useInViewport";

export type BlobListProps = {
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  viewMode: "grid" | "list";
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
};

type DetectedKindMap = Record<string, "image" | "video">;

type ResolvedMeta = {
  type?: string;
  name?: string;
};

type ResolvedMetaMap = Record<string, ResolvedMeta>;

type FileKind = "image" | "video" | "pdf" | "doc" | "sheet" | "document";

type SortKey = "name" | "type" | "size" | "uploaded";

type SortConfig = { key: SortKey; direction: "asc" | "desc" };

const CARD_HEIGHT = 260;
const LIST_THUMBNAIL_SIZE = 48;

const deriveBlobSortName = (blob: BlossomBlob) => {
  const explicit = blob.name?.trim();
  if (explicit) return explicit.toLowerCase();
  if (blob.url) {
    const tail = blob.url.split("/").pop();
    if (tail) return tail.toLowerCase();
  }
  return blob.sha256.toLowerCase();
};

export const BlobList: React.FC<BlobListProps> = ({
  blobs,
  baseUrl,
  requiresAuth = false,
  signTemplate,
  serverType = "blossom",
  selected,
  viewMode,
  onToggle,
  onSelectMany,
  onDelete,
  onCopy,
  onPlay,
}) => {
  const [detectedKinds, setDetectedKinds] = useState<DetectedKindMap>({});
  const [resolvedMeta, setResolvedMeta] = useState<ResolvedMetaMap>({});
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const pendingLookups = useRef(new Set<string>());
  const attemptedLookups = useRef(new Set<string>());
  const passiveDetectors = useRef(new Map<string, () => void>());
  const isMounted = useRef(true);
  const metadataSchedulerRef = useRef<{ running: number; queue: Array<() => void>; generation: number }>({
    running: 0,
    queue: [],
    generation: 0,
  });
  const metadataAbortControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    return () => {
      isMounted.current = false;
      passiveDetectors.current.forEach(cleanup => cleanup());
      passiveDetectors.current.clear();
    };
  }, []);

  const handleDetect = useCallback((sha: string, kind: "image" | "video") => {
    setDetectedKinds(prev => (prev[sha] === kind ? prev : { ...prev, [sha]: kind }));
  }, []);

  useEffect(() => {
    setDetectedKinds(prev => {
      const next: DetectedKindMap = {};
      blobs.forEach(blob => {
        const kind = prev[blob.sha256];
        if (kind) next[blob.sha256] = kind;
      });
      return next;
    });
    setResolvedMeta(prev => {
      const next: ResolvedMetaMap = {};
      blobs.forEach(blob => {
        const meta = prev[blob.sha256];
        if (meta) next[blob.sha256] = meta;
      });
      return next;
    });
    const currentShas = new Set(blobs.map(blob => blob.sha256));
    attemptedLookups.current.forEach(sha => {
      if (!currentShas.has(sha)) attemptedLookups.current.delete(sha);
    });
    pendingLookups.current.forEach(sha => {
      if (!currentShas.has(sha)) pendingLookups.current.delete(sha);
    });
    passiveDetectors.current.forEach((cleanup, sha) => {
      if (!currentShas.has(sha)) {
        cleanup();
        passiveDetectors.current.delete(sha);
      }
    });
  }, [blobs]);

  useEffect(() => {
    const scheduler = metadataSchedulerRef.current;
    scheduler.generation += 1;
    scheduler.queue = [];
    scheduler.running = 0;
    const currentGeneration = scheduler.generation;

    metadataAbortControllers.current.forEach(controller => controller.abort());
    metadataAbortControllers.current.clear();

    const schedule = (task: () => Promise<void>) => {
      const execute = () => {
        if (scheduler.generation !== currentGeneration) return;
        scheduler.running += 1;
        task()
          .catch(() => undefined)
          .finally(() => {
            scheduler.running = Math.max(0, scheduler.running - 1);
            if (scheduler.generation !== currentGeneration) return;
            const next = scheduler.queue.shift();
            if (next) next();
          });
      };
      if (scheduler.running < 4) execute();
      else scheduler.queue.push(execute);
    };

    const resolveForBlob = async (blob: BlossomBlob, resourceUrl: string) => {
      const controller = new AbortController();
      metadataAbortControllers.current.set(blob.sha256, controller);
      pendingLookups.current.add(blob.sha256);

      try {
        const headers: Record<string, string> = {};
        const effectiveType = blob.serverType ?? serverType;
        const buildAuth = async (method: "HEAD" | "GET") => {
          if (!requiresAuth || !signTemplate) return undefined;
          if (effectiveType === "nip96") {
            return buildNip98AuthHeader(signTemplate, {
              url: resourceUrl,
              method,
            });
          }
          let resource: URL | null = null;
          try {
            resource = new URL(resourceUrl);
          } catch (error) {
            resource = null;
          }
          return buildAuthorizationHeader(signTemplate, "get", {
            hash: blob.sha256,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 120,
          });
        };

        if (requiresAuth) {
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
            if (requiresAuth) {
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
              } catch (error) {
                // Ignore cancellation errors; the headers are already available.
              }
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
          });
        }

        if (isMounted.current) {
          if (nextType?.startsWith("image/")) {
            handleDetect(blob.sha256, "image");
          } else if (nextType?.startsWith("video/")) {
            handleDetect(blob.sha256, "video");
          }
        }

        if (!nextType && !nextName) return;
        if (!isMounted.current) return;

        setResolvedMeta(prev => {
          const current = prev[blob.sha256] ?? {};
          const updated: ResolvedMeta = {
            type: nextType ?? current.type,
            name: nextName ?? current.name,
          };
          if (current.type === updated.type && current.name === updated.name) return prev;
          return { ...prev, [blob.sha256]: updated };
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      } finally {
        pendingLookups.current.delete(blob.sha256);
        metadataAbortControllers.current.delete(blob.sha256);
      }
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
        if (isMounted.current) {
          handleDetect(blob.sha256, "image");
        }
        cleanup();
      };
      img.onerror = () => {
        cleanup();
      };
      passiveDetectors.current.set(blob.sha256, cleanup);
      img.src = resourceUrl;
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

      if (!hasType || !hasName) {
        if (!canFetch) {
          ensurePassiveProbe(blob, resourceUrl);
          continue;
        }
      }

      if ((hasType && hasName) || alreadyAttempted || alreadyLoading) continue;
      if (requiresAuth && !signTemplate) continue;
      attemptedLookups.current.add(blob.sha256);
      schedule(() => resolveForBlob(blob, resourceUrl));
    }

    return () => {
      scheduler.queue = [];
      scheduler.running = 0;
      scheduler.generation += 1;
      metadataAbortControllers.current.forEach(controller => controller.abort());
      metadataAbortControllers.current.clear();
    };
  }, [blobs, baseUrl, requiresAuth, signTemplate, resolvedMeta, detectedKinds, handleDetect, serverType]);

  const decoratedBlobs = useMemo(() => {
    return blobs.map(blob => {
      const overrides = resolvedMeta[blob.sha256];
      const base = blob.serverUrl ?? baseUrl;
      const normalizedBase = base ? base.replace(/\/$/, "") : undefined;
      return {
        ...blob,
        type: overrides?.type ?? blob.type,
        name: overrides?.name ?? blob.name,
        url: blob.url || (normalizedBase ? `${normalizedBase}/${blob.sha256}` : undefined),
        serverUrl: normalizedBase ?? blob.serverUrl,
        requiresAuth: blob.requiresAuth ?? requiresAuth,
        serverType: blob.serverType ?? serverType,
      };
    });
  }, [blobs, resolvedMeta, baseUrl, requiresAuth, serverType]);

  const sortedBlobs = useMemo(() => {
    if (!sortConfig) {
      return [...decoratedBlobs].sort((a, b) => {
        const aUploaded = typeof a.uploaded === "number" ? a.uploaded : 0;
        const bUploaded = typeof b.uploaded === "number" ? b.uploaded : 0;
        if (aUploaded !== bUploaded) {
          return bUploaded - aUploaded;
        }
        return deriveBlobSortName(a).localeCompare(deriveBlobSortName(b));
      });
    }

    const { key, direction } = sortConfig;
    const modifier = direction === "asc" ? 1 : -1;

    return [...decoratedBlobs].sort((a, b) => {
      if (key === "size") {
        const aSize = typeof a.size === "number" ? a.size : -1;
        const bSize = typeof b.size === "number" ? b.size : -1;
        const diff = aSize - bSize;
        if (diff !== 0) return diff * modifier;
      } else if (key === "uploaded") {
        const aUploaded = typeof a.uploaded === "number" ? a.uploaded : 0;
        const bUploaded = typeof b.uploaded === "number" ? b.uploaded : 0;
        const diff = aUploaded - bUploaded;
        if (diff !== 0) return diff * modifier;
      } else {
        const aValue = key === "name" ? deriveBlobSortName(a) : (a.type ?? "").toLowerCase();
        const bValue = key === "name" ? deriveBlobSortName(b) : (b.type ?? "").toLowerCase();
        const diff = aValue.localeCompare(bValue);
        if (diff !== 0) return diff * modifier;
      }
      const fallback = deriveBlobSortName(a).localeCompare(deriveBlobSortName(b));
      return fallback * modifier;
    });
  }, [decoratedBlobs, sortConfig]);

  const gridBlobs = useMemo(() => {
    return [...decoratedBlobs].sort((a, b) => {
      const aUploaded = typeof a.uploaded === "number" ? a.uploaded : 0;
      const bUploaded = typeof b.uploaded === "number" ? b.uploaded : 0;
      if (aUploaded !== bUploaded) {
        return bUploaded - aUploaded;
      }
      return deriveBlobSortName(a).localeCompare(deriveBlobSortName(b));
    });
  }, [decoratedBlobs]);

  const handleSortToggle = useCallback((key: SortKey) => {
    setSortConfig(current => {
      if (!current || current.key !== key) {
        return { key, direction: "asc" };
      }
      if (current.direction === "asc") {
        return { key, direction: "desc" };
      }
      return null;
    });
  }, []);

  const handleDownload = useCallback(
    async (blob: BlossomBlob) => {
      if (!blob.url) return;
      let objectUrl: string | null = null;
      try {
        const headers: Record<string, string> = {};
        if (blob.requiresAuth) {
          if (!signTemplate) throw new Error("Signer required to authorize this download.");
          const kind = blob.serverType ?? serverType;
          if (kind === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url: blob.url,
              method: "GET",
            });
          } else {
            let resource: URL | null = null;
            try {
              resource = new URL(blob.url);
            } catch (error) {
              resource = null;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: blob.sha256,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob.serverUrl,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
              expiresInSeconds: 300,
            });
          }
        }

        const response = await fetch(blob.url, { headers, mode: "cors" });
        if (!response.ok) {
          throw new Error(`Download failed with status ${response.status}`);
        }

        const data = await response.blob();
        const disposition = response.headers.get("content-disposition") || undefined;
        const inferredName = deriveFilename(disposition);
        const baseName = sanitizeFilename(inferredName || blob.name || blob.sha256);
        const typeHint = blob.type || data.type;
        const extension = inferExtensionFromType(typeHint);
        const filename = ensureExtension(baseName, extension);

        objectUrl = URL.createObjectURL(data);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        console.error("Failed to download blob", error);
        if (typeof window !== "undefined") {
          const message = error instanceof Error ? error.message : "Failed to download blob.";
          window.alert(message);
        }
      } finally {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      }
    },
    [signTemplate, serverType]
  );

  const listBlobs = viewMode === "list" ? sortedBlobs : decoratedBlobs;

  return (
    <div className="flex h-full flex-1 min-h-0 w-full flex-col overflow-hidden">
      {viewMode === "list" ? (
        <ListLayout
          blobs={listBlobs}
          baseUrl={baseUrl}
          requiresAuth={requiresAuth}
          signTemplate={signTemplate}
          serverType={serverType}
          selected={selected}
          onToggle={onToggle}
          onSelectMany={onSelectMany}
          onDelete={onDelete}
          onDownload={handleDownload}
          onCopy={onCopy}
          onPlay={onPlay}
          detectedKinds={detectedKinds}
          onDetect={handleDetect}
          sortConfig={sortConfig}
          onSort={handleSortToggle}
        />
      ) : (
        <GridLayout
          blobs={gridBlobs}
          baseUrl={baseUrl}
          requiresAuth={requiresAuth}
          signTemplate={signTemplate}
          serverType={serverType}
          selected={selected}
          onToggle={onToggle}
          onDelete={onDelete}
          onDownload={handleDownload}
          onCopy={onCopy}
          onPlay={onPlay}
          detectedKinds={detectedKinds}
          onDetect={handleDetect}
        />
      )}
    </div>
  );
};

const GridLayout: React.FC<{
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
}> = ({
  blobs,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType,
  selected,
  onToggle,
  onSelectMany,
  onDelete,
  onDownload,
  onCopy,
  onPlay,
  detectedKinds,
  onDetect,
}) => {
  const CARD_WIDTH = 220;
  const GAP = 16;
  const OVERSCAN_ROWS = 2;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 0, width: 0, scrollTop: 0 });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let frame: number | null = null;
    const updateSize = () => {
      setViewport(prev => ({ height: el.clientHeight, width: el.clientWidth, scrollTop: prev.scrollTop }));
    };
    const handleScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewport(prev => ({ height: prev.height || el.clientHeight, width: prev.width || el.clientWidth, scrollTop: el.scrollTop }));
      });
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => updateSize()) : null;
    updateSize();
    el.addEventListener("scroll", handleScroll, { passive: true });
    if (resizeObserver) resizeObserver.observe(el);
    else window.addEventListener("resize", updateSize);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", handleScroll);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener("resize", updateSize);
    };
  }, [blobs.length]);

  const viewportHeight = viewport.height || 0;
  const viewportWidth = viewport.width || 0;
  const scrollTop = viewport.scrollTop;
  const columnCount = Math.max(1, Math.floor((viewportWidth + GAP) / (CARD_WIDTH + GAP)));
  const effectiveColumnWidth = Math.max(160, Math.floor((viewportWidth - GAP * (columnCount + 1)) / columnCount) || CARD_WIDTH);
  const rowHeight = CARD_HEIGHT + GAP;
  const rowCount = Math.ceil(blobs.length / columnCount);
  const visibleRowCount = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + OVERSCAN_ROWS * 2 : rowCount;
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const endRow = Math.min(rowCount, startRow + visibleRowCount);
  const items: Array<{ blob: BlossomBlob; row: number; col: number }> = [];
  for (let row = startRow; row < endRow; row += 1) {
    for (let col = 0; col < columnCount; col += 1) {
      const index = row * columnCount + col;
      if (index >= blobs.length) break;
      const blob = blobs[index];
      if (!blob) continue;
      items.push({ blob, row, col });
    }
  }
  const containerHeight = rowCount * rowHeight + GAP;

  return (
    <div className="flex flex-1 min-h-0 w-full flex-col overflow-hidden">
      <div ref={viewportRef} className="relative flex-1 min-h-0 w-full overflow-y-auto px-2">
        <div style={{ position: "relative", height: containerHeight }}>
          {items.map(({ blob, row, col }) => {
            const isSelected = selected.has(blob.sha256);
            const isAudio = blob.type?.startsWith("audio/");
            const displayName = buildDisplayName(blob);
            const previewRequiresAuth = blob.requiresAuth ?? requiresAuth;
            const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
            const disablePreview = kind === "doc" || kind === "sheet" || kind === "pdf";
            const previewUrl = disablePreview ? null : blob.url;
            const top = GAP + row * rowHeight;
            const left = GAP + col * (effectiveColumnWidth + GAP);
            return (
              <React.Fragment key={blob.sha256}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => onToggle(blob.sha256)}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggle(blob.sha256);
                    }
                  }}
                  className={`absolute flex flex-col overflow-hidden rounded-xl border focus:outline-none focus:ring-2 focus:ring-emerald-500/70 focus:ring-offset-2 focus:ring-offset-slate-900 cursor-pointer transition ${
                    isSelected ? "border-emerald-500 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60"
                  }`}
                  style={{ top, left, width: effectiveColumnWidth, height: CARD_HEIGHT }}
                >
                  <div className="relative flex-1" style={{ height: CARD_HEIGHT * 0.75 }}>
                    {previewUrl ? (
                      <BlobPreview
                        sha={blob.sha256}
                        url={previewUrl}
                        name={blob.name || blob.sha256}
                        type={blob.type}
                        serverUrl={blob.serverUrl ?? baseUrl}
                        requiresAuth={previewRequiresAuth}
                        signTemplate={previewRequiresAuth ? signTemplate : undefined}
                        serverType={blob.serverType ?? serverType}
                        onDetect={onDetect}
                        fallbackIconSize={Math.round(CARD_HEIGHT * 0.5)}
                        className="h-full rounded-none border-0 bg-transparent"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-slate-950/80">
                        <FileTypeIcon kind={kind} size={Math.round(CARD_HEIGHT * 0.5)} className="text-slate-300" />
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-2">
                      <div
                        className="w-full truncate rounded-md bg-slate-950/75 px-2 py-1 text-xs font-medium text-slate-100 text-center"
                        title={displayName}
                      >
                        {displayName}
                      </div>
                    </div>
                  </div>
                  <div
                    className="flex flex-wrap items-center justify-center gap-2 border-t border-slate-800/80 bg-slate-950/90 px-4 py-3"
                    style={{ height: CARD_HEIGHT * 0.25 }}
                  >
                    {blob.url && (
                      <button
                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                        onClick={event => {
                          event.stopPropagation();
                          onCopy(blob);
                        }}
                        aria-label="Copy blob URL"
                        title="Copy URL"
                      >
                        <CopyIcon size={16} />
                      </button>
                    )}
                    {blob.url && (
                      <button
                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                        onClick={event => {
                          event.stopPropagation();
                          onDownload(blob);
                        }}
                        aria-label="Download blob"
                        title="Download"
                      >
                        <DownloadIcon size={16} />
                      </button>
                    )}
                    <button
                      className="p-2 rounded-lg bg-red-900/80 hover:bg-red-800 text-slate-100"
                      onClick={event => {
                        event.stopPropagation();
                        onDelete(blob);
                      }}
                      aria-label="Delete blob"
                      title="Delete"
                    >
                      <TrashIcon size={16} />
                    </button>
                    {isAudio && onPlay && blob.url && (
                      <button
                        className="px-2 py-1 text-xs rounded-lg bg-emerald-700/70 hover:bg-emerald-600"
                        onClick={event => {
                          event.stopPropagation();
                          onPlay?.(blob);
                        }}
                      >
                        Play
                      </button>
                    )}
                  </div>
                </div>
              </React.Fragment>
            );

          })}
          {blobs.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
              No content on this server yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ListThumbnail: React.FC<{
  blob: BlossomBlob;
  kind: FileKind;
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  onDetect?: (sha: string, kind: "image" | "video") => void;
}> = ({ blob, kind, baseUrl, requiresAuth, signTemplate, serverType = "blossom", onDetect }) => {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [textPreview, setTextPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const lastFailureKeyRef = useRef<string | null>(null);
  const activeRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const [observeTarget, isVisible] = useInViewport<HTMLDivElement>({ rootMargin: "200px" });

  const containerClass = "flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80 relative";
  const effectiveRequiresAuth = blob.requiresAuth ?? requiresAuth;
  const effectiveServerType = blob.serverType ?? serverType;
  const disablePreview = kind === "doc" || kind === "sheet" || kind === "pdf";
  const previewUrl = disablePreview
    ? undefined
    : blob.url || (() => {
    const fallback = blob.serverUrl ?? baseUrl;
    if (!fallback) return undefined;
    return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
  })();
  const previewKey = previewUrl ? `${blob.sha256}|${previewUrl}|${effectiveRequiresAuth ? "auth" : "anon"}` : null;

  const metaSuggestsText = useMemo(
    () => !disablePreview && isPreviewableTextType({ mime: blob.type, name: blob.name, url: previewUrl }),
    [disablePreview, blob.type, blob.name, previewUrl]
  );

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!previewKey) {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      lastLoadedKeyRef.current = null;
      lastFailureKeyRef.current = null;
      setSrc(null);
      setIsLoaded(false);
      setFailed(false);
      setTextPreview(null);
      return;
    }

    const hasLoadedCurrent = lastLoadedKeyRef.current === previewKey;
    if (hasLoadedCurrent) {
      return;
    }

    if (lastFailureKeyRef.current === previewKey) {
      return;
    }

    if (effectiveRequiresAuth && !signTemplate) {
      lastFailureKeyRef.current = previewKey;
      setFailed(true);
      return;
    }

    if (!previewUrl) {
      return;
    }

    const resolvedPreviewUrl = previewUrl;

    const existingRequest = activeRequestRef.current;
    if (existingRequest) {
      if (existingRequest.key === previewKey) {
        return;
      }
      existingRequest.controller.abort();
      activeRequestRef.current = null;
    }

    const controller = new AbortController();
    activeRequestRef.current = { key: previewKey, controller };
    let cancelled = false;

    lastFailureKeyRef.current = null;
    setFailed(false);
    setIsLoaded(false);
    setSrc(null);
    setTextPreview(null);

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    const finalizeRequest = () => {
      if (activeRequestRef.current?.controller === controller) {
        activeRequestRef.current = null;
      }
    };

    const assignObjectUrl = (blobData: Blob) => {
      if (cancelled) return;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setTextPreview(null);
      const objectUrl = URL.createObjectURL(blobData);
      objectUrlRef.current = objectUrl;
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(objectUrl);
    };

    const useDirectUrl = () => {
      if (cancelled) return;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setTextPreview(null);
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(resolvedPreviewUrl);
    };

    const showTextPreview = async (blobData: Blob, mimeHint?: string | null) => {
      const normalizedMime = mimeHint ?? blobData.type ?? blob.type;
      const shouldRenderText =
        isPreviewableTextType({ mime: normalizedMime, name: blob.name, url: resolvedPreviewUrl }) ||
        (!normalizedMime && isPreviewableTextType({ name: blob.name, url: resolvedPreviewUrl })) ||
        metaSuggestsText;
      if (!shouldRenderText) return false;
      try {
        const preview = await buildTextPreview(blobData);
        if (cancelled) return true;
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
        setSrc(null);
        setTextPreview(preview);
        setIsLoaded(true);
        setFailed(false);
        lastLoadedKeyRef.current = previewKey;
        lastFailureKeyRef.current = null;
        return true;
      } catch (error) {
        return false;
      }
    };

    const load = async () => {
      try {
        const cached = metaSuggestsText
          ? null
          : await getCachedPreviewBlob(blob.serverUrl ?? baseUrl, blob.sha256);
        if (cancelled) return;
        if (cached) {
          assignObjectUrl(cached);
          return;
        }

        const match = resolvedPreviewUrl.match(/[0-9a-f]{64}/i);

        if (!effectiveRequiresAuth) {
          try {
            const response = await fetch(resolvedPreviewUrl, { mode: "cors", signal: controller.signal });
            if (!response.ok || response.type === "opaqueredirect" || response.type === "opaque") {
              throw new Error(`Preview fetch failed (${response.status})`);
            }
            const blobData = await response.blob();
            if (cancelled) return;
            const mime = response.headers.get("content-type") || blobData.type || blob.type || undefined;
            const handled = await showTextPreview(blobData, mime);
            if (handled) return;
            assignObjectUrl(blobData);
            await cachePreviewBlob(blob.serverUrl ?? baseUrl, blob.sha256, blobData);
            return;
          } catch (error) {
            if (cancelled) return;
            if (error instanceof DOMException && error.name === "AbortError") {
              return;
            }
            if (!metaSuggestsText) {
              useDirectUrl();
            } else {
              lastLoadedKeyRef.current = null;
              if (previewKey) {
                lastFailureKeyRef.current = previewKey;
              }
              setFailed(true);
            }
            return;
          }
        }

        if (!signTemplate) {
          if (!cancelled) {
            setFailed(true);
          }
          return;
        }

        const headers: Record<string, string> = {};
        if (effectiveRequiresAuth) {
          if (effectiveServerType === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url: resolvedPreviewUrl,
              method: "GET",
            });
          } else {
            let resource: URL | undefined;
            try {
              resource = new URL(resolvedPreviewUrl);
            } catch (error) {
              resource = undefined;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: match ? match[0] : undefined,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            });
          }
        }

        const response = await fetch(resolvedPreviewUrl, { headers, signal: controller.signal });
        if (!response.ok || response.type === "opaqueredirect" || response.type === "opaque") {
          throw new Error(`Preview fetch failed (${response.status})`);
        }

        const blobData = await response.blob();
        if (cancelled) return;
        const mime = response.headers.get("content-type") || blobData.type || blob.type || undefined;
        const handled = await showTextPreview(blobData, mime);
        if (handled) return;
        assignObjectUrl(blobData);
        await cachePreviewBlob(blob.serverUrl ?? baseUrl, blob.sha256, blobData);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setFailed(true);
        lastLoadedKeyRef.current = null;
        lastFailureKeyRef.current = previewKey;
      }
    };

    void load().finally(finalizeRequest);

    return () => {
      cancelled = true;
      controller.abort();
      finalizeRequest();
    };
  }, [previewKey, isVisible, previewUrl, blob.serverUrl, baseUrl, effectiveRequiresAuth, effectiveServerType, signTemplate, blob.sha256]);

  useEffect(() => {
    if (!previewKey) return;
    if (!isVisible && lastFailureKeyRef.current === previewKey) {
      lastFailureKeyRef.current = null;
    }
  }, [isVisible, previewKey]);

  useEffect(() => {
    if (!previewKey) return;
    if (effectiveRequiresAuth && signTemplate && lastFailureKeyRef.current === previewKey) {
      lastFailureKeyRef.current = null;
    }
  }, [previewKey, effectiveRequiresAuth, signTemplate]);

  const altText = blob.name || previewUrl?.split("/").pop() || blob.sha256;
  const showText = Boolean(textPreview) && !failed;
  const showMedia = Boolean(src) && !failed && Boolean(previewUrl);
  const showOverlay = (!showMedia && !showText) || (showMedia && !isLoaded);
  const fallbackIconSize = Math.round(LIST_THUMBNAIL_SIZE * 0.6);

  return (
    <div ref={observeTarget} className={containerClass}>
      {showText && textPreview && (
        <div className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-slate-950/85 px-2 py-1">
          <pre className="flex-1 overflow-hidden whitespace-pre-wrap break-words font-mono text-[9px] leading-tight text-slate-200" title={textPreview.content}>
            {textPreview.content}
          </pre>
        </div>
      )}
      {showMedia && (
        <img
          src={src!}
          alt={altText}
          className={`h-full w-full object-cover transition-opacity duration-150 ${isLoaded ? "opacity-100" : "opacity-0"}`}
          loading="lazy"
          onLoad={() => {
            setIsLoaded(true);
            onDetect?.(blob.sha256, "image");
          }}
          onError={() => {
            if (objectUrlRef.current) {
              URL.revokeObjectURL(objectUrlRef.current);
              objectUrlRef.current = null;
            }
            lastLoadedKeyRef.current = null;
            if (previewKey) {
              lastFailureKeyRef.current = previewKey;
            }
            setSrc(null);
            setIsLoaded(false);
            setFailed(true);
          }}
        />
      )}
      {showOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 pointer-events-none">
          <FileTypeIcon kind={kind} size={fallbackIconSize} className="text-slate-300" />
        </div>
      )}
    </div>
  );
};

function ListRow({
  blob,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType,
  selected,
  onToggle,
  onDelete,
  onDownload,
  onCopy,
  onPlay,
  detectedKinds,
  onDetect,
}: {
  blob: BlossomBlob;
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
}) {
  const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
  const isAudio = blob.type?.startsWith("audio/");
  const displayName = buildDisplayName(blob);
  const isSelected = selected.has(blob.sha256);

  return (
    <tr
      className={`border-b border-slate-800 transition-colors ${
        isSelected ? "bg-slate-800/50" : "hover:bg-slate-800/40"
      }`}
      onClick={event => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
        onToggle(blob.sha256);
      }}
    >
      <td className="w-12 py-3 px-3 align-middle">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          checked={isSelected}
          onChange={() => onToggle(blob.sha256)}
          aria-label={`Select ${displayName}`}
          onClick={event => event.stopPropagation()}
        />
      </td>
      <td className="py-3 px-3">
        <div className="flex items-center gap-3">
          <ListThumbnail
            blob={blob}
            kind={kind}
            baseUrl={baseUrl}
            requiresAuth={requiresAuth}
            signTemplate={signTemplate}
            serverType={serverType}
            onDetect={(sha, detectedKind) => onDetect(sha, detectedKind)}
          />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-slate-100 truncate">{displayName}</div>
            <div className="text-xs text-slate-500 truncate">{blob.sha256}</div>
          </div>
        </div>
      </td>
      <td className="w-48 py-3 px-3 truncate text-sm text-slate-400">
        {blob.type || "application/octet-stream"}
      </td>
      <td className="w-24 py-3 px-3 text-sm text-slate-400 whitespace-nowrap">
        {prettyBytes(blob.size || 0)}
      </td>
      <td className="w-32 py-3 px-3 text-sm text-slate-400 whitespace-nowrap">
        {blob.uploaded ? prettyDate(blob.uploaded) : "—"}
      </td>
      <td className="w-40 py-3 pl-3 pr-0">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {blob.url && (
            <button
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
              onClick={event => {
                event.stopPropagation();
                onCopy(blob);
              }}
              aria-label="Copy blob URL"
              title="Copy URL"
            >
              <CopyIcon size={16} />
            </button>
          )}
          {blob.url && (
            <button
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
              onClick={event => {
                event.stopPropagation();
                onDownload(blob);
              }}
              aria-label="Download blob"
              title="Download"
            >
              <DownloadIcon size={16} />
            </button>
          )}
          <button
            className="p-2 rounded-lg bg-red-900/80 hover:bg-red-800 text-slate-100"
            onClick={event => {
              event.stopPropagation();
              onDelete(blob);
            }}
            aria-label="Delete blob"
            title="Delete"
          >
            <TrashIcon size={16} />
          </button>
          {isAudio && onPlay && blob.url && (
            <button
              className="px-2 py-1 text-xs rounded-lg bg-emerald-700/70 hover:bg-emerald-600"
              onClick={event => {
                event.stopPropagation();
                onPlay(blob);
              }}
            >
              Play
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

const ListLayout: React.FC<{
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
  sortConfig: SortConfig | null;
  onSort: (key: SortKey) => void;
}> = ({
  blobs,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType,
  selected,
  onToggle,
  onSelectMany,
  onDelete,
  onDownload,
  onCopy,
  onPlay,
  detectedKinds,
  onDetect,
  sortConfig,
  onSort,
}) => {
  const COLUMN_COUNT = 6;
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const allSelected = blobs.length > 0 && blobs.every(blob => selected.has(blob.sha256));
  const partiallySelected = !allSelected && blobs.some(blob => selected.has(blob.sha256));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected, allSelected]);

  const indicatorFor = (key: SortKey) => {
    if (!sortConfig || sortConfig.key !== key) return null;
    return sortConfig.direction === "asc" ? "^" : "v";
  };

  const ariaSortFor = (key: SortKey): "ascending" | "descending" | undefined => {
    if (!sortConfig || sortConfig.key !== key) return undefined;
    return sortConfig.direction === "asc" ? "ascending" : "descending";
  };

  return (
    <div className="flex flex-1 min-h-0 w-full flex-col overflow-hidden pb-1">
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="min-w-full table-fixed text-sm text-slate-300">
          <thead className="text-[11px] uppercase tracking-wide text-slate-300">
            <tr>
              <th scope="col" className="w-12 py-2 px-3">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  checked={allSelected}
                  onChange={event => {
                    const value = event.target.checked;
                    if (onSelectMany) {
                      onSelectMany(
                        blobs.map(blob => blob.sha256),
                        value
                      );
                    } else {
                      blobs.forEach(blob => {
                        const isSelected = selected.has(blob.sha256);
                        if (value && !isSelected) onToggle(blob.sha256);
                        if (!value && isSelected) onToggle(blob.sha256);
                      });
                    }
                  }}
                  aria-label="Select all files"
                />
              </th>
              <th
                scope="col"
                className="py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("name")}
                onClick={() => onSort("name")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("name");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Name</span>
                  <span aria-hidden="true">{indicatorFor("name")}</span>
                </div>
              </th>
              <th
                scope="col"
                className="w-48 py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("type")}
                onClick={() => onSort("type")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("type");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Type</span>
                  <span aria-hidden="true">{indicatorFor("type")}</span>
                </div>
              </th>
              <th
                scope="col"
                className="w-24 py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("size")}
                onClick={() => onSort("size")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("size");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Size</span>
                  <span aria-hidden="true">{indicatorFor("size")}</span>
                </div>
              </th>
              <th
                scope="col"
                className="w-32 py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("uploaded")}
                onClick={() => onSort("uploaded")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("uploaded");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Updated</span>
                  <span aria-hidden="true">{indicatorFor("uploaded")}</span>
                </div>
              </th>
              <th scope="col" className="w-40 py-2 pl-3 pr-0 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {blobs.map(blob => (
              <ListRow
                key={blob.sha256}
                blob={blob}
                baseUrl={baseUrl}
                requiresAuth={requiresAuth}
                signTemplate={signTemplate}
                serverType={serverType}
                selected={selected}
                onToggle={onToggle}
                onDelete={onDelete}
                onDownload={onDownload}
                onCopy={onCopy}
                onPlay={onPlay}
                detectedKinds={detectedKinds}
                onDetect={onDetect}
              />
            ))}
            {blobs.length === 0 && (
              <tr>
                <td colSpan={COLUMN_COUNT} className="py-6 px-3 text-sm text-center text-slate-300">
                  No content on this server yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const BlobPreview: React.FC<{
  sha: string;
  url: string;
  name: string;
  type?: string;
  serverUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  onDetect: (sha: string, kind: "image" | "video") => void;
  className?: string;
  fallbackIconSize?: number;
}> = ({
  sha,
  url,
  name,
  type,
  serverUrl,
  requiresAuth = false,
  signTemplate,
  serverType = "blossom",
  onDetect,
  className,
  fallbackIconSize,
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewType, setPreviewType] = useState<"image" | "video" | "text" | "unknown">(() => {
    if (isPreviewableTextType({ mime: type, name, url })) return "text";
    return inferKind(type, url) ?? "unknown";
  });
  const [isReady, setIsReady] = useState(false);
  const [textPreview, setTextPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const lastFailureKeyRef = useRef<string | null>(null);
  const activeRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const [observeTarget, isVisible] = useInViewport<HTMLDivElement>({ rootMargin: "400px" });

  const fallbackIconKind = useMemo<FileKind>(() => {
    if (previewType === "image" || previewType === "video") return previewType;
    if (isSheetType(type, name || url)) return "sheet";
    if (isDocType(type, name || url)) return "doc";
    if (isPdfType(type, name || url)) return "pdf";
    if (isPreviewableTextType({ mime: type, name, url })) return "document";
    return "document";
  }, [previewType, type, name, url]);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const cacheServerHint = useMemo(() => {
    if (serverUrl) return serverUrl.replace(/\/+$/, "");
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch (error) {
      return undefined;
    }
  }, [serverUrl, url]);

  const metaSuggestsText = useMemo(() => isPreviewableTextType({ mime: type, name, url }), [type, name, url]);

  const previewKey = `${sha}|${requiresAuth ? "auth" : "anon"}|${url}`;

  useEffect(() => {
    if (isPreviewableTextType({ mime: type, name, url })) {
      setPreviewType("text");
    } else {
      setPreviewType(inferKind(type, url) ?? "unknown");
    }
  }, [type, url, name]);

  useEffect(() => {
    return () => {
      releaseObjectUrl();
    };
  }, [releaseObjectUrl]);

  useEffect(() => {
    if (lastLoadedKeyRef.current === previewKey) {
      return;
    }

    if (lastFailureKeyRef.current === previewKey) {
      return;
    }

    if (requiresAuth && !signTemplate) {
      lastFailureKeyRef.current = previewKey;
      setFailed(true);
      setLoading(false);
      return;
    }

    const existingRequest = activeRequestRef.current;
    if (existingRequest) {
      if (existingRequest.key === previewKey) {
        return;
      }
      existingRequest.controller.abort();
      activeRequestRef.current = null;
    }

    const controller = new AbortController();
    activeRequestRef.current = { key: previewKey, controller };
    let cancelled = false;

    lastFailureKeyRef.current = null;
    setFailed(false);
    setLoading(true);
    setIsReady(false);
    setSrc(null);
    setTextPreview(null);
    releaseObjectUrl();

    const existingKind = inferKind(type, url);
    if (!requiresAuth && existingKind) {
      setPreviewType(existingKind);
      onDetect(sha, existingKind);
    }

    const finalizeRequest = () => {
      if (activeRequestRef.current?.controller === controller) {
        activeRequestRef.current = null;
      }
    };

    const assignObjectUrl = (blobData: Blob) => {
      if (cancelled) return;
      releaseObjectUrl();
      setTextPreview(null);
      setIsReady(false);
      const objectUrl = URL.createObjectURL(blobData);
      objectUrlRef.current = objectUrl;
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(objectUrl);
      setLoading(false);
    };

    const useDirectUrl = () => {
      if (cancelled) return;
      releaseObjectUrl();
      setTextPreview(null);
      setIsReady(false);
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(url);
      setLoading(false);
    };

    const showTextPreview = async (blobData: Blob, mimeHint?: string | null) => {
      const normalizedMime = mimeHint ?? blobData.type ?? type;
      const shouldRenderText =
        isPreviewableTextType({ mime: normalizedMime, name, url }) ||
        (!normalizedMime && isPreviewableTextType({ name, url })) ||
        metaSuggestsText;
      if (!shouldRenderText) return false;

      let preview: { content: string; truncated: boolean };
      try {
        preview = await buildTextPreview(blobData);
      } catch (error) {
        return false;
      }
      if (cancelled) return true;
      releaseObjectUrl();
      setSrc(null);
      setPreviewType("text");
      setTextPreview(preview);
      setIsReady(true);
      setLoading(false);
      setFailed(false);
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      return true;
    };

    const load = async () => {
      try {
        const cached = metaSuggestsText ? null : await getCachedPreviewBlob(cacheServerHint, sha);
        if (cancelled) return;
        if (cached) {
          assignObjectUrl(cached);
          return;
        }

        const match = url.match(/[0-9a-f]{64}/i);

        if (!requiresAuth) {
          try {
            const response = await fetch(url, { mode: "cors", signal: controller.signal });
            if (!response.ok || response.type === "opaqueredirect" || response.type === "opaque") {
              throw new Error(`Preview fetch failed (${response.status})`);
            }
            const blobData = await response.blob();
            if (cancelled) return;
            const mime = response.headers.get("content-type") || blobData.type || type || "";
            const handled = await showTextPreview(blobData, mime);
            if (handled) return;
            assignObjectUrl(blobData);
            await cachePreviewBlob(cacheServerHint, sha, blobData);
          } catch (error) {
            if (cancelled) return;
            if (error instanceof DOMException && error.name === "AbortError") {
              return;
            }
            if (!metaSuggestsText) {
              useDirectUrl();
            } else {
              lastLoadedKeyRef.current = null;
              lastFailureKeyRef.current = previewKey;
              setFailed(true);
              setLoading(false);
            }
          }
          return;
        }

        const headers: Record<string, string> = {};
        if (serverType === "nip96") {
          headers.Authorization = await buildNip98AuthHeader(signTemplate!, {
            url,
            method: "GET",
          });
        } else {
          let resource: URL | undefined;
          try {
            resource = new URL(url);
          } catch (error) {
            resource = undefined;
          }
          headers.Authorization = await buildAuthorizationHeader(signTemplate!, "get", {
            hash: match ? match[0] : undefined,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
          });
        }

        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok || response.type === "opaqueredirect" || response.type === "opaque") {
          throw new Error(`Preview fetch failed (${response.status})`);
        }

        const blobData = await response.blob();
        if (cancelled) return;
        const mime = response.headers.get("content-type") || blobData.type || type || "";
        const handled = await showTextPreview(blobData, mime);
        if (handled) return;
        const detectedType = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : previewType;
        setPreviewType(detectedType);
        if (detectedType === "image" || detectedType === "video") {
          onDetect(sha, detectedType);
        }
        assignObjectUrl(blobData);
        await cachePreviewBlob(cacheServerHint, sha, blobData);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        lastLoadedKeyRef.current = null;
        lastFailureKeyRef.current = previewKey;
        setFailed(true);
        setLoading(false);
      }
    };

    void load().finally(finalizeRequest);

    return () => {
      cancelled = true;
      controller.abort();
      finalizeRequest();
    };
  }, [previewKey, isVisible, requiresAuth, signTemplate, releaseObjectUrl, cacheServerHint, sha, type, url, serverType, onDetect]);

  useEffect(() => {
    if (!isVisible && lastFailureKeyRef.current === previewKey) {
      lastFailureKeyRef.current = null;
    }
  }, [isVisible, previewKey]);

  useEffect(() => {
    if (requiresAuth && signTemplate && lastFailureKeyRef.current === previewKey) {
      lastFailureKeyRef.current = null;
    }
  }, [requiresAuth, signTemplate, previewKey]);

  const handlePreviewError = () => {
    releaseObjectUrl();
    lastLoadedKeyRef.current = null;
    lastFailureKeyRef.current = previewKey;
    setSrc(null);
    setTextPreview(null);
    setIsReady(false);
    setLoading(false);
    setFailed(true);
  };

  const showText = Boolean(textPreview) && !failed;
  const showMedia = Boolean(src) && !failed;
  const isVideo = showMedia && previewType === "video";
  const isImage = showMedia && previewType !== "video";
  const showLoading = loading || (showMedia && !isReady);
  const showUnavailable = !loading && !showText && !showMedia && failed;

  const containerClass =
    "relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80";

  return (
    <div ref={observeTarget} className={`${containerClass} ${className ?? "h-40"}`}>
      {showText && textPreview && (
        <div className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-slate-950/85 px-3 py-2">
          <pre className="flex-1 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-slate-200" title={textPreview.content}>
            {textPreview.content}
          </pre>
        </div>
      )}
      {isVideo && (
        <video
          src={src!}
          className={`max-h-full max-w-full transition-opacity duration-200 ${
            isReady ? "opacity-100" : "opacity-0"
          }`}
          controls={false}
          autoPlay
          muted
          loop
          playsInline
          onLoadedData={() => {
            setPreviewType("video");
            setIsReady(true);
            setLoading(false);
            onDetect(sha, "video");
          }}
          onError={handlePreviewError}
        />
      )}
      {isImage && (
        <img
          src={src!}
          alt={name}
          className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${
            isReady ? "opacity-100" : "opacity-0"
          }`}
          loading="lazy"
          onLoad={() => {
            setPreviewType("image");
            setIsReady(true);
            setLoading(false);
            onDetect(sha, "image");
          }}
          onError={handlePreviewError}
        />
      )}
      {showLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs text-slate-300 pointer-events-none">
          Loading preview…
        </div>
      )}
      {showUnavailable && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70">
          <FileTypeIcon
            kind={fallbackIconKind}
            size={fallbackIconSize ?? 96}
            className="text-slate-300"
          />
        </div>
      )}
    </div>
  );
};

function deriveFilename(disposition?: string) {
  if (!disposition) return undefined;
  const starMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8''|)([^;]+)/i);
  if (starMatch?.[1]) {
    const value = starMatch[1].trim().replace(/^UTF-8''/i, "");
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }
  const quotedMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (quotedMatch?.[1]) return quotedMatch[1];
  return undefined;
}

function isSameOrigin(url: string) {
  try {
    const target = new URL(url, window.location.href);
    return target.origin === window.location.origin;
  } catch (error) {
    return false;
  }
}

function decideFileKind(blob: BlossomBlob, detected?: "image" | "video"): FileKind {
  if (detected) return detected;
  if (isSheetType(blob.type, blob.name || blob.url)) return "sheet";
  if (isDocType(blob.type, blob.name || blob.url)) return "doc";
  if (isPdfType(blob.type, blob.name || blob.url)) return "pdf";
  const inferred = inferKind(blob.type, blob.name || blob.url);
  if (inferred) return inferred;
  return "document";
}

function inferKind(type?: string, ref?: string | null): "image" | "video" | undefined {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|hevc)$/.test(name)) return "video";
  return undefined;
}

function isPdfType(type?: string, ref?: string | null) {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (mime === "application/pdf") return true;
  return name.endsWith(".pdf");
}

function isDocType(type?: string, ref?: string | null) {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (
    mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.oasis.opendocument.text" ||
    mime === "application/vnd.apple.pages"
  ) {
    return true;
  }
  return /\.(docx?|docm|dotx|dotm|odt|pages)$/i.test(name);
}

function isSheetType(type?: string, ref?: string | null) {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    mime === "application/vnd.apple.numbers"
  ) {
    return true;
  }
  return /\.(xlsx?|ods|numbers)$/i.test(name);
}

const TEXT_PREVIEW_MIME_ALLOWLIST = new Set(
  [
    "text/plain",
    "text/log",
    "text/csv",
    "text/markdown",
    "text/x-markdown",
    "text/css",
    "text/javascript",
    "application/json",
    "application/xml",
    "text/xml",
  ].map(value => value.toLowerCase())
);

const TEXT_PREVIEW_EXTENSION_ALLOWLIST = new Set([
  "txt",
  "log",
  "csv",
  "md",
  "markdown",
  "css",
  "js",
  "mjs",
  "cjs",
  "json",
  "xml",
]);

const TEXT_PREVIEW_MAX_BYTES = 32 * 1024;
const TEXT_PREVIEW_MAX_LINES = 40;
const TEXT_PREVIEW_MAX_CHARS = 2000;

type TextPreviewMeta = {
  mime?: string | null;
  name?: string | null;
  url?: string | null;
};

function isPreviewableTextType(meta: TextPreviewMeta): boolean {
  const mime = normalizeMime(meta.mime);
  if (mime) {
    if (TEXT_PREVIEW_MIME_ALLOWLIST.has(mime)) return true;
    // Explicitly avoid treating other text types as previews unless they match the allow list.
  }

  if (hasTextPreviewExtension(meta.name)) return true;
  if (hasTextPreviewExtension(meta.url)) return true;

  return false;
}

async function buildTextPreview(blob: Blob): Promise<{ content: string; truncated: boolean }> {
  const limitedBlob = blob.size > TEXT_PREVIEW_MAX_BYTES ? blob.slice(0, TEXT_PREVIEW_MAX_BYTES) : blob;
  const raw = await limitedBlob.text();
  let truncated = blob.size > TEXT_PREVIEW_MAX_BYTES;

  const sanitized = raw.replace(/\u0000/g, "\uFFFD").replace(/\r\n/g, "\n");
  let content = sanitized;

  const lines = content.split("\n");
  if (lines.length > TEXT_PREVIEW_MAX_LINES) {
    content = lines.slice(0, TEXT_PREVIEW_MAX_LINES).join("\n");
    truncated = true;
  }

  if (content.length > TEXT_PREVIEW_MAX_CHARS) {
    content = content.slice(0, TEXT_PREVIEW_MAX_CHARS);
    truncated = true;
  }

  content = content.trimEnd();
  if (!content) {
    return { content: "(empty file)", truncated };
  }

  if (truncated) {
    content = `${content}\n…`;
  }

  return { content, truncated };
}

function normalizeMime(value?: string | null) {
  if (!value) return undefined;
  const [primary] = value.split(";");
  return primary?.trim().toLowerCase() || undefined;
}

function hasTextPreviewExtension(ref?: string | null) {
  if (!ref) return false;
  const lower = ref.toLowerCase();
  const sanitized = lower.split(/[?#]/)[0];
  const lastDot = sanitized.lastIndexOf(".");
  if (lastDot === -1 || lastDot === sanitized.length - 1) return false;
  const ext = sanitized.slice(lastDot + 1);
  return TEXT_PREVIEW_EXTENSION_ALLOWLIST.has(ext);
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[\r\n]+/g, " ");
  const segments = cleaned.split(/[\\/]/);
  return segments[segments.length - 1] || "download";
}

function inferExtensionFromType(type?: string) {
  if (!type) return undefined;
  const [mime] = type.split(";");
  const lookup: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.apple.pages": "pages",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.apple.numbers": "numbers",
    "text/plain": "txt",
  };
  if (!mime) return undefined;
  return lookup[mime.trim().toLowerCase()];
}

function ensureExtension(filename: string, extension?: string) {
  if (!extension) return filename;
  const lower = filename.toLowerCase();
  if (lower.endsWith(`.${extension.toLowerCase()}`)) return filename;
  return `${filename}.${extension}`;
}

function buildDisplayName(blob: BlossomBlob) {
  const raw = blob.name || blob.url?.split("/").pop() || blob.sha256;
  const sanitized = sanitizeFilename(raw);
  const { baseName, extension: existingExtension } = splitNameAndExtension(sanitized);
  const inferredExtension = existingExtension || inferExtensionFromType(blob.type);
  const truncatedBase = truncateMiddle(baseName, 12, 12);
  return inferredExtension ? `${truncatedBase}.${inferredExtension}` : truncatedBase;
}

function splitNameAndExtension(filename: string) {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return { baseName: trimmed, extension: undefined };
  }
  const baseName = trimmed.slice(0, lastDot);
  const extension = trimmed.slice(lastDot + 1);
  return { baseName, extension };
}

function truncateMiddle(value: string, head: number, tail: number) {
  if (value.length <= head + tail) return value;
  const start = value.slice(0, head);
  const end = value.slice(-tail);
  return `${start}...${end}`;
}
