import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { decode } from "blurhash";
import { FixedSizeList as VirtualList } from "react-window";
import { prettyBytes, prettyDate } from "../../../shared/utils/format";
import { buildAuthorizationHeader, extractSha256FromUrl, type BlossomBlob, type SignTemplate } from "../../../shared/api/blossomClient";
import { buildNip98AuthHeader } from "../../../shared/api/nip98";
import { decryptPrivateBlob, type PrivateEncryptionMetadata } from "../../../shared/domain/privateEncryption";
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
  LockIcon,
  CopyIcon,
  TransferIcon,
} from "../../../shared/ui/icons";
import { PRIVATE_PLACEHOLDER_SHA } from "../../../shared/constants/private";
import type { FileKind } from "../../../shared/ui/icons";
import { getBlobMetadataName, normalizeFolderPathInput, type BlobAudioMetadata } from "../../../shared/utils/blobMetadataStore";
import { cachePreviewBlob, getCachedPreviewBlob } from "../../../shared/utils/blobPreviewCache";
import { useBlobMetadata } from "../useBlobMetadata";
import { useBlobPreview, type PreviewTarget, canBlobPreview } from "../useBlobPreview";
import { useInViewport } from "../../../shared/hooks/useInViewport";
import { useAudioMetadataMap } from "../useAudioMetadata";
import { usePrivateLibrary } from "../../../app/context/PrivateLibraryContext";
import type { PrivateListEntry } from "../../../shared/domain/privateList";
import { useUserPreferences, type DefaultSortOption, type SortDirection } from "../../../app/context/UserPreferencesContext";
import { useDialog } from "../../../app/context/DialogContext";
import type { FolderListRecord } from "../../../shared/domain/folderList";
import type { FolderShareHint, ShareFolderScope } from "../../../shared/types/shareFolder";
import type { ShareMode } from "../../share/ui/ShareComposer";

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
  onShare?: (blob: BlossomBlob, options?: { mode?: ShareMode }) => void;
  onRename?: (blob: BlossomBlob) => void;
  onMove?: (blob: BlossomBlob) => void;
  onOpenList?: (blob: BlossomBlob) => void;
  folderRecords?: Map<string, FolderListRecord>;
  onShareFolder?: (hint: FolderShareHint) => void;
  onUnshareFolder?: (hint: FolderShareHint) => void;
  folderShareBusyPath?: string | null;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  showGridPreviews?: boolean;
  showListPreviews?: boolean;
  defaultSortOption: DefaultSortOption;
  sortDirection?: SortDirection;
};

type DetectedKindMap = Record<string, "image" | "video">;

const MUSIC_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|oga|flac|aac|m4a|weba|webm|alac|aiff|aif|wma|mid|midi|amr|opus)(?:\?|#|$)/i;

const ADDITIONAL_AUDIO_MIME_TYPES = new Set(
  ["application/ogg", "application/x-ogg", "application/flac", "application/x-flac"].map(value =>
    value.toLowerCase()
  )
);

const LIST_WORD_REGEX = /(?:^|[+./-])list(?:$|[+./-])/;

const isDirectoryLikeMime = (value?: string | null) => {
  const normalized = normalizeMime(value);
  const raw = value?.toLowerCase() ?? "";
  if (!normalized) return false;
  if (normalized === "application/x-directory" || normalized === "inode/directory") return true;
  if (normalized.startsWith("application/")) {
    if (normalized.includes("directory") || normalized.includes("folder")) return true;
    if (LIST_WORD_REGEX.test(normalized) && (normalized.includes("nostr") || normalized.includes("bloom"))) {
      return true;
    }
  }
  if (raw.includes("type=list") || raw.includes("category=list")) return true;
  return false;
};

export const isListLikeBlob = (blob: BlossomBlob) => {
  if (isDirectoryLikeMime(blob.type)) return true;
  const metadataType = blob.privateData?.metadata?.type;
  if (isDirectoryLikeMime(metadataType)) return true;
  return false;
};

const DROPDOWN_OFFSET_PX = 8;

type DropdownPlacement = "up" | "down";

const useDropdownPlacement = (
  menuOpen: boolean,
  triggerRef: React.RefObject<HTMLElement | null>,
  menuRef: React.RefObject<HTMLElement | null>,
  boundary: HTMLElement | null
) => {
  const [placement, setPlacement] = useState<DropdownPlacement | null>(null);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setPlacement(null);
      return;
    }

    if (typeof window === "undefined") return;

    let frame: number | null = null;

    const computePlacement = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const boundaryRect = boundary?.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();

      const topLimit = boundaryRect ? boundaryRect.top : 0;
      const bottomLimit = boundaryRect ? boundaryRect.bottom : window.innerHeight;
      const spaceBelow = bottomLimit - triggerRect.bottom;
      const spaceAbove = triggerRect.top - topLimit;
      const requiredSpace = menuRect.height + DROPDOWN_OFFSET_PX;
      const shouldDropUp = spaceBelow < requiredSpace && spaceAbove > spaceBelow;

      setPlacement(previous => {
        const next = shouldDropUp ? "up" : "down";
        return previous === next ? previous : next;
      });
    };

    computePlacement();

    const scrollTarget: HTMLElement | Window = boundary ?? window;

    const scheduleCompute = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        computePlacement();
        frame = null;
      });
    };

    scrollTarget.addEventListener("scroll", scheduleCompute, { passive: true });
    window.addEventListener("resize", scheduleCompute);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", scheduleCompute);
      window.removeEventListener("resize", scheduleCompute);
    };
  }, [menuOpen, boundary, triggerRef, menuRef]);

  return placement;
};

const prioritizeListBlobs = (items: readonly BlossomBlob[]): BlossomBlob[] => {
  if (items.length <= 1) {
    return Array.isArray(items) ? (items as BlossomBlob[]).slice() : Array.from(items);
  }
  const lists: BlossomBlob[] = [];
  const files: BlossomBlob[] = [];
  let seenFile = false;
  let requiresReorder = false;

  for (const item of items) {
    if (isListLikeBlob(item)) {
      if (seenFile) {
        requiresReorder = true;
      }
      lists.push(item);
    } else {
      seenFile = true;
      files.push(item);
    }
  }

  if (!requiresReorder) {
    return Array.isArray(items) ? (items as BlossomBlob[]).slice() : Array.from(items);
  }

  return [...lists, ...files];
};

type BlurhashInfo = {
  hash: string;
  width?: number;
  height?: number;
};

type SortKey = "name" | "replicas" | "size" | "updated" | "artist" | "album" | "duration";

type SortConfig = { key: SortKey; direction: "asc" | "desc" };

const CARD_HEIGHT = 260;

const ReplicaBadge: React.FC<{
  info?: BlobReplicaSummary;
  variant: "grid" | "list";
  privateIndicator?: boolean;
  privateLabel?: string;
}> = ({ info, variant, privateIndicator = false, privateLabel }) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  if (privateIndicator) {
    const label = privateLabel ?? "Private";
    const baseClass =
      variant === "grid"
        ? "bg-amber-900/70 text-amber-100 shadow-lg"
        : "bg-amber-900/75 text-amber-100 shadow";
    const paddingClass = variant === "grid" ? "px-2 py-1" : "px-2.5 py-0.5";
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/60 ${baseClass} ${paddingClass} font-semibold text-[11px] cursor-default select-none z-10`}
        title={label}
        aria-label={label}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        <LockIcon size={variant === "grid" ? 14 : 13} className="text-amber-200" aria-hidden="true" />
      </span>
    );
  }

  if (!info) return null;
  const title = info.servers.length
    ? `Available on ${info.servers.map(server => server.name).join(", ")}`
    : `Available on ${info.count} ${info.count === 1 ? "server" : "servers"}`;
  const themeIsLight = theme === "light";
  const baseClass = (() => {
    if (variant === "grid") {
      return themeIsLight ? "bg-white/90 text-emerald-600 shadow" : "bg-slate-950 text-emerald-100 shadow-lg";
    }
    return themeIsLight ? "bg-white text-emerald-600 shadow" : "bg-slate-900/85 text-emerald-100 shadow";
  })();
  const paddingClass = variant === "grid" ? "px-2 py-1" : "px-2.5 py-0.5";
  const iconSize = variant === "grid" ? 14 : 13;
  const iconClass = themeIsLight ? "text-emerald-500" : "text-emerald-300";
  const borderClass = themeIsLight ? "border-emerald-400/70" : "border-emerald-500/60";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border ${borderClass} ${baseClass} ${paddingClass} font-semibold text-[11px] tabular-nums cursor-default select-none z-10`}
      title={title}
      aria-label={title}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <SyncIndicatorIcon size={iconSize} className={iconClass} aria-hidden="true" />
      <span className={themeIsLight ? "text-emerald-600" : undefined}>{info.count}</span>
    </span>
  );
};

const deriveBlobSortName = (blob: BlossomBlob) => {
  const folderName =
    blob.__bloomFolderPlaceholder || isListLikeBlob(blob)
      ? blob.name
      : undefined;
  if (typeof folderName === "string" && folderName.trim()) {
    return folderName.trim().toLowerCase();
  }
  const explicit = getBlobMetadataName(blob);
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
  onMove,
  onOpenList,
  folderRecords,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath = null,
  currentTrackUrl,
  currentTrackStatus,
  showGridPreviews = true,
  showListPreviews = true,
  defaultSortOption = "updated",
  sortDirection = "descending",
}) => {
  const handleMove = useCallback(
    (blob: BlossomBlob) => {
      onMove?.(blob);
    },
    [onMove]
  );
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
      const privateMeta = blob.privateData?.metadata;
      const mergedType = overrides?.type ?? privateMeta?.type ?? blob.type;
      const mergedName = overrides?.name ?? privateMeta?.name ?? blob.name;
      return {
        ...blob,
        type: mergedType,
        name: mergedName,
        url: blob.url || (normalizedBase ? `${normalizedBase}/${blob.sha256}` : undefined),
        serverUrl: normalizedBase ?? blob.serverUrl,
        requiresAuth: blob.requiresAuth ?? requiresAuth,
        serverType: blob.serverType ?? serverType,
      };
    });
  }, [blobs, resolvedMeta, baseUrl, requiresAuth, serverType]);

  const audioMetadata = useAudioMetadataMap(decoratedBlobs);
  const { entriesBySha } = usePrivateLibrary();
  const { alert: showDialogAlert } = useDialog();

  const resolveCoverEntry = useCallback(
    (coverUrl?: string | null) => {
      if (!coverUrl) return null;
      const coverSha = extractSha256FromUrl(coverUrl);
      return coverSha ? entriesBySha.get(coverSha) ?? null : null;
    },
    [entriesBySha]
  );

  const deriveReplicaCount = useCallback(
    (blob: BlossomBlob): number => {
      const summary = replicaInfo?.get(blob.sha256);
      if (summary) {
        return summary.count;
      }

      const servers = new Set<string>();
      const addServer = (value?: string | null) => {
        if (typeof value !== "string") return;
        const normalized = value.trim().replace(/\/+$/, "");
        if (!normalized) return;
        servers.add(normalized);
      };

      addServer(blob.serverUrl ?? null);

      const privateServers = blob.privateData?.servers;
      if (Array.isArray(privateServers)) {
        privateServers.forEach(server => addServer(server));
      }

      return servers.size || (blob.serverUrl ? 1 : 0);
    },
    [replicaInfo]
  );

  const { previewTarget, openPreview, closePreview } = useBlobPreview({
    defaultServerType: serverType,
    defaultSignTemplate: signTemplate,
  });
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  useEffect(() => {
    setSortConfig(current => (current ? null : current));
  }, [defaultSortOption, sortDirection]);

  const baseSortedBlobs = useMemo(() => {
    if (decoratedBlobs.length <= 1) {
      return decoratedBlobs;
    }

    const compareNumbers = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
    const compareNamesAsc = (a: BlossomBlob, b: BlossomBlob) =>
      deriveBlobSortName(a).localeCompare(deriveBlobSortName(b));
    const compareUploadsAsc = (a: BlossomBlob, b: BlossomBlob) => {
      const aUploaded = typeof a.uploaded === "number" ? a.uploaded : 0;
      const bUploaded = typeof b.uploaded === "number" ? b.uploaded : 0;
      return compareNumbers(aUploaded, bUploaded);
    };
    const compareReplicaCountAsc = (a: BlossomBlob, b: BlossomBlob) => {
      const aCount = deriveReplicaCount(a);
      const bCount = deriveReplicaCount(b);
      return compareNumbers(aCount, bCount);
    };
    const compareSizeAsc = (a: BlossomBlob, b: BlossomBlob) => {
      const aSize = typeof a.size === "number" ? a.size : -1;
      const bSize = typeof b.size === "number" ? b.size : -1;
      return compareNumbers(aSize, bSize);
    };

    const directionMultiplier = sortDirection === "descending" ? -1 : 1;

    const comparator = (a: BlossomBlob, b: BlossomBlob) => {
      switch (defaultSortOption) {
        case "name": {
          const diff = compareNamesAsc(a, b);
          if (diff !== 0) return diff * directionMultiplier;
          const uploadedDiff = compareUploadsAsc(a, b);
          return uploadedDiff * directionMultiplier;
        }
        case "servers": {
          const diff = compareReplicaCountAsc(a, b);
          if (diff !== 0) return diff * directionMultiplier;
          return compareNamesAsc(a, b) * directionMultiplier;
        }
        case "size": {
          const diff = compareSizeAsc(a, b);
          if (diff !== 0) return diff * directionMultiplier;
          return compareNamesAsc(a, b) * directionMultiplier;
        }
        case "updated":
        default: {
          const diff = compareUploadsAsc(a, b);
          if (diff !== 0) return diff * directionMultiplier;
          return compareNamesAsc(a, b) * directionMultiplier;
        }
      }
    };

    const sorted = [...decoratedBlobs].sort(comparator);
    return prioritizeListBlobs(sorted);
  }, [decoratedBlobs, defaultSortOption, deriveReplicaCount, sortDirection]);

  const sortedBlobs = useMemo(() => {
    if (!sortConfig) {
      return baseSortedBlobs;
    }

    const { key, direction } = sortConfig;
    if (key === "updated") {
      if (direction === "desc") return baseSortedBlobs;
      return prioritizeListBlobs([...baseSortedBlobs].reverse());
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

    return prioritizeListBlobs(working);
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
      const fallbackBaseUrl = blob.serverUrl ?? baseUrl;
      const effectiveRequiresAuth = Boolean((blob.requiresAuth ?? requiresAuth) || blob.privateData?.encryption);
      const rawPreviewUrl = buildPreviewUrl(blob, fallbackBaseUrl);
      const canPreview = canBlobPreview(blob, detectedKind, kind);
      const isPdf = kind === "pdf";
      const isDocLike = kind === "doc" || kind === "document";
      const previewUrl = !isPdf && !isDocLike && canPreview ? rawPreviewUrl : null;
      const disablePreview = isPdf || isDocLike || !canPreview;

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

        const mimeHint = response.headers.get("content-type") || undefined;
        const privateEncryption = blob.privateData?.encryption;
        const privateMetadata = blob.privateData?.metadata;

        let downloadBlob: Blob;
        if (privateEncryption) {
          const encryptedBuffer = await response.arrayBuffer();
          if (privateEncryption.algorithm !== "AES-GCM") {
            throw new Error(`Unsupported encryption algorithm: ${privateEncryption.algorithm}`);
          }
          const decryptionMetadata: PrivateEncryptionMetadata = {
            algorithm: "AES-GCM",
            key: privateEncryption.key,
            iv: privateEncryption.iv,
            originalName: privateMetadata?.name,
            originalType: privateMetadata?.type,
            originalSize: privateMetadata?.size,
          };
          try {
            const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, decryptionMetadata);
            const resolvedType = privateMetadata?.type || blob.type || mimeHint || "application/octet-stream";
            downloadBlob = new Blob([decryptedBuffer], { type: resolvedType });
          } catch (decryptError) {
            throw new Error(
              decryptError instanceof Error ? decryptError.message : "Failed to decrypt private file."
            );
          }
        } else {
          downloadBlob = await response.blob();
        }

        const metadataName = getBlobMetadataName(blob);
        const baseName = sanitizeFilename(metadataName ?? blob.sha256);
        const typeHint = privateMetadata?.type || downloadBlob.type || blob.type || mimeHint;
        const extension = inferExtensionFromType(typeHint);
        const filename = ensureExtension(baseName, extension);

        objectUrl = URL.createObjectURL(downloadBlob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        console.error("Failed to download blob", error);
        const message = error instanceof Error ? error.message : "Failed to download blob.";
        void showDialogAlert({
          title: "Download failed",
          message,
          acknowledgeLabel: "Close",
          tone: "danger",
        });
      } finally {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      }
    },
    [showDialogAlert, signTemplate, serverType]
  );

  const listBlobs = useMemo(() => {
    if (viewMode !== "list") return baseSortedBlobs;
    if (!sortConfig || sortConfig.key === "name" || sortConfig.key === "size" || sortConfig.key === "updated") {
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

    const directed = sortConfig.direction === "asc" ? sorted : sorted.reverse();
    return prioritizeListBlobs(directed);
  }, [audioMetadata, baseSortedBlobs, replicaInfo, sortConfig, sortedBlobs, viewMode]);

  if (previewTarget) {
    return (
      <div className="flex h-full flex-1 min-h-0 w-full flex-col overflow-hidden">
        <PreviewDialog
          target={previewTarget}
          onClose={handleClosePreview}
          onDetect={handleDetect}
          onCopy={onCopy}
          onBlobVisible={requestMetadata}
        />
      </div>
    );
  }

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
          onMove={handleMove}
          onOpenList={onOpenList}
          folderRecords={folderRecords}
          onShareFolder={onShareFolder}
          onUnshareFolder={onUnshareFolder}
          folderShareBusyPath={folderShareBusyPath}
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
          resolveCoverEntry={resolveCoverEntry}
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
          onMove={handleMove}
          onOpenList={onOpenList}
          folderRecords={folderRecords}
          onShareFolder={onShareFolder}
          onUnshareFolder={onUnshareFolder}
          folderShareBusyPath={folderShareBusyPath}
          currentTrackUrl={currentTrackUrl}
          currentTrackStatus={currentTrackStatus}
          detectedKinds={detectedKinds}
          onDetect={handleDetect}
          onBlobVisible={requestMetadata}
          replicaInfo={replicaInfo}
          audioMetadata={audioMetadata}
          showPreviews={showGridPreviews}
          resolveCoverEntry={resolveCoverEntry}
        />
      )}
    </div>
  );
};

const LIST_ROW_HEIGHT = 68;
const LIST_ROW_HEIGHT_COMPACT = 96;
const LIST_ROW_GAP = 4;

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
  onShare?: (blob: BlossomBlob, options?: { mode?: ShareMode }) => void;
  onRename?: (blob: BlossomBlob) => void;
  onMove?: (blob: BlossomBlob) => void;
  onOpenList?: (blob: BlossomBlob) => void;
  folderRecords?: Map<string, FolderListRecord>;
  onShareFolder?: (hint: FolderShareHint) => void;
  onUnshareFolder?: (hint: FolderShareHint) => void;
  folderShareBusyPath?: string | null;
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
  resolveCoverEntry: (coverUrl?: string | null) => PrivateListEntry | null;
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
      onMove,
      onOpenList,
  folderRecords,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath,
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
  resolveCoverEntry,
}) => {
  const handleMove = useCallback(
    (blob: BlossomBlob) => {
      onMove?.(blob);
    },
    [onMove]
  );
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listOuterRef = useRef<HTMLDivElement | null>(null);
  const getMenuBoundary = useCallback(() => listOuterRef.current, []);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [actionsColumnWidth, setActionsColumnWidth] = useState<number | null>(null);

  const listWidth = container.width > 0 ? Math.max(0, container.width - 1) : container.width || 0;
  const fallbackCompact = typeof window !== "undefined" ? window.innerWidth < 640 : false;
  const isCompactList = container.width > 0 ? container.width < 640 : fallbackCompact;
  const listRowHeight = isCompactList ? LIST_ROW_HEIGHT_COMPACT : LIST_ROW_HEIGHT;

  const handleActionsWidthChange = useCallback((width: number | null) => {
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
      setActionsColumnWidth(null);
      return;
    }
    setActionsColumnWidth(previous => {
      if (previous === null) return width;
      return Math.abs(previous - width) > 1 ? width : previous;
    });
  }, []);

  useEffect(() => {
    setActionsColumnWidth(null);
  }, [isMusicView, isCompactList]);

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
  const estimatedHeight = (listRowHeight + LIST_ROW_GAP) * Math.min(blobs.length, 8);
  const listHeight = container.height > 0 ? container.height : Math.min(480, Math.max(listRowHeight + LIST_ROW_GAP, estimatedHeight));

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

  const itemData = useMemo(
    () => ({
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
      onMove: handleMove,
      onOpenList,
      folderRecords,
      onShareFolder,
      onUnshareFolder,
      folderShareBusyPath,
      currentTrackUrl,
      currentTrackStatus,
      detectedKinds,
      onDetect,
      onBlobVisible,
      replicaInfo,
      isMusicView,
      audioMetadata,
      showPreviews,
      resolveCoverEntry,
      handleActionsWidthChange,
      getMenuBoundary,
      isCompactList,
      listRowHeight,
      actionsColumnWidth,
    }),
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
      handleMove,
      onOpenList,
      folderRecords,
      onShareFolder,
      onUnshareFolder,
      folderShareBusyPath,
      currentTrackUrl,
      currentTrackStatus,
      detectedKinds,
      onDetect,
      onBlobVisible,
      replicaInfo,
      isMusicView,
      audioMetadata,
      showPreviews,
      resolveCoverEntry,
      handleActionsWidthChange,
      getMenuBoundary,
      isCompactList,
      listRowHeight,
      actionsColumnWidth,
    ]
  );

  const Row = useCallback(
    ({ index, style, data }: { index: number; style: React.CSSProperties; data: typeof itemData }) => {
      const {
        blobs: listBlobs,
        baseUrl: rowBaseUrl,
        requiresAuth: rowRequiresAuth,
        signTemplate: rowSignTemplate,
        serverType: rowServerType,
        selected: rowSelected,
        onToggle: rowOnToggle,
        onDelete: rowOnDelete,
        onDownload: rowOnDownload,
        onPreview: rowOnPreview,
        onPlay: rowOnPlay,
        onShare: rowOnShare,
        onRename: rowOnRename,
        onMove: rowOnMove,
        onOpenList: rowOnOpenList,
        currentTrackUrl: rowCurrentTrackUrl,
        currentTrackStatus: rowCurrentTrackStatus,
        detectedKinds: rowDetectedKinds,
        onDetect: rowOnDetect,
        onBlobVisible: rowOnBlobVisible,
        replicaInfo: rowReplicaInfo,
        isMusicView: rowIsMusicView,
        audioMetadata: rowAudioMetadata,
        showPreviews: rowShowPreviews,
        resolveCoverEntry: rowResolveCoverEntry,
        handleActionsWidthChange: rowHandleActionsWidthChange,
        getMenuBoundary: rowGetMenuBoundary,
        isCompactList: rowIsCompactList,
        listRowHeight: rowListRowHeight,
        actionsColumnWidth: rowActionsColumnWidth,
        folderRecords: rowFolderRecords,
        onShareFolder: rowOnShareFolder,
        onUnshareFolder: rowOnUnshareFolder,
        folderShareBusyPath: rowFolderShareBusyPath,
      } = data;

      const blob = listBlobs[index];
      if (!blob) return null;

      const rawTop = typeof style.top === "number" ? style.top : Number.parseFloat(String(style.top ?? 0));
      const top = Number.isFinite(rawTop) ? rawTop + LIST_ROW_GAP / 2 : rawTop;
      const baseRowHeight = rowListRowHeight;
      const rawHeight = typeof style.height === "number" ? style.height : Number.parseFloat(String(style.height ?? baseRowHeight));
      const height = Number.isFinite(rawHeight) ? rawHeight : baseRowHeight;
      const replicaSummary = rowReplicaInfo?.get(blob.sha256);
      const isPrivateBlob = Boolean(blob.privateData);
      const trackMetadata = rowAudioMetadata.get(blob.sha256) ?? null;
      const coverEntry = rowResolveCoverEntry(trackMetadata?.coverUrl ?? undefined);
      const isSelected = rowSelected.has(blob.sha256);
      const detectedKind = rowDetectedKinds[blob.sha256];

      return (
        <ListRow
          key={blob.sha256}
          top={top}
          left={0}
          width={listWidth}
          height={height}
          blob={blob}
          baseUrl={rowBaseUrl}
          requiresAuth={rowRequiresAuth}
          signTemplate={rowSignTemplate}
          serverType={rowServerType}
          isSelected={isSelected}
          onToggle={rowOnToggle}
          onDelete={rowOnDelete}
          onDownload={rowOnDownload}
          onPreview={rowOnPreview}
          onPlay={rowOnPlay}
          onShare={rowOnShare}
          onRename={rowOnRename}
          onMove={rowOnMove}
          onOpenList={rowOnOpenList}
          folderRecords={rowFolderRecords}
          onShareFolder={rowOnShareFolder}
          onUnshareFolder={rowOnUnshareFolder}
          folderShareBusyPath={rowFolderShareBusyPath}
          currentTrackUrl={rowCurrentTrackUrl}
          currentTrackStatus={rowCurrentTrackStatus}
          detectedKind={detectedKind}
          onDetect={rowOnDetect}
          onBlobVisible={rowOnBlobVisible}
          replicaSummary={replicaSummary}
          isMusicListView={rowIsMusicView}
          trackMetadata={trackMetadata}
          onActionsWidthChange={rowHandleActionsWidthChange}
          showPreviews={rowShowPreviews}
          isPrivateBlob={isPrivateBlob}
          coverEntry={coverEntry}
          getMenuBoundary={rowGetMenuBoundary}
          isCompactList={rowIsCompactList}
          actionsColumnWidth={rowActionsColumnWidth}
        />
      );
    },
    [itemData, listWidth]
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
            style={!isCompactList && actionsColumnWidth ? { width: actionsColumnWidth } : undefined}
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
          onClick={() => onSort("updated")}
          className="hidden items-center gap-1 text-left font-semibold text-slate-200 hover:text-slate-100 md:flex"
        >
          <span>Updated</span>
          <span aria-hidden="true">{headerIndicator("updated")}</span>
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
          style={!isCompactList && actionsColumnWidth ? { width: actionsColumnWidth } : undefined}
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
          itemSize={listRowHeight + LIST_ROW_GAP}
            width={listWidth}
            onItemsRendered={handleItemsRendered}
            overscanCount={6}
            outerRef={listOuterRef}
            itemData={itemData}
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
  onShare?: (blob: BlossomBlob, options?: { mode?: ShareMode }) => void;
  onRename?: (blob: BlossomBlob) => void;
  onMove?: (blob: BlossomBlob) => void;
  onOpenList?: (blob: BlossomBlob) => void;
  folderRecords?: Map<string, FolderListRecord>;
  onShareFolder?: (hint: FolderShareHint) => void;
  onUnshareFolder?: (hint: FolderShareHint) => void;
  folderShareBusyPath?: string | null;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
  onBlobVisible: (sha: string) => void;
  replicaInfo?: Map<string, BlobReplicaSummary>;
  audioMetadata: Map<string, BlobAudioMetadata>;
  showPreviews: boolean;
  resolveCoverEntry: (coverUrl?: string | null) => PrivateListEntry | null;
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
  onMove: handleMove,
  onOpenList,
  folderRecords,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath,
  currentTrackUrl,
  currentTrackStatus,
  detectedKinds,
  onDetect,
  onBlobVisible,
  replicaInfo,
  audioMetadata,
  showPreviews,
  resolveCoverEntry,
}) => {
  const CARD_WIDTH = 220;
  const HORIZONTAL_GAP = 8;
  const VERTICAL_GAP = 12;
  const OVERSCAN_ROWS = 2;
  const FALLBACK_MAX_WIDTH = 1280;
  const FALLBACK_HORIZONTAL_PADDING = HORIZONTAL_GAP * 2;
  const FALLBACK_MIN_ROWS = 3;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fallbackViewport = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        width: CARD_WIDTH * 3 + HORIZONTAL_GAP * 4,
        height: (CARD_HEIGHT + VERTICAL_GAP) * FALLBACK_MIN_ROWS,
      };
    }
    const width = Math.max(
      CARD_WIDTH,
      Math.min(window.innerWidth, FALLBACK_MAX_WIDTH) - FALLBACK_HORIZONTAL_PADDING
    );
    const height = Math.max(CARD_HEIGHT + VERTICAL_GAP, Math.floor((window.innerHeight || 800) * 0.6));
    return { width, height };
  }, []);
  const [viewport, setViewport] = useState(() => ({
    height: fallbackViewport.height,
    width: fallbackViewport.width,
    scrollTop: 0,
  }));
  const [hasMeasuredViewport, setHasMeasuredViewport] = useState(false);
  const [openMenuBlob, setOpenMenuBlob] = useState<string | null>(null);
  const dropdownRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const getMenuBoundary = useCallback(() => viewportRef.current, []);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let frame: number | null = null;
    const updateSize = () => {
      setViewport(prev => {
        const nextHeight = el.clientHeight;
        const nextWidth = el.clientWidth;
        const hasDimensions = nextHeight > 0 && nextWidth > 0;
        if (hasDimensions && prev.height === nextHeight && prev.width === nextWidth) {
          return prev;
        }
        if (!hasDimensions) {
          return prev;
        }
        return { height: nextHeight, width: nextWidth, scrollTop: el.scrollTop };
      });
      if (el.clientHeight > 0 && el.clientWidth > 0) {
        setHasMeasuredViewport(true);
      }
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

  const viewportHeight = hasMeasuredViewport ? viewport.height : fallbackViewport.height;
  const viewportWidth = hasMeasuredViewport ? viewport.width : fallbackViewport.width;
  const scrollTop = hasMeasuredViewport ? viewport.scrollTop : 0;
  const columnCount = Math.max(1, Math.floor((viewportWidth + HORIZONTAL_GAP) / (CARD_WIDTH + HORIZONTAL_GAP)));
  const effectiveColumnWidth = Math.max(
    160,
    Math.floor((viewportWidth - HORIZONTAL_GAP * (columnCount + 1)) / columnCount) || CARD_WIDTH
  );
  const rowHeight = CARD_HEIGHT + VERTICAL_GAP;
  const rowCount = Math.ceil(blobs.length / columnCount);
  const visibleRowCount = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + OVERSCAN_ROWS * 2 : rowCount;
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const endRow = Math.min(rowCount, startRow + visibleRowCount);
  const visibleItems = useMemo(() => {
    const result: Array<{ blob: BlossomBlob; row: number; col: number }> = [];
    for (let row = startRow; row < endRow; row += 1) {
      for (let col = 0; col < columnCount; col += 1) {
        const index = row * columnCount + col;
        if (index >= blobs.length) break;
        const blob = blobs[index];
        if (!blob) continue;
        result.push({ blob, row, col });
      }
    }
    return result;
  }, [blobs, columnCount, endRow, startRow]);

  const handleToggleMenu = useCallback((sha: string) => {
    setOpenMenuBlob(current => (current === sha ? null : sha));
  }, []);

  const handleCloseMenu = useCallback(() => {
    setOpenMenuBlob(null);
  }, []);
  const containerHeight = rowCount * rowHeight + VERTICAL_GAP;

  return (
    <div className="flex flex-1 min-h-0 w-full flex-col overflow-hidden">
      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden"
      >
        <div style={{ position: "relative", height: containerHeight }}>
          {visibleItems.map(({ blob, row, col }) => (
            <GridCard
              key={blob.sha256}
              blob={blob}
              top={VERTICAL_GAP + row * rowHeight}
              left={HORIZONTAL_GAP + col * (effectiveColumnWidth + HORIZONTAL_GAP)}
              width={effectiveColumnWidth}
              height={CARD_HEIGHT}
              isSelected={selected.has(blob.sha256)}
              baseUrl={baseUrl}
              requiresAuth={requiresAuth}
              signTemplate={signTemplate}
              serverType={serverType}
              currentTrackUrl={currentTrackUrl}
              currentTrackStatus={currentTrackStatus}
              detectedKind={detectedKinds[blob.sha256]}
              audioMetadata={audioMetadata}
              onToggle={onToggle}
              onDelete={onDelete}
              onDownload={onDownload}
              onPreview={onPreview}
              onPlay={onPlay}
              onShare={onShare}
              onRename={onRename}
              onMove={handleMove}
              onOpenList={onOpenList}
              folderRecords={folderRecords}
              onShareFolder={onShareFolder}
              onUnshareFolder={onUnshareFolder}
              folderShareBusyPath={folderShareBusyPath}
              onDetect={onDetect}
              onBlobVisible={onBlobVisible}
              replicaSummary={replicaInfo?.get(blob.sha256)}
              showPreviews={showPreviews}
              resolveCoverEntry={resolveCoverEntry}
              isMenuOpen={openMenuBlob === blob.sha256}
              onToggleMenu={handleToggleMenu}
              onCloseMenu={handleCloseMenu}
              dropdownRefs={dropdownRefs}
              getMenuBoundary={getMenuBoundary}
            />
          ))}
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

type GridCardProps = {
  blob: BlossomBlob;
  top: number;
  left: number;
  width: number;
  height: number;
  isSelected: boolean;
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  detectedKind?: "image" | "video";
  audioMetadata: Map<string, BlobAudioMetadata>;
  onToggle: (sha: string) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onPreview: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob, options?: { mode?: ShareMode }) => void;
  onRename?: (blob: BlossomBlob) => void;
  onMove?: (blob: BlossomBlob) => void;
  onOpenList?: (blob: BlossomBlob) => void;
  folderRecords?: Map<string, FolderListRecord>;
  onShareFolder?: (hint: FolderShareHint) => void;
  onUnshareFolder?: (hint: FolderShareHint) => void;
  folderShareBusyPath?: string | null;
  onDetect: (sha: string, kind: "image" | "video") => void;
  onBlobVisible: (sha: string) => void;
  replicaSummary?: BlobReplicaSummary;
  showPreviews: boolean;
  resolveCoverEntry: (coverUrl?: string | null) => PrivateListEntry | null;
  isMenuOpen: boolean;
  onToggleMenu: (sha: string) => void;
  onCloseMenu: () => void;
  dropdownRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  getMenuBoundary: () => HTMLElement | null;
};

const GridCard = React.memo<GridCardProps>(
  ({
    blob,
    top,
    left,
    width,
    height,
    isSelected,
    baseUrl,
    requiresAuth,
    signTemplate,
    serverType,
    currentTrackUrl,
    currentTrackStatus,
    detectedKind,
    audioMetadata,
    onToggle,
    onDelete,
    onDownload,
    onPreview,
    onPlay,
    onShare,
    onRename,
    onMove,
    onOpenList,
    folderRecords,
    onShareFolder,
    onUnshareFolder,
    folderShareBusyPath,
    onDetect,
    onBlobVisible,
    replicaSummary,
    showPreviews,
    resolveCoverEntry,
    isMenuOpen,
    onToggleMenu,
    onCloseMenu,
    dropdownRefs,
    getMenuBoundary,
  }) => {
    const dropdownContainerRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const menuBoundary = getMenuBoundary?.() ?? null;
    const menuPlacement = useDropdownPlacement(isMenuOpen, dropdownContainerRef, menuRef, menuBoundary);
    const {
      preferences: { theme },
    } = useUserPreferences();
    const isLightTheme = theme === "light";
    const toolbarFocusClass = isLightTheme
      ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-white"
      : "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900";
    const toolbarBaseClass = `${toolbarFocusClass} flex h-11 w-full items-center justify-center transition disabled:cursor-not-allowed disabled:opacity-45`;
    const neutralToolbarClass = isLightTheme
      ? "border border-slate-300 bg-white/95 text-slate-700 shadow-sm hover:bg-white"
      : "border border-slate-700 bg-slate-900/80 text-slate-100 shadow-sm hover:bg-slate-900/60";
    const primaryToolbarClass = isLightTheme
      ? "border border-slate-300 bg-slate-100 text-slate-900 shadow-sm hover:bg-slate-200"
      : "border border-slate-700 bg-slate-800 text-slate-100 shadow-sm hover:bg-slate-700";
    const toolbarNeutralButtonClass = `${toolbarBaseClass} ${neutralToolbarClass}`;
    const toolbarPrimaryButtonClass = `${toolbarBaseClass} ${primaryToolbarClass}`;
    const dropdownTriggerClass = `${toolbarNeutralButtonClass} justify-center`;
    const menuBaseClass = isLightTheme
      ? "absolute right-0 z-50 w-44 rounded-md border border-slate-300 bg-white p-1 text-slate-700 shadow-xl"
      : "absolute right-0 z-50 w-44 rounded-md border border-slate-700 bg-slate-900/95 p-1 text-slate-200 shadow-xl backdrop-blur";
    const focusRingClass = isLightTheme
      ? "focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-white"
      : "focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-slate-900";
    const makeItemClass = (variant?: "destructive", disabled?: boolean) => {
      const base = `flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition ${focusRingClass}`;
      const variantClass = variant === "destructive"
        ? isLightTheme
          ? "text-red-600 hover:bg-red-50"
          : "text-red-300 hover:bg-red-900/40"
        : isLightTheme
          ? "text-slate-700 hover:bg-slate-100"
          : "text-slate-200 hover:bg-slate-700";
      const disabledClass = disabled ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "";
      return `${base} ${variantClass} ${disabledClass}`.trim();
    };
    const cardStyle = useMemo<React.CSSProperties>(
      () => ({
        top: 0,
        left: 0,
        width,
        height,
        transform: `translate3d(${left}px, ${top}px, 0)`,
        willChange: "transform",
        zIndex: isMenuOpen ? 40 : isSelected ? 30 : undefined,
      }),
      [height, isMenuOpen, isSelected, left, top, width]
    );
    const contentHeight = height * 0.75;

    const isAudio = blob.type?.startsWith("audio/");
    const isActiveTrack = Boolean(currentTrackUrl && blob.url && currentTrackUrl === blob.url);
    const isActivePlaying = isActiveTrack && currentTrackStatus === "playing";
    const previewRequiresAuth = Boolean((blob.requiresAuth ?? requiresAuth) || blob.privateData?.encryption);
    const kind = decideFileKind(blob, detectedKind);
    const trackMetadata = audioMetadata.get(blob.sha256);
    const canPreview = canBlobPreview(blob, detectedKind, kind);
    const allowDialogPreview = kind === "pdf" || kind === "doc" || kind === "document";
    const coverUrl = kind === "music" ? trackMetadata?.coverUrl : undefined;
    const coverEntry = resolveCoverEntry(coverUrl);
    const previewUrl = canPreview ? buildPreviewUrl(blob, baseUrl) : null;
    const blurhash = extractBlurhash(blob);
    const isListBlob = isListLikeBlob(blob);
    const isPrivateList = isListBlob && blob.sha256 === PRIVATE_PLACEHOLDER_SHA;
    const isPrivateBlob = Boolean(blob.privateData);
    const isPrivateScope = blob.__bloomFolderScope === "private";
    const isPrivateItem = isPrivateList || isPrivateBlob || isPrivateScope;
    const playButtonLabel = isActivePlaying ? "Pause" : "Play";
    const playButtonAria = isActivePlaying ? "Pause audio" : "Play audio";
    const displayName = buildDisplayName(blob);
    const folderInfo = blob.__bloomFolderPlaceholder
      ? {
          scope: blob.__bloomFolderScope ?? "aggregated",
          path: blob.__bloomFolderTargetPath ?? "",
          serverUrl: blob.serverUrl ?? null,
          isParent: Boolean(blob.__bloomFolderIsParentLink),
        }
      : null;
    const isFolderParentLink = Boolean(folderInfo?.isParent);
    const normalizedFolderPath = folderInfo ? normalizeFolderPathInput(folderInfo.path ?? undefined) ?? "" : null;
    const folderRecord =
      normalizedFolderPath && folderRecords ? folderRecords.get(normalizedFolderPath) ?? null : null;
    const folderShareable =
      Boolean(
        folderInfo &&
          !folderInfo.isParent &&
          folderInfo.scope !== "private" &&
          normalizedFolderPath !== null &&
          folderRecord
      );
    const shareBusy = normalizedFolderPath ? folderShareBusyPath === normalizedFolderPath : false;
    const folderVisibility = folderRecord?.visibility ?? "private";
    const folderShareScope: ShareFolderScope = folderInfo?.scope === "server" ? "server" : "aggregated";
    const folderIsShared = Boolean(folderInfo && !folderInfo.isParent && folderRecord?.visibility === "public");
    const folderShareHint: FolderShareHint | null =
      folderShareable && normalizedFolderPath
        ? {
            path: normalizedFolderPath,
            scope: folderShareScope,
            serverUrl: folderInfo?.serverUrl ?? blob.serverUrl ?? null,
          }
        : null;

    const handleMenuToggle = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
      event => {
        event.stopPropagation();
        onToggleMenu(blob.sha256);
      },
      [blob.sha256, onToggleMenu]
    );

    const registerDropdownRef = useCallback(
      (node: HTMLDivElement | null) => {
        dropdownContainerRef.current = node;
        if (node) {
          dropdownRefs.current.set(blob.sha256, node);
        } else {
          dropdownRefs.current.delete(blob.sha256);
        }
      },
      [blob.sha256, dropdownRefs]
    );

    const dropdownItems = useMemo(() => {
      type DropdownItem = {
        key: string;
        label: string;
        icon: React.ReactNode;
        onSelect: () => void;
        ariaLabel?: string;
        variant?: "destructive";
        disabled?: boolean;
      };
      const items: DropdownItem[] = [];
      if (folderShareHint && onShareFolder) {
        if (folderVisibility === "public" && onUnshareFolder) {
          items.push({
            key: "unshare-folder",
            label: shareBusy ? "Unsharing…" : "Unshare Folder",
            icon: <LockIcon size={14} />, 
            ariaLabel: "Unshare folder",
            onSelect: () => {
              if (shareBusy) return;
              onUnshareFolder({ ...folderShareHint });
            },
            disabled: shareBusy,
          });
        } else {
          items.push({
            key: "share-folder",
            label: shareBusy ? "Sharing…" : "Share Folder",
            icon: <ShareIcon size={14} />, 
            ariaLabel: "Share folder",
            onSelect: () => {
              if (shareBusy) return;
              onShareFolder({ ...folderShareHint });
            },
            disabled: shareBusy,
          });
        }
      }
      if (blob.url && !isListBlob) {
        items.push({
          key: "download",
          label: "Download",
          icon: <DownloadIcon size={14} />,
          ariaLabel: isAudio ? "Download track" : "Download blob",
          onSelect: () => onDownload(blob),
        });
      }

      const canMove =
        Boolean(onMove) &&
        !isFolderParentLink &&
        !isPrivateList;

      if (canMove) {
        items.push({
          key: "move",
          label: "Move to…",
          icon: <TransferIcon size={14} />,
          ariaLabel: isListBlob ? "Move folder" : "Move file",
          onSelect: () => onMove?.(blob),
        });
      }

      if (onRename && !isPrivateList) {
        items.push({
          key: "rename",
          label: "Edit Details",
          icon: <EditIcon size={14} />,
          ariaLabel: isAudio ? "Edit track details" : "Edit file details",
          onSelect: () => onRename(blob),
        });
      }

      items.push({
        key: "delete",
        label: isListBlob ? "Delete Folder" : isAudio ? "Delete Track" : "Delete",
        icon: <TrashIcon size={14} />,
        ariaLabel: isListBlob
          ? "Delete folder"
          : isAudio
            ? "Delete track"
            : "Delete blob",
        onSelect: () => onDelete(blob),
        variant: "destructive",
      });

      return items;
    }, [
      blob,
      folderShareHint,
      onShareFolder,
      onUnshareFolder,
      shareBusy,
      folderVisibility,
      isAudio,
      isListBlob,
      isPrivateList,
      onDelete,
      onDownload,
      onRename,
      onMove,
      onShare,
      isPrivateItem,
      isFolderParentLink,
    ]);

    const handleMenuItemSelect = useCallback(
      (callback: () => void) => {
        callback();
        onCloseMenu();
      },
      [onCloseMenu]
    );

    const previewAllowed = showPreviews && canPreview && !(kind === "pdf" || kind === "doc" || kind === "document");
    const allowCoverArt = showPreviews && Boolean(coverUrl);

    const fallbackPreview = useMemo(() => {
      const backgroundClass =
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
                  : kind === "folder"
                    ? "from-amber-900/70 via-slate-900 to-slate-950"
                    : "from-slate-900 via-slate-900 to-slate-950";
      return (
        <div className={`flex h-full w-full items-center justify-center rounded-lg border border-slate-800 bg-gradient-to-br ${backgroundClass}`}>
          <FileTypeIcon
            kind={kind}
            size={Math.round(CARD_HEIGHT * 0.5)}
            className={kind === "folder" ? "text-amber-200" : "text-slate-200"}
            aria-hidden="true"
          />
        </div>
      );
    }, [kind]);

    const previewContent = useMemo(() => {
      if (allowCoverArt && coverUrl) {
        return (
          <AudioCoverImage
            url={coverUrl}
            alt={`${(trackMetadata?.title?.trim() || displayName)} cover art`}
            className="h-full w-full rounded-lg border border-slate-800 object-cover"
            fallback={fallbackPreview}
            requiresAuth={previewRequiresAuth}
            signTemplate={previewRequiresAuth ? signTemplate : undefined}
            serverType={blob.serverType ?? serverType}
            blob={blob}
            coverEntry={coverEntry}
          />
        );
      }
      if (previewAllowed && previewUrl) {
        return (
          <BlobPreview
            sha={blob.sha256}
            url={previewUrl}
            name={(blob.__bloomFolderPlaceholder || isListLikeBlob(blob) ? blob.name : getBlobMetadataName(blob)) ?? blob.sha256}
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
            blob={blob}
          />
        );
      }
      return fallbackPreview;
    }, [
      allowCoverArt,
      blob,
      baseUrl,
      blurhash,
      coverEntry,
      coverUrl,
      fallbackPreview,
      onBlobVisible,
      onDetect,
      previewAllowed,
      previewRequiresAuth,
      previewUrl,
      serverType,
      signTemplate,
      trackMetadata,
      displayName,
    ]);

    const shareTriggerRef = useRef<HTMLButtonElement | null>(null);
    const shareMenuRef = useRef<HTMLDivElement | null>(null);
    const [shareMenuOpen, setShareMenuOpen] = useState(false);
    const shareMenuDisabled = useMemo(
      () => Boolean(folderShareHint && onShareFolder) || !onShare || isPrivateItem || !blob.url,
      [folderShareHint, onShare, onShareFolder, isPrivateItem, blob.url]
    );

    useEffect(() => {
      setShareMenuOpen(false);
    }, [blob.sha256, folderShareHint, onShareFolder]);

    useEffect(() => {
      if (!shareMenuOpen) return;
      if (typeof document === "undefined") return;
      const handlePointer = (event: Event) => {
        const target = event.target as Node | null;
        if (!target) return;
        const trigger = shareTriggerRef.current;
        const menu = shareMenuRef.current;
        if (trigger?.contains(target) || menu?.contains(target)) {
          return;
        }
        setShareMenuOpen(false);
      };
      const handleKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setShareMenuOpen(false);
        }
      };
      document.addEventListener("pointerdown", handlePointer);
      document.addEventListener("keydown", handleKey);
      return () => {
        document.removeEventListener("pointerdown", handlePointer);
        document.removeEventListener("keydown", handleKey);
      };
    }, [shareMenuOpen]);

    useEffect(() => {
      if (shareMenuDisabled) {
        setShareMenuOpen(false);
      }
    }, [shareMenuDisabled]);

    const shareButton = (() => {
      if (folderShareHint && onShareFolder) {
        const disabled = shareBusy;
        const title = disabled
          ? "Sharing folder…"
          : folderVisibility === "public"
            ? "Show share link"
            : "Share folder";
        return (
          <button
            className={`${toolbarNeutralButtonClass} rounded-none border-l border-r-0 disabled:border-inherit disabled:bg-inherit disabled:text-inherit disabled:hover:bg-inherit`}
            onClick={event => {
              event.stopPropagation();
              if (disabled) return;
              onShareFolder({ ...folderShareHint });
            }}
            aria-label="Share folder"
            title={title}
            type="button"
            disabled={disabled}
          >
            <ShareIcon size={18} />
          </button>
        );
      }
      if (!onShare) return null;
      const disabled = isPrivateItem || !blob.url;
      const title = disabled
        ? isPrivateItem
          ? "Private files cannot be shared"
          : "Share available once file link is ready"
        : "Share";
      const ariaLabel = isAudio ? "Share track" : "Share blob";
      return (
        <div className="relative">
          <button
            ref={shareTriggerRef}
            className={`${toolbarNeutralButtonClass} rounded-none border-l border-r-0 disabled:border-inherit disabled:bg-inherit disabled:text-inherit disabled:hover:bg-inherit`}
            onClick={event => {
              event.stopPropagation();
              if (disabled) return;
              setShareMenuOpen(value => !value);
            }}
            aria-label={ariaLabel}
            title={title}
            type="button"
            disabled={disabled}
            aria-haspopup="true"
            aria-expanded={shareMenuOpen}
          >
            <ShareIcon size={18} />
          </button>
          {shareMenuOpen ? (
            <div
              ref={shareMenuRef}
              className={`${menuBaseClass} absolute right-0 top-full mt-2 origin-top visible opacity-100`}
              role="menu"
              aria-label="Share options"
            >
              <a
                href="#"
                role="menuitem"
                className={makeItemClass()}
                onClick={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  setShareMenuOpen(false);
                  onShare?.(blob);
                }}
              >
                <ShareIcon size={14} />
                <span>Share publicly</span>
              </a>
              <a
                href="#"
                role="menuitem"
                className={makeItemClass()}
                onClick={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  setShareMenuOpen(false);
                  onShare?.(blob, { mode: "private-link" });
                }}
              >
                <LockIcon size={14} />
                <span>Share privately</span>
              </a>
            </div>
          ) : null}
        </div>
      );
    })();

    const primaryAction = useMemo(() => {
      if (isListBlob && onOpenList) {
        return (
          <button
            className={`${toolbarPrimaryButtonClass} justify-center rounded-none rounded-bl-xl border-r-0`}
            onClick={event => {
              event.stopPropagation();
              onOpenList(blob);
            }}
            aria-label="Open list"
            title="Open"
            type="button"
          >
            <PreviewIcon size={18} />
          </button>
        );
      }
      if (isAudio && onPlay && blob.url) {
        const playingToolbarClass = `${toolbarBaseClass} ${
          isLightTheme
            ? "border border-slate-400 bg-slate-200 text-slate-900 shadow-sm hover:bg-slate-300"
            : "border border-slate-600 bg-slate-700 text-slate-100 shadow-sm hover:bg-slate-600"
        }`;
        const idleToolbarClass = toolbarPrimaryButtonClass;
        return (
          <button
            className={`${isActivePlaying ? `${playingToolbarClass} border-r-0` : `${idleToolbarClass} border-r-0`} justify-center rounded-none rounded-bl-xl`}
            onClick={event => {
              event.stopPropagation();
              onPlay(blob);
            }}
            aria-label={playButtonAria}
            aria-pressed={isActivePlaying}
            title={playButtonLabel}
            type="button"
          >
            {isActivePlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </button>
        );
      }
      const buttonDisabled = !canPreview && !allowDialogPreview;
      return (
        <button
          className={`${toolbarPrimaryButtonClass} justify-center rounded-none rounded-bl-xl border-r-0`}
          onClick={event => {
            event.stopPropagation();
            onPreview(blob);
          }}
          aria-label={buttonDisabled ? "Preview unavailable" : "Preview blob"}
          title={buttonDisabled ? "Preview unavailable" : "Preview"}
          type="button"
          disabled={buttonDisabled}
        >
          <PreviewIcon size={18} />
        </button>
      );
    }, [
      allowDialogPreview,
      blob,
      canPreview,
      isActivePlaying,
      isAudio,
      isListBlob,
      onOpenList,
      onPlay,
      onPreview,
      playButtonAria,
      playButtonLabel,
      toolbarBaseClass,
      toolbarPrimaryButtonClass,
      isLightTheme,
    ]);

    const toolbarContainerClass = isLightTheme
      ? "grid grid-cols-3 border-t border-slate-200 bg-slate-50/90 backdrop-blur px-0 py-0"
      : "grid grid-cols-3 border-t border-slate-800/70 bg-slate-950/85 backdrop-blur px-0 py-0";

    const menuPlacementClass =
      menuPlacement === "up"
        ? "bottom-full mb-2 origin-bottom"
        : "top-full mt-2 origin-top";
    const menuVisibilityClass = menuPlacement ? "visible opacity-100" : "invisible opacity-0 pointer-events-none";

    return (
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
        className={`absolute flex flex-col overflow-visible rounded-xl border box-border focus:outline-none focus:ring-2 focus:ring-emerald-500/70 focus:ring-offset-2 focus:ring-offset-slate-900 cursor-pointer transition ${
          isSelected ? "border-emerald-500 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60"
        }`}
        style={cardStyle}
      >
        <div className="relative flex-1 overflow-hidden" style={{ height: contentHeight }}>
          {replicaSummary && replicaSummary.count > 1 ? (
            <div className="pointer-events-none absolute right-2 top-2 z-20">
              <ReplicaBadge info={replicaSummary} variant="grid" />
            </div>
          ) : null}
          {previewContent}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-2">
            <div className="w-full rounded-md bg-slate-950/75 px-2 py-1 text-xs font-medium text-white text-center" title={displayName}>
                <span className="flex max-w-full items-center justify-center gap-1">
                  <span className="truncate">{displayName}</span>
                  {folderIsShared ? <ShareIcon size={12} className="text-white" aria-hidden="true" /> : null}
                  {isPrivateItem ? <LockIcon size={12} className="text-amber-300" aria-hidden="true" /> : null}
                </span>
            </div>
          </div>
        </div>
        <div className={toolbarContainerClass}>
          {primaryAction}
          {shareButton ?? <div className="h-11 w-full" />}
          {dropdownItems.length > 0 ? (
            <div className="relative h-full w-full" ref={registerDropdownRef}>
              <button
                className={`${dropdownTriggerClass} h-full w-full rounded-none rounded-br-xl border-l`}
                onClick={handleMenuToggle}
                aria-haspopup="true"
                aria-expanded={isMenuOpen}
                title="More actions"
                type="button"
                aria-label="More actions"
              >
                <ChevronDownIcon size={18} />
              </button>
              {isMenuOpen ? (
                <div
                  ref={menuRef}
                  className={`${menuBaseClass} ${menuPlacementClass} ${menuVisibilityClass}`}
                  role="menu"
                  aria-label="More actions"
                >
                  {dropdownItems.map(item => (
                    <a
                      key={item.key}
                      href="#"
                      role="menuitem"
                      aria-label={item.ariaLabel ?? item.label}
                      className={makeItemClass(item.variant, item.disabled)}
                      aria-disabled={item.disabled || undefined}
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (item.disabled) return;
                        handleMenuItemSelect(item.onSelect);
                      }}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);

GridCard.displayName = "GridCard";

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
  const updatedLabel = typeof blob.uploaded === "number" ? prettyDate(blob.uploaded) : null;
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

  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";
  const containerBaseClass = "relative flex h-full w-full flex-1 flex-col";
  const containerClass = isLightTheme
    ? `${containerBaseClass} bg-white text-slate-700`
    : `${containerBaseClass} bg-slate-900 text-slate-100`;
  const headingClass = isLightTheme ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-slate-100";
  const metaContainerClass = isLightTheme
    ? "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"
    : "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400";
  const contentAreaClass = "flex min-h-0 flex-1 flex-col gap-4 pt-4";
  const metaLabelClass = isLightTheme ? "text-slate-500" : "text-slate-300";
  const previewContainerClass = isLightTheme
    ? "relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white"
    : "relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-900/90";
  const fallbackMessageClass = isLightTheme
    ? "flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-sm text-slate-500"
    : "flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-sm text-slate-400";
  const closeButtonClass = isLightTheme
    ? "absolute right-4 top-4 rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-white"
    : "absolute right-4 top-4 rounded-full p-2 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900";
  const footerContainerClass = isLightTheme
    ? "flex flex-wrap gap-4 border-t border-slate-200 px-6 pt-4 text-[11px] text-slate-500"
    : "flex flex-wrap gap-4 border-t border-slate-800/80 px-6 pt-4 text-[11px] text-slate-400";
  const hashLabelClass = isLightTheme ? "font-mono break-all text-slate-600" : "font-mono break-all text-slate-400";
  const directUrlLabelClass = isLightTheme ? "text-slate-600" : "text-slate-300";
  const copyButtonClass = isLightTheme
    ? "flex max-w-full items-center gap-1 rounded px-1 text-left text-[11px] text-emerald-600 underline decoration-dotted underline-offset-2 hover:text-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-white"
    : "flex max-w-full items-center gap-1 rounded px-1 text-left text-[11px] text-emerald-300 underline decoration-dotted underline-offset-2 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900";

  return (
    <section className="flex h-full w-full flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        <div
          role="region"
          aria-label={`Preview ${displayName}`}
          className={containerClass}
        >
          <button
            type="button"
            className={closeButtonClass}
            onClick={onClose}
            aria-label="Close preview"
          >
            <CancelIcon size={18} />
          </button>
          <div className="px-6 pt-6">
            <h2 className={headingClass}>{displayName}</h2>
            <div className={metaContainerClass}>
              {sizeLabel && (
                <span>
                  <span className={metaLabelClass}>Size:</span> {sizeLabel}
                </span>
              )}
              {updatedLabel && (
                <span>
                  <span className={metaLabelClass}>Updated:</span> {updatedLabel}
                </span>
              )}
              <span>
                <span className={metaLabelClass}>Type:</span> {typeLabel}
              </span>
              {originLabel && (
                <span className="truncate">
                  <span className={metaLabelClass}>Server:</span> {originLabel}
                </span>
              )}
            </div>
          </div>
          <div className={contentAreaClass}>
            <div className={previewContainerClass}>
              {previewUnavailable ? (
                <div className={fallbackMessageClass}>
                  <FileTypeIcon
                    kind={derivedKind}
                    size={112}
                    className={isLightTheme ? "text-slate-400" : "text-slate-500"}
                  />
                  <p className="max-w-sm text-center">Preview not available for this file type.</p>
                </div>
              ) : (
                <BlobPreview
                  sha={blob.sha256}
                  url={previewUrl}
                  name={(blob.__bloomFolderPlaceholder || isListLikeBlob(blob) ? blob.name : getBlobMetadataName(blob)) ?? blob.sha256}
                  type={blob.type}
                  serverUrl={target.baseUrl ?? blob.serverUrl}
                  requiresAuth={requiresAuth}
                  signTemplate={requiresAuth ? signTemplate : undefined}
                  serverType={serverType}
                  onDetect={onDetect}
                  fallbackIconSize={160}
                  className="h-full w-full"
                  variant="dialog"
                  onVisible={onBlobVisible}
                  blurhash={blurhash}
                  blob={blob}
                />
              )}
            </div>
            <div className={footerContainerClass}>
              <span className={hashLabelClass}>Hash: {blob.sha256}</span>
              {blob.url && (
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleDirectUrlCopy();
                  }}
                  className={copyButtonClass}
                  title="Copy direct URL"
                  aria-label="Copy direct URL"
                >
                  <span className={directUrlLabelClass}>Direct URL:</span>
                  <span className="truncate font-mono">{blob.url}</span>
                  <span className="mt-[1px] text-current"><CopyIcon size={12} /></span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
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
  canPreview?: boolean;
  previewUrl?: string | null;
  coverEntry?: PrivateListEntry | null;
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
  canPreview = false,
  previewUrl,
  coverEntry,
}) => {
  const containerClass =
    "flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80 relative";
  const blurhash = extractBlurhash(blob);
  const effectiveServerType = blob.serverType ?? serverType;
  const coverEncryption = coverEntry?.encryption;
  const effectiveRequiresAuth = Boolean((blob.requiresAuth ?? requiresAuth) || coverEncryption);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updatePixelRatio = () => {
      setDevicePixelRatio(window.devicePixelRatio || 1);
    };
    updatePixelRatio();
    window.addEventListener("resize", updatePixelRatio);
    return () => window.removeEventListener("resize", updatePixelRatio);
  }, []);

  const THUMBNAIL_BASE_PX = 48;
  const effectivePixelSize = THUMBNAIL_BASE_PX * devicePixelRatio;
  const shouldLoadCompactCover = effectivePixelSize >= 136;
  const previewName =
    blob.__bloomFolderPlaceholder || isListLikeBlob(blob)
      ? blob.name ?? blob.sha256
      : getBlobMetadataName(blob) ?? blob.sha256;

  if (kind === "music") {
    const fallbackContent = (
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-900/70 via-slate-900 to-slate-950">
        <MusicIcon size={18} className="text-emerald-200" aria-hidden="true" />
      </div>
    );
    if (showPreview && coverUrl && shouldLoadCompactCover) {
      return (
        <div className={containerClass}>
          <AudioCoverImage
            url={coverUrl}
            alt={`${previewName} cover art`}
            className="h-full w-full object-cover"
            fallback={fallbackContent}
            requiresAuth={effectiveRequiresAuth}
            signTemplate={effectiveRequiresAuth ? signTemplate : undefined}
            serverType={effectiveServerType}
            blob={blob}
            coverEntry={coverEntry}
            targetSize={Math.max(64, Math.min(256, Math.round(effectivePixelSize * 1.25)))}
          />
        </div>
      );
    }
    if (showPreview && blurhash) {
      return (
        <div className={containerClass}>
          <BlurhashThumbnail
            hash={blurhash.hash}
            width={blurhash.width}
            height={blurhash.height}
            alt={`${previewName} preview`}
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

  if (showPreview && canPreview && previewUrl) {
    return (
      <div className={containerClass}>
        <BlobPreview
          sha={blob.sha256}
          url={previewUrl}
          name={previewName}
          type={blob.type}
          serverUrl={blob.serverUrl ?? baseUrl}
          requiresAuth={effectiveRequiresAuth}
          signTemplate={effectiveRequiresAuth ? signTemplate : undefined}
          serverType={blob.serverType ?? serverType}
          onDetect={onDetect ?? (() => undefined)}
          fallbackIconSize={40}
          className="h-full w-full rounded-none border-0 bg-transparent"
          onVisible={onVisible}
          blurhash={blurhash}
          blob={blob}
        />
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

  if (kind === "folder") {
    return (
      <div
        className={`${containerClass} items-center justify-center bg-gradient-to-br from-amber-900/70 via-slate-900 to-slate-950`}
      >
        <FileTypeIcon kind="folder" size={18} className="text-amber-200" aria-hidden="true" />
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

  return (
    <div className={containerClass}>
      <FileTypeIcon kind={kind} size={40} className="text-slate-300" />
    </div>
  );
};

type ListRowProps = {
  top: number;
  left: number;
  width: number;
  height: number;
  blob: BlossomBlob;
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  isSelected: boolean;
  onToggle: (sha: string) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onPreview: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  onShare?: (blob: BlossomBlob, options?: { mode?: ShareMode }) => void;
  onRename?: (blob: BlossomBlob) => void;
  onMove?: (blob: BlossomBlob) => void;
  onOpenList?: (blob: BlossomBlob) => void;
  folderRecords?: Map<string, FolderListRecord>;
  onShareFolder?: (hint: FolderShareHint) => void;
  onUnshareFolder?: (hint: FolderShareHint) => void;
  folderShareBusyPath?: string | null;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  detectedKind?: "image" | "video";
  onDetect: (sha: string, kind: "image" | "video") => void;
  onBlobVisible: (sha: string) => void;
  replicaSummary?: BlobReplicaSummary;
  isMusicListView: boolean;
  trackMetadata: BlobAudioMetadata | null;
  onActionsWidthChange: (width: number | null) => void;
  showPreviews: boolean;
  isPrivateBlob?: boolean;
  coverEntry?: PrivateListEntry | null;
  getMenuBoundary?: () => HTMLElement | null;
  isCompactList: boolean;
  actionsColumnWidth: number | null;
};

const ListRowComponent: React.FC<ListRowProps> = ({
  top,
  left,
  width,
  height,
  blob,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType,
  isSelected,
  onToggle,
  onDelete,
  onDownload,
  onPreview,
  onPlay,
  onShare,
  onRename,
  onMove,
  onOpenList,
  folderRecords,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath,
  currentTrackUrl,
  currentTrackStatus,
  detectedKind,
  onDetect,
  onBlobVisible,
  replicaSummary,
  isMusicListView,
  trackMetadata: trackMetadataProp,
  onActionsWidthChange,
  showPreviews,
  isPrivateBlob,
  coverEntry,
  getMenuBoundary,
  isCompactList,
  actionsColumnWidth,
}) => {
  const rowStyle = useMemo<React.CSSProperties>(
    () => ({ position: "absolute", top, left, width, height }),
    [top, left, width, height]
  );
  const footerHeight = height * 0.25;
  const kind = decideFileKind(blob, detectedKind);
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
  const playPauseIcon = isActivePlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />;
  const displayName = buildDisplayName(blob);
  const folderInfo = blob.__bloomFolderPlaceholder
    ? {
        scope: blob.__bloomFolderScope ?? "aggregated",
        path: blob.__bloomFolderTargetPath ?? "",
        serverUrl: blob.serverUrl ?? null,
        isParent: Boolean(blob.__bloomFolderIsParentLink),
      }
    : null;
  const normalizedFolderPath = folderInfo ? normalizeFolderPathInput(folderInfo.path ?? undefined) ?? "" : null;
  const folderRecord =
    normalizedFolderPath && folderRecords ? folderRecords.get(normalizedFolderPath) ?? null : null;
  const folderShareable =
    Boolean(
      folderInfo &&
        !folderInfo.isParent &&
        folderInfo.scope !== "private" &&
        normalizedFolderPath !== null &&
        folderRecord
    );
  const shareBusy = normalizedFolderPath ? folderShareBusyPath === normalizedFolderPath : false;
  const folderVisibility = folderRecord?.visibility ?? "private";
  const folderShareScope: ShareFolderScope = folderInfo?.scope === "server" ? "server" : "aggregated";
  const folderIsShared = Boolean(folderInfo && !folderInfo.isParent && folderRecord?.visibility === "public");
  const folderShareHint: FolderShareHint | null =
    folderShareable && normalizedFolderPath
      ? {
          path: normalizedFolderPath,
          scope: folderShareScope,
          serverUrl: folderInfo?.serverUrl ?? blob.serverUrl ?? null,
        }
      : null;
  const trackMetadata = trackMetadataProp ?? undefined;
  const canPreview = canBlobPreview(blob, detectedKind, kind);
  const allowDialogPreview = kind === "pdf" || kind === "doc" || kind === "document";
  const previewUrl = canPreview ? buildPreviewUrl(blob, baseUrl) : null;
  const disablePreview = !canPreview && !allowDialogPreview;
  const isListBlob = isListLikeBlob(blob);
  const isPrivateListEntry = isListBlob && blob.sha256 === PRIVATE_PLACEHOLDER_SHA;
  const isPrivateScope = blob.__bloomFolderScope === "private";
  const isPrivateItem = isPrivateListEntry || isPrivateBlob || isPrivateScope;
  const handleOpenList = useCallback(() => {
    if (onOpenList) onOpenList(blob);
  }, [blob, onOpenList]);
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
  const coverUrl = kind === "music" ? trackMetadata?.coverUrl : undefined;
  const resolvedCoverEntry = coverEntry ?? null;
  const allowThumbnailPreview =
    showPreviews && !allowDialogPreview && (canPreview || (kind === "music" && Boolean(coverUrl)));
  const actionsStyle =
    !isCompactList && actionsColumnWidth
      ? { width: actionsColumnWidth, minHeight: footerHeight }
      : { minHeight: footerHeight };

  const updatedLabel = blob.uploaded ? prettyDate(blob.uploaded) : "—";
  const sizeLabel = isListBlob ? "—" : prettyBytes(blob.size || 0);
  const replicaLabel =
    replicaSummary && replicaSummary.count > 0
      ? `${replicaSummary.count} server${replicaSummary.count === 1 ? "" : "s"}`
      : null;

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
        coverUrl={coverUrl}
        showPreview={allowThumbnailPreview}
        canPreview={canPreview}
        previewUrl={previewUrl}
        coverEntry={resolvedCoverEntry}
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
    if (!element || isCompactList) {
      onActionsWidthChange(null);
      return;
    }

    const notify = () => {
      if (isCompactList) {
        onActionsWidthChange(null);
        return;
      }
      const width = element.offsetWidth;
      onActionsWidthChange(Number.isFinite(width) && width > 0 ? width : null);
    };

    notify();

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => notify())
        : null;

    resizeObserver?.observe(element);

    if (typeof window !== "undefined") {
      const handleResize = () => notify();
      window.addEventListener("resize", handleResize);
      return () => {
        resizeObserver?.disconnect();
        window.removeEventListener("resize", handleResize);
      };
    }

    return () => {
      resizeObserver?.disconnect();
    };
  }, [onActionsWidthChange, menuOpen, isCompactList]);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBoundary = getMenuBoundary?.() ?? null;
  const menuPlacement = useDropdownPlacement(menuOpen, dropdownRef, menuRef, menuBoundary);

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

  const shareTriggerRef = useRef<HTMLButtonElement | null>(null);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);

  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";
  const dropdownTriggerClass = isLightTheme
    ? "p-2 shrink-0 flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-100"
    : "p-2 shrink-0 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-slate-200 transition hover:bg-slate-700";
  const menuBaseClass = isLightTheme
    ? "absolute right-0 z-30 w-44 rounded-md border border-slate-300 bg-white p-1 text-slate-700 shadow-xl"
    : "absolute right-0 z-30 w-44 rounded-md border border-slate-700 bg-slate-900/95 p-1 text-slate-200 shadow-xl backdrop-blur";
  const focusRingClass = isLightTheme
    ? "focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-white"
    : "focus:outline-none focus:ring-1 focus:ring-emerald-400 focus:ring-offset-1 focus:ring-offset-slate-900";
  const makeItemClass = (variant?: "destructive", disabled?: boolean) => {
    const base = `flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition ${focusRingClass}`;
    const variantClass =
      variant === "destructive"
        ? isLightTheme
          ? "text-red-600 hover:bg-red-50"
          : "text-red-300 hover:bg-red-900/40"
        : isLightTheme
          ? "text-slate-700 hover:bg-slate-100"
          : "text-slate-200 hover:bg-slate-700";
    const disabledClass = disabled ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "";
    return `${base} ${variantClass} ${disabledClass}`.trim();
  };

  useEffect(() => {
    if (!shareMenuOpen) return;
    if (typeof document === "undefined") return;
    const handlePointer = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (shareTriggerRef.current?.contains(target) || shareMenuRef.current?.contains(target)) {
        return;
      }
      setShareMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShareMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [shareMenuOpen]);

  useEffect(() => {
    setShareMenuOpen(false);
  }, [blob.sha256, folderShareHint, onShareFolder]);

  const shareMenuDisabled = useMemo(
    () => Boolean(folderShareHint && onShareFolder) || !onShare || isPrivateItem || !blob.url,
    [folderShareHint, onShare, onShareFolder, isPrivateItem, blob.url]
  );

  useEffect(() => {
    if (shareMenuDisabled) {
      setShareMenuOpen(false);
    }
  }, [shareMenuDisabled]);

  const shareButton = (() => {
    if (folderShareHint && onShareFolder) {
      const disabled = shareBusy;
      const title = disabled
        ? "Sharing folder…"
        : folderVisibility === "public"
          ? "Show share link"
          : "Share folder";
      return (
        <button
          className="p-2 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-800"
          onClick={event => {
            event.stopPropagation();
            if (disabled) return;
            onShareFolder(folderShareHint);
          }}
          aria-label="Share folder"
          title={title}
          type="button"
          disabled={disabled}
        >
          <ShareIcon size={16} />
        </button>
      );
    }
    if (!onShare) return null;
    const disabled = isPrivateItem || !blob.url;
    const ariaLabel = isMusicListView ? "Share track" : "Share blob";
    const title = disabled
      ? isPrivateItem
        ? "Private files cannot be shared"
        : "Share available once file link is ready"
      : "Share";
    return (
      <div className="relative">
        <button
          ref={shareTriggerRef}
          className="p-2 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-800"
          onClick={event => {
            event.stopPropagation();
            if (disabled) return;
            setShareMenuOpen(value => !value);
          }}
          aria-label={ariaLabel}
          title={title}
          type="button"
          disabled={disabled}
          aria-haspopup="true"
          aria-expanded={shareMenuOpen}
        >
          <ShareIcon size={16} />
        </button>
        {shareMenuOpen ? (
          <div
            ref={shareMenuRef}
            className={`${menuBaseClass} absolute right-0 top-full mt-2 origin-top visible opacity-100`}
            role="menu"
            aria-label="Share options"
          >
            <a
              href="#"
              role="menuitem"
              className={makeItemClass()}
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                setShareMenuOpen(false);
                onShare?.(blob);
              }}
            >
              <ShareIcon size={14} />
              <span>Share publicly</span>
            </a>
            <a
              href="#"
              role="menuitem"
              className={makeItemClass()}
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                setShareMenuOpen(false);
                onShare?.(blob, { mode: "private-link" });
              }}
            >
              <LockIcon size={14} />
              <span>Share privately</span>
            </a>
          </div>
        ) : null}
      </div>
    );
  })();

  type DropdownItem = {
    key: string;
    label: string;
    icon: React.ReactNode;
    onSelect: () => void;
    ariaLabel?: string;
    variant?: "destructive";
    disabled?: boolean;
  };

  const dropdownItems: DropdownItem[] = [];

  if (folderShareHint && onShareFolder) {
    if (folderVisibility === "public" && onUnshareFolder) {
      dropdownItems.push({
        key: "unshare-folder",
        label: shareBusy ? "Unsharing…" : "Unshare Folder",
        icon: <LockIcon size={14} />,
        ariaLabel: "Unshare folder",
        onSelect: () => {
          if (shareBusy) return;
          onUnshareFolder({ ...folderShareHint });
        },
        disabled: shareBusy,
      });
    } else {
      dropdownItems.push({
        key: "share-folder",
        label: shareBusy ? "Sharing…" : "Share Folder",
        icon: <ShareIcon size={14} />,
        ariaLabel: "Share folder",
        onSelect: () => {
          if (shareBusy) return;
          onShareFolder({ ...folderShareHint });
        },
        disabled: shareBusy,
      });
    }
  }

  if (!isListBlob && blob.url) {
    dropdownItems.push({
      key: "download",
      label: "Download",
      icon: <DownloadIcon size={14} />,
      ariaLabel: isMusicListView ? "Download track" : "Download blob",
      onSelect: () => onDownload(blob),
    });
  }

  const canMove =
    Boolean(onMove) &&
    !(folderInfo?.isParent) &&
    !isPrivateListEntry;

  if (canMove) {
    dropdownItems.push({
      key: "move",
      label: "Move to…",
      icon: <TransferIcon size={14} />,
      ariaLabel: isListBlob ? "Move folder" : "Move file",
      onSelect: () => onMove?.(blob),
    });
  }

  if (onRename && !isPrivateListEntry) {
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
    label: isListBlob ? "Delete Folder" : isMusicListView ? "Delete track" : "Delete",
    icon: <TrashIcon size={14} />,
    ariaLabel: isListBlob ? "Delete folder" : isMusicListView ? "Delete track" : "Delete blob",
    onSelect: () => onDelete(blob),
    variant: "destructive",
  });

  const showDropdown = dropdownItems.length > 0;

  const handleMenuToggle: React.MouseEventHandler<HTMLButtonElement> = event => {
    event.stopPropagation();
    setMenuOpen(value => !value);
  };

  const menuPlacementClass =
    menuPlacement === "up"
      ? "bottom-full mb-2 origin-bottom"
      : "top-full mt-2 origin-top";
  const menuVisibilityClass = menuPlacement ? "visible opacity-100" : "invisible opacity-0 pointer-events-none";

  const dropdownMenu = !showDropdown
    ? null
    : (
        <div className="relative" ref={dropdownRef}>
          <button
            className={dropdownTriggerClass}
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
              ref={menuRef}
              className={`${menuBaseClass} ${menuPlacementClass} ${menuVisibilityClass}`}
              role="menu"
              aria-label="More actions"
            >
              {dropdownItems.map(item => (
                <a
                  key={item.key}
                  href="#"
                  role="menuitem"
                  aria-label={item.ariaLabel ?? item.label}
                  className={makeItemClass(item.variant, item.disabled)}
                  aria-disabled={item.disabled || undefined}
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (item.disabled) return;
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

  const showButtonClass = `${primaryActionBaseClass} ${
    isLightTheme ? "bg-blue-700 text-white hover:bg-blue-600" : "bg-emerald-700/70 text-slate-100 hover:bg-emerald-600"
  }`;

  const primaryAction = isListBlob && onOpenList ? (
    <button
      className={showButtonClass}
      onClick={event => {
        event.stopPropagation();
        handleOpenList();
      }}
      aria-label="Open list"
      title="Open"
      type="button"
    >
      <PreviewIcon size={16} />
    </button>
  ) : isAudio && onPlay && blob.url ? (
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
          if (isListBlob && onOpenList) {
            handleOpenList();
            return;
          }
          onPreview(blob);
        }}
        aria-label={isListBlob ? "Open list" : disablePreview ? "Preview unavailable" : "Show blob"}
        title={isListBlob ? "Open" : disablePreview ? "Preview unavailable" : "Show"}
        type="button"
      >
        <PreviewIcon size={16} />
      </button>
    ) : null;

  const handleRowClick: React.MouseEventHandler<HTMLDivElement> = event => {
    if (!isListBlob || !onOpenList) return;
    if (event.target instanceof HTMLElement && event.target.closest("button, input, a")) {
      return;
    }
    event.stopPropagation();
    handleOpenList();
  };

  if (isMusicListView) {
    return (
      <div
        style={rowStyle}
        className={`absolute left-0 right-0 grid grid-cols-[60px,minmax(0,1fr)] md:grid-cols-[60px,minmax(0,1fr),10rem,12rem,6rem,max-content] items-center gap-2 border-b border-slate-800 px-2 transition-colors ring-1 ring-transparent ${rowHighlightClass}`}
        role="row"
        aria-current={isActiveTrack ? "true" : undefined}
        onClick={handleRowClick}
      >
        <div className="flex h-full items-center justify-center">
          {thumbnail}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 truncate font-medium text-slate-100" title={displayName}>
            <span className="truncate">{trackTitle}</span>
            {folderIsShared ? <ShareIcon size={14} className="shrink-0" aria-hidden="true" /> : null}
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
          style={actionsStyle}
        >
          {primaryAction}
          {shareButton}
          {dropdownMenu}
        </div>
      </div>
    );
  }

  const metadataInline = (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
      <span>{sizeLabel}</span>
      {updatedLabel !== "—" ? <span>{updatedLabel}</span> : null}
      {replicaLabel ? <span>{replicaLabel}</span> : null}
    </div>
  );

  const hasActions = Boolean(primaryAction || shareButton || dropdownMenu);

  if (isCompactList) {
    return (
      <div
        style={rowStyle}
        className={`absolute left-0 right-0 flex flex-col gap-3 border-b border-slate-800 px-3 py-3 transition-colors ring-1 ring-transparent ${rowHighlightClass}`}
        role="row"
        aria-current={isActiveTrack ? "true" : undefined}
        onClick={handleRowClick}
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            checked={isSelected}
            onChange={() => onToggle(blob.sha256)}
            aria-label={`Select ${displayName}`}
            onClick={event => event.stopPropagation()}
          />
          <div className="flex min-w-0 flex-1 gap-3">
            <div className="flex-shrink-0">{thumbnail}</div>
            <div className="min-w-0" title={displayName}>
              <div className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-slate-100">
                <span className="truncate">{displayName}</span>
                {folderIsShared ? <ShareIcon size={14} className="text-slate-100" aria-hidden="true" /> : null}
                {isPrivateItem ? <LockIcon size={14} className="text-amber-300" aria-hidden="true" /> : null}
              </div>
              {metadataInline}
            </div>
          </div>
        </div>
        {hasActions ? (
          <div className="flex flex-wrap items-center gap-2">
            {primaryAction}
            {shareButton}
            {dropdownMenu}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      style={rowStyle}
      className={`absolute left-0 right-0 flex h-full flex-col gap-3 border-b border-slate-800 px-3 py-3 transition-colors ring-1 ring-transparent md:flex-row md:items-center md:gap-2 md:px-2 md:py-0 ${rowHighlightClass}`}
      role="row"
      aria-current={isActiveTrack ? "true" : undefined}
      onClick={handleRowClick}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 md:items-center">
        <div className="flex items-center pt-1 md:pt-0">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            checked={isSelected}
            onChange={() => onToggle(blob.sha256)}
            aria-label={`Select ${displayName}`}
            onClick={event => event.stopPropagation()}
          />
        </div>
        {thumbnail}
        <div className="min-w-0" title={displayName}>
          <div className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-slate-100">
            <span className="truncate">{displayName}</span>
            {isPrivateItem ? (
              <LockIcon size={14} className="text-amber-300 flex-shrink-0" aria-hidden="true" />
            ) : null}
          </div>
          <div className="md:hidden">{metadataInline}</div>
        </div>
      </div>
      <div className="hidden w-20 shrink-0 items-center justify-center text-sm text-slate-200 md:flex">
        {(() => {
          if (isListBlob) return "—";
          if (replicaSummary && replicaSummary.count > 0) {
            return <ReplicaBadge info={replicaSummary} variant="list" />;
          }
          return "—";
        })()}
      </div>
      <div className="hidden w-40 shrink-0 px-3 text-xs text-slate-400 md:block" title={updatedLabel !== "—" ? updatedLabel : undefined}>
        {updatedLabel}
      </div>
      <div className="hidden w-24 shrink-0 px-3 text-sm text-slate-400 md:block">{sizeLabel}</div>
      <div
        ref={actionsContainerRef}
        className="flex w-full shrink-0 flex-wrap items-center justify-start gap-2 px-1 md:w-auto md:flex-nowrap md:justify-end md:px-2"
        style={actionsStyle}
      >
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
  blob?: BlossomBlob;
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
  blob,
}) => {
  const privateMeta = blob?.privateData?.metadata;
  const privateEncryption = blob?.privateData?.encryption;
  const isPrivate = Boolean(privateEncryption);
  const effectiveName = privateMeta?.name ?? name;
  const effectiveType = privateMeta?.type ?? type;
  const previewKey = `${serverType}|${sha}|${requiresAuth ? "auth" : "anon"}|${url}|${isPrivate ? "private" : "public"}`;
  const initialCachedSrc = getCachedPreviewSrc(previewKey);

  const [src, setSrc] = useState<string | null>(initialCachedSrc);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewType, setPreviewType] = useState<"image" | "video" | "text" | "pdf" | "doc" | "unknown">(() => {
    if (isPreviewableTextType({ mime: effectiveType, name: effectiveName, url })) return "text";
    if (isPdfType(effectiveType, effectiveName || url)) return "pdf";
    if (isDocType(effectiveType, effectiveName || url)) return "doc";
    return inferKind(effectiveType, effectiveName || url) ?? "unknown";
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
    if (previewType === "image" || previewType === "video" || previewType === "pdf" || previewType === "doc") {
      return previewType;
    }
    if (isMusicType(effectiveType, effectiveName, url)) return "music";
    if (isSheetType(effectiveType, effectiveName || url)) return "sheet";
    if (isDocType(effectiveType, effectiveName || url)) return "doc";
    if (isPdfType(effectiveType, effectiveName || url)) return "pdf";
    if (isPreviewableTextType({ mime: effectiveType, name: effectiveName, url })) return "document";
    return "document";
  }, [previewType, effectiveType, effectiveName, url]);

  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

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

  const metaSuggestsText = useMemo(
    () => isPreviewableTextType({ mime: effectiveType, name: effectiveName, url }),
    [effectiveType, effectiveName, url]
  );

  useEffect(() => {
    return () => {
      releaseObjectUrl();
    };
  }, [releaseObjectUrl]);

  useEffect(() => {
    if (isPreviewableTextType({ mime: effectiveType, name: effectiveName, url })) {
      setPreviewType("text");
    } else if (isPdfType(effectiveType, effectiveName || url)) {
      setPreviewType("pdf");
    } else if (isDocType(effectiveType, effectiveName || url)) {
      setPreviewType("doc");
    } else {
      setPreviewType(inferKind(effectiveType, effectiveName || url) ?? "unknown");
    }
  }, [effectiveType, url, effectiveName]);

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
      const resolvedType = blobData.type || effectiveType || privateMeta?.type;
      if (resolvedType === "application/pdf" || isPdfType(resolvedType, effectiveName ?? url)) {
        setPreviewType(previous => (previous === "pdf" ? previous : "pdf"));
      } else if (isDocType(resolvedType, effectiveName ?? url)) {
        setPreviewType(previous => (previous === "doc" ? previous : "doc"));
      } else if (resolvedType?.startsWith("image/") && previewType !== "image") {
        setPreviewType("image");
      } else if (resolvedType?.startsWith("video/") && previewType !== "video") {
        setPreviewType("video");
      }
    };

    const showTextPreview = async (blobData: Blob, mimeHint?: string | null) => {
      const normalizedMime = mimeHint ?? blobData.type ?? effectiveType;
      const shouldRenderText =
        isPreviewableTextType({ mime: normalizedMime, name: effectiveName, url }) ||
        (!normalizedMime && isPreviewableTextType({ name: effectiveName, url })) ||
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
        if (previewType === "pdf" || previewType === "doc") {
          setLoading(false);
          finalizeRequest();
          return;
        }
        const allowPersistentCache = !isPrivate && !metaSuggestsText;
        const cachedBlob = allowPersistentCache ? await getCachedPreviewBlob(cacheServerHint, sha) : null;
        if (cancelled) return;
        if (cachedBlob) {
          assignObjectUrl(cachedBlob);
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (!isPrivate && previewType === "video" && url && !requiresAuth) {
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
          method: "GET",
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

        if (isPrivate && privateEncryption) {
          const encryptedBuffer = await response.arrayBuffer();
          if (cancelled) return;
          try {
            if (privateEncryption.algorithm !== "AES-GCM") {
              throw new Error(`Unsupported encryption algorithm: ${privateEncryption.algorithm}`);
            }
            const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
              algorithm: "AES-GCM",
              key: privateEncryption.key,
              iv: privateEncryption.iv,
              originalName: privateMeta?.name,
              originalType: privateMeta?.type,
              originalSize: privateMeta?.size,
            });
            const mimeType = effectiveType || mimeHint || "application/octet-stream";
            const decryptedBlob = new Blob([decryptedBuffer], { type: mimeType });
            if (await showTextPreview(decryptedBlob, mimeType)) {
              setLoading(false);
              finalizeRequest();
              return;
            }
            assignObjectUrl(decryptedBlob);
            const inferred =
              inferKind(effectiveType ?? mimeType, effectiveName ?? url) ??
              inferKind(mimeType, effectiveName ?? url);
            if (inferred && inferred !== previewType) {
              if (inferred === "image" || inferred === "video") {
                setPreviewType(inferred);
              }
            }
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
          return;
        }

        const blobData = await response.blob();
        if (cancelled) return;

        if (await showTextPreview(blobData, mimeHint)) {
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (!requiresAuth) {
          const resolvedMime = mimeHint ?? effectiveType;
          if (resolvedMime === "application/pdf" || isPdfType(resolvedMime, effectiveName ?? url)) {
            setPreviewType(previous => (previous === "pdf" ? previous : "pdf"));
          } else if (isDocType(resolvedMime, effectiveName ?? url)) {
            setPreviewType(previous => (previous === "doc" ? previous : "doc"));
          } else if (resolvedMime?.startsWith("image/") && previewType !== "image") {
            setPreviewType("image");
          } else if (resolvedMime?.startsWith("video/") && previewType !== "video") {
            setPreviewType("video");
          }
          assignObjectUrl(blobData);
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (allowPersistentCache && cacheServerHint) {
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
    effectiveType,
    effectiveName,
    url,
    variant,
    isPrivate,
    privateEncryption,
    previewType,
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

  useEffect(() => {
    if (previewType === "pdf" || previewType === "doc") {
      setIsReady(true);
      setLoading(false);
      setFailed(false);
    }
  }, [previewType]);

  const isPdf = previewType === "pdf";
  const isDoc = previewType === "doc";
  const isStaticPreview = isPdf || isDoc;
  const showMedia = !isStaticPreview && Boolean(src) && !failed && Boolean(url);
  const isVideo = showMedia && previewType === "video";
  const isImage = showMedia && previewType === "image";
  const showLoading = !isStaticPreview && loading && !showMedia && !textPreview;
  const showUnavailable = !isStaticPreview && (failed || (!showMedia && !textPreview && !loading));

  const baseBackgroundClass = isLightTheme ? "bg-white" : "bg-slate-950/80";
  const classNames = `relative flex h-full w-full items-center justify-center overflow-hidden ${baseBackgroundClass} ${
    className ?? ""
  }`;
  const textPreviewWrapperClass = isLightTheme ? "px-4 py-3 text-xs text-slate-700" : "px-4 py-3 text-xs text-slate-200";
  const textPreviewPreClass = isLightTheme
    ? "line-clamp-6 whitespace-pre-wrap break-words text-[11px] leading-snug text-slate-800"
    : "line-clamp-6 whitespace-pre-wrap break-words text-[11px] leading-snug";

  const blurhashPlaceholder = blurhash ? (
    <BlurhashThumbnail
      hash={blurhash.hash}
      width={blurhash.width}
      height={blurhash.height}
      alt={effectiveName}
    />
  ) : null;

  const docBackgroundClass = isLightTheme
    ? "border border-slate-200 bg-gradient-to-br from-purple-100 via-white to-slate-100"
    : "border border-slate-800/80 bg-gradient-to-br from-purple-900/70 via-slate-900 to-slate-950";
  const docIconClass = isLightTheme ? "text-purple-600" : "text-purple-200";
  const pdfBackgroundClass = isLightTheme
    ? "border border-slate-200 bg-gradient-to-br from-red-100 via-white to-slate-100"
    : "border border-slate-800/80 bg-gradient-to-br from-red-900/70 via-slate-900 to-slate-950";
  const pdfIconClass = isLightTheme ? "text-red-500" : "text-red-200";

  const content = textPreview ? (
    <div className={textPreviewWrapperClass}>
      <pre className={textPreviewPreClass}>
        {textPreview.content}
        {textPreview.truncated ? " …" : ""}
      </pre>
    </div>
  ) : isImage ? (
    <img
      src={src ?? undefined}
      alt={effectiveName}
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
  ) : isDoc ? (
    <div
      className={`flex h-full w-full items-center justify-center rounded-2xl ${docBackgroundClass} transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      } ${variant === "dialog" ? "mx-4 my-4" : ""}`}
    >
      <DocumentIcon
        size={fallbackIconSize ?? (variant === "dialog" ? 120 : 56)}
        className={docIconClass}
        aria-hidden="true"
      />
    </div>
  ) : isPdf ? (
    <div
      className={`flex h-full w-full items-center justify-center rounded-2xl ${pdfBackgroundClass} transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      } ${variant === "dialog" ? "mx-4 my-4" : ""}`}
    >
      <FileTypeIcon
        kind="pdf"
        size={fallbackIconSize ?? (variant === "dialog" ? 120 : 56)}
        className={pdfIconClass}
        aria-hidden="true"
      />
    </div>
  ) : null;

  const loadingOverlayClass = isLightTheme
    ? "absolute inset-0 flex items-center justify-center bg-white/80 text-xs text-slate-600 pointer-events-none"
    : "absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs text-slate-300 pointer-events-none";
  const overlayBorderClass = isLightTheme ? "border-slate-200" : "border-slate-800/80";

  const overlayConfig = useMemo(() => {
    const baseSize = fallbackIconSize ?? (variant === "dialog" ? 96 : 48);
    const gradient = (light: string, dark: string) => (isLightTheme ? light : dark);
    const iconColor = (light: string, dark: string) => (isLightTheme ? light : dark);
    switch (fallbackIconKind) {
      case "music":
        return {
          background: gradient(
            "bg-gradient-to-br from-emerald-100 via-white to-slate-100",
            "bg-gradient-to-br from-emerald-900/70 via-slate-900 to-slate-950"
          ),
          icon: <MusicIcon size={baseSize} className={iconColor("text-emerald-600", "text-emerald-200")} aria-hidden="true" />,
        };
      case "video":
        return {
          background: gradient(
            "bg-gradient-to-br from-sky-100 via-white to-slate-100",
            "bg-gradient-to-br from-sky-900/70 via-slate-900 to-slate-950"
          ),
          icon: <VideoIcon size={baseSize} className={iconColor("text-sky-600", "text-sky-200")} aria-hidden="true" />,
        };
      case "pdf":
        return {
          background: gradient(
            "bg-gradient-to-br from-red-100 via-white to-slate-100",
            "bg-gradient-to-br from-red-900/70 via-slate-900 to-slate-950"
          ),
          icon: <FileTypeIcon kind="pdf" size={baseSize} className={iconColor("text-red-500", "text-red-200")} aria-hidden="true" />,
        };
      case "folder":
        return {
          background: gradient(
            "bg-gradient-to-br from-amber-100 via-white to-slate-100",
            "bg-gradient-to-br from-amber-900/70 via-slate-900 to-slate-950"
          ),
          icon: <FileTypeIcon kind="folder" size={baseSize} className={iconColor("text-amber-600", "text-amber-200")} aria-hidden="true" />,
        };
      case "doc":
      case "document":
        return {
          background: gradient(
            "bg-gradient-to-br from-purple-100 via-white to-slate-100",
            "bg-gradient-to-br from-purple-900/70 via-slate-900 to-slate-950"
          ),
          icon: <DocumentIcon size={baseSize} className={iconColor("text-purple-600", "text-purple-200")} aria-hidden="true" />,
        };
      default:
        return {
          background: gradient("bg-slate-200", "bg-slate-950/70"),
          icon: (
            <FileTypeIcon
              kind={fallbackIconKind}
              size={baseSize}
              className={iconColor("text-slate-600", "text-slate-300")}
              aria-hidden="true"
            />
          ),
        };
    }
  }, [fallbackIconKind, fallbackIconSize, variant, isLightTheme]);

  const showBlurhashPlaceholder = Boolean(blurhashPlaceholder && !textPreview && !showMedia && !isStaticPreview);
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
      {showLoadingOverlay && <div className={loadingOverlayClass}>Loading preview…</div>}
      {showUnavailableOverlay && (
        <div
          className={`absolute inset-0 flex items-center justify-center rounded-2xl border ${overlayBorderClass} ${overlayConfig.background} ${
            variant === "dialog" ? "mx-4 my-4" : ""
          }`}
        >
          {overlayConfig.icon}
        </div>
      )}
    </div>
  );
};

const ListRow = React.memo(ListRowComponent, (prev, next) => {
  return (
    prev.blob === next.blob &&
    prev.top === next.top &&
    prev.left === next.left &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.isSelected === next.isSelected &&
    prev.baseUrl === next.baseUrl &&
    prev.requiresAuth === next.requiresAuth &&
    prev.signTemplate === next.signTemplate &&
    prev.serverType === next.serverType &&
    prev.currentTrackUrl === next.currentTrackUrl &&
    prev.currentTrackStatus === next.currentTrackStatus &&
    prev.detectedKind === next.detectedKind &&
    prev.replicaSummary === next.replicaSummary &&
    prev.isMusicListView === next.isMusicListView &&
    prev.trackMetadata === next.trackMetadata &&
    prev.showPreviews === next.showPreviews &&
    prev.isPrivateBlob === next.isPrivateBlob &&
    prev.coverEntry === next.coverEntry &&
    prev.isCompactList === next.isCompactList &&
    prev.actionsColumnWidth === next.actionsColumnWidth
  );
});


function buildPreviewUrl(blob: BlossomBlob, baseUrl?: string | null) {
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
  if (isListLikeBlob(blob)) return "folder";
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

const AudioCoverImage: React.FC<{
  url: string;
  alt: string;
  className?: string;
  fallback: React.ReactNode;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  blob?: BlossomBlob;
  coverEntry?: PrivateListEntry | null;
  targetSize?: number;
}> = ({
  url,
  alt,
  className,
  fallback,
  requiresAuth = false,
  signTemplate,
  serverType = "blossom",
  blob,
  coverEntry,
  targetSize,
}) => {
  const [failed, setFailed] = useState(false);
  const coverEncryption = coverEntry?.encryption;
  const coverMetadata = coverEntry?.metadata;
  const preferredSize = Math.max(64, Math.min(targetSize ?? 256, 384));
  const optimizedUrl = useMemo(() => {
    if (requiresAuth || coverEncryption) return url;
    try {
      const parsed = new URL(url);
      const candidates = [preferredSize, Math.min(preferredSize * 2, 512)];
      const primary = new URL(parsed.toString());
      primary.searchParams.set("w", String(candidates[0]));
      primary.searchParams.set("h", String(candidates[0]));
      primary.searchParams.set("fit", "cover");
      return primary.toString();
    } catch {
      return url;
    }
  }, [coverEncryption, preferredSize, requiresAuth, url]);
  const [src, setSrc] = useState<string | null>(requiresAuth || coverEncryption ? null : optimizedUrl);
  const [usedOptimized, setUsedOptimized] = useState(() => optimizedUrl !== url);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    if (!url) {
      setSrc(null);
      setFailed(true);
      return () => {
        controller.abort();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
      };
    }

    const isDataUrl = url.startsWith("data:");
    const needsFetch = (requiresAuth || Boolean(coverEncryption)) && !isDataUrl;
    if (!needsFetch) {
      setSrc(optimizedUrl);
      setUsedOptimized(optimizedUrl !== url);
      setFailed(false);
      return () => {
        controller.abort();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
      };
    }

    setFailed(false);
    setSrc(null);

    const loadCover = async () => {
      try {
        const headers: Record<string, string> = {};
        if (requiresAuth && signTemplate) {
          if (serverType === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url,
              method: "GET",
            });
          } else {
            let resource: URL | null = null;
            try {
              resource = new URL(url, window.location.href);
            } catch {
              resource = null;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: coverEntry?.sha256,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob?.serverUrl,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
              expiresInSeconds: 300,
            });
          }
        }

        const fetchTarget = optimizedUrl;
        const response = await fetch(fetchTarget, {
          headers,
          signal: controller.signal,
          mode: "cors",
        });
        if (!response.ok) {
          throw new Error(`Cover fetch failed (${response.status})`);
        }

        let imageBlob: Blob;
        if (coverEncryption) {
          try {
            if (coverEncryption.algorithm !== "AES-GCM") {
              throw new Error(`Unsupported encryption algorithm: ${coverEncryption.algorithm}`);
            }
            const encryptedBuffer = await response.arrayBuffer();
            const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
              algorithm: "AES-GCM",
              key: coverEncryption.key,
              iv: coverEncryption.iv,
              originalName: coverMetadata?.name,
              originalType: coverMetadata?.type,
              originalSize: coverMetadata?.size,
            });
            const mimeType = coverMetadata?.type || response.headers.get("content-type") || "image/jpeg";
            imageBlob = new Blob([decryptedBuffer], { type: mimeType });
          } catch (error) {
            if (!cancelled) {
              console.warn("Cover fetch decrypt failed", error);
              setFailed(true);
            }
            return;
          }
        } else {
          imageBlob = await response.blob();
        }

        if (cancelled) return;
        const objectUrl = URL.createObjectURL(imageBlob);
        objectUrlRef.current = objectUrl;
        setSrc(objectUrl);
        setUsedOptimized(false);
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
        }
      }
    };

    loadCover();

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [coverEncryption, coverMetadata, optimizedUrl, requiresAuth, serverType, signTemplate, url]);

  if (!src || failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => {
        if (usedOptimized) {
          setUsedOptimized(false);
          setSrc(url);
          return;
        }
        setFailed(true);
      }}
      draggable={false}
    />
  );
};

const blurhashDataUrlCache = new Map<string, string>();

const buildBlurhashCacheKey = (hash: string, width?: number, height?: number) =>
  `${hash}|${width ?? ""}|${height ?? ""}`;

type IdleCancel = () => void;

const scheduleIdle = (work: () => void): IdleCancel => {
  if (typeof window === "undefined") {
    work();
    return () => undefined;
  }

  const win = window as typeof window & {
    requestIdleCallback?: (callback: (...args: any[]) => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(() => work(), { timeout: 150 });
    return () => {
      win.cancelIdleCallback?.(handle);
    };
  }

  const timeout = window.setTimeout(work, 32);
  return () => {
    window.clearTimeout(timeout);
  };
};

let blurhashCanvas: HTMLCanvasElement | null = null;
let blurhashContext: CanvasRenderingContext2D | null = null;

const ensureDecodeSurface = (width: number, height: number) => {
  if (!blurhashCanvas) {
    blurhashCanvas = document.createElement("canvas");
    blurhashContext = blurhashCanvas.getContext("2d");
  }
  if (!blurhashCanvas || !blurhashContext) return null;
  if (blurhashCanvas.width !== width) blurhashCanvas.width = width;
  if (blurhashCanvas.height !== height) blurhashCanvas.height = height;
  return { canvas: blurhashCanvas, ctx: blurhashContext } as const;
};

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

    const surface = ensureDecodeSurface(decodeWidth, decodeHeight);
    if (!surface) return null;
    const { canvas, ctx } = surface;
    const pixels = decode(hash, decodeWidth, decodeHeight);
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
    let cancelled = false;
    const cancel = scheduleIdle(() => {
      if (cancelled) return;
      const result = decodeBlurhashToDataUrl(hash, width, height);
      if (cancelled) return;
      if (result) {
        blurhashDataUrlCache.set(cacheKey, result);
        setDataUrl(result);
      } else {
        setDataUrl(null);
      }
    });
    return () => {
      cancelled = true;
      cancel();
    };
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
  if (blob.__bloomFolderPlaceholder || isListLikeBlob(blob)) {
    const rawFolderName = blob.name || blob.folderPath || blob.sha256;
    return sanitizeFilename(rawFolderName);
  }

  const metadataName = getBlobMetadataName(blob);
  const raw = metadataName ?? blob.sha256;
  const sanitized = sanitizeFilename(raw);
  const { baseName, extension: existingExtension } = splitNameAndExtension(sanitized);
  const inferredExtension = existingExtension || inferExtensionFromType(blob.type);

  const shouldKeepFullName = Boolean(metadataName) && blob.type?.startsWith("audio/");
  const displayBase = metadataName
    ? shouldKeepFullName
      ? baseName
      : truncateMiddle(baseName, 12, 12)
    : baseName;

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
