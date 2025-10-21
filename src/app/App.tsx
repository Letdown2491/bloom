import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useNdk, useCurrentPubkey } from "./context/NdkContext";
import { useNip46 } from "./context/Nip46Context";
import { useFolderLists } from "./context/FolderListContext";
import { useAudio } from "./context/AudioContext";
import {
  useUserPreferences,
  type DefaultSortOption,
  type SortDirection,
} from "./context/UserPreferencesContext";
import { useDialog } from "./context/DialogContext";
import { useSyncPipeline } from "./context/SyncPipelineContext";
import type { ManagedServer } from "./hooks/useServers";
import { useServers, sortServersByName } from "./hooks/useServers";
import { usePreferredRelays } from "./hooks/usePreferredRelays";
import { useAliasSync } from "./hooks/useAliasSync";
import { useIsCompactScreen } from "../shared/hooks/useIsCompactScreen";
import { useShareWorkflow } from "../features/share/useShareWorkflow";
import { useSelection } from "../features/selection/SelectionContext";
import { LoggedOutPrompt } from "./components/LoggedOutPrompt";
import { MainNavigation, type NavigationTab } from "./components/MainNavigation";
import { deriveServerNameFromUrl } from "../shared/utils/serverName";
import {
  collectRelayTargets,
  DEFAULT_PUBLIC_RELAYS,
  normalizeRelayUrls,
  sanitizeRelayUrl,
} from "../shared/utils/relays";
import { buildNip94EventTemplate } from "../shared/api/nip94";
import type { ShareFolderRequest } from "../shared/types/shareFolder";
import { type ShareFolderItem } from "../shared/types/shareFolder";
import { usePrivateLinks } from "../features/privateLinks/hooks/usePrivateLinks";
import type { PrivateLinkRecord } from "../shared/domain/privateLinks";
import {
  buildItemsFromRecord,
  buildShareableItemHints,
  buildShareItemsFromRequest,
  filterItemsByPolicy,
} from "../shared/domain/folderShareHelpers";
import type { NdkEventInstance, NdkRelayInstance } from "../shared/api/ndkModule";

import type { ShareCompletion, SharePayload, ShareMode } from "../features/share/ui/ShareComposer";
import type { BlossomBlob } from "../shared/api/blossomClient";
import type { StatusMessageTone } from "../shared/types/status";
import type { TabId } from "../shared/types/tabs";
import type { SyncStateSnapshot } from "../features/workspace/TransferTabContainer";
import type {
  BrowseActiveListState,
  BrowseNavigationState,
} from "../features/workspace/BrowseTabContainer";
import type { FilterMode } from "../shared/types/filter";
import type { ProfileMetadataPayload } from "../features/profile/ProfilePanel";

import { TransferIcon, UploadIcon, SettingsIcon, EditIcon, LogoutIcon } from "../shared/ui/icons";
import { FolderShareDialog } from "../features/share/ui/FolderShareDialog";
import { FolderShareRelayPrompt } from "../features/share/ui/FolderShareRelayPrompt";
import { FolderSharePolicyPrompt } from "../features/share/ui/FolderSharePolicyPrompt";
import { StatusFooter } from "../shared/ui/StatusFooter";
import { WorkspaceSection } from "../features/workspace/ui/WorkspaceSection";
import {
  encodeFolderNaddr,
  isPrivateFolderName,
  buildFolderEventTemplate,
  type FolderListRecord,
  type FolderSharePolicy,
} from "../shared/domain/folderList";
import type {
  FolderSharePhases,
  PublishOperationSummary,
  PublishPhaseState,
  RelayPublishFailure,
} from "../features/share/ui/folderShareStatus";

const ConnectSignerDialogLazy = React.lazy(() =>
  import("../features/nip46/ConnectSignerDialog").then(module => ({
    default: module.ConnectSignerDialog,
  })),
);

const RenameDialogLazy = React.lazy(() =>
  import("../features/rename/RenameDialog").then(module => ({ default: module.RenameDialog })),
);

const AudioPlayerCardLazy = React.lazy(() =>
  import("../features/browse/BrowseTab").then(module => ({ default: module.AudioPlayerCard })),
);

const NAV_TABS: NavigationTab[] = [{ id: "upload" as const, label: "Upload", icon: UploadIcon }];
const FOLDER_METADATA_FETCH_TIMEOUT_MS = 7000;

const ALL_SERVERS_VALUE = "__all__";

type StatusMetrics = {
  count: number;
  size: number;
};

const normalizeManagedServer = (server: ManagedServer): ManagedServer => {
  const trimmedUrl = (server.url || "").trim();
  const normalizedUrl = trimmedUrl.replace(/\/$/, "");
  const derivedName = deriveServerNameFromUrl(normalizedUrl);
  const fallbackName = derivedName || normalizedUrl.replace(/^https?:\/\//, "");
  const name = (server.name || "").trim() || fallbackName;

  const requiresAuth = server.type === "satellite" ? true : server.requiresAuth !== false;
  return {
    ...server,
    url: normalizedUrl,
    name,
    requiresAuth,
    sync: server.type === "satellite" ? false : Boolean(server.sync),
  };
};

const validateManagedServers = (servers: ManagedServer[]): string | null => {
  const seen = new Set<string>();
  for (const server of servers) {
    const trimmedUrl = (server.url || "").trim();
    if (!trimmedUrl) return "Enter a server URL for every entry.";
    if (!/^https?:\/\//i.test(trimmedUrl))
      return "Server URLs must start with http:// or https://.";
    const normalizedUrl = trimmedUrl.replace(/\/$/, "").toLowerCase();
    if (seen.has(normalizedUrl)) return "Server URLs must be unique.";
    seen.add(normalizedUrl);
    const name = (server.name || "").trim();
    if (!name) return "Enter a server name for every entry.";
  }
  return null;
};

type PendingSave = {
  servers: ManagedServer[];
  successMessage?: string;
  backoffUntil?: number;
};

type FolderShareDialogState = {
  record: FolderListRecord;
  naddr: string;
  shareUrl: string;
  phases?: FolderSharePhases;
  relayHints?: readonly string[];
  shareBlobs?: BlossomBlob[] | null;
  shareItems?: ShareFolderItem[] | null;
};

type FolderSharePolicyPromptState = {
  record: FolderListRecord;
  normalizedPath: string;
  relayOptions: string[];
  request: ShareFolderRequest;
  items: ShareFolderItem[];
  counts: {
    total: number;
    privateOnly: number;
    publicOnly: number;
  };
  defaultPolicy: FolderSharePolicy;
};

type FolderShareRelayPromptState = {
  record: FolderListRecord;
  normalizedPath: string;
  relayOptions: string[];
  request: ShareFolderRequest;
  items: ShareFolderItem[];
  sharePolicy: FolderSharePolicy;
};

type ShareFolderExecutionRequest = {
  record: FolderListRecord;
  normalizedPath: string;
  relayHints: readonly string[];
  items: ShareFolderItem[];
  sharePolicy: FolderSharePolicy;
};

export default function App() {
  const queryClient = useQueryClient();
  const { connect, disconnect, user, signer, ndk, getModule, prepareRelaySet } = useNdk();
  const {
    snapshot: nip46Snapshot,
    service: nip46Service,
    ready: nip46Ready,
    transportReady: nip46TransportReady,
  } = useNip46();
  const pubkey = useCurrentPubkey();
  const { servers, saveServers, saving, hasFetchedUserServers } = useServers();
  const {
    preferences,
    setDefaultServerUrl,
    setDefaultViewMode,
    setDefaultFilterMode,
    setDefaultSortOption,
    setShowGridPreviews,
    setShowListPreviews,
    setKeepSearchExpanded,
    setTheme,
    setSortDirection,
    setSyncEnabled,
    syncState,
  } = useUserPreferences();
  const { statusMessage: pipelineStatusMessage, statusTone: pipelineStatusTone } =
    useSyncPipeline();
  const { confirm } = useDialog();
  const { effectiveRelays, relayPolicies } = usePreferredRelays();
  useAliasSync(effectiveRelays, Boolean(pubkey));
  const isCompactScreen = useIsCompactScreen();

  const preferredWriteRelays = useMemo(
    () => relayPolicies.filter(policy => policy.write).map(policy => policy.url),
    [relayPolicies],
  );
  const shareRelayCandidates = useMemo(
    () => (preferredWriteRelays.length > 0 ? preferredWriteRelays : effectiveRelays),
    [effectiveRelays, preferredWriteRelays],
  );

  const keepSearchExpanded = preferences.keepSearchExpanded;

  const [localServers, setLocalServers] = useState<ManagedServer[]>(servers);
  const [selectedServer, setSelectedServer] = useState<string | null>(() => {
    if (preferences.defaultServerUrl) {
      return preferences.defaultServerUrl;
    }
    return servers[0]?.url ?? null;
  });
  const [tab, setTab] = useState<TabId>("browse");
  const [browseHeaderControls, setBrowseHeaderControls] = useState<React.ReactNode | null>(null);
  const [homeNavigationKey, setHomeNavigationKey] = useState(0);
  const [browseNavigationState, setBrowseNavigationState] = useState<BrowseNavigationState | null>(
    null,
  );
  const [browseActiveList, setBrowseActiveList] = useState<BrowseActiveListState | null>(null);
  const browseRestoreCounterRef = useRef(0);
  const [pendingBrowseRestore, setPendingBrowseRestore] = useState<{
    state: BrowseActiveListState | null;
    key: number;
  } | null>(null);
  const [uploadReturnTarget, setUploadReturnTarget] = useState<{
    tab: TabId;
    browseActiveList: BrowseActiveListState | null;
    selectedServer: string | null;
  } | null>(null);
  const uploadFolderSuggestion = useMemo(() => {
    const activeList = uploadReturnTarget?.browseActiveList;
    if (activeList && activeList.type === "folder") {
      return activeList.path;
    }
    return null;
  }, [uploadReturnTarget]);
  const [isSearchOpen, setIsSearchOpen] = useState(() => keepSearchExpanded);
  const [searchQuery, setSearchQuery] = useState("");

  const { selected: selectedBlobs } = useSelection();
  const hasSelection = selectedBlobs.size > 0;
  const {
    shareState,
    openShareForPayload,
    openShareByKey,
    handleShareComplete: completeShareInternal,
    clearShareState,
  } = useShareWorkflow();

  const audio = useAudio();
  const { foldersByPath, resolveFolderPath, setFolderVisibility } = useFolderLists();
  const {
    links: privateLinkRecords,
    serviceConfigured: privateLinkServiceConfigured,
    serviceHost: privateLinkServiceHost,
    isLoading: privateLinksLoading,
    isFetching: privateLinksFetching,
  } = usePrivateLinks({ enabled: Boolean(user && signer) });
  const privateLinkHost = useMemo(
    () => privateLinkServiceHost.replace(/\/+$/, ""),
    [privateLinkServiceHost],
  );
  const [folderShareBusyPath, setFolderShareBusyPath] = useState<string | null>(null);
  const [folderSharePolicyPrompt, setFolderSharePolicyPrompt] =
    useState<FolderSharePolicyPromptState | null>(null);
  const [folderShareRelayPrompt, setFolderShareRelayPrompt] =
    useState<FolderShareRelayPromptState | null>(null);
  const [folderShareDialog, setFolderShareDialog] = useState<FolderShareDialogState | null>(null);

  const {
    enabled: syncEnabled,
    loading: syncLoading,
    error: syncError,
    pending: syncPending,
    lastSyncedAt: syncLastSyncedAt,
  } = syncState;

  const handleFilterModeChange = useCallback((_mode: FilterMode) => {
    void _mode;
    // Music mode no longer requires tracking the active browse filter at the app level.
  }, []);

  const handleBrowseActiveListChange = useCallback((state: BrowseActiveListState | null) => {
    setBrowseActiveList(state);
  }, []);

  const handleBrowseRestoreHandled = useCallback(() => {
    setPendingBrowseRestore(null);
  }, []);

  const selectTab = useCallback(
    (nextTab: TabId) => {
      if (tab === nextTab) return;
      if (nextTab === "upload") {
        setUploadReturnTarget({
          tab,
          browseActiveList: tab === "browse" && browseActiveList ? { ...browseActiveList } : null,
          selectedServer,
        });
      } else if (tab === "upload") {
        setUploadReturnTarget(null);
      }
      setTab(nextTab);
    },
    [tab, browseActiveList, selectedServer],
  );

  const [statusMetrics, setStatusMetrics] = useState<StatusMetrics>({ count: 0, size: 0 });
  const [syncSnapshot, setSyncSnapshot] = useState<SyncStateSnapshot>({
    syncStatus: { state: "idle", progress: 0 },
    syncAutoReady: false,
    allLinkedServersSynced: true,
  });
  const [hasNip07Extension, setHasNip07Extension] = useState(() => {
    if (typeof window === "undefined") return false;
    const nostr = (window as typeof window & { nostr?: { getPublicKey?: unknown } }).nostr;
    return Boolean(nostr && typeof nostr.getPublicKey === "function");
  });
  const syncStarterRef = useRef<(() => void) | null>(null);
  const pendingSyncRef = useRef(false);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusMessageTone, setStatusMessageTone] = useState<StatusMessageTone>("info");
  const statusMessageTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const retryPendingSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingSaveVersion, setPendingSaveVersion] = useState(0);
  const autoRepublishInFlightRef = useRef<Set<string>>(new Set());

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [connectSignerOpen, setConnectSignerOpen] = useState(false);
  const [pendingRemoteSignerConnect, setPendingRemoteSignerConnect] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BlossomBlob | null>(null);
  const [folderRenamePath, setFolderRenamePath] = useState<string | null>(null);

  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const mainWidgetRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const syncEnabledServerUrls = useMemo(
    () => localServers.filter(server => server.sync).map(server => server.url),
    [localServers],
  );

  const serverValidationError = useMemo(() => validateManagedServers(localServers), [localServers]);

  const userInitials = useMemo(() => {
    const npub = user?.npub;
    if (!npub) return "??";
    return npub.slice(0, 2).toUpperCase();
  }, [user]);

  const syncStatus = syncSnapshot.syncStatus;
  const syncBusy = syncStatus.state === "syncing";
  const syncButtonDisabled =
    syncEnabledServerUrls.length < 2 ||
    syncBusy ||
    (syncSnapshot.syncAutoReady &&
      syncSnapshot.allLinkedServersSynced &&
      syncStatus.state !== "error");

  useEffect(() => {
    setLocalServers(servers);
  }, [servers]);

  useEffect(() => {
    setSelectedServer(prev => {
      if (prev && servers.some(server => server.url === prev)) {
        return prev;
      }
      if (
        preferences.defaultServerUrl &&
        servers.some(server => server.url === preferences.defaultServerUrl)
      ) {
        return preferences.defaultServerUrl;
      }
      return servers[0]?.url ?? null;
    });
  }, [servers, preferences.defaultServerUrl]);

  useEffect(() => {
    if (!hasFetchedUserServers) return;
    if (!preferences.defaultServerUrl) return;
    if (!servers.some(server => server.url === preferences.defaultServerUrl)) {
      setDefaultServerUrl(null);
    }
  }, [servers, hasFetchedUserServers, preferences.defaultServerUrl, setDefaultServerUrl]);

  useEffect(() => {
    if (tab === "transfer" && selectedBlobs.size === 0) {
      selectTab("upload");
    }
  }, [selectedBlobs.size, tab, selectTab]);

  useEffect(() => {
    if (!isUserMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!userMenuRef.current || userMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsUserMenuOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!userMenuRef.current || userMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
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
  }, [isUserMenuOpen]);

  useEffect(() => {
    if (!user) {
      setIsUserMenuOpen(false);
    }
  }, [user]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkAvailability = () => {
      const nostr = (window as typeof window & { nostr?: { getPublicKey?: unknown } }).nostr;
      const available = Boolean(nostr && typeof nostr.getPublicKey === "function");
      setHasNip07Extension(prev => (prev === available ? prev : available));
    };

    checkAvailability();

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        checkAvailability();
      }
    };

    window.addEventListener("focus", checkAvailability);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const timeout = window.setTimeout(checkAvailability, 1500);

    return () => {
      window.removeEventListener("focus", checkAvailability);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearTimeout(timeout);
    };
  }, []);

  const isSignedIn = Boolean(user);
  const showAuthPrompt = !isSignedIn;
  const compactUploadLabel = hasSelection ? "Transfer" : "Upload";
  const compactUploadIcon = hasSelection ? TransferIcon : UploadIcon;
  const compactUploadActive = hasSelection || tab === "upload" || tab === "transfer";
  const showCompactUploadControl = isCompactScreen && isSignedIn && !showAuthPrompt;
  const handleCompactUploadClick = useCallback(() => {
    selectTab(hasSelection ? "transfer" : "upload");
  }, [hasSelection, selectTab]);

  useEffect(() => {
    const element = mainWidgetRef.current;
    if (!element) return;
    element.removeAttribute("inert");
  }, [showAuthPrompt]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const key = params.get("share");
    if (!key) return;
    openShareByKey(key);
    selectTab("share");
    params.delete("share");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [openShareByKey, selectTab]);

  useEffect(() => {
    return () => {
      if (statusMessageTimeout.current) {
        clearTimeout(statusMessageTimeout.current);
      }
      if (retryPendingSaveTimeout.current) {
        clearTimeout(retryPendingSaveTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    async function loadProfile() {
      if (!ndk || !user?.pubkey) {
        setAvatarUrl(null);
        return;
      }
      try {
        const evt = await ndk.fetchEvent({ kinds: [0], authors: [user.pubkey] });
        if (evt?.content && !ignore) {
          try {
            const metadata = JSON.parse(evt.content);
            setAvatarUrl(metadata.picture || null);
          } catch {
            if (!ignore) setAvatarUrl(null);
          }
        }
      } catch {
        if (!ignore) setAvatarUrl(null);
      }
    }
    loadProfile();
    return () => {
      ignore = true;
    };
  }, [ndk, user?.pubkey]);

  const showStatusMessage = useCallback(
    (message: string, tone: StatusMessageTone = "info", duration = 5000) => {
      if (statusMessageTimeout.current) {
        clearTimeout(statusMessageTimeout.current);
        statusMessageTimeout.current = null;
      }
      setStatusMessage(message);
      setStatusMessageTone(tone);
      if (duration > 0) {
        statusMessageTimeout.current = setTimeout(() => {
          setStatusMessage(null);
          setStatusMessageTone("info");
          statusMessageTimeout.current = null;
        }, duration);
      }
    },
    [],
  );

  const ensureFolderListOnRelays = useCallback(
    async (
      record: FolderListRecord,
      relayUrls: readonly string[],
      blobs?: BlossomBlob[],
      options?: {
        allowedShas?: ReadonlySet<string> | null;
        sharePolicy?: FolderSharePolicy | null;
        items?: ShareFolderItem[] | null;
      },
    ): Promise<{ record: FolderListRecord; summary: PublishOperationSummary }> => {
      const sanitizedRelays = collectRelayTargets(relayUrls, DEFAULT_PUBLIC_RELAYS);
      const baseSummary: PublishOperationSummary = {
        total: sanitizedRelays.length,
        succeeded: 0,
        failed: [],
      };
      if (!ndk || !signer || !user) {
        return {
          record,
          summary: {
            ...baseSummary,
            error: "Signer unavailable",
          },
        };
      }
      if (!sanitizedRelays.length) {
        return {
          record,
          summary: {
            ...baseSummary,
            error: "No relays configured",
          },
        };
      }
      const { relaySet } = await prepareRelaySet(sanitizedRelays, { waitForConnection: true });
      if (!relaySet) {
        return {
          record,
          summary: {
            ...baseSummary,
            error: "Unable to connect to relays",
            failed: sanitizedRelays.map(url => ({ url, message: "Connection pending" })),
          },
        };
      }

      const allowedInput = options?.allowedShas;
      const allowedSet = allowedInput
        ? new Set(
            Array.from(allowedInput)
              .map(value => value.toLowerCase())
              .filter(value => value.length === 64),
          )
        : null;
      const isAllowedSha = (sha: string) => {
        if (!allowedSet) return true;
        return allowedSet.has(sha);
      };

      const policyRaw = options?.sharePolicy ?? record.sharePolicy ?? "all";
      const sharePolicy: FolderSharePolicy =
        policyRaw === "private-only" || policyRaw === "public-only" ? policyRaw : "all";

      const candidateItems =
        options?.items && options.items.length > 0
          ? options.items
          : Array.isArray(blobs)
            ? blobs
                .filter((blob): blob is BlossomBlob =>
                  Boolean(blob && typeof blob.sha256 === "string"),
                )
                .map(blob => ({
                  blob,
                  privateLinkAlias: null,
                  privateLinkUrl: null,
                }))
            : [];

      const normalizedItems = candidateItems
        .filter(item => item && item.blob && typeof item.blob.sha256 === "string")
        .map(item => ({
          blob: item.blob,
          privateLinkAlias: item.privateLinkAlias ?? null,
          privateLinkUrl: item.privateLinkUrl ?? null,
        }))
        .filter(item => {
          const sha = item.blob.sha256?.toLowerCase();
          if (!sha || sha.length !== 64) return false;
          if (!isAllowedSha(sha)) return false;
          return true;
        });

      const { shas, hints } = buildShareableItemHints({
        record,
        items: normalizedItems,
        sharePolicy,
      });

      const shareRecord: FolderListRecord = {
        ...record,
        shas,
        pubkey: record.pubkey ?? user.pubkey,
        fileHints: Object.keys(hints).length > 0 ? hints : record.fileHints,
        sharePolicy,
      };

      const summary: PublishOperationSummary = {
        total: sanitizedRelays.length,
        succeeded: 0,
        failed: [],
      };

      try {
        const module = await getModule();
        const createdAt = Math.floor(Date.now() / 1000);
        const template = buildFolderEventTemplate(shareRecord, shareRecord.pubkey ?? user.pubkey, {
          createdAt,
          fileHints: shareRecord.fileHints ? Object.values(shareRecord.fileHints) : undefined,
          sharePolicy: shareRecord.sharePolicy ?? null,
        });
        const event = new module.NDKEvent(ndk);
        event.kind = template.kind;
        event.pubkey = template.pubkey;
        event.created_at = template.created_at;
        event.tags = template.tags;
        event.content = template.content;
        await event.sign();
        try {
          const publishedRelays = await event.publish(relaySet, undefined, sanitizedRelays.length);
          const successUrls = new Set<string>();
          publishedRelays.forEach(relay => {
            const normalized = sanitizeRelayUrl(relay.url);
            if (normalized) {
              successUrls.add(normalized);
            }
          });
          summary.succeeded = successUrls.size;
          summary.failed = sanitizedRelays
            .filter(url => !successUrls.has(url))
            .map(url => ({ url, message: "No acknowledgement" }));
          summary.error = summary.failed.length
            ? "Some relays did not acknowledge the folder list."
            : undefined;
        } catch (publishError) {
          const successUrls = new Set<string>();
          const failedMap = new Map<string, string | undefined>();
          if (
            publishError &&
            typeof publishError === "object" &&
            "publishedToRelays" in publishError &&
            publishError.publishedToRelays instanceof Set
          ) {
            (publishError.publishedToRelays as Set<NdkRelayInstance>).forEach(relay => {
              const normalized = sanitizeRelayUrl(relay.url);
              if (normalized) {
                successUrls.add(normalized);
              }
            });
          }
          if (
            publishError &&
            typeof publishError === "object" &&
            "errors" in publishError &&
            publishError.errors instanceof Map
          ) {
            (publishError.errors as Map<NdkRelayInstance, Error>).forEach((err, relayInstance) => {
              const normalized = sanitizeRelayUrl(relayInstance.url);
              if (normalized) {
                failedMap.set(normalized, err instanceof Error ? err.message : String(err));
              }
            });
          }
          summary.succeeded = successUrls.size;
          const failedUrls = sanitizedRelays.filter(url => !successUrls.has(url));
          summary.failed = failedUrls.map(url => ({
            url,
            message:
              failedMap.get(url) ??
              (publishError instanceof Error ? publishError.message : "Publish failed"),
          }));
          summary.error =
            summary.failed.length > 0
              ? publishError instanceof Error
                ? publishError.message
                : "Failed to publish to some relays"
              : publishError instanceof Error
                ? publishError.message
                : "Publish error";
          console.warn("Failed to republish folder list to share relays", publishError);
        }
      } catch (error) {
        summary.error = error instanceof Error ? error.message : "Unexpected error";
        summary.failed =
          sanitizedRelays.length > 0
            ? sanitizedRelays.map(url => ({
                url,
                message: summary.error ?? "Unexpected error",
              }))
            : [];
        console.warn("Failed to republish folder list to share relays", error);
      }

      return { record: shareRecord, summary };
    },
    [getModule, ndk, prepareRelaySet, signer, user],
  );

  const ensureFolderMetadataOnRelays = useCallback(
    async (
      record: FolderListRecord,
      relayUrls: readonly string[],
      blobs?: BlossomBlob[],
    ): Promise<PublishOperationSummary> => {
      const sanitizedRelays = collectRelayTargets(relayUrls, DEFAULT_PUBLIC_RELAYS);
      const summary: PublishOperationSummary = {
        total: sanitizedRelays.length,
        succeeded: 0,
        failed: [],
      };
      if (!ndk) {
        summary.error = "Nostr connection unavailable";
        return summary;
      }
      if (!sanitizedRelays.length) {
        summary.error = "No relays configured";
        return summary;
      }
      const { relaySet } = await prepareRelaySet(sanitizedRelays, { waitForConnection: true });
      if (!relaySet) {
        summary.error = "Unable to prepare relays";
        summary.failed = sanitizedRelays.map(url => ({ url, message: "Connection pending" }));
        return summary;
      }
      const module = await getModule();
      const shas = Array.from(
        new Set(record.shas.map(sha => sha?.toLowerCase()).filter(Boolean) as string[]),
      );
      if (!shas.length) {
        summary.succeeded = sanitizedRelays.length;
        return summary;
      }

      const blobLookup = new Map<string, BlossomBlob>();
      blobs?.forEach(blob => {
        if (blob?.sha256) {
          blobLookup.set(blob.sha256.toLowerCase(), blob);
        }
      });

      let fetchedEvents: Set<NdkEventInstance> = new Set<NdkEventInstance>();
      let metadataFetchTimedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        const metadataFetch = ndk.fetchEvents(
          [
            { kinds: [1063], "#x": shas, limit: shas.length },
            { kinds: [1063], "#ox": shas, limit: shas.length },
          ],
          { closeOnEose: true, groupable: false },
          relaySet,
        ) as Promise<Set<NdkEventInstance>>;
        fetchedEvents = (await Promise.race([
          metadataFetch.finally(() => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
          }),
          new Promise<Set<NdkEventInstance>>(resolve => {
            timeoutHandle = setTimeout(() => {
              metadataFetchTimedOut = true;
              timeoutHandle = null;
              resolve(new Set<NdkEventInstance>());
            }, FOLDER_METADATA_FETCH_TIMEOUT_MS);
          }),
        ])) as Set<NdkEventInstance>;
      } catch (error) {
        console.warn("Unable to fetch existing file metadata for share", error);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      }
      if (metadataFetchTimedOut) {
        console.warn(
          `Timed out after ${FOLDER_METADATA_FETCH_TIMEOUT_MS}ms while fetching metadata events for shared items`,
        );
      }

      const found = new Set<string>();
      const eventsToPublish: NdkEventInstance[] = [];

      fetchedEvents.forEach(eventInstance => {
        if (!eventInstance || !Array.isArray(eventInstance.tags)) return;
        const shaTag = eventInstance.tags.find(
          (tag: unknown) =>
            Array.isArray(tag) && (tag[0] === "x" || tag[0] === "ox") && typeof tag[1] === "string",
        ) as string[] | undefined;
        if (!shaTag || typeof shaTag[1] !== "string") return;
        const sha = shaTag[1].toLowerCase();
        if (!shas.includes(sha)) return;
        found.add(sha);
        eventsToPublish.push(eventInstance);
      });

      const missing = shas.filter(sha => !found.has(sha));
      if (missing.length && signer) {
        missing.forEach(sha => {
          const blob = blobLookup.get(sha);
          if (!blob || !blob.url) return;
          const template = buildNip94EventTemplate({ blob });
          const event = new module.NDKEvent(ndk, template);
          eventsToPublish.push(event);
          found.add(sha);
        });
      }

      if (!eventsToPublish.length) {
        summary.succeeded = sanitizedRelays.length;
        return summary;
      }

      const relayFailures = new Map<string, string>();
      const relaySuccesses = new Map<string, number>();

      const trackSuccess = (url: string) => {
        relaySuccesses.set(url, (relaySuccesses.get(url) ?? 0) + 1);
      };
      const trackFailure = (url: string, message: string) => {
        if (relayFailures.has(url)) return;
        relayFailures.set(url, message);
      };

      for (const event of eventsToPublish) {
        try {
          if (!event.sig) {
            await event.sign();
          }
          const published = await event.publish(relaySet, undefined, sanitizedRelays.length);
          published.forEach(relay => {
            const normalized = sanitizeRelayUrl(relay.url);
            if (normalized) {
              trackSuccess(normalized);
            }
          });
        } catch (publishError) {
          const successUrls = new Set<string>();
          const failureMap = new Map<string, string | undefined>();
          if (
            publishError &&
            typeof publishError === "object" &&
            "publishedToRelays" in publishError &&
            publishError.publishedToRelays instanceof Set
          ) {
            (publishError.publishedToRelays as Set<NdkRelayInstance>).forEach(relay => {
              const normalized = sanitizeRelayUrl(relay.url);
              if (normalized) {
                successUrls.add(normalized);
                trackSuccess(normalized);
              }
            });
          }
          if (
            publishError &&
            typeof publishError === "object" &&
            "errors" in publishError &&
            publishError.errors instanceof Map
          ) {
            (publishError.errors as Map<NdkRelayInstance, Error>).forEach((err, relayInstance) => {
              const normalized = sanitizeRelayUrl(relayInstance.url);
              if (normalized) {
                failureMap.set(normalized, err instanceof Error ? err.message : String(err));
              }
            });
          }
          const fallbackMessage =
            publishError instanceof Error
              ? publishError.message
              : "Failed to publish metadata event";
          sanitizedRelays.forEach(url => {
            if (successUrls.has(url)) return;
            trackFailure(url, failureMap.get(url) ?? fallbackMessage);
          });
          console.warn("Failed to publish metadata event to all relays", publishError);
        }
      }

      const succeededRelays = sanitizedRelays.filter(
        url => !relayFailures.has(url) && (relaySuccesses.get(url) ?? 0) >= eventsToPublish.length,
      );
      summary.succeeded = succeededRelays.length;
      summary.failed = sanitizedRelays
        .filter(url => !succeededRelays.includes(url))
        .map(url => ({
          url,
          message: relayFailures.get(url) ?? "No acknowledgement",
        }));
      summary.error =
        summary.failed.length > 0 ? "Some relays did not receive file metadata." : undefined;

      if (shas.some(sha => !found.has(sha))) {
        console.warn(
          "Some shared items are missing metadata events",
          shas.filter(sha => !found.has(sha)),
        );
      }

      return summary;
    },
    [getModule, ndk, prepareRelaySet, signer],
  );

  useEffect(() => {
    if (!privateLinkServiceConfigured) return;
    if (privateLinksLoading || privateLinksFetching) return;
    if (!ndk || !signer || !user) return;
    if (!shareRelayCandidates.length) return;
    if (!privateLinkHost) return;
    if (folderShareBusyPath) return;

    const activeLinks = new Map<string, PrivateLinkRecord>();
    privateLinkRecords.forEach(record => {
      if (!record || record.status !== "active" || record.isExpired) return;
      const sha = record.target?.sha256;
      if (!sha || sha.length !== 64) return;
      activeLinks.set(sha.toLowerCase(), record);
    });

    const folderRecords = Array.from(foldersByPath.values());
    folderRecords.forEach(record => {
      if (!record || record.visibility !== "public") return;
      const policy: FolderSharePolicy =
        record.sharePolicy === "private-only" || record.sharePolicy === "public-only"
          ? record.sharePolicy
          : "all";
      const allItems = buildItemsFromRecord(record, activeLinks, privateLinkHost);
      const filteredItems = filterItemsByPolicy(allItems, policy);
      const desiredShaSet = new Set(filteredItems.map(item => item.blob.sha256.toLowerCase()));
      const currentShaSet = new Set(
        (record.shas ?? []).map(sha => (typeof sha === "string" ? sha.toLowerCase() : String(sha))),
      );

      let needsRepublish = false;
      if (desiredShaSet.size !== currentShaSet.size) {
        needsRepublish = true;
      } else {
        for (const sha of desiredShaSet) {
          if (!currentShaSet.has(sha)) {
            needsRepublish = true;
            break;
          }
        }
      }

      if (!needsRepublish) {
        const hints = record.fileHints ?? {};
        for (const item of filteredItems) {
          const sha = item.blob.sha256.toLowerCase();
          const hint = hints[sha];
          const currentAlias = hint?.privateLinkAlias ?? null;
          const expectedAlias = item.privateLinkAlias ?? null;
          if (policy === "public-only") {
            if (currentAlias) {
              needsRepublish = true;
              break;
            }
          } else {
            if (Boolean(expectedAlias) !== Boolean(currentAlias)) {
              needsRepublish = true;
              break;
            }
            if (expectedAlias && currentAlias && expectedAlias !== currentAlias) {
              needsRepublish = true;
              break;
            }
          }
        }
      }

      if (!needsRepublish) return;

      const pathKey = record.path ?? record.identifier;
      if (!pathKey) return;
      if (autoRepublishInFlightRef.current.has(pathKey)) return;
      autoRepublishInFlightRef.current.add(pathKey);

      const blobs = filteredItems.map(item => item.blob);
      const allowedShas = new Set(filteredItems.map(item => item.blob.sha256.toLowerCase()));

      void (async () => {
        try {
          const result = await ensureFolderListOnRelays(record, shareRelayCandidates, blobs, {
            allowedShas,
            sharePolicy: policy,
            items: filteredItems,
          });
          if (
            result.summary.failed.length &&
            result.summary.failed.length === result.summary.total
          ) {
            console.warn(
              "Auto-republish failed for shared folder",
              record.path || record.identifier,
            );
          }
        } catch (error) {
          console.warn(
            "Auto-republish encountered an error for shared folder",
            record.path || record.identifier,
            error,
          );
        } finally {
          autoRepublishInFlightRef.current.delete(pathKey);
        }
      })();
    });
  }, [
    privateLinkServiceConfigured,
    privateLinksLoading,
    privateLinksFetching,
    privateLinkRecords,
    privateLinkHost,
    foldersByPath,
    shareRelayCandidates,
    ensureFolderListOnRelays,
    folderShareBusyPath,
    ndk,
    signer,
    user,
  ]);

  const shareFolderWithRelays = useCallback(
    async ({
      record,
      normalizedPath,
      relayHints,
      items,
      sharePolicy,
    }: ShareFolderExecutionRequest) => {
      const sanitizedHints = collectRelayTargets(relayHints, shareRelayCandidates);
      if (!sanitizedHints.length) {
        showStatusMessage("Select at least one relay before sharing.", "error", 4000);
        return;
      }
      if (folderShareBusyPath && folderShareBusyPath !== normalizedPath) {
        showStatusMessage("Another folder is updating. Please wait.", "info", 2500);
        return;
      }
      if (folderShareBusyPath === normalizedPath) {
        showStatusMessage("Folder sharing in progress…", "info", 2500);
        return;
      }

      const allowedShaSet = new Set<string>();
      items.forEach(item => {
        if (item?.blob?.sha256 && item.blob.sha256.length === 64) {
          allowedShaSet.add(item.blob.sha256.toLowerCase());
        }
      });
      const filteredBlobs = items.map(item => item.blob);

      setFolderShareBusyPath(normalizedPath);
      try {
        let nextRecord = record;
        showStatusMessage("Making folder public…", "info", 2500);
        const published = await setFolderVisibility(normalizedPath, "public");
        nextRecord = published ?? record;
        if (nextRecord.visibility !== "public") {
          showStatusMessage("Unable to share this folder right now.", "error", 4500);
          return;
        }
        showStatusMessage("Folder is now public.", "success", 2500);

        const listPublish = await ensureFolderListOnRelays(
          nextRecord,
          sanitizedHints,
          filteredBlobs,
          {
            allowedShas: allowedShaSet,
            sharePolicy,
            items,
          },
        );
        const shareRecord = listPublish.record;
        const ownerPubkey = shareRecord.pubkey ?? user?.pubkey ?? null;
        const naddr = encodeFolderNaddr(shareRecord, ownerPubkey, sanitizedHints);
        if (!naddr) {
          showStatusMessage("Unable to build a share link for this folder.", "error", 4500);
          return;
        }
        const origin =
          typeof window !== "undefined" && window.location?.origin
            ? window.location.origin
            : "https://bloomapp.me";
        const shareUrl = `${origin}/folders/${encodeURIComponent(naddr)}`;

        setFolderShareDialog({
          record: shareRecord,
          naddr,
          shareUrl,
          relayHints: sanitizedHints,
          shareBlobs: filteredBlobs,
          shareItems: items,
          phases: {
            list: {
              status: listPublish.summary.failed.length > 0 ? "partial" : "ready",
              total: sanitizedHints.length,
              succeeded: Math.max(0, sanitizedHints.length - listPublish.summary.failed.length),
              failed: listPublish.summary.failed,
              message: listPublish.summary.error,
            },
            metadata: {
              status: "publishing",
              total: sanitizedHints.length,
              succeeded: 0,
              failed: [],
            },
          },
        });

        if (listPublish.summary.failed.length > 0) {
          showStatusMessage(
            "Share link ready. Some relays still need attention—retry from the share dialog.",
            "success",
            4500,
          );
        } else {
          showStatusMessage("Share link ready.", "success", 2000);
        }

        void (async () => {
          try {
            const metadataSummary = await ensureFolderMetadataOnRelays(
              shareRecord,
              sanitizedHints,
              filteredBlobs,
            );
            setFolderShareDialog(current => {
              if (!current || current.record.path !== shareRecord.path) return current;
              const relayUniverse =
                current.relayHints && current.relayHints.length > 0
                  ? normalizeRelayUrls(current.relayHints)
                  : sanitizedHints;
              const baseTotal = relayUniverse.length;
              const listPhase: PublishPhaseState = current.phases?.list ?? {
                status: "ready",
                total: baseTotal,
                succeeded: baseTotal,
                failed: [],
              };
              const remainingFailures = metadataSummary.failed;
              return {
                ...current,
                relayHints: relayUniverse,
                phases: {
                  list: listPhase,
                  metadata: {
                    status: remainingFailures.length > 0 ? "partial" : "ready",
                    total: baseTotal,
                    succeeded: Math.max(0, baseTotal - remainingFailures.length),
                    failed: remainingFailures,
                    message: metadataSummary.error,
                  },
                },
              };
            });
            if (metadataSummary.failed.length > 0) {
              showStatusMessage(
                "Some relays did not receive file details. Retry from the share dialog.",
                "warning",
                6000,
              );
            }
          } catch (metadataError) {
            console.warn("Failed to publish folder metadata for share", metadataError);
            setFolderShareDialog(current => {
              if (!current || current.record.path !== shareRecord.path) return current;
              const relayUniverse =
                current.relayHints && current.relayHints.length > 0
                  ? normalizeRelayUrls(current.relayHints)
                  : sanitizedHints;
              const baseTotal = relayUniverse.length;
              const nextPhases = current.phases ?? {
                list: {
                  status: "ready",
                  total: baseTotal,
                  succeeded: baseTotal,
                  failed: [],
                },
                metadata: {
                  status: "publishing",
                  total: baseTotal,
                  succeeded: 0,
                  failed: [],
                },
              };
              return {
                ...current,
                relayHints: relayUniverse,
                phases: {
                  ...nextPhases,
                  metadata: {
                    status: "error",
                    total: baseTotal,
                    succeeded: nextPhases.metadata.succeeded ?? 0,
                    failed: nextPhases.metadata.failed ?? [],
                    message:
                      metadataError instanceof Error
                        ? metadataError.message
                        : "Failed to publish metadata",
                  },
                },
              };
            });
            showStatusMessage(
              "Some file details are still publishing. Previews may take a bit longer to appear.",
              "warning",
              5000,
            );
          }
        })();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to share folder.";
        showStatusMessage(message, "error", 5000);
      } finally {
        setFolderShareBusyPath(null);
      }
    },
    [
      shareRelayCandidates,
      folderShareBusyPath,
      showStatusMessage,
      setFolderVisibility,
      ensureFolderListOnRelays,
      ensureFolderMetadataOnRelays,
      user?.pubkey,
    ],
  );

  const handleShareFolder = useCallback(
    async (request: ShareFolderRequest) => {
      const normalizedPath = resolveFolderPath(request.path);
      if (typeof normalizedPath !== "string") {
        showStatusMessage("Folder not found.", "error", 4000);
        return;
      }
      const record = foldersByPath.get(normalizedPath);
      if (!record) {
        showStatusMessage("Folder details unavailable.", "error", 4000);
        return;
      }
      if (isPrivateFolderName(record.name)) {
        showStatusMessage("The Private folder cannot be shared.", "info", 3500);
        return;
      }
      let items = buildShareItemsFromRequest(request);
      if (!items.length) {
        const activeLinks = new Map<string, PrivateLinkRecord>();
        privateLinkRecords.forEach(link => {
          if (!link || link.status !== "active" || link.isExpired) return;
          const sha = link.target?.sha256;
          if (!sha || sha.length !== 64) return;
          activeLinks.set(sha.toLowerCase(), link);
        });
        const fallbackItems = buildItemsFromRecord(record, activeLinks, privateLinkHost);
        if (fallbackItems.length) {
          items = fallbackItems;
        }
      }

      const shareableItems = filterItemsByPolicy(items, "all");
      if (shareableItems.length === 0) {
        showStatusMessage("No shareable files found in this folder.", "info", 3500);
        return;
      }
      const privateCount = filterItemsByPolicy(shareableItems, "private-only").length;
      const publicCount = filterItemsByPolicy(shareableItems, "public-only").length;
      const defaultPolicy = record.sharePolicy ?? "all";

      const relayOptions = normalizeRelayUrls(shareRelayCandidates);
      if (!relayOptions.length) {
        showStatusMessage("Configure at least one relay before sharing.", "error", 4000);
        return;
      }

      if (record.visibility === "public") {
        const targetRecord =
          folderShareDialog?.record?.path === record.path ? folderShareDialog.record : record;
        setFolderSharePolicyPrompt({
          record: targetRecord,
          normalizedPath,
          relayOptions,
          request,
          items: shareableItems,
          counts: {
            total: shareableItems.length,
            privateOnly: privateCount,
            publicOnly: publicCount,
          },
          defaultPolicy,
        });
        return;
      }

      if (folderShareBusyPath && folderShareBusyPath !== normalizedPath) {
        showStatusMessage("Another folder is updating. Please wait.", "info", 2500);
        return;
      }
      if (folderShareBusyPath === normalizedPath) {
        showStatusMessage("Folder sharing in progress…", "info", 2500);
        return;
      }
      setFolderSharePolicyPrompt({
        record,
        normalizedPath,
        relayOptions,
        request,
        items: shareableItems,
        counts: {
          total: shareableItems.length,
          privateOnly: privateCount,
          publicOnly: publicCount,
        },
        defaultPolicy,
      });
    },
    [
      resolveFolderPath,
      foldersByPath,
      folderShareBusyPath,
      folderShareDialog,
      setFolderSharePolicyPrompt,
      showStatusMessage,
      shareRelayCandidates,
      user?.pubkey,
      privateLinkRecords,
      privateLinkHost,
    ],
  );

  const handleCancelSharePolicyPrompt = useCallback(() => {
    setFolderSharePolicyPrompt(null);
  }, []);

  const handleConfirmSharePolicy = useCallback(
    (policy: FolderSharePolicy) => {
      if (!folderSharePolicyPrompt) return;
      const { record, normalizedPath, relayOptions, request, items } = folderSharePolicyPrompt;
      const nextRequest: ShareFolderRequest = {
        ...request,
        sharePolicy: policy,
      };
      setFolderSharePolicyPrompt(null);
      setFolderShareRelayPrompt({
        record,
        normalizedPath,
        relayOptions,
        request: nextRequest,
        items,
        sharePolicy: policy,
      });
    },
    [folderSharePolicyPrompt],
  );

  const handleRetryFolderList = useCallback(async () => {
    if (!folderShareDialog) return;
    const { record, relayHints, shareBlobs, shareItems, phases } = folderShareDialog;
    const failedUrls = phases?.list?.failed?.map(entry => entry.url).filter(Boolean) ?? [];
    const relayTargets = failedUrls.length
      ? normalizeRelayUrls(failedUrls)
      : relayHints && relayHints.length > 0
        ? collectRelayTargets(relayHints, shareRelayCandidates)
        : normalizeRelayUrls(shareRelayCandidates);
    if (!relayTargets.length) {
      showStatusMessage("No relays available to retry.", "info", 3500);
      return;
    }
    if (phases?.list.status === "publishing") {
      showStatusMessage("Folder list update already in progress…", "info", 2500);
      return;
    }
    setFolderShareDialog(current => {
      if (!current || current.record.path !== record.path) return current;
      const existingList = current.phases?.list;
      const existingMetadata = current.phases?.metadata;
      const relayUniverse =
        current.relayHints && current.relayHints.length > 0
          ? normalizeRelayUrls(current.relayHints)
          : normalizeRelayUrls(shareRelayCandidates);
      const baseTotal = relayUniverse.length;
      const succeededBefore = existingList
        ? Math.min(existingList.succeeded, baseTotal)
        : Math.max(0, baseTotal - relayTargets.length);
      const nextList: PublishPhaseState = {
        status: "publishing",
        total: baseTotal,
        succeeded: succeededBefore,
        failed: existingList?.failed
          ? [...existingList.failed]
          : relayTargets.map(url => ({ url })),
      };
      const nextMetadata: PublishPhaseState = existingMetadata
        ? { ...existingMetadata }
        : { status: "idle", total: null, succeeded: 0, failed: [] };
      return {
        ...current,
        relayHints: relayUniverse,
        phases: {
          list: nextList,
          metadata: nextMetadata,
        },
      };
    });
    try {
      const retryItems =
        shareItems && shareItems.length > 0
          ? shareItems
          : (shareBlobs ?? [])
              .filter((blob): blob is BlossomBlob =>
                Boolean(blob && typeof blob.sha256 === "string"),
              )
              .map(blob => ({
                blob,
                privateLinkAlias: null,
                privateLinkUrl: null,
              }));

      const allowedShaSet = new Set<string>();
      retryItems.forEach(item => {
        if (item?.blob?.sha256 && item.blob.sha256.length === 64) {
          allowedShaSet.add(item.blob.sha256.toLowerCase());
        }
      });
      if (allowedShaSet.size === 0) {
        record.shas.forEach(sha => {
          if (typeof sha === "string" && sha.length === 64) {
            allowedShaSet.add(sha.toLowerCase());
          }
        });
      }

      const result = await ensureFolderListOnRelays(record, relayTargets, shareBlobs ?? undefined, {
        allowedShas: allowedShaSet,
        sharePolicy: record.sharePolicy ?? folderShareDialog.record.sharePolicy ?? null,
        items: retryItems,
      });
      setFolderShareDialog(current => {
        if (!current || current.record.path !== record.path) return current;
        const relayUniverse =
          current.relayHints && current.relayHints.length > 0
            ? normalizeRelayUrls(current.relayHints)
            : normalizeRelayUrls(shareRelayCandidates);
        const baseTotal = relayUniverse.length;
        const currentMetadata = current.phases?.metadata ?? {
          status: "idle" as const,
          total: baseTotal,
          succeeded: 0,
          failed: [] as RelayPublishFailure[],
        };
        const remainingFailures = result.summary.failed;
        return {
          ...current,
          record: result.record,
          relayHints: relayUniverse,
          shareBlobs: retryItems.map(item => item.blob),
          shareItems: retryItems,
          phases: {
            list: {
              status: remainingFailures.length > 0 ? "partial" : "ready",
              total: baseTotal,
              succeeded: Math.max(0, baseTotal - remainingFailures.length),
              failed: remainingFailures,
              message: result.summary.error,
            },
            metadata: currentMetadata,
          },
        };
      });
      if (result.summary.failed.length === 0) {
        showStatusMessage("Folder list republished to all relays.", "success", 3000);
      } else {
        showStatusMessage(
          "Retry completed, but some relays still need attention.",
          "warning",
          5000,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to republish folder list.";
      setFolderShareDialog(current => {
        if (!current || current.record.path !== record.path) return current;
        const relayUniverse =
          current.relayHints && current.relayHints.length > 0
            ? normalizeRelayUrls(current.relayHints)
            : normalizeRelayUrls(shareRelayCandidates);
        const baseTotal = relayUniverse.length;
        const currentMetadata = current.phases?.metadata ?? {
          status: "idle" as const,
          total: baseTotal,
          succeeded: 0,
          failed: [] as RelayPublishFailure[],
        };
        const previousList = current.phases?.list;
        return {
          ...current,
          relayHints: relayUniverse,
          phases: {
            list: {
              status: "error",
              total: baseTotal,
              succeeded: previousList?.succeeded ?? 0,
              failed: previousList?.failed ? [...previousList.failed] : [],
              message,
            },
            metadata: currentMetadata,
          },
        };
      });
      showStatusMessage(message, "error", 5000);
    }
  }, [ensureFolderListOnRelays, folderShareDialog, shareRelayCandidates, showStatusMessage]);

  const handleRetryFolderMetadata = useCallback(async () => {
    if (!folderShareDialog) return;
    const { record, relayHints, shareBlobs, phases } = folderShareDialog;
    const failedUrls = phases?.metadata?.failed?.map(entry => entry.url).filter(Boolean) ?? [];
    const relayTargets = failedUrls.length
      ? normalizeRelayUrls(failedUrls)
      : relayHints && relayHints.length > 0
        ? collectRelayTargets(relayHints, shareRelayCandidates)
        : normalizeRelayUrls(shareRelayCandidates);
    if (!relayTargets.length) {
      showStatusMessage("No relays available to retry.", "info", 3500);
      return;
    }
    if (phases?.metadata.status === "publishing") {
      showStatusMessage("File details are already publishing…", "info", 2500);
      return;
    }
    setFolderShareDialog(current => {
      if (!current || current.record.path !== record.path) return current;
      const relayUniverse =
        current.relayHints && current.relayHints.length > 0
          ? normalizeRelayUrls(current.relayHints)
          : normalizeRelayUrls(shareRelayCandidates);
      const baseTotal = relayUniverse.length;
      const currentList = current.phases?.list ?? {
        status: "ready" as const,
        total: baseTotal,
        succeeded: Math.max(0, baseTotal - relayTargets.length),
        failed: [] as RelayPublishFailure[],
      };
      const currentMetadata = current.phases?.metadata;
      const nextMetadata: PublishPhaseState = {
        status: "publishing",
        total: baseTotal,
        succeeded: currentMetadata
          ? Math.min(currentMetadata.succeeded, baseTotal)
          : Math.max(0, baseTotal - relayTargets.length),
        failed: currentMetadata?.failed
          ? [...currentMetadata.failed]
          : relayTargets.map(url => ({ url })),
      };
      return {
        ...current,
        relayHints: relayUniverse,
        phases: {
          list: currentList,
          metadata: nextMetadata,
        },
      };
    });
    try {
      const summary = await ensureFolderMetadataOnRelays(
        record,
        relayTargets,
        shareBlobs ?? undefined,
      );
      setFolderShareDialog(current => {
        if (!current || current.record.path !== record.path) return current;
        const relayUniverse =
          current.relayHints && current.relayHints.length > 0
            ? normalizeRelayUrls(current.relayHints)
            : normalizeRelayUrls(shareRelayCandidates);
        const baseTotal = relayUniverse.length;
        const currentList = current.phases?.list ?? {
          status: "ready" as const,
          total: baseTotal,
          succeeded: Math.max(0, baseTotal - summary.failed.length),
          failed: [] as RelayPublishFailure[],
        };
        return {
          ...current,
          relayHints: relayUniverse,
          phases: {
            list: currentList,
            metadata: {
              status: summary.failed.length > 0 ? "partial" : "ready",
              total: baseTotal,
              succeeded: Math.max(0, baseTotal - summary.failed.length),
              failed: summary.failed,
              message: summary.error,
            },
          },
        };
      });
      if (summary.failed.length === 0) {
        showStatusMessage("File details republished to all relays.", "success", 3000);
      } else {
        showStatusMessage(
          "Some relays still need file details. Retry again if needed.",
          "warning",
          5000,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to republish metadata.";
      setFolderShareDialog(current => {
        if (!current || current.record.path !== record.path) return current;
        const relayUniverse =
          current.relayHints && current.relayHints.length > 0
            ? normalizeRelayUrls(current.relayHints)
            : normalizeRelayUrls(shareRelayCandidates);
        const baseTotal = relayUniverse.length;
        const currentList = current.phases?.list ?? {
          status: "ready" as const,
          total: baseTotal,
          succeeded: Math.max(0, baseTotal - relayTargets.length),
          failed: [] as RelayPublishFailure[],
        };
        const previousMetadata = current.phases?.metadata;
        return {
          ...current,
          relayHints: relayUniverse,
          phases: {
            list: currentList,
            metadata: {
              status: "error",
              total: baseTotal,
              succeeded: previousMetadata?.succeeded ?? 0,
              failed: previousMetadata?.failed ? [...previousMetadata.failed] : [],
              message,
            },
          },
        };
      });
      showStatusMessage(message, "error", 5000);
    }
  }, [ensureFolderMetadataOnRelays, folderShareDialog, shareRelayCandidates, showStatusMessage]);

  const handleConfirmShareRelays = useCallback(
    async (selectedRelays: readonly string[]) => {
      if (!folderShareRelayPrompt) return;
      const sanitized = collectRelayTargets(selectedRelays, folderShareRelayPrompt.relayOptions);
      if (!sanitized.length) {
        showStatusMessage("Choose at least one relay to publish to.", "warning", 4000);
        return;
      }
      const payload: ShareFolderExecutionRequest = {
        record: folderShareRelayPrompt.record,
        normalizedPath: folderShareRelayPrompt.normalizedPath,
        relayHints: sanitized,
        items: folderShareRelayPrompt.items,
        sharePolicy: folderShareRelayPrompt.sharePolicy,
      };
      setFolderShareRelayPrompt(null);
      await shareFolderWithRelays(payload);
    },
    [folderShareRelayPrompt, shareFolderWithRelays, showStatusMessage],
  );

  const handleCancelShareRelayPrompt = useCallback(() => {
    setFolderShareRelayPrompt(null);
  }, []);

  const handleUnshareFolder = useCallback(
    async (request: ShareFolderRequest) => {
      const normalizedPath = resolveFolderPath(request.path);
      if (typeof normalizedPath !== "string") {
        showStatusMessage("Folder not found.", "error", 4000);
        return;
      }
      const record = foldersByPath.get(normalizedPath);
      if (!record) {
        showStatusMessage("Folder details unavailable.", "error", 4000);
        return;
      }
      if (record.visibility !== "public") {
        showStatusMessage("This folder is already private.", "info", 2500);
        return;
      }
      if (folderShareBusyPath && folderShareBusyPath !== normalizedPath) {
        showStatusMessage("Another folder is updating. Please wait.", "info", 2500);
        return;
      }
      if (folderShareBusyPath === normalizedPath) {
        showStatusMessage("Folder update in progress…", "info", 2500);
        return;
      }
      setFolderShareBusyPath(normalizedPath);
      try {
        await setFolderVisibility(normalizedPath, "private");
        showStatusMessage(
          "Folder is now private. Shared links will stop working soon.",
          "success",
          4000,
        );
        setFolderShareDialog(current =>
          current && current.record.path === normalizedPath ? null : current,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to update folder visibility.";
        showStatusMessage(message, "error", 5000);
      } finally {
        setFolderShareBusyPath(null);
      }
    },
    [resolveFolderPath, foldersByPath, folderShareBusyPath, setFolderVisibility, showStatusMessage],
  );

  const handleCloseFolderShareDialog = useCallback(() => {
    setFolderShareDialog(null);
  }, []);

  const handleProfileUpdated = useCallback((metadata: ProfileMetadataPayload) => {
    const nextAvatarUrl =
      typeof metadata.picture === "string" && metadata.picture.trim()
        ? metadata.picture.trim()
        : null;
    setAvatarUrl(nextAvatarUrl);
  }, []);

  const latestRemoteSignerSession = useMemo(() => {
    return (
      nip46Snapshot.sessions
        .filter(session => session.status !== "revoked" && !session.lastError)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  }, [nip46Snapshot.sessions]);

  const hasConnectableRemoteSignerSession = useMemo(
    () =>
      nip46Snapshot.sessions.some(session => session.status !== "revoked" && !session.lastError),
    [nip46Snapshot.sessions],
  );

  const isRemoteSignerAdopted = Boolean(signer);
  const shouldShowConnectSignerDialog = connectSignerOpen && !isRemoteSignerAdopted;

  const handleConnectSignerClick = useCallback(() => {
    if (isRemoteSignerAdopted) {
      showStatusMessage("Remote signer already connected", "info", 2500);
      return;
    }

    if (pendingRemoteSignerConnect) {
      showStatusMessage("Connecting to remote signer…", "info", 2500);
      return;
    }

    if (nip46Ready && !latestRemoteSignerSession) {
      setConnectSignerOpen(true);
      return;
    }

    setPendingRemoteSignerConnect(true);
    if (nip46Ready && latestRemoteSignerSession) {
      setConnectSignerOpen(true);
    }
    if (!nip46Ready || !nip46TransportReady || !nip46Service) {
      showStatusMessage("Preparing remote signer support…", "info", 3000);
    } else {
      showStatusMessage("Connecting to remote signer…", "info", 3000);
    }
  }, [
    isRemoteSignerAdopted,
    pendingRemoteSignerConnect,
    nip46Ready,
    latestRemoteSignerSession,
    nip46Service,
    nip46TransportReady,
    showStatusMessage,
  ]);

  useEffect(() => {
    if (!isRemoteSignerAdopted) return;
    setConnectSignerOpen(false);
  }, [isRemoteSignerAdopted]);

  useEffect(() => {
    if (!isRemoteSignerAdopted) return;
    if (!pendingRemoteSignerConnect) return;
    setPendingRemoteSignerConnect(false);
  }, [isRemoteSignerAdopted, pendingRemoteSignerConnect]);

  useEffect(() => {
    if (!pendingRemoteSignerConnect) return;
    if (!nip46Ready) return;
    if (!nip46TransportReady) return;
    if (!nip46Service) return;

    const sessionId = latestRemoteSignerSession?.id;
    if (!sessionId) {
      setPendingRemoteSignerConnect(false);
      if (!hasConnectableRemoteSignerSession) {
        setConnectSignerOpen(true);
      }
      return;
    }

    let cancelled = false;

    const attemptReconnect = async () => {
      try {
        await nip46Service.connectSession(sessionId);
      } catch (error) {
        console.error("Failed to connect remote signer", error);
        if (cancelled) return;
        showStatusMessage("Failed to connect to remote signer. Please re-connect.", "error", 6000);
        setConnectSignerOpen(true);
      } finally {
        if (!cancelled) {
          setPendingRemoteSignerConnect(false);
        }
      }
    };

    void attemptReconnect();

    return () => {
      cancelled = true;
    };
  }, [
    pendingRemoteSignerConnect,
    nip46Ready,
    nip46Service,
    nip46TransportReady,
    latestRemoteSignerSession,
    hasConnectableRemoteSignerSession,
    showStatusMessage,
  ]);

  const handleRequestRename = useCallback((blob: BlossomBlob) => {
    setRenameTarget(blob);
  }, []);

  const handleRequestFolderRename = useCallback((path: string) => {
    setFolderRenamePath(path);
  }, []);

  const handleRenameDialogClose = useCallback(() => {
    setRenameTarget(null);
  }, []);

  const handleFolderRenameClose = useCallback(() => {
    setFolderRenamePath(null);
  }, []);

  const handleBreadcrumbHome = useCallback(() => {
    setHomeNavigationKey(value => value + 1);
    selectTab("browse");
    browseNavigationState?.onNavigateHome();
  }, [browseNavigationState, selectTab]);

  const handleSyncSelectedServers = useCallback(() => {
    if (syncEnabledServerUrls.length < 2) {
      showStatusMessage("Enable sync on at least two servers to start.", "info", 3000);
      return;
    }
    pendingSyncRef.current = true;
    selectTab("transfer");
    if (syncStarterRef.current) {
      const runner = syncStarterRef.current;
      pendingSyncRef.current = false;
      runner();
    }
  }, [showStatusMessage, syncEnabledServerUrls.length, selectTab]);

  const handleSetDefaultServer = useCallback(
    (url: string | null) => {
      setDefaultServerUrl(url);
      if (url) {
        setSelectedServer(url);
      }
    },
    [setDefaultServerUrl],
  );

  const handleSetDefaultViewMode = useCallback(
    (mode: "grid" | "list") => {
      setDefaultViewMode(mode);
    },
    [setDefaultViewMode],
  );

  const handleSetDefaultFilterMode = useCallback(
    (mode: FilterMode) => {
      if (preferences.defaultFilterMode === mode) return;
      setDefaultFilterMode(mode);
    },
    [preferences.defaultFilterMode, setDefaultFilterMode],
  );

  const handleSetDefaultSortOption = useCallback(
    (option: DefaultSortOption) => {
      if (preferences.defaultSortOption === option) return;
      setDefaultSortOption(option);
    },
    [preferences.defaultSortOption, setDefaultSortOption],
  );

  const handleSetSortDirection = useCallback(
    (direction: SortDirection) => {
      if (preferences.sortDirection === direction) return;
      setSortDirection(direction);
    },
    [preferences.sortDirection, setSortDirection],
  );

  const handleSetShowPreviewsInGrid = useCallback(
    (value: boolean) => {
      setShowGridPreviews(value);
    },
    [setShowGridPreviews],
  );

  const handleSetShowPreviewsInList = useCallback(
    (value: boolean) => {
      setShowListPreviews(value);
    },
    [setShowListPreviews],
  );

  const handleSetKeepSearchExpanded = useCallback(
    (value: boolean) => {
      setKeepSearchExpanded(value);
    },
    [setKeepSearchExpanded],
  );

  const handleSetTheme = useCallback(
    (nextTheme: "dark" | "light") => {
      setTheme(nextTheme);
    },
    [setTheme],
  );

  const handleToggleSearch = useCallback(() => {
    if (keepSearchExpanded) {
      selectTab("browse");
      setIsSearchOpen(true);
      return;
    }
    setIsSearchOpen(prev => {
      const next = !prev;
      if (next) {
        selectTab("browse");
      } else {
        setSearchQuery("");
      }
      return next;
    });
  }, [keepSearchExpanded, selectTab]);

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && !keepSearchExpanded) {
        setIsSearchOpen(false);
        setSearchQuery("");
      }
    },
    [keepSearchExpanded],
  );

  const handleInsertSearchToken = useCallback(
    (token: string) => {
      const normalized = token.trim();
      if (!normalized) return;
      setIsSearchOpen(true);
      setSearchQuery(prev => {
        const trimmed = prev.trim();
        if (!trimmed) {
          return `${normalized} `;
        }
        return `${trimmed} ${normalized} `;
      });
      if (typeof window !== "undefined") {
        window.requestAnimationFrame(() => {
          const node = searchInputRef.current;
          if (node) {
            node.focus();
            const length = node.value.length;
            try {
              node.setSelectionRange(length, length);
            } catch {
              // Ignore selection errors in non-editable states.
            }
          }
        });
      }
    },
    [searchInputRef],
  );

  useEffect(() => {
    if (isSearchOpen) {
      const id = window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isSearchOpen]);

  useEffect(() => {
    if (showAuthPrompt) {
      setIsSearchOpen(false);
      setSearchQuery("");
    }
  }, [showAuthPrompt]);

  useEffect(() => {
    if (keepSearchExpanded && !showAuthPrompt) {
      setIsSearchOpen(true);
    } else if (!keepSearchExpanded) {
      setIsSearchOpen(prev => (prev ? false : prev));
      setSearchQuery("");
    }
  }, [keepSearchExpanded, showAuthPrompt]);

  useEffect(() => {
    if (!keepSearchExpanded && tab !== "browse" && isSearchOpen) {
      setIsSearchOpen(false);
      setSearchQuery("");
    }
  }, [isSearchOpen, keepSearchExpanded, tab]);

  const schedulePendingSaveAttempt = useCallback((backoffUntil?: number) => {
    if (retryPendingSaveTimeout.current) {
      clearTimeout(retryPendingSaveTimeout.current);
      retryPendingSaveTimeout.current = null;
    }

    setPendingSaveVersion(prev => prev + 1);

    if (backoffUntil === undefined) return;
    const delay = Math.max(0, backoffUntil - Date.now());
    retryPendingSaveTimeout.current = setTimeout(() => {
      retryPendingSaveTimeout.current = null;
      setPendingSaveVersion(prev => prev + 1);
    }, delay);
  }, []);

  const queuePendingSave = useCallback(
    (payload: PendingSave) => {
      pendingSaveRef.current = payload;
      schedulePendingSaveAttempt(payload.backoffUntil);
    },
    [schedulePendingSaveAttempt],
  );

  const attemptSave = useCallback(
    async (serversToPersist: ManagedServer[], successMessage?: string) => {
      try {
        await saveServers(serversToPersist);
        showStatusMessage(successMessage ?? "Server list updated", "success", 2500);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save servers";
        const backoffUntil = Date.now() + 5000;
        queuePendingSave({ servers: serversToPersist, successMessage, backoffUntil });
        showStatusMessage(message, "error", 3000);
      }
    },
    [queuePendingSave, saveServers, showStatusMessage],
  );

  const flushPendingSave = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    if (!signer || saving) return;
    if (pending.backoffUntil && pending.backoffUntil > Date.now()) return;

    pendingSaveRef.current = null;
    void attemptSave(pending.servers, pending.successMessage);
  }, [attemptSave, saving, signer]);

  useEffect(() => {
    flushPendingSave();
  }, [flushPendingSave, pendingSaveVersion]);

  const persistServers = useCallback(
    (serversToPersist: ManagedServer[], options?: { successMessage?: string }): boolean => {
      const validationError = validateManagedServers(serversToPersist);
      if (validationError) {
        showStatusMessage(validationError, "error", 3000);
        return false;
      }

      const normalized = sortServersByName(serversToPersist.map(normalizeManagedServer));
      setLocalServers(normalized);

      const successMessage = options?.successMessage;

      if (!signer) {
        queuePendingSave({ servers: normalized, successMessage });
        showStatusMessage("Connect your signer to finish saving changes", "info", 3000);
        return true;
      }

      if (saving) {
        queuePendingSave({ servers: normalized, successMessage });
        showStatusMessage("Saving queued…", "info", 2000);
        return true;
      }

      void attemptSave(normalized, successMessage);
      return true;
    },
    [attemptSave, queuePendingSave, saving, showStatusMessage, signer],
  );

  const handleAddServer = (server: ManagedServer) => {
    const normalized = normalizeManagedServer(server);
    const trimmedUrl = normalized.url;
    if (!trimmedUrl) return;

    let added = false;
    let nextServers: ManagedServer[] | null = null;

    setLocalServers(prev => {
      if (prev.find(existing => existing.url === trimmedUrl)) {
        nextServers = prev;
        return prev;
      }

      const next = sortServersByName([...prev, normalized]);
      nextServers = next;
      added = true;
      return next;
    });

    setSelectedServer(trimmedUrl);

    if (added && nextServers) {
      persistServers(nextServers, { successMessage: "Server added" });
    }
  };

  const handleUpdateServer = (originalUrl: string, updated: ManagedServer) => {
    const normalized = normalizeManagedServer(updated);
    const normalizedUrl = normalized.url;
    if (!normalizedUrl) return;

    let updatedServers: ManagedServer[] | null = null;
    let didChange = false;

    setLocalServers(prev => {
      if (prev.some(server => server.url !== originalUrl && server.url === normalizedUrl)) {
        updatedServers = prev;
        return prev;
      }

      const replaced = prev.map(server => {
        if (server.url !== originalUrl) return server;
        didChange =
          didChange ||
          server.name !== normalized.name ||
          server.url !== normalized.url ||
          server.type !== normalized.type ||
          Boolean(server.requiresAuth) !== normalized.requiresAuth ||
          Boolean(server.sync) !== normalized.sync;
        return normalized;
      });

      const sorted = sortServersByName(replaced);
      updatedServers = sorted;
      return sorted;
    });

    setSelectedServer(prev => {
      if (prev === originalUrl) {
        return normalizedUrl;
      }
      return prev;
    });

    if (didChange && updatedServers) {
      persistServers(updatedServers, { successMessage: "Server updated" });
    }
  };

  const handleRemoveServer = useCallback(
    async (url: string) => {
      const target = localServers.find(server => server.url === url);
      if (!target) return;

      const confirmed = await confirm({
        title: "Remove server",
        message: `Remove ${target.name || target.url}?`,
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        tone: "danger",
      });
      if (!confirmed) return;

      const nextServers = localServers.filter(server => server.url !== url);
      if (nextServers.length === localServers.length) {
        return;
      }

      const committed = persistServers(nextServers, { successMessage: "Server removed" });
      if (!committed) {
        return;
      }

      if (selectedServer === url) {
        setSelectedServer(null);
      }
    },
    [confirm, localServers, persistServers, selectedServer, setSelectedServer],
  );

  const handleShareBlob = useCallback(
    (payload: SharePayload, options?: { mode?: ShareMode }) => {
      openShareForPayload(payload, options?.mode);
      const targetTab: TabId = options?.mode === "private-link" ? "share-private" : "share";
      selectTab(targetTab);
    },
    [openShareForPayload, selectTab],
  );

  const handleShareComplete = useCallback(
    (result: ShareCompletion) => {
      const label = completeShareInternal(result);
      const isDm = result.mode === "dm" || result.mode === "dm-private";
      const isPrivateDm = result.mode === "dm-private";
      if (!isDm) {
        if (!result.success && result.message) {
          showStatusMessage(result.message, "error", 5000);
        }
        return;
      }
      if (result.success) {
        const dmLabel = isPrivateDm ? "Private DM" : "DM";
        let message = label ? `${dmLabel} sent to ${label}.` : `${dmLabel} sent.`;
        if (result.failures && result.failures > 0) {
          message += ` ${result.failures} relay${result.failures === 1 ? "" : "s"} reported errors.`;
        }
        showStatusMessage(
          message,
          result.failures && result.failures > 0 ? "info" : "success",
          5000,
        );
        selectTab("browse");
      } else {
        const dmLabel = isPrivateDm ? "private DM" : "DM";
        const message =
          result.message ||
          (label ? `Failed to send ${dmLabel} to ${label}.` : `Failed to send ${dmLabel}.`);
        showStatusMessage(message, "error", 6000);
      }
    },
    [completeShareInternal, selectTab, showStatusMessage],
  );

  const handleUploadCompleted = (success: boolean) => {
    if (!success) return;
    servers.forEach(server => {
      queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url] });
    });

    if (uploadReturnTarget && uploadReturnTarget.selectedServer !== selectedServer) {
      setSelectedServer(uploadReturnTarget.selectedServer);
    }

    if (uploadReturnTarget?.tab === "browse" && uploadReturnTarget.browseActiveList) {
      browseRestoreCounterRef.current += 1;
      setPendingBrowseRestore({
        state: { ...uploadReturnTarget.browseActiveList },
        key: browseRestoreCounterRef.current,
      });
    }

    showStatusMessage("All files uploaded successfully", "success", 5000);
  };

  const handleStatusServerChange: React.ChangeEventHandler<HTMLSelectElement> = event => {
    const value = event.target.value;
    if (value === ALL_SERVERS_VALUE) {
      setSelectedServer(null);
    } else {
      setSelectedServer(value);
    }
    selectTab("browse");
  };

  const toneClassByKey: Record<
    "muted" | "syncing" | "success" | "warning" | "info" | "error",
    string
  > = {
    muted: "text-slate-500",
    syncing: "text-emerald-300",
    success: "text-emerald-200",
    warning: "text-amber-300",
    info: "text-slate-400",
    error: "text-red-400",
  };

  const syncSummary = useMemo(() => {
    if (syncEnabledServerUrls.length < 2) {
      return { text: null, tone: "muted" as const };
    }
    if (syncStatus.state === "syncing") {
      const percent = Math.min(100, Math.max(0, Math.round((syncStatus.progress || 0) * 100)));
      return { text: `Syncing servers – ${percent}%`, tone: "syncing" as const };
    }
    if (syncStatus.state === "error") {
      return { text: "Servers not in sync", tone: "error" as const };
    }
    if (!syncSnapshot.syncAutoReady) {
      return { text: "Sync setup pending", tone: "info" as const };
    }
    if (syncSnapshot.allLinkedServersSynced) {
      return { text: "All servers synced", tone: "success" as const };
    }
    return { text: "Servers not in sync", tone: "warning" as const };
  }, [
    syncEnabledServerUrls.length,
    syncStatus,
    syncSnapshot.allLinkedServersSynced,
    syncSnapshot.syncAutoReady,
  ]);

  const derivedStatusMessage = statusMessage
    ? statusMessage
    : (pipelineStatusMessage ?? (syncLoading ? "Syncing settings" : null));
  const centerMessage = derivedStatusMessage ?? syncSummary.text;
  const centerTone = (() => {
    if (statusMessage) {
      if (statusMessageTone === "error") return "error" as const;
      if (statusMessageTone === "success") return "success" as const;
      return "info" as const;
    }
    if (pipelineStatusMessage) {
      return pipelineStatusTone;
    }
    if (syncLoading) {
      return "syncing" as const;
    }
    return syncSummary.text ? syncSummary.tone : ("muted" as const);
  })();
  const centerClass = toneClassByKey[centerTone];

  const statusSelectValue = selectedServer ?? ALL_SERVERS_VALUE;

  const statusCount = statusMetrics.count;
  const statusSize = statusMetrics.size;
  const showStatusTotals =
    tab === "browse" || tab === "upload" || tab === "share" || tab === "transfer";
  const hideServerSelectorTabs: TabId[] = ["profile", "relays", "servers", "settings"];
  const showServerSelector = !hideServerSelectorTabs.includes(tab);
  const showGithubLink = hideServerSelectorTabs.includes(tab);
  const showSupportLink = showGithubLink;

  const handleProvideSyncStarter = useCallback((runner: () => void) => {
    syncStarterRef.current = runner;
    if (pendingSyncRef.current) {
      pendingSyncRef.current = false;
      runner();
    }
  }, []);

  const handleStatusMetricsChange = useCallback((metrics: StatusMetrics) => {
    setStatusMetrics(metrics);
  }, []);

  const handleSyncStateChange = useCallback((snapshot: SyncStateSnapshot) => {
    setSyncSnapshot(snapshot);
  }, []);

  const toggleUserMenu = useCallback(() => {
    setIsUserMenuOpen(prev => !prev);
  }, []);

  const handleSelectProfile = useCallback(() => {
    selectTab("profile");
    setIsUserMenuOpen(false);
  }, [selectTab]);

  const handleSelectSettings = useCallback(() => {
    selectTab("settings");
    setIsUserMenuOpen(false);
  }, [selectTab]);

  const userMenuLinks = useMemo(
    () =>
      [
        { label: "Edit Profile", icon: EditIcon, handler: handleSelectProfile },
        { label: "Settings", icon: SettingsIcon, handler: handleSelectSettings },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    [handleSelectProfile, handleSelectSettings],
  );

  const handleDisconnectClick = useCallback(() => {
    setIsUserMenuOpen(false);
    disconnect();
  }, [disconnect]);

  const isLightTheme = preferences.theme === "light";
  const shellBaseClass =
    "relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-3xl border border-slate-800/70";
  const shellClass = showAuthPrompt
    ? `${shellBaseClass} ${isLightTheme ? "bg-slate-900/70" : "bg-slate-900/70"}`
    : `${shellBaseClass} ${
        isLightTheme
          ? "bg-white surface-sheet shadow-panel noise-layer"
          : "bg-slate-900 surface-sheet shadow-panel noise-layer"
      }`;
  const userMenuButtonClass = isLightTheme
    ? "relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white/90 p-0 text-xs text-slate-700 transition hover:border-blue-400 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
    : "relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-800/80 bg-slate-900/80 p-0 text-xs text-slate-200 transition hover:border-emerald-400 hover:text-emerald-300 focus:outline-none focus-visible:focus-emerald-ring";
  const userMenuContainerClass = isLightTheme
    ? "absolute right-0 z-50 mt-3 min-w-[12rem] rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-700 shadow-lg backdrop-blur-sm"
    : "absolute right-0 z-50 mt-3 min-w-[12rem] rounded-xl border border-slate-800/80 bg-slate-900/90 px-3 py-2 text-sm text-slate-200 shadow-floating backdrop-blur";
  const userMenuItemClass = isLightTheme
    ? "flex w-full items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-100 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
    : "flex w-full items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800/70 hover:text-emerald-300 focus-visible:focus-emerald-ring";

  const shouldShowFloatingPlayer = Boolean(audio.current);

  return (
    <div className="surface-window flex min-h-screen max-h-screen w-full flex-col overflow-hidden text-slate-100">
      <div className="flex w-full flex-1 min-h-0 flex-col gap-2 px-0 py-0 sm:px-6 sm:py-8 lg:mx-auto lg:max-w-7xl">
        <header className="relative z-30 flex flex-col gap-4 rounded-3xl border border-slate-800/70 bg-slate-900/80 p-4 shadow-toolbar backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3">
              <img
                src="/bloom.webp"
                alt="Bloom logo"
                className="h-8 w-8 rounded-lg object-cover md:h-9 md:w-9"
              />
              <div className="leading-tight">
                <h1 className="text-sm font-semibold tracking-tight">Bloom</h1>
                <p className="hidden text-[11px] text-slate-400 sm:block">
                  Manage your content, upload media, and mirror files across servers.
                </p>
              </div>
            </div>
            {user && (
              <div className="relative ml-auto" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={toggleUserMenu}
                  className={userMenuButtonClass}
                  aria-haspopup="menu"
                  aria-expanded={isUserMenuOpen}
                  aria-label={isUserMenuOpen ? "Close account menu" : "Open account menu"}
                  title="Account options"
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt="User avatar"
                      className="block h-full w-full rounded-full object-cover"
                      onError={() => setAvatarUrl(null)}
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center font-semibold">
                      {userInitials}
                    </span>
                  )}
                  <span
                    className={`pointer-events-none absolute -bottom-1.5 -right-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border shadow-toolbar ${
                      preferences.theme === "light"
                        ? "border-slate-200 bg-white text-slate-900"
                        : "border-slate-900 bg-slate-950 text-emerald-300"
                    }`}
                    aria-hidden="true"
                  >
                    <SettingsIcon size={12} />
                  </span>
                </button>
                {isUserMenuOpen && (
                  <div className={userMenuContainerClass}>
                    <ul className="flex flex-col gap-1">
                      {userMenuLinks.map(item => (
                        <li key={item.label}>
                          <a
                            href="#"
                            onClick={event => {
                              event.preventDefault();
                              item.handler();
                            }}
                            className={userMenuItemClass}
                          >
                            <item.icon size={16} />
                            <span>{item.label}</span>
                          </a>
                        </li>
                      ))}
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleDisconnectClick();
                          }}
                          className={userMenuItemClass}
                        >
                          <LogoutIcon size={16} />
                          <span>Disconnect</span>
                        </a>
                      </li>
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
          {!showAuthPrompt && (
            <MainNavigation
              showAuthPrompt={false}
              keepSearchExpanded={keepSearchExpanded}
              browseNavigationState={browseNavigationState}
              isSearchOpen={isSearchOpen}
              searchQuery={searchQuery}
              searchInputRef={searchInputRef}
              onSearchChange={handleSearchChange}
              onSearchKeyDown={handleSearchKeyDown}
              onSearchClear={handleClearSearch}
              onInsertSearchToken={handleInsertSearchToken}
              onToggleSearch={handleToggleSearch}
              browseHeaderControls={browseHeaderControls}
              selectedCount={selectedBlobs.size}
              tab={tab}
              onSelectTab={selectTab}
              navTabs={NAV_TABS}
              onBreadcrumbHome={handleBreadcrumbHome}
              theme={preferences.theme}
            />
          )}
        </header>

        <div className={shellClass}>
          <div ref={mainWidgetRef} className="flex flex-1 min-h-0 flex-col">
            {showAuthPrompt ? (
              <LoggedOutPrompt
                onConnect={connect}
                onConnectRemoteSigner={handleConnectSignerClick}
                hasNip07Extension={hasNip07Extension}
              />
            ) : (
              <WorkspaceSection
                tab={tab}
                localServers={localServers}
                selectedServer={selectedServer}
                onSelectServer={setSelectedServer}
                homeNavigationKey={homeNavigationKey}
                defaultViewMode={preferences.defaultViewMode}
                defaultFilterMode={preferences.defaultFilterMode}
                showGridPreviews={preferences.showGridPreviews}
                showListPreviews={preferences.showListPreviews}
                defaultSortOption={preferences.defaultSortOption}
                sortDirection={preferences.sortDirection}
                onStatusMetricsChange={handleStatusMetricsChange}
                onSyncStateChange={handleSyncStateChange}
                onProvideSyncStarter={handleProvideSyncStarter}
                onRequestRename={handleRequestRename}
                onRequestFolderRename={handleRequestFolderRename}
                folderRenamePath={folderRenamePath}
                onCloseFolderRename={handleFolderRenameClose}
                onRequestShare={handleShareBlob}
                onShareFolder={handleShareFolder}
                onUnshareFolder={handleUnshareFolder}
                folderShareBusyPath={folderShareBusyPath}
                onSetTab={selectTab}
                onUploadCompleted={handleUploadCompleted}
                showStatusMessage={showStatusMessage}
                onProvideBrowseControls={setBrowseHeaderControls}
                onProvideBrowseNavigation={setBrowseNavigationState}
                onFilterModeChange={handleFilterModeChange}
                searchQuery={searchQuery}
                onBrowseActiveListChange={handleBrowseActiveListChange}
                browseRestoreState={pendingBrowseRestore?.state ?? null}
                browseRestoreKey={pendingBrowseRestore?.key ?? null}
                onBrowseRestoreHandled={handleBrowseRestoreHandled}
                uploadFolderSuggestion={uploadFolderSuggestion}
                shareState={shareState}
                onClearShareState={clearShareState}
                onShareComplete={handleShareComplete}
                defaultServerUrl={preferences.defaultServerUrl}
                keepSearchExpanded={keepSearchExpanded}
                theme={preferences.theme}
                syncEnabled={syncEnabled}
                syncLoading={syncLoading}
                syncError={syncError}
                syncPending={syncPending}
                syncLastSyncedAt={syncLastSyncedAt}
                onToggleSyncEnabled={setSyncEnabled}
                onSetDefaultViewMode={handleSetDefaultViewMode}
                onSetDefaultFilterMode={handleSetDefaultFilterMode}
                onSetDefaultSortOption={handleSetDefaultSortOption}
                onSetSortDirection={handleSetSortDirection}
                onSetDefaultServer={handleSetDefaultServer}
                onSetShowGridPreviews={handleSetShowPreviewsInGrid}
                onSetShowListPreviews={handleSetShowPreviewsInList}
                onSetKeepSearchExpanded={handleSetKeepSearchExpanded}
                onSetTheme={handleSetTheme}
                saving={saving}
                signer={signer}
                onAddServer={handleAddServer}
                onUpdateServer={handleUpdateServer}
                onRemoveServer={handleRemoveServer}
                onSyncSelectedServers={handleSyncSelectedServers}
                syncButtonDisabled={syncButtonDisabled}
                syncBusy={syncBusy}
                serverValidationError={serverValidationError}
                onProfileUpdated={handleProfileUpdated}
              />
            )}
          </div>
        </div>

        {shouldShowFloatingPlayer && (
          <Suspense fallback={null}>
            <AudioPlayerCardLazy audio={audio} variant="docked" />
          </Suspense>
        )}

        <StatusFooter
          isSignedIn={isSignedIn}
          localServers={localServers}
          statusSelectValue={statusSelectValue}
          onStatusServerChange={handleStatusServerChange}
          centerClass={centerClass}
          centerMessage={centerMessage}
          showStatusTotals={showStatusTotals}
          showServerSelector={showServerSelector}
          statusCount={statusCount}
          statusSize={statusSize}
          allServersValue={ALL_SERVERS_VALUE}
          showGithubLink={showGithubLink}
          showSupportLink={showSupportLink}
          theme={preferences.theme}
          userMenuItems={userMenuLinks}
          onDisconnect={handleDisconnectClick}
          showCompactUploadControl={showCompactUploadControl}
          compactUploadLabel={compactUploadLabel}
          compactUploadIcon={compactUploadIcon}
          compactUploadActive={compactUploadActive}
          onCompactUploadClick={handleCompactUploadClick}
        />

        {!showAuthPrompt && renameTarget && (
          <Suspense
            fallback={
              <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/80 text-sm text-slate-300">
                Loading editor…
              </div>
            }
          >
            <RenameDialogLazy
              blob={renameTarget}
              ndk={ndk}
              signer={signer}
              relays={effectiveRelays}
              onClose={handleRenameDialogClose}
              onStatus={showStatusMessage}
            />
          </Suspense>
        )}

        {folderSharePolicyPrompt ? (
          <FolderSharePolicyPrompt
            record={folderSharePolicyPrompt.record}
            counts={folderSharePolicyPrompt.counts}
            defaultPolicy={folderSharePolicyPrompt.defaultPolicy}
            onConfirm={handleConfirmSharePolicy}
            onCancel={handleCancelSharePolicyPrompt}
          />
        ) : null}

        {folderShareRelayPrompt ? (
          <FolderShareRelayPrompt
            record={folderShareRelayPrompt.record}
            relays={folderShareRelayPrompt.relayOptions}
            onConfirm={handleConfirmShareRelays}
            onCancel={handleCancelShareRelayPrompt}
          />
        ) : null}

        {folderShareDialog ? (
          <FolderShareDialog
            record={folderShareDialog.record}
            shareUrl={folderShareDialog.shareUrl}
            naddr={folderShareDialog.naddr}
            onClose={handleCloseFolderShareDialog}
            onStatus={showStatusMessage}
            phases={folderShareDialog.phases}
            onRetryList={handleRetryFolderList}
            onRetryMetadata={handleRetryFolderMetadata}
          />
        ) : null}

        <Suspense fallback={null}>
          <ConnectSignerDialogLazy
            open={shouldShowConnectSignerDialog}
            onClose={() => setConnectSignerOpen(false)}
          />
        </Suspense>
      </div>
    </div>
  );
}
