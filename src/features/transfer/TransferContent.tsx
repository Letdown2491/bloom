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
  currentTransfers: TransferState[];
  transferPhase: "idle" | "transferring" | "completed" | "attention";
  toggleTransferTarget: (url: string) => void;
  handleStartTransfer: () => void;
  onBackToBrowse: () => void;
  onResetTransfer: () => void;
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
  currentTransfers,
  transferPhase,
  toggleTransferTarget,
  handleStartTransfer,
  onBackToBrowse,
  onResetTransfer,
  currentSignerMissing,
  syncedServerCount = 0,
  syncedServerTotal = 0,
  fullySyncedServerUrls = new Set<string>(),
}) => {
  const serverNameMap = React.useMemo(
    () => new Map(localServers.map(server => [server.url, server.name])),
    [localServers],
  );
  const pendingServerCount = React.useMemo(() => {
    if (transferTargets.length === 0) return 0;
    return transferTargets.reduce(
      (count, url) => (fullySyncedServerUrls.has(url) ? count : count + 1),
      0,
    );
  }, [fullySyncedServerUrls, transferTargets]);
  const disableTransferAction =
    transferBusy ||
    transferTargets.length === 0 ||
    selectedBlobItems.length === 0 ||
    localServers.length <= 1;
  const showSetupContent = transferPhase === "idle" || transferPhase === "attention";
  const readOnlyMode = transferPhase === "transferring" || transferPhase === "completed";
  const transferTotals = React.useMemo(() => {
    if (currentTransfers.length === 0) {
      return {
        total: 0,
        completed: 0,
        errors: 0,
        pending: 0,
        transferredBytes: 0,
        totalBytes: 0,
        percent: 0,
      };
    }
    let completed = 0;
    let errors = 0;
    let pending = 0;
    let transferredBytes = 0;
    let totalBytes = 0;
    currentTransfers.forEach(item => {
      if (item.status === "success") completed += 1;
      else if (item.status === "error") errors += 1;
      else pending += 1;
      const total = item.total > 0 ? item.total : item.transferred > 0 ? item.transferred : 0;
      const transferred =
        item.transferred > 0 ? Math.min(item.transferred, total || item.transferred) : 0;
      totalBytes += total;
      transferredBytes += transferred;
    });
    const percent =
      totalBytes > 0
        ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
        : Math.min(100, Math.round((completed / currentTransfers.length) * 100));
    return {
      total: currentTransfers.length,
      completed,
      errors,
      pending,
      transferredBytes,
      totalBytes,
      percent,
    };
  }, [currentTransfers]);
  const transferTargetNames = React.useMemo(() => {
    const labels = new Set<string>();
    const append = (url: string) => {
      const label = serverNameMap.get(url) || url;
      if (label.trim()) labels.add(label);
    };
    if (currentTransfers.length > 0) {
      currentTransfers.forEach(item => append(item.serverUrl));
    } else {
      transferTargets.forEach(url => append(url));
    }
    return Array.from(labels).join(", ");
  }, [currentTransfers, serverNameMap, transferTargets]);
  const statusBanner = React.useMemo(() => {
    if (transferPhase === "transferring") {
      return (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold">Transferring files</span>
              <span className="text-xs text-emerald-100/80">
                {transferTargetNames
                  ? `Sending to ${transferTargetNames}.`
                  : "Sending to your selected servers."}
              </span>
            </div>
            <span className="rounded-full bg-emerald-500/30 px-3 py-1 text-xs font-semibold text-emerald-50">
              {transferTotals.percent}% complete
            </span>
          </div>
          <p className="mt-2 text-xs text-emerald-100/80">
            Setup controls are hidden while transfers finish. Track progress above.
          </p>
        </div>
      );
    }
    if (transferPhase === "completed") {
      return (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-4 text-emerald-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold">Transfers complete</span>
              <span className="text-xs text-emerald-100/80">
                {`Transferred ${transferTotals.completed} ${transferTotals.completed === 1 ? "item" : "items"} (${prettyBytes(
                  transferTotals.totalBytes,
                )})${transferTargetNames ? ` to ${transferTargetNames}` : ""}.`}
              </span>
            </div>
            <button
              type="button"
              onClick={onResetTransfer}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400"
            >
              Start new transfer
            </button>
          </div>
          <p className="mt-2 text-xs text-emerald-100/80">
            You can keep this summary for reference or reset to prepare a new batch.
          </p>
        </div>
      );
    }
    if (transferPhase === "attention") {
      return (
        <div className="rounded-xl border border-amber-400/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <span className="text-sm font-semibold">Transfers need attention</span>
          <p className="mt-1 text-xs text-amber-100/80">
            Review the items below to retry the failed transfers.
          </p>
        </div>
      );
    }
    return null;
  }, [onResetTransfer, transferPhase, transferTargetNames, transferTotals]);
  const activityTitle =
    transferPhase === "transferring"
      ? "Transfer progress"
      : transferPhase === "completed"
        ? "Transfer summary"
        : "Transfer activity";
  const activityCard =
    transferActivity.length > 0 ? (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-100">{activityTitle}</div>
          {transferPhase !== "idle" ? (
            <div className="text-xs text-slate-400">
              {transferTotals.completed} completed · {transferTotals.pending} in progress ·{" "}
              {transferTotals.errors} errors
            </div>
          ) : null}
        </div>
        {transferPhase !== "idle" && transferTotals.totalBytes > 0 ? (
          <div className="text-xs text-slate-500">
            {prettyBytes(transferTotals.transferredBytes)} /{" "}
            {prettyBytes(transferTotals.totalBytes)} copied
          </div>
        ) : null}
        <div className="space-y-3">
          {transferActivity.map(item => {
            const percent = item.total > 0 ? Math.round((item.transferred / item.total) * 100) : 0;
            const label = serverNameMap.get(item.serverUrl) || item.serverUrl;
            return (
              <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
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
    ) : null;
  const selectionSummary =
    selectedBlobItems.length === 0 ? (
      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
        Choose one or more files in Browse, then return here to send them to another server.
      </div>
    ) : (
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
        <div className="text-xs text-slate-400">
          {pendingServerCount === 0
            ? "All selected destination servers already have these files."
            : `Transferring files to ${pendingServerCount} destination ${pendingServerCount === 1 ? "server" : "servers"}.`}
        </div>
        {missingSourceCount > 0 && (
          <div className="text-xs text-amber-300">
            {missingSourceCount} item{missingSourceCount === 1 ? "" : "s"} could not be fetched
            right now.
          </div>
        )}
        <ul className="mt-1 space-y-1 text-xs text-slate-400">
          {selectedBlobItems.slice(0, 6).map(item => (
            <li key={item.blob.sha256} className="flex items-center justify-between gap-3">
              <span className="truncate">{getBlobMetadataName(item.blob) ?? item.blob.sha256}</span>
              <span>{prettyBytes(item.blob.size || 0)}</span>
            </li>
          ))}
          {selectedBlobItems.length > 6 && (
            <li className="text-xs text-slate-500">+ {selectedBlobItems.length - 6} more</li>
          )}
        </ul>
      </div>
    );

  return (
    <div className="space-y-6">
      {transferPhase !== "idle" ? activityCard : null}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Transfer files</h2>
          <p className="text-sm text-slate-400">
            Select where Bloom should copy the files you picked in Browse.
          </p>
        </div>
        {statusBanner}
        {selectionSummary}
        {!showSetupContent && transferPhase === "transferring" && selectedBlobItems.length > 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 text-xs text-slate-400">
            Destinations are locked while transfers run. Monitor progress above.
          </div>
        ) : null}
        {showSetupContent && selectedBlobItems.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-slate-500">Destination servers</h3>
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
                    readOnlyMode ||
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
        ) : null}
        {transferFeedback && (
          <div className={`text-sm ${transferFeedbackTone}`}>{transferFeedback}</div>
        )}
        <div className="flex flex-wrap gap-3">
          {showSetupContent ? (
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
          ) : null}
          <button
            onClick={onBackToBrowse}
            className="px-4 py-2 rounded-xl border border-slate-800 bg-slate-900/60 text-sm text-slate-300 hover:border-slate-700"
          >
            Go Back Home
          </button>
        </div>
      </div>
      {transferPhase === "idle" ? activityCard : null}
    </div>
  );
};
