import React, { useEffect, useMemo, useRef, useState } from "react";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";
import type { FolderListRecord } from "../../../shared/domain/folderList";
import {
  ChevronRightIcon,
  CloseIcon,
  GridIcon,
  LightningIcon,
  ListIcon,
} from "../../../shared/ui/icons";

type FolderShareRelayPromptProps = {
  record: FolderListRecord;
  relays: readonly string[];
  onConfirm: (selectedRelays: string[]) => void | Promise<void>;
  onCancel: () => void;
};

const formatRelayLabel = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url.replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
  }
};

const normalizeRelayUrlForId = (url: string) => url.replace(/[^a-z0-9]/gi, "_");

export const FolderShareRelayPrompt: React.FC<FolderShareRelayPromptProps> = ({
  record,
  relays,
  onConfirm,
  onCancel,
}) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

  const folderLabel = useMemo(() => {
    const name = record.name?.trim() || "Shared folder";
    const path = record.path?.trim() || "/";
    return `${name} (${path})`;
  }, [record.name, record.path]);

  const [showSelection, setShowSelection] = useState(() => record.visibility !== "public");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(relays));
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (record.visibility !== "public") {
      setShowSelection(true);
    }
  }, [record.visibility, record.path]);

  useEffect(() => {
    setSelected(new Set(relays));
  }, [relays]);

  const handleContinueWithAll = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(Array.from(relays));
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const handlePublishSelected = async () => {
    if (submitting) return;
    const chosen = Array.from(selected);
    if (chosen.length === 0) return;
    setSubmitting(true);
    try {
      await onConfirm(chosen);
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const toggleRelay = (url: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelected(new Set(relays));
  };

  const handleClearAll = () => {
    setSelected(new Set<string>());
  };

  const selectedCount = selected.size;
  const totalCount = relays.length;

  const overlayClass =
    "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4";
  const containerClass = isLightTheme
    ? "w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-xl"
    : "w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl text-slate-100";
  const headingClass = isLightTheme
    ? "text-lg font-semibold text-slate-900"
    : "text-lg font-semibold text-slate-100";
  const folderLabelClass = isLightTheme
    ? "mt-2 text-sm text-slate-600 break-all"
    : "mt-2 text-sm text-slate-300 break-all";
  const descriptionClass = isLightTheme
    ? "mt-4 text-sm text-slate-600"
    : "mt-4 text-sm text-slate-300";
  const helperTextClass = isLightTheme
    ? "mt-3 text-xs text-slate-500"
    : "mt-3 text-xs text-slate-500";
  const selectionIntroClass = isLightTheme
    ? "flex items-center justify-between text-xs text-slate-500"
    : "flex items-center justify-between text-xs text-slate-400";
  const selectionContainerClass = isLightTheme
    ? "max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3"
    : "max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-3";
  const selectionCountClass = isLightTheme ? "text-xs text-slate-500" : "text-xs text-slate-500";
  const toggleLinkClass = isLightTheme
    ? "text-emerald-600 hover:text-emerald-500 focus:outline-none disabled:opacity-60"
    : "text-emerald-300 hover:text-emerald-200 focus:outline-none disabled:opacity-60";
  const cancelButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white disabled:opacity-60"
    : "inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-60";
  const secondaryButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
    : "inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60";
  const primaryButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
    : "inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60";
  const tertiaryButtonClass = isLightTheme
    ? "inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
    : "inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className={overlayClass}>
      <div className={containerClass}>
        <h2 className={headingClass}>Select where to share</h2>
        <p className={folderLabelClass}>{folderLabel}</p>
        <p className={descriptionClass}>
          Sharing this folder will make it publicly accessible to anyone with the link. We will
          publish the folder details to your preferred relays (NIP-65) so other clients can find it.
        </p>
        {!showSelection ? (
          <p className={helperTextClass}>
            Continue to publish to all {totalCount} configured relays, or review the list before
            publishing.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className={selectionIntroClass}>
              <span>Select the relays to publish this folder to:</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={toggleLinkClass}
                  onClick={handleSelectAll}
                  disabled={submitting}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-emerald-300 hover:text-emerald-200 focus:outline-none"
                  onClick={handleClearAll}
                  disabled={submitting}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className={selectionContainerClass}>
              {relays.map(url => {
                const checked = selected.has(url);
                const relayId = `relay-option-${normalizeRelayUrlForId(url)}`;
                const labelBaseClass = isLightTheme
                  ? "flex items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-sm text-slate-700 transition"
                  : "flex items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-sm text-slate-200 transition";
                const labelActiveClass = isLightTheme
                  ? "border-emerald-500/60 bg-emerald-50"
                  : "border-slate-700/80";
                const labelInactiveHoverClass = isLightTheme
                  ? "hover:border-slate-300"
                  : "hover:border-slate-700/80";
                return (
                  <label
                    key={url}
                    htmlFor={relayId}
                    className={`${labelBaseClass} ${checked ? labelActiveClass : labelInactiveHoverClass}`}
                  >
                    <input
                      id={relayId}
                      type="checkbox"
                      className={
                        isLightTheme
                          ? "h-4 w-4 rounded border-slate-300 bg-white text-emerald-600 focus:ring-emerald-500"
                          : "h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                      }
                      checked={checked}
                      disabled={submitting}
                      onChange={() => toggleRelay(url)}
                    />
                    <span className={isLightTheme ? "font-medium text-slate-800" : "font-medium"}>
                      {formatRelayLabel(url)}
                    </span>
                    <span className="text-xs text-slate-500">{url}</span>
                  </label>
                );
              })}
              {relays.length === 0 ? (
                <p className="text-xs text-slate-500">No relays configured.</p>
              ) : null}
            </div>
            <p className={selectionCountClass}>
              {selectedCount}/{totalCount} relays selected.
            </p>
          </div>
        )}
        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            className={cancelButtonClass}
            onClick={onCancel}
            disabled={submitting}
          >
            <CloseIcon size={16} aria-hidden="true" />
            <span>Cancel</span>
          </button>
          {!showSelection ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => setShowSelection(true)}
                disabled={submitting}
              >
                <ListIcon size={16} aria-hidden="true" />
                <span>Select relays</span>
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                onClick={handleContinueWithAll}
                disabled={submitting}
              >
                <LightningIcon size={16} aria-hidden="true" />
                <span>Continue</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={tertiaryButtonClass}
                onClick={() => {
                  setShowSelection(false);
                  handleSelectAll();
                }}
                disabled={submitting}
              >
                <GridIcon size={16} aria-hidden="true" />
                <span>Use all relays</span>
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                onClick={handlePublishSelected}
                disabled={submitting || selectedCount === 0}
              >
                <ChevronRightIcon size={16} aria-hidden="true" />
                <span>Publish</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FolderShareRelayPrompt;
