import type { FilterMode } from "../types/filter";
import type { UserPreferences } from "../context/UserPreferencesContext";

export const PREFERENCES_SYNC_KIND = 30078;
export const PREFERENCES_SYNC_IDENTIFIER = "bloom:prefs:v1";

export type SyncedPreferencesPayload = {
  version: 1;
  updated_at: number;
  preferences: SerializedPreferences;
  saved_searches: SyncedSavedSearch[];
};

export type SyncedSavedSearch = {
  id: string;
  label: string;
  query: string;
  created_at: number;
  updated_at: number;
};

type SerializedPreferences = {
  default_server_url: string | null;
  default_view_mode: "grid" | "list";
  default_filter_mode: FilterMode;
  default_sort_option: "name" | "servers" | "updated" | "size";
  sort_direction: "ascending" | "descending";
  show_grid_previews: boolean;
  show_list_previews: boolean;
  keep_search_expanded: boolean;
  theme: "dark" | "light";
};

const DEFAULT_SERIALIZED_PREFERENCES: SerializedPreferences = {
  default_server_url: null,
  default_view_mode: "list",
  default_filter_mode: "all",
  default_sort_option: "updated",
  sort_direction: "descending",
  show_grid_previews: true,
  show_list_previews: true,
  keep_search_expanded: false,
  theme: "dark",
};

const sanitizeFilterMode = (value: unknown): FilterMode => {
  switch (value) {
    case "documents":
    case "images":
    case "music":
    case "pdfs":
    case "videos":
    case "all":
      return value;
    default:
      return "all";
  }
};

const sanitizeSortOption = (value: unknown): SerializedPreferences["default_sort_option"] => {
  switch (value) {
    case "name":
    case "servers":
    case "updated":
    case "size":
      return value;
    default:
      return "updated";
  }
};

const sanitizeSortDirection = (value: unknown): SerializedPreferences["sort_direction"] => {
  return value === "ascending" ? "ascending" : "descending";
};

const sanitizeViewMode = (value: unknown): SerializedPreferences["default_view_mode"] => {
  return value === "grid" ? "grid" : "list";
};

const sanitizeTheme = (value: unknown): SerializedPreferences["theme"] => {
  return value === "light" ? "light" : "dark";
};

export const serializePreferences = (
  preferences: UserPreferences,
  savedSearches: SyncedSavedSearch[],
  updatedAt: number
): SyncedPreferencesPayload => {
  const payload: SyncedPreferencesPayload = {
    version: 1,
    updated_at: updatedAt,
    preferences: {
      default_server_url: preferences.defaultServerUrl,
      default_view_mode: preferences.defaultViewMode,
      default_filter_mode: preferences.defaultFilterMode,
      default_sort_option: preferences.defaultSortOption,
      sort_direction: preferences.sortDirection,
      show_grid_previews: preferences.showGridPreviews,
      show_list_previews: preferences.showListPreviews,
      keep_search_expanded: preferences.keepSearchExpanded,
      theme: preferences.theme,
    },
    saved_searches: savedSearches,
  };
  return payload;
};

export const deserializePreferences = (
  input: unknown
): { payload: SyncedPreferencesPayload; preferences: UserPreferences; savedSearches: SyncedSavedSearch[] } | null => {
  if (!input || typeof input !== "object") return null;
  const source = input as Partial<SyncedPreferencesPayload>;
  if (source.version !== 1) return null;
  const updatedAt = typeof source.updated_at === "number" && Number.isFinite(source.updated_at)
    ? Math.max(0, Math.trunc(source.updated_at))
    : null;
  if (!updatedAt) return null;

  const rawPreferences = source.preferences && typeof source.preferences === "object"
    ? { ...DEFAULT_SERIALIZED_PREFERENCES, ...(source.preferences as SerializedPreferences) }
    : DEFAULT_SERIALIZED_PREFERENCES;

  const preferences: UserPreferences = {
    defaultServerUrl:
      typeof rawPreferences.default_server_url === "string" && rawPreferences.default_server_url.trim()
        ? rawPreferences.default_server_url.trim()
        : null,
    defaultViewMode: sanitizeViewMode(rawPreferences.default_view_mode),
    defaultFilterMode: sanitizeFilterMode(rawPreferences.default_filter_mode),
    defaultSortOption: sanitizeSortOption(rawPreferences.default_sort_option),
    sortDirection: sanitizeSortDirection(rawPreferences.sort_direction),
    showGridPreviews: Boolean(rawPreferences.show_grid_previews),
    showListPreviews: Boolean(rawPreferences.show_list_previews),
    keepSearchExpanded: Boolean(rawPreferences.keep_search_expanded),
    theme: sanitizeTheme(rawPreferences.theme),
  };

  const savedSearches: SyncedSavedSearch[] = Array.isArray(source.saved_searches)
    ? source.saved_searches
        .map(entry => sanitizeSavedSearch(entry))
        .filter((entry): entry is SyncedSavedSearch => Boolean(entry))
    : [];

  const payload: SyncedPreferencesPayload = {
    version: 1,
    updated_at: updatedAt,
    preferences: {
      default_server_url: preferences.defaultServerUrl,
      default_view_mode: preferences.defaultViewMode,
      default_filter_mode: preferences.defaultFilterMode,
      default_sort_option: preferences.defaultSortOption,
      sort_direction: preferences.sortDirection,
      show_grid_previews: preferences.showGridPreviews,
      show_list_previews: preferences.showListPreviews,
      keep_search_expanded: preferences.keepSearchExpanded,
      theme: preferences.theme,
    },
    saved_searches: savedSearches,
  };

  return { payload, preferences, savedSearches };
};

const sanitizeSavedSearch = (value: unknown): SyncedSavedSearch | null => {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : null;
  const label = typeof source.label === "string" && source.label.trim() ? source.label.trim() : null;
  const query = typeof source.query === "string" && source.query.trim() ? source.query.trim() : null;
  const createdAt = normalizeTimestamp(source.created_at);
  const updatedAt = normalizeTimestamp(source.updated_at);
  if (!id || !query || !createdAt || !updatedAt) return null;
  return {
    id,
    label: label ?? "",
    query,
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

const normalizeTimestamp = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
};
