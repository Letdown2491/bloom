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

  const lightFocusRing = "focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white";
  const serverSelectClass =
    theme === "light"
      ? `rounded-lg border border-slate-200 bg-white/90 px-2 py-1.5 text-xs text-slate-700 transition hover:border-blue-400 focus:outline-none sm:px-3 ${lightFocusRing}`
      : "rounded-lg border border-slate-800/70 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-200 transition hover:border-emerald-400 focus:outline-none focus-visible:focus-emerald-ring sm:px-3";
  const settingsButtonClass =
    theme === "light"
      ? `flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white/90 text-slate-600 transition hover:border-blue-400 hover:text-blue-700 focus:outline-none ${lightFocusRing}`
      : "flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800/70 bg-slate-900/70 text-slate-300 transition hover:border-emerald-400 hover:text-emerald-300 focus:outline-none focus-visible:focus-emerald-ring";
  const serverArrowClass = theme === "light" ? "text-slate-500" : "text-slate-400";

  const donateLinkClass =
    theme === "light"
      ? `flex items-center gap-2 rounded-xl border border-slate-200 bg-white/90 px-3 py-1.5 text-slate-700 transition hover:border-blue-400 hover:text-blue-700 ${lightFocusRing}`
      : "flex items-center gap-2 rounded-xl border border-slate-800/60 bg-slate-900/50 px-3 py-1.5 text-slate-200 transition hover:border-emerald-400 hover:text-emerald-300 focus-visible:focus-emerald-ring";

  const statusTotalsContainerClass =
    theme === "light"
      ? "flex items-center gap-3 rounded-xl border border-slate-200 bg-white/90 px-3 py-1.5 text-slate-700 shadow-toolbar"
      : "flex items-center gap-3 rounded-xl border border-slate-800/60 bg-slate-900/40 px-3 py-1.5 text-slate-200 shadow-toolbar";
  const statusTotalsItemClass = theme === "light" ? "flex items-center gap-1" : "flex items-center gap-1 text-slate-200";
  const statusTotalsSizeClass =
    theme === "light" ? "flex items-center gap-1 text-blue-700" : "flex items-center gap-1 text-emerald-300";

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
      <footer className="relative flex w-full flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800/70 surface-floating px-4 py-3 text-xs text-slate-300 shadow-floating">
        <div className="flex w-full flex-wrap items-center gap-4">
          <a
            href="https://github.com/Letdown2491/bloom"
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-slate-200 transition ${
              theme === "light" ? `${lightFocusRing} hover:text-blue-700` : "hover:text-emerald-300 focus-visible:focus-emerald-ring"
            }`}
          >
            <GithubIcon size={16} aria-hidden="true" />
            <span className="font-medium">GitHub</span>
          </a>
          <a
            href="https://getalby.com/p/geek"
            target="_blank"
            rel="noopener noreferrer"
            className={`ml-auto flex items-center gap-2 rounded-xl px-3 py-1.5 text-slate-200 transition ${
              theme === "light" ? `${lightFocusRing} hover:text-blue-700` : "hover:text-emerald-300 focus-visible:focus-emerald-ring"
            }`}
          >
            <LightningIcon size={16} aria-hidden="true" />
            <span className="font-medium">Donate</span>
          </a>
        </div>
      </footer>
    );
  }

  return (
    <footer className="relative flex min-h-12 flex-wrap items-center gap-4 rounded-2xl border border-slate-800/70 surface-floating px-4 py-3 text-xs text-slate-300 shadow-floating md:flex-nowrap">
      {showServerSelector && (
        <div className="flex shrink-0 items-center gap-2">
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
              className={`${settingsButtonClass} hidden sm:flex`}
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
                    ? "absolute bottom-full left-0 z-50 mb-2 min-w-[10rem] rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-700 shadow-lg backdrop-blur-sm"
                    : "absolute bottom-full left-0 z-50 mb-2 min-w-[10rem] rounded-xl border border-slate-800/80 bg-slate-900/95 px-3 py-2 text-sm text-slate-200 shadow-floating backdrop-blur"
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
                            ? `flex w-full items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-100 hover:text-blue-700 ${lightFocusRing}`
                            : "flex w-full items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800/70 hover:text-emerald-300 focus-visible:focus-emerald-ring"
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
                            ? `flex w-full items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-100 hover:text-blue-700 ${lightFocusRing}`
                            : "flex w-full items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800/70 hover:text-emerald-300 focus-visible:focus-emerald-ring"
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
              className={`${serverSelectClass} flex h-8 w-10 items-center justify-center shadow-toolbar sm:w-auto sm:justify-between sm:gap-2 sm:pl-3 sm:pr-7`}
            >
              <span className="flex flex-1 items-center justify-center sm:justify-start">
                <ServersIcon size={14} aria-hidden="true" />
              </span>
              <span className="hidden sm:inline-flex sm:pl-2 sm:text-left sm:whitespace-nowrap">{currentServerLabel}</span>
              <span className={`hidden items-center ${serverArrowClass} sm:flex`}>
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
                    ? "absolute bottom-full left-0 z-50 mb-2 min-w-[12rem] rounded-xl border border-slate-200 bg-white/95 py-2 text-sm text-slate-700 shadow-lg backdrop-blur-sm"
                    : "absolute bottom-full left-0 z-50 mb-2 min-w-[12rem] rounded-xl border border-slate-800/80 bg-slate-900/95 py-2 text-sm text-slate-200 shadow-floating backdrop-blur"
                }
              >
                <ul className="flex flex-col gap-1 px-1">
                  {serverOptions.map(option => {
                    const selected = option.value === statusSelectValue;
                    const baseClass =
                      theme === "light"
                        ? `flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-700 transition hover:bg-slate-100 hover:text-blue-700 ${lightFocusRing}`
                        : "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-slate-200 transition hover:bg-slate-800/70 hover:text-emerald-300 focus-visible:focus-emerald-ring";
                    const selectedClass = selected
                      ? theme === "light"
                        ? " bg-blue-100 text-blue-700"
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

      <div className="pointer-events-none absolute inset-0 hidden items-center justify-center px-4 text-center sm:flex">
        {centerMessage ? (
          <span
            className={`inline-flex items-center gap-2 rounded-xl px-3 py-1.5 font-semibold shadow-toolbar ${
              theme === "light"
                ? "bg-blue-100 text-blue-700"
                : "bg-emerald-500/10 text-emerald-200"
            } ${centerClass}`}
          >
            <BellIcon size={14} aria-hidden="true" />
            <span>{centerMessage}</span>
          </span>
        ) : null}
      </div>

      {showGithubLink && (
        <a
          href="https://github.com/Letdown2491/bloom"
          target="_blank"
          rel="noopener noreferrer"
          className={`hidden shrink-0 items-center gap-2 rounded-xl px-3 py-1.5 text-slate-200 transition sm:flex ${
            theme === "light" ? `${lightFocusRing} hover:text-blue-700` : "hover:text-emerald-300 focus-visible:focus-emerald-ring"
          }`}
        >
          <GithubIcon size={16} aria-hidden="true" />
          <span className="font-medium">Github</span>
        </a>
      )}

      {(showStatusTotals || showSupportLink) && (
        <div className="ml-auto hidden shrink-0 items-center gap-4 sm:flex">
          {showStatusTotals && (
            <div className={statusTotalsContainerClass}>
              <span className={statusTotalsItemClass}>
                {statusCount} item{statusCount === 1 ? "" : "s"}
              </span>
              <span className={statusTotalsSizeClass}>{prettyBytes(statusSize)}</span>
            </div>
          )}

          {showSupportLink && (
            <a
            href="https://getalby.com/p/geek"
              target="_blank"
              rel="noopener noreferrer"
              className={`${donateLinkClass} hidden sm:flex`}
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
