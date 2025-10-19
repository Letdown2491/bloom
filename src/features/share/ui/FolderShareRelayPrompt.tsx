import React, { useEffect, useMemo, useRef, useState } from "react";
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100">Select where to share</h2>
        <p className="mt-2 text-sm text-slate-300 break-all">{folderLabel}</p>
        <p className="mt-4 text-sm text-slate-300">
          Sharing this folder will make it publicly accessible to anyone with the link. We will publish the folder
          details to your preferred relays (NIP-65) so other clients can find it.
        </p>
        {!showSelection ? (
          <p className="mt-3 text-xs text-slate-500">
            Continue to publish to all {totalCount} configured relays, or review the list before publishing.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Select the relays to publish this folder to:</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-emerald-300 hover:text-emerald-200 focus:outline-none"
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
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-3">
              {relays.map(url => {
                const checked = selected.has(url);
                const relayId = `relay-option-${normalizeRelayUrlForId(url)}`;
                return (
                  <label
                    key={url}
                    htmlFor={relayId}
                    className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-sm text-slate-200 hover:border-slate-700/80"
                  >
                    <input
                      id={relayId}
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                      checked={checked}
                      disabled={submitting}
                      onChange={() => toggleRelay(url)}
                    />
                    <span className="font-medium">{formatRelayLabel(url)}</span>
                    <span className="text-xs text-slate-500">{url}</span>
                  </label>
                );
              })}
              {relays.length === 0 ? (
                <p className="text-xs text-slate-500">No relays configured.</p>
              ) : null}
            </div>
            <p className="text-xs text-slate-500">
              {selectedCount}/{totalCount} relays selected.
            </p>
          </div>
        )}
        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950"
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
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950"
                onClick={() => setShowSelection(true)}
                disabled={submitting}
              >
                <ListIcon size={16} aria-hidden="true" />
                <span>Select relays</span>
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
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
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950"
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
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
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
