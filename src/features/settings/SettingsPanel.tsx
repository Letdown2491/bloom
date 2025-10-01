import React from "react";
import type { FilterMode } from "../../types/filter";
import type { ManagedServer } from "../../hooks/useServers";
import type { DefaultSortOption } from "../../context/UserPreferencesContext";
import type { StatusMessageTone } from "../../types/status";
import { GridIcon, ListIcon, FilterIcon, DocumentIcon, ImageIcon, MusicIcon, VideoIcon } from "../../components/icons";

type FilterOption = {
  id: FilterMode;
  label: string;
  Icon: typeof FilterIcon;
};

const FILTER_OPTION_PRESETS = [
  { id: "all", label: "All Files", Icon: FilterIcon },
  { id: "documents", label: "Documents", Icon: DocumentIcon },
  { id: "images", label: "Images", Icon: ImageIcon },
  { id: "music", label: "Audio", Icon: MusicIcon },
  { id: "pdfs", label: "PDFs", Icon: DocumentIcon },
  { id: "videos", label: "Videos", Icon: VideoIcon },
] satisfies FilterOption[];

const FILTER_OPTIONS: FilterOption[] = [...FILTER_OPTION_PRESETS].sort((a, b) =>
  a.label.localeCompare(b.label)
);

const LABEL_CLASSES = "w-52 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-white";

const SORT_OPTIONS: { id: DefaultSortOption; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "servers", label: "Servers" },
  { id: "updated", label: "Updated" },
  { id: "size", label: "Size" },
];

type SettingsPanelProps = {
  servers: ManagedServer[];
  defaultServerUrl: string | null;
  defaultViewMode: "grid" | "list";
  defaultFilterMode: FilterMode;
  defaultSortOption: DefaultSortOption;
  showIconsPreviews: boolean;
  showListPreviews: boolean;
  keepSearchExpanded: boolean;
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
  onSetShowIconsPreviews: (value: boolean) => void;
  onSetShowListPreviews: (value: boolean) => void;
  onSetKeepSearchExpanded: (value: boolean) => void;
  showStatusMessage?: (message: string, tone?: StatusMessageTone, duration?: number) => void;
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  servers,
  defaultServerUrl,
  defaultViewMode,
  defaultFilterMode,
  defaultSortOption,
  showIconsPreviews,
  showListPreviews,
  keepSearchExpanded,
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
  onSetShowIconsPreviews,
  onSetShowListPreviews,
  onSetKeepSearchExpanded,
  showStatusMessage,
}) => {
  const showIconsToggleId = React.useId();
  const showListToggleId = React.useId();
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

  const lastUpdatedLabel = React.useMemo(() => {
    if (syncLoading) return "Syncing…";
    if (syncPending) return "Pending publish…";
    if (!syncEnabled) return "Sync disabled";
    if (lastSyncedAt) {
      try {
        const millis = lastSyncedAt >= 1_000_000_000_000 ? lastSyncedAt : lastSyncedAt * 1000;
        return new Date(millis).toLocaleString();
      } catch {
        return "Unknown";
      }
    }
    return "Never";
  }, [syncLoading, syncPending, lastSyncedAt, syncEnabled]);

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

  return (
    <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
        <p className="text-xs text-slate-400">Last updated: {lastUpdatedLabel}</p>
      </div>
      <div className="space-y-5 text-sm text-slate-300">
        <div className="flex flex-wrap items-start gap-3">
          <span className={LABEL_CLASSES}>Sync settings to Nostr:</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { void onToggleSyncEnabled(true); }}
              disabled={syncEnabled || syncLoading}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                syncEnabled
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              } ${syncLoading ? "opacity-60" : ""}`}
            >
              {syncEnabled ? "Enabled" : "Enable"}
            </button>
            <button
              type="button"
              onClick={() => { void onToggleSyncEnabled(false); }}
              disabled={!syncEnabled || syncLoading}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                !syncEnabled
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              } ${syncLoading ? "opacity-60" : ""}`}
            >
              {syncEnabled ? "Disable" : "Disabled"}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES}>Default server:</span>
          <select
            value={defaultServerSelectValue}
            onChange={event => {
              const value = event.target.value.trim().replace(/\/$/, "");
              onSetDefaultServer(value ? value : null);
            }}
            className="min-w-[14rem] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="">No default (All servers)</option>
            {servers.map(server => (
              <option key={server.url} value={server.url}>
                {server.name}
              </option>
            ))}
            {!defaultServerExists && defaultServerSelectValue ? (
              <option value={defaultServerSelectValue}>{defaultServerSelectValue}</option>
            ) : null}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES}>Default layout:</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSetDefaultViewMode("grid")}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                defaultViewMode === "grid"
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              <GridIcon size={16} />
              <span>Grid View</span>
            </button>
            <button
              type="button"
              onClick={() => onSetDefaultViewMode("list")}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                defaultViewMode === "list"
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              <ListIcon size={16} />
              <span>List View</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES}>Default filter:</span>
          <div className="flex flex-wrap gap-2">
            {FILTER_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => onSetDefaultFilterMode(option.id)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  defaultFilterMode === option.id
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-400 text-white hover:border-slate-500"
                }`}
              >
                <option.Icon size={16} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES}>Default sorting:</span>
          <div className="flex flex-wrap gap-2">
            {SORT_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => onSetDefaultSortOption(option.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  defaultSortOption === option.id
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-400 text-white hover:border-slate-500"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES} id={showIconsToggleId}>
            Previews in Icons view:
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              aria-labelledby={showIconsToggleId}
              aria-pressed={showIconsPreviews}
              onClick={() => onSetShowIconsPreviews(true)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                showIconsPreviews
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              Show
            </button>
            <button
              type="button"
              aria-labelledby={showIconsToggleId}
              aria-pressed={!showIconsPreviews}
              onClick={() => onSetShowIconsPreviews(false)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                !showIconsPreviews
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              Hide
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES} id={showListToggleId}>
            Previews in List view:
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              aria-labelledby={showListToggleId}
              aria-pressed={showListPreviews}
              onClick={() => onSetShowListPreviews(true)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                showListPreviews
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              Show
            </button>
            <button
              type="button"
              aria-labelledby={showListToggleId}
              aria-pressed={!showListPreviews}
              onClick={() => onSetShowListPreviews(false)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                !showListPreviews
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              Hide
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL_CLASSES}>Keep search bar expanded:</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSetKeepSearchExpanded(true)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                keepSearchExpanded
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => onSetKeepSearchExpanded(false)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                !keepSearchExpanded
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              No
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
