import React, { memo, useEffect, useRef, useState } from "react";
import type { ChangeEventHandler, KeyboardEventHandler, MutableRefObject, ReactNode } from "react";

import { useSyncPipeline } from "../context/SyncPipelineContext";
import { useIsCompactScreen } from "../../shared/hooks/useIsCompactScreen";
import {
  ChevronRightIcon,
  ChevronLeftIcon,
  CloseIcon,
  HomeIcon,
  SearchIcon,
  TransferIcon,
} from "../../shared/ui/icons";
import type { SearchSyntaxSection } from "../../shared/types/search";
import type { TabId } from "../../shared/types/tabs";
import type { BrowseNavigationState } from "../../features/workspace/BrowseTabContainer";

export type NavigationTab = {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
};

export type MainNavigationProps = {
  showAuthPrompt: boolean;
  keepSearchExpanded: boolean;
  browseNavigationState: BrowseNavigationState | null;
  isSearchOpen: boolean;
  searchQuery: string;
  searchInputRef: MutableRefObject<HTMLInputElement | null>;
  onSearchChange: ChangeEventHandler<HTMLInputElement>;
  onSearchKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSearchClear: () => void;
  onInsertSearchToken: (token: string) => void;
  onToggleSearch: () => void;
  browseHeaderControls: ReactNode | null;
  selectedCount: number;
  tab: TabId;
  onSelectTab: (tab: TabId) => void;
  navTabs: NavigationTab[];
  onBreadcrumbHome: () => void;
  theme: "dark" | "light";
};

const SEARCH_SYNTAX_SECTIONS: SearchSyntaxSection[] = [
  {
    id: "visibility",
    title: "Visibility & Type",
    items: [
      { token: "is:public", description: "Public or unencrypted items" },
      { token: "is:private", description: "Encrypted or private items" },
      { token: "is:shared", description: "Items inside shared folders" },
      { token: "is:shared-folder", description: "Shared folders only" },
      { token: "is:shared-file", description: "Shared files only" },
      { token: "is:shared-link", description: "Items with private links" },
      { token: "is:audio", description: "Music and other audio files" },
      { token: "is:image", description: "Photos and images" },
      { token: "is:video", description: "Video files" },
      { token: "is:document", description: "Documents and text files" },
      { token: "is:pdf", description: "PDF documents" },
    ],
  },
  {
    id: "fields",
    title: "Metadata Fields",
    items: [
      { token: "artist:", description: "Match artist name" },
      { token: "album:", description: "Match album title" },
      { token: "title:", description: "Match track or file title" },
      { token: "genre:", description: "Match genre metadata" },
      { token: "year:", description: "Match release year" },
      { token: "folder:", description: "Match folder path" },
      { token: "path:", description: "Alternative folder filter" },
      { token: "server:", description: "Match server URL or name" },
      { token: "host:", description: "Match server host" },
      { token: "type:", description: "Match file extension" },
      { token: "mime:", description: "Match MIME type" },
      { token: "ext:", description: "Match extension shorthand" },
    ],
  },
  {
    id: "ranges",
    title: "Ranges & Dates",
    items: [
      { token: "size:>10mb", description: "Larger than 10 MB" },
      { token: "size:200kb...5mb", description: "Between 200 KB and 5 MB" },
      { token: "duration:<5m", description: "Shorter than 5 minutes" },
      { token: "duration:2m...10m", description: "Between 2 and 10 minutes" },
      { token: "year:>=2020", description: "Year 2020 or newer" },
      { token: "year:1990...1999", description: "Year between 1990 and 1999" },
      { token: "before:2024-01-01", description: "Uploaded before 1 Jan 2024" },
      { token: "after:2023-06", description: "Uploaded after June 2023" },
      { token: "on:2023-09-01...2023-09-30", description: "Uploaded in September 2023" },
    ],
  },
  {
    id: "advanced",
    title: "Advanced",
    items: [{ token: "not:", description: "Negate the next filter (e.g. not:is:shared)" }],
  },
];

export const MainNavigation = memo(function MainNavigation({
  showAuthPrompt,
  keepSearchExpanded,
  browseNavigationState,
  isSearchOpen,
  searchQuery,
  searchInputRef,
  onSearchChange,
  onSearchKeyDown,
  onSearchClear,
  onInsertSearchToken,
  onToggleSearch,
  browseHeaderControls,
  selectedCount,
  tab,
  onSelectTab,
  navTabs,
  onBreadcrumbHome,
  theme,
}: MainNavigationProps) {
  const assignSearchInputRef = (node: HTMLInputElement | null) => {
    searchInputRef.current = node;
  };
  const [isSyntaxOpen, setSyntaxOpen] = useState(false);
  const syntaxButtonRef = useRef<HTMLButtonElement | null>(null);
  const syntaxPopoverRef = useRef<HTMLDivElement | null>(null);
  const isCompactScreen = useIsCompactScreen();
  const hasBreadcrumbs = Boolean(browseNavigationState?.segments.length);
  const showBreadcrumbs = !isCompactScreen && hasBreadcrumbs;
  const isLightTheme = theme === "light";
  const { settingsReady } = useSyncPipeline();
  const allowSearch = !showAuthPrompt && settingsReady;

  useEffect(() => {
    if (!allowSearch) {
      setSyntaxOpen(false);
    }
  }, [allowSearch]);

  const navContainerClass = isLightTheme
    ? "flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-toolbar"
    : "flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800/60 bg-slate-950/30 px-3 py-2 shadow-toolbar backdrop-blur-sm";

  const mergeClasses = (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" ");

  const segmentBaseClass =
    "flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-sm transition focus-visible:outline-none focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-55";
  const segmentDefaultClass = isLightTheme
    ? "bg-slate-200 text-slate-600 hover:bg-slate-100"
    : "bg-slate-900/40 text-slate-300 hover:bg-slate-800/60";
  const segmentActiveClass = isLightTheme
    ? "bg-emerald-200/60 text-emerald-700 shadow-toolbar"
    : "bg-emerald-500/15 text-emerald-200 shadow-toolbar";
  const segmentDisabledClass = isLightTheme
    ? "bg-slate-100 text-slate-400"
    : "bg-transparent text-slate-500";
  const searchSegmentState = !allowSearch
    ? segmentDisabledClass
    : isSearchOpen
      ? segmentActiveClass
      : segmentDefaultClass;
  const browseControlSegments = browseHeaderControls
    ? React.Children.toArray(browseHeaderControls).filter(Boolean)
    : [];
  const navButtonSegments = navTabs.map(item => {
    const isUploadTab = item.id === "upload";
    if (isUploadTab && isCompactScreen) {
      return null;
    }
    const isTransferView = tab === "transfer";
    const showTransfer = isUploadTab && selectedCount > 0;
    const isActive = tab === item.id || (isUploadTab && (isTransferView || showTransfer));
    const IconComponent = showTransfer ? TransferIcon : item.icon;
    const label = showTransfer ? "Transfer" : item.label;
    const hideLabelOnMobile = isUploadTab;
    const nextTab: TabId = showTransfer ? "transfer" : item.id;
    return (
      <button
        key={item.id}
        onClick={() => onSelectTab(nextTab)}
        disabled={showAuthPrompt || !settingsReady}
        aria-label={label}
        title={label}
        className={mergeClasses(
          segmentBaseClass,
          "justify-center",
          isActive ? segmentActiveClass : segmentDefaultClass,
        )}
        data-segment-type="label"
      >
        <IconComponent size={16} />
        <span
          className={
            hideLabelOnMobile
              ? "hidden whitespace-nowrap text-sm font-medium sm:inline"
              : "whitespace-nowrap text-sm font-medium"
          }
        >
          {label}
        </span>
      </button>
    );
  });

  const homeButtonClass = isLightTheme
    ? "flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-emerald-400 hover:text-emerald-600 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-60"
    : "flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-60";
  const backButtonClass = isLightTheme
    ? "flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-emerald-400 hover:text-emerald-600 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-40"
    : "flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-40";
  const searchExpandedContainerClass = isLightTheme
    ? "relative flex h-10 min-w-[18rem] flex-1 items-center gap-0 overflow-visible rounded-full border border-slate-300 bg-white shadow-toolbar"
    : "relative flex h-10 min-w-[18rem] flex-1 items-center gap-0 overflow-visible rounded-full border border-slate-800 bg-slate-900/50 shadow-toolbar";
  const searchExpandedIconButtonClass = isLightTheme
    ? "flex h-10 w-10 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 focus-visible:focus-emerald-ring"
    : "flex h-10 w-10 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-800/70 focus-visible:focus-emerald-ring";
  const searchContentClass = "relative flex min-w-0 flex-1 items-center gap-2 pr-2";
  const searchHelperButtonClass = isLightTheme
    ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white font-semibold text-slate-600 transition hover:border-emerald-400 hover:text-emerald-500 focus-visible:focus-emerald-ring"
    : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-900/60 font-semibold text-slate-200 transition hover:border-emerald-400 hover:text-emerald-200 focus-visible:focus-emerald-ring";
  const searchInputClass = isLightTheme
    ? "h-10 flex-1 rounded-full border-0 bg-transparent pr-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
    : "h-10 flex-1 rounded-full border-0 bg-transparent pr-2 text-sm text-slate-100 outline-none placeholder:text-slate-400";
  const searchClearButtonClass = isLightTheme
    ? "flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 focus-visible:focus-emerald-ring"
    : "flex h-7 w-7 items-center justify-center rounded-full bg-slate-900/60 text-slate-300 transition hover:bg-slate-800 focus-visible:focus-emerald-ring";
  const popoverClass = isLightTheme
    ? "absolute left-0 top-12 z-20 w-72 rounded-2xl border border-slate-200 bg-white p-3 text-slate-600 shadow-xl"
    : "absolute left-0 top-12 z-20 w-72 rounded-2xl border border-slate-800 bg-slate-900/95 p-3 text-slate-200 shadow-xl backdrop-blur";
  const sectionTitleClass = isLightTheme
    ? "px-1 text-xs font-semibold uppercase tracking-wide text-slate-500"
    : "px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
  const itemButtonClass = isLightTheme
    ? "flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-sm text-slate-600 transition hover:bg-slate-100 focus:outline-none focus-visible:focus-emerald-ring"
    : "flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-sm text-slate-200 transition hover:bg-slate-800/70 focus:outline-none focus-visible:focus-emerald-ring";
  const tokenClass = isLightTheme
    ? "font-mono text-xs font-semibold text-slate-700"
    : "font-mono text-xs font-semibold text-slate-200";
  const descriptionClass = isLightTheme ? "text-xs text-slate-500" : "text-xs text-slate-400";

  useEffect(() => {
    if (!isSearchOpen) {
      setSyntaxOpen(false);
    }
  }, [isSearchOpen]);

  useEffect(() => {
    if (!isSyntaxOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (syntaxPopoverRef.current?.contains(target) || syntaxButtonRef.current?.contains(target)) {
        return;
      }
      setSyntaxOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSyntaxOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSyntaxOpen]);

  const handleInsertToken = (token: string) => {
    onInsertSearchToken(token);
    setSyntaxOpen(false);
  };

  const handleSearchKeyDownInternal = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === "Escape" || event.key === "Esc") && isSyntaxOpen) {
      event.preventDefault();
      event.stopPropagation();
      setSyntaxOpen(false);
      return;
    }
    if (
      (event.key === "/" || event.code === "Slash") &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      setSyntaxOpen(prev => !prev);
      return;
    }
    onSearchKeyDown(event);
  };

  return (
    <nav className={navContainerClass}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBreadcrumbHome}
          disabled={showAuthPrompt || !settingsReady}
          aria-label="Home"
          className={homeButtonClass}
        >
          <HomeIcon size={16} />
          <span className="hidden sm:inline">Home</span>
        </button>
        {keepSearchExpanded && (
          <button
            type="button"
            onClick={() => browseNavigationState?.onNavigateUp?.()}
            disabled={showAuthPrompt || !settingsReady || !browseNavigationState?.canNavigateUp}
            className={backButtonClass}
            aria-label="Go back"
          >
            <ChevronLeftIcon size={16} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {allowSearch && isSearchOpen ? (
          <div className={searchExpandedContainerClass}>
            <button
              type="button"
              onClick={onToggleSearch}
              className={searchExpandedIconButtonClass}
              aria-label="Close search"
            >
              <SearchIcon size={16} />
            </button>
            <div className={searchContentClass}>
              <button
                type="button"
                ref={syntaxButtonRef}
                onClick={() => setSyntaxOpen(prev => !prev)}
                className={searchHelperButtonClass}
                aria-label="Show search syntax"
                aria-haspopup="dialog"
                aria-expanded={isSyntaxOpen}
              >
                ?
              </button>
              <input
                ref={assignSearchInputRef}
                type="text"
                value={searchQuery}
                onChange={onSearchChange}
                onKeyDown={handleSearchKeyDownInternal}
                placeholder="Search files"
                className={searchInputClass}
                aria-label="Search files"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={onSearchClear}
                  className={searchClearButtonClass}
                  aria-label="Clear search"
                >
                  <CloseIcon size={16} />
                </button>
              ) : null}
            </div>
            {isSyntaxOpen ? (
              <div
                ref={syntaxPopoverRef}
                className={popoverClass}
                role="dialog"
                aria-label="Search syntax help"
              >
                {SEARCH_SYNTAX_SECTIONS.map(section => (
                  <div key={section.id} className="mt-3 first:mt-0">
                    <div className={sectionTitleClass}>{section.title}</div>
                    <div className="mt-1 space-y-1">
                      {section.items.map(item => (
                        <button
                          key={item.token}
                          type="button"
                          onClick={() => handleInsertToken(item.token)}
                          className={itemButtonClass}
                        >
                          <span className={tokenClass}>{item.token}</span>
                          <span className={descriptionClass}>{item.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : showBreadcrumbs && browseNavigationState ? (
          <div
            className={
              isLightTheme
                ? "flex flex-wrap items-center gap-1 rounded-xl border border-transparent bg-slate-100/60 px-3 py-2 text-sm font-medium text-slate-600"
                : "flex flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm font-medium text-slate-200"
            }
            title={`/${browseNavigationState.segments.map(segment => segment.label).join("/")}`}
          >
            {browseNavigationState.segments.map((segment, index) => (
              <React.Fragment key={segment.id}>
                {index > 0 && <ChevronRightIcon size={14} className="text-slate-500" />}
                <button
                  type="button"
                  onClick={segment.onNavigate}
                  disabled={showAuthPrompt || !settingsReady}
                  className={
                    isLightTheme
                      ? "rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 transition hover:text-emerald-600 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-50"
                      : "rounded-lg px-2 py-1 text-xs font-semibold text-slate-200 transition hover:text-emerald-200 focus-visible:focus-emerald-ring disabled:cursor-not-allowed disabled:opacity-50"
                  }
                >
                  {segment.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : !isCompactScreen ? (
          <span className="text-sm text-slate-500">/</span>
        ) : null}
      </div>
      <div
        className={mergeClasses(
          "flex items-center gap-2",
          allowSearch && isSearchOpen ? "ml-auto" : "",
        )}
        role="group"
        aria-label="Main navigation controls"
      >
        {allowSearch ? (
          isSearchOpen ? (
            <div className="flex items-center gap-2">
              {browseControlSegments.map(segment => {
                if (!React.isValidElement(segment)) return null;
                const segmentType =
                  segment.props["data-segment-type"] ||
                  (segment.type === "button" ? "icon" : undefined);
                const baseClass = mergeClasses(
                  segmentBaseClass,
                  segmentType === "label" ? "" : "w-10 justify-center px-0",
                );
                return React.cloneElement(segment, {
                  className: mergeClasses(
                    baseClass,
                    segmentDefaultClass,
                    segment.props.className || "",
                  ),
                  "data-segment-type": segmentType,
                });
              })}
              {navButtonSegments}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggleSearch}
                disabled={showAuthPrompt || !settingsReady}
                aria-label="Search files"
                aria-pressed={isSearchOpen}
                className={mergeClasses(
                  segmentBaseClass,
                  "w-10 justify-center px-0",
                  searchSegmentState,
                )}
                data-segment-type="icon"
              >
                <SearchIcon size={16} />
              </button>
              {browseControlSegments.map(segment => {
                if (!React.isValidElement(segment)) return null;
                const segmentType =
                  segment.props["data-segment-type"] ||
                  (segment.type === "button" ? "icon" : undefined);
                const baseClass = mergeClasses(
                  segmentBaseClass,
                  segmentType === "label" ? "" : "w-10 justify-center px-0",
                );
                return React.cloneElement(segment, {
                  className: mergeClasses(
                    baseClass,
                    segmentDefaultClass,
                    segment.props.className || "",
                  ),
                  "data-segment-type": segmentType,
                });
              })}
              {navButtonSegments}
            </div>
          )
        ) : (
          <div className="flex items-center gap-2">
            {browseControlSegments.map(segment => {
              if (!React.isValidElement(segment)) return null;
              const segmentType =
                segment.props["data-segment-type"] ||
                (segment.type === "button" ? "icon" : undefined);
              const baseClass = mergeClasses(
                segmentBaseClass,
                segmentType === "label" ? "" : "w-10 justify-center px-0",
              );
              return React.cloneElement(segment, {
                className: mergeClasses(
                  baseClass,
                  segmentDefaultClass,
                  segment.props.className || "",
                ),
                "data-segment-type": segmentType,
              });
            })}
            {navButtonSegments}
          </div>
        )}
      </div>
    </nav>
  );
});

MainNavigation.displayName = "MainNavigation";
