import type { FilterMode } from "./filter";

export type ViewMode = "grid" | "list";

export type DefaultSortOption = "name" | "servers" | "updated" | "size";

export type SortDirection = "ascending" | "descending";

export type UserPreferences = {
  defaultServerUrl: string | null;
  defaultViewMode: ViewMode;
  defaultFilterMode: FilterMode;
  defaultSortOption: DefaultSortOption;
  sortDirection: SortDirection;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  keepSearchExpanded: boolean;
  theme: "dark" | "light";
};
