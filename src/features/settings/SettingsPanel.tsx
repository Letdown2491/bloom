import React from "react";
import type { FilterMode } from "../../types/filter";
import type { ManagedServer } from "../../hooks/useServers";

const BASE_FILTER_OPTIONS: { id: FilterMode; label: string }[] = [
  { id: "all", label: "All Files" },
  { id: "documents", label: "Documents" },
  { id: "images", label: "Images" },
  { id: "music", label: "Music" },
  { id: "pdfs", label: "PDFs" },
  { id: "videos", label: "Videos" },
];

const FILTER_OPTIONS = [...BASE_FILTER_OPTIONS].sort((a, b) => a.label.localeCompare(b.label));

type SettingsPanelProps = {
  servers: ManagedServer[];
  defaultServerUrl: string | null;
  defaultViewMode: "grid" | "list";
  defaultFilterMode: FilterMode;
  showIconsPreviews: boolean;
  showListPreviews: boolean;
  onSetDefaultViewMode: (mode: "grid" | "list") => void;
  onSetDefaultFilterMode: (mode: FilterMode) => void;
  onSetDefaultServer: (url: string | null) => void;
  onSetShowIconsPreviews: (value: boolean) => void;
  onSetShowListPreviews: (value: boolean) => void;
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  servers,
  defaultServerUrl,
  defaultViewMode,
  defaultFilterMode,
  showIconsPreviews,
  showListPreviews,
  onSetDefaultViewMode,
  onSetDefaultFilterMode,
  onSetDefaultServer,
  onSetShowIconsPreviews,
  onSetShowListPreviews,
}) => {
  const showIconsToggleId = React.useId();
  const showListToggleId = React.useId();
  const defaultServerSelectValue = React.useMemo(() => {
    if (!defaultServerUrl) {
      return "";
    }
    const normalized = defaultServerUrl.trim().replace(/\/$/, "");
    return servers.some(server => server.url === normalized) ? normalized : "";
  }, [defaultServerUrl, servers]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
      <div className="mt-4 space-y-5 text-sm text-slate-300">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Default server</span>
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
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Default browse view</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSetDefaultViewMode("grid")}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                defaultViewMode === "grid"
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              Icons
            </button>
            <button
              type="button"
              onClick={() => onSetDefaultViewMode("list")}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                defaultViewMode === "list"
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-400 text-white hover:border-slate-500"
              }`}
            >
              List
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Default filter</span>
          <div className="flex flex-wrap gap-2">
            {FILTER_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => onSetDefaultFilterMode(option.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  defaultFilterMode === option.id
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
          <span className="text-[11px] font-semibold uppercase tracking-wide text-white" id={showIconsToggleId}>
            Previews in Icons view
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
          <span className="text-[11px] font-semibold uppercase tracking-wide text-white" id={showListToggleId}>
            Previews in List view
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
      </div>
    </section>
  );
};

export default SettingsPanel;
