import React from "react";
import type { NDKUser } from "@nostr-dev-kit/ndk";

import { LogoutIcon } from "./icons";

type UserMenuLink = {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  handler: () => void;
};

type AppTopBarProps = {
  user: NDKUser | null;
  avatarUrl: string | null;
  userInitials: string;
  isUserMenuOpen: boolean;
  userMenuLinks: UserMenuLink[];
  onAvatarError: () => void;
  onToggleUserMenu: () => void;
  onDisconnect: () => void;
  showAuthPrompt: boolean;
  menuRef: React.RefObject<HTMLDivElement>;
};

const AppTopBarComponent: React.FC<AppTopBarProps> = ({
  user,
  avatarUrl,
  userInitials,
  isUserMenuOpen,
  userMenuLinks,
  onAvatarError,
  onToggleUserMenu,
  onDisconnect,
  showAuthPrompt,
  menuRef,
}) => {
  return (
    <header className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-3">
        <img src="/bloom.webp" alt="Bloom logo" className="h-10 w-10 rounded-xl object-cover" />
        <div>
          <h1 className="text-2xl font-semibold">Bloom</h1>
          <p className="hidden md:block text-xs text-slate-400">
            Manage your content, upload media, and mirror files across servers.
          </p>
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
        {user && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={onToggleUserMenu}
              className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-800 bg-slate-900/70 p-0 text-xs text-slate-200 transition hover:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              aria-haspopup="menu"
              aria-expanded={isUserMenuOpen}
              disabled={showAuthPrompt}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="User avatar" className="block h-full w-full object-cover" onError={onAvatarError} />
              ) : (
                <span className="font-semibold">{userInitials}</span>
              )}
            </button>
            {isUserMenuOpen && (
              <div className="absolute right-0 z-50 mt-2 min-w-[10rem] rounded-md bg-slate-900 px-2 py-2 text-sm shadow-lg">
                <div className="flex flex-col gap-2 text-slate-200">
                  <ul className="flex flex-col gap-1">
                    {userMenuLinks.map(item => {
                      const Icon = item.icon;
                      return (
                        <li key={item.label}>
                          <a
                            href="#"
                            onClick={event => {
                              event.preventDefault();
                              item.handler();
                            }}
                            className="flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-800/70 hover:text-emerald-300"
                          >
                            <Icon size={16} />
                            <span>{item.label}</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="border-t border-slate-800 pt-2">
                    <button
                      type="button"
                      onClick={onDisconnect}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition hover:bg-slate-800/70 hover:text-emerald-300"
                    >
                      <LogoutIcon size={16} />
                      <span>Disconnect</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
};

export const AppTopBar = React.memo(AppTopBarComponent);
