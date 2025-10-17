import React, { memo } from "react";

import type { ManagedServer } from "../types/servers";
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
  theme: "dark" | "light";
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
  theme,
}: StatusFooterProps) {
  if (!isSignedIn) {
    return (
      <footer className="border-t border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-4">
          <a
            href="https://github.com/Letdown2491/bloom"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-slate-200 transition hover:text-emerald-300"
          >
            <GithubIcon size={16} aria-hidden="true" />
            <span className="font-medium">GitHub</span>
          </a>
          <a
            href="https://getalby.com/p/invincibleperfection384952"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-slate-200 transition hover:text-emerald-300"
          >
            <LightningIcon size={16} aria-hidden="true" />
            <span className="font-medium">Donate</span>
          </a>
        </div>
      </footer>
    );
  }

  const serverTextClass = theme === "light" ? "text-slate-700" : "text-slate-300";
  const serverBadgeClass =
    theme === "light"
      ? "rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
      : "rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200";
  const serverSelectClass =
    theme === "light"
      ? "rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
      : "rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

  const donateLinkClass =
    theme === "light"
      ? "flex items-center gap-2 rounded-lg px-3 py-1 text-slate-200 transition hover:text-emerald-300"
      : "flex items-center gap-2 rounded-lg px-3 py-1 text-slate-200 transition hover:text-emerald-300";

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
          <label
            htmlFor="status-server"
            className={`flex items-center ${serverTextClass}`}
            aria-label="Server selector"
          >
            <span className="sr-only">Server</span>
            <ServersIcon size={14} aria-hidden="true" />
          </label>
          {localServers.length <= 1 ? (
            <span className={serverBadgeClass}>
              {localServers[0]?.name || "All servers"}
            </span>
          ) : (
            <select
              id="status-server"
              value={statusSelectValue}
              onChange={onStatusServerChange}
              className={serverSelectClass}
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
              className={donateLinkClass}
            >
              <LightningIcon size={16} aria-hidden="true" />
              <span className="font-medium">Donate</span>
            </a>
          )}
        </div>
      )}
    </footer>
  );
});

StatusFooter.displayName = "StatusFooter";

export default StatusFooter;
