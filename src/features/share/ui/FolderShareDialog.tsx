import React, { useCallback, useEffect, useMemo } from "react";
import { CopyIcon } from "../../../shared/ui/icons";
import type { FolderListRecord } from "../../../shared/domain/folderList";
import type { StatusMessageTone } from "../../../shared/types/status";

type FolderShareDialogProps = {
  record: FolderListRecord;
  shareUrl: string;
  naddr: string;
  onClose: () => void;
  onStatus: (message: string, tone?: StatusMessageTone, duration?: number) => void;
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

export const FolderShareDialog: React.FC<FolderShareDialogProps> = ({ record, shareUrl, naddr, onClose, onStatus }) => {
  const folderLabel = useMemo(() => {
    const name = record.name?.trim();
    if (name) return name;
    const path = record.path?.trim();
    if (path) return path;
    return "Shared folder";
  }, [record.name, record.path]);

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
    [onStatus]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100">Share folder</h2>
        <p className="mt-2 text-sm text-slate-300">{folderLabel}</p>
        <p className="mt-1 text-xs text-slate-500 break-all">{record.path || "(root)"}</p>
        <div className="mt-6 space-y-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Public link</span>
            <button
              type="button"
              onClick={() => {
                void handleCopy(shareUrl, "Link");
              }}
              className="mt-2 inline-flex w-full items-center gap-2 truncate text-left text-sm text-emerald-300 underline decoration-dotted underline-offset-2 transition hover:text-emerald-200 focus:outline-none"
              aria-label="Copy public link"
            >
              <span className="truncate" title={shareUrl}>
                {shareUrl}
              </span>
              <CopyIcon size={14} className="flex-shrink-0" />
            </button>
          </div>
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Nostr address</span>
            <button
              type="button"
              onClick={() => {
                void handleCopy(naddr, "NIP-19 address");
              }}
              className="mt-2 inline-flex w-full items-center gap-2 truncate text-left text-sm text-emerald-300 underline decoration-dotted underline-offset-2 transition hover:text-emerald-200 focus:outline-none"
              aria-label="Copy NIP-19 address"
            >
              <span className="truncate font-mono" title={naddr}>
                {naddr}
              </span>
              <CopyIcon size={14} className="flex-shrink-0" />
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Anyone with the link can view this folder. Sharing updates may take a moment to propagate across relays.
          </p>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-950"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderShareDialog;
