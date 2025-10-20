import React from "react";
import type { BrowseNavigationState } from "../BrowseTabContainer";
import type { TabId } from "../../../shared/types/tabs";
import {
  CloseIcon,
  HomeIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  TransferIcon,
  ShareIcon,
} from "../../../shared/ui/icons";
import { useIsCompactScreen } from "../../../shared/hooks/useIsCompactScreen";
import { useSyncPipeline } from "../../../app/context/SyncPipelineContext";

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

const GROUP_BUTTON_BASE =
  "flex h-10 shrink-0 items-center gap-2 px-0 text-sm transition focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60";
const GROUP_BUTTON_DEFAULT = "bg-slate-900/70 text-slate-300 hover:bg-slate-900/80";
const GROUP_BUTTON_ACTIVE = "bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20";
const GROUP_BUTTON_DISABLED = "bg-slate-900/70 text-slate-500";

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
  const isCompactScreen = useIsCompactScreen();
  const { settingsReady } = useSyncPipeline();
  const hasBreadcrumbs = Boolean(browseNavigationState?.segments.length);
  const showBreadcrumbs = !isCompactScreen && hasBreadcrumbs;
  const searchButtonStateClass =
    showAuthPrompt || !settingsReady || keepSearchExpanded ? GROUP_BUTTON_DISABLED : GROUP_BUTTON_DEFAULT;
  const browseControlsSegments = browseHeaderControls
    ? React.Children.toArray(browseHeaderControls)
    : activeTab === "browse"
    ? [
        <span
          key="placeholder-1"
          className={`${GROUP_BUTTON_BASE} ${GROUP_BUTTON_DEFAULT} w-11 justify-center pointer-events-none select-none`}
          aria-hidden="true"
        />,
        <span
          key="placeholder-2"
          className={`${GROUP_BUTTON_BASE} ${GROUP_BUTTON_DEFAULT} w-11 justify-center pointer-events-none select-none`}
          aria-hidden="true"
        />,
        <span
          key="placeholder-3"
          className={`${GROUP_BUTTON_BASE} ${GROUP_BUTTON_DEFAULT} w-11 justify-center pointer-events-none select-none`}
          aria-hidden="true"
        />,
      ]
    : [];
  const navButtonSegments = navTabs.map(item => {
    const isUploadTab = item.id === "upload";
    const isTransferView = activeTab === "transfer";
    const showTransfer = isUploadTab && selectedBlobCount > 0;
    const isActive = activeTab === item.id || (isUploadTab && (isTransferView || showTransfer));
    const IconComponent = showTransfer ? TransferIcon : item.icon;
    const label = showTransfer ? "Transfer" : item.label;
    const targetTab = showTransfer ? ("transfer" as TabId) : item.id;
    const hideLabelOnMobile = isUploadTab;
    return (
      <button
        key={item.id}
        onClick={() => onSelectTab(targetTab)}
        disabled={showAuthPrompt || !settingsReady}
        aria-label={label}
        title={label}
        className={`${GROUP_BUTTON_BASE} ${isActive ? GROUP_BUTTON_ACTIVE : GROUP_BUTTON_DEFAULT} px-4 justify-center`}
      >
        <IconComponent size={16} />
        <span
          className={
            hideLabelOnMobile ? "hidden whitespace-nowrap text-sm font-medium sm:inline" : "whitespace-nowrap text-sm font-medium"
          }
        >
          {label}
        </span>
      </button>
    );
  });

  return (
    <nav className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onNavigateHome}
          disabled={showAuthPrompt || !settingsReady}
          aria-label="Home"
          className="px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
        >
          <HomeIcon size={16} />
          <span className="hidden sm:inline">Home</span>
        </button>
        {keepSearchExpanded && (
          <button
            type="button"
            onClick={onNavigateUp}
            disabled={showAuthPrompt || !settingsReady || !canNavigateUp}
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
        ) : showBreadcrumbs && browseNavigationState ? (
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
                  disabled={showAuthPrompt || !settingsReady}
                  className="max-w-[10rem] truncate rounded-lg border border-slate-800 bg-slate-900/70 px-2 py-1 text-left transition hover:border-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <span className="flex items-center gap-1">
                      <span className="truncate">{segment.label}</span>
                      {segment.visibility === "public" ? (
                        <ShareIcon size={12} className="shrink-0 text-slate-200" aria-hidden="true" />
                      ) : null}
                    </span>
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : !isCompactScreen ? (
          <span className="text-sm text-slate-500">/</span>
        ) : null}
      </div>
      <div className="flex items-center" role="group" aria-label="Workspace navigation controls">
        <div className="flex items-stretch rounded-xl border border-slate-800 bg-slate-900/70 divide-x divide-slate-800">
          <button
            type="button"
            onClick={onToggleSearch}
            disabled={showAuthPrompt || !settingsReady || keepSearchExpanded}
            aria-label="Search files"
            aria-pressed={isSearchOpen}
            className={`${GROUP_BUTTON_BASE} ${searchButtonStateClass} w-11 justify-center`}
          >
            <SearchIcon size={16} />
          </button>
          {browseControlsSegments}
          {navButtonSegments}
        </div>
      </div>
    </nav>
  );
};

export const WorkspaceToolbar = React.memo(WorkspaceToolbarComponent);
