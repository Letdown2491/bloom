import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useNdk, useCurrentPubkey } from "./context/NdkContext";
import { useNip46 } from "./context/Nip46Context";
import { useFolderLists } from "./context/FolderListContext";
import { useAudio } from "./context/AudioContext";
import { useUserPreferences, type DefaultSortOption, type SortDirection } from "./context/UserPreferencesContext";
import { useDialog } from "./context/DialogContext";
import { useServers, ManagedServer, sortServersByName } from "./hooks/useServers";
import { usePreferredRelays } from "./hooks/usePreferredRelays";
import { useAliasSync } from "./hooks/useAliasSync";
import { useIsCompactScreen } from "../shared/hooks/useIsCompactScreen";
import { useShareWorkflow } from "../features/share/useShareWorkflow";
import { useSelection } from "../features/selection/SelectionContext";
import { deriveServerNameFromUrl } from "../shared/utils/serverName";
import { DEFAULT_PUBLIC_RELAYS, sanitizeRelayUrl } from "../shared/utils/relays";
import { buildNip94EventTemplate } from "../shared/api/nip94";
import { ShareFolderRequest } from "../shared/types/shareFolder";

import type { ShareCompletion, SharePayload, ShareMode } from "../features/share/ui/ShareComposer";
import type { BlossomBlob } from "../shared/api/blossomClient";
import type { StatusMessageTone } from "../shared/types/status";
import type { TabId } from "../shared/types/tabs";
import type { SyncStateSnapshot } from "../features/workspace/TransferTabContainer";
import type { BrowseActiveListState, BrowseNavigationState } from "../features/workspace/BrowseTabContainer";
import type { FilterMode } from "../shared/types/filter";
import type { ProfileMetadataPayload } from "../features/profile/ProfilePanel";

import {
  ChevronRightIcon,
  ChevronLeftIcon,
  CloseIcon,
  HomeIcon,
  SearchIcon,
  TransferIcon,
  UploadIcon,
  SettingsIcon,
  EditIcon,
  LinkIcon,
  LogoutIcon,
} from "../shared/ui/icons";
import { FolderShareDialog } from "../features/share/ui/FolderShareDialog";
import { StatusFooter } from "../shared/ui/StatusFooter";
import { WorkspaceSection } from "../features/workspace/ui/WorkspaceSection";
import {
  encodeFolderNaddr,
  isPrivateFolderName,
  buildFolderEventTemplate,
  type FolderListRecord,
  type FolderFileHint,
} from "../shared/domain/folderList";

const ConnectSignerDialogLazy = React.lazy(() =>
  import("../features/nip46/ConnectSignerDialog").then(module => ({ default: module.ConnectSignerDialog }))
);

const RenameDialogLazy = React.lazy(() =>
  import("../features/rename/RenameDialog").then(module => ({ default: module.RenameDialog }))
);

const AudioPlayerCardLazy = React.lazy(() =>
  import("../features/browse/BrowseTab").then(module => ({ default: module.AudioPlayerCard }))
);

const NAV_TABS = [{ id: "upload" as const, label: "Upload", icon: UploadIcon }];
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
    if (!/^https?:\/\//i.test(trimmedUrl)) return "Server URLs must start with http:// or https://.";
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
};

const collectRelayUrls = (relays: readonly string[]) => {
  const set = new Set<string>();
  relays.forEach(url => {
    const normalized = sanitizeRelayUrl(url);
    if (normalized) {
      set.add(normalized);
    }
  });
  return Array.from(set);
};

export default function App() {
  const queryClient = useQueryClient();
  const { connect, disconnect, user, signer, ndk, getModule } = useNdk();
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
  const { confirm } = useDialog();
  const { effectiveRelays } = usePreferredRelays();
  useAliasSync(effectiveRelays, Boolean(pubkey));

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
  const [browseNavigationState, setBrowseNavigationState] = useState<BrowseNavigationState | null>(null);
  const [browseActiveList, setBrowseActiveList] = useState<BrowseActiveListState | null>(null);
  const browseRestoreCounterRef = useRef(0);
  const [pendingBrowseRestore, setPendingBrowseRestore] = useState<
    { state: BrowseActiveListState | null; key: number } | null
  >(null);
  const [uploadReturnTarget, setUploadReturnTarget] = useState<
    { tab: TabId; browseActiveList: BrowseActiveListState | null; selectedServer: string | null } | null
  >(null);
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
  const {
    shareState,
    openShareForPayload,
    openShareByKey,
    handleShareComplete: completeShareInternal,
    clearShareState,
  } = useShareWorkflow();

  const audio = useAudio();
  const { foldersByPath, resolveFolderPath, setFolderVisibility } = useFolderLists();
  const [folderShareBusyPath, setFolderShareBusyPath] = useState<string | null>(null);
  const [folderShareDialog, setFolderShareDialog] = useState<FolderShareDialogState | null>(null);

  const { enabled: syncEnabled, loading: syncLoading, error: syncError, pending: syncPending, lastSyncedAt: syncLastSyncedAt } = syncState;

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
    [tab, browseActiveList, selectedServer]
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
    [localServers]
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
    (syncSnapshot.syncAutoReady && syncSnapshot.allLinkedServersSynced && syncStatus.state !== "error");

  useEffect(() => {
    setLocalServers(servers);
  }, [servers]);

  useEffect(() => {
    setSelectedServer(prev => {
      if (prev && servers.some(server => server.url === prev)) {
        return prev;
      }
      if (preferences.defaultServerUrl && servers.some(server => server.url === preferences.defaultServerUrl)) {
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
    []
  );

  const ensureRelayConnections = useCallback(
    async (relayUrls: readonly string[]) => {
      if (!ndk) return;
      const targets = collectRelayUrls(relayUrls);
      if (!targets.length) return;
      let attemptedConnection = false;
      targets.forEach(url => {
        const relay = ndk.pool?.relays.get(url);
        if (relay) {
          if (typeof relay.connect === "function") {
            try {
              relay.connect();
              attemptedConnection = true;
            } catch (error) {
              console.warn("Unable to connect to relay", url, error);
            }
          }
          return;
        }
        try {
          ndk.addExplicitRelay(url, undefined, true);
          attemptedConnection = true;
        } catch (error) {
          console.warn("Unable to add relay for sharing", url, error);
        }
      });
      if (attemptedConnection) {
        try {
          await ndk.connect();
        } catch (error) {
          console.warn("Failed to establish relay connections for sharing", error);
        }
      }
    },
    [ndk]
  );

  const ensureFolderListOnRelays = useCallback(
    async (record: FolderListRecord, relayUrls: readonly string[], blobs?: BlossomBlob[]) => {
      if (!ndk || !signer || !user) return record;
      const sanitizedRelays = collectRelayUrls(relayUrls.length ? relayUrls : DEFAULT_PUBLIC_RELAYS);
      if (!sanitizedRelays.length) return record;
      await ensureRelayConnections(sanitizedRelays);

      const shaSet = new Set<string>();
      record.shas.forEach(sha => {
        if (typeof sha === "string" && sha.length === 64) {
          shaSet.add(sha.toLowerCase());
        }
      });
      blobs?.forEach(blob => {
        if (blob?.sha256 && blob.sha256.length === 64) {
          shaSet.add(blob.sha256.toLowerCase());
        }
      });
      const shas = Array.from(shaSet).sort((a, b) => a.localeCompare(b));

      const baseHints = record.fileHints ?? {};
      const hintMap: Record<string, FolderFileHint> = {};
      shas.forEach(sha => {
        const existing = baseHints[sha];
        hintMap[sha] = existing ? { ...existing, sha } : { sha };
      });

      const registerBlobHint = (blob?: BlossomBlob | null) => {
        if (!blob?.sha256 || blob.sha256.length !== 64) return;
        const sha = blob.sha256.toLowerCase();
        if (!hintMap[sha]) {
          hintMap[sha] = { sha };
        }
        const entry = hintMap[sha];
        const normalizedServer = blob.serverUrl ? blob.serverUrl.replace(/\/+$/, "") : undefined;
        const fallbackUrl = normalizedServer ? `${normalizedServer}/${blob.sha256}` : undefined;
        const resolvedUrl = blob.url?.trim() || fallbackUrl;
        if (resolvedUrl) entry.url = resolvedUrl;
        if (normalizedServer) entry.serverUrl = normalizedServer;
        if (typeof blob.requiresAuth === "boolean") entry.requiresAuth = blob.requiresAuth;
        if (blob.serverType) entry.serverType = blob.serverType;
        if (blob.type) entry.mimeType = blob.type;
        if (typeof blob.size === "number" && Number.isFinite(blob.size)) entry.size = blob.size;
        if (blob.name) entry.name = blob.name;
      };

      blobs?.forEach(registerBlobHint);

      const effectiveHints = Object.fromEntries(
        Object.entries(hintMap).filter(([, hint]) => {
          if (!hint) return false;
          if (hint.url && hint.url.trim()) return true;
          if (hint.serverUrl && hint.serverUrl.trim()) return true;
          if (typeof hint.requiresAuth === "boolean") return true;
          if (hint.mimeType) return true;
          if (typeof hint.size === "number" && Number.isFinite(hint.size)) return true;
          if (hint.name) return true;
          return false;
        })
      );

      const shareRecord: FolderListRecord = {
        ...record,
        shas,
        pubkey: record.pubkey ?? user.pubkey,
        fileHints: Object.keys(effectiveHints).length > 0 ? effectiveHints : record.fileHints,
      };

      try {
        const module = await getModule();
        const relaySet = module.NDKRelaySet.fromRelayUrls(sanitizedRelays, ndk);
        const createdAt = Math.floor(Date.now() / 1000);
        const template = buildFolderEventTemplate(shareRecord, shareRecord.pubkey ?? user.pubkey, {
          createdAt,
          fileHints: shareRecord.fileHints ? Object.values(shareRecord.fileHints) : undefined,
        });
        const event = new module.NDKEvent(ndk);
        event.kind = template.kind;
        event.pubkey = template.pubkey;
        event.created_at = template.created_at;
        event.tags = template.tags;
        event.content = template.content;
        await event.sign();
        await event.publish(relaySet);
      } catch (error) {
        console.warn("Failed to republish folder list to share relays", error);
      }

      return shareRecord;
    },
    [ensureRelayConnections, getModule, ndk, signer, user]
  );

  const ensureFolderMetadataOnRelays = useCallback(
    async (record: FolderListRecord, relayUrls: readonly string[], blobs?: BlossomBlob[]) => {
      if (!ndk) return;
      const sanitizedRelays = collectRelayUrls(relayUrls.length ? relayUrls : DEFAULT_PUBLIC_RELAYS);
      if (!sanitizedRelays.length) return;
      await ensureRelayConnections(sanitizedRelays);
      const module = await getModule();
      const relaySet = module.NDKRelaySet.fromRelayUrls(sanitizedRelays, ndk);
      const shas = Array.from(new Set(record.shas.map(sha => sha?.toLowerCase()).filter(Boolean) as string[]));
      if (!shas.length) return;

      const blobLookup = new Map<string, BlossomBlob>();
      blobs?.forEach(blob => {
        if (blob?.sha256) {
          blobLookup.set(blob.sha256.toLowerCase(), blob);
        }
      });

      let fetchedEvents: Set<any> = new Set();
      let metadataFetchTimedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        const metadataFetch = ndk.fetchEvents(
          [
            { kinds: [1063], "#x": shas, limit: shas.length },
            { kinds: [1063], "#ox": shas, limit: shas.length },
          ],
          { closeOnEose: true, groupable: false },
          relaySet
        );
        fetchedEvents = (await Promise.race([
          metadataFetch.finally(() => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
          }),
          new Promise<Set<any>>(resolve => {
            timeoutHandle = setTimeout(() => {
              metadataFetchTimedOut = true;
              timeoutHandle = null;
              resolve(new Set());
            }, FOLDER_METADATA_FETCH_TIMEOUT_MS);
          }),
        ])) as Set<any>;
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
          `Timed out after ${FOLDER_METADATA_FETCH_TIMEOUT_MS}ms while fetching metadata events for shared items`
        );
      }

      const found = new Set<string>();
      const publishTasks: Promise<void>[] = [];

      fetchedEvents.forEach(raw => {
        if (!raw || !Array.isArray(raw.tags)) return;
        const shaTag = raw.tags.find((tag: unknown) =>
          Array.isArray(tag) && (tag[0] === "x" || tag[0] === "ox") && typeof tag[1] === "string"
        ) as string[] | undefined;
        if (!shaTag || typeof shaTag[1] !== "string") return;
        const sha = shaTag[1].toLowerCase();
        if (!shas.includes(sha)) return;
        found.add(sha);
        const event = new module.NDKEvent(ndk, raw);
        publishTasks.push(
          event.publish(relaySet).then(() => undefined).catch(error => {
            console.warn("Failed to republish metadata event", error);
          })
        );
      });

      const missing = shas.filter(sha => !found.has(sha));
      if (missing.length && signer) {
        missing.forEach(sha => {
          const blob = blobLookup.get(sha);
          if (!blob || !blob.url) return;
          const template = buildNip94EventTemplate({ blob });
          const event = new module.NDKEvent(ndk, template);
          publishTasks.push(
            (async () => {
              await event.sign();
              await event.publish(relaySet);
            })().catch(error => {
              console.warn("Failed to publish metadata for", sha, error);
            })
          );
          found.add(sha);
        });
      }

      await Promise.all(publishTasks);

      if (shas.some(sha => !found.has(sha))) {
        console.warn("Some shared items are missing metadata events", shas.filter(sha => !found.has(sha)));
      }
    },
    [getModule, ndk, signer]
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
      if (record.visibility === "public") {
        const existingHintRecord =
          folderShareDialog?.record?.path === record.path ? folderShareDialog.record : record;
        const ownerPubkey = existingHintRecord.pubkey ?? user?.pubkey ?? null;
        const relayCandidates = effectiveRelays.length ? effectiveRelays : Array.from(DEFAULT_PUBLIC_RELAYS);
        const relayHints = collectRelayUrls(relayCandidates);
        const naddrExisting = encodeFolderNaddr(
          existingHintRecord,
          ownerPubkey,
          relayHints.length ? relayHints : undefined
        );
        const originExisting =
          typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://bloomapp.me";
        if (!naddrExisting) {
          showStatusMessage("Unable to build a share link for this folder.", "error", 4500);
          return;
        }
        const shareUrlExisting = `${originExisting}/folders/${encodeURIComponent(naddrExisting)}`;
        setFolderShareDialog({ record: existingHintRecord, naddr: naddrExisting, shareUrl: shareUrlExisting });
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
      setFolderShareBusyPath(normalizedPath);
      try {
        let nextRecord = record;
        showStatusMessage("Making folder public…", "info", 2500);
        const published = await setFolderVisibility(normalizedPath, "public");
        nextRecord = published ?? record;
        showStatusMessage("Folder is now public.", "success", 2500);
        if (nextRecord.visibility !== "public") {
          showStatusMessage("Unable to share this folder right now.", "error", 4500);
          return;
        }
        const relayCandidates = effectiveRelays.length ? effectiveRelays : Array.from(DEFAULT_PUBLIC_RELAYS);
        const relayHints = collectRelayUrls(relayCandidates);
        if (!relayHints.length) {
          showStatusMessage("Configure at least one relay before sharing.", "error", 4000);
          return;
        }
        const shareRecord = await ensureFolderListOnRelays(nextRecord, relayHints, request.blobs);
        const ownerPubkey = shareRecord.pubkey ?? user?.pubkey ?? null;
        const naddr = encodeFolderNaddr(shareRecord, ownerPubkey, relayHints);
        if (!naddr) {
          showStatusMessage("Unable to build a share link for this folder.", "error", 4500);
          return;
        }
        const origin =
          typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://bloomapp.me";
        const shareUrl = `${origin}/folders/${encodeURIComponent(naddr)}`;
        setFolderShareDialog({ record: shareRecord, naddr, shareUrl });
        showStatusMessage("Share link ready.", "success", 2000);
        void (async () => {
          try {
            await ensureFolderMetadataOnRelays(shareRecord, relayHints, request.blobs);
          } catch (metadataError) {
            console.warn("Failed to publish folder metadata for share", metadataError);
            showStatusMessage(
              "Some file details are still publishing. Previews may take a bit longer to appear.",
              "warning",
              5000
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
      resolveFolderPath,
      foldersByPath,
      folderShareBusyPath,
      setFolderVisibility,
      ensureFolderListOnRelays,
      ensureFolderMetadataOnRelays,
      showStatusMessage,
      effectiveRelays,
      user?.pubkey,
    ]
  );

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
        showStatusMessage("Folder is now private. Shared links will stop working soon.", "success", 4000);
        setFolderShareDialog(current => (current && current.record.path === normalizedPath ? null : current));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update folder visibility.";
        showStatusMessage(message, "error", 5000);
      } finally {
        setFolderShareBusyPath(null);
      }
    },
    [resolveFolderPath, foldersByPath, folderShareBusyPath, setFolderVisibility, showStatusMessage]
  );

  const handleCloseFolderShareDialog = useCallback(() => {
    setFolderShareDialog(null);
  }, []);

  const handleProfileUpdated = useCallback((metadata: ProfileMetadataPayload) => {
    const nextAvatarUrl = typeof metadata.picture === "string" && metadata.picture.trim() ? metadata.picture.trim() : null;
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
    () => nip46Snapshot.sessions.some(session => session.status !== "revoked" && !session.lastError),
    [nip46Snapshot.sessions]
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
    [setDefaultServerUrl]
  );

  const handleSetDefaultViewMode = useCallback(
    (mode: "grid" | "list") => {
      setDefaultViewMode(mode);
    },
    [setDefaultViewMode]
  );

  const handleSetDefaultFilterMode = useCallback(
    (mode: FilterMode) => {
      if (preferences.defaultFilterMode === mode) return;
      setDefaultFilterMode(mode);
    },
    [preferences.defaultFilterMode, setDefaultFilterMode]
  );

  const handleSetDefaultSortOption = useCallback(
    (option: DefaultSortOption) => {
      if (preferences.defaultSortOption === option) return;
      setDefaultSortOption(option);
    },
    [preferences.defaultSortOption, setDefaultSortOption]
  );

  const handleSetSortDirection = useCallback(
    (direction: SortDirection) => {
      if (preferences.sortDirection === direction) return;
      setSortDirection(direction);
    },
    [preferences.sortDirection, setSortDirection]
  );

  const handleSetShowPreviewsInGrid = useCallback(
    (value: boolean) => {
      setShowGridPreviews(value);
    },
    [setShowGridPreviews]
  );

  const handleSetShowPreviewsInList = useCallback(
    (value: boolean) => {
      setShowListPreviews(value);
    },
    [setShowListPreviews]
  );

  const handleSetKeepSearchExpanded = useCallback(
    (value: boolean) => {
      setKeepSearchExpanded(value);
    },
    [setKeepSearchExpanded]
  );

  const handleSetTheme = useCallback(
    (nextTheme: "dark" | "light") => {
      setTheme(nextTheme);
    },
    [setTheme]
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
    [keepSearchExpanded]
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

  const schedulePendingSaveAttempt = useCallback(
    (backoffUntil?: number) => {
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
    },
    []
  );

  const queuePendingSave = useCallback(
    (payload: PendingSave) => {
      pendingSaveRef.current = payload;
      schedulePendingSaveAttempt(payload.backoffUntil);
    },
    [schedulePendingSaveAttempt]
  );

  const attemptSave = useCallback(
    async (serversToPersist: ManagedServer[], successMessage?: string) => {
      try {
        await saveServers(serversToPersist);
        showStatusMessage(successMessage ?? "Server list updated", "success", 2500);
      } catch (error: any) {
        const message = error?.message || "Failed to save servers";
        const backoffUntil = Date.now() + 5000;
        queuePendingSave({ servers: serversToPersist, successMessage, backoffUntil });
        showStatusMessage(message, "error", 3000);
      }
    },
    [queuePendingSave, saveServers, showStatusMessage]
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
    [attemptSave, queuePendingSave, saving, showStatusMessage, signer]
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
    [confirm, localServers, persistServers, selectedServer, setSelectedServer]
  );

  const handleShareBlob = useCallback(
    (payload: SharePayload, options?: { mode?: ShareMode }) => {
      openShareForPayload(payload, options?.mode);
      const targetTab: TabId = options?.mode === "private-link" ? "share-private" : "share";
      selectTab(targetTab);
    },
    [openShareForPayload, selectTab]
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
        showStatusMessage(message, result.failures && result.failures > 0 ? "info" : "success", 5000);
        selectTab("browse");
      } else {
        const dmLabel = isPrivateDm ? "private DM" : "DM";
        const message = result.message || (label ? `Failed to send ${dmLabel} to ${label}.` : `Failed to send ${dmLabel}.`);
        showStatusMessage(message, "error", 6000);
      }
    },
    [completeShareInternal, selectTab, showStatusMessage]
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

  const toneClassByKey: Record<"muted" | "syncing" | "success" | "warning" | "info" | "error", string> = {
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
  }, [syncEnabledServerUrls.length, syncStatus, syncSnapshot.allLinkedServersSynced, syncSnapshot.syncAutoReady]);

  const derivedStatusMessage = statusMessage ?? (syncLoading ? "Syncing settings" : null);
  const centerMessage = derivedStatusMessage ?? syncSummary.text;
  const centerTone = derivedStatusMessage
    ? derivedStatusMessage === statusMessage
      ? statusMessageTone === "error"
        ? "error"
        : statusMessageTone === "success"
        ? "success"
        : "info"
      : "syncing"
    : syncSummary.text
    ? syncSummary.tone
    : "muted";
  const centerClass = toneClassByKey[centerTone];

  const statusSelectValue = selectedServer ?? ALL_SERVERS_VALUE;

  const statusCount = statusMetrics.count;
  const statusSize = statusMetrics.size;
  const showStatusTotals = tab === "browse" || tab === "upload" || tab === "share" || tab === "transfer";
  const hideServerSelectorTabs: TabId[] = ["profile", "private-links", "relays", "servers", "settings"];
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

  const handleSelectPrivateLinks = useCallback(() => {
    selectTab("private-links");
    setIsUserMenuOpen(false);
  }, [selectTab]);

  const handleSelectSettings = useCallback(() => {
    selectTab("settings");
    setIsUserMenuOpen(false);
  }, [selectTab]);

  const userMenuLinks = useMemo(() =>
    [
      { label: "Edit Profile", icon: EditIcon, handler: handleSelectProfile },
      { label: "Private Links", icon: LinkIcon, handler: handleSelectPrivateLinks },
      { label: "Settings", icon: SettingsIcon, handler: handleSelectSettings },
    ].sort((a, b) => a.label.localeCompare(b.label)),
  [handleSelectPrivateLinks, handleSelectProfile, handleSelectSettings]
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
        isLightTheme ? "bg-white surface-sheet shadow-panel noise-layer" : "bg-slate-900 surface-sheet shadow-panel noise-layer"
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
    <div className="surface-window flex min-h-screen max-h-screen flex-col overflow-hidden text-slate-100">
    <div className="mx-auto flex w-full max-w-7xl flex-1 min-h-0 flex-col gap-2 px-4 py-6 sm:px-6 sm:py-8">
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
                    <span className="flex h-full w-full items-center justify-center font-semibold">{userInitials}</span>
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

        {folderShareDialog ? (
          <FolderShareDialog
            record={folderShareDialog.record}
            shareUrl={folderShareDialog.shareUrl}
            naddr={folderShareDialog.naddr}
            onClose={handleCloseFolderShareDialog}
            onStatus={showStatusMessage}
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

type MainNavigationProps = {
  showAuthPrompt: boolean;
  keepSearchExpanded: boolean;
  browseNavigationState: BrowseNavigationState | null;
  isSearchOpen: boolean;
  searchQuery: string;
  searchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onSearchChange: React.ChangeEventHandler<HTMLInputElement>;
  onSearchKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
  onSearchClear: () => void;
  onToggleSearch: () => void;
  browseHeaderControls: React.ReactNode | null;
  selectedCount: number;
  tab: TabId;
  onSelectTab: (tab: TabId) => void;
  navTabs: typeof NAV_TABS;
  onBreadcrumbHome: () => void;
  theme: "dark" | "light";
};

type LoggedOutPromptProps = {
  onConnect: () => void | Promise<void>;
  onConnectRemoteSigner: () => void;
  hasNip07Extension: boolean;
};

const LoggedOutPrompt: React.FC<LoggedOutPromptProps> = ({
  onConnect,
  onConnectRemoteSigner,
  hasNip07Extension,
}) => {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-xl">
        <img
          src="/bloom.webp"
          alt="Bloom logo"
          width={128}
          height={128}
          className="w-24 md:w-32 rounded-xl"
        />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-100">Welcome to Bloom</h2>
          <p className="text-sm text-slate-300 text-left">
            Browse, upload, and share music, video, and documents on any{" "}
            <a
              href="https://github.com/nostr-protocol/nips/blob/master/B7.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 underline decoration-emerald-500/60 underline-offset-2 transition hover:text-emerald-200"
            >
              Blossom
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/nostr-protocol/nips/blob/master/96.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 underline decoration-emerald-500/60 underline-offset-2 transition hover:text-emerald-200"
            >
              NIP-96
            </a>
            -compatible servers. All your media stays decentralized, secure, and instantly accessible.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          {hasNip07Extension && (
            <button
              onClick={() => {
                void onConnect();
              }}
              className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
            >
              Connect With Extension
            </button>
          )}
          <button
            onClick={onConnectRemoteSigner}
            className="px-3 py-2 rounded-xl border border-emerald-500/60 bg-transparent text-emerald-300 hover:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            Connect Remote Signer
          </button>
          <div className="flex items-center justify-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <span className="h-px w-6 bg-slate-800" aria-hidden="true" />
            <span>or</span>
            <span className="h-px w-6 bg-slate-800" aria-hidden="true" />
          </div>
          <button
            onClick={() => {
              window.open("https://start.nostr.net/", "_blank", "noopener");
            }}
            className="px-3 py-2 rounded-xl border border-slate-700 bg-slate-900/80 text-slate-200 transition hover:border-emerald-400 hover:text-emerald-200 hover:bg-slate-900/60 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            Learn more about Nostr
          </button>
        </div>
      </div>
    </div>
  );
};

const MainNavigation = memo(function MainNavigation({
  showAuthPrompt,
  keepSearchExpanded,
  browseNavigationState,
  isSearchOpen,
  searchQuery,
  searchInputRef,
  onSearchChange,
  onSearchKeyDown,
  onSearchClear,
  onToggleSearch,
  browseHeaderControls,
  selectedCount,
  tab,
  onSelectTab,
  navTabs,
  onBreadcrumbHome,
  theme,
}: MainNavigationProps) {
  const assignSearchInputRef = (node: HTMLInputElement | null) => {
    searchInputRef.current = node;
  };
  const isCompactScreen = useIsCompactScreen();
  const hasBreadcrumbs = Boolean(browseNavigationState?.segments.length);
  const showBreadcrumbs = !isCompactScreen && hasBreadcrumbs;
  const isLightTheme = theme === "light";
  const navContainerClass = isLightTheme
    ? "flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-toolbar"
    : "flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800/60 bg-slate-950/30 px-3 py-2 shadow-toolbar backdrop-blur-sm";
  const mergeClasses = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");
  const segmentBaseClass =
    "flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-sm transition focus-visible:outline-none focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-55";
  const segmentDefaultClass = isLightTheme
    ? "bg-slate-200 text-slate-600 hover:bg-slate-100"
    : "bg-slate-900/40 text-slate-300 hover:bg-slate-800/60";
  const segmentActiveClass = isLightTheme
    ? "bg-emerald-200/60 text-emerald-700 shadow-toolbar"
    : "bg-emerald-500/15 text-emerald-200 shadow-toolbar";
  const segmentDisabledClass = isLightTheme ? "bg-slate-100 text-slate-400" : "bg-transparent text-slate-500";
  const searchSegmentState = showAuthPrompt
    ? segmentDisabledClass
    : isSearchOpen
      ? segmentActiveClass
      : segmentDefaultClass;
  const browseControlSegments = browseHeaderControls
    ? React.Children.toArray(browseHeaderControls).filter(Boolean)
    : [];
  const navButtonSegments = navTabs.map(item => {
    const isUploadTab = item.id === "upload";
    const isTransferView = tab === "transfer";
    const showTransfer = isUploadTab && selectedCount > 0;
    const isActive = tab === item.id || (isUploadTab && (isTransferView || showTransfer));
    const IconComponent = showTransfer ? TransferIcon : item.icon;
    const label = showTransfer ? "Transfer" : item.label;
    const hideLabelOnMobile = isUploadTab;
    const nextTab: TabId = showTransfer ? "transfer" : item.id;
    return (
      <button
        key={item.id}
        onClick={() => onSelectTab(nextTab)}
        disabled={showAuthPrompt}
        aria-label={label}
        title={label}
        className={mergeClasses(segmentBaseClass, "justify-center", isActive ? segmentActiveClass : segmentDefaultClass)}
        data-segment-type="label"
      >
        <IconComponent size={16} />
        <span className={hideLabelOnMobile ? "hidden whitespace-nowrap text-sm font-medium sm:inline" : "whitespace-nowrap text-sm font-medium"}>
          {label}
        </span>
      </button>
    );
  });

  const homeButtonClass = isLightTheme
    ? "flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-emerald-400 hover:text-emerald-600 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-60"
    : "flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-60";
  const backButtonClass = isLightTheme
    ? "flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-emerald-400 hover:text-emerald-600 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-40"
    : "flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-40";
  const searchInputClass = isLightTheme
    ? "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 placeholder:text-slate-400 shadow-inner focus:border-emerald-500 focus:outline-none focus-visible:focus-emerald-ring"
    : "h-10 w-full rounded-xl border border-slate-800/70 bg-slate-950/40 px-3 text-sm text-slate-100 placeholder:text-slate-500 shadow-inner focus:border-emerald-500 focus:outline-none focus-visible:focus-emerald-ring";
  const searchClearButtonClass = isLightTheme
    ? "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-slate-200 text-emerald-600 transition hover:bg-emerald-200/80 hover:text-emerald-700 focus:outline-none focus-visible:focus-emerald-ring"
    : "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-slate-900/60 text-emerald-300 transition hover:bg-emerald-500/25 hover:text-emerald-200 focus:outline-none focus-visible:focus-emerald-ring";
  const breadcrumbButtonClass = isLightTheme
    ? "max-w-[12rem] truncate rounded-xl border border-transparent bg-white px-3 py-1.5 text-left text-slate-600 transition hover:bg-slate-100 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-60"
    : "max-w-[12rem] truncate rounded-xl border border-transparent bg-slate-900/40 px-3 py-1.5 text-left transition hover:bg-slate-800/60 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-60";
  const breadcrumbChevronClass = isLightTheme ? "text-slate-400 flex-shrink-0" : "text-slate-600 flex-shrink-0";
  const breadcrumbWrapperClass = isLightTheme
    ? "flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-slate-500"
    : "flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-slate-200";
  const controlsContainerClass = isLightTheme
    ? "flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-1.5 py-1 shadow-toolbar"
    : "flex items-center gap-2 rounded-2xl border border-slate-800/70 bg-slate-900/50 px-1.5 py-1 shadow-toolbar";

  return (
    <nav className={navContainerClass}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBreadcrumbHome}
          disabled={showAuthPrompt}
          aria-label="Home"
          className={homeButtonClass}
        >
          <HomeIcon size={16} />
          <span className="hidden sm:inline">Home</span>
        </button>
        {keepSearchExpanded && (
          <button
            type="button"
            onClick={() => browseNavigationState?.onNavigateUp?.()}
            disabled={showAuthPrompt || !browseNavigationState?.canNavigateUp}
            className={backButtonClass}
            aria-label="Go back"
          >
            <ChevronLeftIcon size={16} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {isSearchOpen ? (
          <div className="relative w-full">
            <input
              ref={assignSearchInputRef}
              type="search"
              value={searchQuery}
              onChange={onSearchChange}
              onKeyDown={onSearchKeyDown}
              placeholder="Search files"
              className={searchInputClass}
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={onSearchClear}
                className={searchClearButtonClass}
                aria-label="Clear search"
              >
                <CloseIcon size={14} />
              </button>
            ) : null}
          </div>
        ) : showBreadcrumbs && browseNavigationState ? (
          <div
            className={breadcrumbWrapperClass}
            title={`/${browseNavigationState.segments.map(segment => segment.label).join("/")}`}
          >
            {browseNavigationState.segments.map((segment, index) => (
              <React.Fragment key={segment.id}>
                {index > 0 && <ChevronRightIcon size={14} className={breadcrumbChevronClass} />}
                <button
                  type="button"
                  onClick={segment.onNavigate}
                  disabled={showAuthPrompt}
                  className={breadcrumbButtonClass}
                >
                  {segment.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : !isCompactScreen ? (
          <span className="text-sm text-slate-500">/</span>
        ) : null}
      </div>
      <div className="flex items-center" role="group" aria-label="Main navigation controls">
        <div className={controlsContainerClass}>
          <button
            type="button"
            onClick={onToggleSearch}
            disabled={showAuthPrompt}
            aria-label="Search files"
            aria-pressed={isSearchOpen}
            className={mergeClasses(segmentBaseClass, "w-10 justify-center px-0", searchSegmentState)}
            data-segment-type="icon"
          >
            <SearchIcon size={16} />
          </button>
          {browseControlSegments.map((segment) => {
            if (!React.isValidElement(segment)) return null;
            const segmentType = segment.props["data-segment-type"] || (segment.type === "button" ? "icon" : undefined);
            const baseClass = mergeClasses(
              segmentBaseClass,
              segmentType === "label" ? "" : "w-10 justify-center px-0"
            );
            return React.cloneElement(segment, {
              className: mergeClasses(baseClass, segmentDefaultClass, segment.props.className || ""),
              "data-segment-type": segmentType,
            });
          })}
          {navButtonSegments}
        </div>
      </div>
    </nav>
  );
});

MainNavigation.displayName = "MainNavigation";
