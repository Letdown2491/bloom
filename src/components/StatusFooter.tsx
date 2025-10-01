import React, { memo } from "react";

import type { ManagedServer } from "../hooks/useServers";
import { prettyBytes } from "../utils/format";
import { ServersIcon, BellIcon, GithubIcon, LightningIcon } from "./icons";

type StatusFooterProps = {
  isSignedIn: boolean;
  localServers: ManagedServer[];
  statusSelectValue: string;
  onStatusServerChange: React.ChangeEventHandler<HTMLSelectElement>;
  centerClass: string;
  centerMessage: string | null | undefined;
  showStatusTotals: boolean;
  showServerSelector: boolean;
  statusCount: number;
  statusSize: number;
  allServersValue: string;
  showGithubLink: boolean;
  showSupportLink: boolean;
};

export const StatusFooter = memo(function StatusFooter({
  isSignedIn,
  localServers,
  statusSelectValue,
  onStatusServerChange,
  centerClass,
  centerMessage,
  showStatusTotals,
  showServerSelector,
  statusCount,
  statusSize,
  allServersValue,
  showGithubLink,
  showSupportLink,
}: StatusFooterProps) {
  if (!isSignedIn) {
    return (
      <footer
        className="relative border-t border-slate-800 bg-slate-900/70 px-4 py-3 min-h-12"
        aria-hidden="true"
      />
    );
  }

  return (
    <footer className="relative border-t border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-4 min-h-12">
      {showGithubLink && (
        <a
          href="https://github.com/Letdown2491/bloom"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-slate-200 transition hover:text-emerald-300"
        >
          <GithubIcon size={16} aria-hidden="true" />
          <span className="font-medium">Github</span>
        </a>
      )}

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center">
        {centerMessage ? (
          <span className={`inline-flex items-center gap-2 font-semibold ${centerClass}`}>
            <BellIcon size={14} aria-hidden="true" />
            <span>{centerMessage}</span>
          </span>
        ) : null}
      </div>

      {showServerSelector && (
        <div className="flex items-center gap-2">
          <label htmlFor="status-server" className="flex items-center text-slate-300" aria-label="Server selector">
            <span className="sr-only">Server</span>
            <ServersIcon size={14} aria-hidden="true" />
          </label>
          {localServers.length <= 1 ? (
            <span className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200">
              {localServers[0]?.name || "All servers"}
            </span>
          ) : (
            <select
              id="status-server"
              value={statusSelectValue}
              onChange={onStatusServerChange}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value={allServersValue}>All servers</option>
              {localServers.map(server => (
                <option key={server.url} value={server.url}>
                  {server.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {(showStatusTotals || showSupportLink) && (
        <div className="ml-auto flex items-center gap-4">
          {showStatusTotals && (
            <div className="flex gap-4">
              <span>
                {statusCount} item{statusCount === 1 ? "" : "s"}
              </span>
              <span>{prettyBytes(statusSize)}</span>
            </div>
          )}

          {showSupportLink && (
            <a
              href="https://getalby.com/p/invincibleperfection384952"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-amber-200 transition hover:border-amber-300 hover:text-amber-100"
            >
              <LightningIcon size={14} aria-hidden="true" />
              <span className="font-medium">Support Bloom</span>
            </a>
          )}
        </div>
      )}
    </footer>
  );
});

StatusFooter.displayName = "StatusFooter";

export default StatusFooter;
