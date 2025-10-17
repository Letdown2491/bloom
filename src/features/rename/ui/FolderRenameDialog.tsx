import React, { useCallback, useEffect, useRef, useState } from "react";

import { useFolderLists } from "../../../app/context/FolderListContext";
import { containsReservedFolderSegment } from "../../../shared/utils/blobMetadataStore";
import type { StatusMessageTone } from "../../../shared/types/status";

export type FolderRenameDialogProps = {
  path: string;
  onClose: () => void;
  onStatus: (message: string, tone?: StatusMessageTone, duration?: number) => void;
};

export const FolderRenameDialog: React.FC<FolderRenameDialogProps> = ({ path, onClose, onStatus }) => {
  const { renameFolder, getFolderDisplayName } = useFolderLists();
  const [name, setName] = useState(() => getFolderDisplayName(path));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setName(getFolderDisplayName(path));
    setError(null);
    setBusy(false);
  }, [getFolderDisplayName, path]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [path]);

  const handleSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Folder name cannot be empty.");
      return;
    }
    if (containsReservedFolderSegment(trimmed)) {
      setError('Folder names cannot include the word "private".');
      return;
    }
    setBusy(true);
    try {
      await renameFolder(path, trimmed);
      onStatus("Folder renamed.", "success", 2500);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Rename failed.";
      setError(message);
      onStatus(message, "error", 4000);
    } finally {
      setBusy(false);
    }
  }, [name, onClose, onStatus, path, renameFolder]);

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onClose();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  const nameHasReservedKeyword = containsReservedFolderSegment(name);
  const folderInputClass = nameHasReservedKeyword
    ? "mt-2 w-full rounded-xl border border-red-500 bg-slate-950 px-3 py-2 text-slate-100 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
    : "mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" onKeyDown={handleKeyDown}>
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100">Rename folder</h2>
        <p className="mt-2 text-xs text-slate-400">{path || "(root)"}</p>
        <label className="mt-4 block text-sm text-slate-300">
          Folder name
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={event => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            disabled={busy}
            className={folderInputClass}
            placeholder="Enter a folder name"
          />
        </label>
        {nameHasReservedKeyword && (
          <div className="mt-2 text-sm text-red-400">Folder names cannot include the word "private".</div>
        )}
        {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-600"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-500 disabled:opacity-50"
            onClick={() => void handleSubmit()}
            disabled={busy || nameHasReservedKeyword}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderRenameDialog;
