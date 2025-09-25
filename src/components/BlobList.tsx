import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { decode } from "blurhash";
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
  ChevronDownIcon,
  ShareIcon,
  SyncIndicatorIcon,
  TrashIcon,
  CancelIcon,
  MusicIcon,
  VideoIcon,
  DocumentIcon,
} from "./icons";
import type { FileKind } from "./icons";
import type { BlobAudioMetadata } from "../utils/blobMetadataStore";
import { cachePreviewBlob, getCachedPreviewBlob } from "../utils/blobPreviewCache";
import { useBlobMetadata } from "../features/browse/useBlobMetadata";
import { useBlobPreview, type PreviewTarget } from "../features/browse/useBlobPreview";
import { useInViewport } from "../hooks/useInViewport";
import { useAudioMetadataMap } from "../features/browse/useAudioMetadata";

export type BlobReplicaSummary = {
  count: number;
  servers: { url: string; name: string }[];
};

export type BlobListProps = {
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  replicaInfo?: Map<string, BlobReplicaSummary>;
  selected: Set<string>;
  viewMode: "grid" | "list";
  isMusicView?: boolean;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob) => void;
  onRename?: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  showGridPreviews?: boolean;
  showListPreviews?: boolean;
};

type DetectedKindMap = Record<string, "image" | "video">;

const MUSIC_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|oga|flac|aac|m4a|weba|webm|alac|aiff|aif|wma|mid|midi|amr|opus)(?:\?|#|$)/i;

const ADDITIONAL_AUDIO_MIME_TYPES = new Set(
  ["application/ogg", "application/x-ogg", "application/flac", "application/x-flac"].map(value =>
    value.toLowerCase()
  )
);

type BlurhashInfo = {
  hash: string;
  width?: number;
  height?: number;
};

type SortKey = "name" | "replicas" | "size" | "uploaded" | "artist" | "album" | "duration";

type SortConfig = { key: SortKey; direction: "asc" | "desc" };

const CARD_HEIGHT = 260;

const ReplicaBadge: React.FC<{ info: BlobReplicaSummary; variant: "grid" | "list" }> = ({ info, variant }) => {
  const title = info.servers.length
    ? `Available on ${info.servers.map(server => server.name).join(", ")}`
    : `Available on ${info.count} ${info.count === 1 ? "server" : "servers"}`;
  const baseClass =
    variant === "grid"
      ? "bg-slate-950 text-emerald-100 shadow-lg"
      : "bg-slate-900/85 text-emerald-100 shadow";
  const paddingClass = variant === "grid" ? "px-2 py-1" : "px-2.5 py-0.5";
  const iconSize = variant === "grid" ? 14 : 13;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/60 ${baseClass} ${paddingClass} font-semibold text-[11px] tabular-nums cursor-default select-none`}
      title={title}
      aria-label={title}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <SyncIndicatorIcon size={iconSize} className="text-emerald-300" aria-hidden="true" />
      <span>{info.count}</span>
    </span>
  );
};

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
  replicaInfo,
  selected,
  viewMode,
  isMusicView = false,
  onToggle,
  onSelectMany,
  onDelete,
  onCopy,
  onPlay,
  onShare,
  onRename,
  currentTrackUrl,
  currentTrackStatus,
  showGridPreviews = true,
  showListPreviews = true,
}) => {
  const { resolvedMeta, detectedKinds, requestMetadata, reportDetectedKind } = useBlobMetadata(blobs, {
    baseUrl,
    requiresAuth,
    signTemplate,
    serverType,
  });
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

  const audioMetadata = useAudioMetadataMap(decoratedBlobs);

  const { previewTarget, openPreview, closePreview } = useBlobPreview({
    defaultServerType: serverType,
    defaultSignTemplate: signTemplate,
  });
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  const baseSortedBlobs = useMemo(() => {
    if (decoratedBlobs.length <= 1) return decoratedBlobs;
    return [...decoratedBlobs].sort((a, b) => {
      const aUploaded = typeof a.uploaded === "number" ? a.uploaded : 0;
      const bUploaded = typeof b.uploaded === "number" ? b.uploaded : 0;
      if (aUploaded !== bUploaded) {
        return bUploaded - aUploaded;
      }
      return deriveBlobSortName(a).localeCompare(deriveBlobSortName(b));
    });
  }, [decoratedBlobs]);

  const sortedBlobs = useMemo(() => {
    if (!sortConfig) {
      return baseSortedBlobs;
    }

    const { key, direction } = sortConfig;
    if (key === "uploaded") {
      if (direction === "desc") return baseSortedBlobs;
      return [...baseSortedBlobs].reverse();
    }

    const modifier = direction === "asc" ? 1 : -1;
    const working = [...decoratedBlobs];

    working.sort((a, b) => {
      if (key === "size") {
        const aSize = typeof a.size === "number" ? a.size : -1;
        const bSize = typeof b.size === "number" ? b.size : -1;
        const diff = aSize - bSize;
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

    return working;
  }, [baseSortedBlobs, decoratedBlobs, sortConfig]);

  const gridBlobs = baseSortedBlobs;

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

  const listBlobs = useMemo(() => {
    if (viewMode !== "list") return baseSortedBlobs;
    if (!sortConfig || sortConfig.key === "name" || sortConfig.key === "size" || sortConfig.key === "uploaded") {
      return sortedBlobs;
    }

    const sorted = [...baseSortedBlobs].sort((a, b) => {
      if (sortConfig.key === "replicas") {
        const aCount = replicaInfo?.get(a.sha256)?.count ?? 0;
        const bCount = replicaInfo?.get(b.sha256)?.count ?? 0;
        const diff = aCount - bCount;
        if (diff !== 0) return diff;
      } else if (sortConfig.key === "artist" || sortConfig.key === "album") {
        const aMeta = audioMetadata.get(a.sha256);
        const bMeta = audioMetadata.get(b.sha256);
        const aValue = (sortConfig.key === "artist" ? aMeta?.artist : aMeta?.album)?.trim().toLowerCase() ?? "";
        const bValue = (sortConfig.key === "artist" ? bMeta?.artist : bMeta?.album)?.trim().toLowerCase() ?? "";
        if (aValue && !bValue) return -1;
        if (!aValue && bValue) return 1;
        if (aValue && bValue) {
          const diff = aValue.localeCompare(bValue);
          if (diff !== 0) return diff;
        }
      } else if (sortConfig.key === "duration") {
        const aDuration = audioMetadata.get(a.sha256)?.durationSeconds;
        const bDuration = audioMetadata.get(b.sha256)?.durationSeconds;
        const aHas = typeof aDuration === "number" && aDuration > 0;
        const bHas = typeof bDuration === "number" && bDuration > 0;
        if (aHas && bHas) {
          const diff = (aDuration ?? 0) - (bDuration ?? 0);
          if (diff !== 0) return diff;
        } else if (aHas && !bHas) {
          return -1;
        } else if (!aHas && bHas) {
          return 1;
        }
      }
      return deriveBlobSortName(a).localeCompare(deriveBlobSortName(b));
    });

    return sortConfig.direction === "asc" ? sorted : sorted.reverse();
  }, [audioMetadata, baseSortedBlobs, replicaInfo, sortConfig, sortedBlobs, viewMode]);

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
        replicaInfo={replicaInfo}
        isMusicView={isMusicView}
        audioMetadata={audioMetadata}
        showPreviews={showListPreviews}
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
        replicaInfo={replicaInfo}
        audioMetadata={audioMetadata}
        showPreviews={showGridPreviews}
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
  replicaInfo?: Map<string, BlobReplicaSummary>;
  isMusicView: boolean;
  audioMetadata: Map<string, BlobAudioMetadata>;
  showPreviews: boolean;
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
  replicaInfo,
  isMusicView,
  audioMetadata,
  showPreviews,
}) => {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listOuterRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [actionsColumnWidth, setActionsColumnWidth] = useState<number | null>(null);

  const handleActionsWidthChange = useCallback((width: number) => {
    if (!Number.isFinite(width) || width <= 0) return;
    setActionsColumnWidth(previous => {
      if (previous === null) return width;
      return Math.abs(previous - width) > 1 ? width : previous;
    });
  }, []);

  useEffect(() => {
    setActionsColumnWidth(null);
  }, [isMusicView]);

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
    const previousPaddingRight = outer.style.paddingRight;
    const previousMarginRight = outer.style.marginRight;
    const previousBoxSizing = outer.style.boxSizing;
    outer.style.overflowX = "hidden";
    outer.style.paddingRight = "0.5rem";
    outer.style.marginRight = "-0.5rem";
    outer.style.boxSizing = "content-box";
    return () => {
      outer.style.overflowX = previous;
      outer.style.paddingRight = previousPaddingRight;
      outer.style.marginRight = previousMarginRight;
      outer.style.boxSizing = previousBoxSizing;
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
      const replicaSummary = replicaInfo?.get(blob.sha256);

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
          replicaSummary={replicaSummary}
          isMusicListView={isMusicView}
          audioMetadata={audioMetadata}
          onActionsWidthChange={handleActionsWidthChange}
          showPreviews={showPreviews}
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
      replicaInfo,
      listWidth,
      isMusicView,
      audioMetadata,
      showPreviews,
      handleActionsWidthChange,
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

  const renderHeader = () => {
    if (isMusicView) {
      return (
        <div className="grid grid-cols-[60px,minmax(0,1fr)] md:grid-cols-[60px,minmax(0,1fr),10rem,12rem,6rem,max-content] items-center gap-2 text-xs tracking-wide text-slate-200">
          <div className="flex items-center justify-center font-semibold text-slate-300 normal-case">Cover</div>
          <button
            type="button"
            onClick={() => onSort("name")}
            className="flex items-center gap-1 text-left font-semibold text-slate-200 hover:text-slate-100"
          >
            <span>Title</span>
            <span aria-hidden="true">{headerIndicator("name")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSort("artist")}
            className="hidden items-center gap-1 font-semibold text-slate-200 hover:text-slate-100 md:flex"
          >
            <span>Artist</span>
            <span aria-hidden="true">{headerIndicator("artist")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSort("album")}
            className="hidden items-center gap-1 font-semibold text-slate-200 hover:text-slate-100 lg:flex"
          >
            <span>Album</span>
            <span aria-hidden="true">{headerIndicator("album")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSort("duration")}
            className="hidden items-center justify-end gap-1 font-semibold text-slate-200 hover:text-slate-100 lg:flex"
          >
            <span>Length</span>
            <span aria-hidden="true">{headerIndicator("duration")}</span>
          </button>
          <div
            className="hidden w-full justify-center text-center font-semibold text-slate-200 md:flex normal-case"
            style={actionsColumnWidth ? { width: actionsColumnWidth } : undefined}
          >
            Actions
          </div>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-[40px,minmax(0,1fr)] md:grid-cols-[40px,minmax(0,1fr),6rem,10rem,6rem,max-content] items-center gap-2 text-xs tracking-wide text-slate-200">
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
          onClick={() => onSort("replicas")}
          className="hidden items-center justify-center gap-1 font-semibold text-slate-200 hover:text-slate-100 md:flex"
        >
          <span>Servers</span>
          <span aria-hidden="true">{headerIndicator("replicas")}</span>
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
        <div
          className="hidden w-full justify-center text-center font-semibold text-slate-200 md:flex normal-case"
          style={actionsColumnWidth ? { width: actionsColumnWidth } : undefined}
        >
          Actions
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-1 min-h-0 w-full flex-col overflow-hidden overflow-x-hidden pb-1">
      <div className="border-b border-slate-800 bg-slate-900/60 px-2 pb-2 pt-0 text-xs uppercase tracking-wide text-slate-200">
        {renderHeader()}
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
  replicaInfo?: Map<string, BlobReplicaSummary>;
  audioMetadata: Map<string, BlobAudioMetadata>;
  showPreviews: boolean;
}> = ({
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
  replicaInfo,
  audioMetadata,
  showPreviews,
}) => {
  const CARD_WIDTH = 220;
  const GAP = 16;
  const OVERSCAN_ROWS = 2;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 0, width: 0, scrollTop: 0 });
  const [openMenuBlob, setOpenMenuBlob] = useState<string | null>(null);
  const dropdownRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

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

  useEffect(() => {
    if (!openMenuBlob) return;

    const activeNode = dropdownRefs.current.get(openMenuBlob);
    if (!activeNode) {
      setOpenMenuBlob(null);
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const node = dropdownRefs.current.get(openMenuBlob);
      if (node && !node.contains(target)) {
        setOpenMenuBlob(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuBlob(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenuBlob]);

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
        className="relative flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden pl-2 pr-2 -mr-2"
      >
        <div style={{ position: "relative", height: containerHeight }}>
          {items.map(({ blob, row, col }) => {
            const isSelected = selected.has(blob.sha256);
            const isAudio = blob.type?.startsWith("audio/");
            const isActiveTrack = Boolean(currentTrackUrl && blob.url && currentTrackUrl === blob.url);
            const isActivePlaying = isActiveTrack && currentTrackStatus === "playing";
            const playButtonLabel = isActivePlaying ? "Pause" : "Play";
            const playButtonAria = isActivePlaying ? "Pause audio" : "Play audio";
            const playPauseIcon = isActivePlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />;
            const displayName = buildDisplayName(blob);
            const effectiveServerType = blob.serverType ?? serverType;
            const previewRequiresAuth =
              effectiveServerType === "satellite" ? false : blob.requiresAuth ?? requiresAuth;
            const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
            const trackMetadata = audioMetadata.get(blob.sha256);
            const disablePreview = shouldDisablePreview(kind);
            const coverUrl = kind === "music" ? trackMetadata?.coverUrl : undefined;
            const previewUrl = buildPreviewUrl(blob, kind, baseUrl);
            const blurhash = extractBlurhash(blob);
            const top = GAP + row * rowHeight;
            const left = GAP + col * (effectiveColumnWidth + GAP);
            const replicaSummary = replicaInfo?.get(blob.sha256);
            const showReplicaBadge = replicaSummary && replicaSummary.count > 1;
            const coverAlt = trackMetadata?.title?.trim() || displayName;
            const previewAllowed = showPreviews && !disablePreview;
            const allowCoverArt = showPreviews && Boolean(coverUrl);
            const primaryActionBaseClass =
              "p-2 shrink-0 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40";
            const playButtonClass = `${primaryActionBaseClass} ${
              isActivePlaying
                ? "bg-emerald-500/80 text-slate-900 hover:bg-emerald-400"
                : "bg-emerald-700/70 text-slate-100 hover:bg-emerald-600"
            }`;
            const showButtonClass = `${primaryActionBaseClass} bg-emerald-700/70 text-slate-100 hover:bg-emerald-600`;
            const primaryAction =
              isAudio && onPlay && blob.url
                ? (
                    <button
                      className={`${playButtonClass} aspect-square h-10 w-10`}
                      onClick={event => {
                        event.stopPropagation();
                        onPlay?.(blob);
                      }}
                      aria-label={playButtonAria}
                      aria-pressed={isActivePlaying}
                      title={playButtonLabel}
                      type="button"
                    >
                      {playPauseIcon}
                    </button>
                  )
                : !isAudio
                  ? (
                      <button
                        className={`${showButtonClass} h-10 w-10`}
                        onClick={event => {
                          event.stopPropagation();
                          onPreview(blob);
                        }}
                        aria-label={disablePreview ? "Preview unavailable" : "Show blob"}
                        title={disablePreview ? "Preview unavailable" : "Show"}
                        type="button"
                        disabled={disablePreview}
                      >
                        <PreviewIcon size={16} />
                      </button>
                    )
                  : null;

            const shareButton =
              blob.url && onShare
                ? (
                    <button
                      className="p-2 shrink-0 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-slate-200 transition hover:bg-slate-700"
                      onClick={event => {
                        event.stopPropagation();
                        onShare?.(blob);
                      }}
                      aria-label={isAudio ? "Share track" : "Share blob"}
                      title="Share"
                      type="button"
                    >
                      <ShareIcon size={16} />
                    </button>
                  )
                : null;

            type DropdownItem = {
              key: string;
              label: string;
              icon: React.ReactNode;
              onSelect: () => void;
              ariaLabel?: string;
              variant?: "destructive";
            };

            const dropdownItems: DropdownItem[] = [];

            if (blob.url) {
              dropdownItems.push({
                key: "download",
                label: "Download",
                icon: <DownloadIcon size={14} />,
                ariaLabel: isAudio ? "Download track" : "Download blob",
                onSelect: () => onDownload(blob),
              });
            }

            if (onRename) {
              dropdownItems.push({
                key: "rename",
                label: "Edit Details",
                icon: <EditIcon size={14} />,
                ariaLabel: isAudio ? "Edit track details" : "Edit file details",
                onSelect: () => onRename(blob),
              });
            }

            dropdownItems.push({
              key: "delete",
              label: isAudio ? "Delete Track" : "Delete",
              icon: <TrashIcon size={14} />,
              ariaLabel: isAudio ? "Delete track" : "Delete blob",
              onSelect: () => onDelete(blob),
              variant: "destructive",
            });

            const menuOpen = openMenuBlob === blob.sha256;
            const handleMenuToggle: React.MouseEventHandler<HTMLButtonElement> = event => {
              event.stopPropagation();
              setOpenMenuBlob(current => (current === blob.sha256 ? null : blob.sha256));
            };

            const registerDropdownRef = (node: HTMLDivElement | null) => {
              if (node) {
                dropdownRefs.current.set(blob.sha256, node);
              } else {
                dropdownRefs.current.delete(blob.sha256);
              }
            };

            const dropdownMenu = dropdownItems.length === 0
              ? null
              : (
                  <div className="relative" ref={registerDropdownRef}>
                    <button
                      className="p-2 shrink-0 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-slate-200 transition hover:bg-slate-700"
                      onClick={handleMenuToggle}
                      aria-haspopup="true"
                      aria-expanded={menuOpen}
                      title="More actions"
                      type="button"
                    >
                      <ChevronDownIcon size={16} />
                    </button>
                    {menuOpen ? (
                      <div
                        className="absolute right-0 z-50 mt-2 w-44 rounded-md border border-slate-700 bg-slate-900/95 p-1 shadow-xl"
                        role="menu"
                        aria-label="More actions"
                      >
                        {dropdownItems.map(item => (
                          <a
                            key={item.key}
                            href="#"
                            role="menuitem"
                            aria-label={item.ariaLabel ?? item.label}
                            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                              item.variant === "destructive"
                                ? "text-red-300 hover:bg-red-900/40 focus:ring-offset-1 focus:ring-offset-slate-900"
                                : "text-slate-200 hover:bg-slate-700 focus:ring-offset-1 focus:ring-offset-slate-900"
                            }`}
                            onClick={event => {
                              event.preventDefault();
                              event.stopPropagation();
                              item.onSelect();
                              setOpenMenuBlob(null);
                            }}
                          >
                            {item.icon}
                            <span>{item.label}</span>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
            const fallbackPreview = (
              <div
                className={`flex h-full w-full items-center justify-center rounded-lg border border-slate-800 bg-gradient-to-br ${
                  kind === "music"
                    ? "from-emerald-900/70 via-slate-900 to-slate-950"
                    : kind === "video"
                      ? "from-sky-900/70 via-slate-900 to-slate-950"
                      : kind === "image"
                        ? "from-cyan-900/70 via-slate-900 to-slate-950"
                        : kind === "pdf"
                          ? "from-red-900/70 via-slate-900 to-slate-950"
                          : kind === "doc" || kind === "document"
                            ? "from-purple-900/70 via-slate-900 to-slate-950"
                            : "from-slate-900 via-slate-900 to-slate-950"
                }`}
              >
                <FileTypeIcon
                  kind={kind}
                  size={Math.round(CARD_HEIGHT * 0.5)}
                  className="text-slate-200"
                  aria-hidden="true"
                />
              </div>
            );

            let previewPanel: React.ReactNode = fallbackPreview;
            if (previewAllowed && previewUrl) {
              previewPanel = (
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
                  className="h-full w-full rounded-lg border border-slate-800 bg-slate-950/70"
                  onVisible={onBlobVisible}
                  blurhash={blurhash}
                />
              );
            }

            const previewContent = allowCoverArt
              ? (
                  <AudioCoverImage
                    url={coverUrl!}
                    alt={`${coverAlt} cover art`}
                    className="h-full w-full rounded-lg border border-slate-800 object-cover"
                    fallback={fallbackPreview}
                  />
                )
              : previewPanel;
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
                  className={`absolute flex flex-col overflow-visible rounded-xl border focus:outline-none focus:ring-2 focus:ring-emerald-500/70 focus:ring-offset-2 focus:ring-offset-slate-900 cursor-pointer transition ${
                    isSelected ? "border-emerald-500 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60"
                  }`}
                  style={{ top, left, width: effectiveColumnWidth, height: CARD_HEIGHT }}
                >
                  <div className="relative flex-1 overflow-hidden" style={{ height: CARD_HEIGHT * 0.75 }}>
                    {showReplicaBadge ? (
                      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-start p-2">
                        <div
                          className="pointer-events-auto"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={event => event.stopPropagation()}
                        >
                          <ReplicaBadge info={replicaSummary!} variant="grid" />
                        </div>
                      </div>
                    ) : null}
                    {previewContent}
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
                    className="flex items-center justify-center gap-2 border-t border-slate-800/80 bg-slate-950/90 px-2 py-3"
                    style={{ height: CARD_HEIGHT * 0.25 }}
                  >
                    {primaryAction}
                    {shareButton}
                    {dropdownMenu}
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
  const blurhash = extractBlurhash(blob);
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
        className="relative flex w-full max-w-4xl flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl max-h-[calc(100vh-2rem)] overflow-hidden"
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
        <div className="relative flex min-h-[18rem] flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60 max-h-[calc(100vh-18rem)]">
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
              className="h-full w-full max-h-[65vh] max-w-full"
              variant="dialog"
              onVisible={onBlobVisible}
              blurhash={blurhash}
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
  coverUrl?: string;
  showPreview?: boolean;
}> = ({
  blob,
  kind,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType = "blossom",
  onDetect,
  onVisible,
  coverUrl,
  showPreview = true,
}) => {
  const containerClass =
    "flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80 relative";
  const blurhash = extractBlurhash(blob);
  const [observeTarget, isVisible] = useInViewport<HTMLDivElement>({ rootMargin: "200px" });

  useEffect(() => {
    if (!showPreview) return;
    if (!blurhash) return;
    if (!isVisible) return;
    onVisible?.(blob.sha256);
  }, [blurhash, blob.sha256, isVisible, onVisible, showPreview]);

  useEffect(() => {
    if (!showPreview) return;
    if (!blurhash) return;
    if (kind === "image" || kind === "video") {
      onDetect?.(blob.sha256, kind === "image" ? "image" : "video");
    }
  }, [blurhash, blob.sha256, kind, onDetect, showPreview]);

  if (showPreview && (kind === "image" || kind === "video") && blurhash) {
    return (
      <div ref={observeTarget} className={containerClass}>
        <BlurhashThumbnail
          hash={blurhash.hash}
          width={blurhash.width}
          height={blurhash.height}
          alt={blob.name || blob.sha256}
        />
      </div>
    );
  }

  const previewUrl = showPreview && kind === "image" ? buildPreviewUrl(blob, kind, baseUrl) : null;
  const effectiveServerType = blob.serverType ?? serverType;
  const effectiveRequiresAuth =
    effectiveServerType === "satellite" ? false : blob.requiresAuth ?? requiresAuth;

  if (kind === "music") {
    const fallbackContent = (
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-900/70 via-slate-900 to-slate-950">
        <MusicIcon size={18} className="text-emerald-200" aria-hidden="true" />
      </div>
    );
    if (showPreview && coverUrl) {
      return (
        <div className={containerClass}>
          <AudioCoverImage
            url={coverUrl}
            alt={`${blob.name || blob.sha256} cover art`}
            className="h-full w-full object-cover"
            fallback={fallbackContent}
          />
        </div>
      );
    }
    return (
      <div
        className={`${containerClass} items-center justify-center bg-gradient-to-br from-emerald-900/70 via-slate-900 to-slate-950`}
      >
        <MusicIcon size={18} className="text-emerald-200" aria-hidden="true" />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div
        className={`${containerClass} items-center justify-center bg-gradient-to-br from-sky-900/70 via-slate-900 to-slate-950`}
      >
        <VideoIcon size={18} className="text-sky-200" aria-hidden="true" />
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div
        className={`${containerClass} items-center justify-center bg-gradient-to-br from-cyan-900/70 via-slate-900 to-slate-950`}
      >
        <FileTypeIcon kind="image" size={18} className="text-cyan-200" aria-hidden="true" />
      </div>
    );
  }

  if (kind === "document" || kind === "doc") {
    return (
      <div
        className={`${containerClass} items-center justify-center bg-gradient-to-br from-purple-900/70 via-slate-900 to-slate-950`}
      >
        <DocumentIcon size={18} className="text-purple-200" aria-hidden="true" />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div
        className={`${containerClass} items-center justify-center bg-gradient-to-br from-red-900/70 via-slate-900 to-slate-950`}
      >
        <FileTypeIcon kind="pdf" size={18} className="text-red-200" aria-hidden="true" />
      </div>
    );
  }

  if (previewUrl) {
    return (
      <div className={containerClass}>
        <BlobPreview
          sha={blob.sha256}
          url={previewUrl}
          name={blob.name || blob.sha256}
          type={blob.type}
          serverUrl={blob.serverUrl ?? baseUrl}
          requiresAuth={effectiveRequiresAuth}
          signTemplate={effectiveRequiresAuth ? signTemplate : undefined}
          serverType={blob.serverType ?? serverType}
          onDetect={onDetect ?? (() => undefined)}
          fallbackIconSize={40}
          className="h-full w-full rounded-none border-0 bg-transparent"
          onVisible={onVisible}
        />
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <FileTypeIcon kind={kind} size={40} className="text-slate-300" />
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
  replicaSummary,
  isMusicListView,
  audioMetadata,
  onActionsWidthChange,
  showPreviews,
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
  replicaSummary?: BlobReplicaSummary;
  isMusicListView: boolean;
  audioMetadata: Map<string, BlobAudioMetadata>;
  onActionsWidthChange: (width: number) => void;
  showPreviews: boolean;
}) {
  const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
  const isAudio = blob.type?.startsWith("audio/");
  const isActiveTrack = Boolean(currentTrackUrl && blob.url && currentTrackUrl === blob.url);
  const isActivePlaying = isActiveTrack && currentTrackStatus === "playing";
  const playButtonLabel = isActivePlaying ? "Pause" : "Play";
  const playButtonAria = isActivePlaying ? "Pause audio" : "Play audio";
  const primaryActionBaseClass =
    "p-2 shrink-0 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400";
  const playButtonClass = `${primaryActionBaseClass} ${
    isActivePlaying ? "bg-emerald-500/80 text-slate-900 hover:bg-emerald-400" : "bg-emerald-700/70 text-slate-100 hover:bg-emerald-600"
  }`;
  const showButtonClass = `${primaryActionBaseClass} bg-emerald-700/70 text-slate-100 hover:bg-emerald-600`;
  const playPauseIcon = isActivePlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />;
  const displayName = buildDisplayName(blob);
  const isSelected = selected.has(blob.sha256);
  const trackMetadata = audioMetadata.get(blob.sha256);
  const disablePreview = shouldDisablePreview(kind);
  const { baseName } = splitNameAndExtension(displayName);
  const trackTitle = trackMetadata?.title?.trim() || baseName;
  const artistName = trackMetadata?.artist?.trim() || "";
  const albumName = trackMetadata?.album?.trim() || "";
  const durationLabel = formatDurationSeconds(trackMetadata?.durationSeconds);
  const rowHighlightClass = isActiveTrack
    ? isActivePlaying
      ? "bg-emerald-950/40 ring-1 ring-emerald-400/60"
      : "bg-emerald-950/30 ring-1 ring-emerald-400/40"
    : isSelected
      ? "bg-slate-800/50"
      : "hover:bg-slate-800/40";
  const allowThumbnailPreview = showPreviews && (!disablePreview || (kind === "music" && Boolean(trackMetadata?.coverUrl)));

  const thumbnail = (
    <div className="relative">
      <ListThumbnail
        blob={blob}
        kind={kind}
        baseUrl={baseUrl}
        requiresAuth={requiresAuth}
        signTemplate={signTemplate}
        serverType={serverType}
        onDetect={(sha, detectedKind) => onDetect(sha, detectedKind)}
        onVisible={onBlobVisible}
        coverUrl={trackMetadata?.coverUrl}
        showPreview={allowThumbnailPreview}
      />
      {isActiveTrack ? (
        <span
          className={`absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-slate-900/80 text-xs ${
            isActivePlaying ? "bg-emerald-500 text-slate-900" : "bg-slate-800 text-emerald-300"
          }`}
          aria-hidden="true"
        >
          {isActivePlaying ? <PauseIcon size={10} /> : <PlayIcon size={10} />}
        </span>
      ) : null}
    </div>
  );

  const actionsContainerRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    const element = actionsContainerRef.current;
    if (!element) return;

    const notify = () => {
      const width = element.offsetWidth;
      if (width) onActionsWidthChange(width);
    };

    notify();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => notify());
      observer.observe(element);
      return () => observer.disconnect();
    }

    if (typeof window !== "undefined") {
      const handleResize = () => notify();
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    return undefined;
  }, [onActionsWidthChange, menuOpen]);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [blob.sha256]);

  useEffect(() => {
    if (!menuOpen) return;
    if (typeof document === "undefined") return;

    const handlePointer = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || !dropdownRef.current) return;
      if (!dropdownRef.current.contains(target)) {
        setMenuOpen(false);
      }
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);

    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  const primaryAction =
    isAudio && onPlay && blob.url ? (
      <button
        className={playButtonClass}
        onClick={event => {
          event.stopPropagation();
          onPlay?.(blob);
        }}
        aria-label={playButtonAria}
        aria-pressed={isActivePlaying}
        title={playButtonLabel}
        type="button"
      >
        {playPauseIcon}
      </button>
    ) : !isAudio ? (
      <button
        className={showButtonClass}
        onClick={event => {
          event.stopPropagation();
          onPreview(blob);
        }}
        aria-label={disablePreview ? "Preview unavailable" : "Show blob"}
        title={disablePreview ? "Preview unavailable" : "Show"}
        type="button"
      >
        <PreviewIcon size={16} />
      </button>
    ) : null;

  const shareButton =
    blob.url && onShare
      ? (
          <button
            className="p-2 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
            onClick={event => {
              event.stopPropagation();
              onShare?.(blob);
            }}
            aria-label={isMusicListView ? "Share track" : "Share blob"}
            title="Share"
            type="button"
          >
            <ShareIcon size={16} />
          </button>
        )
      : null;

  type DropdownItem = {
    key: string;
    label: string;
    icon: React.ReactNode;
    onSelect: () => void;
    ariaLabel?: string;
    variant?: "destructive";
  };

  const dropdownItems: DropdownItem[] = [];

  if (blob.url) {
    dropdownItems.push({
      key: "download",
      label: "Download",
      icon: <DownloadIcon size={14} />,
      ariaLabel: isMusicListView ? "Download track" : "Download blob",
      onSelect: () => onDownload(blob),
    });
  }

  if (onRename) {
    dropdownItems.push({
      key: "rename",
      label: "Edit Details",
      icon: <EditIcon size={14} />,
      ariaLabel: isMusicListView ? "Edit track details" : "Edit file details",
      onSelect: () => onRename(blob),
    });
  }

  dropdownItems.push({
    key: "delete",
    label: "Delete",
    icon: <TrashIcon size={14} />,
    ariaLabel: isMusicListView ? "Delete track" : "Delete blob",
    onSelect: () => onDelete(blob),
    variant: "destructive",
  });

  const showDropdown = dropdownItems.length > 0;

  const handleMenuToggle: React.MouseEventHandler<HTMLButtonElement> = event => {
    event.stopPropagation();
    setMenuOpen(value => !value);
  };

  const dropdownMenu = !showDropdown
    ? null
    : (
        <div className="relative" ref={dropdownRef}>
          <button
            className="p-2 shrink-0 rounded-lg bg-slate-800 text-slate-200 transition hover:bg-slate-700"
            onClick={handleMenuToggle}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            title="More actions"
            type="button"
          >
            <ChevronDownIcon size={16} />
          </button>
          {menuOpen ? (
            <div
              className="absolute right-0 z-30 mt-2 w-44 rounded-md border border-slate-700 bg-slate-900/95 p-1 shadow-xl"
              role="menu"
              aria-label="More actions"
            >
              {dropdownItems.map(item => (
                <a
                  key={item.key}
                  href="#"
                  role="menuitem"
                  aria-label={item.ariaLabel ?? item.label}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                    item.variant === "destructive"
                      ? "text-red-300 hover:bg-red-900/40 focus:ring-offset-1 focus:ring-offset-slate-900"
                      : "text-slate-200 hover:bg-slate-700 focus:ring-offset-1 focus:ring-offset-slate-900"
                  }`}
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    item.onSelect();
                    setMenuOpen(false);
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </a>
              ))}
            </div>
          ) : null}
        </div>
      );

  if (isMusicListView) {
    return (
      <div
        style={style}
        className={`absolute left-0 right-0 grid grid-cols-[60px,minmax(0,1fr)] md:grid-cols-[60px,minmax(0,1fr),10rem,12rem,6rem,max-content] items-center gap-2 border-b border-slate-800 px-2 transition-colors ring-1 ring-transparent ${rowHighlightClass}`}
        role="row"
        aria-current={isActiveTrack ? "true" : undefined}
      >
        <div className="flex h-full items-center justify-center">
          {thumbnail}
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-100" title={displayName}>
            {trackTitle}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400 md:hidden">
            <span className="truncate">{artistName || "—"}</span>
            {durationLabel !== "—" && <span>{durationLabel}</span>}
          </div>
        </div>
        <div className="hidden truncate text-sm text-slate-200 md:block" title={artistName}>
          {artistName || "—"}
        </div>
        <div className="hidden truncate text-sm text-slate-200 lg:block" title={albumName}>
          {albumName || "—"}
        </div>
        <div className="hidden justify-end text-sm text-slate-400 lg:flex">
          {durationLabel}
        </div>
        <div
          ref={actionsContainerRef}
          className="col-span-2 flex shrink-0 items-center justify-center gap-2 px-2 md:col-span-1 md:justify-end"
        >
          {primaryAction}
          {shareButton}
          {dropdownMenu}
        </div>
      </div>
    );
  }

  return (
    <div
      style={style}
      className={`absolute left-0 right-0 flex items-center gap-2 border-b border-slate-800 px-2 transition-colors ring-1 ring-transparent ${rowHighlightClass}`}
      role="row"
      aria-current={isActiveTrack ? "true" : undefined}
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
      <div className="flex min-w-0 flex-[2] items-center gap-3">
        {thumbnail}
        <div className="truncate font-medium text-slate-100" title={displayName}>
          {displayName}
        </div>
      </div>
      <div className="hidden w-20 shrink-0 items-center justify-center text-sm text-slate-200 md:flex">
        {replicaSummary?.count ? <ReplicaBadge info={replicaSummary} variant="list" /> : "—"}
      </div>
      <div className="hidden w-40 shrink-0 px-3 text-xs text-slate-400 md:block">
        {blob.uploaded ? prettyDate(blob.uploaded) : "—"}
      </div>
      <div className="w-24 shrink-0 px-3 text-sm text-slate-400">{prettyBytes(blob.size || 0)}</div>
      <div ref={actionsContainerRef} className="flex shrink-0 items-center justify-center gap-2 px-2 md:justify-end">
        {primaryAction}
        {shareButton}
        {dropdownMenu}
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
  blurhash?: BlurhashInfo | null;
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
  blurhash,
}) => {
  const previewKey = `${serverType}|${sha}|${requiresAuth ? "auth" : "anon"}|${url}`;
  const initialCachedSrc = getCachedPreviewSrc(previewKey);

  const [src, setSrc] = useState<string | null>(initialCachedSrc);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewType, setPreviewType] = useState<"image" | "video" | "text" | "unknown">(() => {
    if (isPreviewableTextType({ mime: type, name, url })) return "text";
    return inferKind(type, url) ?? "unknown";
  });
  const [isReady, setIsReady] = useState(Boolean(initialCachedSrc));
  const [textPreview, setTextPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const objectUrlRef = useRef<string | null>(initialCachedSrc ?? null);
  const lastLoadedKeyRef = useRef<string | null>(initialCachedSrc ? previewKey : null);
  const lastFailureKeyRef = useRef<string | null>(null);
  const activeRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const [observeTarget, isVisible] = useInViewport<HTMLDivElement>({ rootMargin: "400px" });
  const hasReportedVisibilityRef = useRef(false);

  const detectRef = useRef(onDetect);
  useEffect(() => {
    detectRef.current = onDetect;
  }, [onDetect]);

  const fallbackIconKind = useMemo<FileKind>(() => {
    if (previewType === "image" || previewType === "video") return previewType;
    if (isMusicType(type, name, url)) return "music";
    if (isSheetType(type, name || url)) return "sheet";
    if (isDocType(type, name || url)) return "doc";
    if (isPdfType(type, name || url)) return "pdf";
    if (isPreviewableTextType({ mime: type, name, url })) return "document";
    return "document";
  }, [previewType, type, name, url]);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      const cached = previewSrcCache.get(previewKey);
      if (!cached || cached.url !== objectUrlRef.current) {
        try {
          URL.revokeObjectURL(objectUrlRef.current);
        } catch (error) {
          // ignore revoke failures
        }
      }
      objectUrlRef.current = null;
    }
  }, [previewKey]);

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

  useEffect(() => {
    return () => {
      releaseObjectUrl();
    };
  }, [releaseObjectUrl]);

  useEffect(() => {
    if (isPreviewableTextType({ mime: type, name, url })) {
      setPreviewType("text");
    } else {
      setPreviewType(inferKind(type, url) ?? "unknown");
    }
  }, [type, url, name]);

  useEffect(() => {
    if (!previewKey) return;

    if (lastLoadedKeyRef.current === previewKey && src) {
      setFailed(false);
      setLoading(false);
      setIsReady(true);
      return;
    }

    if (lastFailureKeyRef.current === previewKey) {
      return;
    }

    const cachedSrc = getCachedPreviewSrc(previewKey);
    if (cachedSrc) {
      lastLoadedKeyRef.current = previewKey;
      setSrc(cachedSrc);
      objectUrlRef.current = cachedSrc;
      setFailed(false);
      setLoading(false);
      setIsReady(true);
      if (previewType === "image") detectRef.current?.(sha, "image");
      if (previewType === "video") detectRef.current?.(sha, "video");
      return;
    }

    if (requiresAuth && !signTemplate) {
      lastFailureKeyRef.current = previewKey;
      setFailed(true);
      setLoading(false);
      setIsReady(false);
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

    setFailed(false);
    setLoading(true);
    setIsReady(Boolean(src));
    setTextPreview(null);

    const finalizeRequest = () => {
      if (activeRequestRef.current?.controller === controller) {
        activeRequestRef.current = null;
      }
    };

    const assignObjectUrl = (blobData: Blob) => {
      if (cancelled) return;
      clearCachedPreviewSrc(previewKey);
      releaseObjectUrl();
      const objectUrl = URL.createObjectURL(blobData);
      objectUrlRef.current = objectUrl;
      setCachedPreviewSrc(previewKey, objectUrl);
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(objectUrl);
      setIsReady(true);
    };

    const useDirectUrl = () => {
      if (cancelled) return;
      clearCachedPreviewSrc(previewKey);
      releaseObjectUrl();
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(url);
      setIsReady(true);
    };

    const showTextPreview = async (blobData: Blob, mimeHint?: string | null) => {
      const normalizedMime = mimeHint ?? blobData.type ?? type;
      const shouldRenderText =
        isPreviewableTextType({ mime: normalizedMime, name, url }) ||
        (!normalizedMime && isPreviewableTextType({ name, url })) ||
        metaSuggestsText;
      if (!shouldRenderText) return false;
      try {
        const preview = await buildTextPreview(blobData);
        if (cancelled) return true;
        clearCachedPreviewSrc(previewKey);
        releaseObjectUrl();
        setSrc(null);
        setTextPreview(preview);
        setIsReady(true);
        lastLoadedKeyRef.current = previewKey;
        lastFailureKeyRef.current = null;
        return true;
      } catch (error) {
        return false;
      }
    };

    const load = async () => {
      try {
        const cachedBlob = metaSuggestsText ? null : await getCachedPreviewBlob(cacheServerHint, sha);
        if (cancelled) return;
        if (cachedBlob) {
          assignObjectUrl(cachedBlob);
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (previewType === "video" && url && !requiresAuth) {
          setSrc(url);
          setLoading(false);
          setIsReady(true);
          finalizeRequest();
          return;
        }

        const headers: Record<string, string> = {};
        if (requiresAuth && signTemplate) {
          const parsed = new URL(url, window.location.href);
          headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
            hash: sha,
            serverUrl: `${parsed.protocol}//${parsed.host}`,
            urlPath: `${parsed.pathname}${parsed.search}`,
            expiresInSeconds: 120,
          });
        }

        const response = await fetch(url, {
          method: metaSuggestsText ? "GET" : "GET",
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          if (!controller.signal.aborted) {
            clearCachedPreviewSrc(previewKey);
            lastFailureKeyRef.current = previewKey;
            setFailed(true);
            setIsReady(false);
          }
          return;
        }

        const mimeHint = response.headers.get("content-type");
        const blobData = await response.blob();
        if (cancelled) return;

        if (await showTextPreview(blobData, mimeHint)) {
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (!requiresAuth) {
          useDirectUrl();
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (!metaSuggestsText && cacheServerHint) {
          void cachePreviewBlob(cacheServerHint, sha, blobData).catch(() => undefined);
        }
        assignObjectUrl(blobData);
        setLoading(false);
      } catch (error) {
        if (!controller.signal.aborted && !cancelled) {
          clearCachedPreviewSrc(previewKey);
          lastFailureKeyRef.current = previewKey;
          setFailed(true);
          setIsReady(false);
        }
        setLoading(false);
      } finally {
        finalizeRequest();
      }
    };

    if (!isVisible && variant === "inline") {
      setLoading(false);
      activeRequestRef.current = null;
      return;
    }

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    cacheServerHint,
    isVisible,
    metaSuggestsText,
    previewKey,
    releaseObjectUrl,
    requiresAuth,
    sha,
    signTemplate,
    src,
    type,
    url,
    variant,
  ]);

  useEffect(() => {
    if (!previewKey) return;
    if (isVisible) {
      if (!hasReportedVisibilityRef.current) {
        hasReportedVisibilityRef.current = true;
        onVisible?.(sha);
      }
    } else {
      hasReportedVisibilityRef.current = false;
    }
  }, [isVisible, onVisible, previewKey, sha]);

  const showMedia = Boolean(src) && !failed && Boolean(url);
  const isVideo = showMedia && previewType === "video";
  const isImage = showMedia && previewType !== "video";
  const showLoading = loading && !showMedia && !textPreview;
  const showUnavailable = failed || (!showMedia && !textPreview && !loading);

  const classNames = `relative flex h-full w-full items-center justify-center overflow-hidden bg-slate-950/80 ${
    className ?? ""
  }`;

  const blurhashPlaceholder = blurhash ? (
    <BlurhashThumbnail
      hash={blurhash.hash}
      width={blurhash.width}
      height={blurhash.height}
      alt={name}
    />
  ) : null;

  const content = textPreview ? (
    <div className="px-4 py-3 text-xs text-slate-200">
      <pre className="line-clamp-6 whitespace-pre-wrap break-words text-[11px] leading-snug">
        {textPreview.content}
        {textPreview.truncated ? " …" : ""}
      </pre>
    </div>
  ) : isImage ? (
    <img
      src={src ?? undefined}
      alt={name}
      className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      }`}
      loading="lazy"
      onLoad={() => {
        setIsReady(true);
        setLoading(false);
        setFailed(false);
        detectRef.current?.(sha, "image");
      }}
      onError={() => {
        clearCachedPreviewSrc(previewKey);
        releaseObjectUrl();
        setFailed(true);
      }}
    />
  ) : isVideo ? (
    <video
      src={src ?? undefined}
      className={`max-h-full max-w-full transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      }`}
      controls={variant === "dialog"}
      muted
      onCanPlay={() => {
        setIsReady(true);
        setLoading(false);
        setFailed(false);
        detectRef.current?.(sha, "video");
      }}
      onError={() => {
        clearCachedPreviewSrc(previewKey);
        releaseObjectUrl();
        setFailed(true);
      }}
    />
  ) : null;

  const overlayConfig = useMemo(() => {
    const baseSize = fallbackIconSize ?? (variant === "dialog" ? 96 : 48);
    switch (fallbackIconKind) {
      case "music":
        return {
          background: "bg-gradient-to-br from-emerald-900/70 via-slate-900 to-slate-950",
          icon: <MusicIcon size={baseSize} className="text-emerald-200" aria-hidden="true" />,
        };
      case "video":
        return {
          background: "bg-gradient-to-br from-sky-900/70 via-slate-900 to-slate-950",
          icon: <VideoIcon size={baseSize} className="text-sky-200" aria-hidden="true" />,
        };
      case "pdf":
        return {
          background: "bg-gradient-to-br from-red-900/70 via-slate-900 to-slate-950",
          icon: <FileTypeIcon kind="pdf" size={baseSize} className="text-red-200" aria-hidden="true" />,
        };
      case "doc":
      case "document":
        return {
          background: "bg-gradient-to-br from-purple-900/70 via-slate-900 to-slate-950",
          icon: <DocumentIcon size={baseSize} className="text-purple-200" aria-hidden="true" />,
        };
      default:
        return {
          background: "bg-slate-950/70",
          icon: <FileTypeIcon kind={fallbackIconKind} size={baseSize} className="text-slate-300" aria-hidden="true" />,
        };
    }
  }, [fallbackIconKind, fallbackIconSize, variant]);

  const showBlurhashPlaceholder = Boolean(blurhashPlaceholder && !textPreview && !showMedia);
  const showLoadingOverlay = showLoading && !showBlurhashPlaceholder;
  const showUnavailableOverlay = showUnavailable && !showBlurhashPlaceholder;

  return (
    <div ref={observeTarget} className={classNames}>
      {showBlurhashPlaceholder ? (
        <div className="absolute inset-0">
          {blurhashPlaceholder}
        </div>
      ) : null}
      {content}
      {showLoadingOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs text-slate-300 pointer-events-none">
          Loading preview…
        </div>
      )}
      {showUnavailableOverlay && (
        <div
          className={`absolute inset-0 flex items-center justify-center rounded-2xl border border-slate-800/80 ${overlayConfig.background} ${
            variant === "dialog" ? "mx-4 my-4" : ""
          }`}
        >
          {overlayConfig.icon}
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

function shouldDisablePreview(kind: FileKind) {
  return kind !== "image" && kind !== "video";
}

function buildPreviewUrl(blob: BlossomBlob, kind: FileKind, baseUrl?: string | null) {
  if (shouldDisablePreview(kind)) return null;
  if (blob.url) return blob.url;
  const fallback = blob.serverUrl ?? baseUrl;
  if (!fallback) return null;
  return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
}

function extractBlurhash(blob: BlossomBlob): BlurhashInfo | null {
  const tags = Array.isArray(blob.nip94) ? blob.nip94 : null;
  if (!tags) return null;
  let hash: string | null = null;
  let width: number | undefined;
  let height: number | undefined;

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    const [key, value] = tag;
    if (key === "blurhash" && typeof value === "string" && value.trim()) {
      hash = value.trim();
    } else if (key === "dim" && typeof value === "string") {
      const [w, h] = value.trim().toLowerCase().split("x");
      const parsedWidth = Number(w);
      const parsedHeight = Number(h);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) width = parsedWidth;
      if (Number.isFinite(parsedHeight) && parsedHeight > 0) height = parsedHeight;
    } else if (key === "width" && typeof value === "string") {
      const parsedWidth = Number(value);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) width = parsedWidth;
    } else if (key === "height" && typeof value === "string") {
      const parsedHeight = Number(value);
      if (Number.isFinite(parsedHeight) && parsedHeight > 0) height = parsedHeight;
    }
  }

  if (!hash) return null;
  return { hash, width, height };
}

function decideFileKind(blob: BlossomBlob, detected?: "image" | "video"): FileKind {
  if (detected) return detected;
  if (isSheetType(blob.type, blob.name || blob.url)) return "sheet";
  if (isDocType(blob.type, blob.name || blob.url)) return "doc";
  if (isPdfType(blob.type, blob.name || blob.url)) return "pdf";
  if (isMusicType(blob.type, blob.name, blob.url)) return "music";
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

function hasMusicExtension(value?: string | null) {
  if (!value) return false;
  return MUSIC_EXTENSION_REGEX.test(value.toLowerCase());
}

function isMusicType(type?: string, name?: string | null, url?: string | null) {
  const normalizedMime = normalizeMime(type);
  if (normalizedMime?.startsWith("audio/")) return true;
  if (normalizedMime && ADDITIONAL_AUDIO_MIME_TYPES.has(normalizedMime)) return true;
  if (hasMusicExtension(name)) return true;
  if (hasMusicExtension(url)) return true;
  return false;
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

const PREVIEW_OBJECT_URL_TTL_MS = 60_000;
const previewSrcCache = new Map<string, { url: string; expiresAt: number }>();

const getCachedPreviewSrc = (key: string): string | null => {
  const entry = previewSrcCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    URL.revokeObjectURL(entry.url);
    previewSrcCache.delete(key);
    return null;
  }
  entry.expiresAt = Date.now() + PREVIEW_OBJECT_URL_TTL_MS;
  previewSrcCache.set(key, entry);
  return entry.url;
};

const setCachedPreviewSrc = (key: string, url: string) => {
  previewSrcCache.set(key, { url, expiresAt: Date.now() + PREVIEW_OBJECT_URL_TTL_MS });
};

const clearCachedPreviewSrc = (key: string) => {
  const entry = previewSrcCache.get(key);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    previewSrcCache.delete(key);
  }
};

const AudioCoverImage: React.FC<{ url: string; alt: string; className?: string; fallback: React.ReactNode }> = ({
  url,
  alt,
  className,
  fallback,
}) => {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={url}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
};

const blurhashDataUrlCache = new Map<string, string>();

const buildBlurhashCacheKey = (hash: string, width?: number, height?: number) =>
  `${hash}|${width ?? ""}|${height ?? ""}`;

const decodeBlurhashToDataUrl = (hash: string, width?: number, height?: number): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const aspectRatio = width && height && height > 0 ? width / height : 1;
    const baseSize = 32;
    const maxSize = 64;
    let decodeWidth = baseSize;
    let decodeHeight = baseSize;
    if (aspectRatio > 1) {
      decodeWidth = Math.min(maxSize, Math.max(8, Math.round(baseSize * aspectRatio)));
      decodeHeight = Math.max(8, Math.round(decodeWidth / aspectRatio));
    } else if (aspectRatio > 0 && aspectRatio < 1) {
      decodeHeight = Math.min(maxSize, Math.max(8, Math.round(baseSize / Math.max(aspectRatio, 0.01))));
      decodeWidth = Math.max(8, Math.round(decodeHeight * aspectRatio));
    }
    decodeWidth = Math.max(4, Math.min(maxSize, decodeWidth));
    decodeHeight = Math.max(4, Math.min(maxSize, decodeHeight));

    const pixels = decode(hash, decodeWidth, decodeHeight);
    const canvas = document.createElement("canvas");
    canvas.width = decodeWidth;
    canvas.height = decodeHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = ctx.createImageData(decodeWidth, decodeHeight);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  } catch (error) {
    console.warn("Failed to decode blurhash preview", error);
    return null;
  }
};

type BlurhashThumbnailProps = {
  hash: string;
  width?: number;
  height?: number;
  alt: string;
};

function BlurhashThumbnail({ hash, width, height, alt }: BlurhashThumbnailProps) {
  const cacheKey = useMemo(() => buildBlurhashCacheKey(hash, width, height), [hash, width, height]);
  const [dataUrl, setDataUrl] = useState<string | null>(() => blurhashDataUrlCache.get(cacheKey) ?? null);

  useEffect(() => {
    const cached = blurhashDataUrlCache.get(cacheKey);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    const result = decodeBlurhashToDataUrl(hash, width, height);
    if (result) {
      blurhashDataUrlCache.set(cacheKey, result);
      setDataUrl(result);
    } else {
      setDataUrl(null);
    }
  }, [cacheKey, hash, width, height]);

  if (!dataUrl) {
    return <div className="h-full w-full bg-slate-900/70" />;
  }

  return <img src={dataUrl} alt={alt} className="h-full w-full object-cover" loading="lazy" draggable={false} />;
}

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

function formatDurationSeconds(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
