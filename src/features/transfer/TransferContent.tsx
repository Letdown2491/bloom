import React from "react";
import { prettyBytes } from "../../shared/utils/format";
import { getBlobMetadataName } from "../../shared/utils/blobMetadataStore";
import type { ManagedServer } from "../../shared/types/servers";
import type { BlossomBlob } from "../../shared/api/blossomClient";
import type { TransferState } from "../workspace/ui/UploadPanel";

type SelectedBlobItem = {
  blob: BlossomBlob;
  server: ManagedServer;
};

export type TransferContentProps = {
  localServers: ManagedServer[];
  selectedServer: string | null;
  selectedBlobItems: SelectedBlobItem[];
  selectedBlobTotalSize: number;
  sourceServerUrls: Set<string>;
  missingSourceCount: number;
  transferTargets: string[];
  transferBusy: boolean;
  transferFeedback: string | null;
  transferFeedbackTone: string;
  transferActivity: TransferState[];
  toggleTransferTarget: (url: string) => void;
  handleStartTransfer: () => void;
  onBackToBrowse: () => void;
  currentSignerMissing: boolean;
  syncedServerCount?: number;
  syncedServerTotal?: number;
  fullySyncedServerUrls?: Set<string>;
};

export const TransferContent: React.FC<TransferContentProps> = ({
  localServers,
  selectedServer,
  selectedBlobItems,
  selectedBlobTotalSize,
  sourceServerUrls,
  missingSourceCount,
  transferTargets,
  transferBusy,
  transferFeedback,
  transferFeedbackTone,
  transferActivity,
  toggleTransferTarget,
  handleStartTransfer,
  onBackToBrowse,
  currentSignerMissing,
  syncedServerCount = 0,
  syncedServerTotal = 0,
  fullySyncedServerUrls = new Set<string>(),
}) => {
  const serverNameMap = React.useMemo(
    () => new Map(localServers.map(server => [server.url, server.name])),
    [localServers],
  );
  const disableTransferAction =
    transferBusy ||
    transferTargets.length === 0 ||
    selectedBlobItems.length === 0 ||
    localServers.length <= 1;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Transfer files</h2>
          <p className="text-sm text-slate-400">
            Select where Bloom should copy the files you picked in Browse.
          </p>
        </div>
        {selectedBlobItems.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
            Choose one or more files in Browse, then return here to send them to another server.
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 space-y-2 text-sm text-slate-200">
              <div className="flex flex-wrap gap-4 text-slate-200">
                <span>
                  {selectedBlobItems.length} item{selectedBlobItems.length === 1 ? "" : "s"}
                </span>
                <span>{prettyBytes(selectedBlobTotalSize)}</span>
              </div>
              <div className="text-xs uppercase tracking-wide text-slate-500">
                From{" "}
                {Array.from(sourceServerUrls)
                  .map(url => serverNameMap.get(url) || url)
                  .join(", ") || "unknown server"}
              </div>
              {selectedBlobItems.length > 0 && syncedServerTotal > 1 && (
                <div
                  className={`text-xs ${
                    syncedServerCount === syncedServerTotal
                      ? "text-emerald-300"
                      : syncedServerCount === 0
                        ? "text-amber-300"
                        : "text-slate-400"
                  }`}
                >
                  {syncedServerCount === syncedServerTotal
                    ? "Synced across all destination servers."
                    : syncedServerCount === 0
                      ? "No destination server currently has every selected file."
                      : `All selected files are available on ${syncedServerCount} of ${syncedServerTotal} destination servers.`}
                </div>
              )}
              {missingSourceCount > 0 && (
                <div className="text-xs text-amber-300">
                  {missingSourceCount} item{missingSourceCount === 1 ? "" : "s"} could not be
                  fetched right now.
                </div>
              )}
              <ul className="mt-1 space-y-1 text-xs text-slate-400">
                {selectedBlobItems.slice(0, 6).map(item => (
                  <li key={item.blob.sha256} className="flex items-center justify-between gap-3">
                    <span className="truncate">
                      {getBlobMetadataName(item.blob) ?? item.blob.sha256}
                    </span>
                    <span>{prettyBytes(item.blob.size || 0)}</span>
                  </li>
                ))}
                {selectedBlobItems.length > 6 && (
                  <li className="text-xs text-slate-500">+ {selectedBlobItems.length - 6} more</li>
                )}
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="text-xs uppercase tracking-wide text-slate-500">
                Destination servers
              </h3>
              {localServers.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-400">
                  Add a server in the Servers tab before transferring.
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {localServers.map(server => {
                    const isChecked = transferTargets.includes(server.url);
                    const requiresSigner = Boolean(server.requiresAuth);
                    const disabled =
                      localServers.length <= 1 ||
                      server.url === selectedServer ||
                      fullySyncedServerUrls.has(server.url);
                    return (
                      <label
                        key={server.url}
                        className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition ${
                          isChecked
                            ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                            : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                        } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
                        aria-disabled={disabled}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{server.name}</div>
                          <div className="text-xs text-slate-500 truncate">{server.url}</div>
                          {requiresSigner && currentSignerMissing && (
                            <div className="mt-1 text-[11px] text-amber-300">Signer required</div>
                          )}
                        </div>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          checked={isChecked}
                          disabled={disabled}
                          onChange={() => toggleTransferTarget(server.url)}
                        />
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            {transferFeedback && (
              <div className={`text-sm ${transferFeedbackTone}`}>{transferFeedback}</div>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleStartTransfer}
                disabled={disableTransferAction}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  disableTransferAction
                    ? "cursor-not-allowed border border-slate-800 bg-slate-900/60 text-slate-500"
                    : "border border-emerald-500 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                }`}
              >
                {transferBusy ? "Transferring…" : "Start Transfer"}
              </button>
              <button
                onClick={onBackToBrowse}
                className="px-4 py-2 rounded-xl border border-slate-800 bg-slate-900/60 text-sm text-slate-300 hover:border-slate-700"
              >
                Go Back Home
              </button>
            </div>
          </>
        )}
      </div>
      {transferActivity.length > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-4">
          <div className="text-sm font-semibold text-slate-100">Transfer activity</div>
          <div className="space-y-3">
            {transferActivity.map(item => {
              const percent =
                item.total > 0 ? Math.round((item.transferred / item.total) * 100) : 0;
              const label = serverNameMap.get(item.serverUrl) || item.serverUrl;
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-200">
                    <span className="truncate font-medium">{item.fileName}</span>
                    <span className="text-xs text-slate-500">{label}</span>
                  </div>
                  {item.status === "uploading" && (
                    <div className="mt-2">
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>{percent}%</span>
                        <span>
                          {prettyBytes(item.transferred)} / {prettyBytes(item.total)}
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-slate-800">
                        <div
                          className="h-2 rounded-full bg-emerald-500"
                          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {item.status === "success" && (
                    <div className="mt-2 text-xs text-emerald-300">Transfer complete.</div>
                  )}
                  {item.status === "error" && (
                    <div className="mt-2 text-xs text-red-400">
                      {item.message || "Transfer failed"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
