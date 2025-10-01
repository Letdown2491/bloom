import React, { Suspense } from "react";
import type { FilterMode } from "../../types/filter";
import { BrowseContent, type BrowseContentProps } from "./BrowseContent";
import { useAudio, type AudioContextValue } from "../../context/AudioContext";
import type { BlobListProps } from "../../components/BlobList";
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
} from "../../components/icons";
import type { SortDirection } from "../../context/UserPreferencesContext";

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
  { id: "pdfs", label: "PDFs", icon: DocumentIcon },
  { id: "videos", label: "Videos", icon: VideoIcon },
];

const FILTER_OPTIONS: FilterOption[] = [...BASE_FILTER_OPTIONS].sort((a, b) =>
  a.label.localeCompare(b.label)
);


const CONTROL_BUTTON_BASE =
  "flex items-center gap-2 rounded-xl border px-2.5 py-2 text-sm transition focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60";
const CONTROL_BUTTON_DEFAULT = "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700";
const CONTROL_BUTTON_ACTIVE = "border-emerald-500 bg-emerald-500/10 text-emerald-200";
const CONTROL_BUTTON_DISABLED = "border-slate-800 bg-slate-900/70 text-slate-500";
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
}) => {
  return (
    <>
      <button
        type="button"
        onClick={() => onSelectViewMode(viewMode === "grid" ? "list" : "grid")}
        disabled={disabled}
        aria-label={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
        className={`${CONTROL_BUTTON_BASE} ${disabled ? CONTROL_BUTTON_DISABLED : CONTROL_BUTTON_DEFAULT}`}
      >
        {viewMode === "grid" ? <GridIcon size={18} /> : <ListIcon size={18} />}
      </button>

      <button
        type="button"
        onClick={onToggleSortDirection}
        disabled={disabled}
        aria-label={`Toggle sort direction (${sortDirection === "ascending" ? "ascending" : "descending"})`}
        className={`${CONTROL_BUTTON_BASE} ${disabled ? CONTROL_BUTTON_DISABLED : CONTROL_BUTTON_DEFAULT}`}
      >
        {sortDirection === "ascending" ? <DoubleChevronUpIcon size={18} /> : <DoubleChevronDownIcon size={18} />}
      </button>

      <div className="relative" ref={filterMenuRef}>
        <button
          type="button"
          onClick={onToggleFilterMenu}
          disabled={disabled}
          aria-label={filterButtonAriaLabel}
          aria-pressed={filterButtonActive}
          aria-haspopup="menu"
          aria-expanded={isFilterMenuOpen}
          title={filterButtonLabel}
          className={`${CONTROL_BUTTON_BASE} ${
            disabled ? CONTROL_BUTTON_DISABLED : filterButtonActive ? CONTROL_BUTTON_ACTIVE : CONTROL_BUTTON_DEFAULT
          }`}
        >
          <FilterIcon size={18} />
          <span className="sr-only">{filterButtonAriaLabel}</span>
        </button>
        {isFilterMenuOpen && (
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-48 rounded-xl border border-slate-800 bg-slate-950/95 p-1 shadow-lg backdrop-blur"
          >
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
                  className={`flex w-full items-center gap-2 px-2 py-2 text-left text-sm transition focus:outline-none ${
                    isActive ? "text-emerald-200" : "text-slate-100 hover:text-emerald-300"
                  }`}
                >
                  <option.icon size={16} />
                  <span>{option.label}</span>
                </a>
              );
            })}
            <div className="mt-1 border-t border-slate-800 pt-1">
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
                className={`w-full px-2 py-2 text-left text-sm transition focus:outline-none ${
                  filterMode === "all"
                    ? "cursor-default text-slate-500"
                    : "text-slate-100 hover:text-emerald-300"
                }`}
                tabIndex={filterMode === "all" ? -1 : 0}
              >
                Clear Filters
              </a>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export type BrowsePanelProps = Omit<BrowseContentProps, "renderBlobList">;

export const BrowsePanel: React.FC<BrowsePanelProps> = props => {
  const audio = useAudio();
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

  const showInlinePlayer = props.filterMode === "music" && Boolean(audio.current);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {showInlinePlayer && (
        <div className="mb-4">
          <AudioPlayerCard audio={audio} variant="inline" />
        </div>
      )}
      <BrowseContent {...props} renderBlobList={renderBlobList} />
    </div>
  );
};

type AudioPlayerCardProps = {
  audio: AudioContextValue;
  variant?: "floating" | "inline";
};

const formatTime = (value: number) => {
  const total = Math.max(0, Math.floor(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const AudioPlayerCard: React.FC<AudioPlayerCardProps> = ({ audio, variant = "floating" }) => {
  if (!audio.current) return null;

  const scrubberMax = audio.duration > 0 ? audio.duration : Math.max(audio.currentTime || 0, 1);
  const scrubberValue = Math.min(audio.currentTime || 0, scrubberMax);
  const scrubberDisabled = !audio.current || audio.duration <= 0;

  const handleScrub: React.ChangeEventHandler<HTMLInputElement> = event => {
    const next = Number(event.target.value);
    if (!Number.isFinite(next)) return;
    audio.seek(next);
  };

  const isInline = variant === "inline";
  const containerClass = isInline
    ? "w-full box-border overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 px-6 pt-4 pb-3 text-sm text-slate-200 shadow"
    : "fixed bottom-4 right-4 w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/85 px-4 py-3 text-sm text-slate-200 shadow-lg";
  const coverContainerClass = isInline
    ? "relative mx-auto aspect-square w-28 overflow-hidden rounded-lg border border-slate-800 bg-slate-900 sm:w-32 md:mx-0 md:w-36 md:flex-shrink-0 md:self-start"
    : "relative h-14 w-14 overflow-hidden rounded-lg border border-slate-800 bg-slate-900";
  const progressLabelWidth = isInline ? "w-12" : "w-10";

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

  const renderControls = (layout: "inline" | "floating") => {
    const containerClass =
      layout === "inline"
        ? "flex flex-wrap items-center justify-center gap-2"
        : "flex items-center justify-between gap-2";

    const repeatButtonClass =
      audio.repeatMode === "track"
        ? "bg-emerald-700 text-slate-100 hover:bg-emerald-600"
        : "bg-slate-800 hover:bg-slate-700 text-slate-200";

    const stopButtonClass =
      "flex h-10 w-10 items-center justify-center rounded-lg bg-red-600 text-slate-100 transition hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-300";

    return (
      <div className={containerClass}>
        <button
          type="button"
          onClick={audio.shuffleQueue}
          disabled={audio.queue.length < 2}
          className={buttonBaseClass(audio.queue.length < 2)}
          aria-label="Shuffle queue"
        >
          <ShuffleIcon size={18} />
          <span className="sr-only">Shuffle</span>
        </button>
        <button
          type="button"
          onClick={audio.previous}
          disabled={!audio.hasPrevious}
          className={buttonBaseClass(!audio.hasPrevious)}
          aria-label="Play previous track"
        >
          <PreviousIcon size={18} />
          <span className="sr-only">Previous</span>
        </button>
        <button
          type="button"
          onClick={() => audio.toggle(audio.current!, audio.queue)}
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
          className={buttonBaseClass(!audio.hasNext)}
          aria-label="Play next track"
        >
          <NextIcon size={18} />
          <span className="sr-only">Next</span>
        </button>
        <button
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
        </button>
        <button
          type="button"
          onClick={audio.stop}
          className={stopButtonClass}
          aria-label="Stop playback"
        >
          <StopIcon size={18} />
          <span className="sr-only">Stop</span>
        </button>
      </div>
    );
  };

  if (isInline) {
    const songTitle = audio.current.title || audio.current.url;
    const artistName = audio.current.artist?.trim();
    const year = audio.current?.year;
    const yearLabel =
      typeof year === "number"
        ? ` (${year})`
        : typeof year === "string" && year.trim()
          ? ` (${year.trim()})`
          : "";
    const infoLine = artistName ? `${songTitle} by ${artistName}${yearLabel}` : songTitle;

    return (
      <div className={containerClass}>
        <div className="grid gap-4 md:grid-cols-[auto,1fr] md:items-stretch">
          {audio.current.coverUrl && (
            <div className={coverContainerClass}>
              <img
                src={audio.current.coverUrl}
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
          <div className="flex min-w-0 flex-col gap-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-slate-400">Now playing</div>
              <div className="text-base font-semibold text-slate-50 truncate">{infoLine}</div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-center">
                {renderControls("inline")}
              </div>
              <div className="flex min-w-0 items-center gap-3">
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
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          {audio.current.coverUrl && (
            <div className={`${coverContainerClass} flex-shrink-0`}>
              <img
                src={audio.current.coverUrl}
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
            <div className="text-sm font-medium text-slate-100 truncate">
              {audio.current.title || audio.current.url}
            </div>
            {audio.current.artist && (
              <div className="text-xs text-slate-400 truncate">{audio.current.artist}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
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
    </div>
  );
};

export default BrowsePanel;
