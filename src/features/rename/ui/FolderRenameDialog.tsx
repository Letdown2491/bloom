import React, { useCallback, useEffect, useRef, useState } from "react";

import { useFolderLists } from "../../../app/context/FolderListContext";
import { useNdk } from "../../../app/context/NdkContext";
import { usePreferredRelays } from "../../../app/hooks/usePreferredRelays";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { publishNip94Metadata, extractExtraNip94Tags } from "../../../shared/api/nip94Publisher";
import { containsReservedFolderSegment, getBlobMetadataName } from "../../../shared/utils/blobMetadataStore";
import type { StatusMessageTone } from "../../../shared/types/status";
import type { BlossomBlob } from "../../../shared/api/blossomClient";

export type FolderRenameDialogProps = {
  path: string;
  onClose: () => void;
  onStatus: (message: string, tone?: StatusMessageTone, duration?: number) => void;
};

type MetadataSyncTarget = {
  blob: BlossomBlob;
  folderPath: string | null;
};

export const FolderRenameDialog: React.FC<FolderRenameDialogProps> = ({ path, onClose, onStatus }) => {
  const { renameFolder, getFolderDisplayName, foldersByPath, getFoldersForBlob } = useFolderLists();
  const { ndk, signer } = useNdk();
  const { effectiveRelays } = usePreferredRelays();
  const { aggregated, currentSnapshot, privateBlobs } = useWorkspace();
  const [name, setName] = useState(() => getFolderDisplayName(path));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const resolveBlobBySha = useCallback(
    (sha: string): BlossomBlob | null => {
      if (!sha) return null;
      const normalized = sha.trim();
      if (!normalized) return null;
      const sources: (readonly BlossomBlob[] | undefined | null)[] = [
        aggregated?.blobs,
        currentSnapshot?.blobs,
        privateBlobs,
      ];
      for (const source of sources) {
        if (!source) continue;
        const match = source.find(candidate => candidate?.sha256 === normalized);
        if (match) {
          return match;
        }
      }
      return null;
    },
    [aggregated?.blobs, currentSnapshot?.blobs, privateBlobs]
  );

  const syncMetadata = useCallback(
    (targets: MetadataSyncTarget[]) => {
      if (!ndk || !signer) return;
      if (!targets.length) return;
      void (async () => {
        let successCount = 0;
        let failureCount = 0;
        for (const target of targets) {
          try {
            const alias = getBlobMetadataName(target.blob) ?? target.blob.name ?? null;
            const extraTags = extractExtraNip94Tags(target.blob.nip94);
            await publishNip94Metadata({
              ndk,
              signer,
              blob: target.blob,
              relays: effectiveRelays,
              alias,
              folderPath: target.folderPath,
              extraTags,
            });
            successCount += 1;
          } catch (error) {
            failureCount += 1;
            console.warn("Failed to sync NIP-94 metadata for folder rename", target.blob.sha256, error);
          }
        }
        if (failureCount === 0) {
          onStatus(
            successCount === 1 ? "Synced metadata for 1 item." : `Synced metadata for ${successCount} items.`,
            "success",
            3000
          );
        } else {
          onStatus(
            failureCount === 1
              ? "Failed to sync metadata to relays."
              : `Failed to sync metadata for ${failureCount} items.`,
            "error",
            4500
          );
        }
      })();
    },
    [effectiveRelays, ndk, onStatus, signer]
  );

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

    const impactedRecords = Array.from(foldersByPath.values()).filter(record => {
      if (!record?.path) return false;
      return record.path === path || record.path.startsWith(`${path}/`);
    });
    const shasToSync = new Set<string>();
    impactedRecords.forEach(record => {
      record.shas.forEach(sha => {
        if (sha) shasToSync.add(sha);
      });
    });

    setBusy(true);
    try {
      await renameFolder(path, trimmed);
      onStatus("Folder renamed. Syncing metadata…", "success", 2500);

      if (shasToSync.size > 0) {
        const targets: MetadataSyncTarget[] = [];
        shasToSync.forEach(sha => {
          const blob = resolveBlobBySha(sha);
          if (!blob || blob.privateData) return;
          const folders = getFoldersForBlob(sha);
          const destination = folders && folders.length > 0 ? folders[0] : null;
          const normalizedDestination = destination && destination.length > 0 ? destination : null;
          targets.push({ blob, folderPath: normalizedDestination });
        });
        if (targets.length) {
          syncMetadata(targets);
        }
      }

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Rename failed.";
      setError(message);
      onStatus(message, "error", 4000);
    } finally {
      setBusy(false);
    }
  }, [foldersByPath, getFoldersForBlob, name, onClose, onStatus, path, renameFolder, resolveBlobBySha, syncMetadata]);

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
