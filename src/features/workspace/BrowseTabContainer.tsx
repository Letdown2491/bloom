import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FilterMode } from "../../shared/types/filter";
import { useWorkspace } from "./WorkspaceContext";
import { useSelection } from "../selection/SelectionContext";
import { usePrivateLibrary } from "../../app/context/PrivateLibraryContext";
import { useFolderLists } from "../../app/context/FolderListContext";
import { MoveDialog } from "./ui/MoveDialog";
import type { MoveDialogDestination } from "./ui/MoveDialog";
import { useAudio } from "../../app/context/AudioContext";
import { matchesFilter, createAudioTrack } from "../browse/browseUtils";
import { useAudioMetadataMap } from "../browse/useAudioMetadata";
import type { StatusMessageTone } from "../../shared/types/status";
import type { SharePayload, ShareMode } from "../share/ui/ShareComposer";
import type { BlossomBlob, SignTemplate } from "../../shared/api/blossomClient";
import { extractSha256FromUrl } from "../../shared/api/blossomClient";
import type { ManagedServer } from "../../shared/types/servers";
import type { TabId } from "../../shared/types/tabs";
import { deleteUserBlob, buildAuthorizationHeader } from "../../shared/api/blossomClient";
import { deleteNip96File } from "../../shared/api/nip96Client";
import { deleteSatelliteFile } from "../../shared/api/satelliteClient";
import { useNdk, useCurrentPubkey } from "../../app/context/NdkContext";
import { isMusicBlob } from "../../shared/utils/blobClassification";
import { PRIVATE_PLACEHOLDER_SHA, PRIVATE_SERVER_NAME } from "../../shared/constants/private";
import { applyFolderUpdate, getBlobMetadataName, normalizeFolderPathInput } from "../../shared/utils/blobMetadataStore";
import type { BlobAudioMetadata } from "../../shared/utils/blobMetadataStore";
import { deriveNameFromPath, isPrivateFolderName, type FolderListVisibility } from "../../shared/domain/folderList";
import { isListLikeBlob, type BlobReplicaSummary } from "../browse/ui/BlobList";
import type { DefaultSortOption, SortDirection } from "../../app/context/UserPreferencesContext";
import { buildNip98AuthHeader } from "../../shared/api/nip98";
import { decryptPrivateBlob } from "../../shared/domain/privateEncryption";
import type { Track } from "../../app/context/AudioContext";
import type { PrivateListEntry } from "../../shared/domain/privateList";
import { useDialog } from "../../app/context/DialogContext";
import type { FolderShareHint, ShareFolderRequest } from "../../shared/types/shareFolder";
import { usePrivateLinks } from "../privateLinks/hooks/usePrivateLinks";
import type { PrivateLinkRecord } from "../../shared/domain/privateLinks";
import { publishNip94Metadata, extractExtraNip94Tags } from "../../shared/api/nip94Publisher";
import { usePreferredRelays } from "../../app/hooks/usePreferredRelays";

type MetadataSyncTarget = {
  blob: BlossomBlob;
  folderPath: string | null;
};

type MetadataSyncContext = {
  successMessage?: (count: number) => string;
  errorMessage?: (count: number) => string;
};

const BrowsePanelLazy = React.lazy(() =>
  import("../browse/BrowseTab").then(module => ({ default: module.BrowsePanel }))
);

const normalizeServerUrl = (value: string) => value.replace(/\/+$/, "");
const NEW_FOLDER_OPTION_VALUE = "__bloom_move_create_new_folder__";

const normalizeMatchUrl = (value?: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
};

type SearchField = "artist" | "album" | "title" | "genre" | "year" | "type" | "mime" | "size";

type SizeComparison = {
  operator: ">" | ">=" | "<" | "<=" | "=";
  value: number;
};

type ParsedSearchQuery = {
  textTerms: string[];
  fieldTerms: Partial<Record<SearchField, string[]>>;
  sizeComparisons: SizeComparison[];
  isActive: boolean;
};

const SEARCH_FIELD_ALIASES: Record<string, SearchField> = {
  artist: "artist",
  album: "album",
  title: "title",
  song: "title",
  genre: "genre",
  year: "year",
  type: "type",
  mime: "mime",
  ext: "type",
  size: "size",
};

const extractExtension = (value?: string | null) => {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const match = /\.([^.\\/]+)$/.exec(trimmed);
  return match?.[1];
};

const tokenizeSearchInput = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (char === "\"" || char === "'") {
      if (quote === char) {
        quote = null;
        continue;
      }
      if (!quote) {
        quote = char;
        continue;
      }
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const parseSizeComparison = (value: string): SizeComparison | null => {
  const SIZE_REGEX = /^(?<op>>=|<=|>|<|=)?\s*(?<number>\d+(?:\.\d+)?)\s*(?<unit>kb|mb|gb|tb|b)?$/i;
  const match = SIZE_REGEX.exec(value.trim());
  if (!match || !match.groups) return null;
  const operator = (match.groups.op as SizeComparison["operator"]) ?? ">=";
  const rawNumber = Number(match.groups.number);
  if (!Number.isFinite(rawNumber)) return null;
  const unit = match.groups.unit?.toLowerCase() ?? "b";
  const multiplier = unit === "tb"
    ? 1024 ** 4
    : unit === "gb"
      ? 1024 ** 3
      : unit === "mb"
        ? 1024 ** 2
        : unit === "kb"
          ? 1024
          : 1;
  return {
    operator,
    value: rawNumber * multiplier,
  };
};

const parseSearchQuery = (value: string): ParsedSearchQuery => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return { textTerms: [], fieldTerms: {}, sizeComparisons: [], isActive: false };
  }

  const tokens = tokenizeSearchInput(trimmed);
  const textTerms: string[] = [];
  const fieldTerms: Partial<Record<SearchField, string[]>> = {};
  const sizeComparisons: SizeComparison[] = [];

  tokens.forEach(token => {
    const separatorIndex = token.indexOf(":");
    if (separatorIndex > 0) {
      const key = token.slice(0, separatorIndex).trim();
      const alias = SEARCH_FIELD_ALIASES[key];
      const rawValue = token.slice(separatorIndex + 1).trim();
      if (alias && rawValue) {
        if (alias === "size") {
          const parts = rawValue.split("...");
          let parsedAny = false;
          parts.forEach(part => {
            const comparison = parseSizeComparison(part);
            if (comparison) {
              sizeComparisons.push(comparison);
              parsedAny = true;
            }
          });
          if (parsedAny) {
            return;
          }
        }
        const values = fieldTerms[alias] ?? [];
        values.push(rawValue);
        fieldTerms[alias] = values;
        return;
      }
    }
    if (token) {
      textTerms.push(token);
    }
  });

  const isActive =
    textTerms.length > 0 ||
    sizeComparisons.length > 0 ||
    Object.values(fieldTerms).some(list => (list?.length ?? 0) > 0);
  return { textTerms, fieldTerms, sizeComparisons, isActive };
};

type FolderNode = {
  path: string;
  name: string;
  parent: string | null;
  children: Set<string>;
  items: BlossomBlob[];
  latestUploaded: number;
};

type FolderScope = "aggregated" | "server" | "private";

type MoveDialogState =
  | { kind: "blob"; blob: BlossomBlob; currentPath: string | null; isPrivate: boolean }
  | { kind: "folder"; path: string; name: string; currentParent: string | null; scope: FolderScope; isPrivate: boolean };

const folderPlaceholderSha = (scope: FolderScope, path: string, variant: "node" | "up") => {
  const encodedPath = encodeURIComponent(path || "__root__");
  return `__folder__:${scope}:${encodedPath}:${variant}`;
};

const getParentFolderPath = (path: string): string | null => {
  if (!path) return null;
  const segments = path.split("/");
  segments.pop();
  if (segments.length === 0) return "";
  return segments.join("/");
};

const buildFolderIndex = (blobs: readonly BlossomBlob[]): Map<string, FolderNode> => {
  const root: FolderNode = { path: "", name: "", parent: null, children: new Set(), items: [], latestUploaded: 0 };
  const nodes = new Map<string, FolderNode>();
  nodes.set("", root);

  const applyLatestUploaded = (path: string, uploaded: number) => {
    if (!uploaded) return;
    const node = nodes.get(path);
    if (!node) return;
    if (uploaded > node.latestUploaded) {
      node.latestUploaded = uploaded;
    }
  };

  blobs.forEach(blob => {
    const normalizedPath = normalizeFolderPathInput(blob.folderPath ?? undefined);
    const uploadedValue = typeof blob.uploaded === "number" ? blob.uploaded : 0;

    applyLatestUploaded("", uploadedValue);

    if (!normalizedPath) {
      root.items.push(blob);
      return;
    }
    const segments = normalizedPath.split("/");
    let parentPath = "";
    segments.forEach(segment => {
      const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
      if (!nodes.has(currentPath)) {
        nodes.set(currentPath, {
          path: currentPath,
          name: segment,
          parent: parentPath,
          children: new Set(),
          items: [],
          latestUploaded: 0,
        });
      }
      const parentNode = nodes.get(parentPath);
      if (parentNode) {
        parentNode.children.add(currentPath);
      }
      applyLatestUploaded(currentPath, uploadedValue);
      parentPath = currentPath;
    });
    const leafNode = nodes.get(parentPath);
    if (leafNode) {
      leafNode.items.push(blob);
    }
  });

  return nodes;
};

type BuildFolderViewOptions = {
  activePath: string;
  scope: FolderScope;
  serverUrl?: string | null;
  serverType?: BlossomBlob["serverType"];
  requiresAuth?: boolean;
  resolveFolderName?: (path: string) => string;
};

const createFolderPlaceholder = (
  options: BuildFolderViewOptions & {
    path: string;
    name: string;
    targetPath: string | null;
    isParent?: boolean;
    latestUploaded?: number;
  }
): BlossomBlob => {
  const { scope, path, name, serverUrl, serverType, requiresAuth, targetPath, isParent = false, latestUploaded } = options;
  const placeholder: BlossomBlob = {
    sha256: folderPlaceholderSha(scope, path, isParent ? "up" : "node"),
    name,
    type: "application/x-directory",
    size: 0,
    serverUrl: serverUrl ?? undefined,
    serverType,
    requiresAuth: Boolean(requiresAuth),
    uploaded: latestUploaded ?? 0,
    url: undefined,
    folderPath: targetPath ?? null,
    __bloomFolderPlaceholder: true,
    __bloomFolderScope: scope,
    __bloomFolderTargetPath: targetPath,
    __bloomFolderIsParentLink: isParent,
  };
  return placeholder;
};

const buildFolderViewFromIndex = (
  index: Map<string, FolderNode>,
  allBlobs: readonly BlossomBlob[],
  options: BuildFolderViewOptions
): { list: BlossomBlob[]; parentPath: string | null } => {
  const targetPath = options.activePath;
  const node = index.get(targetPath) ?? index.get("");
  if (!node) {
    return { list: allBlobs.slice(), parentPath: null };
  }
  const childPaths = Array.from(node.children);
  childPaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const childPlaceholders = childPaths.map(path => {
    const childNode = index.get(path);
    const defaultName = childNode?.name ?? path.split("/").pop() ?? path;
    const folderName = options.resolveFolderName ? options.resolveFolderName(path) : defaultName;
    return createFolderPlaceholder({
      ...options,
      path,
      name: folderName,
      targetPath: path,
      latestUploaded: childNode?.latestUploaded,
    });
  });
  const parentPath = getParentFolderPath(targetPath);
  const list: BlossomBlob[] = [];
  list.push(...childPlaceholders);
  list.push(...node.items);
  return { list, parentPath };
};

export type BrowseTabContainerProps = {
  active: boolean;
  onStatusMetricsChange: (metrics: { count: number; size: number }) => void;
  onRequestRename: (blob: BlossomBlob) => void;
  onRequestFolderRename: (path: string) => void;
  onRequestShare: (payload: SharePayload, options?: { mode?: ShareMode }) => void;
  onShareFolder: (request: ShareFolderRequest) => void;
  onUnshareFolder: (request: ShareFolderRequest) => void;
  folderShareBusyPath?: string | null;
  onSetTab: (tab: TabId) => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  viewMode: "grid" | "list";
  filterMode: FilterMode;
  filterMenuRef: React.RefObject<HTMLDivElement>;
  isFilterMenuOpen: boolean;
  onCloseFilterMenu: () => void;
  onBrowseTabChange: (tabId: string) => void;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  homeResetKey: number;
  defaultSortOption: DefaultSortOption;
  sortDirection: SortDirection;
  onNavigationChange?: (navigation: BrowseNavigationState | null) => void;
  searchTerm: string;
  onActiveListChange?: (state: BrowseActiveListState | null) => void;
  restoreActiveList?: BrowseActiveListState | null;
  restoreActiveListKey?: number | null;
  onRestoreActiveList?: () => void;
};

export type BrowseActiveListState =
  | { type: "private"; serverUrl: string | null }
  | { type: "folder"; scope: FolderScope; path: string; serverUrl?: string | null };

type ActiveListState = BrowseActiveListState;

export type BrowseNavigationSegment = {
  id: string;
  label: string;
  onNavigate: () => void;
  visibility?: FolderListVisibility | null;
};

export type BrowseNavigationState = {
  segments: BrowseNavigationSegment[];
  canNavigateUp: boolean;
  onNavigateHome: () => void;
  onNavigateUp: () => void;
};

export const BrowseTabContainer: React.FC<BrowseTabContainerProps> = ({
  active,
  onStatusMetricsChange,
  onRequestRename,
  onRequestFolderRename,
  onRequestShare,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath = null,
  onSetTab,
  showStatusMessage,
  viewMode,
  filterMode,
  filterMenuRef,
  isFilterMenuOpen,
  onCloseFilterMenu,
  onBrowseTabChange,
  showGridPreviews,
  showListPreviews,
  homeResetKey,
  defaultSortOption,
  sortDirection,
  onNavigationChange,
  searchTerm,
  onActiveListChange,
  restoreActiveList,
  restoreActiveListKey,
  onRestoreActiveList,
}) => {
  const {
    aggregated,
    snapshots,
    blobReplicaInfo,
    browsingAllServers,
    currentSnapshot,
    selectedServer,
    servers,
    privateBlobs,
    privateEntries,
  } = useWorkspace();
  const { selected: selectedBlobs, toggle: toggleBlob, selectMany: selectManyBlobs, clear: clearSelection } = useSelection();
  const audio = useAudio();
  const queryClient = useQueryClient();
  const { effectiveRelays } = usePreferredRelays();

  const {
    links: privateLinks,
    serviceConfigured: privateLinkServiceConfigured,
    serviceHost: privateLinkServiceHost,
  } = usePrivateLinks({ enabled: true });
  const privateLinkHost = useMemo(() => privateLinkServiceHost.replace(/\/+$/, ""), [privateLinkServiceHost]);
  const findExistingPrivateLink = useCallback(
    (blob: BlossomBlob): PrivateLinkRecord | null => {
      if (!privateLinkServiceConfigured) return null;
      const blobSha = blob.sha256 ?? null;
      const blobUrl = normalizeMatchUrl(blob.url ?? null);
      for (const record of privateLinks) {
        if (!record || record.status !== "active" || record.isExpired) continue;
        const target = record.target;
        if (!target) continue;
        const targetSha = target.sha256 ?? null;
        const targetUrl = normalizeMatchUrl(target.url ?? null);
        const matchesSha = Boolean(blobSha && targetSha && blobSha === targetSha);
        const matchesUrl = Boolean(blobUrl && targetUrl && blobUrl === targetUrl);
        if (matchesSha || matchesUrl) {
          return record;
        }
      }
      return null;
    },
    [privateLinks, privateLinkServiceConfigured]
  );
  const { ndk, signer, signEventTemplate } = useNdk();
  const pubkey = useCurrentPubkey();
  const { entriesBySha, removeEntries, upsertEntries } = usePrivateLibrary();
  const {
    folders,
    deleteFolder,
    foldersByPath,
    getFolderDisplayName,
    removeBlobFromFolder,
    resolveFolderPath,
    renameFolder,
    getFoldersForBlob,
    setBlobFolderMembership,
  } = useFolderLists();
  const { confirm } = useDialog();
  const [activeList, setActiveList] = useState<ActiveListState | null>(null);
  const playbackUrlCacheRef = useRef(new Map<string, string>());
  const lastPlayRequestRef = useRef<string | undefined>();
  const autoPrivateNavigationRef = useRef<{ previous: ActiveListState | null } | null>(null);
  const [moveState, setMoveState] = useState<MoveDialogState | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  useEffect(() => {
    onActiveListChange?.(activeList);
  }, [activeList, onActiveListChange]);

  useEffect(() => {
    if (restoreActiveListKey == null) return;
    setActiveList(() => (restoreActiveList ? { ...restoreActiveList } : null));
    clearSelection();
    onRestoreActiveList?.();
  }, [restoreActiveListKey, restoreActiveList, clearSelection, onRestoreActiveList]);

  const metadataSource = useMemo(() => [...aggregated.blobs, ...privateBlobs], [aggregated.blobs, privateBlobs]);
  const metadataMap = useAudioMetadataMap(metadataSource);

  const searchQuery = useMemo(() => parseSearchQuery(searchTerm), [searchTerm]);
  const isSearching = searchQuery.isActive;

  const matchesSearch = useCallback(
    (blob: BlossomBlob) => {
      if (!searchQuery.isActive) return true;

      if (isListLikeBlob(blob) || blob.__bloomFolderPlaceholder) {
        return false;
      }

      const { textTerms, fieldTerms } = searchQuery;
      const privateMetadata = blob.privateData?.metadata;
      const privateAudio = privateMetadata?.audio ?? undefined;
      const audioMetadata = metadataMap.get(blob.sha256);

      const coerceValue = (value: unknown): string | undefined => {
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed ? trimmed : undefined;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
          return String(value);
        }
        return undefined;
      };

      const getAudioValue = (field: keyof BlobAudioMetadata) =>
        coerceValue(audioMetadata?.[field] ?? (privateAudio ? (privateAudio as any)[field] : undefined));

      const mimeValueSet = new Set<string>();
      const typeValueSet = new Set<string>();

      const addMimeCandidate = (value?: string | null) => {
        const coerced = coerceValue(value);
        if (!coerced) return;
        const normalized = coerced.toLowerCase();
        mimeValueSet.add(normalized);
        const slashIndex = normalized.indexOf("/");
        if (slashIndex > 0) {
          const category = normalized.slice(0, slashIndex);
          mimeValueSet.add(category);
          typeValueSet.add(category);
        }
      };

      const addTypeCandidate = (value?: string | null) => {
        const extension = extractExtension(value);
        if (extension) {
          typeValueSet.add(extension);
        }
      };

      addMimeCandidate(blob.type);
      addMimeCandidate(privateMetadata?.type);
      addTypeCandidate(blob.name);
      addTypeCandidate(privateMetadata?.name);
      addTypeCandidate(blob.label);

      if (searchQuery.sizeComparisons.length > 0) {
        const resolvedSize = (() => {
          if (typeof blob.size === "number" && Number.isFinite(blob.size)) return blob.size;
          const privateSize = privateMetadata?.size;
          if (typeof privateSize === "number" && Number.isFinite(privateSize)) return privateSize;
          if (typeof privateMetadata?.audio?.durationSeconds === "number") return undefined;
          return undefined;
        })();
        if (typeof resolvedSize !== "number") {
          return false;
        }
        const satisfiesSizeFilters = searchQuery.sizeComparisons.every(comparison => {
          switch (comparison.operator) {
            case ">":
              return resolvedSize > comparison.value;
            case ">=":
              return resolvedSize >= comparison.value;
            case "<":
              return resolvedSize < comparison.value;
            case "<=":
              return resolvedSize <= comparison.value;
            case "=":
            default:
              return resolvedSize === comparison.value;
          }
        });
        if (!satisfiesSizeFilters) {
          return false;
        }
      }

      const fieldEntries = Object.entries(fieldTerms) as [SearchField, string[]][];
      for (const [field, values] of fieldEntries) {
        if (!values || values.length === 0) continue;

        let candidates: string[] = [];
        switch (field) {
          case "artist": {
            const value = getAudioValue("artist");
            if (value) {
              candidates = [value.toLowerCase()];
            }
            break;
          }
          case "album": {
            const value = getAudioValue("album");
            if (value) {
              candidates = [value.toLowerCase()];
            }
            break;
          }
          case "title": {
            const value =
              getAudioValue("title") ??
              coerceValue(privateMetadata?.name) ??
              coerceValue(blob.name);
            if (value) {
              candidates = [value.toLowerCase()];
            }
            break;
          }
          case "genre": {
            const value = getAudioValue("genre");
            if (value) {
              candidates = [value.toLowerCase()];
            }
            break;
          }
          case "year": {
            const value = getAudioValue("year");
            if (value) {
              candidates = [value.toLowerCase()];
            }
            break;
          }
          case "type": {
            candidates = Array.from(typeValueSet);
            break;
          }
          case "mime": {
            candidates = Array.from(mimeValueSet);
            break;
          }
          default:
            candidates = [];
        }

        if (candidates.length === 0) {
          return false;
        }

        const matchedAll = values.every(value =>
          candidates.some(candidate => candidate.includes(value))
        );
        if (!matchedAll) {
          return false;
        }
      }

      if (textTerms.length === 0) {
        return true;
      }

      const candidates = new Set<string>();
      const pushCandidate = (value?: string | null) => {
        const coerced = coerceValue(value);
        if (coerced) {
          candidates.add(coerced.toLowerCase());
        }
      };

      pushCandidate(blob.name);
      pushCandidate(blob.label);
      pushCandidate(blob.folderPath ?? undefined);
      pushCandidate(privateMetadata?.name);
      pushCandidate(privateMetadata?.folderPath ?? undefined);
      pushCandidate(blob.type);
      pushCandidate(privateMetadata?.type);
      pushCandidate(getAudioValue("title"));
      pushCandidate(getAudioValue("artist"));
      pushCandidate(getAudioValue("album"));
      pushCandidate(getAudioValue("genre"));

      typeValueSet.forEach(value => candidates.add(value));
      mimeValueSet.forEach(value => candidates.add(value));

      const addExtensionCandidate = (value?: string | null) => {
        const extension = extractExtension(value);
        if (extension) {
          candidates.add(extension);
        }
      };

      addExtensionCandidate(blob.name);
      addExtensionCandidate(privateMetadata?.name);

      for (const term of textTerms) {
        let matched = false;
        for (const candidate of candidates) {
          if (candidate.includes(term)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          return false;
        }
      }

      return true;
    },
    [metadataMap, searchQuery]
  );

  const normalizedSelectedServer = selectedServer ? normalizeServerUrl(selectedServer) : null;
  const normalizeMaybeServerUrl = (value?: string | null) => (value ? normalizeServerUrl(value) : null);
  const serverByUrl = useMemo(() => new Map(servers.map(server => [normalizeServerUrl(server.url), server])), [servers]);

  const hasActiveFilter = filterMode !== "all" || isSearching;
  const isPrivateRootView = activeList?.type === "private";
  const isPrivateFolderView = activeList?.type === "folder" && activeList.scope === "private";
  const isPrivateView = isPrivateRootView || isPrivateFolderView;
  const privateScopeUrl =
    activeList?.type === "private"
      ? activeList.serverUrl
      : isPrivateFolderView
        ? activeList.serverUrl ?? null
        : null;
  const hasPrivateFiles = privateBlobs.length > 0;
  const activeFolder = activeList?.type === "folder" ? activeList : null;
  const activePrivateServer = privateScopeUrl ? serverByUrl.get(privateScopeUrl) : undefined;
  const privateFolderPath = activeFolder?.scope === "private" ? activeFolder.path : "";

  const excludeListedBlobs = useCallback(
    (source: BlossomBlob[]) => source.filter(blob => !entriesBySha.has(blob.sha256)),
    [entriesBySha]
  );

  useEffect(() => {
    onBrowseTabChange(active ? "browse" : "");
  }, [active, onBrowseTabChange]);

  useEffect(() => {
    if (!active) return;
    if (!isFilterMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      onCloseFilterMenu();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      onCloseFilterMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseFilterMenu();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, filterMenuRef, isFilterMenuOpen, onCloseFilterMenu]);

  useEffect(() => {
    clearSelection();
  }, [clearSelection, selectedServer, isPrivateView, isSearching]);

  useEffect(() => {
    if (!isPrivateRootView) return;
    if (privateScopeUrl !== normalizedSelectedServer) {
      setActiveList(null);
    }
  }, [isPrivateRootView, privateScopeUrl, normalizedSelectedServer]);

  useEffect(() => {
    if (isPrivateView && !hasPrivateFiles) {
      setActiveList(null);
    }
  }, [hasPrivateFiles, isPrivateView]);

  useEffect(() => {
    if (!homeResetKey) return;
    setActiveList(null);
  }, [homeResetKey]);

  useEffect(() => {
    if (!activeFolder) return;
    if (activeFolder.scope === "aggregated" && selectedServer) {
      setActiveList(null);
      return;
    }
    if (activeFolder.scope === "server") {
      if (!selectedServer) {
        setActiveList(null);
        return;
      }
      if (normalizeServerUrl(selectedServer) !== (activeFolder.serverUrl ? normalizeServerUrl(activeFolder.serverUrl) : undefined)) {
        setActiveList(null);
      }
    }
  }, [activeFolder, selectedServer]);

  useEffect(() => () => {
    playbackUrlCacheRef.current.forEach(url => {
      if (typeof url === "string" && url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore revoke failures
        }
      }
    });
    playbackUrlCacheRef.current.clear();
  }, []);

  const privatePlaceholderBlob = useMemo(() => {
    if (!hasPrivateFiles || isPrivateView) return null;
    const newestPrivateUpload = privateBlobs.reduce((max, blob) => {
      const value = typeof blob.uploaded === "number" ? blob.uploaded : 0;
      return value > max ? value : max;
    }, 0);
    return {
      sha256: PRIVATE_PLACEHOLDER_SHA,
      name: PRIVATE_SERVER_NAME,
      serverUrl: selectedServer ?? undefined,
      serverType: "blossom",
      requiresAuth: false,
      type: "application/x-directory",
      uploaded: newestPrivateUpload || Math.floor(Date.now() / 1000),
      url: undefined,
      label: PRIVATE_SERVER_NAME,
    } as BlossomBlob;
  }, [hasPrivateFiles, isPrivateView, privateBlobs, selectedServer]);

  const hasPrivateMatchingFilter = useMemo(() => {
    if (!hasPrivateFiles) return false;
    if (filterMode === "all" && !isSearching) return true;
    return privateBlobs.some(blob => matchesFilter(blob, filterMode) && matchesSearch(blob));
  }, [filterMode, hasPrivateFiles, isSearching, matchesSearch, privateBlobs]);

  const openPrivateList = useCallback(() => {
    setActiveList({ type: "private", serverUrl: normalizedSelectedServer });
    onSetTab("browse");
    clearSelection();
  }, [clearSelection, normalizedSelectedServer, onSetTab]);

  const openFolderFromInfo = useCallback(
    (info: { scope: FolderScope; path: string; serverUrl?: string | null }) => {
      const normalizedPath = info.path ?? "";
      if (!normalizedPath) {
        if (info.scope === "private") {
          setActiveList({ type: "private", serverUrl: info.serverUrl ?? null });
        } else {
          setActiveList(null);
        }
      } else {
        setActiveList({
          type: "folder",
          scope: info.scope,
          path: normalizedPath,
          serverUrl: info.serverUrl ?? null,
        });
      }
      onSetTab("browse");
      clearSelection();
    },
    [clearSelection, onSetTab]
  );

  const isPlaceholderSha = useCallback(
    (sha: string) => sha === PRIVATE_PLACEHOLDER_SHA,
    []
  );

  const isPlaceholderBlob = useCallback(
    (blob: BlossomBlob) => blob.sha256 === PRIVATE_PLACEHOLDER_SHA,
    []
  );

  const privateSearchMatches = useMemo(() => {
    if (!isSearching) return [] as BlossomBlob[];
    const base =
      filterMode === "all"
        ? privateBlobs
        : privateBlobs.filter(blob => matchesFilter(blob, filterMode));
    return base.filter(matchesSearch);
  }, [filterMode, isSearching, matchesSearch, privateBlobs]);

  const aggregatedFilteredBlobs = useMemo(() => {
    const base =
      filterMode === "all"
        ? aggregated.blobs
        : aggregated.blobs.filter(blob => matchesFilter(blob, filterMode));
    const filtered = excludeListedBlobs(base);
    if (!isSearching) return filtered;
    const matches = filtered.filter(matchesSearch);
    if (privateSearchMatches.length === 0) {
      return matches;
    }
    const merged = matches.slice();
    const seen = new Set(merged.map(blob => blob.sha256));
    privateSearchMatches.forEach(blob => {
      if (seen.has(blob.sha256)) return;
      seen.add(blob.sha256);
      merged.push(blob);
    });
    return merged;
  }, [aggregated.blobs, excludeListedBlobs, filterMode, isSearching, matchesSearch, privateSearchMatches]);

  const aggregatedFolderIndex = useMemo(() => buildFolderIndex(aggregatedFilteredBlobs), [aggregatedFilteredBlobs]);

  const aggregatedFolderPath = activeFolder?.scope === "aggregated" ? activeFolder.path : "";

  const visibleAggregatedBlobs = useMemo(() => {
    if (hasActiveFilter) {
      if (!isSearching && privatePlaceholderBlob && hasPrivateMatchingFilter) {
        return [privatePlaceholderBlob, ...aggregatedFilteredBlobs];
      }
      return aggregatedFilteredBlobs;
    }
    const { list } = buildFolderViewFromIndex(aggregatedFolderIndex, aggregatedFilteredBlobs, {
      activePath: aggregatedFolderPath,
      scope: "aggregated",
      resolveFolderName: getFolderDisplayName,
    });
    if (!aggregatedFolderPath && privatePlaceholderBlob && hasPrivateMatchingFilter) {
      return [privatePlaceholderBlob, ...list];
    }
    return list;
  }, [
    aggregatedFilteredBlobs,
    aggregatedFolderIndex,
    aggregatedFolderPath,
    hasActiveFilter,
    hasPrivateMatchingFilter,
    isSearching,
    privatePlaceholderBlob,
    getFolderDisplayName,
  ]);

  const privateScopedBlobs = useMemo(() => {
    if (!hasPrivateFiles) return [] as BlossomBlob[];
    if (!privateScopeUrl) return privateBlobs;

    const filtered = privateBlobs.filter(blob => {
      const serversForBlob = blob.privateData?.servers;
      if (serversForBlob && serversForBlob.length) {
        return serversForBlob.some(url => normalizeServerUrl(url) === privateScopeUrl);
      }
      const fallback = normalizeMaybeServerUrl(blob.serverUrl);
      return fallback === privateScopeUrl;
    });

    const targetServer = serverByUrl.get(privateScopeUrl);
    if (!targetServer) {
      return filtered.map(blob => {
        const currentNormalized = normalizeMaybeServerUrl(blob.serverUrl);
        if (currentNormalized === privateScopeUrl) {
          return blob;
        }
        const baseUrl = privateScopeUrl;
        return {
          ...blob,
          serverUrl: baseUrl,
          url: `${baseUrl}/${blob.sha256}`,
        };
      });
    }

    const targetBaseUrl = normalizeServerUrl(targetServer.url);

    return filtered.map(blob => ({
      ...blob,
      serverUrl: targetBaseUrl,
      url: `${targetBaseUrl}/${blob.sha256}`,
      serverType: targetServer.type,
      requiresAuth: Boolean(targetServer.requiresAuth),
      label: targetServer.name ?? blob.label,
    }));
  }, [hasPrivateFiles, privateBlobs, privateScopeUrl, serverByUrl]);

  const privateVisibleBlobs = useMemo(() => {
    const byFilter =
      filterMode === "all"
        ? privateScopedBlobs
        : privateScopedBlobs.filter(blob => matchesFilter(blob, filterMode));
    if (!isSearching) return byFilter;
    return byFilter.filter(matchesSearch);
  }, [filterMode, isSearching, matchesSearch, privateScopedBlobs]);

  const privateFolderIndex = useMemo(() => buildFolderIndex(privateVisibleBlobs), [privateVisibleBlobs]);

  const visiblePrivateBlobs = useMemo(() => {
    if (!isPrivateView || hasActiveFilter) return privateVisibleBlobs;
    const { list } = buildFolderViewFromIndex(privateFolderIndex, privateVisibleBlobs, {
      activePath: privateFolderPath,
      scope: "private",
      serverUrl: privateScopeUrl,
      serverType: activePrivateServer?.type,
      requiresAuth: activePrivateServer ? Boolean(activePrivateServer.requiresAuth) : undefined,
      resolveFolderName: getFolderDisplayName,
    });
    return list;
  }, [
    activePrivateServer,
    isPrivateView,
    hasActiveFilter,
    privateFolderPath,
    privateScopeUrl,
    privateVisibleBlobs,
    privateFolderIndex,
    getFolderDisplayName,
  ]);

  const currentFilteredBlobs = useMemo(() => {
    if (!currentSnapshot) return undefined;
    const base =
      filterMode === "all"
        ? currentSnapshot.blobs
        : currentSnapshot.blobs.filter(blob => matchesFilter(blob, filterMode));
    const filtered = excludeListedBlobs(base);
    if (!isSearching) return filtered;
    const matches = filtered.filter(matchesSearch);
    if (privateSearchMatches.length === 0) {
      return matches;
    }
    const merged = matches.slice();
    const seen = new Set(merged.map(blob => blob.sha256));
    privateSearchMatches.forEach(blob => {
      if (seen.has(blob.sha256)) return;
      seen.add(blob.sha256);
      merged.push(blob);
    });
    return merged;
  }, [currentSnapshot, excludeListedBlobs, filterMode, isSearching, matchesSearch, privateSearchMatches]);

  const currentFolderIndex = useMemo(
    () => (currentFilteredBlobs ? buildFolderIndex(currentFilteredBlobs) : null),
    [currentFilteredBlobs]
  );

  const currentFolderPath = activeFolder?.scope === "server" ? activeFolder.path : "";

  const currentVisibleBlobs = useMemo(() => {
    if (!currentFilteredBlobs) return undefined;
    const serverInfo = currentSnapshot?.server;
    if (hasActiveFilter) {
      if (!isSearching && !currentFolderPath && privatePlaceholderBlob && hasPrivateMatchingFilter) {
        return [privatePlaceholderBlob, ...currentFilteredBlobs];
      }
      return currentFilteredBlobs;
    }
    const index = currentFolderIndex ?? buildFolderIndex(currentFilteredBlobs);
    const { list } = buildFolderViewFromIndex(index, currentFilteredBlobs, {
      activePath: currentFolderPath,
      scope: "server",
      serverUrl: serverInfo ? normalizeServerUrl(serverInfo.url) : null,
      serverType: serverInfo?.type,
      requiresAuth: serverInfo ? Boolean(serverInfo.requiresAuth) : undefined,
      resolveFolderName: getFolderDisplayName,
    });
    if (!currentFolderPath && privatePlaceholderBlob && hasPrivateMatchingFilter) {
      return [privatePlaceholderBlob, ...list];
    }
    return list;
  }, [
    currentFilteredBlobs,
    currentFolderPath,
    currentSnapshot,
    hasActiveFilter,
    hasPrivateMatchingFilter,
    isSearching,
    privatePlaceholderBlob,
    currentFolderIndex,
    getFolderDisplayName,
  ]);

  const resolveBlobBySha = useCallback(
    (sha: string): BlossomBlob | null => {
      if (!sha) return null;
      const normalized = sha.trim();
      if (!normalized) return null;
      const sources: (readonly BlossomBlob[] | undefined | null)[] = [
        aggregated.blobs,
        currentSnapshot?.blobs,
        currentVisibleBlobs,
        visibleAggregatedBlobs,
        privateBlobs,
        privateVisibleBlobs,
      ];
      for (const source of sources) {
        if (!source) continue;
        const match = source.find(candidate => candidate?.sha256 === normalized);
        if (match) {
          return match;
        }
      }
      return null;
    },
    [aggregated.blobs, currentSnapshot, currentVisibleBlobs, visibleAggregatedBlobs, privateBlobs, privateVisibleBlobs]
  );

  const queueMetadataSync = useCallback(
    (targets: MetadataSyncTarget[], context?: MetadataSyncContext) => {
      if (!ndk || !signer) return;
      if (!Array.isArray(targets) || targets.length === 0) return;
      const publicTargets = targets.filter(target => target && !target.blob.privateData);
      if (publicTargets.length === 0) return;
      void (async () => {
        let successCount = 0;
        let failureCount = 0;
        for (const target of publicTargets) {
          try {
            const alias = getBlobMetadataName(target.blob) ?? target.blob.name ?? null;
            const extraTags = extractExtraNip94Tags(target.blob.nip94);
            await publishNip94Metadata({
              ndk,
              signer,
              blob: target.blob,
              relays: effectiveRelays,
              alias,
              folderPath: target.folderPath,
              extraTags,
            });
            successCount += 1;
          } catch (error) {
            failureCount += 1;
            console.warn("Failed to sync NIP-94 metadata", target.blob.sha256, error);
          }
        }
        if (failureCount === 0) {
          if (context?.successMessage) {
            showStatusMessage(context.successMessage(successCount), "success", 3000);
          }
        } else {
          const message = context?.errorMessage
            ? context.errorMessage(failureCount)
            : failureCount === 1
              ? "Failed to sync metadata to relays."
              : `Failed to sync metadata for ${failureCount} items.`;
          showStatusMessage(message, "error", 4500);
        }
      })();
    },
    [effectiveRelays, ndk, showStatusMessage, signer]
  );

  useEffect(() => {
    if (!hasPrivateFiles) {
      autoPrivateNavigationRef.current = null;
      return;
    }

    const hasVisibleNonPrivateMatches = isPrivateView
      ? false
      : browsingAllServers
        ? aggregatedFilteredBlobs.length > 0
        : (currentFilteredBlobs?.length ?? 0) > 0;

    if (isSearching && hasPrivateMatchingFilter && !isPrivateView && !hasVisibleNonPrivateMatches) {
      if (!autoPrivateNavigationRef.current) {
        autoPrivateNavigationRef.current = { previous: activeList ?? null };
      }
      openPrivateList();
      return;
    }

    if (autoPrivateNavigationRef.current && (!isSearching || !hasPrivateMatchingFilter)) {
      const previous = autoPrivateNavigationRef.current.previous ?? null;
      autoPrivateNavigationRef.current = null;
      setActiveList(previous);
    }
  }, [
    activeList,
    aggregatedFilteredBlobs,
    browsingAllServers,
    currentFilteredBlobs,
    hasPrivateFiles,
    hasPrivateMatchingFilter,
    isPrivateView,
    isSearching,
    openPrivateList,
  ]);

  const folderPlaceholderInfo = useMemo(() => {
    const map = new Map<string, { scope: FolderScope; path: string; serverUrl?: string | null }>();
    const register = (list?: readonly BlossomBlob[]) => {
      if (!list) return;
      list.forEach(blob => {
        if (blob.__bloomFolderPlaceholder) {
          map.set(blob.sha256, {
            scope: blob.__bloomFolderScope ?? "aggregated",
            path: blob.__bloomFolderTargetPath ?? "",
            serverUrl: blob.serverUrl ?? null,
          });
        }
      });
    };
    register(visibleAggregatedBlobs);
    register(currentVisibleBlobs);
    if (isPrivateView) {
      register(visiblePrivateBlobs);
    }
    return map;
  }, [isPrivateView, visiblePrivateBlobs, visibleAggregatedBlobs, currentVisibleBlobs]);

  const extractFolderInfo = (blob: BlossomBlob) => {
    if (!blob.__bloomFolderPlaceholder) return null;
    return {
      scope: blob.__bloomFolderScope ?? "aggregated",
      path: blob.__bloomFolderTargetPath ?? "",
      serverUrl: blob.serverUrl ?? null,
    } as { scope: FolderScope; path: string; serverUrl?: string | null };
  };

  const formatFolderLabel = useCallback((value: string | null) => {
    if (!value) return "Home";
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0) return "Home";
    return segments.join(" / ");
  }, []);

  const formatPrivateFolderLabel = useCallback((value: string | null) => {
    if (!value) return "Private";
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0) return "Private";
    return `Private / ${segments.join(" / ")}`;
  }, []);

  const formatMoveDestinationLabel = useCallback(
    (value: string | null, isPrivate: boolean) =>
      isPrivate ? formatPrivateFolderLabel(value) : formatFolderLabel(value),
    [formatFolderLabel, formatPrivateFolderLabel]
  );

  const moveDestinations = useMemo(() => {
    const paths = new Set<string>();
    folders.forEach(record => {
      const normalized = normalizeFolderPathInput(record.path) ?? null;
      if (!normalized) return;
      const name = deriveNameFromPath(normalized);
      if (isPrivateFolderName(name)) return;
      const canonical = resolveFolderPath(normalized);
      paths.add(canonical);
    });
    return Array.from(paths).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [folders, resolveFolderPath]);

  const privateMoveDestinations = useMemo(() => {
    const paths = new Set<string>();
    privateBlobs.forEach(blob => {
      const normalized = normalizeFolderPathInput(blob.folderPath ?? undefined);
      if (!normalized) return;
      let current: string | null = normalized;
      while (current && !paths.has(current)) {
        paths.add(current);
        current = getParentFolderPath(current);
        if (current === "") {
          current = null;
        }
      }
    });
    return Array.from(paths).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [privateBlobs]);

  const moveDialogOptions = useMemo(() => {
    if (moveState?.isPrivate) {
      const options: Array<{ value: string | null; label: string; disabled?: boolean }> = [
        { value: null, label: "Private" },
        ...privateMoveDestinations.map(path => ({
          value: path,
          label: formatPrivateFolderLabel(path),
        })),
        { value: NEW_FOLDER_OPTION_VALUE, label: "New folder…" },
      ];
      if (moveState.kind === "folder") {
        const currentPath = moveState.path;
        return options.map(option => {
          if (!option.value) return option;
          if (option.value === NEW_FOLDER_OPTION_VALUE) return option;
          if (option.value === currentPath || option.value.startsWith(`${currentPath}/`)) {
            return { ...option, disabled: true };
          }
          return option;
        });
      }
      return options;
    }

    const options: Array<{ value: string | null; label: string; disabled?: boolean }> = [
      { value: null, label: "Home" },
      ...moveDestinations.map(path => ({
        value: path,
        label: formatFolderLabel(path),
      })),
      { value: NEW_FOLDER_OPTION_VALUE, label: "New folder…" },
    ];

    if (moveState?.kind === "folder") {
      const currentPath = moveState.path;
      return options.map(option => {
        if (!option.value) return option;
        if (option.value === NEW_FOLDER_OPTION_VALUE) return option;
        if (option.value === currentPath || option.value.startsWith(`${currentPath}/`)) {
          return { ...option, disabled: true };
        }
        return option;
      });
    }

    return options;
  }, [formatFolderLabel, formatPrivateFolderLabel, moveDestinations, moveState, privateMoveDestinations]);

  const blobVariantsBySha = useMemo(() => {
    const map = new Map<string, BlossomBlob[]>();
    const register = (blob: BlossomBlob | null | undefined) => {
      if (!blob?.sha256) return;
      const key = blob.sha256.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        const alreadyPresent = existing.some(entry => {
          if (entry === blob) return true;
          const sameUrl = entry.url && blob.url ? entry.url === blob.url : false;
          const sameServer = entry.serverUrl && blob.serverUrl ? entry.serverUrl === blob.serverUrl : false;
          return sameUrl && sameServer;
        });
        if (!alreadyPresent) {
          existing.push(blob);
        }
      } else {
        map.set(key, [blob]);
      }
    };

    aggregated.blobs.forEach(register);
    snapshots.forEach(snapshot => {
      snapshot.blobs.forEach(register);
    });
    privateBlobs.forEach(register);

    return map;
  }, [aggregated.blobs, snapshots, privateBlobs]);

  const collectFolderBlobs = useCallback(
    (scope: FolderScope, normalizedPath: string, serverUrl?: string | null) => {
      const sanitizedPath = normalizedPath ?? "";
      const normalizedServer = serverUrl ? normalizeServerUrl(serverUrl) : null;
      const hasUrl = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
      const normalizePath = (value?: string | null) => normalizeFolderPathInput(value ?? undefined) ?? "";

      const mergeWithFallback = (primary: BlossomBlob, fallback: BlossomBlob): BlossomBlob => {
        if (primary === fallback) return primary;
        const merged: BlossomBlob = { ...primary };
        const applyFallback = <K extends keyof BlossomBlob>(key: K) => {
          const current = merged[key];
          const isMissing =
            current === undefined ||
            current === null ||
            (typeof current === "string" && current.trim().length === 0);
          if (!isMissing) return;
          const fallbackValue = fallback[key];
          if (fallbackValue !== undefined) {
            (merged as BlossomBlob)[key] = fallbackValue as BlossomBlob[K];
          }
        };

        (["url", "serverUrl", "serverType", "requiresAuth", "size", "type", "name", "label", "uploaded", "infohash", "magnet", "nip94"] as (keyof BlossomBlob)[]).forEach(applyFallback);
        return merged;
      };

      const resolveSharableBlob = (blob: BlossomBlob): BlossomBlob => {
        if (!blob.sha256) return blob;
        if (hasUrl(blob.url)) return blob;
        const variants = blobVariantsBySha.get(blob.sha256.toLowerCase());
        if (!variants?.length) return blob;
        const withUrl = variants.filter(candidate => hasUrl(candidate.url));
        if (!withUrl.length) return blob;

        const blobPath = normalizePath(blob.folderPath);
        const matchesPath = (candidate: BlossomBlob) => normalizePath(candidate.folderPath) === (sanitizedPath || blobPath);
        const matchesServer = (candidate: BlossomBlob) =>
          normalizedServer ? normalizeMaybeServerUrl(candidate.serverUrl) === normalizedServer : true;

        const pickCandidate =
          withUrl.find(candidate => matchesServer(candidate) && matchesPath(candidate) && candidate.requiresAuth !== true) ??
          withUrl.find(candidate => matchesServer(candidate) && candidate.requiresAuth !== true) ??
          withUrl.find(candidate => matchesPath(candidate) && candidate.requiresAuth !== true) ??
          withUrl.find(candidate => matchesServer(candidate)) ??
          withUrl.find(candidate => matchesPath(candidate)) ??
          withUrl.find(candidate => candidate.requiresAuth !== true) ??
          withUrl[0];

        if (!pickCandidate) return blob;
        return mergeWithFallback(blob, pickCandidate);
      };

      const matchesPath = (blob: BlossomBlob) => {
        if (blob.__bloomFolderPlaceholder) return false;
        if (blob.__bloomFolderScope === "private") return false;
        const blobPath = normalizeFolderPathInput(blob.folderPath ?? undefined) ?? "";
        return blobPath === sanitizedPath;
      };
      const matchesServer = (blob: BlossomBlob) => {
        if (!normalizedServer) return true;
        const blobServer = blob.serverUrl ? normalizeServerUrl(blob.serverUrl) : null;
        return blobServer === normalizedServer;
      };

      let source: readonly BlossomBlob[] = aggregated.blobs;
      if (scope === "server") {
        if (normalizedServer && currentSnapshot?.server && normalizeMaybeServerUrl(currentSnapshot.server.url) === normalizedServer) {
          source = currentSnapshot.blobs;
        } else if (normalizedServer) {
          source = aggregated.blobs.filter(blob => matchesServer(blob));
        } else if (currentSnapshot?.blobs) {
          source = currentSnapshot.blobs;
        }
      }

      const deduped = new Map<string, BlossomBlob>();
      source.forEach(blob => {
        if (!matchesPath(blob)) return;
        if (!matchesServer(blob)) return;
        if (!blob.sha256) return;
        const key = blob.sha256.toLowerCase();
        const resolved = resolveSharableBlob(blob);
        const existing = deduped.get(key);
        if (!existing) {
          deduped.set(key, resolved);
          return;
        }
        const existingHasUrl = hasUrl(existing.url);
        const resolvedHasUrl = hasUrl(resolved.url);
        const existingPublic = existing.requiresAuth !== true;
        const resolvedPublic = resolved.requiresAuth !== true;
        if (
          (!existingHasUrl && resolvedHasUrl) ||
          (existingHasUrl === resolvedHasUrl && !existingPublic && resolvedPublic)
        ) {
          deduped.set(key, mergeWithFallback(resolved, existing));
        }
      });
      return Array.from(deduped.values());
    },
    [aggregated.blobs, blobVariantsBySha, currentSnapshot, normalizeMaybeServerUrl]
  );

  const handleShareFolderHint = useCallback(
    (hint: FolderShareHint) => {
      const normalizedPath = normalizeFolderPathInput(hint.path ?? undefined) ?? "";
      if (!normalizedPath) return;
      const blobs = collectFolderBlobs(hint.scope, normalizedPath, hint.serverUrl ?? null);
      onShareFolder({
        path: normalizedPath,
        scope: hint.scope,
        serverUrl: hint.serverUrl ?? null,
        blobs,
      });
    },
    [collectFolderBlobs, onShareFolder]
  );

  const handleUnshareFolderHint = useCallback(
    (hint: FolderShareHint) => {
      const normalizedPath = normalizeFolderPathInput(hint.path ?? undefined) ?? "";
      if (!normalizedPath) return;
      const blobs = collectFolderBlobs(hint.scope, normalizedPath, hint.serverUrl ?? null);
      onUnshareFolder({
        path: normalizedPath,
        scope: hint.scope,
        serverUrl: hint.serverUrl ?? null,
        blobs,
      });
    },
    [collectFolderBlobs, onUnshareFolder]
  );

  const isPrivateAggregated = isPrivateView && !privateScopeUrl;

  const privateSnapshot = useMemo(() => {
    if (!isPrivateView || isPrivateAggregated) return null;
    if (currentSnapshot) {
      return {
        ...currentSnapshot,
        blobs: privateVisibleBlobs,
      };
    }
    if (!privateScopeUrl) return null;
    const server = serverByUrl.get(privateScopeUrl);
    if (!server) return null;
    return {
      server,
      blobs: privateVisibleBlobs,
      isLoading: false,
      isError: false,
      error: null,
    };
  }, [currentSnapshot, isPrivateAggregated, isPrivateView, privateScopeUrl, privateVisibleBlobs, serverByUrl]);

  const privateReplicaInfo = useMemo(() => {
    if (!isPrivateView) return undefined;
    const map = new Map<string, BlobReplicaSummary>();
    privateVisibleBlobs.forEach(blob => {
      const urls = new Set<string>();
      const privateServers = blob.privateData?.servers ?? [];
      privateServers.forEach(url => {
        const normalized = normalizeMaybeServerUrl(url);
        if (normalized) urls.add(normalized);
      });
      const fallback = normalizeMaybeServerUrl(blob.serverUrl);
      if (fallback) urls.add(fallback);
      if (urls.size === 0 && privateScopeUrl) urls.add(privateScopeUrl);
      if (urls.size === 0) return;
      const servers = Array.from(urls).map(url => {
        const server = serverByUrl.get(url);
        const name = server?.name ?? server?.url ?? url;
        return { url, name };
      });
      map.set(blob.sha256, { count: servers.length, servers });
    });
    return map;
  }, [isPrivateView, privateVisibleBlobs, privateScopeUrl, serverByUrl]);

  const effectiveBrowsingAllServers = isPrivateView ? isPrivateAggregated : browsingAllServers;
  const effectiveAggregatedBlobs = isPrivateView && isPrivateAggregated ? visiblePrivateBlobs : visibleAggregatedBlobs;
  const effectiveCurrentSnapshot = isPrivateView
    ? isPrivateAggregated
      ? undefined
      : privateSnapshot ?? currentSnapshot
    : currentSnapshot;
  const effectiveCurrentVisibleBlobs = isPrivateView ? visiblePrivateBlobs : currentVisibleBlobs;
  const effectiveReplicaInfo = isPrivateView ? privateReplicaInfo : blobReplicaInfo;

  const activeServerForPrivate = isPrivateView ? activePrivateServer ?? privateSnapshot?.server : undefined;

  const effectiveSignTemplate = signEventTemplate as SignTemplate | undefined;

  const statusCount = isPrivateView
    ? privateVisibleBlobs.length
    : currentSnapshot
    ? currentVisibleBlobs?.length ?? 0
    : visibleAggregatedBlobs.length;
  const statusSize = isPrivateView
    ? privateVisibleBlobs.reduce((acc, blob) => acc + (blob.size || 0), 0)
    : currentSnapshot
    ? (currentVisibleBlobs ?? []).reduce((acc, blob) => acc + (blob.size || 0), 0)
    : visibleAggregatedBlobs.reduce((acc, blob) => acc + (blob.size || 0), 0);

  useEffect(() => {
    onStatusMetricsChange({ count: statusCount, size: statusSize });
  }, [onStatusMetricsChange, statusCount, statusSize]);

  const handleToggleBlob = useCallback(
    (sha: string) => {
      if (isPlaceholderSha(sha)) {
        openPrivateList();
        return;
      }
      const folderTarget = folderPlaceholderInfo.get(sha);
      if (folderTarget) {
        openFolderFromInfo(folderTarget);
        return;
      }
      toggleBlob(sha);
    },
    [folderPlaceholderInfo, isPlaceholderSha, openFolderFromInfo, openPrivateList, toggleBlob]
  );

  const handleSelectManyBlobs = useCallback(
    (shas: string[], value: boolean) => {
      if (shas.some(isPlaceholderSha)) {
        openPrivateList();
        return;
      }
      const folderTarget = shas
        .map(sha => folderPlaceholderInfo.get(sha))
        .find((info): info is { scope: FolderScope; path: string; serverUrl?: string | null } => Boolean(info));
      if (folderTarget) {
        openFolderFromInfo(folderTarget);
        return;
      }
      selectManyBlobs(shas, value);
    },
    [folderPlaceholderInfo, isPlaceholderSha, openFolderFromInfo, openPrivateList, selectManyBlobs]
  );

  const musicQueueSource = useMemo(() => {
    if (isPrivateView) {
      return privateVisibleBlobs;
    }
    if (isSearching) {
      return aggregatedFilteredBlobs;
    }
    return excludeListedBlobs(aggregated.blobs);
  }, [aggregated.blobs, aggregatedFilteredBlobs, excludeListedBlobs, isPrivateView, isSearching, privateVisibleBlobs]);

  const resolvePlaybackUrl = useCallback(
    async (blob: BlossomBlob) => {
      const cacheKey = `audio:${blob.sha256}`;
      const cached = playbackUrlCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const baseUrl = blob.url;
      if (!baseUrl) {
        throw new Error("Track source unavailable.");
      }

      const effectiveServerType = blob.serverType ?? "blossom";
      const requiresAuth = Boolean(blob.requiresAuth);
      const encryption = blob.privateData?.encryption;

      if (!requiresAuth && !encryption) {
        playbackUrlCacheRef.current.set(cacheKey, baseUrl);
        return baseUrl;
      }

      const headers: Record<string, string> = {};
      if (requiresAuth) {
        if (!signEventTemplate) {
          throw new Error("Connect your signer to play this track.");
        }
        if (effectiveServerType === "nip96") {
          headers.Authorization = await buildNip98AuthHeader(signEventTemplate, {
            url: baseUrl,
            method: "GET",
          });
        } else {
          let resource: URL | null = null;
          try {
            resource = new URL(baseUrl, window.location.href);
          } catch {
            resource = null;
          }
          headers.Authorization = await buildAuthorizationHeader(signEventTemplate, "get", {
            hash: blob.sha256,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob.serverUrl,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 600,
          });
        }
      }

      const response = await fetch(baseUrl, {
        headers,
        mode: "cors",
      });
      if (!response.ok) {
        throw new Error(`Playback request failed (${response.status})`);
      }

      let audioBlob: Blob;
      if (encryption) {
        if (encryption.algorithm !== "AES-GCM") {
          throw new Error(`Unsupported encryption algorithm: ${encryption.algorithm}`);
        }
        const encryptedBuffer = await response.arrayBuffer();
        const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
          algorithm: "AES-GCM",
          key: encryption.key,
          iv: encryption.iv,
          originalName: blob.privateData?.metadata?.name,
          originalType: blob.privateData?.metadata?.type,
          originalSize: blob.privateData?.metadata?.size,
        });
        const mimeType =
          blob.privateData?.metadata?.type ||
          blob.type ||
          response.headers.get("content-type") ||
          "audio/mpeg";
        audioBlob = new Blob([decryptedBuffer], { type: mimeType });
      } else {
        audioBlob = await response.blob();
      }

      const existing = playbackUrlCacheRef.current.get(cacheKey);
      if (existing && existing.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(existing);
        } catch {
          // ignore revoke errors
        }
      }
      const objectUrl = URL.createObjectURL(audioBlob);
      playbackUrlCacheRef.current.set(cacheKey, objectUrl);
      return objectUrl;
    },
    [signEventTemplate]
  );

  const resolveCoverArtUrl = useCallback(
    async (blob: BlossomBlob, coverUrl?: string | null, coverEntry?: PrivateListEntry | null) => {
      if (!coverUrl) return undefined;
      if (coverUrl.startsWith("data:")) return coverUrl;

      const coverSha = coverEntry?.sha256;
      const cacheKey = coverSha ? `cover:${coverSha}` : `cover:${blob.sha256}:${coverUrl}`;
      const cached = playbackUrlCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const effectiveServerType = blob.serverType ?? "blossom";
      const requiresAuth = Boolean(blob.requiresAuth || coverEntry?.encryption);
      const encryption = coverEntry?.encryption;

      const headers: Record<string, string> = {};
      if (requiresAuth && signEventTemplate) {
        if (effectiveServerType === "nip96") {
          headers.Authorization = await buildNip98AuthHeader(signEventTemplate, {
            url: coverUrl,
            method: "GET",
          });
        } else {
          let resource: URL | null = null;
          try {
            resource = new URL(coverUrl, window.location.href);
          } catch {
            resource = null;
          }
          headers.Authorization = await buildAuthorizationHeader(signEventTemplate, "get", {
            hash: coverSha,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob.serverUrl,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 300,
          });
        }
      } else if (requiresAuth && !signEventTemplate) {
        throw new Error("Connect your signer to view private cover art.");
      }

      const response = await fetch(coverUrl, {
        headers,
        mode: "cors",
      });
      if (!response.ok) {
        throw new Error(`Cover art request failed (${response.status})`);
      }

      let imageBlob: Blob;
      if (encryption) {
        if (encryption.algorithm !== "AES-GCM") {
          throw new Error(`Unsupported encryption algorithm: ${encryption.algorithm}`);
        }
        const encryptedBuffer = await response.arrayBuffer();
        const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
          algorithm: "AES-GCM",
          key: encryption.key,
          iv: encryption.iv,
          originalName: coverEntry?.metadata?.name,
          originalType: coverEntry?.metadata?.type,
          originalSize: coverEntry?.metadata?.size,
        });
        const mimeType =
          coverEntry?.metadata?.type ||
          response.headers.get("content-type") ||
          "image/jpeg";
        imageBlob = new Blob([decryptedBuffer], { type: mimeType });
      } else {
        imageBlob = await response.blob();
      }

      const existing = playbackUrlCacheRef.current.get(cacheKey);
      if (existing && existing.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(existing);
        } catch {
          // ignore revoke errors
        }
      }
      const objectUrl = URL.createObjectURL(imageBlob);
      playbackUrlCacheRef.current.set(cacheKey, objectUrl);
      return objectUrl;
    },
    [signEventTemplate]
  );

  const buildTrackForBlob = useCallback(
    async (blob: BlossomBlob) => {
      if (!isMusicBlob(blob)) return null;
      const url = await resolvePlaybackUrl(blob);
      const metadata = metadataMap.get(blob.sha256);
      let coverEntry: PrivateListEntry | null = null;
      const coverUrl = metadata?.coverUrl;
      if (coverUrl) {
        const coverSha = extractSha256FromUrl(coverUrl);
        if (coverSha) {
          coverEntry = entriesBySha.get(coverSha) ?? null;
        }
      }
      const track = createAudioTrack(blob, metadata, url);
      if (!track) return null;
      if (metadata?.coverUrl) {
        try {
          const resolvedCover = await resolveCoverArtUrl(blob, metadata.coverUrl, coverEntry);
          if (resolvedCover) {
            track.coverUrl = resolvedCover;
          }
        } catch (error) {
          console.warn("Cover art unavailable", error);
        }
      }
      return track;
    },
    [entriesBySha, metadataMap, resolveCoverArtUrl, resolvePlaybackUrl]
  );

  const buildQueueForPlayback = useCallback(
    async (focusBlob: BlossomBlob, existingFocusTrack?: Track | null) => {
      const source = musicQueueSource.length ? musicQueueSource : [focusBlob];
      const tracks: Track[] = [];
      const seenKeys = new Set<string>();

      const registerTrack = (track: Track | null | undefined) => {
        if (!track) return;
        const key = track.id ?? track.url;
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        tracks.push(track);
      };

      if (existingFocusTrack) {
        registerTrack(existingFocusTrack);
      }

      const existingFocusId = existingFocusTrack?.id ?? null;
      for (const item of source) {
        if (existingFocusId && item.sha256 === existingFocusId) continue;
        try {
          const track = await buildTrackForBlob(item);
          registerTrack(track);
        } catch (error) {
          console.warn("Failed to prepare track", error);
        }
      }

      let focusTrack = existingFocusTrack ?? tracks.find(track => track.id === focusBlob.sha256) ?? null;
      if (!focusTrack) {
        try {
          focusTrack = await buildTrackForBlob(focusBlob);
          registerTrack(focusTrack);
        } catch (error) {
          console.warn("Unable to prepare selected track", error);
        }
      }

      return { focusTrack, queue: tracks };
    },
    [buildTrackForBlob, musicQueueSource]
  );

  const handleDeleteBlob = useCallback(
    async (blob: BlossomBlob) => {
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        if (blob.__bloomFolderIsParentLink) {
          openFolderFromInfo(folderInfo);
          return;
        }

        if (folderInfo.scope === "private") {
          showStatusMessage("Deleting private folders is not supported yet.", "info", 3000);
          return;
        }

        const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined);
        if (!normalizedPath) {
          showStatusMessage("Cannot delete the root folder.", "error", 3000);
          return;
        }

        const record = foldersByPath.get(normalizedPath);
        if (!record) {
          showStatusMessage("Folder details unavailable.", "error", 3000);
          return;
        }

        const itemCount = record.shas.length;
        const displayName = getFolderDisplayName(normalizedPath) || record.name || normalizedPath;
        const message = itemCount
          ? `Delete folder "${displayName}" and move ${itemCount === 1 ? "its item" : `${itemCount} items`} to Home?`
          : `Delete folder "${displayName}"?`;
        const confirmed = await confirm({
          title: "Delete folder",
          message,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          tone: "danger",
        });
        if (!confirmed) return;

        try {
          const deletedRecord = await deleteFolder(normalizedPath);
          const shasToClear = deletedRecord?.shas ?? record.shas;

          if (shasToClear.length) {
            const blobLookup = new Map<string, BlossomBlob>();
            const register = (items?: readonly BlossomBlob[] | null) => {
              if (!items) return;
              items.forEach(item => {
                if (!item || !item.sha256) return;
                if (!blobLookup.has(item.sha256)) {
                  blobLookup.set(item.sha256, item);
                }
              });
            };

            register(aggregated.blobs);
            register(currentSnapshot?.blobs ?? null);
            register(currentVisibleBlobs ?? null);
            register(visibleAggregatedBlobs);
            register(privateBlobs);
            register(privateVisibleBlobs);

            const metadataTargets: MetadataSyncTarget[] = [];

            shasToClear.forEach(sha => {
              const target = blobLookup.get(sha);
              applyFolderUpdate(target?.serverUrl, sha, null, undefined);
              if (target && !target.privateData) {
                metadataTargets.push({ blob: target, folderPath: null });
              }
            });

            if (metadataTargets.length) {
              queueMetadataSync(metadataTargets, {
                successMessage: count =>
                  count === 1 ? "Synced metadata for 1 item." : `Synced metadata for ${count} items.`,
                errorMessage: failureCount =>
                  failureCount === 1
                    ? "Failed to sync metadata to relays."
                    : `Failed to sync metadata for ${failureCount} items.`,
              });
            }
          }

          if (activeList?.type === "folder" && normalizeFolderPathInput(activeList.path) === normalizedPath) {
            const parentPath = getParentFolderPath(normalizedPath);
            if (parentPath) {
              setActiveList({
                type: "folder",
                scope: folderInfo.scope,
                path: parentPath,
                serverUrl: folderInfo.serverUrl ?? null,
              });
            } else {
              setActiveList(null);
            }
          }

          clearSelection();
          showStatusMessage("Folder deleted. Syncing metadata…", "success", 3000);
        } catch (error: any) {
          const message = error?.message || "Failed to delete folder.";
          showStatusMessage(message, "error", 4000);
        }
        return;
      }
      if (isPlaceholderBlob(blob)) {
        if (!hasPrivateFiles) {
          showStatusMessage("There are no private files to delete.", "info", 2000);
          return;
        }
        const confirmed = await confirm({
          title: "Delete private files",
          message: "Delete all files in your Private list?",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          tone: "danger",
        });
        if (!confirmed) return;
        const shas = privateEntries.map(entry => entry.sha256);
        try {
          await removeEntries(shas);
          setActiveList(null);
          clearSelection();
          showStatusMessage("Private list deleted", "success", 2000);
        } catch (error: any) {
          console.warn("Failed to delete private list", error);
          showStatusMessage(error?.message || "Failed to delete private list", "error", 4000);
        }
        return;
      }
      if (!isPrivateView && !currentSnapshot) {
        showStatusMessage("Select a specific server to delete files.", "error", 2000);
        return;
      }
      const targetServer = isPrivateView ? activeServerForPrivate : currentSnapshot?.server;
      if (!targetServer) {
        showStatusMessage("Select a server to manage private files.", "error", 3000);
        return;
      }
      const confirmed = await confirm({
        title: "Delete file",
        message: `Delete ${blob.sha256.slice(0, 10)}… from ${targetServer.name}?`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        tone: "danger",
      });
      if (!confirmed) return;
      const requiresSigner = Boolean(targetServer.requiresAuth);
      if (requiresSigner && !signer) {
        showStatusMessage("Connect your signer to delete from this server.", "error", 2000);
        return;
      }
      try {
        const signTemplateForDelete = requiresSigner ? (signEventTemplate as SignTemplate | undefined) : undefined;
        await performDelete(
          blob,
          signTemplateForDelete,
          targetServer.type,
          targetServer.url,
          requiresSigner
        );
        if (entriesBySha.has(blob.sha256)) {
          try {
            await removeEntries([blob.sha256]);
          } catch (error) {
            console.warn("Failed to update private list after delete", error);
          }
        }
        if (pubkey) {
          queryClient.invalidateQueries({
            queryKey: ["server-blobs", targetServer.url, pubkey, targetServer.type],
          });
        }
        if (!isPrivateView && blob.folderPath) {
          try {
            await removeBlobFromFolder(blob.folderPath, blob.sha256);
          } catch (error) {
            console.warn("Failed to update folder list after delete", error);
          }
        }
        selectManyBlobs([blob.sha256], false);
        showStatusMessage("Blob deleted", "success", 2000);
      } catch (error: any) {
        showStatusMessage(error?.message || "Delete failed", "error", 5000);
      }
    },
    [
      activeList,
      activeServerForPrivate,
      aggregated.blobs,
      clearSelection,
      currentSnapshot,
      currentVisibleBlobs,
      deleteFolder,
      entriesBySha,
      extractFolderInfo,
      foldersByPath,
      getFolderDisplayName,
      hasPrivateFiles,
      isPlaceholderBlob,
      isPrivateView,
      openFolderFromInfo,
      privateBlobs,
      privateEntries,
      privateVisibleBlobs,
      pubkey,
      queryClient,
      removeBlobFromFolder,
      removeEntries,
      confirm,
      selectManyBlobs,
      setActiveList,
      showStatusMessage,
      signEventTemplate,
      signer,
      visibleAggregatedBlobs,
    ]
  );

  const handleCopyUrl = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        openFolderFromInfo(folderInfo);
        return;
      }
      if (!blob.url) return;
      navigator.clipboard.writeText(blob.url).catch(() => undefined);
      showStatusMessage("URL copied to clipboard", "success", 1500);
    },
    [extractFolderInfo, isPlaceholderBlob, openFolderFromInfo, openPrivateList, showStatusMessage]
  );

  const handleShareBlob = useCallback(
    (blob: BlossomBlob, options?: { mode?: ShareMode }) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        if (blob.__bloomFolderIsParentLink || folderInfo.scope === "private") {
          openFolderFromInfo(folderInfo);
          return;
        }
        const normalizedPath = normalizeFolderPathInput(folderInfo.path ?? undefined) ?? "";
        if (!normalizedPath) {
          openFolderFromInfo(folderInfo);
          return;
        }
        const shareHint: FolderShareHint = {
          path: normalizedPath,
          scope: folderInfo.scope === "server" ? "server" : "aggregated",
          serverUrl: folderInfo.serverUrl ?? null,
        };
        handleShareFolderHint(shareHint);
        return;
      }
      if (!blob.url) {
        showStatusMessage("This file does not have a shareable URL.", "error", 3000);
        return;
      }
      if (options?.mode === "private-link" && privateLinkServiceConfigured) {
        const existingLink = findExistingPrivateLink(blob);
        if (existingLink) {
          const linkUrl = `${privateLinkHost}/${existingLink.alias}`;
          const sharePayload: SharePayload = {
            url: linkUrl,
            name: getBlobMetadataName(blob),
            sha256: blob.sha256,
            serverUrl: blob.serverUrl ?? null,
            size: typeof blob.size === "number" ? blob.size : null,
          };
          onRequestShare(sharePayload);
          onSetTab("share");
          return;
        }
      }
      const payload: SharePayload = {
        url: blob.url,
        name: getBlobMetadataName(blob),
        sha256: blob.sha256,
        serverUrl: blob.serverUrl ?? null,
        size: typeof blob.size === "number" ? blob.size : null,
      };
      onRequestShare(payload, options);
      onSetTab(options?.mode === "private-link" ? "share-private" : "share");
    },
    [
      extractFolderInfo,
      handleShareFolderHint,
      isPlaceholderBlob,
      onRequestShare,
      onSetTab,
      openFolderFromInfo,
      openPrivateList,
      showStatusMessage,
      findExistingPrivateLink,
      privateLinkServiceConfigured,
      privateLinkHost,
    ]
  );

  const handlePlayBlob = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        openFolderFromInfo(folderInfo);
        return;
      }
      if (audio.current?.id === blob.sha256) {
        audio.toggle(audio.current, audio.queue);
        return;
      }
      void (async () => {
        try {
          const focusTrack = await buildTrackForBlob(blob);
          if (!focusTrack) {
            showStatusMessage("Unable to play this track.", "error", 4000);
            return;
          }
          const requestKey = focusTrack.id ?? focusTrack.url;
          lastPlayRequestRef.current = requestKey;
          audio.toggle(focusTrack, [focusTrack]);
          void (async () => {
            try {
              const { queue } = await buildQueueForPlayback(blob, focusTrack);
              if (!queue.length) return;
              const currentKey = requestKey;
              if (!currentKey) return;
              if (lastPlayRequestRef.current !== currentKey) return;
              if (audio.current && audio.current.url !== focusTrack.url) return;
              audio.replaceQueue(queue);
            } catch (error) {
              console.warn("Failed to build playback queue", error);
            }
          })();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Playback failed.";
          showStatusMessage(message, "error", 4000);
        }
      })();
    },
    [
      audio,
      buildQueueForPlayback,
      buildTrackForBlob,
      extractFolderInfo,
      isPlaceholderBlob,
      openFolderFromInfo,
      openPrivateList,
      showStatusMessage,
    ]
  );

  const handleMoveRequest = useCallback(
    (blob: BlossomBlob) => {
      if (blob.__bloomFolderPlaceholder) {
        if (blob.__bloomFolderIsParentLink) {
          return;
        }
        const scope = blob.__bloomFolderScope ?? "aggregated";
        const normalizedPath = normalizeFolderPathInput(blob.__bloomFolderTargetPath ?? undefined);
        if (scope === "private") {
          if (!normalizedPath) {
            showStatusMessage("Unable to determine the folder location.", "error", 4000);
            return;
          }
          const folderName =
            blob.name?.trim().length ? blob.name.trim() : normalizedPath.split("/").pop() ?? normalizedPath;
          const parentPathRaw = getParentFolderPath(normalizedPath);
          const parentPath = parentPathRaw && parentPathRaw.length > 0 ? parentPathRaw : null;
          setMoveError(null);
          setMoveBusy(false);
          setMoveState({
            kind: "folder",
            path: normalizedPath,
            name: folderName,
            currentParent: parentPath,
            scope,
            isPrivate: true,
          });
          return;
        }
        if (!normalizedPath) {
          showStatusMessage("Unable to determine the folder location.", "error", 4000);
          return;
        }
        const canonicalPath = resolveFolderPath(normalizedPath);
        const folderName = getFolderDisplayName(canonicalPath) || canonicalPath.split("/").pop() || canonicalPath;
        const parentPathRaw = getParentFolderPath(canonicalPath);
        const parentPath = parentPathRaw && parentPathRaw.length > 0 ? resolveFolderPath(parentPathRaw) : null;
        setMoveError(null);
        setMoveBusy(false);
        setMoveState({
          kind: "folder",
          path: canonicalPath,
          name: folderName,
          currentParent: parentPath,
          scope: blob.__bloomFolderScope ?? "aggregated",
          isPrivate: false,
        });
        return;
      }

      if (isListLikeBlob(blob)) {
        const folderInfo = extractFolderInfo(blob);
        const scope = folderInfo?.scope ?? "aggregated";
        const normalizedPath = normalizeFolderPathInput(folderInfo?.path ?? blob.folderPath ?? undefined);
        if (scope === "private") {
          if (!normalizedPath) {
            showStatusMessage("This folder cannot be moved.", "error", 4000);
            return;
          }
          const folderName =
            blob.name?.trim().length ? blob.name.trim() : normalizedPath.split("/").pop() ?? normalizedPath;
          const parentPathRaw = getParentFolderPath(normalizedPath);
          const parentPath = parentPathRaw && parentPathRaw.length > 0 ? parentPathRaw : null;
          setMoveError(null);
          setMoveBusy(false);
          setMoveState({
            kind: "folder",
            path: normalizedPath,
            name: folderName,
            currentParent: parentPath,
            scope,
            isPrivate: true,
          });
          return;
        }
        if (!normalizedPath) {
          showStatusMessage("This folder cannot be moved.", "error", 4000);
          return;
        }
        const canonicalPath = resolveFolderPath(normalizedPath);
        const folderName = getFolderDisplayName(canonicalPath) || canonicalPath.split("/").pop() || canonicalPath;
        const parentPathRaw = getParentFolderPath(canonicalPath);
        const parentPath = parentPathRaw && parentPathRaw.length > 0 ? resolveFolderPath(parentPathRaw) : null;
        setMoveError(null);
        setMoveBusy(false);
        setMoveState({
          kind: "folder",
          path: canonicalPath,
          name: folderName,
          currentParent: parentPath,
          scope,
          isPrivate: false,
        });
        return;
      }

      if (blob.privateData) {
        const entry = entriesBySha.get(blob.sha256);
        const normalizedPath =
          normalizeFolderPathInput(entry?.metadata?.folderPath ?? blob.folderPath ?? undefined) ?? null;
        if (!entry) {
          showStatusMessage("Unable to locate private file details.", "error", 4000);
          return;
        }
        setMoveError(null);
        setMoveBusy(false);
        setMoveState({ kind: "blob", blob, currentPath: normalizedPath, isPrivate: true });
        return;
      }

      const memberships = getFoldersForBlob(blob.sha256);
      const currentPath = memberships[0] ?? null;
      setMoveError(null);
      setMoveBusy(false);
      setMoveState({ kind: "blob", blob, currentPath, isPrivate: false });
    },
    [entriesBySha, extractFolderInfo, getFolderDisplayName, getFoldersForBlob, isListLikeBlob, resolveFolderPath, showStatusMessage]
  );

  const handleMoveSubmit = useCallback(
    async (destination: MoveDialogDestination) => {
      if (!moveState) return;
      setMoveBusy(true);
      setMoveError(null);

      const canonicalize = (value: string | null) => {
        if (!value) return null;
        if (moveState.isPrivate) {
          return value;
        }
        const resolved = resolveFolderPath(value);
        return resolved ? resolved : null;
      };

      try {
        const resolveDestinationValue = (): string | null => {
          if (destination.kind === "new") {
            const normalized = normalizeFolderPathInput(destination.path);
            if (!normalized) {
              throw new Error("Enter a valid folder path.");
            }
            return normalized;
          }
          return destination.target ?? null;
        };

        const rawDestination = resolveDestinationValue();

        if (moveState.kind === "blob") {
          if (moveState.isPrivate) {
            const targetCanonical = canonicalize(rawDestination);
            const currentCanonical = canonicalize(moveState.currentPath);
            if ((currentCanonical ?? null) === (targetCanonical ?? null)) {
              setMoveState(null);
              return;
            }
            const entry = entriesBySha.get(moveState.blob.sha256);
            if (!entry) {
              throw new Error("Unable to locate private file details.");
            }
            const updatedEntry: PrivateListEntry = {
              sha256: entry.sha256,
              encryption: entry.encryption,
              metadata: {
                ...(entry.metadata ?? {}),
                folderPath: targetCanonical,
              },
              servers: entry.servers,
              updatedAt: Math.floor(Date.now() / 1000),
            };
            await upsertEntries([updatedEntry]);
            const destinationLabel = formatPrivateFolderLabel(targetCanonical);
            showStatusMessage(`Moved to ${destinationLabel}.`, "success", 2500);
            setMoveState(null);
            setMoveError(null);
          } else {
            const targetCanonical = canonicalize(rawDestination);
            const currentCanonical = canonicalize(moveState.currentPath);
            if ((currentCanonical ?? null) === (targetCanonical ?? null)) {
              setMoveState(null);
              return;
          }
          await setBlobFolderMembership(moveState.blob.sha256, targetCanonical);
          const destinationLabel = formatFolderLabel(targetCanonical);
          showStatusMessage(`Moved to ${destinationLabel}. Syncing metadata…`, "success", 3000);
          queueMetadataSync(
            [{ blob: moveState.blob, folderPath: targetCanonical ?? null }],
            {
              successMessage: () => "Folder metadata synced across relays.",
              errorMessage: failureCount =>
                failureCount === 1 ? "Failed to sync metadata to relays." : `Failed to sync metadata for ${failureCount} items.`,
            }
          );
          setMoveState(null);
          setMoveError(null);
        }
        } else {
          const targetCanonical = canonicalize(rawDestination);
          const currentCanonical = moveState.path;
          const currentParentCanonical = canonicalize(moveState.currentParent);

          if ((currentParentCanonical ?? null) === (targetCanonical ?? null)) {
            setMoveState(null);
            return;
          }

          if (targetCanonical && (targetCanonical === currentCanonical || targetCanonical.startsWith(`${currentCanonical}/`))) {
            throw new Error("Choose a destination outside this folder.");
          }

          const folderName = currentCanonical.split("/").pop() ?? currentCanonical;
          const nextPath = targetCanonical ? `${targetCanonical}/${folderName}` : folderName;

          if (moveState.isPrivate) {
            const nowSeconds = Math.floor(Date.now() / 1000);
            const updates: PrivateListEntry[] = [];
            privateEntries.forEach(entry => {
              const entryPath = normalizeFolderPathInput(entry.metadata?.folderPath ?? undefined);
              if (!entryPath) return;
              if (entryPath === currentCanonical || entryPath.startsWith(`${currentCanonical}/`)) {
                const suffix = entryPath.slice(currentCanonical.length).replace(/^\/+/, "");
                const updatedPath = suffix ? `${nextPath}/${suffix}` : nextPath;
                updates.push({
                  sha256: entry.sha256,
                  encryption: entry.encryption,
                  metadata: {
                    ...(entry.metadata ?? {}),
                    folderPath: updatedPath,
                  },
                  servers: entry.servers,
                  updatedAt: nowSeconds,
                });
              }
            });

            if (!updates.length) {
              throw new Error("Unable to locate private folder contents.");
            }

            await upsertEntries(updates);

            const destinationLabel = formatPrivateFolderLabel(targetCanonical);
            showStatusMessage(`Folder moved to ${destinationLabel}.`, "success", 2500);

            if (activeList?.type === "folder" && activeList.scope === "private") {
              if (activeList.path === currentCanonical) {
                setActiveList({
                  ...activeList,
                  path: nextPath,
                });
              } else if (activeList.path.startsWith(`${currentCanonical}/`)) {
                const suffix = activeList.path.slice(currentCanonical.length).replace(/^\/+/, "");
                const updatedActivePath = suffix ? `${nextPath}/${suffix}` : nextPath;
                setActiveList({
                  ...activeList,
                  path: updatedActivePath,
                });
              }
            }

            setMoveState(null);
            setMoveError(null);
          } else {
            const impactedRecords = Array.from(foldersByPath.values()).filter(record => {
              if (!currentCanonical) return false;
              return record.path === currentCanonical || record.path.startsWith(`${currentCanonical}/`);
            });
            const metadataTargetMap = new Map<string, MetadataSyncTarget>();
            const computeTargetPath = (recordPath: string) => {
              if (!currentCanonical) return nextPath;
              if (recordPath === currentCanonical) return nextPath;
              if (recordPath.startsWith(`${currentCanonical}/`)) {
                const suffix = recordPath.slice(currentCanonical.length).replace(/^\/+/, "");
                if (!suffix) return nextPath;
                return nextPath ? `${nextPath}/${suffix}` : suffix;
              }
              return nextPath;
            };
            impactedRecords.forEach(record => {
              const targetPathRaw = computeTargetPath(record.path);
              const targetPath = targetPathRaw && targetPathRaw.length > 0 ? targetPathRaw : null;
              record.shas.forEach(sha => {
                if (!sha) return;
                const existing = metadataTargetMap.get(sha);
                if (existing) {
                  existing.folderPath = targetPath;
                  return;
                }
                const blob = resolveBlobBySha(sha);
                if (!blob || blob.privateData) return;
                metadataTargetMap.set(sha, { blob, folderPath: targetPath });
              });
            });
            const metadataTargets = Array.from(metadataTargetMap.values());

            await renameFolder(currentCanonical, nextPath);

            const destinationLabel = formatFolderLabel(targetCanonical);
            showStatusMessage(`Folder moved to ${destinationLabel}. Syncing metadata…`, "success", 3000);
            if (metadataTargets.length) {
              queueMetadataSync(metadataTargets, {
                successMessage: count =>
                  count === 1 ? "Synced metadata for 1 item." : `Synced metadata for ${count} items.`,
                errorMessage: failureCount =>
                  failureCount === 1
                    ? "Failed to sync metadata to relays."
                    : `Failed to sync metadata for ${failureCount} items.`,
              });
            }

            if (activeList?.type === "folder") {
              const activeCanonical = resolveFolderPath(activeList.path);
              if (activeCanonical === currentCanonical) {
                const resolvedNext = resolveFolderPath(nextPath);
                setActiveList({
                  ...activeList,
                  path: resolvedNext,
                });
              }
            }

            setMoveState(null);
            setMoveError(null);
          }
        }
      } catch (error) {
        setMoveError(error instanceof Error ? error.message : "Unable to move item.");
        return;
      } finally {
        setMoveBusy(false);
      }
    },
    [
      activeList,
      entriesBySha,
      formatFolderLabel,
      formatPrivateFolderLabel,
      moveState,
      privateEntries,
      renameFolder,
      resolveFolderPath,
      setActiveList,
      setBlobFolderMembership,
      showStatusMessage,
      upsertEntries,
    ]
  );

  const closeMoveDialog = useCallback(() => {
    if (moveBusy) return;
    setMoveState(null);
    setMoveError(null);
  }, [moveBusy]);

  const handleRenameBlob = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        if (folderInfo.scope === "private") {
          openFolderFromInfo(folderInfo);
          return;
        }
        if (folderInfo.path) {
          onRequestFolderRename(folderInfo.path);
          return;
        }
        return;
      }
      onRequestRename(blob);
    },
    [
      extractFolderInfo,
      isPlaceholderBlob,
      onRequestFolderRename,
      onRequestRename,
      openFolderFromInfo,
      openPrivateList,
    ]
  );

  const handleOpenListBlob = useCallback(
    (blob: BlossomBlob) => {
      if (isPlaceholderBlob(blob)) {
        openPrivateList();
        return;
      }
      const folderInfo = extractFolderInfo(blob);
      if (folderInfo) {
        openFolderFromInfo(folderInfo);
      }
    },
    [extractFolderInfo, isPlaceholderBlob, openFolderFromInfo, openPrivateList]
  );

  const navigateHome = useCallback(() => {
    setActiveList(null);
    clearSelection();
  }, [clearSelection]);

  const navigateUp = useCallback(() => {
    setActiveList(prev => {
      if (!prev) return prev;
      if (prev.type === "private") {
        return null;
      }
      if (prev.type === "folder") {
        const parentPath = getParentFolderPath(prev.path);
        if (prev.scope === "private") {
          if (parentPath === null || parentPath === "") {
            return { type: "private", serverUrl: prev.serverUrl ?? null };
          }
          return {
            type: "folder",
            scope: "private",
            path: parentPath,
            serverUrl: prev.serverUrl ?? null,
          };
        }
        if (parentPath === null || parentPath === "") {
          return null;
        }
        return {
          type: "folder",
          scope: prev.scope,
          path: parentPath,
          serverUrl: prev.serverUrl ?? null,
        };
      }
      return prev;
    });
    clearSelection();
  }, [clearSelection, setActiveList]);

  const breadcrumbSegments = useMemo<BrowseNavigationSegment[]>(() => {
    if (isSearching || !activeList) return [];
    const segments: BrowseNavigationSegment[] = [];

    if (activeList.type === "private") {
      segments.push({
        id: `private-root:${activeList.serverUrl ?? "all"}`,
        label: PRIVATE_SERVER_NAME,
        onNavigate: () => {
          openPrivateList();
        },
      });
      return segments;
    }

    if (activeList.type === "folder") {
      if (activeList.scope === "private") {
        segments.push({
          id: `private-root:${activeList.serverUrl ?? "all"}`,
          label: PRIVATE_SERVER_NAME,
          onNavigate: () => {
            openPrivateList();
          },
        });
      }

      const pathSegments = activeList.path ? activeList.path.split("/") : [];
      pathSegments.forEach((segment, index) => {
        const targetPath = pathSegments.slice(0, index + 1).join("/");
        const label = getFolderDisplayName(targetPath) || segment;
        const id = `${activeList.scope}:${targetPath || "__root__"}:${activeList.serverUrl ?? "all"}`;
        const canonicalPath = resolveFolderPath(targetPath);
        const record = canonicalPath ? foldersByPath.get(canonicalPath) ?? null : null;
        segments.push({
          id,
          label,
          onNavigate: () => {
            openFolderFromInfo({
              scope: activeList.scope,
              path: targetPath,
              serverUrl: activeList.serverUrl ?? null,
            });
          },
          visibility: record?.visibility ?? null,
        });
      });

      return segments;
    }

    return segments;
  }, [activeList, foldersByPath, getFolderDisplayName, isSearching, openFolderFromInfo, openPrivateList]);

  const navigationState = useMemo<BrowseNavigationState>(() => ({
    segments: breadcrumbSegments,
    canNavigateUp: Boolean(activeList) && !isSearching,
    onNavigateHome: navigateHome,
    onNavigateUp: navigateUp,
  }), [activeList, breadcrumbSegments, isSearching, navigateHome, navigateUp]);

  useEffect(() => {
    onNavigationChange?.(navigationState);
  }, [navigationState, onNavigationChange]);

  useEffect(() => {
    return () => {
      onNavigationChange?.(null);
    };
  }, [onNavigationChange]);

  const moveDialogInitialValue = moveState
    ? moveState.kind === "folder"
      ? moveState.currentParent ?? null
      : moveState.currentPath ?? null
    : null;

  const moveDialogCurrentLocation = moveState
    ? moveState.kind === "folder"
      ? formatMoveDestinationLabel(moveState.currentParent, moveState.isPrivate)
      : formatMoveDestinationLabel(moveState.currentPath, moveState.isPrivate)
    : "Home";

  const moveDialogItemLabel = moveState
    ? moveState.kind === "folder"
      ? moveState.name
      : getBlobMetadataName(moveState.blob) ?? moveState.blob.name ?? moveState.blob.sha256
    : "";

  const moveDialogItemPath =
    moveState?.kind === "folder"
      ? formatMoveDestinationLabel(moveState.path, moveState.isPrivate)
      : undefined;

  const moveDialogDestinationHint = moveState?.isPrivate
    ? "Private items can only be moved within Private."
    : "Only non-private folders are available as destinations.";

  const moveDialogNewFolderDefault = moveState?.isPrivate ? "Trips" : "Images/Trips";

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading library…
            </div>
          }
        >
          <BrowsePanelLazy
            viewMode={viewMode}
            browsingAllServers={effectiveBrowsingAllServers}
            aggregatedBlobs={effectiveAggregatedBlobs}
            currentSnapshot={effectiveCurrentSnapshot}
          currentVisibleBlobs={effectiveCurrentVisibleBlobs}
          selectedBlobs={selectedBlobs}
          signTemplate={effectiveSignTemplate}
          replicaInfo={effectiveReplicaInfo}
          onToggle={handleToggleBlob}
          onSelectMany={handleSelectManyBlobs}
          onDelete={handleDeleteBlob}
          onCopy={handleCopyUrl}
          onShare={handleShareBlob}
          onRename={handleRenameBlob}
          onMove={handleMoveRequest}
          onPlay={handlePlayBlob}
          currentTrackUrl={audio.current?.url}
          currentTrackStatus={audio.status}
          filterMode={filterMode}
          showGridPreviews={showGridPreviews}
          showListPreviews={showListPreviews}
          onOpenList={handleOpenListBlob}
          defaultSortOption={defaultSortOption}
          sortDirection={sortDirection}
          folderRecords={foldersByPath}
          onShareFolder={handleShareFolderHint}
          onUnshareFolder={handleUnshareFolderHint}
          folderShareBusyPath={folderShareBusyPath}
        />
        </Suspense>
      </div>
      {moveState ? (
        <MoveDialog
          itemType={moveState.kind === "folder" ? "folder" : "file"}
          itemLabel={moveDialogItemLabel}
          currentLocationLabel={moveDialogCurrentLocation}
          itemPathLabel={moveDialogItemPath}
          options={moveDialogOptions}
          initialValue={moveDialogInitialValue}
          busy={moveBusy}
          error={moveError}
          onSubmit={handleMoveSubmit}
          onCancel={closeMoveDialog}
          createNewOptionValue={NEW_FOLDER_OPTION_VALUE}
          newFolderDefaultPath={moveDialogNewFolderDefault}
          destinationHint={moveDialogDestinationHint}
        />
      ) : null}
    </div>
  );
};

const performDelete = async (
  blob: BlossomBlob,
  signTemplate: SignTemplate | undefined,
  serverType: ManagedServer["type"],
  serverUrl: string,
  requiresSigner: boolean
) => {
  if (serverType === "nip96") {
    await deleteNip96File(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
    return;
  }
  if (serverType === "satellite") {
    await deleteSatelliteFile(serverUrl, blob.sha256, signTemplate, true);
    return;
  }
  await deleteUserBlob(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
};
