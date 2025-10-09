import React from "react";
import type { FilterMode } from "../../types/filter";
import type { ManagedServer } from "../../hooks/useServers";
import type { DefaultSortOption } from "../../context/UserPreferencesContext";
import type { StatusMessageTone } from "../../types/status";
import { WorkspaceProvider } from "../workspace/WorkspaceContext";
import {
  GridIcon,
  ListIcon,
  FilterIcon,
  DocumentIcon,
  ImageIcon,
  MusicIcon,
  VideoIcon,
  RefreshIcon,
  SyncIndicatorIcon,
  ServersIcon,
  DownloadIcon,
  SearchIcon,
  SettingsIcon,
  RelayIcon,
  GithubIcon,
  LightningIcon,
} from "../../components/icons";
import { ServerList } from "../../components/ServerList";
const RelayListLazy = React.lazy(() => import("../../components/RelayList"));

type FilterOption = {
  id: FilterMode;
  label: string;
  Icon: typeof FilterIcon;
};

type SegmentedOption = {
  id: string;
  label: string;
  Icon?: typeof GridIcon;
};

type StatusTone = "info" | "warning" | "muted";

const FILTER_OPTIONS: FilterOption[] = [
  { id: "all", label: "All Files", Icon: FilterIcon },
  { id: "music", label: "Audio", Icon: MusicIcon },
  { id: "documents", label: "Documents", Icon: DocumentIcon },
  { id: "images", label: "Images", Icon: ImageIcon },
  { id: "videos", label: "Videos", Icon: VideoIcon },
];

const SORT_OPTIONS: { id: DefaultSortOption; label: string; Icon: typeof GridIcon }[] = [
  { id: "name", label: "Name", Icon: DocumentIcon },
  { id: "servers", label: "Servers", Icon: ServersIcon },
  { id: "updated", label: "Updated", Icon: RefreshIcon },
  { id: "size", label: "Size", Icon: DownloadIcon },
];

const VIEW_MODE_OPTIONS: SegmentedOption[] = [
  { id: "grid", label: "Grid view", Icon: GridIcon },
  { id: "list", label: "List view", Icon: ListIcon },
];

const TONE_CLASS_BY_KEY: Record<StatusTone, string> = {
  info: "text-emerald-300",
  warning: "text-amber-300",
  muted: "text-slate-400",
};

const formatRelativeTime = (timestampMs: number): string => {
  const now = Date.now();
  const diff = timestampMs - now;
  const divisions: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: "minute" },
    { amount: 60, unit: "hour" },
    { amount: 24, unit: "day" },
    { amount: 7, unit: "week" },
    { amount: 4.34524, unit: "month" },
    { amount: 12, unit: "year" },
  ];

  let duration = diff / 1000;
  let unit: Intl.RelativeTimeFormatUnit = "second";

  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      unit = division.unit;
      break;
    }
    duration /= division.amount;
    unit = division.unit;
  }

  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    return rtf.format(Math.round(duration), unit);
  } catch {
    return new Date(timestampMs).toLocaleString();
  }
};

type SwitchControlProps = {
  id?: string;
  checked: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
  labelledBy?: string;
  label?: string;
};

const SwitchControl: React.FC<SwitchControlProps> = ({ id, checked, onToggle, disabled, labelledBy, label }) => {
  const trackClass = disabled
    ? "cursor-not-allowed border-slate-600 bg-slate-700/70 opacity-60"
    : checked
    ? "border-emerald-500/80 bg-emerald-400/90"
    : "border-slate-500/80 bg-slate-600/70";

  const knobPosition = checked ? "right-1" : "left-1";
  const knobColor = checked ? "border-emerald-500 text-emerald-500" : "border-slate-500 text-slate-500";

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={`relative inline-flex h-8 w-16 flex-shrink-0 items-center rounded-full border transition duration-300 ease-out ${trackClass}`}
      onClick={() => {
        if (disabled) return;
        onToggle(!checked);
      }}
    >
      {!labelledBy && label ? <span className="sr-only">{label}</span> : null}
      <span
        className={`pointer-events-none absolute top-1 bottom-1 flex aspect-square items-center justify-center rounded-full border-2 bg-white text-base transition-all duration-300 ease-out ${
          knobPosition
        } ${knobColor}`}
      >
        {checked ? "✓" : "✕"}
      </span>
    </button>
  );
};

type SettingCardProps = {
  headingId: string;
  descriptionId?: string;
  title: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
};

const SettingCard: React.FC<SettingCardProps> = ({ headingId, descriptionId, title, description, className, children }) => (
  <section
    aria-labelledby={headingId}
    aria-describedby={description ? descriptionId : undefined}
    className={`rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-sm ${className ?? ""}`}
  >
    <div className="space-y-1">
      <h3 id={headingId} className="text-sm font-semibold text-slate-100">
        {title}
      </h3>
      {description ? (
        <p id={descriptionId} className="text-xs text-slate-400">
          {description}
        </p>
      ) : null}
    </div>
    <div className="mt-4 text-sm text-slate-200">{children}</div>
  </section>
);

type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  labelledBy: string;
  describedBy?: string;
  className?: string;
};

const SegmentedControl: React.FC<SegmentedControlProps> = ({ options, value, onChange, labelledBy, describedBy, className }) => (
  <div
    role="radiogroup"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    className={className ?? "grid gap-2 sm:grid-cols-2"}
  >
    {options.map(option => {
      const isActive = value === option.id;
      return (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={isActive}
          tabIndex={isActive ? 0 : -1}
          onClick={() => onChange(option.id)}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
            isActive ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-slate-500/60 text-slate-200 hover:border-slate-400"
          }`}
        >
          {option.Icon ? <option.Icon size={16} /> : null}
          <span>{option.label}</span>
        </button>
      );
    })}
  </div>
);

type SettingsPanelProps = {
  servers: ManagedServer[];
  defaultServerUrl: string | null;
  selectedServerUrl: string | null;
  defaultViewMode: "grid" | "list";
  defaultFilterMode: FilterMode;
  defaultSortOption: DefaultSortOption;
  showIconsPreviews: boolean;
  showListPreviews: boolean;
  keepSearchExpanded: boolean;
  theme: "dark" | "light";
  syncEnabled: boolean;
  syncLoading: boolean;
  syncError: string | null;
  syncPending: boolean;
  lastSyncedAt: number | null;
  onToggleSyncEnabled: (value: boolean) => Promise<void> | void;
  onSetDefaultViewMode: (mode: "grid" | "list") => void;
  onSetDefaultFilterMode: (mode: FilterMode) => void;
  onSetDefaultSortOption: (option: DefaultSortOption) => void;
  onSetDefaultServer: (url: string | null) => void;
  onSelectServer: (url: string | null) => void;
  onAddServer: (server: ManagedServer) => void;
  onUpdateServer: (originalUrl: string, server: ManagedServer) => void;
  onRemoveServer: (url: string) => void;
  onSyncServers?: () => void;
  serverSyncDisabled?: boolean;
  serverSyncInProgress?: boolean;
  savingServers: boolean;
  serverActionsDisabled?: boolean;
  serverValidationError?: string | null;
  onSetShowIconsPreviews: (value: boolean) => void;
  onSetShowListPreviews: (value: boolean) => void;
  onSetKeepSearchExpanded: (value: boolean) => void;
  onSetTheme: (theme: "dark" | "light") => void;
  showStatusMessage?: (message: string, tone?: StatusMessageTone, duration?: number) => void;
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  servers,
  defaultServerUrl,
  selectedServerUrl,
  defaultViewMode,
  defaultFilterMode,
  defaultSortOption,
  showIconsPreviews,
  showListPreviews,
  keepSearchExpanded,
  theme,
  syncEnabled,
  syncLoading,
  syncError,
  syncPending,
  lastSyncedAt,
  onToggleSyncEnabled,
  onSetDefaultViewMode,
  onSetDefaultFilterMode,
  onSetDefaultSortOption,
  onSetDefaultServer,
  onSelectServer,
  onAddServer,
  onUpdateServer,
  onRemoveServer,
  onSyncServers,
  serverSyncDisabled,
  serverSyncInProgress,
  savingServers,
  serverActionsDisabled = false,
  serverValidationError,
  onSetShowIconsPreviews,
  onSetShowListPreviews,
  onSetKeepSearchExpanded,
  onSetTheme,
  showStatusMessage,
}) => {
  const syncHeadingId = React.useId();
  const syncDescriptionId = React.useId();
  const defaultServerHeadingId = React.useId();
  const defaultServerDescriptionId = React.useId();
  const defaultServerHelperId = React.useId();
  const missingDefaultId = React.useId();
  const appearanceHeadingId = React.useId();
  const appearanceDescriptionId = React.useId();
  const viewHeadingId = React.useId();
  const viewDescriptionId = React.useId();
  const filterHeadingId = React.useId();
  const filterDescriptionId = React.useId();
  const sortHeadingId = React.useId();
  const sortDescriptionId = React.useId();
  const iconsPreviewHeadingId = React.useId();
  const iconsPreviewDescriptionId = React.useId();
  const listPreviewHeadingId = React.useId();
  const listPreviewDescriptionId = React.useId();
  const searchHeadingId = React.useId();
  const searchDescriptionId = React.useId();
  const { defaultServerSelectValue, defaultServerExists } = React.useMemo(() => {
    if (!defaultServerUrl) {
      return { defaultServerSelectValue: "", defaultServerExists: false };
    }
    const normalized = defaultServerUrl.trim().replace(/\/$/, "");
    const exists = servers.some(server => server.url === normalized);
    return {
      defaultServerSelectValue: normalized,
      defaultServerExists: exists,
    };
  }, [defaultServerUrl, servers]);

  const missingDefaultMessageVisible = !defaultServerExists && Boolean(defaultServerSelectValue);
  const defaultServerHelperText = "Bloom uses all linked servers when no default is set.";
  const defaultServerDescribedBy = React.useMemo(() => {
    const ids = [defaultServerDescriptionId, defaultServerHelperId];
    if (missingDefaultMessageVisible) ids.push(missingDefaultId);
    return ids.join(" ");
  }, [defaultServerDescriptionId, defaultServerHelperId, missingDefaultMessageVisible, missingDefaultId]);

  const normalizedDefaultFilterMode = defaultFilterMode === "pdfs" ? "documents" : defaultFilterMode;
  const filterSegmentOptions: SegmentedOption[] = FILTER_OPTIONS.map(option => ({ id: option.id, label: option.label, Icon: option.Icon }));
  const sortSegmentOptions: SegmentedOption[] = SORT_OPTIONS.map(option => ({
    id: option.id,
    label: option.label,
    Icon: option.Icon,
  }));

  const lastSyncStatus = React.useMemo<{ text: string; tone: StatusTone }>(() => {
    if (syncLoading) {
      return { text: "Sync in progress…", tone: "info" };
    }
    if (syncPending) {
      return { text: "Publish pending", tone: "warning" };
    }
    if (!syncEnabled) {
      return { text: "Sync disabled", tone: "muted" };
    }
    if (lastSyncedAt) {
      try {
        const millis = lastSyncedAt >= 1_000_000_000_000 ? lastSyncedAt : lastSyncedAt * 1000;
        return { text: formatRelativeTime(millis), tone: "muted" };
      } catch {
        return { text: "Last sync time unavailable", tone: "muted" };
      }
    }
    return { text: "Never synced", tone: "muted" };
  }, [syncLoading, syncPending, syncEnabled, lastSyncedAt]);

  const syncStatusClass = TONE_CLASS_BY_KEY[lastSyncStatus.tone];

  const lastReportedSyncError = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!showStatusMessage) {
      lastReportedSyncError.current = syncError;
      return;
    }
    if (syncError && syncError !== lastReportedSyncError.current) {
      showStatusMessage(syncError, "error", 5000);
    }
    lastReportedSyncError.current = syncError;
  }, [showStatusMessage, syncError]);

  const relayStatusHandler = React.useCallback(
    (message: string, tone?: StatusMessageTone, duration?: number) => {
      showStatusMessage?.(message, tone, duration);
    },
    [showStatusMessage]
  );

  const sections = React.useMemo(() => [
    {
      id: "primary",
      label: "Application Settings",
      description: "Keep Bloom connected and choose your default server.",
      icon: SyncIndicatorIcon,
      cards: [
        (
          <SettingCard
            key="sync"
            headingId={syncHeadingId}
            descriptionId={syncDescriptionId}
            title="Sync to Nostr"
            description="Bloom can publish preference updates to your relays so other devices stay aligned."
            className={syncEnabled ? "border-emerald-500/40 bg-emerald-500/10" : undefined}
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                    syncEnabled ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-300"
                  }`}
                >
                  <SyncIndicatorIcon size={18} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-100">{syncEnabled ? "Sync enabled" : "Sync disabled"}</p>
                  <p className="text-xs text-slate-400">{syncEnabled ? "Preferences publish automatically." : "Bloom keeps settings local."}</p>
                </div>
              </div>
              <SwitchControl
                labelledBy={syncHeadingId}
                checked={syncEnabled}
                onToggle={value => {
                  void onToggleSyncEnabled(value);
                }}
                disabled={syncLoading}
              />
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              {syncLoading ? <RefreshIcon size={14} className="animate-spin text-slate-300" aria-hidden /> : null}
              <span className={syncStatusClass}>Saved {lastSyncStatus.text}</span>
            </div>
            {syncError ? (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300" role="alert">
                {syncError}
              </p>
            ) : null}
          </SettingCard>
        ),
        (
          <SettingCard
            key="default-server"
            headingId={defaultServerHeadingId}
            descriptionId={defaultServerDescriptionId}
            title="Default server"
            description="Pick which server Bloom opens first when you browse your library."
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
                <ServersIcon size={18} />
              </div>
              <div className="flex-1 space-y-2">
                <select
                  value={defaultServerSelectValue}
                  onChange={event => {
                    const value = event.target.value.trim().replace(/\/$/, "");
                    onSetDefaultServer(value ? value : null);
                  }}
                  aria-describedby={defaultServerDescribedBy}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="">Use all servers</option>
                  {servers.map(server => (
                    <option key={server.url} value={server.url}>
                      {server.name}
                    </option>
                  ))}
                  {!defaultServerExists && defaultServerSelectValue ? (
                    <option value={defaultServerSelectValue}>{defaultServerSelectValue}</option>
                  ) : null}
                </select>
                <p id={defaultServerHelperId} className="text-xs text-slate-500">
                  {defaultServerHelperText}
                </p>
                {missingDefaultMessageVisible ? (
                  <p id={missingDefaultId} className="text-xs text-amber-300">
                    Bloom can’t reach this server right now. We’ll keep the saved URL until you remove it.
                  </p>
                ) : null}
              </div>
            </div>
          </SettingCard>
        ),
        (
          <SettingCard
            key="theme"
            headingId={appearanceHeadingId}
            descriptionId={appearanceDescriptionId}
            title="Appearance"
            description="Switch between dark mode and a brighter light mode."
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl text-lg ${
                    theme === "dark" ? "bg-slate-900 text-emerald-200" : "bg-amber-100 text-amber-500"
                  }`}
                >
                  {theme === "dark" ? "🌙" : "☀️"}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-100">{theme === "dark" ? "Dark mode" : "Light mode"}</p>
                  <p className="text-xs text-slate-400">Light mode brightens surfaces for well-lit environments.</p>
                </div>
              </div>
              <SwitchControl
                checked={theme === "dark"}
                onToggle={value => onSetTheme(value ? "dark" : "light")}
                label="Toggle dark mode"
              />
            </div>
          </SettingCard>
        ),
      ],
    },
    {
      id: "library",
      label: "Layout Settings",
      description: "Tune how Bloom displays and organises your files by default.",
      icon: SettingsIcon,
      cards: [
        (
          <SettingCard
            key="layout"
            headingId={viewHeadingId}
            descriptionId={viewDescriptionId}
            title="Default layout"
            description="Decide whether Bloom opens the library in grid or list view."
          >
            <SegmentedControl
              options={VIEW_MODE_OPTIONS}
              value={defaultViewMode}
              onChange={id => onSetDefaultViewMode(id as "grid" | "list")}
              labelledBy={viewHeadingId}
              describedBy={viewDescriptionId}
            />
          </SettingCard>
        ),
        (
          <SettingCard
            key="filter"
            headingId={filterHeadingId}
            descriptionId={filterDescriptionId}
            title="Default filter"
            description="Automatically focus on a media type whenever you open the library."
          >
            <SegmentedControl
              options={filterSegmentOptions}
              value={normalizedDefaultFilterMode}
              onChange={id => onSetDefaultFilterMode(id as FilterMode)}
              labelledBy={filterHeadingId}
              describedBy={filterDescriptionId}
              className="grid gap-2 sm:grid-cols-2"
            />
          </SettingCard>
        ),
        (
          <SettingCard
            key="sorting"
            headingId={sortHeadingId}
            descriptionId={sortDescriptionId}
            title="Default sorting"
            description="Choose how Bloom orders items when loading folders."
          >
            <SegmentedControl
              options={sortSegmentOptions}
              value={defaultSortOption}
              onChange={id => onSetDefaultSortOption(id as DefaultSortOption)}
              labelledBy={sortHeadingId}
              describedBy={sortDescriptionId}
              className="grid gap-2 sm:grid-cols-2"
            />
          </SettingCard>
        ),
      ],
    },
    {
      id: "previews",
      label: "Previews & Search",
      description: "Control thumbnails and search behaviour to match your workflow.",
      icon: SearchIcon,
      cards: [
        (
          <SettingCard
            key="icons-preview"
            headingId={`${iconsPreviewHeadingId}-card`}
            descriptionId={iconsPreviewDescriptionId}
            title="Icons view thumbnails"
            description="Show artwork thumbnails while browsing in the grid layout."
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${showIconsPreviews ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
                  <GridIcon size={18} />
                </div>
                <p className="text-xs text-slate-400">
                  {showIconsPreviews ? "Thumbnails are visible." : "Thumbnails are hidden."}
                </p>
              </div>
              <SwitchControl
                checked={showIconsPreviews}
                onToggle={value => onSetShowIconsPreviews(value)}
                label="Toggle icons view previews"
              />
            </div>
          </SettingCard>
        ),
        (
          <SettingCard
            key="list-preview"
            headingId={`${listPreviewHeadingId}-card`}
            descriptionId={listPreviewDescriptionId}
            title="List view thumbnails"
            description="Display artwork next to items in the list layout."
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${showListPreviews ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
                  <ListIcon size={18} />
                </div>
                <p className="text-xs text-slate-400">
                  {showListPreviews ? "Thumbnails appear in lists." : "Lists stay compact."}
                </p>
              </div>
              <SwitchControl
                checked={showListPreviews}
                onToggle={value => onSetShowListPreviews(value)}
                label="Toggle list view previews"
              />
            </div>
          </SettingCard>
        ),
        (
          <SettingCard
            key="search"
            headingId={searchHeadingId}
            descriptionId={searchDescriptionId}
            title="Keep search bar expanded"
            description="Remember the expanded search state between browsing sessions."
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${keepSearchExpanded ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
                  <SearchIcon size={18} />
                </div>
                <p className="text-xs text-slate-400">
                  {keepSearchExpanded ? "Search stays open." : "Search collapses after use."}
                </p>
              </div>
              <SwitchControl
                checked={keepSearchExpanded}
                onToggle={value => onSetKeepSearchExpanded(value)}
                label="Toggle persistent search"
              />
            </div>
          </SettingCard>
        ),
      ],
    },
    {
      id: "relays",
      label: "Relay Settings",
      description: "Manage which relays Bloom connects to and publishes through.",
      icon: RelayIcon,
      cards: [
        (
          <React.Suspense
            key="relays-panel"
            fallback={<div className="text-sm text-slate-400">Loading relays…</div>}
          >
            <RelayListLazy showStatusMessage={relayStatusHandler} compact />
          </React.Suspense>
        ),
      ],
    },
    {
      id: "servers",
      label: "Server Settings",
      description: "Manage the servers connected to Bloom.",
      icon: ServersIcon,
      cards: [
        <WorkspaceProvider
          key="servers-panel"
          servers={servers}
          selectedServer={selectedServerUrl}
          onSelectServer={onSelectServer}
        >
          <ServerList
            servers={servers}
            selected={selectedServerUrl}
            defaultServerUrl={defaultServerUrl}
            onSelect={onSelectServer}
            onSetDefaultServer={onSetDefaultServer}
            onAdd={onAddServer}
            onUpdate={onUpdateServer}
            saving={savingServers}
            disabled={serverActionsDisabled}
            onRemove={onRemoveServer}
            onSync={onSyncServers}
            syncDisabled={serverSyncDisabled}
            syncInProgress={serverSyncInProgress}
            validationError={serverValidationError}
            showStatusMessage={showStatusMessage}
            compact
          />
        </WorkspaceProvider>,
      ],
    },
  ], [
    syncEnabled,
    syncHeadingId,
    syncDescriptionId,
    syncLoading,
    syncStatusClass,
    lastSyncStatus.text,
    syncError,
    defaultServerSelectValue,
    onSetDefaultServer,
    defaultServerDescribedBy,
    servers,
    defaultServerExists,
    defaultServerHelperId,
    defaultServerHelperText,
    missingDefaultMessageVisible,
    missingDefaultId,
    defaultServerDescriptionId,
    viewHeadingId,
    viewDescriptionId,
    defaultViewMode,
    onSetDefaultViewMode,
    filterHeadingId,
    filterDescriptionId,
    normalizedDefaultFilterMode,
    onSetDefaultFilterMode,
    sortHeadingId,
    sortDescriptionId,
    defaultSortOption,
    onSetDefaultSortOption,
    filterSegmentOptions,
    sortSegmentOptions,
    iconsPreviewHeadingId,
    iconsPreviewDescriptionId,
    showIconsPreviews,
    onSetShowIconsPreviews,
    listPreviewHeadingId,
    listPreviewDescriptionId,
    showListPreviews,
    onSetShowListPreviews,
    searchHeadingId,
    searchDescriptionId,
    keepSearchExpanded,
    onSetKeepSearchExpanded,
    appearanceHeadingId,
    appearanceDescriptionId,
    theme,
    onSetTheme,
    servers,
    selectedServerUrl,
    onSelectServer,
    onAddServer,
    onUpdateServer,
    savingServers,
    serverActionsDisabled,
    onRemoveServer,
    onSyncServers,
    serverSyncDisabled,
    serverSyncInProgress,
    serverValidationError,
    relayStatusHandler,
  ]);

  const [activeSectionId, setActiveSectionId] = React.useState(() => sections[0]?.id ?? "primary");

  React.useEffect(() => {
    if (!sections.some(section => section.id === activeSectionId) && sections.length > 0) {
      const firstSection = sections[0];
      if (firstSection) {
        setActiveSectionId(firstSection.id);
      }
    }
  }, [sections, activeSectionId]);

  const navItemBaseClass = "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-slate-800/60 hover:text-emerald-200";
  const handleOpenSubmitIssue = React.useCallback(() => {
    if (typeof window === "undefined") return;
    window.open("https://github.com/Letdown2491/bloom/issues", "_blank", "noopener,noreferrer");
  }, []);
  const handleOpenSupport = React.useCallback(() => {
    if (typeof window === "undefined") return;
    window.open("https://getalby.com/p/invincibleperfection384952", "_blank", "noopener,noreferrer");
  }, []);

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-2xl font-semibold text-slate-100">Settings</h2>
      </header>

      <div className="grid gap-6 xl:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-sm">
          <ul className="space-y-2 text-sm text-slate-300">
            {sections.map(section => {
              const Icon = section.icon;
              const isActive = section.id === activeSectionId;
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => setActiveSectionId(section.id)}
                    className={`${navItemBaseClass} ${
                      isActive ? "bg-slate-800/70 text-emerald-200" : ""
                    }`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <Icon size={16} />
                    <span>{section.label}</span>
                  </button>
                </li>
              );
            })}
            <li>
              <button type="button" onClick={handleOpenSubmitIssue} className={`${navItemBaseClass} text-slate-300`}>
                <GithubIcon size={16} />
                <span className="font-medium">Submit Issue</span>
              </button>
            </li>
            <li>
              <button type="button" onClick={handleOpenSupport} className={`${navItemBaseClass} text-slate-300`}>
                <LightningIcon size={16} />
                <span className="font-medium">Support Bloom</span>
              </button>
            </li>
          </ul>
        </nav>

        <div className="space-y-10">
          {sections
            .filter(section => section.id === activeSectionId)
            .map(section => (
              <div key={section.id} id={section.id} className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-slate-100">{section.label}</h3>
                  <p className="text-xs text-slate-400">{section.description}</p>
                </div>
                <div className="space-y-4">
                  {section.cards.map((card, index) => (
                    <React.Fragment key={index}>{card}</React.Fragment>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
};

export default SettingsPanel;
