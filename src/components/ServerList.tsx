import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagedServer } from "../hooks/useServers";
import { deriveServerNameFromUrl } from "../utils/serverName";
import { CancelIcon, EditIcon, FolderIcon, SaveIcon, TrashIcon } from "./icons";

export type ServerListProps = {
  servers: ManagedServer[];
  selected: string | null;
  defaultServerUrl: string | null;
  onSelect: (serverUrl: string | null) => void;
  onSetDefaultServer: (serverUrl: string | null) => void;
  onAdd: (server: ManagedServer) => void;
  onUpdate: (originalUrl: string, server: ManagedServer) => void;
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
  onRemove: (url: string) => void;
  onToggleAuth: (url: string, value: boolean) => void;
  onToggleSync: (url: string, value: boolean) => void;
  onSync?: () => void;
  syncDisabled?: boolean;
  syncInProgress?: boolean;
  validationError?: string | null;
};

type ServerDraft = {
  name: string;
  url: string;
  type: ManagedServer["type"];
  requiresAuth: boolean;
  sync: boolean;
};

const createEmptyDraft = (): ServerDraft => ({
  name: "",
  url: "https://",
  type: "blossom",
  requiresAuth: true,
  sync: false,
});

type ServerHealthStatus = "checking" | "online" | "auth" | "offline";

type ServerHealth = {
  status: ServerHealthStatus;
  checkedAt?: number;
  httpStatus?: number;
  latencyMs?: number;
  error?: string;
};

const HEALTH_CHECK_TIMEOUT_MS = 8000;
const HEALTH_RECHECK_TTL_MS = 5 * 60 * 1000;
const HEALTH_PENDING_GRACE_MS = 12 * 1000;

export const ServerList: React.FC<ServerListProps> = ({
  servers,
  selected,
  defaultServerUrl,
  onSelect,
  onSetDefaultServer,
  onAdd,
  onUpdate,
  onSave,
  saving,
  disabled,
  onRemove,
  onToggleAuth,
  onToggleSync,
  onSync,
  syncDisabled,
  syncInProgress,
  validationError,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(createEmptyDraft);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, ServerHealth>>({});
  const previousUrlsRef = useRef<string[]>([]);
  const activeControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingStartRef = useRef<Set<string>>(new Set());
  const controlsDisabled = Boolean(disabled || saving);
  const saveButtonDisabled = Boolean(saving || disabled || validationError);
  const saveButtonLabel = saving ? "Saving…" : disabled ? "Save (connect signer)" : "Save";
  const syncButtonDisabled = Boolean(syncDisabled || disabled || syncInProgress);
  const syncButtonLabel = syncInProgress ? "Syncing…" : "Sync selected";

  const handleDraftKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelDraft();
    }
    event.stopPropagation();
  };

  useEffect(() => {
    if (isAdding || editingUrl) {
      urlInputRef.current?.focus({ preventScroll: true });
    }
  }, [isAdding, editingUrl]);

  const startHealthCheck = useCallback(
    (server: ManagedServer) => {
      if (typeof window === "undefined") return;
      const key = server.url;
      if (activeControllersRef.current.has(key)) return;
      if (pendingStartRef.current.has(key)) return;

      pendingStartRef.current.add(key);

      setHealthMap(prev => {
        const current = prev[key];
        if (current?.status === "checking") return prev;
        return { ...prev, [key]: { status: "checking" } };
      });

      const controller = new AbortController();
      activeControllersRef.current.set(key, controller);
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, HEALTH_CHECK_TIMEOUT_MS);

      const commit = (entry: ServerHealth) => {
        setHealthMap(prev => {
          const current = prev[key];
          if (
            current &&
            current.status === entry.status &&
            current.httpStatus === entry.httpStatus &&
            current.latencyMs === entry.latencyMs &&
            current.error === entry.error
          ) {
            return prev;
          }
          return { ...prev, [key]: entry };
        });
      };

      const normalizedUrl = server.url.replace(/\/$/, "");
      const targetUrl = `${normalizedUrl}/`;
      const start = performance.now();

      (async () => {
        try {
          let response: Response | null = null;

          try {
            response = await fetch(targetUrl, {
              method: "HEAD",
              mode: "cors",
              cache: "no-store",
              signal: controller.signal,
            });

            if (response.status === 405 || response.status === 501) {
              response = await fetch(targetUrl, {
                method: "GET",
                mode: "cors",
                cache: "no-store",
                signal: controller.signal,
              });
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              if (timedOut) {
                commit({ status: "offline", checkedAt: Date.now(), error: "Timed out" });
              }
              return;
            }

            try {
              response = await fetch(targetUrl, {
                method: "GET",
                mode: "no-cors",
                cache: "no-store",
                signal: controller.signal,
              });
            } catch (fallbackError) {
              if (fallbackError instanceof DOMException && fallbackError.name === "AbortError") {
                if (timedOut) {
                  commit({ status: "offline", checkedAt: Date.now(), error: "Timed out" });
                }
                return;
              }

              const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
              commit({ status: "offline", checkedAt: Date.now(), error: message });
              return;
            }
          }

          if (!response) return;

          const duration = Math.max(0, Math.round(performance.now() - start));
          const checkedAt = Date.now();

          if (response.type === "opaque") {
            commit({ status: "online", checkedAt, latencyMs: duration });
            return;
          }

          const httpStatus = response.status;
          const requiresAuth = httpStatus === 401 || httpStatus === 403;
          const reachable = response.ok || requiresAuth;
          const status: ServerHealthStatus = requiresAuth ? "auth" : reachable ? "online" : "offline";

          commit({ status, checkedAt, httpStatus, latencyMs: duration, error: reachable ? undefined : response.statusText });
        } finally {
          clearTimeout(timeoutId);
          pendingStartRef.current.delete(key);
          activeControllersRef.current.delete(key);
        }
      })().catch(() => {
        // Swallow errors; commit handles error reporting.
      });
    },
    [setHealthMap]
  );

  useEffect(() => {
    const currentUrls = servers.map(server => server.url);
    const previousUrls = previousUrlsRef.current;
    const previousSet = new Set(previousUrls);

    const addedServers = servers.filter(server => !previousSet.has(server.url));
    const removedUrls = previousUrls.filter(url => !currentUrls.includes(url));

    if (removedUrls.length > 0) {
      setHealthMap(prev => {
        let changed = false;
        const next = { ...prev };
        removedUrls.forEach(url => {
          if (next[url]) {
            delete next[url];
            changed = true;
          }
        });
        return changed ? next : prev;
      });
      removedUrls.forEach(url => {
        const controller = activeControllersRef.current.get(url);
        if (controller) {
          controller.abort();
          activeControllersRef.current.delete(url);
        }
      });
    }

    addedServers.forEach(server => startHealthCheck(server));

    const now = Date.now();
    const staleServers = servers.filter(server => {
      const key = server.url;
      if (activeControllersRef.current.has(key)) {
        return false;
      }
      if (pendingStartRef.current.has(key)) {
        return false;
      }
      const health = healthMap[key];
      if (!health) return true;
      if (health.status === "checking") {
        const lastAttempt = health.checkedAt ?? 0;
        return now - lastAttempt > HEALTH_PENDING_GRACE_MS;
      }
      if (!health.checkedAt) return true;
      return now - health.checkedAt > HEALTH_RECHECK_TTL_MS;
    });

    staleServers.forEach(server => startHealthCheck(server));

    previousUrlsRef.current = currentUrls;
  }, [servers, startHealthCheck, healthMap]);

  useEffect(() => {
    return () => {
      activeControllersRef.current.forEach(controller => controller.abort());
      activeControllersRef.current.clear();
      pendingStartRef.current.clear();
    };
  }, []);

  const statusStyles = useMemo<Record<ServerHealthStatus, { label: string; dot: string; text: string }>>(
    () => ({
      checking: {
        label: "Checking…",
        dot: "bg-slate-500 animate-pulse",
        text: "text-slate-400",
      },
      online: {
        label: "Reachable",
        dot: "bg-emerald-500",
        text: "text-emerald-300",
      },
      auth: {
        label: "Reachable (auth)",
        dot: "bg-amber-500",
        text: "text-amber-300",
      },
      offline: {
        label: "Unreachable",
        dot: "bg-red-500",
        text: "text-red-400",
      },
    }),
    []
  );

  const renderHealthCell = (server: ManagedServer, showPendingNote = false) => {
    const health = healthMap[server.url];
    if (!health) {
      return <span className="text-xs text-slate-300">Not checked</span>;
    }

    const styles = statusStyles[health.status];
    const latency = typeof health.latencyMs === "number" ? `${health.latencyMs}ms` : null;

    return (
      <div className="flex flex-col gap-1">
        <span className={`inline-flex items-center gap-2 text-xs ${styles.text}`}>
          <span className={`h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
          {styles.label}
          {health.status === "auth" && health.httpStatus ? ` (${health.httpStatus})` : null}
          {latency ? <span className="text-[11px] text-slate-400">{latency}</span> : null}
        </span>
        {showPendingNote ? (
          <span className="text-[11px] text-slate-300">Will refresh after saving</span>
        ) : null}
      </div>
    );
  };

  const beginAdd = () => {
    setEditingUrl(null);
    setDraft(createEmptyDraft());
    setError(null);
    setIsAdding(true);
  };

  const beginEdit = (server: ManagedServer) => {
    setIsAdding(false);
    setError(null);
    setEditingUrl(server.url);
    setDraft({
      name: server.name,
      url: server.url,
      type: server.type,
      requiresAuth: Boolean(server.requiresAuth),
      sync: Boolean(server.sync),
    });
  };

  const cancelDraft = () => {
    setIsAdding(false);
    setEditingUrl(null);
    setDraft(createEmptyDraft());
    setError(null);
  };

  const handleSubmit = () => {
    if (editingUrl) {
      handleEditSubmit();
    } else {
      handleAddSubmit();
    }
  };

  const handleAddSubmit = () => {
    const trimmedUrl = draft.url.trim();
    if (!trimmedUrl) {
      setError("Enter a server URL");
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError("URL must start with http:// or https://");
      return;
    }
    const normalizedUrl = trimmedUrl.replace(/\/$/, "");
    if (servers.some(server => server.url === normalizedUrl)) {
      setError("Server already added");
      return;
    }
    const name = draft.name.trim() || deriveServerNameFromUrl(normalizedUrl);
    if (!name) {
      setError("Enter a server name");
      return;
    }

    onAdd({
      name,
      url: normalizedUrl,
      type: draft.type,
      requiresAuth: draft.requiresAuth,
      sync: draft.sync,
    });
    setIsAdding(false);
    setEditingUrl(null);
    setDraft(createEmptyDraft());
    setError(null);
  };

  const handleEditSubmit = () => {
    if (!editingUrl) return;

    const trimmedUrl = draft.url.trim();
    if (!trimmedUrl) {
      setError("Enter a server URL");
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError("URL must start with http:// or https://");
      return;
    }
    const normalizedUrl = trimmedUrl.replace(/\/$/, "");
    if (servers.some(server => server.url !== editingUrl && server.url === normalizedUrl)) {
      setError("Server already added");
      return;
    }
    const name = draft.name.trim() || deriveServerNameFromUrl(normalizedUrl);
    if (!name) {
      setError("Enter a server name");
      return;
    }

    onUpdate(editingUrl, {
      name,
      url: normalizedUrl,
      type: draft.type,
      requiresAuth: draft.requiresAuth,
      sync: draft.sync,
    });
    setEditingUrl(null);
    setIsAdding(false);
    setDraft(createEmptyDraft());
    setError(null);
  };

  const handleToggle = (server: ManagedServer) => {
    if (selected === server.url) {
      onSelect(null);
    } else {
      onSelect(server.url);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Servers</h2>
          <p className="text-xs text-slate-400">Select where your content lives. Please note that the NIP-96 server spec has been deprecated.</p>
        </div>
        <div className="flex gap-2">
          {onSync ? (
            <button
              type="button"
              onClick={event => {
                event.preventDefault();
                onSync?.();
              }}
              className="rounded-xl bg-emerald-600 px-3 py-2 text-sm text-slate-950 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={syncButtonDisabled}
              aria-busy={syncInProgress ? true : undefined}
            >
              {syncButtonLabel}
            </button>
          ) : null}
          <button
            onClick={beginAdd}
            className="rounded-xl bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={saving || isAdding || Boolean(editingUrl)}
          >
            Add server
          </button>
          <button
            onClick={onSave}
            className="rounded-xl bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-40"
            disabled={saveButtonDisabled}
          >
            {saveButtonLabel}
          </button>
        </div>
      </header>

      {(validationError || saving) && (
        <div
          className={`mb-3 rounded-xl border px-3 py-2 text-xs ${
            validationError
              ? "border-amber-600/40 bg-amber-500/5 text-amber-200"
              : "border-emerald-600/30 bg-emerald-500/5 text-emerald-200"
          }`}
          role="alert"
        >
          {validationError || "Saving changes…"}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full table-fixed text-sm text-slate-300">
          <thead className="text-[11px] uppercase tracking-wide text-slate-300">
            <tr>
              <th scope="col" className="w-28 py-2 px-3 text-center font-semibold">Default</th>
              <th scope="col" className="py-2 px-3 text-left font-semibold">Server</th>
              <th scope="col" className="py-2 px-3 text-left font-semibold">URL</th>
              <th scope="col" className="w-44 py-2 px-3 text-left font-semibold">Status</th>
              <th scope="col" className="w-32 py-2 px-3 text-left font-semibold">Type</th>
              <th scope="col" className="w-24 py-2 px-3 text-center font-semibold">Auth</th>
              <th scope="col" className="w-24 py-2 px-3 text-center font-semibold">Sync</th>
              <th scope="col" className="w-28 py-2 px-3 text-center font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isAdding && (
              <tr className="border-t border-slate-800 bg-slate-900/70">
                <td className="py-3 px-3 text-center text-xs text-slate-500">Save to set default</td>
                <td className="py-3 px-3">
                  <input
                    type="text"
                    value={draft.name}
                    onChange={event => {
                      setDraft(prev => ({ ...prev, name: event.target.value }));
                      if (error) setError(null);
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                    placeholder="Server name"
                    aria-label="Server name"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={handleDraftKeyDown}
                    autoComplete="off"
                  />
                </td>
                <td className="py-3 px-3">
                  <input
                    ref={urlInputRef}
                    type="url"
                    value={draft.url}
                    onChange={event => {
                      const value = event.target.value;
                      setDraft(prev => {
                        const next = { ...prev, url: value };
                        const previousDerived = deriveServerNameFromUrl(prev.url.trim());
                        if (!prev.name || prev.name === previousDerived) {
                          const derived = deriveServerNameFromUrl(value.trim());
                          if (derived) next.name = derived;
                        }
                        return next;
                      });
                      if (error) setError(null);
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                    placeholder="https://example.com"
                    aria-label="Server URL"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={handleDraftKeyDown}
                    autoComplete="off"
                  />
                </td>
                <td className="py-3 px-3 text-xs text-slate-300">
                  Health check runs after saving
                </td>
                <td className="py-3 px-3">
                  <select
                    value={draft.type}
                    onChange={event => {
                      const nextType = event.target.value as ManagedServer["type"];
                      setDraft(prev => ({
                        ...prev,
                        type: nextType,
                        requiresAuth: nextType === "satellite" ? true : prev.requiresAuth,
                      }));
                      if (error) setError(null);
                    }}
                    className="w-full min-w-[8rem] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                    aria-label="Server type"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={handleDraftKeyDown}
                  >
                    <option value="blossom">Blossom</option>
                    <option value="nip96">NIP-96</option>
                    <option value="satellite">Satellite</option>
                  </select>
                </td>
                <td className="py-3 px-3 text-center">
                  <div className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={draft.type === "satellite" ? true : draft.requiresAuth}
                      onChange={event => {
                        if (draft.type === "satellite") return;
                        setDraft(prev => ({ ...prev, requiresAuth: event.target.checked }));
                        if (error) setError(null);
                      }}
                      aria-label="Requires auth"
                      onClick={event => event.stopPropagation()}
                      onKeyDown={handleDraftKeyDown}
                      disabled={saving || draft.type === "satellite"}
                    />
                  </div>
                </td>
                <td className="py-3 px-3 text-center">
                  <div className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={draft.sync}
                      onChange={event => {
                        setDraft(prev => ({ ...prev, sync: event.target.checked }));
                        if (error) setError(null);
                      }}
                      aria-label="Sync server"
                      onClick={event => event.stopPropagation()}
                      onKeyDown={handleDraftKeyDown}
                      disabled={saving}
                    />
                  </div>
                </td>
                <td className="py-3 px-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500"
                      onClick={event => {
                        event.stopPropagation();
                        handleSubmit();
                      }}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="text-xs px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700"
                      onClick={event => {
                        event.stopPropagation();
                        cancelDraft();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  {error && (
                    <div className="mt-2 text-xs text-red-400 text-right">{error}</div>
                  )}
                </td>
              </tr>
            )}
            {servers.map(server => {
              const isEditing = editingUrl === server.url;
              const isDefault = defaultServerUrl === server.url;
              const rowHighlightClass = selected === server.url
                ? "bg-emerald-500/10"
                : isDefault
                ? "bg-slate-800/40"
                : "hover:bg-slate-800/50";

              if (isEditing) {
                return (
                  <tr key={server.url} className="border-t border-slate-800 bg-slate-900/70">
                    <td className="py-3 px-3 text-center text-xs text-slate-500">Save to set default</td>
                    <td className="py-3 px-3">
                      <input
                        type="text"
                        value={draft.name}
                        onChange={event => {
                          setDraft(prev => ({ ...prev, name: event.target.value }));
                          if (error) setError(null);
                        }}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                        placeholder="Server name"
                        aria-label="Server name"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={handleDraftKeyDown}
                        autoComplete="off"
                      />
                  </td>
                  <td className="py-3 px-3">
                    <input
                      ref={urlInputRef}
                      type="url"
                      value={draft.url}
                      onChange={event => {
                        const value = event.target.value;
                        setDraft(prev => {
                          const next = { ...prev, url: value };
                          const previousDerived = deriveServerNameFromUrl(prev.url.trim());
                          if (!prev.name || prev.name === previousDerived) {
                            const derived = deriveServerNameFromUrl(value.trim());
                            if (derived) next.name = derived;
                          }
                          return next;
                        });
                        if (error) setError(null);
                      }}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                      placeholder="https://example.com"
                      aria-label="Server URL"
                      onClick={event => event.stopPropagation()}
                      onKeyDown={handleDraftKeyDown}
                      autoComplete="off"
                    />
                  </td>
                  <td className="py-3 px-3">{renderHealthCell(server, true)}</td>
                  <td className="py-3 px-3">
                    <select
                      value={draft.type}
                      onChange={event => {
                        const nextType = event.target.value as ManagedServer["type"];
                        setDraft(prev => ({
                          ...prev,
                          type: nextType,
                          requiresAuth: nextType === "satellite" ? true : prev.requiresAuth,
                        }));
                        if (error) setError(null);
                      }}
                        className="w-full min-w-[8rem] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                        aria-label="Server type"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={handleDraftKeyDown}
                      >
                        <option value="blossom">Blossom</option>
                        <option value="nip96">NIP-96</option>
                        <option value="satellite">Satellite</option>
                      </select>
                    </td>
                    <td className="py-3 px-3 text-center">
                      <div className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={draft.type === "satellite" ? true : draft.requiresAuth}
                      onChange={event => {
                        if (draft.type === "satellite") return;
                        setDraft(prev => ({ ...prev, requiresAuth: event.target.checked }));
                        if (error) setError(null);
                      }}
                      aria-label="Requires auth"
                      onClick={event => event.stopPropagation()}
                      onKeyDown={handleDraftKeyDown}
                      disabled={saving || draft.type === "satellite"}
                    />
                  </div>
                </td>
                <td className="py-3 px-3 text-center">
                  <div className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={draft.sync}
                      onChange={event => {
                        setDraft(prev => ({ ...prev, sync: event.target.checked }));
                        if (error) setError(null);
                      }}
                      aria-label="Sync server"
                      onClick={event => event.stopPropagation()}
                      onKeyDown={handleDraftKeyDown}
                      disabled={saving}
                    />
                  </div>
                </td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="flex items-center justify-center rounded-lg bg-emerald-600 p-2 text-slate-50 transition hover:bg-emerald-500"
                          onClick={event => {
                            event.stopPropagation();
                            handleSubmit();
                          }}
                          aria-label="Save server"
                          title="Save server"
                        >
                          <SaveIcon size={16} />
                        </button>
                        <button
                          type="button"
                          className="flex items-center justify-center rounded-lg bg-slate-800 p-2 text-slate-200 transition hover:bg-slate-700"
                          onClick={event => {
                            event.stopPropagation();
                            cancelDraft();
                          }}
                          aria-label="Cancel editing"
                          title="Cancel editing"
                        >
                          <CancelIcon size={16} />
                        </button>
                      </div>
                      {error && (
                        <div className="mt-2 text-xs text-red-400 text-right">{error}</div>
                      )}
                    </td>
                  </tr>
                );
              }

              return (
                <tr
                  key={server.url}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === server.url}
                  onClick={() => handleToggle(server)}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleToggle(server);
                    }
                  }}
                  className={`border-t border-slate-800 first:border-t-0 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/60 focus:ring-offset-2 focus:ring-offset-slate-900 ${rowHighlightClass}`}
                >
                  <td className="py-3 px-3 text-center">
                    {isDefault ? (
                      <span className="rounded-lg border border-emerald-500/60 bg-emerald-500/10 px-2 py-1 text-[10px] uppercase tracking-wide text-emerald-200">
                        Default
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-xs rounded-lg border border-slate-700 px-2 py-1 text-slate-200 transition hover:border-emerald-500 hover:text-emerald-200"
                        onClick={event => {
                          event.stopPropagation();
                          onSetDefaultServer(server.url);
                          onSelect(server.url);
                        }}
                      >
                        Set default
                      </button>
                    )}
                  </td>
                  <td className="py-3 px-3 font-medium text-slate-100">
                    <div className="flex items-center gap-2">
                      <FolderIcon size={18} className="text-slate-300" />
                      <span className="truncate">{server.name}</span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-xs text-slate-400">
                    <span className="break-all">{server.url}</span>
                  </td>
                  <td className="py-3 px-3">{renderHealthCell(server)}</td>
                  <td className="py-3 px-3 text-[11px] uppercase tracking-wide text-slate-300">
                    {server.type}
                  </td>
                  <td className="py-3 px-3 text-center">
                    <label
                      className="inline-flex items-center gap-2 text-xs text-slate-300"
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(server.requiresAuth)}
                        onChange={e => onToggleAuth(server.url, e.target.checked)}
                        disabled={controlsDisabled}
                      />
                      <span className="sr-only">Requires auth</span>
                    </label>
                  </td>
                  <td className="py-3 px-3 text-center">
                    <label
                      className="inline-flex items-center gap-2 text-xs text-slate-300"
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(server.sync)}
                        onChange={e => onToggleSync(server.url, e.target.checked)}
                        disabled={controlsDisabled}
                      />
                      <span className="sr-only">Sync server</span>
                    </label>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="text-xs px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700"
                        onClick={e => {
                          e.stopPropagation();
                          beginEdit(server);
                        }}
                      >
                        <EditIcon size={16} />
                      </button>
                      <button
                        type="button"
                        className="text-xs px-2 py-1 rounded-lg bg-red-900/70 hover:bg-red-800"
                        onClick={e => {
                          e.stopPropagation();
                          onRemove(server.url);
                        }}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {servers.length === 0 && !isAdding && !editingUrl && (
              <tr>
                <td colSpan={8} className="py-6 px-3 text-sm text-center text-slate-400">
                  No servers yet. Add your first Blossom or NIP-96 server.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
