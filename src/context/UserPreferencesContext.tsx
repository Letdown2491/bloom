import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { FilterMode } from "../types/filter";

type ViewMode = "grid" | "list";

type UserPreferences = {
  defaultServerUrl: string | null;
  defaultViewMode: ViewMode;
  defaultFilterMode: FilterMode;
  showGridPreviews: boolean;
  showListPreviews: boolean;
};

const DEFAULT_PREFERENCES: UserPreferences = {
  defaultServerUrl: null,
  defaultViewMode: "list",
  defaultFilterMode: "all",
  showGridPreviews: true,
  showListPreviews: true,
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
    const legacyShowPreviews = typeof parsed?.showPreviews === "boolean" ? parsed.showPreviews : undefined;
    const showGridPreviews = typeof parsed?.showGridPreviews === "boolean"
      ? parsed.showGridPreviews
      : legacyShowPreviews ?? true;
    const showListPreviews = typeof parsed?.showListPreviews === "boolean"
      ? parsed.showListPreviews
      : legacyShowPreviews ?? true;
    const defaultServerUrl = typeof parsed?.defaultServerUrl === "string" && parsed.defaultServerUrl.trim()
      ? parsed.defaultServerUrl.trim()
      : null;
    return {
      defaultServerUrl,
      defaultViewMode,
      defaultFilterMode,
      showGridPreviews,
      showListPreviews,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
};

const isFilterMode = (value: unknown): value is FilterMode =>
  value === "all" || value === "music" || value === "documents" || value === "images" || value === "pdfs" || value === "videos";

type UserPreferencesContextValue = {
  preferences: UserPreferences;
  setDefaultServerUrl: (url: string | null) => void;
  setDefaultViewMode: (mode: ViewMode) => void;
  setDefaultFilterMode: (mode: FilterMode) => void;
  setShowGridPreviews: (value: boolean) => void;
  setShowListPreviews: (value: boolean) => void;
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

  const value = useMemo(
    () => ({
      preferences,
      setDefaultServerUrl,
      setDefaultViewMode,
      setDefaultFilterMode,
      setShowGridPreviews,
      setShowListPreviews,
    }),
    [
      preferences,
      setDefaultServerUrl,
      setDefaultViewMode,
      setDefaultFilterMode,
      setShowGridPreviews,
      setShowListPreviews,
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
