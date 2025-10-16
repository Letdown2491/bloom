import React from "react";
import type { FilterMode } from "../../types/filter";
import type { ManagedServer } from "../../hooks/useServers";
import type { DefaultSortOption, SortDirection } from "../../context/UserPreferencesContext";
import type { StatusMessageTone } from "../../types/status";
import type { ShareFolderRequest } from "../../types/shareFolder";
import type { FolderListRecord } from "../../lib/folderList";
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
  DoubleChevronUpIcon,
  DoubleChevronDownIcon,
  ShareIcon,
  FolderIcon,
  LockIcon,
} from "../../components/icons";
import { ServerList } from "../../components/ServerList";
const RelayListLazy = React.lazy(() => import("../../components/RelayList"));
import { useIsCompactScreen } from "../../hooks/useIsCompactScreen";
import { useStorageQuota } from "../../hooks/useStorageQuota";
import { formatBytes } from "../../utils/storageQuota";
import { useFolderLists } from "../../context/FolderListContext";
import { encodeFolderNaddr, isPrivateFolderName } from "../../lib/folderList";
import { usePreferredRelays } from "../../hooks/usePreferredRelays";
import { useCurrentPubkey } from "../../context/NdkContext";
import { DEFAULT_PUBLIC_RELAYS, sanitizeRelayUrl } from "../../utils/relays";

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

const SORT_DIRECTION_OPTIONS: SegmentedOption[] = [
  { id: "ascending", label: "Ascending", Icon: DoubleChevronUpIcon },
  { id: "descending", label: "Descending", Icon: DoubleChevronDownIcon },
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

const STORAGE_FEEDBACK_CLASS_BY_TONE = {
  success: "text-emerald-300",
  warning: "text-amber-300",
  error: "text-red-300",
} as const;

const DEFAULT_SHARE_ORIGIN = "https://bloomapp.me";

const VISIBILITY_OPTIONS: SegmentedOption[] = [
  { id: "private", label: "Only you", Icon: LockIcon },
  { id: "public", label: "Public", Icon: ShareIcon },
];

const collectRelayHints = (relays: readonly string[]): string[] => {
  const normalized = new Set<string>();
  relays.forEach(url => {
    const sanitized = sanitizeRelayUrl(url);
    if (sanitized) {
      normalized.add(sanitized);
    }
  });
  return Array.from(normalized);
};

const buildShareLink = (
  record: FolderListRecord,
  fallbackPubkey: string | null,
  relays: readonly string[],
  origin: string
): { naddr: string; url: string } | null => {
  const ownerPubkey = record.pubkey ?? fallbackPubkey;
  if (!ownerPubkey) return null;
  const relayHints = Array.isArray(relays) && relays.length > 0 ? relays : undefined;
  const naddr = encodeFolderNaddr(record, ownerPubkey, relayHints);
  if (!naddr) return null;
  const trimmedOrigin = origin.replace(/\/+$/, "") || DEFAULT_SHARE_ORIGIN;
  return {
    naddr,
    url: `${trimmedOrigin}/folders/${encodeURIComponent(naddr)}`,
  };
};


const getProgressBarClass = (percent: number): string => {
  if (percent >= 80) return "bg-red-400";
  if (percent >= 66.6666667) return "bg-amber-400";
  return "bg-emerald-400";
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
  headingId?: string;
  descriptionId?: string;
  title?: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
};

const SettingCard: React.FC<SettingCardProps> = ({
  headingId,
  descriptionId,
  title,
  description,
  className,
  actions,
  children,
}) => {
  const hasHeaderContent = Boolean(title || description || actions);
  const labelledBy = title && headingId ? headingId : undefined;
  const describedBy = description && descriptionId ? descriptionId : undefined;

  return (
    <section
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-sm ${className ?? ""}`}
    >
      {hasHeaderContent ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            {title ? (
              <h3 id={headingId} className="text-sm font-semibold text-slate-100">
                {title}
              </h3>
            ) : null}
            {description ? (
              <p id={descriptionId} className="text-xs text-slate-400">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={`${hasHeaderContent ? "mt-4" : ""} text-sm text-slate-200`}>{children}</div>
    </section>
  );
};

type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  labelledBy: string;
  describedBy?: string;
  className?: string;
  variant?: "default" | "compact";
  disabled?: boolean;
};

const SegmentedControl: React.FC<SegmentedControlProps> = ({
  options,
  value,
  onChange,
  labelledBy,
  describedBy,
  className,
  variant = "default",
  disabled = false,
}) => {
  const containerClass =
    className ??
    (variant === "compact" ? "flex flex-wrap gap-2" : "grid gap-2 sm:grid-cols-2");

  const baseButtonClass =
    variant === "compact"
      ? "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
      : "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900";

  const activeClass = variant === "compact"
      ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
      : "border-emerald-500 bg-emerald-500/10 text-emerald-200";
  const inactiveClass = variant === "compact"
    ? "border-slate-600/70 text-slate-200 hover:border-slate-400"
    : "border-slate-500/60 text-slate-200 hover:border-slate-400";
  const disabledClass =
    variant === "compact"
      ? "cursor-not-allowed border-slate-700/60 text-slate-500 opacity-60"
      : "cursor-not-allowed border-slate-700/60 text-slate-500 opacity-60";

  const iconSize = variant === "compact" ? 14 : 16;

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={containerClass}
    >
      {options.map(option => {
        const isActive = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={disabled ? -1 : isActive ? 0 : -1}
            onClick={() => {
              if (disabled) return;
              onChange(option.id);
            }}
            disabled={disabled}
            aria-disabled={disabled ? "true" : undefined}
            className={`${baseButtonClass} ${
              disabled ? disabledClass : isActive ? activeClass : inactiveClass
            }`}
          >
            {option.Icon ? <option.Icon size={iconSize} /> : null}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
};

type SettingsPanelProps = {
  servers: ManagedServer[];
  defaultServerUrl: string | null;
  selectedServerUrl: string | null;
  defaultViewMode: "grid" | "list";
  defaultFilterMode: FilterMode;
  defaultSortOption: DefaultSortOption;
  sortDirection: SortDirection;
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
  onSetSortDirection: (direction: SortDirection) => void;
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
  onShareFolder: (request: ShareFolderRequest) => void;
  onUnshareFolder: (request: ShareFolderRequest) => void;
  folderShareBusyPath: string | null;
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  servers,
  defaultServerUrl,
  selectedServerUrl,
  defaultViewMode,
  defaultFilterMode,
  defaultSortOption,
  sortDirection,
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
  onSetSortDirection,
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
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath,
}) => {
  const isSmallScreen = useIsCompactScreen();
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
  const sortDirectionHeadingId = React.useId();
  const sortDirectionDescriptionId = React.useId();
  const iconsPreviewHeadingId = React.useId();
  const iconsPreviewDescriptionId = React.useId();
  const listPreviewHeadingId = React.useId();
  const listPreviewDescriptionId = React.useId();
  const searchHeadingId = React.useId();
  const searchDescriptionId = React.useId();
  const localStorageHeadingId = React.useId();
  const cacheStorageHeadingId = React.useId();
  const storageFeedbackId = React.useId();
  const [serverActions, setServerActions] = React.useState<React.ReactNode | null>(null);
  const [relayActions, setRelayActions] = React.useState<React.ReactNode | null>(null);
  const { folders } = useFolderLists();
  const { effectiveRelays } = usePreferredRelays();
  const currentPubkey = useCurrentPubkey();
  const shareRelayHints = React.useMemo(
    () => collectRelayHints(effectiveRelays.length > 0 ? effectiveRelays : DEFAULT_PUBLIC_RELAYS),
    [effectiveRelays]
  );
  const shareOrigin = React.useMemo(() => {
    if (typeof window !== "undefined" && window.location?.origin) {
      return window.location.origin;
    }
    return DEFAULT_SHARE_ORIGIN;
  }, []);

  const {
    snapshot: storageSnapshot,
    warnThreshold: storageWarnThreshold,
    criticalThreshold: storageCriticalThreshold,
    usagePercent: storageUsagePercent,
    managedKeys: storageManagedKeys,
    refresh: refreshStorageQuota,
    clear: clearLocalStorageAction,
    isSupported: isStorageSupported,
    originQuota: originQuotaBytes,
    approximateCacheUsage: approximateCacheBytes,
    cacheSupported,
    cacheEstimate,
    clearCache: clearCacheStorage,
  } = useStorageQuota();

  const [clearingLocalStorage, setClearingLocalStorage] = React.useState(false);
  const [clearingCacheStorage, setClearingCacheStorage] = React.useState(false);
  const [storageFeedback, setStorageFeedback] = React.useState<{ text: string; tone: "success" | "warning" | "error" } | null>(null);

  const storageWarnMarkerPercent = React.useMemo(() => {
    if (storageCriticalThreshold <= 0) return 1;
    return Math.max(0, Math.min(1, storageWarnThreshold / storageCriticalThreshold));
  }, [storageWarnThreshold, storageCriticalThreshold]);
  const storageProgressWidth = React.useMemo(() => Math.max(0, Math.min(100, storageUsagePercent * 100)), [storageUsagePercent]);
  const storageBarClass = React.useMemo(() => getProgressBarClass(storageProgressWidth), [storageProgressWidth]);
  const cacheUsageDisplay = React.useMemo(() => {
    if (cacheEstimate && cacheEstimate.totalBytes != null) {
      return formatBytes(cacheEstimate.totalBytes);
    }
    if (approximateCacheBytes != null) {
      return formatBytes(approximateCacheBytes);
    }
    return null;
  }, [approximateCacheBytes, cacheEstimate]);
  const cacheEntriesCount = cacheEstimate?.entryCount ?? null;
  const cacheUsageBytes = React.useMemo(
    () => (cacheEstimate && cacheEstimate.totalBytes != null ? cacheEstimate.totalBytes : approximateCacheBytes ?? 0),
    [cacheEstimate, approximateCacheBytes]
  );
  const cacheCapacityBytes = React.useMemo(() => {
    if (originQuotaBytes && originQuotaBytes > 0) {
      return originQuotaBytes;
    }
    if (storageCriticalThreshold > 0) {
      return storageCriticalThreshold;
    }
    return Math.max(cacheUsageBytes, 1);
  }, [originQuotaBytes, storageCriticalThreshold, cacheUsageBytes]);
  const cacheProgressWidth = React.useMemo(() => {
    if (cacheCapacityBytes <= 0) {
      return cacheUsageBytes > 0 ? 100 : 0;
    }
    return Math.max(0, Math.min(100, (cacheUsageBytes / cacheCapacityBytes) * 100));
  }, [cacheUsageBytes, cacheCapacityBytes]);
  const cacheBarClass = getProgressBarClass(cacheProgressWidth);

  const handleStorageRefresh = React.useCallback(() => {
    setStorageFeedback(null);
    refreshStorageQuota("settings-panel:manual-refresh");
  }, [refreshStorageQuota]);

  const handleClearLocalStorage = React.useCallback(() => {
    if (!isStorageSupported || clearingLocalStorage) return;
    setClearingLocalStorage(true);
    setStorageFeedback(null);
    try {
      const result = clearLocalStorageAction();
      refreshStorageQuota("settings-panel:clear-local");
      if (result.failedKeys.length > 0) {
        setStorageFeedback({
          tone: "error",
          text: "Unable to remove every local storage entry. Close other tabs or clear storage via your browser settings.",
        });
      } else if (result.removedKeys.length === 0) {
        setStorageFeedback({
          tone: "warning",
          text: "Local storage was already clear—no Bloom data found.",
        });
      } else {
        setStorageFeedback({
          tone: "success",
          text: `Removed ${result.removedKeys.length} ${result.removedKeys.length === 1 ? "entry" : "entries"} from Bloom’s local storage.`,
        });
      }
    } catch (error) {
      setStorageFeedback({
        tone: "error",
        text: "Clearing local storage failed unexpectedly. Try again after refreshing Bloom.",
      });
    } finally {
      setClearingLocalStorage(false);
    }
  }, [clearLocalStorageAction, clearingLocalStorage, isStorageSupported, refreshStorageQuota]);

  const handleClearCacheStorage = React.useCallback(() => {
    if (!cacheSupported || clearingCacheStorage) return;
    setClearingCacheStorage(true);
    setStorageFeedback(null);
    void (async () => {
      try {
        const result = await clearCacheStorage();
        if (!result) {
          setStorageFeedback({
            tone: "warning",
            text: "Cache storage is unavailable in this environment.",
          });
          return;
        }
        if (result.failed.length > 0) {
          setStorageFeedback({
            tone: "error",
            text: "Unable to clear every cache entry. Close other tabs or retry after refreshing Bloom.",
          });
        } else if (result.cleared.length === 0) {
          setStorageFeedback({
            tone: "warning",
            text: "Preview cache was already empty.",
          });
        } else {
          setStorageFeedback({
            tone: "success",
            text: "Preview cache cleared successfully.",
          });
        }
      } catch (error) {
        setStorageFeedback({
          tone: "error",
          text: "Clearing cache storage failed unexpectedly. Try again after refreshing Bloom.",
        });
      } finally {
        setClearingCacheStorage(false);
      }
    })();
  }, [cacheSupported, clearingCacheStorage, clearCacheStorage]);
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

  const sections = React.useMemo(() => {
    const shareableFolders = folders
      .filter(record => record.path && record.path.trim().length > 0 && !isPrivateFolderName(record.name))
      .map(record => {
        const normalizedPath = record.path ?? "";
        const segments = normalizedPath.split("/").filter(Boolean);
        const depth = segments.length;
        const parentPath = depth > 0 ? segments.slice(0, -1).join("/") : "";
        return { record, depth, parentPath };
      })
      .sort((a, b) => (a.record.path || "").localeCompare(b.record.path || "", undefined, { sensitivity: "base" }));

    const folderSharingCards = [
      (
        <SettingCard key="folder-sharing">
          {shareableFolders.length === 0 ? (
            <p className="text-sm text-slate-400">Create a folder with files in the library view to enable public sharing.</p>
          ) : (
            <div className="space-y-2">
              {shareableFolders.map(({ record, depth }) => {
                const pathLabel = `/${record.path}`;
                const isPublic = record.visibility === "public";
                const isBusy = folderShareBusyPath === record.path;
                const sanitizedIdSource = record.path || record.name || "folder";
                const folderLabelId = `folder-sharing-${sanitizedIdSource.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`;
                const guideDepth = Math.max(depth - 1, 0);
                const indentGuides =
                  guideDepth > 0 ? (
                    <div className="flex shrink-0 text-slate-100" aria-hidden="true">
                      {Array.from({ length: guideDepth }).map((_, levelIndex) => {
                        const isLast = levelIndex === guideDepth - 1;
                        return (
                          <div key={`${record.path}-guide-${levelIndex}`} className="relative h-full w-6">
                            <div
                              className="absolute left-1/2 border-l border-current"
                              style={{ top: 0, bottom: isLast ? "50%" : 0 }}
                            />
                            {isLast ? (
                              <div
                                className="absolute left-1/2 right-0 border-t border-current"
                                style={{ top: "50%" }}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null;
                const visibilityValue = isPublic ? "public" : "private";
                const shareRequest = { path: record.path, scope: "aggregated" as const, serverUrl: null };
                const shareLink = isPublic ? buildShareLink(record, currentPubkey, shareRelayHints, shareOrigin) : null;
                const shareUrl = shareLink?.url ?? null;
                const handleCopyLink = async () => {
                  if (isBusy) return;
                  if (!shareUrl) {
                    onShareFolder(shareRequest);
                    return;
                  }
                  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                    try {
                      await navigator.clipboard.writeText(shareUrl);
                      showStatusMessage?.("Share link copied to clipboard.", "success", 2500);
                      return;
                    } catch {
                      // fall through
                    }
                  }
                  showStatusMessage?.("Copy unavailable. Opening share dialog to manage the link.", "warning", 4000);
                  onShareFolder(shareRequest);
                };
                const labelContent = (
                  <>
                    <FolderIcon
                      size={16}
                      aria-hidden="true"
                      className={`${
                        isPublic ? "text-slate-100 transition group-hover:text-emerald-200" : "text-slate-100"
                      }`}
                    />
                    <span className="flex min-w-0 items-center gap-1">
                      <span id={folderLabelId} className="truncate">
                        {record.name || pathLabel}
                      </span>
                      {isPublic ? (
                        <ShareIcon
                          size={14}
                          className="text-slate-100 transition group-hover:text-emerald-200"
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                  </>
                );
                return (
                  <div key={record.path} className="flex items-stretch">
                    {indentGuides}
                    <div
                      className={`flex flex-1 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
                        isBusy ? "opacity-80" : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-2">
                        {isPublic ? (
                          <button
                            type="button"
                            onClick={handleCopyLink}
                            disabled={isBusy}
                            title="Copy share link"
                            className={`group inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                              isBusy
                                ? "cursor-not-allowed text-slate-500"
                                : "text-slate-100 hover:text-emerald-100"
                            }`}
                          >
                            {labelContent}
                          </button>
                        ) : (
                          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                            {labelContent}
                          </div>
                        )}
                        <p className="break-all text-xs text-slate-500">{pathLabel}</p>
                      </div>
                      <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-none">
                        <SegmentedControl
                          options={VISIBILITY_OPTIONS}
                          value={visibilityValue}
                          onChange={nextValue => {
                            if (nextValue === visibilityValue || isBusy) return;
                            if (nextValue === "public") {
                              onShareFolder(shareRequest);
                            } else {
                              onUnshareFolder(shareRequest);
                            }
                          }}
                          labelledBy={folderLabelId}
                          variant="compact"
                          className="flex flex-wrap justify-end gap-2"
                          disabled={isBusy}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SettingCard>
      ),
    ];

    const baseSections = [
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
          !isSmallScreen && (
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
              variant="compact"
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
              variant="compact"
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
              variant="compact"
            />
          </SettingCard>
        ),
        (
          <SettingCard
            key="sorting-direction"
            headingId={sortDirectionHeadingId}
            descriptionId={sortDirectionDescriptionId}
            title="Default sort direction"
            description="Set whether Bloom sorts items ascending or descending by default."
          >
            <SegmentedControl
              options={SORT_DIRECTION_OPTIONS}
              value={sortDirection}
              onChange={id => onSetSortDirection(id as SortDirection)}
              labelledBy={sortDirectionHeadingId}
              describedBy={sortDirectionDescriptionId}
              variant="compact"
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
          !isSmallScreen && (
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
        id: "storage",
        label: "Storage Settings",
        description: "Review how Bloom uses browser storage.",
        icon: DownloadIcon,
        cards: [
        (
          <div key="storage-widgets" className="grid gap-4 lg:grid-cols-2">
            <SettingCard key="storage-local" headingId={localStorageHeadingId} title="Local storage">
              {!isStorageSupported ? (
                <p className="text-xs text-slate-500">Local storage is unavailable in this environment, so Bloom keeps settings in memory only.</p>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800" role="presentation">
                      <div
                        className={`h-full ${storageBarClass}`}
                        style={{ width: `${Math.max(2, storageProgressWidth).toFixed(1)}%` }}
                      />
                      {storageWarnMarkerPercent > 0 && storageWarnMarkerPercent < 1 ? (
                        <div
                          className="absolute top-0 bottom-0 w-px bg-amber-400/70"
                          style={{ left: `${(storageWarnMarkerPercent * 100).toFixed(1)}%` }}
                          aria-hidden
                        />
                      ) : null}
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>Warn {formatBytes(storageWarnThreshold)}</span>
                      <span>Critical {formatBytes(storageCriticalThreshold)}</span>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs text-slate-400">
                    <div className="flex justify-between">
                      <dt>Usage</dt>
                      <dd className="text-slate-200">
                        {formatBytes(storageSnapshot.totalBytes)} of {formatBytes(storageCriticalThreshold)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Keys managed</dt>
                      <dd className="text-slate-200">{storageManagedKeys.length}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleClearLocalStorage}
                      disabled={clearingLocalStorage}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                        clearingLocalStorage ? "cursor-not-allowed border-slate-600 text-slate-500" : "border-emerald-500/70 text-emerald-200 hover:border-emerald-400 hover:text-emerald-100"
                      }`}
                    >
                      {clearingLocalStorage ? "Clearing…" : "Clear local storage"}
                    </button>
                    <button
                      type="button"
                      onClick={handleStorageRefresh}
                      className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                    >
                      Refresh
                    </button>
                  </div>
                </>
              )}
            </SettingCard>
            <SettingCard key="storage-cache" headingId={cacheStorageHeadingId} title="Cache storage">
              {cacheSupported ? (
                <>
                  <div className="space-y-2">
                    <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800" role="presentation">
                      <div className={`h-full ${cacheBarClass}`} style={{ width: `${Math.max(2, cacheProgressWidth).toFixed(1)}%` }} />
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>0MB</span>
                      <span>{formatBytes(cacheCapacityBytes)}</span>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs text-slate-400">
                    <div className="flex justify-between">
                      <dt>Usage</dt>
                      <dd className="text-slate-200">{cacheUsageDisplay ?? "Unknown"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Previews cached</dt>
                      <dd className="text-slate-200">{cacheEntriesCount ?? "—"}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleClearCacheStorage}
                      disabled={clearingCacheStorage}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                        clearingCacheStorage ? "cursor-not-allowed border-slate-600 text-slate-500" : "border-emerald-500/70 text-emerald-200 hover-border-emerald-400 hover:text-emerald-100"
                      }`}
                    >
                      {clearingCacheStorage ? "Clearing…" : "Clear preview cache"}
                    </button>
                    <button
                      type="button"
                      onClick={handleStorageRefresh}
                      className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                    >
                      Refresh
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-500">Cache Storage is unavailable, so Bloom skips storing preview thumbnails on this device.</p>
              )}
            </SettingCard>
          </div>
        ),
        (
          <div key="storage-note" className="text-xs text-slate-400">
            Bloom keeps preferences, relay health snapshots, preview thumbnails, and recent share targets locally so everything loads instantly, and clearing storage resets these caches but never touches files stored on your servers.
          </div>
        ),
        storageFeedback ? (
          <p key="storage-feedback" className={`text-xs ${STORAGE_FEEDBACK_CLASS_BY_TONE[storageFeedback.tone]}`} id={storageFeedbackId}>
            {storageFeedback.text}
          </p>
        ) : null,
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
            <RelayListLazy showStatusMessage={relayStatusHandler} compact onProvideActions={setRelayActions} />
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
              onProvideActions={setServerActions}
            />
          </WorkspaceProvider>,
        ],
      },
    ];

    const sectionsWithShare = [
      ...baseSections,
      {
        id: "sharing",
        label: "Folder Sharing",
        description: "Manage which folders Bloom shares publicly.",
        icon: ShareIcon,
        cards: folderSharingCards,
      },
    ];

    return sectionsWithShare.sort((a, b) => a.label.localeCompare(b.label));
  }, [
    folders,
    folderShareBusyPath,
    currentPubkey,
    shareRelayHints,
    shareOrigin,
    showStatusMessage,
    onShareFolder,
    onUnshareFolder,
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
    sortDirectionHeadingId,
    sortDirectionDescriptionId,
    defaultSortOption,
    onSetDefaultSortOption,
    sortDirection,
    onSetSortDirection,
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
    serverActions,
    relayActions,
    relayStatusHandler,
    isSmallScreen,
    relayActions,
    localStorageHeadingId,
    cacheStorageHeadingId,
    storageFeedbackId,
    storageSnapshot.status,
    storageSnapshot.totalBytes,
    storageCriticalThreshold,
    storageWarnThreshold,
    storageManagedKeys.length,
    storageBarClass,
    storageProgressWidth,
    storageWarnMarkerPercent,
    storageFeedback,
    handleStorageRefresh,
    handleClearLocalStorage,
    handleClearCacheStorage,
    clearingLocalStorage,
    clearingCacheStorage,
    isStorageSupported,
    cacheSupported,
    cacheUsageDisplay,
    cacheEntriesCount,
    cacheProgressWidth,
    cacheCapacityBytes,
    cacheBarClass,
    originQuotaBytes,
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
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold text-slate-100">{section.label}</h3>
                    <p className="text-xs text-slate-400">{section.description}</p>
                  </div>
                  {(() => {
                    const actions =
                      section.id === "servers"
                        ? serverActions
                        : section.id === "relays"
                          ? relayActions
                          : null;
                    return actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null;
                  })()}
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
