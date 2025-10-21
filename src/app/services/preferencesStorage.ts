import type { FilterMode } from "../../shared/types/filter";
import type { UserPreferences } from "../../shared/types/preferences";
import { normalizeEpochSeconds } from "../../shared/utils/time";

export const DEFAULT_PREFERENCES: UserPreferences = {
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

export type SyncMetadata = {
  lastSyncedAt: number | null;
  lastLocalUpdatedAt: number | null;
};

const isFilterMode = (value: unknown): value is FilterMode =>
  value === "all" ||
  value === "music" ||
  value === "documents" ||
  value === "images" ||
  value === "pdfs" ||
  value === "videos";

const isSortOption = (value: unknown): value is UserPreferences["defaultSortOption"] =>
  value === "name" || value === "servers" || value === "updated" || value === "size";

const isSortDirection = (value: unknown): value is UserPreferences["sortDirection"] =>
  value === "ascending" || value === "descending";

const isViewMode = (value: unknown): value is UserPreferences["defaultViewMode"] =>
  value === "grid" || value === "list";

const isTheme = (value: unknown): value is UserPreferences["theme"] =>
  value === "dark" || value === "light";

export const loadStoredPreferences = (): UserPreferences => {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as
      | (Partial<UserPreferences> & { showPreviews?: boolean })
      | null;
    const defaultViewMode = isViewMode(parsed?.defaultViewMode) ? parsed!.defaultViewMode : "list";
    const defaultFilterMode = isFilterMode(parsed?.defaultFilterMode)
      ? parsed!.defaultFilterMode
      : "all";
    const defaultSortOption = isSortOption(parsed?.defaultSortOption)
      ? parsed!.defaultSortOption
      : "updated";
    const sortDirection = isSortDirection(parsed?.sortDirection)
      ? parsed!.sortDirection
      : "descending";
    const legacyShowPreviews =
      typeof parsed?.showPreviews === "boolean" ? parsed.showPreviews : undefined;
    const showGridPreviews =
      typeof parsed?.showGridPreviews === "boolean"
        ? parsed.showGridPreviews
        : (legacyShowPreviews ?? true);
    const showListPreviews =
      typeof parsed?.showListPreviews === "boolean"
        ? parsed.showListPreviews
        : (legacyShowPreviews ?? true);
    const keepSearchExpanded =
      typeof parsed?.keepSearchExpanded === "boolean" ? parsed.keepSearchExpanded : false;
    const defaultServerUrl =
      typeof parsed?.defaultServerUrl === "string" && parsed.defaultServerUrl.trim()
        ? parsed.defaultServerUrl.trim()
        : null;
    const theme = isTheme(parsed?.theme) ? parsed!.theme : "dark";
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

export const loadSyncEnabled = (): boolean => {
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

export const loadSyncMetadata = (): SyncMetadata => {
  if (typeof window === "undefined") return { lastSyncedAt: null, lastLocalUpdatedAt: null };
  try {
    const raw = window.localStorage.getItem(SYNC_META_KEY);
    if (!raw) return { lastSyncedAt: null, lastLocalUpdatedAt: null };
    const parsed = JSON.parse(raw) as SyncMetadata;
    const lastSyncedAt = normalizeEpochSeconds(parsed?.lastSyncedAt);
    const lastLocalUpdatedAt = normalizeEpochSeconds(parsed?.lastLocalUpdatedAt);
    return {
      lastSyncedAt,
      lastLocalUpdatedAt,
    };
  } catch {
    return { lastSyncedAt: null, lastLocalUpdatedAt: null };
  }
};

export const persistSyncEnabled = (value: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_ENABLED_KEY, value ? "1" : "0");
  } catch {
    // ignore storage failures
  }
};

export const persistSyncMetadata = (meta: SyncMetadata) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore storage failures
  }
};

export const persistPreferences = (preferences: UserPreferences) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // ignore storage failures
  }
};
