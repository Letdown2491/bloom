import React from "react";

import type { ManagedServer } from "../types/servers";
import { BellIcon } from "./icons";
import { prettyBytes } from "../utils/format";

type AppFooterProps = {
  servers: ManagedServer[];
  selectedServerValue: string;
  onSelectServer: React.ChangeEventHandler<HTMLSelectElement>;
  centerMessage: string | null;
  centerClassName: string;
  statusCount: number;
  statusSize: number;
  allServersValue: string;
};

const AppFooterComponent: React.FC<AppFooterProps> = ({
  servers,
  selectedServerValue,
  onSelectServer,
  centerMessage,
  centerClassName,
  statusCount,
  statusSize,
  allServersValue,
}) => {
  return (
    <footer className="border-t border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <label htmlFor="status-server" className="text-[11px] uppercase tracking-wide text-slate-300">
          Server
        </label>
        <select
          id="status-server"
          value={selectedServerValue}
          onChange={onSelectServer}
          className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
        >
          <option value={allServersValue}>All servers</option>
          {servers.map(server => (
            <option key={server.url} value={server.url}>
              {server.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1 flex justify-center">
        {centerMessage ? (
          <span className={`flex items-center gap-2 ${centerClassName}`}>
            <BellIcon size={14} />
            <span className="font-semibold">{centerMessage}</span>
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex gap-4">
        <span>
          {statusCount} item{statusCount === 1 ? "" : "s"}
        </span>
        <span>{prettyBytes(statusSize)}</span>
      </div>
    </footer>
  );
};

export const AppFooter = React.memo(AppFooterComponent);
