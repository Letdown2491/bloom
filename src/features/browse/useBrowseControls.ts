import { useCallback, useMemo, useRef, useState } from "react";

export type FilterMode = "all" | "music" | "documents" | "images" | "pdfs" | "videos";

type FilterOption = {
  id: Exclude<FilterMode, "all">;
  label: string;
};

const FILTER_OPTIONS: FilterOption[] = [
  { id: "music", label: "Music" },
  { id: "documents", label: "Documents" },
  { id: "images", label: "Images" },
  { id: "pdfs", label: "PDFs" },
  { id: "videos", label: "Videos" },
];

const OPTION_MAP = FILTER_OPTIONS.reduce<Record<Exclude<FilterMode, "all">, FilterOption>>((acc, option) => {
  acc[option.id] = option;
  return acc;
}, {} as any);

export const useBrowseControls = () => {
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const previousViewModeRef = useRef<"grid" | "list">("list");

  const isMusicFilterActive = filterMode === "music";

  const openFilterMenu = useCallback(() => setIsFilterMenuOpen(true), []);
  const closeFilterMenu = useCallback(() => setIsFilterMenuOpen(false), []);
  const toggleFilterMenu = useCallback(() => {
    setIsFilterMenuOpen(prev => !prev);
  }, []);

  const selectFilter = useCallback(
    (next: FilterMode) => {
      setFilterMode(prev => {
        const nextValue = prev === next ? "all" : next;
        if (nextValue === "music" && prev !== "music") {
          previousViewModeRef.current = viewMode;
          setViewMode("list");
        } else if (prev === "music" && nextValue !== "music") {
          setViewMode(previousViewModeRef.current);
        }
        return nextValue;
      });
      setIsFilterMenuOpen(false);
    },
    [viewMode]
  );

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
      isMusicFilterActive,
    };
  }, [filterMode, isFilterMenuOpen, isMusicFilterActive]);

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
  };
};

export const getFilterOptions = () => FILTER_OPTIONS;
