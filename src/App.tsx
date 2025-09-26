import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useNdk, useCurrentPubkey } from "./context/NdkContext";
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

import { prettyBytes } from "./utils/format";
import { deriveServerNameFromUrl } from "./utils/serverName";

import { ChevronRightIcon, CloseIcon, HomeIcon, SearchIcon, TransferIcon, UploadIcon } from "./components/icons";
import { FolderRenameDialog } from "./components/FolderRenameDialog";

const WorkspaceLazy = React.lazy(() =>
  import("./features/workspace/Workspace").then(module => ({ default: module.Workspace }))
);

const ServerListLazy = React.lazy(() =>
  import("./components/ServerList").then(module => ({ default: module.ServerList }))
);

const RelayListLazy = React.lazy(() =>
  import("./components/RelayList").then(module => ({ default: module.RelayList }))
);

const ShareComposerLazy = React.lazy(() =>
  import("./features/share/ShareComposerPanel").then(module => ({ default: module.ShareComposerPanel }))
);

const ConnectSignerDialogLazy = React.lazy(() =>
  import("./features/nip46/ConnectSignerDialog").then(module => ({ default: module.ConnectSignerDialog }))
);

const RenameDialogLazy = React.lazy(() =>
  import("./features/rename/RenameDialog").then(module => ({ default: module.RenameDialog }))
);

const AudioPlayerCardLazy = React.lazy(() =>
  import("./features/browse/BrowseTab").then(module => ({ default: module.AudioPlayerCard }))
);

const SettingsPanelLazy = React.lazy(() =>
  import("./features/settings/SettingsPanel").then(module => ({ default: module.SettingsPanel }))
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
    sync: Boolean(server.sync),
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

export default function App() {
  const queryClient = useQueryClient();
  const { connect, disconnect, user, signer, ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const { servers, saveServers, saving } = useServers();
  const {
    preferences,
    setDefaultServerUrl,
    setDefaultViewMode,
    setDefaultFilterMode,
    setDefaultSortOption,
    setShowGridPreviews,
    setShowListPreviews,
  } = useUserPreferences();
  const { effectiveRelays } = usePreferredRelays();
  useAliasSync(effectiveRelays, Boolean(pubkey));

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
  const [isSearchOpen, setIsSearchOpen] = useState(false);
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

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [connectSignerOpen, setConnectSignerOpen] = useState(false);
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
    if (!preferences.defaultServerUrl) return;
    if (!servers.some(server => server.url === preferences.defaultServerUrl)) {
      setDefaultServerUrl(null);
    }
  }, [servers, preferences.defaultServerUrl, setDefaultServerUrl]);

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

  const showAuthPrompt = !user;

  useEffect(() => {
    const element = mainWidgetRef.current;
    if (!element) return;
    if (showAuthPrompt) {
      element.setAttribute("inert", "");
      return () => {
        element.removeAttribute("inert");
      };
    }
    element.removeAttribute("inert");
    return () => {
      element.removeAttribute("inert");
    };
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

  const handleToggleSearch = useCallback(() => {
    setIsSearchOpen(prev => {
      const next = !prev;
      if (next) {
        setTab("browse");
      } else {
        setSearchQuery("");
      }
      return next;
    });
  }, [setTab]);

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  }, []);

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsSearchOpen(false);
      setSearchQuery("");
    }
  }, []);

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
    if (tab !== "browse" && isSearchOpen) {
      setIsSearchOpen(false);
      setSearchQuery("");
    }
  }, [isSearchOpen, tab]);

  const handleAddServer = (server: ManagedServer) => {
    const normalized = normalizeManagedServer(server);
    const trimmedUrl = normalized.url;
    if (!trimmedUrl) return;

    setLocalServers(prev => {
      if (prev.find(existing => existing.url === trimmedUrl)) {
        return prev;
      }
      const next = [...prev, normalized];
      return sortServersByName(next);
    });
    setSelectedServer(trimmedUrl);
  };

  const handleUpdateServer = (originalUrl: string, updated: ManagedServer) => {
    const normalized = normalizeManagedServer(updated);
    const normalizedUrl = normalized.url;
    if (!normalizedUrl) return;

    setLocalServers(prev => {
      if (prev.some(server => server.url !== originalUrl && server.url === normalizedUrl)) {
        return prev;
      }
      const updatedList = prev.map(server => (server.url === originalUrl ? normalized : server));
      return sortServersByName(updatedList);
    });

    setSelectedServer(prev => {
      if (prev === originalUrl) {
        return normalizedUrl;
      }
      return prev;
    });
  };

  const handleRemoveServer = (url: string) => {
    setLocalServers(prev => prev.filter(server => server.url !== url));
    if (selectedServer === url) {
      setSelectedServer(null);
    }
  };

  const handleToggleRequiresAuth = (url: string, value: boolean) => {
    setLocalServers(prev => prev.map(server => (server.url === url ? { ...server, requiresAuth: value } : server)));
  };

  const handleToggleSync = (url: string, value: boolean) => {
    setLocalServers(prev => prev.map(server => (server.url === url ? { ...server, sync: value } : server)));
  };

  const handleSaveServers = async () => {
    if (!signer) {
      showStatusMessage("Connect your signer to save servers", "error", 2500);
      return;
    }
    if (saving) {
      showStatusMessage("Server list update already in progress.", "info", 2000);
      return;
    }
    if (serverValidationError) {
      showStatusMessage(serverValidationError, "error", 3000);
      return;
    }
    const normalized = sortServersByName(localServers.map(normalizeManagedServer));
    setLocalServers(normalized);
    try {
      await saveServers(normalized);
      showStatusMessage("Server list updated", "success", 2500);
    } catch (error: any) {
      showStatusMessage(error?.message || "Failed to save servers", "error", 3000);
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
      if (result.mode !== "dm") {
        if (!result.success && result.message) {
          showStatusMessage(result.message, "error", 5000);
        }
        return;
      }
      if (result.success) {
        let message = label ? `DM sent to ${label}.` : "DM sent.";
        if (result.failures && result.failures > 0) {
          message += ` ${result.failures} relay${result.failures === 1 ? "" : "s"} reported errors.`;
        }
        showStatusMessage(message, result.failures && result.failures > 0 ? "info" : "success", 5000);
        setTab("browse");
      } else {
        const message = result.message || (label ? `Failed to send DM to ${label}.` : "Failed to send DM.");
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

  const centerMessage = statusMessage ?? syncSummary.text;
  const centerClass = statusMessage
    ? statusMessageTone === "error"
      ? "text-red-400"
      : statusMessageTone === "success"
      ? "text-emerald-300"
      : "text-slate-400"
    : centerMessage
    ? toneClassByKey[syncSummary.tone]
    : "text-slate-500";

  const statusSelectValue = selectedServer ?? ALL_SERVERS_VALUE;

  const statusCount = statusMetrics.count;
  const statusSize = statusMetrics.size;

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

  const handleSelectRelays = useCallback(() => {
    setTab("relays");
    setIsUserMenuOpen(false);
  }, []);

  const handleSelectSettings = useCallback(() => {
    setTab("settings");
    setIsUserMenuOpen(false);
  }, []);

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
          <div className="flex items-center gap-3">
            <img
              src="/bloom.png"
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
                  <div className="absolute right-0 z-10 mt-2 min-w-[8rem] rounded-md bg-slate-900 px-2 py-1 text-sm shadow-lg">
                    <ul className="flex flex-col gap-1 text-slate-200">
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleSelectServers();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Servers
                        </a>
                      </li>
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleSelectRelays();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Relays
                        </a>
                      </li>
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleSelectSettings();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Settings
                        </a>
                      </li>
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleDisconnectClick();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Disconnect
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
          <div
            ref={mainWidgetRef}
            className={`flex flex-1 min-h-0 flex-col ${showAuthPrompt ? "pointer-events-none opacity-40" : ""}`}
            aria-hidden={showAuthPrompt || undefined}
          >
            <nav className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleBreadcrumbHome}
                  disabled={showAuthPrompt}
                  className="px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                >
                  <HomeIcon size={16} />
                  <span>Home</span>
                </button>
              </div>
              <div className="min-w-0 flex-1">
                {isSearchOpen ? (
                  <div className="relative w-full">
                    <input
                      ref={searchInputRef}
                      type="search"
                      value={searchQuery}
                      onChange={handleSearchChange}
                      onKeyDown={handleSearchKeyDown}
                      placeholder="Search files"
                      className="w-full rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                    {searchQuery ? (
                      <button
                        type="button"
                        onClick={handleClearSearch}
                        className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:text-slate-200"
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
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleToggleSearch}
                  disabled={showAuthPrompt}
                  aria-label="Search files"
                  aria-pressed={isSearchOpen}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 transition hover:border-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <SearchIcon size={16} />
                </button>
                {browseHeaderControls ? (
                  <div className="flex items-center gap-3">{browseHeaderControls}</div>
                ) : null}
                <div className="flex gap-3 ml-3">
                  {NAV_TABS.map(item => {
                    const selectedCount = selectedBlobs.size;
                    const isUploadTab = item.id === "upload";
                    const isTransferView = tab === "transfer";
                    const showTransfer = isUploadTab && selectedCount > 0;
                    const isActive = tab === item.id || (isUploadTab && isTransferView);
                    const IconComponent = showTransfer ? TransferIcon : item.icon;
                    const label = showTransfer ? "Transfer" : item.label;
                    const hideLabelOnMobile = isUploadTab;
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          const nextTab = showTransfer ? "transfer" : item.id;
                          setTab(nextTab);
                        }}
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
            <div
              className={`flex flex-1 min-h-0 flex-col box-border p-4 ${
                tab === "browse" || tab === "share" ? "overflow-hidden" : "overflow-y-auto"
              }`}
            >
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                    Loading workspace…
                  </div>
                }
              >
              <WorkspaceLazy
                tab={tab}
                servers={localServers}
                selectedServer={selectedServer}
                onSelectServer={setSelectedServer}
                homeNavigationKey={homeNavigationKey}
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
              />
            </Suspense>

              {tab === "share" && (
                <div className="flex flex-1 min-h-0">
                  <Suspense
                    fallback={
                      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                        Loading share composer…
                      </div>
                    }
                  >
                    <ShareComposerLazy
                      embedded
                      payload={shareState.payload}
                      shareKey={shareState.shareKey}
                      onClose={() => {
                        clearShareState();
                        setTab("browse");
                      }}
                      onShareComplete={handleShareComplete}
                    />
                  </Suspense>
                </div>
              )}

              {tab === "servers" && (
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                      Loading servers…
                    </div>
                  }
                >
                  <ServerListLazy
                    servers={localServers}
                    selected={selectedServer}
                    defaultServerUrl={preferences.defaultServerUrl}
                    onSelect={setSelectedServer}
                    onSetDefaultServer={handleSetDefaultServer}
                    onAdd={handleAddServer}
                    onUpdate={handleUpdateServer}
                    onSave={handleSaveServers}
                    saving={saving}
                    disabled={!signer}
                    onRemove={handleRemoveServer}
                    onToggleAuth={handleToggleRequiresAuth}
                    onToggleSync={handleToggleSync}
                    onSync={handleSyncSelectedServers}
                    syncDisabled={syncButtonDisabled}
                    syncInProgress={syncBusy}
                    validationError={serverValidationError}
                  />
                </Suspense>
              )}

              {tab === "settings" && (
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                      Loading settings…
                    </div>
                  }
                >
                  <SettingsPanelLazy
                    servers={localServers}
                    defaultServerUrl={preferences.defaultServerUrl}
                    showIconsPreviews={preferences.showGridPreviews}
                    showListPreviews={preferences.showListPreviews}
                    defaultViewMode={preferences.defaultViewMode}
                    defaultFilterMode={preferences.defaultFilterMode}
                    defaultSortOption={preferences.defaultSortOption}
                    onSetDefaultViewMode={handleSetDefaultViewMode}
                    onSetDefaultFilterMode={handleSetDefaultFilterMode}
                    onSetDefaultSortOption={handleSetDefaultSortOption}
                    onSetDefaultServer={handleSetDefaultServer}
                    onSetShowIconsPreviews={handleSetShowPreviewsInGrid}
                    onSetShowListPreviews={handleSetShowPreviewsInList}
                  />
                </Suspense>
              )}

              {tab === "relays" && (
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                      Loading relays…
                    </div>
                  }
                >
                  <RelayListLazy />
                </Suspense>
              )}
            </div>
          </div>

          <footer className="border-t border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="status-server" className="text-[11px] uppercase tracking-wide text-slate-300">
                Server
              </label>
              <select
                id="status-server"
                value={statusSelectValue}
                onChange={handleStatusServerChange}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value={ALL_SERVERS_VALUE}>All servers</option>
                {localServers.map(server => (
                  <option key={server.url} value={server.url}>
                    {server.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={`flex-1 text-center ${centerClass}`}>{centerMessage ?? ""}</div>
            <div className="ml-auto flex gap-4">
              <span>
                {statusCount} item{statusCount === 1 ? "" : "s"}
              </span>
              <span>{prettyBytes(statusSize)}</span>
            </div>
          </footer>

          {showAuthPrompt && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-slate-950/80 px-6 text-center backdrop-blur-sm">
              <img src="/bloom.png" alt="Bloom logo" className="w-24 md:w-32 rounded-xl" />
              <p className="text-sm text-slate-200">Connect your Nostr account to use Bloom.</p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={connect}
                  className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  Connect With Browser Extension
                </button>
                <button
                  onClick={() => setConnectSignerOpen(true)}
                  className="px-3 py-2 rounded-xl border border-emerald-500/60 bg-transparent text-emerald-300 hover:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                >
                  Connect With Signer
                </button>
              </div>
            </div>
          )}

          {renameTarget && (
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

          {folderRenamePath && (
            <FolderRenameDialog
              path={folderRenamePath}
              onClose={handleFolderRenameClose}
              onStatus={showStatusMessage}
            />
          )}

          <Suspense fallback={null}>
            <ConnectSignerDialogLazy
              open={connectSignerOpen}
              onClose={() => setConnectSignerOpen(false)}
              onPaired={() => showStatusMessage("Amber signer connected", "success")}
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
