import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FilterMode } from "../../types/filter";
import { useWorkspace } from "./WorkspaceContext";
import { useSelection } from "../selection/SelectionContext";
import { usePrivateLibrary } from "../../context/PrivateLibraryContext";
import { useFolderLists } from "../../context/FolderListContext";
import { useAudio } from "../../context/AudioContext";
import { matchesFilter, createAudioTrack } from "../browse/browseUtils";
import { useAudioMetadataMap } from "../browse/useAudioMetadata";
import type { StatusMessageTone } from "../../types/status";
import type { SharePayload } from "../../components/ShareComposer";
import type { BlossomBlob, SignTemplate } from "../../lib/blossomClient";
import { extractSha256FromUrl } from "../../lib/blossomClient";
import type { ManagedServer } from "../../hooks/useServers";
import type { TabId } from "../../types/tabs";
import { deleteUserBlob, buildAuthorizationHeader } from "../../lib/blossomClient";
import { deleteNip96File } from "../../lib/nip96Client";
import { deleteSatelliteFile } from "../../lib/satelliteClient";
import { useNdk, useCurrentPubkey } from "../../context/NdkContext";
import { isMusicBlob } from "../../utils/blobClassification";
import { PRIVATE_PLACEHOLDER_SHA, PRIVATE_SERVER_NAME } from "../../constants/private";
import { applyFolderUpdate, normalizeFolderPathInput } from "../../utils/blobMetadataStore";
import type { BlobAudioMetadata } from "../../utils/blobMetadataStore";
import type { BlobReplicaSummary } from "../../components/BlobList";
import type { DefaultSortOption } from "../../context/UserPreferencesContext";
import { buildNip98AuthHeader } from "../../lib/nip98";
import { decryptPrivateBlob } from "../../lib/privateEncryption";
import type { Track } from "../../context/AudioContext";
import type { PrivateListEntry } from "../../lib/privateList";

const BrowsePanelLazy = React.lazy(() =>
  import("../browse/BrowseTab").then(module => ({ default: module.BrowsePanel }))
);

const normalizeServerUrl = (value: string) => value.replace(/\/+$/, "");

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

const buildFolderView = (
  blobs: readonly BlossomBlob[],
  options: BuildFolderViewOptions
): { list: BlossomBlob[]; parentPath: string | null } => {
  const index = buildFolderIndex(blobs);
  const targetPath = options.activePath;
  const node = index.get(targetPath) ?? index.get("");
  if (!node) {
    return { list: blobs.slice(), parentPath: null };
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
  onRequestShare: (payload: SharePayload) => void;
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
  onNavigationChange?: (navigation: BrowseNavigationState | null) => void;
  searchTerm: string;
};

type ActiveListState =
  | { type: "private"; serverUrl: string | null }
  | { type: "folder"; scope: FolderScope; path: string; serverUrl?: string | null };

export type BrowseNavigationSegment = {
  id: string;
  label: string;
  onNavigate: () => void;
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
  onNavigationChange,
  searchTerm,
}) => {
  const {
    aggregated,
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
  const { signer, signEventTemplate } = useNdk();
  const pubkey = useCurrentPubkey();
  const { entriesBySha, removeEntries } = usePrivateLibrary();
  const { deleteFolder, foldersByPath, getFolderDisplayName, removeBlobFromFolder } = useFolderLists();
  const [activeList, setActiveList] = useState<ActiveListState | null>(null);
  const playbackUrlCacheRef = useRef(new Map<string, string>());
  const autoPrivateNavigationRef = useRef<{ previous: ActiveListState | null } | null>(null);

  const metadataSource = useMemo(() => [...aggregated.blobs, ...privateBlobs], [aggregated.blobs, privateBlobs]);
  const metadataMap = useAudioMetadataMap(metadataSource);

  const searchQuery = useMemo(() => parseSearchQuery(searchTerm), [searchTerm]);
  const isSearching = searchQuery.isActive;

  const matchesSearch = useCallback(
    (blob: BlossomBlob) => {
      if (!searchQuery.isActive) return true;

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

  const aggregatedFilteredBlobs = useMemo(() => {
    const base =
      filterMode === "all"
        ? aggregated.blobs
        : aggregated.blobs.filter(blob => matchesFilter(blob, filterMode));
    const filtered = excludeListedBlobs(base);
    if (!isSearching) return filtered;
    return filtered.filter(matchesSearch);
  }, [aggregated.blobs, excludeListedBlobs, filterMode, isSearching, matchesSearch]);

  const aggregatedFolderPath = activeFolder?.scope === "aggregated" ? activeFolder.path : "";

  const visibleAggregatedBlobs = useMemo(() => {
    if (hasActiveFilter) {
      if (privatePlaceholderBlob && hasPrivateMatchingFilter) {
        return [privatePlaceholderBlob, ...aggregatedFilteredBlobs];
      }
      return aggregatedFilteredBlobs;
    }
    const { list } = buildFolderView(aggregatedFilteredBlobs, {
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
    aggregatedFolderPath,
    hasActiveFilter,
    hasPrivateMatchingFilter,
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

  const visiblePrivateBlobs = useMemo(() => {
    if (!isPrivateView || hasActiveFilter) return privateVisibleBlobs;
    const { list } = buildFolderView(privateVisibleBlobs, {
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
    return filtered.filter(matchesSearch);
  }, [currentSnapshot, excludeListedBlobs, filterMode, isSearching, matchesSearch]);

  const currentFolderPath = activeFolder?.scope === "server" ? activeFolder.path : "";

  const currentVisibleBlobs = useMemo(() => {
    if (!currentFilteredBlobs) return undefined;
    const serverInfo = currentSnapshot?.server;
    if (hasActiveFilter) {
      if (!currentFolderPath && privatePlaceholderBlob && hasPrivateMatchingFilter) {
        return [privatePlaceholderBlob, ...currentFilteredBlobs];
      }
      return currentFilteredBlobs;
    }
    const { list } = buildFolderView(currentFilteredBlobs, {
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
    privatePlaceholderBlob,
    getFolderDisplayName,
  ]);

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
      const requiresAuth =
        effectiveServerType === "satellite"
          ? false
          : Boolean(blob.requiresAuth);
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
      const requiresAuth =
        effectiveServerType === "satellite"
          ? false
          : Boolean(blob.requiresAuth || coverEntry?.encryption);
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
    async (focusBlob: BlossomBlob) => {
      const source = musicQueueSource.length ? musicQueueSource : [focusBlob];
      const tracks: Track[] = [];

      for (const item of source) {
        try {
          const track = await buildTrackForBlob(item);
          if (track && !tracks.some(existing => existing.id === track.id)) {
            tracks.push(track);
          }
        } catch (error) {
          console.warn("Failed to prepare track", error);
        }
      }

      let focusTrack = tracks.find(track => track.id === focusBlob.sha256) ?? null;
      if (!focusTrack) {
        try {
          focusTrack = await buildTrackForBlob(focusBlob);
          if (focusTrack) {
            tracks.push(focusTrack);
          }
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
        const prompt = itemCount
          ? `Delete folder "${displayName}" and move ${itemCount === 1 ? "its item" : `${itemCount} items`} to Home?`
          : `Delete folder "${displayName}"?`;
        if (!window.confirm(prompt)) return;

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

            shasToClear.forEach(sha => {
              const target = blobLookup.get(sha);
              applyFolderUpdate(target?.serverUrl, sha, null, undefined);
            });
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
          showStatusMessage("Folder deleted", "success", 2500);
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
        const confirmed = window.confirm("Delete all files in your Private list?");
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
      const confirmed = window.confirm(
        `Delete ${blob.sha256.slice(0, 10)}… from ${targetServer.name}?`
      );
      if (!confirmed) return;
      const requiresSigner =
        targetServer.type === "satellite" || Boolean(targetServer.requiresAuth);
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
      if (!blob.url) {
        showStatusMessage("This file does not have a shareable URL.", "error", 3000);
        return;
      }
      const payload: SharePayload = {
        url: blob.url,
        name: blob.name ?? null,
        sha256: blob.sha256,
        serverUrl: blob.serverUrl ?? null,
        size: typeof blob.size === "number" ? blob.size : null,
      };
      onRequestShare(payload);
      onSetTab("share");
    },
    [extractFolderInfo, isPlaceholderBlob, onRequestShare, onSetTab, openFolderFromInfo, openPrivateList, showStatusMessage]
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
      void (async () => {
        try {
          const { focusTrack, queue } = await buildQueueForPlayback(blob);
          if (!focusTrack) {
            showStatusMessage("Unable to play this track.", "error", 4000);
            return;
          }
          audio.toggle(focusTrack, queue);
        } catch (error) {
      const message = error instanceof Error ? error.message : "Playback failed.";
      showStatusMessage(message, "error", 4000);
    }
  })();
},
    [
      audio,
      buildQueueForPlayback,
      extractFolderInfo,
      isPlaceholderBlob,
      openFolderFromInfo,
      openPrivateList,
      showStatusMessage,
    ]
  );

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
        });
      });

      return segments;
    }

    return segments;
  }, [activeList, getFolderDisplayName, isSearching, openFolderFromInfo, openPrivateList]);

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
            onPlay={handlePlayBlob}
            currentTrackUrl={audio.current?.url}
            currentTrackStatus={audio.status}
            filterMode={filterMode}
            showGridPreviews={showGridPreviews}
            showListPreviews={showListPreviews}
            onOpenList={handleOpenListBlob}
            defaultSortOption={defaultSortOption}
          />
        </Suspense>
      </div>
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
    await deleteSatelliteFile(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
    return;
  }
  await deleteUserBlob(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
};
