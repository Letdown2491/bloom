import React, { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FilterMode } from "../../shared/types/filter";
import { BrowseContent, type BrowseContentProps } from "./BrowseContent";
import type { AudioContextValue } from "../../app/context/AudioContext";
import type { BlobListProps } from "./ui/BlobList";
import {
  GridIcon,
  ListIcon,
  DoubleChevronUpIcon,
  DoubleChevronDownIcon,
  FilterIcon,
  MusicIcon,
  DocumentIcon,
  ImageIcon,
  VideoIcon,
  PreviousIcon,
  PlayIcon,
  PauseIcon,
  NextIcon,
  ShuffleIcon,
  RepeatIcon,
  RepeatOneIcon,
  StopIcon,
} from "../../shared/ui/icons";
import type { SortDirection } from "../../app/context/UserPreferencesContext";

const BlobListPanelLazy = React.lazy(() =>
  import("./BlobListPanel").then(module => ({ default: module.BlobListPanel }))
);

type FilterOption = {
  id: Exclude<FilterMode, "all">;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
};

const BASE_FILTER_OPTIONS: FilterOption[] = [
  { id: "documents", label: "Documents", icon: DocumentIcon },
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "music", label: "Audio", icon: MusicIcon },
  { id: "videos", label: "Videos", icon: VideoIcon },
];

const FILTER_OPTIONS: FilterOption[] = [...BASE_FILTER_OPTIONS].sort((a, b) =>
  a.label.localeCompare(b.label)
);

const MARQUEE_GAP_PX = 48;

let marqueeStylesInjected = false;
const ensureMarqueeStyles = () => {
  if (marqueeStylesInjected || typeof document === "undefined") return;
  const style = document.createElement("style");
  style.textContent = `
@keyframes bloom-marquee {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(calc(-1 * var(--bloom-marquee-distance, 0px)));
  }
}
`;
  document.head.appendChild(style);
  marqueeStylesInjected = true;
};

type ScrollingTextProps = {
  children: React.ReactNode;
  className?: string;
};

const ScrollingText: React.FC<ScrollingTextProps> = ({ children, className = "" }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [state, setState] = useState<{ scroll: boolean; width: number }>({ scroll: false, width: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const update = () => {
      const overflow = content.scrollWidth > container.clientWidth + 1;
      const width = overflow ? content.scrollWidth : 0;
      setState(prev => {
        if (prev.scroll === overflow && (!overflow || prev.width === width)) {
          return prev;
        }
        return { scroll: overflow, width };
      });
    };

    update();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(container);
      observer.observe(content);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [children]);

  useEffect(() => {
    if (state.scroll) {
      ensureMarqueeStyles();
    }
  }, [state.scroll]);

  const animationDuration = state.scroll ? Math.max(12, state.width / 40) : 0;
  const animationStyle = state.scroll
    ? ({
        animation: `bloom-marquee ${animationDuration}s linear infinite`,
        ["--bloom-marquee-distance" as any]: `${state.width + MARQUEE_GAP_PX}px`,
      } as React.CSSProperties)
    : undefined;

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
      <div className="flex w-max items-center" style={animationStyle}>
        <span ref={contentRef} className="inline-block min-w-0 whitespace-nowrap">
          {children}
        </span>
        {state.scroll && (
          <span
            aria-hidden="true"
            className="inline-block min-w-0 whitespace-nowrap"
            style={{ marginLeft: `${MARQUEE_GAP_PX}px` }}
          >
            {children}
          </span>
        )}
      </div>
    </div>
  );
};


const CONTROL_BUTTON_BASE =
  "flex h-10 items-center gap-2 rounded-xl border px-2.5 py-2 text-sm transition focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60";
type BrowseControlsProps = {
  viewMode: "grid" | "list";
  disabled: boolean;
  onSelectViewMode: (mode: "grid" | "list") => void;
  sortDirection: SortDirection;
  onToggleSortDirection: () => void;
  filterButtonLabel: string;
  filterButtonAriaLabel: string;
  filterButtonActive: boolean;
  isFilterMenuOpen: boolean;
  onToggleFilterMenu: () => void;
  onSelectFilter: (mode: FilterMode) => void;
  filterMode: FilterMode;
  filterMenuRef: React.RefObject<HTMLDivElement>;
  theme: "dark" | "light";
  showViewToggle: boolean;
  showSortToggle: boolean;
  showFilterButton: boolean;
  variant?: "default" | "grouped";
};

export const BrowseControls: React.FC<BrowseControlsProps> = ({
  viewMode,
  disabled,
  onSelectViewMode,
  sortDirection,
  onToggleSortDirection,
  filterButtonLabel,
  filterButtonAriaLabel,
  filterButtonActive,
  isFilterMenuOpen,
  onToggleFilterMenu,
  onSelectFilter,
  filterMode,
  filterMenuRef,
  theme,
  showViewToggle,
  showSortToggle,
  showFilterButton = true,
  variant = "default",
}) => {
  const isLightTheme = theme === "light";
  const menuContainerClass = isLightTheme
    ? "absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-slate-300 bg-white p-1 text-slate-700 shadow-lg"
    : "absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-slate-800 bg-slate-950/95 p-1 text-slate-100 shadow-lg backdrop-blur";
  const menuItemClass = (isActive: boolean) =>
    isLightTheme
      ? `flex w-full items-center gap-2 px-2 py-2 text-left text-sm transition focus:outline-none ${
          isActive ? "text-emerald-600" : "text-slate-700 hover:text-emerald-600"
        }`
      : `flex w-full items-center gap-2 px-2 py-2 text-left text-sm transition focus:outline-none ${
          isActive ? "text-emerald-200" : "text-slate-100 hover:text-emerald-300"
        }`;
  const menuDividerClass = isLightTheme ? "mt-1 border-t border-slate-200 pt-1" : "mt-1 border-t border-slate-800 pt-1";
  const clearFiltersClass =
    filterMode === "all"
      ? isLightTheme
        ? "w-full px-2 py-2 text-left text-sm transition focus:outline-none cursor-default text-slate-400"
        : "w-full px-2 py-2 text-left text-sm transition focus:outline-none cursor-default text-slate-500"
      : isLightTheme
        ? "w-full px-2 py-2 text-left text-sm transition focus:outline-none text-slate-700 hover:text-emerald-600"
        : "w-full px-2 py-2 text-left text-sm transition focus:outline-none text-slate-100 hover:text-emerald-300";
  const buttonDefaultClass = isLightTheme
    ? "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
    : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700";
  const buttonActiveClass = isLightTheme
    ? "border-emerald-300 bg-emerald-100 text-emerald-700"
    : "border-emerald-500 bg-emerald-500/10 text-emerald-200";
  const buttonDisabledClass = isLightTheme
    ? "border-slate-200 bg-slate-100 text-slate-400"
    : "border-slate-800 bg-slate-900/70 text-slate-500";
  const isGrouped = variant === "grouped";

  if (isGrouped) {
    const groupedButtonBase =
      "flex h-10 shrink-0 items-center gap-2 px-0 text-sm transition focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60";
    const groupedDefault = isLightTheme
      ? "bg-slate-200 text-slate-600 hover:bg-slate-100"
      : "bg-slate-900/70 text-slate-300 hover:bg-slate-900/80";
    const groupedActive = isLightTheme
      ? "bg-emerald-200/60 text-emerald-700 hover:bg-emerald-200/80"
      : "bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20";
    const groupedDisabled = isLightTheme
      ? "bg-slate-100 text-slate-400"
      : "bg-slate-900/70 text-slate-500";

    const buttonClass = (
      state: "default" | "active" | "disabled",
      kind: "icon" | "default" = "default"
    ) => {
      const extras = kind === "icon" ? " w-11 justify-center" : " px-4";
      if (state === "active") return `${groupedButtonBase}${extras} ${groupedActive}`;
      if (state === "disabled") return `${groupedButtonBase}${extras} ${groupedDisabled}`;
      return `${groupedButtonBase}${extras} ${groupedDefault}`;
    };

    const groupedControls: React.ReactNode[] = [];

    if (showViewToggle) {
      groupedControls.push(
        <button
          key="view-toggle"
          type="button"
          onClick={() => onSelectViewMode(viewMode === "grid" ? "list" : "grid")}
          disabled={disabled}
          aria-label={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
          className={buttonClass(disabled ? "disabled" : "default", "icon")}
          data-segment-type="icon"
        >
          {viewMode === "grid" ? <GridIcon size={18} /> : <ListIcon size={18} />}
        </button>
      );
    }

    if (showSortToggle) {
      groupedControls.push(
        <button
          key="sort-toggle"
          type="button"
          onClick={onToggleSortDirection}
          disabled={disabled}
          aria-label={`Toggle sort direction (${sortDirection === "ascending" ? "ascending" : "descending"})`}
          className={buttonClass(disabled ? "disabled" : "default", "icon")}
          data-segment-type="icon"
        >
          {sortDirection === "ascending" ? <DoubleChevronUpIcon size={18} /> : <DoubleChevronDownIcon size={18} />}
        </button>
      );
    }

    if (showFilterButton) {
      groupedControls.push(
        <div key="filter-menu" className="relative flex items-center" ref={filterMenuRef} data-segment-type="menu-container">
          <button
            type="button"
            onClick={onToggleFilterMenu}
            disabled={disabled}
            aria-label={filterButtonAriaLabel}
            aria-pressed={filterButtonActive}
            aria-haspopup="menu"
            aria-expanded={isFilterMenuOpen}
            title={filterButtonLabel}
            className={buttonClass(disabled ? "disabled" : filterButtonActive ? "active" : "default", "icon")}
          >
            <FilterIcon size={18} />
            <span className="sr-only">{filterButtonAriaLabel}</span>
          </button>
          {isFilterMenuOpen && (
            <div role="menu" className={menuContainerClass}>
              {FILTER_OPTIONS.map(option => {
                const isActive = filterMode === option.id;
                return (
                  <a
                    key={option.id}
                    href="#"
                    onClick={event => {
                      event.preventDefault();
                      onSelectFilter(option.id);
                    }}
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={menuItemClass(isActive)}
                  >
                    <option.icon size={16} />
                    <span>{option.label}</span>
                  </a>
                );
              })}
              <div className={menuDividerClass}>
                <a
                  href="#"
                  onClick={event => {
                    event.preventDefault();
                    if (filterMode !== "all") {
                      onSelectFilter("all");
                    }
                  }}
                  role="menuitem"
                  aria-disabled={filterMode === "all"}
                  className={clearFiltersClass}
                  tabIndex={filterMode === "all" ? -1 : 0}
                >
                  Clear Filters
                </a>
              </div>
            </div>
          )}
        </div>
      );
    }

    return <>{groupedControls}</>;
  }

  const controls: React.ReactNode[] = [];
  const buttonBaseClass = CONTROL_BUTTON_BASE;

  if (showViewToggle) {
    controls.push(
      <button
        key="view-toggle"
        type="button"
        onClick={() => onSelectViewMode(viewMode === "grid" ? "list" : "grid")}
        disabled={disabled}
        aria-label={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
        className={`${buttonBaseClass} ${disabled ? buttonDisabledClass : buttonDefaultClass}`}
      >
        {viewMode === "grid" ? <GridIcon size={18} /> : <ListIcon size={18} />}
      </button>
    );
  }

  if (showSortToggle) {
    controls.push(
      <button
        key="sort-toggle"
        type="button"
        onClick={onToggleSortDirection}
        disabled={disabled}
        aria-label={`Toggle sort direction (${sortDirection === "ascending" ? "ascending" : "descending"})`}
        className={`${buttonBaseClass} ${disabled ? buttonDisabledClass : buttonDefaultClass}`}
      >
        {sortDirection === "ascending" ? <DoubleChevronUpIcon size={18} /> : <DoubleChevronDownIcon size={18} />}
      </button>
    );
  }

  if (showFilterButton) {
    controls.push(
      <div key="filter-menu" className="relative" ref={filterMenuRef}>
        <button
          type="button"
          onClick={onToggleFilterMenu}
          disabled={disabled}
          aria-label={filterButtonAriaLabel}
          aria-pressed={filterButtonActive}
          aria-haspopup="menu"
          aria-expanded={isFilterMenuOpen}
          title={filterButtonLabel}
          className={`${buttonBaseClass} ${
            disabled ? buttonDisabledClass : filterButtonActive ? buttonActiveClass : buttonDefaultClass
          }`}
        >
          <FilterIcon size={18} />
          <span className="sr-only">{filterButtonAriaLabel}</span>
        </button>
        {isFilterMenuOpen && (
          <div role="menu" className={menuContainerClass}>
            {FILTER_OPTIONS.map(option => {
              const isActive = filterMode === option.id;
              return (
                <a
                  key={option.id}
                  href="#"
                  onClick={event => {
                    event.preventDefault();
                    onSelectFilter(option.id);
                  }}
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={menuItemClass(isActive)}
                >
                  <option.icon size={16} />
                  <span>{option.label}</span>
                </a>
              );
            })}
            <div className={menuDividerClass}>
              <a
                href="#"
                onClick={event => {
                  event.preventDefault();
                  if (filterMode !== "all") {
                    onSelectFilter("all");
                  }
                }}
                role="menuitem"
                aria-disabled={filterMode === "all"}
                className={clearFiltersClass}
                tabIndex={filterMode === "all" ? -1 : 0}
              >
                Clear Filters
              </a>
            </div>
          </div>
        )}
      </div>
    );
  }

  return <div className="flex items-center gap-3">{controls}</div>;
};

export type BrowsePanelProps = Omit<BrowseContentProps, "renderBlobList">;

export const BrowsePanel: React.FC<BrowsePanelProps> = props => {
  const renderBlobList = (blobListProps: BlobListProps) => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          Loading files…
        </div>
      }
    >
      <BlobListPanelLazy {...blobListProps} />
    </Suspense>
  );

  return <BrowseContent {...props} renderBlobList={renderBlobList} />;
};

type AudioPlayerCardProps = {
  audio: AudioContextValue;
  variant?: "floating" | "docked";
};

const formatTime = (value: number) => {
  const total = Math.max(0, Math.floor(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const AudioPlayerCard: React.FC<AudioPlayerCardProps> = ({ audio, variant = "floating" }) => {
  const currentTrack = audio.current;
  if (!currentTrack) return null;

  const scrubberMax = audio.duration > 0 ? audio.duration : Math.max(audio.currentTime || 0, 1);
  const scrubberValue = Math.min(audio.currentTime || 0, scrubberMax);
  const scrubberDisabled = audio.duration <= 0;

  const handleScrub: React.ChangeEventHandler<HTMLInputElement> = event => {
    const next = Number(event.target.value);
    if (!Number.isFinite(next)) return;
    audio.seek(next);
  };

  const isDocked = variant === "docked";
  const coverContainerClass = "relative h-14 w-14 overflow-hidden rounded-lg border border-slate-800 bg-slate-900";
  const progressLabelWidth = isDocked ? "w-12" : "w-10";

  const buttonBaseClass = (disabled: boolean) =>
    `flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 rounded-lg h-10 w-10 ${
      disabled
        ? "bg-slate-800/50 text-slate-500 cursor-not-allowed"
        : "bg-slate-800 hover:bg-slate-700 text-slate-200"
    }`;

  const playButtonClass =
    `flex items-center justify-center transition focus:outline-none focus:ring-2 focus:ring-emerald-400 rounded-full h-12 w-12 ${
      audio.status === "playing"
        ? "bg-emerald-500 text-slate-900 hover:bg-emerald-400"
        : "bg-slate-100 text-slate-900 hover:bg-slate-200"
    }`;

  const renderControls = (layout: "floating" | "docked", options?: { bare?: boolean }) => {
    const containerClass =
      layout === "floating"
        ? "flex items-center justify-center gap-2"
        : "flex flex-wrap items-center justify-center gap-2 md:justify-end";

    const repeatButtonClass =
      audio.repeatMode === "track"
        ? "bg-emerald-700 text-slate-100 hover:bg-emerald-600"
        : "bg-slate-800 hover:bg-slate-700 text-slate-200";

    const controls: React.ReactNode[] = [
      <button
        key="shuffle"
        type="button"
        onClick={audio.shuffleQueue}
        disabled={audio.queue.length < 2}
        className={buttonBaseClass(audio.queue.length < 2)}
        aria-label="Shuffle queue"
      >
        <ShuffleIcon size={18} />
        <span className="sr-only">Shuffle</span>
      </button>,
      <button
        key="previous"
        type="button"
        onClick={audio.previous}
        disabled={!audio.hasPrevious}
        className={buttonBaseClass(!audio.hasPrevious)}
        aria-label="Play previous track"
      >
        <PreviousIcon size={18} />
        <span className="sr-only">Previous</span>
      </button>,
      <button
        key="toggle"
        type="button"
          onClick={() => audio.toggle(currentTrack, audio.queue)}
        className={playButtonClass}
        aria-label={audio.status === "playing" ? "Pause track" : "Play track"}
      >
        {audio.status === "playing" ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
        <span className="sr-only">{audio.status === "playing" ? "Pause" : "Play"}</span>
      </button>,
      <button
        key="next"
        type="button"
        onClick={audio.next}
        disabled={!audio.hasNext}
        className={buttonBaseClass(!audio.hasNext)}
        aria-label="Play next track"
      >
        <NextIcon size={18} />
        <span className="sr-only">Next</span>
      </button>,
      <button
        key="repeat"
        type="button"
        onClick={audio.toggleRepeatMode}
        aria-label="Toggle repeat mode"
        aria-pressed={audio.repeatMode === "track"}
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${repeatButtonClass}`}
      >
        {audio.repeatMode === "track" ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
        <span className="sr-only">
          {audio.repeatMode === "track" ? "Repeat current track" : "Repeat entire queue"}
        </span>
      </button>,
    ];

    if (options?.bare) {
      return controls;
    }

    return <div className={containerClass}>{controls}</div>;
  };

  const songTitle = currentTrack.title || currentTrack.url;
  const artistName = currentTrack.artist?.trim();
  const year = currentTrack?.year;
  const yearLabel =
    typeof year === "number"
      ? ` (${year})`
      : typeof year === "string" && year.trim()
        ? ` (${year.trim()})`
        : "";
  const renderFloatingCard = () => (
    <div className="surface-floating pointer-events-auto relative w-full max-w-sm rounded-2xl border border-slate-800/70 px-4 py-3 text-xs text-slate-200 shadow-floating">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start gap-3">
          {currentTrack.coverUrl && (
            <div className={`${coverContainerClass} flex-shrink-0`}>
              <img
                src={currentTrack.coverUrl}
                alt="Album art"
                className="h-full w-full object-cover"
                loading="lazy"
                draggable={false}
                onError={event => {
                  event.currentTarget.style.display = "none";
                }}
              />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Now playing</div>
            <ScrollingText className="min-w-0 text-sm font-medium text-slate-100">
              {songTitle}
            </ScrollingText>
            {artistName && (
              <ScrollingText className="min-w-0 text-xs text-slate-400">
                {artistName}
                {yearLabel}
              </ScrollingText>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className={`text-xs tabular-nums text-slate-400 ${progressLabelWidth}`}>
            {formatTime(audio.currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={scrubberMax}
            step={0.1}
            value={scrubberValue}
            onChange={handleScrub}
            disabled={scrubberDisabled}
            aria-label="Seek through current track"
            aria-valuetext={formatTime(scrubberValue)}
            className="flex-1 h-1.5 cursor-pointer appearance-none rounded-full bg-slate-800 accent-emerald-500"
          />
          <span className={`text-xs tabular-nums text-slate-400 text-right ${progressLabelWidth}`}>
            {audio.duration > 0 ? formatTime(audio.duration) : "--:--"}
          </span>
        </div>
        {renderControls("floating")}
      </div>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={audio.stop}
          aria-label="Stop playback"
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600 text-slate-100 transition hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-300"
        >
          <StopIcon size={18} />
          <span className="sr-only">Stop</span>
        </button>
      </div>
    </div>
  );

  if (isDocked) {
    return (
      <div className="surface-floating border-t border-slate-800/60 px-4 py-3 text-sm text-slate-200 shadow-floating">
        <div className="flex flex-col gap-3.5 md:gap-4">
          <div className="flex items-center justify-between gap-2.5 md:hidden">
            <div className="flex min-w-0 items-center gap-3">
              {currentTrack.coverUrl && (
                <div className="flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                  <img
                    src={currentTrack.coverUrl}
                    alt="Album art"
                    className="h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                    onError={event => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                </div>
              )}
              <div className="min-w-0 text-left">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Now playing</div>
                <ScrollingText className="min-w-0 text-sm font-semibold text-slate-100">
                  {songTitle}
                </ScrollingText>
                {artistName && (
                  <ScrollingText className="min-w-0 text-xs text-slate-400">
                    {artistName}
                    {yearLabel}
                  </ScrollingText>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => audio.toggle(currentTrack, audio.queue)}
                className={playButtonClass}
                aria-label={audio.status === "playing" ? "Pause track" : "Play track"}
              >
                {audio.status === "playing" ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
                <span className="sr-only">{audio.status === "playing" ? "Pause" : "Play"}</span>
              </button>
              <button
                type="button"
                onClick={audio.next}
                disabled={!audio.hasNext}
                className={`flex items-center justify-center rounded-lg transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                  !audio.hasNext
                    ? "h-9 w-9 bg-slate-800/50 text-slate-500 cursor-not-allowed"
                    : "h-9 w-9 bg-slate-800 text-slate-200 hover:bg-slate-700"
                }`}
                aria-label="Play next track"
              >
                <NextIcon size={18} />
                <span className="sr-only">Next</span>
              </button>
              <button
                type="button"
                onClick={audio.stop}
                aria-label="Stop playback"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-600 text-slate-100 transition hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-300"
              >
                <StopIcon size={18} />
                <span className="sr-only">Stop</span>
              </button>
            </div>
          </div>

          <div className="hidden items-center gap-5 md:flex">
            <div className="flex min-w-0 items-center gap-3">
              {currentTrack.coverUrl && (
                <div className="flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                  <img
                    src={currentTrack.coverUrl}
                    alt="Album art"
                    className="h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                    onError={event => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                </div>
              )}
              <div className="min-w-0 text-left">
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Now playing</div>
                <ScrollingText className="min-w-0 text-sm font-semibold text-slate-100">
                  {songTitle}
                </ScrollingText>
                {artistName && (
                  <ScrollingText className="min-w-0 text-xs text-slate-400">
                    {artistName}
                    {yearLabel}
                  </ScrollingText>
                )}
              </div>
            </div>
            <div className="flex flex-1 items-center gap-3.5">
              <span className="w-14 text-xs tabular-nums text-slate-400">{formatTime(audio.currentTime)}</span>
              <input
                type="range"
                min={0}
                max={scrubberMax}
                step={0.1}
                value={scrubberValue}
                onChange={handleScrub}
                disabled={scrubberDisabled}
                aria-label="Seek through current track"
                aria-valuetext={formatTime(scrubberValue)}
                className="flex-1 h-1.5 min-w-[340px] cursor-pointer appearance-none rounded-full bg-slate-800 accent-emerald-500"
              />
              <span className="w-14 text-right text-xs tabular-nums text-slate-400">
                {audio.duration > 0 ? formatTime(audio.duration) : "--:--"}
              </span>
            </div>
            <div className="flex items-center justify-end gap-1.5">
              {renderControls("docked", { bare: true })}
              <button
                type="button"
                onClick={audio.stop}
                aria-label="Stop playback"
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600 text-slate-100 transition hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-300"
              >
                <StopIcon size={18} />
                <span className="sr-only">Stop</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const floatingContent = (
    <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 z-40 pointer-events-none">
      {renderFloatingCard()}
    </div>
  );

  if (typeof document !== "undefined") {
    return createPortal(floatingContent, document.body);
  }

  return floatingContent;
};

export default BrowsePanel;
