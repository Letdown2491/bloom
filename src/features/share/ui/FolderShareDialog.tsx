import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";
import {
  CopyIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PreviewIcon,
  ShareIcon,
} from "../../../shared/ui/icons";
import type { FolderListRecord } from "../../../shared/domain/folderList";
import type { StatusMessageTone } from "../../../shared/types/status";
import type { FolderSharePhases, PublishPhaseState } from "./folderShareStatus";

type FolderShareDialogProps = {
  record: FolderListRecord;
  shareUrl: string;
  naddr: string;
  onClose: () => void;
  onStatus: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  phases?: FolderSharePhases;
  onRetryList?: (() => void | Promise<void>) | null;
  onRetryMetadata?: (() => void | Promise<void>) | null;
};

const copyText = async (value: string) => {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(area);
    }
    return;
  }
  await navigator.clipboard.writeText(value);
};

const formatRelayLabel = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url.replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
  }
};

const describePhaseStatus = (phase: PublishPhaseState): string => {
  switch (phase.status) {
    case "ready":
      return "Ready";
    case "partial":
      return "Needs retry";
    case "error":
      return "Publish failed";
    case "publishing":
      return "Publishing…";
    case "idle":
    default:
      return "Pending";
  }
};

const classForPhaseStatus = (phase: PublishPhaseState, isLightTheme: boolean) => {
  switch (phase.status) {
    case "ready":
      return isLightTheme ? "text-emerald-600" : "text-emerald-300";
    case "partial":
      return isLightTheme ? "text-amber-600" : "text-amber-300";
    case "error":
      return isLightTheme ? "text-rose-500" : "text-rose-300";
    case "publishing":
      return isLightTheme ? "text-slate-500" : "text-slate-300";
    default:
      return isLightTheme ? "text-slate-500" : "text-slate-300";
  }
};

const formatPhaseCount = (phase: PublishPhaseState) => {
  if (phase.total == null || phase.total <= 0) return null;
  const succeeded = Math.min(phase.succeeded, phase.total);
  return `${succeeded}/${phase.total} relays`;
};

export const FolderShareDialog: React.FC<FolderShareDialogProps> = ({
  record,
  shareUrl,
  naddr,
  onClose,
  onStatus,
  phases,
  onRetryList,
  onRetryMetadata,
}) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

  const folderLabel = useMemo(() => {
    const name = record.name?.trim();
    if (name) return name;
    const path = record.path?.trim();
    if (path) return path;
    return "Shared folder";
  }, [record.name, record.path]);

  const normalizedFolderPath = useMemo(() => {
    const path = record.path?.trim();
    if (!path) return "/";
    return `/${path.replace(/^\/+/, "")}`;
  }, [record.path]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const handleCopy = useCallback(
    async (value: string, label: string) => {
      try {
        await copyText(value);
        onStatus(`${label} copied to clipboard.`, "success", 2000);
      } catch {
        onStatus("Unable to copy to clipboard.", "error", 2500);
      }
    },
    [onStatus],
  );

  const phaseRows = useMemo(() => {
    if (!phases) return [];
    return [
      { id: "list", label: "Folder list", phase: phases.list, onRetry: onRetryList },
      { id: "metadata", label: "File details", phase: phases.metadata, onRetry: onRetryMetadata },
    ].filter(row => Boolean(row.phase)) as Array<{
      id: string;
      label: string;
      phase: PublishPhaseState;
      onRetry?: (() => void | Promise<void>) | null;
    }>;
  }, [phases, onRetryList, onRetryMetadata]);

  const allPhasesReady = useMemo(
    () => phaseRows.length > 0 && phaseRows.every(row => row.phase.status === "ready"),
    [phaseRows],
  );
  const [detailsExpanded, setDetailsExpanded] = useState(() => !allPhasesReady);
  const previousReadyRef = useRef(allPhasesReady);

  useEffect(() => {
    if (!allPhasesReady) {
      setDetailsExpanded(true);
    } else if (!previousReadyRef.current && allPhasesReady) {
      setDetailsExpanded(false);
    }
    previousReadyRef.current = allPhasesReady;
  }, [allPhasesReady]);

  const phaseMessage = useMemo(() => {
    if (phaseRows.length === 0) {
      return "Anyone with the link can view this folder. Sharing updates may take a moment to propagate across relays.";
    }
    if (phaseRows.some(row => row.phase.status === "publishing")) {
      return "Publishing updates to your relays. You can close this dialog while we finish.";
    }
    if (phaseRows.some(row => row.phase.status === "partial" || row.phase.status === "error")) {
      return "Some relays still need updates. Retry them here or leave the dialog open while we keep trying.";
    }
    return "All configured relays confirmed this share. Anyone with the link can view the folder immediately.";
  }, [phaseRows]);

  const overlayClass =
    "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4";
  const containerClass = isLightTheme
    ? "w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-xl"
    : "w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/90 p-6 text-slate-100 shadow-xl";
  const headingClass = isLightTheme
    ? "flex items-center gap-2 text-lg font-semibold text-slate-900"
    : "flex items-center gap-2 text-lg font-semibold text-slate-100";
  const folderInfoTextClass = isLightTheme
    ? "mt-2 text-sm text-slate-600"
    : "mt-2 text-sm text-slate-300";
  const folderPathTextClass = isLightTheme ? "text-xs text-slate-500" : "text-xs text-slate-500";
  const sectionLabelClass = isLightTheme
    ? "text-xs font-semibold uppercase tracking-wide text-slate-500"
    : "text-xs font-semibold uppercase tracking-wide text-slate-400";
  const shareButtonClass = isLightTheme
    ? "inline-flex flex-1 items-center gap-2 truncate rounded-lg border border-transparent px-2 py-1 text-left text-sm text-emerald-700 underline decoration-dotted underline-offset-2 transition hover:text-emerald-600 focus:outline-none"
    : "inline-flex flex-1 items-center gap-2 truncate rounded-lg border border-transparent px-2 py-1 text-left text-sm text-emerald-300 underline decoration-dotted underline-offset-2 transition hover:text-emerald-200 focus:outline-none";
  const previewButtonClass = isLightTheme
    ? "inline-flex items-center justify-center rounded-lg border border-slate-300 px-2 py-1 text-slate-600 transition hover:border-slate-400 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white"
    : "inline-flex items-center justify-center rounded-lg border border-slate-700 px-2 py-1 text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950";
  const phasesContainerClass = isLightTheme
    ? "space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3"
    : "space-y-3 rounded-2xl border border-slate-800/80 bg-slate-900/50 p-3";
  const phaseRowClass = isLightTheme
    ? "flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2"
    : "flex items-start justify-between gap-3 rounded-xl border border-slate-800/70 bg-slate-950/60 px-3 py-2";
  const phaseLabelClass = isLightTheme
    ? "text-xs font-semibold uppercase tracking-wide text-slate-600"
    : "text-xs font-semibold uppercase tracking-wide text-slate-400";
  const phaseCountClass = isLightTheme
    ? "ml-2 text-xs font-normal text-slate-500"
    : "ml-2 text-xs font-normal text-slate-400";
  const phaseDetailTextClass = isLightTheme
    ? "mt-1 text-xs text-slate-500"
    : "mt-1 text-xs text-slate-500";
  const retryButtonClass = isLightTheme
    ? "rounded-lg border border-emerald-500/70 px-2 py-1 text-xs font-semibold text-emerald-600 transition hover:bg-emerald-50 hover:text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white"
    : "rounded-lg border border-emerald-500/60 px-2 py-1 text-xs font-semibold text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900";
  const toggleButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white"
    : "inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900";
  const phaseMessageClass = isLightTheme ? "text-xs text-slate-500" : "text-xs text-slate-500";
  const closeButtonClass = isLightTheme
    ? "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white"
    : "rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950";

  return (
    <div className={overlayClass}>
      <div className={containerClass}>
        <h2 className={headingClass}>
          <ShareIcon size={18} aria-hidden="true" />
          <span>Share folder</span>
        </h2>
        <p className={folderInfoTextClass}>
          {folderLabel} <span className={folderPathTextClass}>({normalizedFolderPath})</span>
        </p>
        <div className="mt-6 space-y-4">
          <div>
            <span className={sectionLabelClass}>Public link</span>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleCopy(shareUrl, "Link");
                }}
                className={shareButtonClass}
                aria-label="Copy public link"
              >
                <span className="truncate" title={shareUrl}>
                  {shareUrl}
                </span>
                <CopyIcon size={14} className="flex-shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.open(shareUrl, "_blank", "noopener");
                  }
                }}
                className={previewButtonClass}
                aria-label="Open public link in new tab"
              >
                <PreviewIcon size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div>
            <span className={sectionLabelClass}>Nostr address</span>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleCopy(naddr, "NIP-19 address");
                }}
                className={shareButtonClass}
                aria-label="Copy NIP-19 address"
              >
                <span className="truncate font-mono" title={naddr}>
                  {naddr}
                </span>
                <CopyIcon size={14} className="flex-shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.open(
                      `https://nostr.band/?q=${encodeURIComponent(naddr)}`,
                      "_blank",
                      "noopener",
                    );
                  }
                }}
                className={previewButtonClass}
                aria-label="View NIP-19 address on nostr.band"
              >
                <PreviewIcon size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
          {phaseRows.length > 0 ? (
            <div className={phasesContainerClass}>
              {detailsExpanded ? (
                <div className="space-y-2">
                  {phaseRows.map(row => {
                    const statusLabel = describePhaseStatus(row.phase);
                    const statusClass = classForPhaseStatus(row.phase, isLightTheme);
                    const countLabel = formatPhaseCount(row.phase);
                    const firstFailure = row.phase.failed[0];
                    const failureHint =
                      (row.phase.status === "partial" || row.phase.status === "error") &&
                      row.phase.failed.length > 0
                        ? row.phase.failed.length === 1 && firstFailure
                          ? `Waiting on ${formatRelayLabel(firstFailure.url)}`
                          : row.phase.failed.length > 1 && firstFailure
                            ? `Waiting on ${row.phase.failed.length} relays (e.g. ${formatRelayLabel(firstFailure.url)})`
                            : null
                        : null;
                    const detailParts: string[] = [];
                    if (failureHint) {
                      detailParts.push(failureHint);
                    }
                    if (row.phase.message) {
                      detailParts.push(row.phase.message);
                    }
                    const detailText = detailParts.join(" • ");
                    const showRetry =
                      typeof row.onRetry === "function" &&
                      (row.phase.status === "partial" || row.phase.status === "error");
                    return (
                      <div key={row.id} className={phaseRowClass}>
                        <div className="min-w-0">
                          <p className={phaseLabelClass}>{row.label}</p>
                          <p className={`mt-1 text-sm font-medium ${statusClass}`}>
                            {statusLabel}
                            {countLabel ? (
                              <span className={phaseCountClass}>{countLabel}</span>
                            ) : null}
                          </p>
                          {detailText ? <p className={phaseDetailTextClass}>{detailText}</p> : null}
                        </div>
                        {showRetry ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (typeof row.onRetry === "function") {
                                void row.onRetry();
                              }
                            }}
                            className={retryButtonClass}
                          >
                            Retry
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <button
                type="button"
                className={toggleButtonClass}
                onClick={() => setDetailsExpanded(current => !current)}
              >
                {detailsExpanded ? (
                  <ChevronDownIcon size={14} aria-hidden="true" />
                ) : (
                  <ChevronRightIcon size={14} aria-hidden="true" />
                )}
                <span>{detailsExpanded ? "Hide details" : "Additional details"}</span>
              </button>
            </div>
          ) : null}
          <p className={phaseMessageClass}>{phaseMessage}</p>
        </div>
        <div className="mt-6 flex justify-end">
          <button type="button" className={closeButtonClass} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderShareDialog;
