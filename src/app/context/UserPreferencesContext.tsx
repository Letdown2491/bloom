import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NDKEvent as NdkEvent, NDKSigner } from "@nostr-dev-kit/ndk";

import { useNdk } from "./NdkContext";
import {
  PREFERENCES_SYNC_IDENTIFIER,
  PREFERENCES_SYNC_KIND,
  deserializePreferences,
  serializePreferences,
  type SyncedPreferencesPayload,
  type SyncedSavedSearch,
} from "../../shared/domain/preferencesSync";
import type { FilterMode } from "../../shared/types/filter";
import type { ViewMode, DefaultSortOption, SortDirection, UserPreferences } from "../../shared/types/preferences";
import { loadNdkModule } from "../../shared/api/ndkModule";

export type { DefaultSortOption, SortDirection, UserPreferences } from "../../shared/types/preferences";

export type PreferencesSyncState = {
  enabled: boolean;
  loading: boolean;
  error: string | null;
  lastSyncedAt: number | null;
  pending: boolean;
};

type UserPreferencesContextValue = {
  preferences: UserPreferences;
  setDefaultServerUrl: (url: string | null) => void;
  setDefaultViewMode: (mode: ViewMode) => void;
  setDefaultFilterMode: (mode: FilterMode) => void;
  setDefaultSortOption: (option: DefaultSortOption) => void;
  setSortDirection: (direction: SortDirection) => void;
  setShowGridPreviews: (value: boolean) => void;
  setShowListPreviews: (value: boolean) => void;
  setKeepSearchExpanded: (value: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
  setSyncEnabled: (value: boolean) => Promise<void>;
  syncState: PreferencesSyncState;
};

const DEFAULT_PREFERENCES: UserPreferences = {
  defaultServerUrl: null,
  defaultViewMode: "list",
  defaultFilterMode: "all",
  defaultSortOption: "updated",
  sortDirection: "descending",
  showGridPreviews: true,
  showListPreviews: true,
  keepSearchExpanded: false,
  theme: "dark",
};

const STORAGE_KEY = "bloom:user-preferences";
const SYNC_ENABLED_KEY = "bloom:user-preferences-sync-enabled";
const SYNC_META_KEY = "bloom:user-preferences-sync-meta";

const UserPreferencesContext = createContext<UserPreferencesContextValue | undefined>(undefined);

type SyncMetadata = {
  lastSyncedAt: number | null;
  lastLocalUpdatedAt: number | null;
};

type EncryptionCapableSigner = NDKSigner & {
  encrypt: (recipient: { pubkey: string }, value: string, scheme?: "nip44" | "nip04") => Promise<string>;
  decrypt: (sender: { pubkey: string }, value: string, scheme?: "nip44" | "nip04") => Promise<string>;
};

const isEncryptionCapableSigner = (signer: NDKSigner | null | undefined): signer is EncryptionCapableSigner =>
  Boolean(signer && typeof (signer as any).encrypt === "function" && typeof (signer as any).decrypt === "function");

const readStoredPreferences = (): UserPreferences => {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as (Partial<UserPreferences> & { showPreviews?: boolean }) | null;
    const defaultViewMode: ViewMode = parsed?.defaultViewMode === "grid" ? "grid" : "list";
    const defaultFilterMode: FilterMode = isFilterMode(parsed?.defaultFilterMode) ? parsed.defaultFilterMode! : "all";
    const defaultSortOption: DefaultSortOption = isSortOption(parsed?.defaultSortOption)
      ? parsed.defaultSortOption!
      : "updated";
    const sortDirection: SortDirection = isSortDirection(parsed?.sortDirection) ? parsed.sortDirection! : "descending";
    const legacyShowPreviews = typeof parsed?.showPreviews === "boolean" ? parsed.showPreviews : undefined;
    const showGridPreviews = typeof parsed?.showGridPreviews === "boolean"
      ? parsed.showGridPreviews
      : legacyShowPreviews ?? true;
    const showListPreviews = typeof parsed?.showListPreviews === "boolean"
      ? parsed.showListPreviews
      : legacyShowPreviews ?? true;
    const keepSearchExpanded = typeof parsed?.keepSearchExpanded === "boolean" ? parsed.keepSearchExpanded : false;
    const defaultServerUrl = typeof parsed?.defaultServerUrl === "string" && parsed.defaultServerUrl.trim()
      ? parsed.defaultServerUrl.trim()
      : null;
    const theme: "dark" | "light" = parsed?.theme === "light" ? "light" : "dark";
    return {
      defaultServerUrl,
      defaultViewMode,
      defaultFilterMode,
      defaultSortOption,
      sortDirection,
      showGridPreviews,
      showListPreviews,
      keepSearchExpanded,
      theme,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
};

const readStoredSyncEnabled = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(SYNC_ENABLED_KEY);
    if (!raw) return false;
    if (raw === "1") return true;
    if (raw === "0") return false;
    return Boolean(JSON.parse(raw));
  } catch {
    return false;
  }
};

const readStoredSyncMeta = (): SyncMetadata => {
  if (typeof window === "undefined") return { lastSyncedAt: null, lastLocalUpdatedAt: null };
  try {
    const raw = window.localStorage.getItem(SYNC_META_KEY);
    if (!raw) return { lastSyncedAt: null, lastLocalUpdatedAt: null };
    const parsed = JSON.parse(raw) as SyncMetadata;
    const lastSyncedAt = normalizeTimestamp(parsed?.lastSyncedAt);
    const lastLocalUpdatedAt = normalizeTimestamp(parsed?.lastLocalUpdatedAt);
    return {
      lastSyncedAt,
      lastLocalUpdatedAt,
    };
  } catch {
    return { lastSyncedAt: null, lastLocalUpdatedAt: null };
  }
};

const normalizeTimestamp = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 0 ? truncated : null;
};

const isFilterMode = (value: unknown): value is FilterMode =>
  value === "all" || value === "music" || value === "documents" || value === "images" || value === "pdfs" || value === "videos";

const isSortOption = (value: unknown): value is DefaultSortOption =>
  value === "name" || value === "servers" || value === "updated" || value === "size";

const isSortDirection = (value: unknown): value is SortDirection => value === "ascending" || value === "descending";

const preferencesEqual = (a: UserPreferences, b: UserPreferences) =>
  a.defaultServerUrl === b.defaultServerUrl &&
  a.defaultViewMode === b.defaultViewMode &&
  a.defaultFilterMode === b.defaultFilterMode &&
  a.defaultSortOption === b.defaultSortOption &&
  a.sortDirection === b.sortDirection &&
  a.showGridPreviews === b.showGridPreviews &&
  a.showListPreviews === b.showListPreviews &&
  a.keepSearchExpanded === b.keepSearchExpanded &&
  a.theme === b.theme;

const persistSyncEnabled = (value: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_ENABLED_KEY, value ? "1" : "0");
  } catch {
    // ignore storage failures
  }
};

const persistSyncMeta = (meta: SyncMetadata) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore storage failures
  }
};

export const UserPreferencesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ndk, signer, user, ensureConnection } = useNdk();
  const [preferences, setPreferences] = useState<UserPreferences>(() => readStoredPreferences());
  const [syncEnabled, setSyncEnabledState] = useState<boolean>(() => readStoredSyncEnabled());
  const initialSyncMeta = useRef<SyncMetadata>(readStoredSyncMeta());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(initialSyncMeta.current.lastSyncedAt);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [hasPending, setHasPending] = useState(false);

  const savedSearchesRef = useRef<SyncedSavedSearch[]>([]);
  const syncMetaRef = useRef<SyncMetadata>(initialSyncMeta.current);
  const lastLocalUpdateAtRef = useRef<number>(initialSyncMeta.current.lastLocalUpdatedAt ?? 0);
  const latestSyncedAtRef = useRef<number>(initialSyncMeta.current.lastSyncedAt ?? 0);
  const changeOriginRef = useRef<"local" | "remote" | null>(null);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPayloadRef = useRef<SyncedPreferencesPayload | null>(null);
  const lastPublishedJsonRef = useRef<string | null>(null);
  const publishInFlightRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // ignore storage failures
    }
  }, [preferences]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = preferences.theme;
    document.body.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  useEffect(() => {
    return () => {
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, []);

  const flushPending = useCallback(async () => {
    if (!syncEnabled) return;
    const payload = pendingPayloadRef.current;
    if (!payload) return;
    if (!ndk || !signer || !user) return;
    if (!isEncryptionCapableSigner(signer)) {
      setSyncError("Connected signer does not support encrypted sync.");
      return;
    }
    if (publishInFlightRef.current) return;
    publishInFlightRef.current = true;
    setSyncLoading(true);
    try {
      await ensureConnection();
      const { NDKEvent } = await loadNdkModule();
      const event = new NDKEvent(ndk);
      event.kind = PREFERENCES_SYNC_KIND;
      event.pubkey = user.pubkey;
      event.tags = [
        ["d", PREFERENCES_SYNC_IDENTIFIER],
        ["content-type", "application/json"],
        ["version", "1"],
      ];
      event.created_at = payload.updated_at;
      const plaintext = JSON.stringify(payload);
      event.content = await signer.encrypt(user, plaintext, "nip44");
      await event.sign();
      await event.publish();
      lastPublishedJsonRef.current = plaintext;
      pendingPayloadRef.current = null;
      setHasPending(false);
      latestSyncedAtRef.current = payload.updated_at;
      syncMetaRef.current = {
        lastSyncedAt: payload.updated_at,
        lastLocalUpdatedAt: syncMetaRef.current.lastLocalUpdatedAt,
      };
      persistSyncMeta(syncMetaRef.current);
      setLastSyncedAt(payload.updated_at);
      setSyncError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync publish failed.";
      setSyncError(message);
      setHasPending(Boolean(pendingPayloadRef.current));
    } finally {
      publishInFlightRef.current = false;
      setSyncLoading(false);
    }
  }, [ensureConnection, ndk, signer, syncEnabled, user]);

  const queuePublish = useCallback(
    (nextPreferences: UserPreferences, updatedAt: number) => {
      const payload = serializePreferences(nextPreferences, savedSearchesRef.current, updatedAt);
      const serialized = JSON.stringify(payload);
      if (serialized === lastPublishedJsonRef.current && updatedAt <= latestSyncedAtRef.current) {
        return;
      }
      pendingPayloadRef.current = payload;
      setHasPending(true);
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
      }
      publishTimerRef.current = setTimeout(() => {
        publishTimerRef.current = null;
        void flushPending();
      }, 750);
    },
    [flushPending]
  );

  useEffect(() => {
    if (!syncEnabled) return;
    if (!pendingPayloadRef.current) return;
    if (publishTimerRef.current) return;
    if (!ndk || !signer || !user) return;
    if (!isEncryptionCapableSigner(signer)) return;
    void flushPending();
  }, [flushPending, ndk, signer, syncEnabled, user]);

  const applyRemotePreferences = useCallback(
    (payload: SyncedPreferencesPayload, nextPreferences: UserPreferences, savedSearches: SyncedSavedSearch[]) => {
      savedSearchesRef.current = savedSearches;
      latestSyncedAtRef.current = payload.updated_at;
      syncMetaRef.current = {
        lastSyncedAt: payload.updated_at,
        lastLocalUpdatedAt: syncMetaRef.current.lastLocalUpdatedAt,
      };
      persistSyncMeta(syncMetaRef.current);
      setLastSyncedAt(payload.updated_at);
      setSyncError(null);
      changeOriginRef.current = "remote";
      setPreferences(prev => (preferencesEqual(prev, nextPreferences) ? prev : nextPreferences));
    },
    []
  );

  const loadRemotePreferences = useCallback(async () => {
    if (!syncEnabled) return;
    if (!ndk || !signer || !user) {
      setSyncError("Connect your signer to sync preferences.");
      return;
    }
    if (!isEncryptionCapableSigner(signer)) {
      setSyncError("Connected signer does not support encrypted sync.");
      return;
    }
    setSyncLoading(true);
    try {
      await ensureConnection();
      const filter = {
        authors: [user.pubkey],
        kinds: [PREFERENCES_SYNC_KIND],
        "#d": [PREFERENCES_SYNC_IDENTIFIER],
      };
      const events = (await ndk.fetchEvents(filter)) as Set<NdkEvent>;
      if (!events || events.size === 0) {
        const base = Math.max(Math.floor(Date.now() / 1000), lastLocalUpdateAtRef.current);
        queuePublish(preferences, base);
        setSyncLoading(false);
        setSyncError(null);
        return;
      }
      const latest = Array.from(events)
        .filter(event => typeof event?.created_at === "number")
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (!latest || !latest.content) {
        setSyncLoading(false);
        return;
      }
      const decrypted = await signer.decrypt(user, latest.content, "nip44");
      const parsed = JSON.parse(decrypted);
      const result = deserializePreferences(parsed);
      if (!result) {
        setSyncError("Remote settings payload is invalid.");
        return;
      }
      const remoteUpdatedAt = result.payload.updated_at;
      if (remoteUpdatedAt > lastLocalUpdateAtRef.current) {
        applyRemotePreferences(result.payload, result.preferences, result.savedSearches);
      } else if (remoteUpdatedAt < lastLocalUpdateAtRef.current) {
        const timestamp = Math.max(lastLocalUpdateAtRef.current, Math.floor(Date.now() / 1000));
        queuePublish(preferences, timestamp);
      } else {
        latestSyncedAtRef.current = remoteUpdatedAt;
        syncMetaRef.current = {
          lastSyncedAt: remoteUpdatedAt,
          lastLocalUpdatedAt: lastLocalUpdateAtRef.current,
        };
        persistSyncMeta(syncMetaRef.current);
        setLastSyncedAt(remoteUpdatedAt);
        setSyncError(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load synced preferences.";
      setSyncError(message);
    } finally {
      setSyncLoading(false);
    }
  }, [applyRemotePreferences, ensureConnection, ndk, preferences, queuePublish, signer, syncEnabled, user]);

  useEffect(() => {
    if (!syncEnabled) return;
    if (!ndk || !signer || !user) return;
    if (!isEncryptionCapableSigner(signer)) return;
    void loadRemotePreferences();
  }, [loadRemotePreferences, ndk, signer, syncEnabled, user]);

  useEffect(() => {
    if (!syncEnabled) return;
    if (!ndk || !signer || !user) return;
    if (!isEncryptionCapableSigner(signer)) return;
    void ensureConnection();
    const filter = {
      authors: [user.pubkey],
      kinds: [PREFERENCES_SYNC_KIND],
      "#d": [PREFERENCES_SYNC_IDENTIFIER],
    };
    const subscription = ndk.subscribe(filter, { closeOnEose: false });
    const handler = async (event: NdkEvent) => {
      if (!event?.content) return;
      try {
        const decrypted = await signer.decrypt(user, event.content, "nip44");
        const parsed = JSON.parse(decrypted);
        const result = deserializePreferences(parsed);
        if (!result) return;
        const remoteUpdatedAt = result.payload.updated_at;
        if (remoteUpdatedAt <= latestSyncedAtRef.current) return;
        if (remoteUpdatedAt <= lastLocalUpdateAtRef.current) return;
        applyRemotePreferences(result.payload, result.preferences, result.savedSearches);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to process synced preferences.";
        setSyncError(message);
      }
    };
    subscription.on("event", handler);
    return () => {
      subscription.stop();
    };
  }, [applyRemotePreferences, ensureConnection, ndk, signer, syncEnabled, user]);

  useEffect(() => {
    if (!syncEnabled) return;
    if (!signer || !user) {
      setSyncError("Connect your signer to sync preferences.");
      return;
    }
    if (!isEncryptionCapableSigner(signer)) {
      setSyncError("Connected signer does not support encrypted sync.");
      return;
    }
    setSyncError(null);
  }, [signer, syncEnabled, user]);

  useEffect(() => {
    const origin = changeOriginRef.current;
    if (!origin) return;
    changeOriginRef.current = null;
    if (origin === "local") {
      const timestamp = lastLocalUpdateAtRef.current > 0 ? lastLocalUpdateAtRef.current : Math.floor(Date.now() / 1000);
      syncMetaRef.current = {
        lastSyncedAt: syncMetaRef.current.lastSyncedAt,
        lastLocalUpdatedAt: timestamp,
      };
      persistSyncMeta(syncMetaRef.current);
      if (syncEnabled) {
        queuePublish(preferences, timestamp);
      }
    }
  }, [preferences, queuePublish, syncEnabled]);

  const mutatePreferences = useCallback((updater: (prev: UserPreferences) => UserPreferences) => {
    let nextValue: UserPreferences | null = null;
    setPreferences(prev => {
      const next = updater(prev);
      if (next === prev) return prev;
      nextValue = next;
      return next;
    });
    if (nextValue) {
      const baseTimestamp = Math.floor(Date.now() / 1000);
      const nextTimestamp = Math.max(baseTimestamp, lastLocalUpdateAtRef.current + 1, latestSyncedAtRef.current + 1);
      lastLocalUpdateAtRef.current = nextTimestamp;
      changeOriginRef.current = "local";
    }
  }, []);

  const setDefaultServerUrl = useCallback(
    (url: string | null) => {
      mutatePreferences(prev => {
        if (prev.defaultServerUrl === url) return prev;
        return { ...prev, defaultServerUrl: url };
      });
    },
    [mutatePreferences]
  );

  const setDefaultViewMode = useCallback(
    (mode: ViewMode) => {
      mutatePreferences(prev => {
        if (prev.defaultViewMode === mode) return prev;
        return { ...prev, defaultViewMode: mode };
      });
    },
    [mutatePreferences]
  );

  const setDefaultFilterMode = useCallback(
    (mode: FilterMode) => {
      mutatePreferences(prev => {
        if (prev.defaultFilterMode === mode) return prev;
        return { ...prev, defaultFilterMode: mode };
      });
    },
    [mutatePreferences]
  );

  const setDefaultSortOption = useCallback(
    (option: DefaultSortOption) => {
      mutatePreferences(prev => {
        if (prev.defaultSortOption === option) return prev;
        return { ...prev, defaultSortOption: option };
      });
    },
    [mutatePreferences]
  );

  const setSortDirection = useCallback(
    (direction: SortDirection) => {
      mutatePreferences(prev => {
        if (prev.sortDirection === direction) return prev;
        return { ...prev, sortDirection: direction };
      });
    },
    [mutatePreferences]
  );

  const setShowGridPreviews = useCallback(
    (value: boolean) => {
      mutatePreferences(prev => {
        if (prev.showGridPreviews === value) return prev;
        return { ...prev, showGridPreviews: value };
      });
    },
    [mutatePreferences]
  );

  const setShowListPreviews = useCallback(
    (value: boolean) => {
      mutatePreferences(prev => {
        if (prev.showListPreviews === value) return prev;
        return { ...prev, showListPreviews: value };
      });
    },
    [mutatePreferences]
  );

  const setKeepSearchExpanded = useCallback(
    (value: boolean) => {
      mutatePreferences(prev => {
        if (prev.keepSearchExpanded === value) return prev;
        return { ...prev, keepSearchExpanded: value };
      });
    },
    [mutatePreferences]
  );

  const setTheme = useCallback(
    (theme: "dark" | "light") => {
      mutatePreferences(prev => {
        if (prev.theme === theme) return prev;
        return { ...prev, theme };
      });
    },
    [mutatePreferences]
  );

  const setSyncEnabled = useCallback(
    async (value: boolean) => {
      if (value === syncEnabled) return;
      if (value) {
        if (!signer || !user) {
          setSyncError("Connect your signer to enable sync.");
          return;
        }
        if (!isEncryptionCapableSigner(signer)) {
          setSyncError("Connected signer does not support encrypted sync.");
          return;
        }
      }
      setSyncError(null);
      setSyncEnabledState(value);
      persistSyncEnabled(value);
      if (!value) {
        if (publishTimerRef.current) {
          clearTimeout(publishTimerRef.current);
          publishTimerRef.current = null;
        }
        pendingPayloadRef.current = null;
        setHasPending(false);
        setSyncLoading(false);
      }
    },
    [signer, syncEnabled, user]
  );

  const syncState = useMemo<PreferencesSyncState>(
    () => ({
      enabled: syncEnabled,
      loading: syncLoading,
      error: syncError,
      lastSyncedAt,
      pending: hasPending,
    }),
    [hasPending, lastSyncedAt, syncEnabled, syncError, syncLoading]
  );

  const value = useMemo(
    () => ({
      preferences,
      setDefaultServerUrl,
      setDefaultViewMode,
      setDefaultFilterMode,
      setDefaultSortOption,
      setSortDirection,
      setShowGridPreviews,
      setShowListPreviews,
      setKeepSearchExpanded,
      setTheme,
      setSyncEnabled,
      syncState,
    }),
    [
      preferences,
      setDefaultServerUrl,
      setDefaultViewMode,
      setDefaultFilterMode,
      setDefaultSortOption,
      setSortDirection,
      setShowGridPreviews,
      setShowListPreviews,
      setKeepSearchExpanded,
      setTheme,
      setSyncEnabled,
      syncState,
    ]
  );

  return <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>;
};

export const useUserPreferences = () => {
  const context = useContext(UserPreferencesContext);
  if (!context) {
    throw new Error("useUserPreferences must be used within a UserPreferencesProvider");
  }
  return context;
};
