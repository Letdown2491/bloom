import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  MusicIcon,
  VideoIcon,
  DocumentIcon,
  LockIcon,
  TransferIcon,
  SettingsIcon,
} from "../../../shared/ui/icons";
import { PRIVATE_PLACEHOLDER_SHA } from "../../../shared/constants/private";
import type { FileKind } from "../../../shared/ui/icons";
import { getBlobMetadataName, normalizeFolderPathInput, type BlobAudioMetadata } from "../../../shared/utils/blobMetadataStore";
import { useBlobMetadata } from "../useBlobMetadata";
import { useBlobPreview, canBlobPreview } from "../useBlobPreview";
import { useAudioMetadataMap } from "../useAudioMetadata";
import { usePrivateLibrary } from "../../../app/context/PrivateLibraryContext";
import type { PrivateListEntry } from "../../../shared/domain/privateList";
import { useUserPreferences, type DefaultSortOption, type SortDirection } from "../../../app/context/UserPreferencesContext";
import { useDialog } from "../../../app/context/DialogContext";
import type { FolderListRecord } from "../../../shared/domain/folderList";
import type { FolderShareHint, ShareFolderScope } from "../../../shared/types/shareFolder";
import type { ShareMode } from "../../share/ui/ShareComposer";
import { ShareHowDialog } from "../../share/ui/ShareHowDialog";
import {
  BlobPreview,
  PreviewDialog,
  isListLikeBlob,
  buildPreviewUrl,
  decideFileKind,
  extractBlurhash,
  BlurhashThumbnail,
  buildDisplayName,
  sanitizeFilename,
  inferExtensionFromType,
  ensureExtension,
  AudioCoverImage,
} from "./components/blobPreview";

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
  resolvePrivateLink?: (blob: BlossomBlob) => { url: string; alias?: string | null; expiresAt?: number | null } | null;
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
  privateLinkServiceConfigured?: boolean;
};

type DetectedKindMap = Record<string, "image" | "video">;

type ShareAvailability = {
  allowPublic: boolean;
  allowPrivate: boolean;
  disabled: boolean;
  disabledReason: string | null;
  isPrivateItem: boolean;
  publicUrl: string | null;
  privateLinkUrl: string | null;
};

const computeShareAvailability = (
  blob: BlossomBlob,
  privateLinkServiceConfigured: boolean
): ShareAvailability => {
  const isListBlob = isListLikeBlob(blob);
  const isPrivateList = isListBlob && blob.sha256 === PRIVATE_PLACEHOLDER_SHA;
  const isPrivateBlob = Boolean(blob.privateData);
  const isPrivateScope = blob.__bloomFolderScope === "private";
  const isPrivateItem = isPrivateList || isPrivateBlob || isPrivateScope;

  const normalizedServerUrl =
    typeof blob.serverUrl === "string" && blob.serverUrl.trim().length > 0
      ? blob.serverUrl.trim().replace(/\/+$/, "")
      : "";
  const publicUrl =
    typeof blob.url === "string" && blob.url.trim().length > 0
      ? blob.url.trim()
      : normalizedServerUrl && blob.sha256
        ? `${normalizedServerUrl}/${blob.sha256}`
        : null;
  const privateLinkUrl =
    typeof blob.__bloomPrivateLinkUrl === "string" && blob.__bloomPrivateLinkUrl.trim().length > 0
      ? blob.__bloomPrivateLinkUrl.trim()
      : null;

  const allowPublic = !isPrivateItem && Boolean(publicUrl);
  const allowPrivate = !isPrivateItem && (Boolean(privateLinkUrl) || privateLinkServiceConfigured);
  const disabled = !allowPublic && !allowPrivate;
  const disabledReason = disabled
    ? isPrivateItem
      ? isListBlob
        ? "Private folders cannot be shared"
        : "Private files cannot be shared"
      : "Share available once file link is ready"
    : null;

  return {
    allowPublic,
    allowPrivate,
    disabled,
    disabledReason,
    isPrivateItem,
    publicUrl,
    privateLinkUrl,
  };
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
  resolvePrivateLink,
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
  privateLinkServiceConfigured = false,
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
      const privateInfo = resolvePrivateLink?.(blob) ?? null;
      const privateLinkUrl =
        typeof privateInfo?.url === "string" && privateInfo.url.trim().length > 0
          ? privateInfo.url.trim()
          : null;
      return {
        ...blob,
        type: mergedType,
        name: mergedName,
        url: blob.url || (normalizedBase ? `${normalizedBase}/${blob.sha256}` : undefined),
        serverUrl: normalizedBase ?? blob.serverUrl,
        requiresAuth: blob.requiresAuth ?? requiresAuth,
        serverType: blob.serverType ?? serverType,
        __bloomPrivateLinkUrl: privateLinkUrl,
        __bloomPrivateLinkAlias: privateInfo?.alias ?? null,
        __bloomPrivateLinkExpiresAt: privateInfo?.expiresAt ?? null,
      };
    });
  }, [blobs, resolvedMeta, baseUrl, requiresAuth, resolvePrivateLink, serverType]);

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
  const [shareDialogTarget, setShareDialogTarget] = useState<BlossomBlob | null>(null);
  const shareDialogTargetSha = shareDialogTarget?.sha256 ?? null;
  const openShareDialog = useCallback((blob: BlossomBlob) => {
    setShareDialogTarget(blob);
  }, []);
  const handleShareDialogClose = useCallback(() => {
    setShareDialogTarget(null);
  }, []);
  const handleShareDialogSelect = useCallback(
    (mode: "public" | "private") => {
      setShareDialogTarget(current => {
        if (!current) return null;
        if (!onShare) return null;
        if (mode === "private") {
          onShare(current, { mode: "private-link" });
        } else {
          onShare(current);
        }
        return null;
      });
    },
    [onShare]
  );
  const shareDialogAvailability = useMemo(
    () => (shareDialogTarget ? computeShareAvailability(shareDialogTarget, privateLinkServiceConfigured) : null),
    [shareDialogTarget, privateLinkServiceConfigured]
  );
  const shareDialogPublicLink = shareDialogAvailability?.publicUrl ?? null;
  const shareDialogPrivateLink = shareDialogAvailability?.privateLinkUrl ?? null;
  const shareDialogHasPrivateLink = Boolean(shareDialogPrivateLink);
  const shareDialogCanCreatePrivateLink = Boolean(
    privateLinkServiceConfigured && !(shareDialogAvailability?.isPrivateItem ?? false)
  );
  const shareDialogPrivateDisabledReason = useMemo(() => {
    if (!shareDialogAvailability || shareDialogAvailability.allowPrivate) return null;
    if (shareDialogAvailability.isPrivateItem) {
      if (shareDialogTarget && isListLikeBlob(shareDialogTarget)) {
        return "Private folders cannot be shared.";
      }
      return "Private files cannot be shared.";
    }
    if (!privateLinkServiceConfigured) {
      return "Connect a private link service to share privately.";
    }
    return shareDialogAvailability.disabledReason;
  }, [shareDialogAvailability, privateLinkServiceConfigured, shareDialogTarget]);
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
          privateLinkServiceConfigured={privateLinkServiceConfigured}
          openShareDialog={openShareDialog}
          activeShareDialogSha={shareDialogTargetSha}
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
          privateLinkServiceConfigured={privateLinkServiceConfigured}
          openShareDialog={openShareDialog}
          activeShareDialogSha={shareDialogTargetSha}
        />
      )}
      <ShareHowDialog
        open={Boolean(shareDialogTarget)}
        onClose={handleShareDialogClose}
        onSelect={handleShareDialogSelect}
        allowPublic={Boolean(shareDialogAvailability?.allowPublic)}
        allowPrivate={Boolean(shareDialogAvailability?.allowPrivate)}
        hasExistingPrivateLink={shareDialogHasPrivateLink}
        canCreatePrivateLink={shareDialogCanCreatePrivateLink}
        privateLinkDisabledReason={shareDialogPrivateDisabledReason}
        publicLinkUrl={shareDialogPublicLink ?? undefined}
        privateLinkUrl={shareDialogPrivateLink ?? undefined}
      />
    </div>
  );
};

const LIST_ROW_HEIGHT = 68;
const LIST_ROW_HEIGHT_COMPACT = 96;
const MIN_LIST_OVERSCAN = 4;
const MAX_LIST_OVERSCAN = 12;
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
  privateLinkServiceConfigured: boolean;
  openShareDialog: (blob: BlossomBlob) => void;
  activeShareDialogSha: string | null;
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
  privateLinkServiceConfigured,
  openShareDialog,
  activeShareDialogSha,
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
  const listOverscanCount = useMemo(() => {
    const visibleRows = container.height > 0 ? Math.max(1, Math.ceil(container.height / (listRowHeight + LIST_ROW_GAP))) : 4;
    const dynamicOverscan = visibleRows + 2;
    return Math.min(MAX_LIST_OVERSCAN, Math.max(MIN_LIST_OVERSCAN, dynamicOverscan));
  }, [container.height, listRowHeight]);

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
      privateLinkServiceConfigured,
      openShareDialog,
      activeShareDialogSha,
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
      privateLinkServiceConfigured,
      openShareDialog,
      activeShareDialogSha,
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
        privateLinkServiceConfigured: rowPrivateLinkServiceConfigured,
        openShareDialog: rowOpenShareDialog,
        activeShareDialogSha: rowActiveShareDialogSha,
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
          privateLinkServiceConfigured={rowPrivateLinkServiceConfigured}
          onOpenShareDialog={rowOpenShareDialog}
          activeShareDialogSha={rowActiveShareDialogSha}
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
            overscanCount={listOverscanCount}
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
  privateLinkServiceConfigured: boolean;
  openShareDialog: (blob: BlossomBlob) => void;
  activeShareDialogSha: string | null;
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
  privateLinkServiceConfigured,
  openShareDialog,
  activeShareDialogSha,
}) => {
  const CARD_WIDTH = 220;
  const HORIZONTAL_GAP = 8;
  const VERTICAL_GAP = 12;
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
  const prefetchedVisibleRef = useRef<Set<string>>(new Set());

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
  const overscanRows = useMemo(() => {
    if (viewportHeight <= 0) return 2;
    const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
    const dynamicOverscan = Math.ceil(visibleRows / 3);
    return Math.max(1, Math.min(3, dynamicOverscan));
  }, [viewportHeight, rowHeight]);
  const visibleRowCount =
    viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + overscanRows * 2 : rowCount;
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
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

  useEffect(() => {
    if (!visibleItems.length) return;
    const seen = prefetchedVisibleRef.current;
    visibleItems.forEach(({ blob }) => {
      const sha = blob.sha256;
      if (!sha || seen.has(sha)) return;
      seen.add(sha);
      onBlobVisible(sha);
    });
  }, [visibleItems, onBlobVisible]);

  useEffect(() => {
    if (!blobs.length) {
      prefetchedVisibleRef.current.clear();
      return;
    }
    const valid = new Set<string>();
    blobs.forEach(blob => {
      if (blob?.sha256) {
        valid.add(blob.sha256);
      }
    });
    const tracked = prefetchedVisibleRef.current;
    tracked.forEach(sha => {
      if (!valid.has(sha)) {
        tracked.delete(sha);
      }
    });
  }, [blobs]);

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
              privateLinkServiceConfigured={privateLinkServiceConfigured}
              onOpenShareDialog={openShareDialog}
              activeShareDialogSha={activeShareDialogSha}
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
  privateLinkServiceConfigured: boolean;
  onOpenShareDialog: (blob: BlossomBlob) => void;
  activeShareDialogSha: string | null;
};

type GridDropdownItem =
  | {
      key: string;
      type: "separator";
    }
  | {
      key: string;
      label: string;
      icon: React.ReactNode;
      onSelect: () => void;
      ariaLabel?: string;
      variant?: "destructive";
      disabled?: boolean;
    };

const isGridDropdownSeparator = (item: GridDropdownItem): item is { key: string; type: "separator" } =>
  "type" in item && item.type === "separator";

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
    privateLinkServiceConfigured,
    onOpenShareDialog,
    activeShareDialogSha,
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
    const dropdownSeparatorClass = isLightTheme ? "my-1 h-px bg-slate-200" : "my-1 h-px bg-slate-700/60";
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

    const shareAvailability = useMemo(
      () => computeShareAvailability(blob, privateLinkServiceConfigured),
      [blob, privateLinkServiceConfigured]
    );
    const disabledNeutralButtonClass = isLightTheme
      ? [
          "disabled:border-slate-300",
          "disabled:bg-white/95",
          "disabled:text-slate-700",
          "disabled:opacity-100",
          "disabled:hover:bg-white/95",
          "disabled:hover:text-slate-700",
          "disabled:focus:bg-white/95",
          "disabled:focus:text-slate-700",
          "disabled:focus-visible:bg-white/95",
          "disabled:focus-visible:text-slate-700",
          "disabled:active:bg-white/95",
          "disabled:active:text-slate-700",
        ].join(" ")
      : [
          "disabled:border-slate-700",
          "disabled:bg-slate-900/80",
          "disabled:text-slate-100",
          "disabled:opacity-100",
          "disabled:hover:bg-slate-900/80",
          "disabled:hover:text-slate-100",
          "disabled:focus:bg-slate-900/80",
          "disabled:focus:text-slate-100",
          "disabled:focus-visible:bg-slate-900/80",
          "disabled:focus-visible:text-slate-100",
          "disabled:active:bg-slate-900/80",
          "disabled:active:text-slate-100",
        ].join(" ");
    const actionsMenuDisabled = isPrivateList && blob.sha256 === PRIVATE_PLACEHOLDER_SHA;
    const disabledNeutralIconClass = isLightTheme ? "text-slate-400" : "text-slate-500";
    const disabledActionsClass = actionsMenuDisabled ? disabledNeutralButtonClass : "";
    const isShareDialogActive = activeShareDialogSha === blob.sha256;

    const cardStyle = useMemo<React.CSSProperties>(
      () => ({
        top: 0,
        left: 0,
        width,
        height,
        transform: `translate3d(${left}px, ${top}px, 0)`,
        willChange: "transform",
        zIndex: isMenuOpen ? 40 : isShareDialogActive ? 45 : isSelected ? 30 : undefined,
      }),
      [height, isMenuOpen, isShareDialogActive, isSelected, left, top, width]
    );
    const contentHeight = height * 0.75;

    const handleMenuToggle = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
      event => {
        if (actionsMenuDisabled) return;
        event.stopPropagation();
        onToggleMenu(blob.sha256);
      },
      [actionsMenuDisabled, blob.sha256, onToggleMenu]
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
      const items: GridDropdownItem[] = [];
      let addedRename = false;
      if (folderShareHint && onShareFolder) {
        if (folderVisibility === "public") {
          items.push({
            key: "folder-share-options",
            label: shareBusy ? "Opening…" : "Share Options",
            icon: <SettingsIcon size={14} />,
            ariaLabel: "Share options",
            onSelect: () => {
              if (shareBusy) return;
              onShareFolder({ ...folderShareHint });
            },
            disabled: shareBusy,
          });
          if (onUnshareFolder) {
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
          }
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
        items.push({
          key: "folder-actions-separator",
          type: "separator",
        });
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
        addedRename = true;
      }

      if (addedRename) {
        items.push({
          key: "delete-separator",
          type: "separator",
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

    const shareButton = (() => {
      if (folderShareHint && onShareFolder) {
        const disabled = shareBusy;
        const folderShareDisabledClass = disabled ? disabledNeutralButtonClass : "";
        const title = disabled
          ? "Sharing folder…"
          : folderVisibility === "public"
            ? "Show share link"
            : "Share folder";
        return (
          <button
            className={`${toolbarNeutralButtonClass} rounded-none border-l border-r-0 ${folderShareDisabledClass}`}
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
            <ShareIcon size={18} className={disabled ? disabledNeutralIconClass : undefined} />
          </button>
        );
      }
      if (!onShare) return null;
      const disabled = shareAvailability.disabled;
      const shareDisabledClass = disabled ? disabledNeutralButtonClass : "";
      const title = disabled ? shareAvailability.disabledReason ?? "Share unavailable" : "Share";
      const ariaLabel = isAudio ? "Share track" : "Share blob";
      return (
        <button
          className={`${dropdownTriggerClass} h-full w-full rounded-none border-l border-r-0 ${shareDisabledClass}`}
          onClick={event => {
            event.stopPropagation();
            if (disabled) return;
            onOpenShareDialog(blob);
          }}
          aria-label={ariaLabel}
          title={title}
          type="button"
          disabled={disabled}
          aria-haspopup={disabled ? undefined : "dialog"}
          aria-expanded={!disabled && isShareDialogActive}
        >
          <ShareIcon size={18} className={disabled ? disabledNeutralIconClass : undefined} />
        </button>
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
                className={`${dropdownTriggerClass} h-full w-full rounded-none rounded-br-xl border-l ${disabledActionsClass}`}
                onClick={handleMenuToggle}
                aria-haspopup={actionsMenuDisabled ? undefined : "true"}
                aria-expanded={actionsMenuDisabled ? undefined : isMenuOpen}
                title={actionsMenuDisabled ? "Actions unavailable" : "More actions"}
                type="button"
                aria-label="More actions"
                disabled={actionsMenuDisabled}
                aria-disabled={actionsMenuDisabled || undefined}
              >
                <ChevronDownIcon size={18} className={actionsMenuDisabled ? disabledNeutralIconClass : undefined} />
              </button>
              {!actionsMenuDisabled && isMenuOpen ? (
                <div
                  ref={menuRef}
                  className={`${menuBaseClass} ${menuPlacementClass} ${menuVisibilityClass}`}
                  role="menu"
                  aria-label="More actions"
                >
                  {dropdownItems.map(item => {
                    if (isGridDropdownSeparator(item)) {
                      return <div key={item.key} className={dropdownSeparatorClass} role="separator" aria-hidden="true" />;
                    }
                    return (
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
                    );
                  })}
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
  privateLinkServiceConfigured: boolean;
  onOpenShareDialog: (blob: BlossomBlob) => void;
  activeShareDialogSha: string | null;
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
  privateLinkServiceConfigured,
  onOpenShareDialog,
  activeShareDialogSha,
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
  const dropdownSeparatorClass = isLightTheme ? "my-1 h-px bg-slate-200" : "my-1 h-px bg-slate-700/60";

  const shareAvailability = useMemo(
    () => computeShareAvailability(blob, privateLinkServiceConfigured),
    [blob, privateLinkServiceConfigured]
  );
  const isShareDialogActive = activeShareDialogSha === blob.sha256;

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
    const disabled = shareAvailability.disabled;
    const ariaLabel = isMusicListView ? "Share track" : "Share blob";
    const title = disabled ? shareAvailability.disabledReason ?? "Share unavailable" : "Share";
    return (
      <button
        className="p-2 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-800"
        onClick={event => {
          event.stopPropagation();
          if (disabled) return;
          onOpenShareDialog(blob);
        }}
        aria-label={ariaLabel}
        title={title}
        type="button"
        disabled={disabled}
        aria-haspopup={disabled ? undefined : "dialog"}
        aria-expanded={!disabled && isShareDialogActive}
      >
        <ShareIcon size={16} />
      </button>
    );
  })();

  type DropdownItem =
    | {
        key: string;
        type: "separator";
      }
    | {
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
    if (folderVisibility === "public") {
      dropdownItems.push({
        key: "folder-share-options",
        label: shareBusy ? "Opening…" : "Share Options",
        icon: <SettingsIcon size={14} />,
        ariaLabel: "Share options",
        onSelect: () => {
          if (shareBusy) return;
          onShareFolder({ ...folderShareHint });
        },
        disabled: shareBusy,
      });
      if (onUnshareFolder) {
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
      }
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
    dropdownItems.push({
      key: "folder-actions-separator",
      type: "separator",
    });
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
              {dropdownItems.map(item => {
                if ("type" in item) {
                  return <div key={item.key} className={dropdownSeparatorClass} role="separator" aria-hidden="true" />;
                }
                return (
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
                );
              })}
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
    prev.actionsColumnWidth === next.actionsColumnWidth &&
    prev.privateLinkServiceConfigured === next.privateLinkServiceConfigured &&
    prev.activeShareDialogSha === next.activeShareDialogSha
  );
});


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
