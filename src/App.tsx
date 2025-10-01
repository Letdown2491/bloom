import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useNdk, useCurrentPubkey } from "./context/NdkContext";
import { useNip46 } from "./context/Nip46Context";
import { useServers, ManagedServer, sortServersByName } from "./hooks/useServers";
import { usePreferredRelays } from "./hooks/usePreferredRelays";
import { useAliasSync } from "./hooks/useAliasSync";
import { useSelection } from "./features/selection/SelectionContext";
import { useShareWorkflow } from "./features/share/useShareWorkflow";
import { useAudio } from "./context/AudioContext";
import { useUserPreferences, type DefaultSortOption } from "./context/UserPreferencesContext";

import type { ShareCompletion, SharePayload } from "./components/ShareComposer";
import type { BlossomBlob } from "./lib/blossomClient";
import type { StatusMessageTone } from "./types/status";
import type { TabId } from "./types/tabs";
import type { SyncStateSnapshot } from "./features/workspace/TransferTabContainer";
import type { BrowseNavigationState } from "./features/workspace/BrowseTabContainer";
import type { FilterMode } from "./types/filter";
import type { ProfileMetadataPayload } from "./features/profile/ProfilePanel";
import { deriveServerNameFromUrl } from "./utils/serverName";

import {
  ChevronRightIcon,
  ChevronLeftIcon,
  CloseIcon,
  HomeIcon,
  SearchIcon,
  TransferIcon,
  UploadIcon,
  ServersIcon,
  RelayIcon,
  SettingsIcon,
  EditIcon,
  LinkIcon,
  LogoutIcon,
} from "./components/icons";
import { FolderRenameDialog } from "./components/FolderRenameDialog";
import { StatusFooter } from "./components/StatusFooter";
import { WorkspaceSection } from "./components/WorkspaceSection";

const ConnectSignerDialogLazy = React.lazy(() =>
  import("./features/nip46/ConnectSignerDialog").then(module => ({ default: module.ConnectSignerDialog }))
);

const RenameDialogLazy = React.lazy(() =>
  import("./features/rename/RenameDialog").then(module => ({ default: module.RenameDialog }))
);

const AudioPlayerCardLazy = React.lazy(() =>
  import("./features/browse/BrowseTab").then(module => ({ default: module.AudioPlayerCard }))
);

const NAV_TABS = [{ id: "upload" as const, label: "Upload", icon: UploadIcon }];

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

  const requiresAuth = server.type === "satellite" ? true : Boolean(server.requiresAuth);
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

export default function App() {
  const queryClient = useQueryClient();
  const { connect, disconnect, user, signer, ndk } = useNdk();
  const { snapshot: nip46Snapshot, service: nip46Service, ready: nip46Ready } = useNip46();
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
    setSyncEnabled,
    syncState,
  } = useUserPreferences();
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
  const [activeBrowseFilter, setActiveBrowseFilter] = useState<FilterMode>(preferences.defaultFilterMode);
  const [homeNavigationKey, setHomeNavigationKey] = useState(0);
  const [browseNavigationState, setBrowseNavigationState] = useState<BrowseNavigationState | null>(null);
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

  const { enabled: syncEnabled, loading: syncLoading, error: syncError, pending: syncPending, lastSyncedAt: syncLastSyncedAt } = syncState;

  const handleFilterModeChange = useCallback((mode: FilterMode) => {
    setActiveBrowseFilter(prev => (prev === mode ? prev : mode));
  }, []);

  const [statusMetrics, setStatusMetrics] = useState<StatusMetrics>({ count: 0, size: 0 });
  const [syncSnapshot, setSyncSnapshot] = useState<SyncStateSnapshot>({
    syncStatus: { state: "idle", progress: 0 },
    syncAutoReady: false,
    allLinkedServersSynced: true,
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
    setActiveBrowseFilter(preferences.defaultFilterMode);
  }, [preferences.defaultFilterMode]);

  useEffect(() => {
    if (tab === "transfer" && selectedBlobs.size === 0) {
      setTab("upload");
    }
  }, [selectedBlobs.size, tab]);

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
    setTab("share");
    params.delete("share");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [openShareByKey]);

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
    if (!nip46Ready || !nip46Service) {
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
    setTab("browse");
    browseNavigationState?.onNavigateHome();
  }, [browseNavigationState]);

  const handleSyncSelectedServers = useCallback(() => {
    if (syncEnabledServerUrls.length < 2) {
      showStatusMessage("Enable sync on at least two servers to start.", "info", 3000);
      return;
    }
    pendingSyncRef.current = true;
    setTab("transfer");
    if (syncStarterRef.current) {
      const runner = syncStarterRef.current;
      pendingSyncRef.current = false;
      runner();
    }
  }, [showStatusMessage, syncEnabledServerUrls.length]);

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
      setActiveBrowseFilter(mode);
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

  const handleToggleSearch = useCallback(() => {
    if (keepSearchExpanded) {
      setTab(prev => (prev === "browse" ? prev : "browse"));
      setIsSearchOpen(true);
      return;
    }
    setIsSearchOpen(prev => {
      const next = !prev;
      if (next) {
        setTab("browse");
      } else {
        setSearchQuery("");
      }
      return next;
    });
  }, [keepSearchExpanded, setTab]);

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
      setTab(prev => (prev === "browse" ? prev : "browse"));
    } else if (!keepSearchExpanded) {
      setIsSearchOpen(prev => (prev ? false : prev));
      setSearchQuery("");
    }
  }, [keepSearchExpanded, setTab, showAuthPrompt]);

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

  const handleRemoveServer = (url: string) => {
    const target = localServers.find(server => server.url === url);
    if (!target) return;

    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Remove ${target.name || target.url}?`);
      if (!confirmed) return;
    }

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
  };

  const handleShareBlob = useCallback(
    (payload: SharePayload) => {
      openShareForPayload(payload);
      setTab("share");
    },
    [openShareForPayload]
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
        setTab("browse");
      } else {
        const dmLabel = isPrivateDm ? "private DM" : "DM";
        const message = result.message || (label ? `Failed to send ${dmLabel} to ${label}.` : `Failed to send ${dmLabel}.`);
        showStatusMessage(message, "error", 6000);
      }
    },
    [completeShareInternal, showStatusMessage]
  );

  const handleUploadCompleted = (success: boolean) => {
    if (!success) return;
    servers.forEach(server => {
      queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url] });
    });
    setTab("browse");
    showStatusMessage("All files uploaded successfully", "success", 5000);
  };

  const handleStatusServerChange: React.ChangeEventHandler<HTMLSelectElement> = event => {
    const value = event.target.value;
    if (value === ALL_SERVERS_VALUE) {
      setSelectedServer(null);
    } else {
      setSelectedServer(value);
    }
    setTab("browse");
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

  const handleSelectServers = useCallback(() => {
    setTab("servers");
    setIsUserMenuOpen(false);
  }, []);

  const handleSelectProfile = useCallback(() => {
    setTab("profile");
    setIsUserMenuOpen(false);
  }, []);

  const handleSelectRelays = useCallback(() => {
    setTab("relays");
    setIsUserMenuOpen(false);
  }, []);

  const handleSelectPrivateLinks = useCallback(() => {
    setTab("private-links");
    setIsUserMenuOpen(false);
  }, []);

  const handleSelectSettings = useCallback(() => {
    setTab("settings");
    setIsUserMenuOpen(false);
  }, []);

  const userMenuLinks = useMemo(() =>
    [
      { label: "Edit Profile", icon: EditIcon, handler: handleSelectProfile },
      { label: "Private Links", icon: LinkIcon, handler: handleSelectPrivateLinks },
      { label: "Relays", icon: RelayIcon, handler: handleSelectRelays },
      { label: "Servers", icon: ServersIcon, handler: handleSelectServers },
      { label: "Settings", icon: SettingsIcon, handler: handleSelectSettings },
    ].sort((a, b) => a.label.localeCompare(b.label)),
  [handleSelectPrivateLinks, handleSelectProfile, handleSelectRelays, handleSelectServers, handleSelectSettings]
  );

  const handleDisconnectClick = useCallback(() => {
    setIsUserMenuOpen(false);
    disconnect();
  }, [disconnect]);

  const isInlineMusicPlayerActive = tab === "browse" && activeBrowseFilter === "music";
  const shouldShowFloatingPlayer = Boolean(audio.current) && !isInlineMusicPlayerActive;

  return (
    <div className="flex min-h-screen max-h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full flex-1 min-h-0 flex-col gap-6 overflow-hidden px-6 py-8 max-w-7xl box-border">
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 min-h-12">
            <img
              src="/bloom.webp"
              alt="Bloom logo"
              className="h-10 w-10 rounded-xl object-cover"
            />
            <div>
              <h1 className="text-2xl font-semibold">Bloom</h1>
              <p className="hidden md:block text-xs text-slate-400">
                Manage your content, upload media, and mirror files across servers.
              </p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
            {user && (
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={toggleUserMenu}
                  className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-800 bg-slate-900/70 p-0 text-xs text-slate-200 transition hover:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  aria-haspopup="menu"
                  aria-expanded={isUserMenuOpen}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt="User avatar"
                      className="block h-full w-full object-cover"
                      onError={() => setAvatarUrl(null)}
                    />
                  ) : (
                    <span className="font-semibold">{userInitials}</span>
                  )}
                </button>
                {isUserMenuOpen && (
                  <div className="absolute right-0 z-50 mt-2 min-w-[10rem] rounded-md bg-slate-900 px-2 py-2 text-sm shadow-lg">
                    <ul className="flex flex-col gap-1 text-slate-200">
                      {userMenuLinks.map(item => (
                        <li key={item.label}>
                          <a
                            href="#"
                            onClick={event => {
                              event.preventDefault();
                              item.handler();
                            }}
                            className="flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800/70 hover:text-emerald-300"
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
                          className="flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800/70 hover:text-emerald-300"
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
        </header>

        <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70">
          <div ref={mainWidgetRef} className="flex flex-1 min-h-0 flex-col">
            {showAuthPrompt ? (
              <LoggedOutPrompt
                onConnect={connect}
                onConnectRemoteSigner={handleConnectSignerClick}
              />
            ) : (
              <>
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
                  onSelectTab={setTab}
                  navTabs={NAV_TABS}
                  onBreadcrumbHome={handleBreadcrumbHome}
                />
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
                  onStatusMetricsChange={handleStatusMetricsChange}
                  onSyncStateChange={handleSyncStateChange}
                  onProvideSyncStarter={handleProvideSyncStarter}
                  onRequestRename={handleRequestRename}
                  onRequestFolderRename={handleRequestFolderRename}
                  onRequestShare={handleShareBlob}
                  onSetTab={setTab}
                  onUploadCompleted={handleUploadCompleted}
                  showStatusMessage={showStatusMessage}
                  onProvideBrowseControls={setBrowseHeaderControls}
                  onProvideBrowseNavigation={setBrowseNavigationState}
                  onFilterModeChange={handleFilterModeChange}
                  searchQuery={searchQuery}
                  shareState={shareState}
                  onClearShareState={clearShareState}
                  onShareComplete={handleShareComplete}
                  defaultServerUrl={preferences.defaultServerUrl}
                  keepSearchExpanded={keepSearchExpanded}
                  syncEnabled={syncEnabled}
                  syncLoading={syncLoading}
                  syncError={syncError}
                  syncPending={syncPending}
                  syncLastSyncedAt={syncLastSyncedAt}
                  onToggleSyncEnabled={setSyncEnabled}
                  onSetDefaultViewMode={handleSetDefaultViewMode}
                  onSetDefaultFilterMode={handleSetDefaultFilterMode}
                  onSetDefaultSortOption={handleSetDefaultSortOption}
                  onSetDefaultServer={handleSetDefaultServer}
                  onSetShowGridPreviews={handleSetShowPreviewsInGrid}
                  onSetShowListPreviews={handleSetShowPreviewsInList}
                  onSetKeepSearchExpanded={handleSetKeepSearchExpanded}
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
              </>
            )}
          </div>

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

          {!showAuthPrompt && folderRenamePath && (
            <FolderRenameDialog
              path={folderRenamePath}
              onClose={handleFolderRenameClose}
              onStatus={showStatusMessage}
            />
          )}

          <Suspense fallback={null}>
            <ConnectSignerDialogLazy
              open={shouldShowConnectSignerDialog}
              onClose={() => setConnectSignerOpen(false)}
            />
          </Suspense>
        </div>

        {shouldShowFloatingPlayer && (
          <Suspense fallback={null}>
            <AudioPlayerCardLazy audio={audio} />
          </Suspense>
        )}
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
};

type LoggedOutPromptProps = {
  onConnect: () => void | Promise<void>;
  onConnectRemoteSigner: () => void;
};

const LoggedOutPrompt: React.FC<LoggedOutPromptProps> = ({ onConnect, onConnectRemoteSigner }) => {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-xl">
        <img src="/bloom.webp" alt="Bloom logo" className="w-24 md:w-32 rounded-xl" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-slate-100">Welcome to Bloom</h2>
          <p className="text-sm text-slate-300">
            Connect your Nostr account to browse your files, manage uploads, share your library, and more.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <button
            onClick={() => {
              void onConnect();
            }}
            className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            Connect With Browser Extension
          </button>
          <button
            onClick={onConnectRemoteSigner}
            className="px-3 py-2 rounded-xl border border-emerald-500/60 bg-transparent text-emerald-300 hover:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            Connect With Remote Signer
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
}: MainNavigationProps) {
  const assignSearchInputRef = (node: HTMLInputElement | null) => {
    searchInputRef.current = node;
  };

  return (
    <nav className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBreadcrumbHome}
          disabled={showAuthPrompt}
          className="px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
        >
          <HomeIcon size={16} />
          <span>Home</span>
        </button>
        {keepSearchExpanded && (
          <button
            type="button"
            onClick={() => browseNavigationState?.onNavigateUp?.()}
            disabled={showAuthPrompt || !browseNavigationState?.canNavigateUp}
            className="px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-40 border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
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
              className="w-full rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={onSearchClear}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-slate-800/70 text-emerald-300 transition hover:bg-emerald-500/20 hover:text-emerald-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                aria-label="Clear search"
              >
                <CloseIcon size={14} />
              </button>
            ) : null}
          </div>
        ) : browseNavigationState && browseNavigationState.segments.length > 0 ? (
          <div
            className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-slate-200"
            title={`/${browseNavigationState.segments.map(segment => segment.label).join("/")}`}
          >
            {browseNavigationState.segments.map((segment, index) => (
              <React.Fragment key={segment.id}>
                {index > 0 && <ChevronRightIcon size={14} className="text-slate-600 flex-shrink-0" />}
                <button
                  type="button"
                  onClick={segment.onNavigate}
                  disabled={showAuthPrompt}
                  className="max-w-[10rem] truncate rounded-lg border border-slate-800 bg-slate-900/70 px-2 py-1 text-left transition hover:border-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {segment.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : (
          <span className="text-sm text-slate-500">/</span>
        )}
      </div>
      <div className="flex items-center gap-3 min-h-12">
        <button
          type="button"
          onClick={onToggleSearch}
          disabled={showAuthPrompt || keepSearchExpanded}
          aria-label="Search files"
          aria-pressed={isSearchOpen}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 transition hover:border-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <SearchIcon size={16} />
        </button>
        {browseHeaderControls ? (
          <div className="flex items-center gap-3 min-h-12">{browseHeaderControls}</div>
        ) : tab === "browse" ? (
          <div className="flex items-center gap-3 min-h-12" aria-hidden="true">
            <span className="h-10 w-11 rounded-xl border border-transparent bg-transparent" />
            <span className="h-10 w-11 rounded-xl border border-transparent bg-transparent" />
            <span className="h-10 w-11 rounded-xl border border-transparent bg-transparent" />
          </div>
        ) : null}
        <div className="flex gap-3 ml-3">
          {navTabs.map(item => {
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
                className={`px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  isActive
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                }`}
              >
                <IconComponent size={16} />
                <span className={hideLabelOnMobile ? "hidden sm:inline" : undefined}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
});

MainNavigation.displayName = "MainNavigation";
