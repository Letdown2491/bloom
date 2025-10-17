import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ManagedServer } from "../types/servers";
import { prettyBytes } from "../utils/format";
import {
  ServersIcon,
  BellIcon,
  GithubIcon,
  LightningIcon,
  SettingsIcon,
  LogoutIcon,
  ChevronDownIcon,
} from "./icons";

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
  userMenuItems: Array<{
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    handler: () => void;
  }>;
  onDisconnect?: () => void;
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
  userMenuItems,
  onDisconnect,
}: StatusFooterProps) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLAnchorElement | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const serverButtonRef = useRef<HTMLButtonElement | null>(null);
  const serverMenuRef = useRef<HTMLDivElement | null>(null);

  const closeSettingsMenu = useCallback(() => setSettingsMenuOpen(false), []);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !settingsButtonRef.current?.contains(target) &&
        !settingsMenuRef.current?.contains(target)
      ) {
        setSettingsMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsMenuOpen]);

  useEffect(() => {
    if (!serverMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !serverButtonRef.current?.contains(target) &&
        !serverMenuRef.current?.contains(target)
      ) {
        setServerMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setServerMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [serverMenuOpen]);

  useEffect(() => {
    if (!showServerSelector) {
      setServerMenuOpen(false);
    }
  }, [showServerSelector]);

  const handleServerSelect = useCallback(
    (value: string) => {
      setServerMenuOpen(false);
      if (value === statusSelectValue) {
        return;
      }
      onStatusServerChange({
        target: { value },
      } as React.ChangeEvent<HTMLSelectElement>);
    },
    [onStatusServerChange, statusSelectValue]
  );

  const serverSelectClass =
    theme === "light"
      ? "rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 transition focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
      : "rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 transition focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
  const settingsButtonClass =
    theme === "light"
      ? "flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 transition hover:border-emerald-400 hover:text-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
      : "flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 transition hover:border-emerald-400 hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900";
  const serverArrowClass = theme === "light" ? "text-slate-500" : "text-slate-400";

  const donateLinkClass =
    theme === "light"
      ? "flex items-center gap-2 rounded-lg px-3 py-1 text-slate-200 transition hover:text-emerald-300"
      : "flex items-center gap-2 rounded-lg px-3 py-1 text-slate-200 transition hover:text-emerald-300";

  const serverOptions = useMemo(
    () => [
      { value: allServersValue, label: "All servers" },
      ...localServers.map(server => ({
        value: server.url,
        label: server.name || server.url,
      })),
    ],
    [allServersValue, localServers]
  );

  const currentServerLabel = useMemo(() => {
    const match = serverOptions.find(option => option.value === statusSelectValue);
    return match?.label ?? serverOptions[0]?.label ?? "All servers";
  }, [serverOptions, statusSelectValue]);

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
          <div className="relative">
            <a
              ref={settingsButtonRef}
              role="button"
              tabIndex={0}
              aria-haspopup="menu"
              aria-expanded={settingsMenuOpen}
              onClick={event => {
                event.preventDefault();
                setSettingsMenuOpen(open => !open);
              }}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSettingsMenuOpen(open => !open);
                }
              }}
              href="#"
              className={settingsButtonClass}
            >
              <SettingsIcon size={16} aria-hidden="true" />
              <span className="sr-only">Workspace menu</span>
            </a>
            {settingsMenuOpen ? (
              <div
                ref={settingsMenuRef}
                role="menu"
                className={
                  theme === "light"
                    ? "absolute bottom-full left-0 z-50 mb-2 min-w-[10rem] rounded-md bg-white px-2 py-2 text-sm text-slate-700 shadow-lg"
                    : "absolute bottom-full left-0 z-50 mb-2 min-w-[10rem] rounded-md bg-slate-900 px-2 py-2 text-sm text-slate-200 shadow-lg"
                }
              >
                <ul className="flex flex-col gap-1">
                  {userMenuItems.map(item => (
                    <li key={item.label}>
                      <a
                        role="menuitem"
                        href="#"
                        onClick={event => {
                          event.preventDefault();
                          closeSettingsMenu();
                          item.handler();
                        }}
                        className={
                          theme === "light"
                            ? "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-700 transition hover:bg-slate-100 hover:text-emerald-600"
                            : "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-200 transition hover:bg-slate-800/70 hover:text-emerald-300"
                        }
                      >
                        <item.icon size={16} />
                        <span>{item.label}</span>
                      </a>
                    </li>
                  ))}
                  {onDisconnect ? (
                    <li>
                      <a
                        role="menuitem"
                        href="#"
                        onClick={event => {
                          event.preventDefault();
                          closeSettingsMenu();
                          onDisconnect();
                        }}
                        className={
                          theme === "light"
                            ? "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-700 transition hover:bg-slate-100 hover:text-emerald-600"
                            : "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-200 transition hover:bg-slate-800/70 hover:text-emerald-300"
                        }
                      >
                        <LogoutIcon size={16} />
                        <span>Disconnect</span>
                      </a>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="relative">
            <button
              ref={serverButtonRef}
              type="button"
              id="status-server-trigger"
              aria-haspopup="listbox"
              aria-expanded={serverMenuOpen}
              onClick={() => setServerMenuOpen(open => !open)}
              className={`${serverSelectClass} flex h-8 items-center gap-2 pr-7`}
            >
              <ServersIcon size={14} aria-hidden="true" />
              <span className="max-w-[8rem] truncate text-left">{currentServerLabel}</span>
              <span className={`ml-auto flex items-center ${serverArrowClass}`}>
                <ChevronDownIcon size={12} aria-hidden="true" />
              </span>
            </button>
            {serverMenuOpen ? (
              <div
                ref={serverMenuRef}
                role="listbox"
                aria-labelledby="status-server-trigger"
                className={
                  theme === "light"
                    ? "absolute bottom-full left-0 z-50 mb-2 min-w-[12rem] rounded-md border border-slate-300 bg-white py-1 text-sm text-slate-700 shadow-lg"
                    : "absolute bottom-full left-0 z-50 mb-2 min-w-[12rem] rounded-md border border-slate-700 bg-slate-900/95 py-1 text-sm text-slate-200 shadow-xl backdrop-blur"
                }
              >
                <ul className="flex flex-col gap-1 px-1">
                  {serverOptions.map(option => {
                    const selected = option.value === statusSelectValue;
                    const baseClass =
                      theme === "light"
                        ? "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-700 transition hover:bg-slate-100 hover:text-emerald-600"
                        : "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-200 transition hover:bg-slate-800/70 hover:text-emerald-300";
                    const selectedClass = selected
                      ? theme === "light"
                        ? " bg-emerald-500/10 text-emerald-700"
                        : " bg-emerald-500/20 text-emerald-200"
                      : "";
                    return (
                      <li key={option.value}>
                        <a
                          role="option"
                          aria-selected={selected}
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleServerSelect(option.value);
                          }}
                          className={`${baseClass}${selectedClass}`}
                        >
                          <ServersIcon size={14} aria-hidden="true" />
                          <span className="truncate">{option.label}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
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
