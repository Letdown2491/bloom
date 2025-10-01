import React from "react";
import type { BrowseNavigationState } from "../features/workspace/BrowseTabContainer";
import type { TabId } from "../types/tabs";
import { CloseIcon, HomeIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon, TransferIcon } from "./icons";

type NavTab = {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
};

type WorkspaceToolbarProps = {
  showAuthPrompt: boolean;
  keepSearchExpanded: boolean;
  browseNavigationState: BrowseNavigationState | null;
  onNavigateHome: () => void;
  onNavigateUp?: () => void;
  canNavigateUp: boolean;
  isSearchOpen: boolean;
  onToggleSearch: () => void;
  searchQuery: string;
  onSearchChange: React.ChangeEventHandler<HTMLInputElement>;
  onSearchKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
  onClearSearch: () => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  browseHeaderControls: React.ReactNode | null;
  selectedBlobCount: number;
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  navTabs: NavTab[];
};

const WorkspaceToolbarComponent: React.FC<WorkspaceToolbarProps> = ({
  showAuthPrompt,
  keepSearchExpanded,
  browseNavigationState,
  onNavigateHome,
  onNavigateUp,
  canNavigateUp,
  isSearchOpen,
  onToggleSearch,
  searchQuery,
  onSearchChange,
  onSearchKeyDown,
  onClearSearch,
  searchInputRef,
  browseHeaderControls,
  selectedBlobCount,
  activeTab,
  onSelectTab,
  navTabs,
}) => {
  return (
    <nav className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onNavigateHome}
          disabled={showAuthPrompt}
          className="px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
        >
          <HomeIcon size={16} />
          <span>Home</span>
        </button>
        {keepSearchExpanded && (
          <button
            type="button"
            onClick={onNavigateUp}
            disabled={showAuthPrompt || !canNavigateUp}
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
              ref={searchInputRef}
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
                onClick={onClearSearch}
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
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleSearch}
          disabled={showAuthPrompt || keepSearchExpanded}
          aria-label="Search files"
          aria-pressed={isSearchOpen}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 transition hover:border-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <SearchIcon size={16} />
        </button>
        {browseHeaderControls ? (
          <div className="flex items-center gap-3">{browseHeaderControls}</div>
        ) : activeTab === "browse" ? (
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-10 w-11 rounded-xl border border-transparent bg-transparent" />
            <span className="h-10 w-11 rounded-xl border border-transparent bg-transparent" />
            <span className="h-10 w-11 rounded-xl border border-transparent bg-transparent" />
          </div>
        ) : null}
        <div className="flex gap-3 ml-3">
          {navTabs.map(item => {
            const selectedCount = selectedBlobCount;
            const isUploadTab = item.id === "upload";
            const isTransferView = activeTab === "transfer";
            const showTransfer = isUploadTab && selectedCount > 0;
            const isActive = activeTab === item.id || (isUploadTab && (isTransferView || showTransfer));
            const IconComponent = showTransfer ? TransferIcon : item.icon;
            const label = showTransfer ? "Transfer" : item.label;
            const targetTab = showTransfer ? ("transfer" as TabId) : item.id;
            const hideLabelOnMobile = isUploadTab;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(targetTab)}
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
};

export const WorkspaceToolbar = React.memo(WorkspaceToolbarComponent);
