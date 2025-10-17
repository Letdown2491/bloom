import { useCallback, useEffect, useMemo, useState } from "react";
import { useUserPreferences } from "../../app/context/UserPreferencesContext";
import type { FilterMode } from "../../shared/types/filter";
import type { SortDirection } from "../../app/context/UserPreferencesContext";

type FilterOption = {
  id: Exclude<FilterMode, "all">;
  label: string;
};

const FILTER_LABELS: Record<Exclude<FilterMode, "all">, string> = {
  documents: "Documents",
  pdfs: "Documents",
  images: "Images",
  music: "Audio",
  videos: "Videos",
};

const OPTION_MAP = (Object.keys(FILTER_LABELS) as Array<Exclude<FilterMode, "all">>).reduce<
  Record<Exclude<FilterMode, "all">, FilterOption>
>((acc, key) => {
  acc[key] = { id: key, label: FILTER_LABELS[key] };
  return acc;
}, {} as any);

export const useBrowseControls = () => {
  const { preferences, setDefaultViewMode, setSortDirection } = useUserPreferences();
  const [viewMode, setViewModeState] = useState<"grid" | "list">(() => preferences.defaultViewMode);
  const [filterMode, setFilterMode] = useState<FilterMode>(() => preferences.defaultFilterMode);
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const [sortDirection, setSortDirectionState] = useState<SortDirection>(preferences.sortDirection);

  const setViewMode = useCallback(
    (mode: "grid" | "list", persist = true) => {
      setViewModeState(prev => (prev === mode ? prev : mode));
      if (persist) {
        setDefaultViewMode(mode);
      }
    },
    [setDefaultViewMode]
  );

  const openFilterMenu = useCallback(() => setIsFilterMenuOpen(true), []);
  const closeFilterMenu = useCallback(() => setIsFilterMenuOpen(false), []);
  const toggleFilterMenu = useCallback(() => {
    setIsFilterMenuOpen(prev => !prev);
  }, []);

  const selectFilter = useCallback(
    (next: FilterMode) => {
      setFilterMode(prev => {
        const nextValue = prev === next ? "all" : next;
        return nextValue;
      });
      setIsFilterMenuOpen(false);
    },
    [setFilterMode, setIsFilterMenuOpen]
  );

  const toggleSortDirection = useCallback(
    () => {
      setSortDirectionState(prev => {
        const nextDirection: SortDirection = prev === "ascending" ? "descending" : "ascending";
        setSortDirection(nextDirection);
        return nextDirection;
      });
    },
    [setSortDirection]
  );

  useEffect(() => {
    setViewModeState(prev => (prev === preferences.defaultViewMode ? prev : preferences.defaultViewMode));
  }, [preferences.defaultViewMode]);

  useEffect(() => {
    setFilterMode(prev => {
      const nextValue = preferences.defaultFilterMode;
      if (prev === nextValue) return prev;
      return nextValue;
    });
  }, [preferences.defaultFilterMode]);

  useEffect(() => {
    setSortDirectionState(prev => (prev === preferences.sortDirection ? prev : preferences.sortDirection));
  }, [preferences.sortDirection]);

  const filterContext = useMemo(() => {
    const activeOption = filterMode === "all" ? null : OPTION_MAP[filterMode];
    const filterButtonLabel = activeOption ? activeOption.label : "Filter";
    const filterButtonAriaLabel = activeOption ? `Filter: ${activeOption.label}` : "Filter files";
    const filterButtonActive = filterMode !== "all" || isFilterMenuOpen;
    return {
      filterButtonLabel,
      filterButtonAriaLabel,
      filterButtonActive,
      isFilterMenuOpen,
    };
  }, [filterMode, isFilterMenuOpen]);

  const handleTabChange = useCallback((tabId: string) => {
    if (tabId !== "browse") {
      setIsFilterMenuOpen(false);
    }
  }, []);

  return {
    viewMode,
    setViewMode,
    filterMode,
    selectFilter,
    ...filterContext,
    openFilterMenu,
    closeFilterMenu,
    toggleFilterMenu,
    handleTabChange,
    sortDirection,
    toggleSortDirection,
  };
};
