import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { FilterMode } from "../types/filter";

type ViewMode = "grid" | "list";

export type DefaultSortOption = "name" | "servers" | "updated" | "size";

type UserPreferences = {
  defaultServerUrl: string | null;
  defaultViewMode: ViewMode;
  defaultFilterMode: FilterMode;
  defaultSortOption: DefaultSortOption;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  keepSearchExpanded: boolean;
};

const DEFAULT_PREFERENCES: UserPreferences = {
  defaultServerUrl: null,
  defaultViewMode: "list",
  defaultFilterMode: "all",
  defaultSortOption: "updated",
  showGridPreviews: true,
  showListPreviews: true,
  keepSearchExpanded: false,
};

const STORAGE_KEY = "bloom:user-preferences";

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
    return {
      defaultServerUrl,
      defaultViewMode,
      defaultFilterMode,
      defaultSortOption,
      showGridPreviews,
      showListPreviews,
      keepSearchExpanded,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
};

const isFilterMode = (value: unknown): value is FilterMode =>
  value === "all" || value === "music" || value === "documents" || value === "images" || value === "pdfs" || value === "videos";

const isSortOption = (value: unknown): value is DefaultSortOption =>
  value === "name" || value === "servers" || value === "updated" || value === "size";

type UserPreferencesContextValue = {
  preferences: UserPreferences;
  setDefaultServerUrl: (url: string | null) => void;
  setDefaultViewMode: (mode: ViewMode) => void;
  setDefaultFilterMode: (mode: FilterMode) => void;
  setDefaultSortOption: (option: DefaultSortOption) => void;
  setShowGridPreviews: (value: boolean) => void;
  setShowListPreviews: (value: boolean) => void;
  setKeepSearchExpanded: (value: boolean) => void;
};

const UserPreferencesContext = createContext<UserPreferencesContextValue | undefined>(undefined);

export const UserPreferencesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preferences, setPreferences] = useState<UserPreferences>(() => readStoredPreferences());

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Swallow storage errors; preference persistence is best-effort only.
    }
  }, [preferences]);

  const setDefaultServerUrl = useCallback((url: string | null) => {
    setPreferences(prev => {
      if (prev.defaultServerUrl === url) return prev;
      return { ...prev, defaultServerUrl: url };
    });
  }, []);

  const setDefaultViewMode = useCallback((mode: ViewMode) => {
    setPreferences(prev => {
      if (prev.defaultViewMode === mode) return prev;
      return { ...prev, defaultViewMode: mode };
    });
  }, []);

  const setDefaultFilterMode = useCallback((mode: FilterMode) => {
    setPreferences(prev => {
      if (prev.defaultFilterMode === mode) return prev;
      return { ...prev, defaultFilterMode: mode };
    });
  }, []);

  const setDefaultSortOption = useCallback((option: DefaultSortOption) => {
    setPreferences(prev => {
      if (prev.defaultSortOption === option) return prev;
      return { ...prev, defaultSortOption: option };
    });
  }, []);

  const setShowGridPreviews = useCallback((value: boolean) => {
    setPreferences(prev => {
      if (prev.showGridPreviews === value) return prev;
      return { ...prev, showGridPreviews: value };
    });
  }, []);

  const setShowListPreviews = useCallback((value: boolean) => {
    setPreferences(prev => {
      if (prev.showListPreviews === value) return prev;
      return { ...prev, showListPreviews: value };
    });
  }, []);

  const setKeepSearchExpanded = useCallback((value: boolean) => {
    setPreferences(prev => {
      if (prev.keepSearchExpanded === value) return prev;
      return { ...prev, keepSearchExpanded: value };
    });
  }, []);

  const value = useMemo(
    () => ({
      preferences,
      setDefaultServerUrl,
      setDefaultViewMode,
      setDefaultFilterMode,
      setDefaultSortOption,
      setShowGridPreviews,
      setShowListPreviews,
      setKeepSearchExpanded,
    }),
    [
      preferences,
      setDefaultServerUrl,
      setDefaultViewMode,
      setDefaultFilterMode,
      setDefaultSortOption,
      setShowGridPreviews,
      setShowListPreviews,
      setKeepSearchExpanded,
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
