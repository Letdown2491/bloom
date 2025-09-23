import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList as VirtualList } from "react-window";
import { prettyBytes, prettyDate } from "../utils/format";
import { buildAuthorizationHeader, type BlossomBlob, type SignTemplate } from "../lib/blossomClient";
import { buildNip98AuthHeader } from "../lib/nip98";
import {
  DownloadIcon,
  EditIcon,
  FileTypeIcon,
  PauseIcon,
  PreviewIcon,
  PlayIcon,
  ShareIcon,
  TrashIcon,
  CancelIcon,
} from "./icons";
import { cachePreviewBlob, getCachedPreviewBlob } from "../utils/blobPreviewCache";
import { useBlobMetadata } from "../features/browse/useBlobMetadata";
import { useBlobPreview, type PreviewTarget } from "../features/browse/useBlobPreview";
import { useInViewport } from "../hooks/useInViewport";

export type BlobListProps = {
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  selected: Set<string>;
  viewMode: "grid" | "list";
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob) => void;
  onRename?: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
};

type DetectedKindMap = Record<string, "image" | "video">;

type ResolvedMeta = {
  type?: string;
  name?: string;
};

type ResolvedMetaMap = Record<string, ResolvedMeta>;

type FileKind = "image" | "video" | "pdf" | "doc" | "sheet" | "document";

type SortKey = "name" | "size" | "uploaded";

type SortConfig = { key: SortKey; direction: "asc" | "desc" };

const CARD_HEIGHT = 260;
const LIST_THUMBNAIL_SIZE = 48;
const GRID_ACTION_BUTTON_CLASS =
  "flex aspect-square w-full items-center justify-center rounded-lg bg-slate-800 text-slate-200 transition focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-slate-900 hover:bg-slate-700";
const GRID_DELETE_BUTTON_CLASS =
  "flex aspect-square w-full items-center justify-center rounded-lg bg-red-900/80 text-slate-100 transition focus:outline-none focus:ring-1 focus:ring-red-400 focus:ring-offset-1 focus:ring-offset-slate-900 hover:bg-red-800";

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
  onShare,
  onRename,
  currentTrackUrl,
  currentTrackStatus,
}) => {
  const { resolvedMeta, detectedKinds, requestMetadata, reportDetectedKind } = useBlobMetadata(blobs, {
    baseUrl,
    requiresAuth,
    signTemplate,
    serverType,
  });
  const { previewTarget, openPreview, closePreview } = useBlobPreview({
    defaultServerType: serverType,
    defaultSignTemplate: signTemplate,
  });
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

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

  const handleClosePreview = useCallback(() => {
    closePreview();
  }, [closePreview]);

  const handleDetect = useCallback(
    (sha: string, kind: "image" | "video") => {
      reportDetectedKind(sha, kind);
    },
    [reportDetectedKind]
  );

  const handlePreview = useCallback(
    (blob: BlossomBlob) => {
      const detectedKind = detectedKinds[blob.sha256];
      const kind = decideFileKind(blob, detectedKind);
      const displayName = buildDisplayName(blob);
      const effectiveServerType = blob.serverType ?? serverType;
      const fallbackBaseUrl = blob.serverUrl ?? baseUrl;
      const effectiveRequiresAuth =
        effectiveServerType === "satellite" ? false : blob.requiresAuth ?? requiresAuth;
      const previewUrl = buildPreviewUrl(blob, kind, fallbackBaseUrl);
      const disablePreview = shouldDisablePreview(kind);

      openPreview(blob, {
        displayName,
        requiresAuth: effectiveRequiresAuth,
        detectedKind,
        baseUrl: fallbackBaseUrl ?? undefined,
        previewUrl,
        disablePreview,
      });
    },
    [baseUrl, detectedKinds, openPreview, requiresAuth, serverType]
  );

  const handleDownload = useCallback(
    async (blob: BlossomBlob) => {
      if (!blob.url) return;
      let objectUrl: string | null = null;
      try {
        const headers: Record<string, string> = {};
        if (blob.requiresAuth) {
          const kind = blob.serverType ?? serverType;
          if (kind === "nip96") {
            if (!signTemplate) throw new Error("Signer required to authorize this download.");
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url: blob.url,
              method: "GET",
            });
          } else if (kind === "satellite") {
            // Satellite CDN URLs are globally accessible; no auth header required.
          } else {
            if (!signTemplate) throw new Error("Signer required to authorize this download.");
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
          onPreview={handlePreview}
          onPlay={onPlay}
          onShare={onShare}
          onRename={onRename}
          currentTrackUrl={currentTrackUrl}
          currentTrackStatus={currentTrackStatus}
          detectedKinds={detectedKinds}
          onDetect={handleDetect}
          sortConfig={sortConfig}
          onSort={handleSortToggle}
          onBlobVisible={requestMetadata}
          requestMetadata={requestMetadata}
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
          onPreview={handlePreview}
          onPlay={onPlay}
          onShare={onShare}
          onRename={onRename}
          currentTrackUrl={currentTrackUrl}
          currentTrackStatus={currentTrackStatus}
          detectedKinds={detectedKinds}
          onDetect={handleDetect}
          onBlobVisible={requestMetadata}
        />
      )}
      {previewTarget && (
        <PreviewDialog
          target={previewTarget}
          onClose={handleClosePreview}
          onDetect={handleDetect}
          onCopy={onCopy}
          onBlobVisible={requestMetadata}
        />
      )}
    </div>
  );
};

const LIST_ROW_HEIGHT = 76;
const LIST_ROW_GAP = 8;

const ListLayout: React.FC<{
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onPreview: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob) => void;
  onRename?: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
  sortConfig: SortConfig | null;
  onSort: (key: SortKey) => void;
  onBlobVisible: (sha: string) => void;
  requestMetadata: (sha: string) => void;
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
  onPreview,
  onPlay,
  onShare,
  onRename,
  currentTrackUrl,
  currentTrackStatus,
  detectedKinds,
  onDetect,
  sortConfig,
  onSort,
  onBlobVisible,
  requestMetadata,
}) => {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listOuterRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });

  const allSelected = blobs.length > 0 && blobs.every(blob => selected.has(blob.sha256));
  const partiallySelected = !allSelected && blobs.some(blob => selected.has(blob.sha256));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected, allSelected]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () => setContainer({ width: element.clientWidth, height: element.clientHeight });

    update();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }

    const handleResize = () => update();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [blobs.length]);

  const listWidth = container.width > 0 ? Math.max(0, container.width - 1) : container.width || 0;

  useLayoutEffect(() => {
    const outer = listOuterRef.current;
    if (!outer) return;
    const previous = outer.style.overflowX;
    outer.style.overflowX = "hidden";
    return () => {
      outer.style.overflowX = previous;
    };
  }, [listWidth]);
  const estimatedHeight = (LIST_ROW_HEIGHT + LIST_ROW_GAP) * Math.min(blobs.length, 8);
  const listHeight = container.height > 0 ? container.height : Math.min(480, Math.max(LIST_ROW_HEIGHT + LIST_ROW_GAP, estimatedHeight));

  const headerIndicator = useCallback(
    (key: SortKey) => {
      if (!sortConfig || sortConfig.key !== key) return null;
      return sortConfig.direction === "asc" ? "^" : "v";
    },
    [sortConfig]
  );

  const handleSelectAll: React.ChangeEventHandler<HTMLInputElement> = event => {
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
  };

  const Row = useCallback(
    ({ index, style }: { index: number; style: React.CSSProperties }) => {
      const blob = blobs[index];
      if (!blob) return null;
      const adjustedStyle: React.CSSProperties = {
        ...style,
        position: "absolute",
        top: typeof style.top === "number" ? style.top + LIST_ROW_GAP / 2 : style.top,
        left: 0,
        width: listWidth,
        height: LIST_ROW_HEIGHT,
      };

      return (
        <ListRow
          key={blob.sha256}
          style={adjustedStyle}
          blob={blob}
          baseUrl={baseUrl}
          requiresAuth={requiresAuth}
          signTemplate={signTemplate}
          serverType={serverType}
          selected={selected}
          onToggle={onToggle}
          onDelete={onDelete}
          onDownload={onDownload}
          onPreview={onPreview}
          onPlay={onPlay}
          onShare={onShare}
          onRename={onRename}
          currentTrackUrl={currentTrackUrl}
          currentTrackStatus={currentTrackStatus}
          detectedKinds={detectedKinds}
          onDetect={onDetect}
          onBlobVisible={onBlobVisible}
        />
      );
    },
    [
      blobs,
      baseUrl,
      requiresAuth,
      signTemplate,
      serverType,
      selected,
      onToggle,
      onDelete,
      onDownload,
      onPreview,
      onPlay,
      onShare,
      onRename,
      currentTrackUrl,
      currentTrackStatus,
      detectedKinds,
      onDetect,
      onBlobVisible,
      requestMetadata,
      listWidth,
    ]
  );

  const handleItemsRendered = useCallback(
    ({ visibleStartIndex, visibleStopIndex }: { visibleStartIndex: number; visibleStopIndex: number }) => {
      for (let index = visibleStartIndex; index <= visibleStopIndex; index += 1) {
        const blob = blobs[index];
        if (blob) requestMetadata(blob.sha256);
      }
    },
    [blobs, requestMetadata]
  );

  return (
    <div className="flex flex-1 min-h-0 w-full flex-col overflow-hidden overflow-x-hidden pb-1">
      <div className="border-b border-slate-800 bg-slate-900/60 px-2 pb-2 pt-0 text-xs uppercase tracking-wide text-slate-200">
        <div className="grid grid-cols-[40px,minmax(0,1fr)] md:grid-cols-[40px,minmax(0,1fr),10rem,6rem,16rem] items-center gap-2">
          <div className="flex justify-center">
            <input
              ref={selectAllRef}
              type="checkbox"
              className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              checked={allSelected}
              onChange={handleSelectAll}
              aria-label="Select all files"
            />
          </div>
          <button
            type="button"
            onClick={() => onSort("name")}
            className="flex items-center gap-1 text-left font-semibold text-slate-200 hover:text-slate-100"
          >
            <span>Name</span>
            <span aria-hidden="true">{headerIndicator("name")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSort("uploaded")}
            className="hidden items-center gap-1 text-left font-semibold text-slate-200 hover:text-slate-100 md:flex"
          >
            <span>Uploaded</span>
            <span aria-hidden="true">{headerIndicator("uploaded")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSort("size")}
            className="flex items-center gap-1 text-left font-semibold text-slate-200 hover:text-slate-100"
          >
            <span>Size</span>
            <span aria-hidden="true">{headerIndicator("size")}</span>
          </button>
          <div className="hidden justify-center text-center font-semibold text-slate-200 md:flex">Actions</div>
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden overflow-x-hidden">
        {blobs.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">No content on this server yet.</div>
        ) : (
          <VirtualList
            height={listHeight}
            itemCount={blobs.length}
            itemSize={LIST_ROW_HEIGHT + LIST_ROW_GAP}
            width={listWidth}
            onItemsRendered={handleItemsRendered}
            overscanCount={6}
            outerRef={listOuterRef}
          >
            {Row}
          </VirtualList>
        )}
      </div>
    </div>
  );
};

const GridLayout: React.FC<{
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onPreview: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob) => void;
  onRename?: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
  onBlobVisible: (sha: string) => void;
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
  onPreview,
  onPlay,
  onShare,
  onRename,
  currentTrackUrl,
  currentTrackStatus,
  detectedKinds,
  onDetect,
  onBlobVisible,
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
      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden px-2"
      >
        <div style={{ position: "relative", height: containerHeight }}>
          {items.map(({ blob, row, col }) => {
            const isSelected = selected.has(blob.sha256);
            const isAudio = blob.type?.startsWith("audio/");
            const isActiveTrack = Boolean(currentTrackUrl && blob.url && currentTrackUrl === blob.url);
            const isActivePlaying = isActiveTrack && currentTrackStatus === "playing";
            const playButtonLabel = isActivePlaying ? "Pause" : "Play";
            const playButtonAria = isActivePlaying ? "Pause audio" : "Play audio";
            const playButtonClass = `p-2 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
              isActivePlaying
                ? "bg-emerald-500/80 text-slate-900 hover:bg-emerald-400"
                : "bg-emerald-700/70 text-slate-100 hover:bg-emerald-600"
            }`;
            const playPauseIcon = isActivePlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />;
            const displayName = buildDisplayName(blob);
            const effectiveServerType = blob.serverType ?? serverType;
            const previewRequiresAuth =
              effectiveServerType === "satellite" ? false : blob.requiresAuth ?? requiresAuth;
            const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
            const previewUrl = buildPreviewUrl(blob, kind, baseUrl);
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
                        onVisible={onBlobVisible}
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
                    className="grid grid-cols-5 items-center gap-1 border-t border-slate-800/80 bg-slate-950/90 px-2 py-3"
                    style={{ height: CARD_HEIGHT * 0.25 }}
                  >
                    {!isAudio && (
                      <button
                        className={GRID_ACTION_BUTTON_CLASS}
                        onClick={event => {
                          event.stopPropagation();
                          onPreview(blob);
                        }}
                        aria-label="Preview blob"
                        title="Preview"
                      >
                        <PreviewIcon size={16} />
                      </button>
                    )}
                    {isAudio && onPlay && blob.url && (
                      <button
                        className={`${playButtonClass} aspect-square w-full`}
                        onClick={event => {
                          event.stopPropagation();
                          onPlay?.(blob);
                        }}
                        aria-label={playButtonAria}
                        aria-pressed={isActivePlaying}
                        title={playButtonLabel}
                      >
                        {playPauseIcon}
                      </button>
                    )}
                    {blob.url && onShare && (
                      <button
                        className={GRID_ACTION_BUTTON_CLASS}
                        onClick={event => {
                          event.stopPropagation();
                          onShare?.(blob);
                        }}
                        aria-label="Share blob"
                        title="Share"
                      >
                        <ShareIcon size={16} />
                      </button>
                    )}
                    {blob.url && (
                      <button
                        className={GRID_ACTION_BUTTON_CLASS}
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
                    {onRename && (
                      <button
                        className={GRID_ACTION_BUTTON_CLASS}
                        onClick={event => {
                          event.stopPropagation();
                          onRename(blob);
                        }}
                        aria-label="Edit file details"
                        title="Edit details"
                      >
                        <EditIcon size={16} />
                      </button>
                    )}
                    <button
                      className={GRID_DELETE_BUTTON_CLASS}
                      onClick={event => {
                        event.stopPropagation();
                        onDelete(blob);
                      }}
                      aria-label="Delete blob"
                      title="Delete"
                    >
                      <TrashIcon size={16} />
                    </button>
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

const PreviewDialog: React.FC<{
  target: PreviewTarget;
  onClose: () => void;
  onDetect: (sha: string, kind: "image" | "video") => void;
  onCopy: (blob: BlossomBlob) => void;
  onBlobVisible: (sha: string) => void;
}> = ({ target, onClose, onDetect, onCopy, onBlobVisible }) => {
  const { blob, displayName, previewUrl, requiresAuth, signTemplate, serverType, disablePreview } = target;
  const derivedKind: FileKind = (target.kind as FileKind | undefined) ?? decideFileKind(blob, undefined);
  const sizeLabel = typeof blob.size === "number" ? prettyBytes(blob.size) : null;
  const uploadedLabel = typeof blob.uploaded === "number" ? prettyDate(blob.uploaded) : null;
  const typeLabel = blob.type || "Unknown";
  const originLabel = target.baseUrl ?? blob.serverUrl ?? null;
  const previewUnavailable = disablePreview || !previewUrl;

  const handleDirectUrlCopy = useCallback(() => {
    if (!blob.url) return;
    onCopy(blob);
  }, [blob, onCopy]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const { body } = document;
    if (!body) return;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  const handleBackdropClick: React.MouseEventHandler<HTMLDivElement> = event => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${displayName}`}
        className="relative flex w-full max-w-4xl flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <button
          type="button"
          className="absolute right-4 top-4 rounded-full p-2 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          onClick={onClose}
          aria-label="Close preview"
        >
          <CancelIcon size={18} />
        </button>
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{displayName}</h2>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
            {sizeLabel && (
              <span>
                <span className="text-slate-300">Size:</span> {sizeLabel}
              </span>
            )}
            {uploadedLabel && (
              <span>
                <span className="text-slate-300">Uploaded:</span> {uploadedLabel}
              </span>
            )}
            <span>
              <span className="text-slate-300">Type:</span> {typeLabel}
            </span>
            {originLabel && (
              <span className="truncate">
                <span className="text-slate-300">Server:</span> {originLabel}
              </span>
            )}
          </div>
        </div>
        <div className="relative flex min-h-[22rem] flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
          {previewUnavailable ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-sm text-slate-400">
              <FileTypeIcon kind={derivedKind} size={112} className="text-slate-500" />
              <p className="max-w-sm text-center">Preview not available for this file type.</p>
            </div>
          ) : (
            <BlobPreview
              sha={blob.sha256}
              url={previewUrl}
              name={blob.name || blob.sha256}
              type={blob.type}
              serverUrl={target.baseUrl ?? blob.serverUrl}
              requiresAuth={requiresAuth}
              signTemplate={requiresAuth ? signTemplate : undefined}
              serverType={serverType}
              onDetect={onDetect}
              fallbackIconSize={160}
              className="h-[28rem] w-full max-w-full"
              variant="dialog"
              onVisible={onBlobVisible}
            />
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-[11px] text-slate-500">
          <span className="font-mono break-all text-slate-400">Hash: {blob.sha256}</span>
          {blob.url && (
            <button
              type="button"
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                handleDirectUrlCopy();
              }}
              className="flex max-w-full items-center gap-1 rounded px-1 text-left text-[11px] text-emerald-300 underline decoration-dotted underline-offset-2 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900"
              title="Copy direct URL"
              aria-label="Copy direct URL"
            >
              <span className="text-slate-300">Direct URL:</span>
              <span className="truncate font-mono">{blob.url}</span>
            </button>
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
  serverType?: "blossom" | "nip96" | "satellite";
  onDetect?: (sha: string, kind: "image" | "video") => void;
  onVisible?: (sha: string) => void;
}> = ({
  blob,
  kind,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType = "blossom",
  onDetect,
  onVisible,
}) => {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [textPreview, setTextPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const lastFailureKeyRef = useRef<string | null>(null);
  const activeRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const [observeTarget, isVisible] = useInViewport<HTMLDivElement>({ rootMargin: "200px" });
  const hasReportedVisibilityRef = useRef(false);

  const containerClass = "flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80 relative";
  const effectiveServerType = blob.serverType ?? serverType;
  const effectiveRequiresAuth = effectiveServerType === "satellite" ? false : blob.requiresAuth ?? requiresAuth;
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

  useEffect(() => {
    if (!isVisible || !onVisible || hasReportedVisibilityRef.current) return;
    hasReportedVisibilityRef.current = true;
    onVisible(blob.sha256);
  }, [isVisible, onVisible, blob.sha256]);

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
  style,
  blob,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType,
  selected,
  onToggle,
  onDelete,
  onDownload,
  onPreview,
  onPlay,
  onShare,
  onRename,
  currentTrackUrl,
  currentTrackStatus,
  detectedKinds,
  onDetect,
  onBlobVisible,
}: {
  style: React.CSSProperties;
  blob: BlossomBlob;
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onPreview: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob) => void;
  onRename?: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
  onBlobVisible: (sha: string) => void;
}) {
  const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
  const isAudio = blob.type?.startsWith("audio/");
  const isActiveTrack = Boolean(currentTrackUrl && blob.url && currentTrackUrl === blob.url);
  const isActivePlaying = isActiveTrack && currentTrackStatus === "playing";
  const playButtonLabel = isActivePlaying ? "Pause" : "Play";
  const playButtonAria = isActivePlaying ? "Pause audio" : "Play audio";
  const playButtonClass = `p-2 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
    isActivePlaying ? "bg-emerald-500/80 text-slate-900 hover:bg-emerald-400" : "bg-emerald-700/70 text-slate-100 hover:bg-emerald-600"
  }`;
  const playPauseIcon = isActivePlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />;
  const displayName = buildDisplayName(blob);
  const isSelected = selected.has(blob.sha256);
  const disablePreview = shouldDisablePreview(kind);

  return (
    <div
      style={style}
      className={`absolute left-0 right-0 flex items-center gap-2 border-b border-slate-800 px-2 transition-colors ${
        isSelected ? "bg-slate-800/50" : "hover:bg-slate-800/40"
      }`}
      role="row"
    >
      <div className="flex w-12 justify-center">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          checked={isSelected}
          onChange={() => onToggle(blob.sha256)}
          aria-label={`Select ${displayName}`}
          onClick={event => event.stopPropagation()}
        />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ListThumbnail
          blob={blob}
          kind={kind}
          baseUrl={baseUrl}
          requiresAuth={requiresAuth}
          signTemplate={signTemplate}
          serverType={serverType}
          onDetect={(sha, detectedKind) => onDetect(sha, detectedKind)}
          onVisible={onBlobVisible}
        />
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-100">{displayName}</div>
        </div>
      </div>
      <div className="hidden w-40 shrink-0 px-3 text-xs text-slate-400 md:block">
        {blob.uploaded ? prettyDate(blob.uploaded) : "—"}
      </div>
      <div className="w-24 shrink-0 px-3 text-sm text-slate-400">{prettyBytes(blob.size || 0)}</div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-2 md:w-64">
        {!isAudio && (
          <button
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
            onClick={event => {
              event.stopPropagation();
              onPreview(blob);
            }}
            aria-label={disablePreview ? "Preview unavailable" : "Preview blob"}
            title={disablePreview ? "Preview unavailable" : "Preview"}
          >
            <PreviewIcon size={16} />
          </button>
        )}
        {isAudio && onPlay && blob.url && (
          <button
            className={playButtonClass}
            onClick={event => {
              event.stopPropagation();
              onPlay?.(blob);
            }}
            aria-label={playButtonAria}
            aria-pressed={isActivePlaying}
            title={playButtonLabel}
          >
            {playPauseIcon}
          </button>
        )}
        {blob.url && onShare && (
          <button
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
            onClick={event => {
              event.stopPropagation();
              onShare?.(blob);
            }}
            aria-label="Share blob"
            title="Share"
          >
            <ShareIcon size={16} />
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
        {onRename && (
          <button
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
            onClick={event => {
              event.stopPropagation();
              onRename(blob);
            }}
            aria-label="Edit file details"
            title="Edit details"
          >
            <EditIcon size={16} />
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
      </div>
    </div>
  );
}


const BlobPreview: React.FC<{
  sha: string;
  url: string;
  name: string;
  type?: string;
  serverUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  onDetect: (sha: string, kind: "image" | "video") => void;
  className?: string;
  fallbackIconSize?: number;
  variant?: "inline" | "dialog";
  onVisible?: (sha: string) => void;
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
  variant = "inline",
  onVisible,
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
  const hasReportedVisibilityRef = useRef(false);

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
        } else if (serverType === "satellite") {
          // Satellite previews do not need authorization headers.
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

  useEffect(() => {
    if (!isVisible || !onVisible || hasReportedVisibilityRef.current) return;
    hasReportedVisibilityRef.current = true;
    onVisible(sha);
  }, [isVisible, onVisible, sha]);

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

  const videoControls = variant === "dialog";
  const videoAutoPlay = variant === "inline";
  const videoLoop = variant === "inline";
  const videoMuted = variant === "inline";

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
          controls={videoControls}
          autoPlay={videoAutoPlay}
          muted={videoMuted}
          loop={videoLoop}
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

function shouldDisablePreview(kind: FileKind) {
  return kind === "doc" || kind === "sheet" || kind === "pdf";
}

function buildPreviewUrl(blob: BlossomBlob, kind: FileKind, baseUrl?: string | null) {
  if (shouldDisablePreview(kind)) return null;
  if (blob.url) return blob.url;
  const fallback = blob.serverUrl ?? baseUrl;
  if (!fallback) return null;
  return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
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
  const sanitized = lower.split(/[?#]/)[0] ?? "";
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

  const shouldKeepFullName = blob.type?.startsWith("audio/") && typeof blob.name === "string" && blob.name.trim().length > 0;
  const displayBase = shouldKeepFullName ? baseName : truncateMiddle(baseName, 12, 12);

  return inferredExtension ? `${displayBase}.${inferredExtension}` : displayBase;
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
