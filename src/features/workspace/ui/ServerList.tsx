import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagedServer } from "../../../shared/types/servers";
import type { BlossomBlob } from "../../../shared/api/blossomClient";
import type { ServerSnapshot } from "../hooks/useServerData";
import { deriveServerNameFromUrl } from "../../../shared/utils/serverName";
import {
  CancelIcon,
  EditIcon,
  FolderIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
  PlusIcon,
  StarIcon,
} from "../../../shared/ui/icons";
import { useWorkspace } from "../WorkspaceContext";
import type { FilterMode } from "../../../shared/types/filter";
import { prettyBytes } from "../../../shared/utils/format";
import { matchesFilter } from "../../browse/browseUtils";
import type { StatusMessageTone } from "../../../shared/types/status";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";
import { useIsCompactScreen } from "../../../shared/hooks/useIsCompactScreen";

export type ServerListProps = {
  servers: ManagedServer[];
  selected: string | null;
  defaultServerUrl: string | null;
  onSelect: (serverUrl: string | null) => void;
  onSetDefaultServer: (serverUrl: string | null) => void;
  onAdd: (server: ManagedServer) => void;
  onUpdate: (originalUrl: string, server: ManagedServer) => void;
  saving?: boolean;
  disabled?: boolean;
  onRemove: (url: string) => void;
  onSync?: () => void;
  syncDisabled?: boolean;
  syncInProgress?: boolean;
  validationError?: string | null;
  showStatusMessage?: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  compact?: boolean;
  onProvideActions?: (actions: React.ReactNode | null) => void;
};

type ServerDraft = {
  name: string;
  url: string;
  type: ManagedServer["type"];
  sync: boolean;
};

const createEmptyDraft = (): ServerDraft => ({
  name: "",
  url: "https://",
  type: "blossom",
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

type CoreFilterSegmentId = Extract<FilterMode, "music" | "images" | "videos" | "documents">;
type FilterSegmentId = CoreFilterSegmentId | "other";

const FILTER_SEGMENTS: FilterSegmentId[] = ["music", "images", "videos", "documents", "other"];

const SEGMENT_META: Record<FilterSegmentId, { label: string; bar: string; dot: string }> = {
  music: { label: "Audio", bar: "bg-emerald-500", dot: "bg-emerald-300" },
  images: { label: "Images", bar: "bg-sky-500", dot: "bg-sky-300" },
  videos: { label: "Videos", bar: "bg-fuchsia-500", dot: "bg-fuchsia-300" },
  documents: { label: "Documents", bar: "bg-amber-500", dot: "bg-amber-300" },
  other: { label: "Other", bar: "bg-slate-700", dot: "bg-slate-500" },
};

const resolveFilterSegment = (blob: BlossomBlob): FilterSegmentId => {
  const metadata = blob.privateData?.metadata;

  if (metadata?.audio) return "music";

  const classificationTarget: BlossomBlob = {
    ...blob,
  };

  if (metadata?.name) {
    classificationTarget.name = metadata.name;
    if (!classificationTarget.url || classificationTarget.url.endsWith(blob.sha256)) {
      classificationTarget.url = metadata.name;
    }
  }

  if (metadata?.type) {
    classificationTarget.type = metadata.type;
  } else if (metadata?.audio) {
    classificationTarget.type = "audio/*";
  }

  if (matchesFilter(classificationTarget, "pdfs" as FilterMode)) {
    return "documents";
  }

  const coreOrder: CoreFilterSegmentId[] = ["music", "images", "videos", "documents"];
  for (const segment of coreOrder) {
    if (matchesFilter(classificationTarget, segment)) {
      return segment;
    }
  }

  return "other";
};

type ServerUsageSummary = {
  totalBytes: number;
  buckets: Record<FilterSegmentId, number>;
  missingSizeCount: number;
};

export const ServerList: React.FC<ServerListProps> = ({
  servers,
  selected,
  defaultServerUrl,
  onSelect,
  onAdd,
  onUpdate,
  saving,
  disabled,
  onRemove,
  onSync,
  syncDisabled,
  syncInProgress,
  validationError,
  showStatusMessage,
  compact = false,
  onProvideActions,
}) => {
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";
  const [isAdding, setIsAdding] = useState(false);
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(createEmptyDraft);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; url?: string } | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, ServerHealth>>({});
  const previousUrlsRef = useRef<string[]>([]);
  const activeControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingStartRef = useRef<Set<string>>(new Set());
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});
  const isCompactScreen = useIsCompactScreen();
  const showCardLayout = compact || isCompactScreen;

  const syncButtonDisabled = Boolean(syncDisabled || disabled || syncInProgress);
  const syncButtonLabel = syncInProgress ? "Syncing…" : "Sync Selected";
  const syncButtonTooltip = syncInProgress
    ? "Sync in progress…"
    : "Sync enabled servers to align content. Requires at least two servers with sync enabled.";

  const { snapshots, privateBlobs } = useWorkspace();

  const clearFieldErrors = useCallback(() => {
    setFieldErrors(null);
  }, []);

  const clearFieldError = useCallback((field: "name" | "url") => {
    setFieldErrors(prev => {
      if (!prev?.[field]) return prev;
      const next = { ...prev, [field]: undefined };
      if (!next.name && !next.url) return null;
      return next;
    });
  }, []);

  const toggleUsage = useCallback((url: string) => {
    setExpandedUsage(prev => {
      const next = { ...prev, [url]: !prev[url] };
      if (!next[url]) {
        delete next[url];
      }
      return next;
    });
  }, []);

  const snapshotByUrl = useMemo(() => {
    const map = new Map<string, ServerSnapshot>();
    snapshots.forEach(snapshot => {
      map.set(snapshot.server.url, snapshot);
    });
    return map;
  }, [snapshots]);

  const usageByServer = useMemo(() => {
    const map = new Map<string, ServerUsageSummary>();
    const seenByServer = new Map<string, Set<string>>();

    const getSummary = (rawUrl: string | null | undefined) => {
      if (!rawUrl) return null;
      const normalizedUrl = rawUrl.replace(/\/$/, "");
      if (!normalizedUrl) return null;
      let summary = map.get(normalizedUrl);
      if (!summary) {
        summary = {
          totalBytes: 0,
          buckets: {
            music: 0,
            images: 0,
            videos: 0,
            documents: 0,
            other: 0,
          },
          missingSizeCount: 0,
        };
        map.set(normalizedUrl, summary);
      }
      let seen = seenByServer.get(normalizedUrl);
      if (!seen) {
        seen = new Set<string>();
        seenByServer.set(normalizedUrl, seen);
      }
      return { summary, seen };
    };

    const includeBlob = (rawUrl: string | null | undefined, blob: BlossomBlob) => {
      const entry = getSummary(rawUrl);
      if (!entry) return;
      const { summary, seen } = entry;
      const sha = blob.sha256;
      if (sha && seen.has(sha)) return;
      if (sha) {
        seen.add(sha);
      }

      const size = (() => {
        if (typeof blob.size === "number") return blob.size;
        if (typeof blob.size === "string") {
          const parsed = Number(blob.size);
          return Number.isFinite(parsed) ? parsed : null;
        }
        const privateSize = blob.privateData?.metadata?.size;
        if (typeof privateSize === "number") return privateSize;
        if (typeof privateSize === "string") {
          const parsed = Number(privateSize);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })();
      if (size === null) {
        summary.missingSizeCount += 1;
        return;
      }
      if (size <= 0) return;
      const segment = resolveFilterSegment(blob);
      summary.buckets[segment] += size;
      summary.totalBytes += size;
    };

    privateBlobs.forEach(blob => {
      const targetServers =
        Array.isArray(blob.privateData?.servers) && blob.privateData?.servers.length
          ? blob.privateData.servers
          : blob.serverUrl
            ? [blob.serverUrl]
            : [];

      if (targetServers.length === 0) {
        includeBlob(null, blob);
        return;
      }

      targetServers.forEach(serverUrl => {
        includeBlob(serverUrl ?? null, blob);
      });
    });

    snapshots.forEach(snapshot => {
      if (!map.has(snapshot.server.url)) {
        map.set(snapshot.server.url, {
          totalBytes: 0,
          buckets: {
            music: 0,
            images: 0,
            videos: 0,
            documents: 0,
            other: 0,
          },
          missingSizeCount: 0,
        });
      }
      snapshot.blobs.forEach(blob => includeBlob(snapshot.server.url, blob));
    });

    return map;
  }, [snapshots, privateBlobs]);

  useEffect(() => {
    setExpandedUsage(prev => {
      const allowed = new Set(servers.map(server => server.url));
      const retained = Object.keys(prev).filter(url => allowed.has(url));
      if (retained.length === Object.keys(prev).length) {
        return prev;
      }
      const next: Record<string, boolean> = {};
      retained.forEach(url => {
        next[url] = true;
      });
      return next;
    });
  }, [servers]);

  const renderUsageContent = useCallback(
    (server: ManagedServer) => {
      const snapshot = snapshotByUrl.get(server.url);
      const usage = usageByServer.get(server.url);

      const loading = Boolean(snapshot?.isLoading && (!usage || usage.totalBytes === 0));
      const errored = Boolean(snapshot?.isError);

      if (errored) {
        const message =
          snapshot?.error instanceof Error ? snapshot.error.message : "Unable to load file list.";
        return <div className="text-xs text-red-400">{message || "Unable to load file list."}</div>;
      } else if (loading) {
        return (
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="h-full w-1/3 animate-pulse bg-slate-600" />
          </div>
        );
      } else if (!usage || usage.totalBytes === 0) {
        const missingOnlyCount = usage?.missingSizeCount ?? 0;
        return (
          <div className="text-xs text-slate-400">
            {missingOnlyCount > 0
              ? `${missingOnlyCount} file${missingOnlyCount > 1 ? "s" : ""} detected, but size is unavailable.`
              : "No files detected yet."}
          </div>
        );
      } else {
        const segments = FILTER_SEGMENTS.filter(id => usage.buckets[id] > 0);
        const legendEntries = FILTER_SEGMENTS;

        return (
          <div className="flex flex-col items-stretch gap-3">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
              {segments.map(id => (
                <div
                  key={id}
                  className={`h-full ${SEGMENT_META[id].bar} first:rounded-l-full last:rounded-r-full`}
                  style={{ flex: usage.buckets[id] }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-300">
              {legendEntries.map(id => {
                const bytes = usage.buckets[id];
                return (
                  <div key={id} className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${SEGMENT_META[id].dot}`} aria-hidden />
                    <span className="uppercase tracking-wide text-slate-400">
                      {SEGMENT_META[id].label}
                    </span>
                    {bytes > 0 ? (
                      <span className="text-slate-300">{prettyBytes(bytes)}</span>
                    ) : (
                      <span className="text-slate-500">0 B</span>
                    )}
                  </div>
                );
              })}
              <div className="flex items-center gap-2 font-medium text-slate-200">
                <span className="text-slate-100 whitespace-nowrap">
                  (Total: {prettyBytes(usage.totalBytes)})
                </span>
              </div>
            </div>
            {usage.missingSizeCount > 0 ? (
              <div className="text-center text-[10px] text-slate-500">
                {usage.missingSizeCount} file{usage.missingSizeCount > 1 ? "s" : ""} excluded: size
                unavailable.
              </div>
            ) : null}
          </div>
        );
      }
    },
    [snapshotByUrl, usageByServer],
  );

  const renderUsageRow = useCallback(
    (server: ManagedServer, rowId?: string) => {
      return (
        <tr className="border-t border-slate-900/60" id={rowId}>
          <td colSpan={6} className="px-3 pb-4 pt-2">
            {renderUsageContent(server)}
          </td>
        </tr>
      );
    },
    [renderUsageContent],
  );

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

              const message =
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
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
          const status: ServerHealthStatus = requiresAuth
            ? "auth"
            : reachable
              ? "online"
              : "offline";

          commit({
            status,
            checkedAt,
            httpStatus,
            latencyMs: duration,
            error: reachable ? undefined : response.statusText,
          });
        } finally {
          clearTimeout(timeoutId);
          pendingStartRef.current.delete(key);
          activeControllersRef.current.delete(key);
        }
      })().catch(() => {
        // Swallow errors; commit handles error reporting.
      });
    },
    [setHealthMap],
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

  const statusStyles = useMemo<
    Record<ServerHealthStatus, { label: string; dot: string; text: string }>
  >(
    () => ({
      checking: {
        label: "Connecting",
        dot: "bg-slate-500 animate-pulse",
        text: "text-slate-400",
      },
      online: {
        label: "Connected",
        dot: "bg-emerald-500",
        text: "text-emerald-300",
      },
      auth: {
        label: "Reachable (auth)",
        dot: "bg-amber-500",
        text: "text-amber-300",
      },
      offline: {
        label: "Offline",
        dot: "bg-red-500",
        text: "text-red-400",
      },
    }),
    [],
  );

  const renderHealthCell = (server: ManagedServer, showPendingNote = false) => {
    const health = healthMap[server.url];
    if (!health) {
      return <span className="text-xs text-slate-300">Not checked</span>;
    }

    const styles = statusStyles[health.status];

    return (
      <div className="flex flex-col gap-1">
        <span className={`inline-flex items-center gap-2 text-xs ${styles.text}`}>
          <span className={`h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
          {styles.label}
          {health.status === "auth" && health.httpStatus ? ` (${health.httpStatus})` : null}
        </span>
        {showPendingNote ? (
          <span className="text-[11px] text-slate-300">Will refresh after saving</span>
        ) : null}
      </div>
    );
  };

  const beginAdd = useCallback(() => {
    setEditingUrl(null);
    setDraft(createEmptyDraft());
    clearFieldErrors();
    setIsAdding(true);
  }, [clearFieldErrors]);

  const beginEdit = (server: ManagedServer) => {
    setIsAdding(false);
    clearFieldErrors();
    setEditingUrl(server.url);
    setDraft({
      name: server.name,
      url: server.url,
      type: server.type,
      sync: Boolean(server.sync),
    });
  };

  const cancelDraft = () => {
    setIsAdding(false);
    setEditingUrl(null);
    setDraft(createEmptyDraft());
    clearFieldErrors();
  };

  const reportValidationError = useCallback(
    (message: string, field: "name" | "url" = "url") => {
      setFieldErrors({ [field]: message });
      showStatusMessage?.(message, "error");
    },
    [showStatusMessage],
  );

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
      reportValidationError("Enter a server URL", "url");
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      reportValidationError("URL must start with http:// or https://", "url");
      return;
    }
    const normalizedUrl = trimmedUrl.replace(/\/$/, "");
    if (servers.some(server => server.url === normalizedUrl)) {
      reportValidationError("Server already added", "url");
      return;
    }
    const name = draft.name.trim() || deriveServerNameFromUrl(normalizedUrl);
    if (!name) {
      reportValidationError("Enter a server name", "name");
      return;
    }

    const sync = draft.type === "satellite" ? false : draft.sync;

    onAdd({
      name,
      url: normalizedUrl,
      type: draft.type,
      requiresAuth: true,
      sync,
    });
    setIsAdding(false);
    setEditingUrl(null);
    setDraft(createEmptyDraft());
    clearFieldErrors();
  };

  const handleEditSubmit = () => {
    if (!editingUrl) return;

    const trimmedUrl = draft.url.trim();
    if (!trimmedUrl) {
      reportValidationError("Enter a server URL", "url");
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      reportValidationError("URL must start with http:// or https://", "url");
      return;
    }
    const normalizedUrl = trimmedUrl.replace(/\/$/, "");
    if (servers.some(server => server.url !== editingUrl && server.url === normalizedUrl)) {
      reportValidationError("Server already added", "url");
      return;
    }
    const name = draft.name.trim() || deriveServerNameFromUrl(normalizedUrl);
    if (!name) {
      reportValidationError("Enter a server name", "name");
      return;
    }

    const original = servers.find(server => server.url === editingUrl);
    const requiresAuth = draft.type === "satellite" ? true : original?.requiresAuth !== false;
    const sync = draft.type === "satellite" ? false : draft.sync;

    onUpdate(editingUrl, {
      name,
      url: normalizedUrl,
      type: draft.type,
      requiresAuth,
      sync,
    });
    setEditingUrl(null);
    setIsAdding(false);
    setDraft(createEmptyDraft());
    clearFieldErrors();
  };

  const handleToggle = (server: ManagedServer) => {
    if (selected === server.url) {
      onSelect(null);
    } else {
      onSelect(server.url);
    }
  };

  const hasServers = servers.length > 0;

  const controls = useMemo(
    () => (
      <>
        <button
          onClick={beginAdd}
          className="inline-flex items-center gap-2 rounded-xl bg-slate-800 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={saving || isAdding || Boolean(editingUrl)}
        >
          <PlusIcon size={16} />
          Add Server
        </button>
        {onSync ? (
          <button
            type="button"
            onClick={event => {
              event.preventDefault();
              onSync?.();
            }}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm text-slate-950 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={syncButtonDisabled}
            aria-busy={syncInProgress ? true : undefined}
            title={syncButtonTooltip}
          >
            <RefreshIcon size={16} />
            {syncButtonLabel}
          </button>
        ) : null}
      </>
    ),
    [
      beginAdd,
      editingUrl,
      isAdding,
      onSync,
      saving,
      syncButtonDisabled,
      syncButtonLabel,
      syncButtonTooltip,
      syncInProgress,
    ],
  );

  useEffect(() => {
    if (!onProvideActions) return undefined;
    onProvideActions(controls);
    return () => {
      onProvideActions(null);
    };
  }, [controls, onProvideActions]);

  const containerClass = compact
    ? "rounded-xl border border-slate-800 bg-slate-900/60 p-4"
    : "rounded-2xl border border-slate-800 bg-slate-900/70 p-4 flex-1 min-h-0";

  return (
    <section className={containerClass}>
      {!compact ? (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-100">Servers</h2>
          <div className="flex gap-2">{controls}</div>
        </header>
      ) : null}

      {(validationError || saving) && (
        <div
          className={`mb-3 rounded-xl border px-3 py-2 text-xs ${validationError
            ? "border-amber-600/40 bg-amber-500/5 text-amber-200"
            : "border-emerald-600/30 bg-emerald-500/5 text-emerald-200"
            }`}
          role="alert"
        >
          {validationError || "Saving changes…"}
        </div>
      )}
      {!hasServers && !isAdding ? (
        <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
          <h3 className="text-base font-semibold text-slate-100">
            Choose a server type to get started
          </h3>
          <ul className="mt-3 flex flex-col gap-3 text-sm text-slate-300">
            <li>
              <strong>
                <a
                  href="https://github.com/nostr-protocol/nips/blob/master/B7.md"
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-300 hover:text-emerald-200"
                >
                  Blossom servers (NIP-B7)
                </a>
              </strong>{" "}
              – Stand-alone media hosts that speak the Blossom HTTP API. They accept uploads and
              deletions via NIP-98, expose predictable blob URLs, and let Bloom mirror content
              across multiple instances. Bloom can automatically sync as soon as you add at least
              two servers and enable sync.
            </li>
            <li>
              <strong>
                <a
                  href="https://github.com/nostr-protocol/nips/blob/master/96.md"
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-300 hover:text-emerald-200"
                >
                  NIP-96 servers
                </a>
              </strong>{" "}
              – Legacy media-upload relays that wrap Nostr events in an HTTP workflow. The standard
              is deprecated—stick with Blossom when you can, but Bloom still supports NIP-96 if you
              need compatibility with older infrastructure.
            </li>
          </ul>
        </div>
      ) : null}

      {(hasServers || isAdding) && (
        showCardLayout ? (
          <div className="space-y-3">
            {(isAdding || editingUrl) && (
              <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900/50 p-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400">Server Name</label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={event => {
                      setDraft(prev => ({ ...prev, name: event.target.value }));
                      clearFieldError("name");
                    }}
                    className={`w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none ${fieldErrors?.name
                      ? "border border-red-700 focus:border-red-500"
                      : "border border-slate-700 focus:border-emerald-500"
                      }`}
                    placeholder="Server name"
                    autoComplete="off"
                  />
                  {fieldErrors?.name ? (
                    <p className="text-[11px] text-red-400">{fieldErrors.name}</p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400">URL</label>
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
                      clearFieldError("url");
                    }}
                    className={`w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none ${fieldErrors?.url
                      ? "border border-red-700 focus:border-red-500"
                      : "border border-slate-700 focus:border-emerald-500"
                      }`}
                    placeholder={
                      draft.type === "satellite"
                        ? "https://satellite.earth/api/v1"
                        : "https://example.com"
                    }
                    autoComplete="off"
                  />
                  {fieldErrors?.url ? (
                    <p className="text-[11px] text-red-400">{fieldErrors.url}</p>
                  ) : null}
                </div>

                <div className="flex gap-3">
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-slate-400">Type</label>
                    <select
                      value={draft.type}
                      onChange={event => {
                        const nextType = event.target.value as ManagedServer["type"];
                        setDraft(prev => ({
                          ...prev,
                          type: nextType,
                          sync: nextType === "satellite" ? false : prev.sync,
                        }));
                        clearFieldErrors();
                      }}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
                    >
                      <option value="blossom">Blossom</option>
                      <option value="nip96">NIP-96</option>
                      <option value="satellite">Satellite</option>
                    </select>
                  </div>
                  <div className="flex items-center pt-5">
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={draft.sync}
                        onChange={event => {
                          if (draft.type === "satellite") return;
                          setDraft(prev => ({ ...prev, sync: event.target.checked }));
                          clearFieldErrors();
                        }}
                        disabled={saving || draft.type === "satellite"}
                        readOnly={draft.type === "satellite"}
                        className="rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500/50"
                      />
                      Sync
                    </label>
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="button"
                    className="flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm text-slate-950 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={saving}
                    onClick={handleSubmit}
                  >
                    {saving ? <RefreshIcon size={16} className="animate-spin" /> : (editingUrl ? "Save" : "Add")}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-700"
                    onClick={cancelDraft}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {servers.filter(s => s.url !== editingUrl).map(server => {
              const isDefault = defaultServerUrl === server.url;
              const isUsageExpanded = Boolean(expandedUsage[server.url]);
              const usageContent = isUsageExpanded ? renderUsageContent(server) : null;

              return (
                <div
                  key={server.url}
                  className={`flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/30 p-3 ${selected === server.url ? "border-emerald-500/30 bg-emerald-500/5" : ""}`}
                  onClick={() => handleToggle(server)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <FolderIcon size={18} className="text-slate-300 shrink-0" />
                        <span className="font-medium text-slate-100 truncate">{server.name}</span>
                        {isDefault ? (
                          <StarIcon
                            size={16}
                            className="text-emerald-300 shrink-0"
                            aria-label="Default server"
                          />
                        ) : null}
                      </div>
                      <span className="text-xs text-slate-400 break-all">{server.url}</span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        className="p-1.5 text-slate-400 hover:text-slate-200"
                        onClick={e => {
                          e.stopPropagation();
                          beginEdit(server);
                        }}
                      >
                        <EditIcon size={16} />
                      </button>
                      <button
                        type="button"
                        className="p-1.5 text-red-400 hover:text-red-300"
                        onClick={e => {
                          e.stopPropagation();
                          onRemove(server.url);
                        }}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-slate-800/50 pt-2">
                    <div className="flex flex-col">
                      {renderHealthCell(server)}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">{server.type}</span>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-slate-400">
                          <input type="checkbox" checked={Boolean(server.sync)} disabled readOnly />
                          Sync
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-slate-800/50 pt-2">
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        toggleUsage(server.url);
                      }}
                      className={`text-xs font-medium transition ${isLightTheme
                        ? "text-blue-800 hover:text-blue-600"
                        : "text-emerald-300 hover:text-emerald-200"
                        }`}
                    >
                      {isUsageExpanded ? "Hide usage" : "View usage"}
                    </button>
                    {isUsageExpanded ? <div className="mt-2 text-xs">{usageContent}</div> : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full table-fixed text-sm text-slate-300">
              <thead className="text-[11px] uppercase tracking-wide text-slate-300">
                <tr>
                  <th scope="col" className="py-2 px-3 text-left font-semibold">
                    Server
                  </th>
                  <th scope="col" className="py-2 px-3 text-left font-semibold">
                    URL
                  </th>
                  <th scope="col" className="w-44 py-2 px-3 text-left font-semibold">
                    Status
                  </th>
                  <th scope="col" className="w-32 py-2 px-3 text-left font-semibold">
                    Type
                  </th>
                  <th scope="col" className="w-24 py-2 px-3 text-center font-semibold">
                    Sync
                  </th>
                  <th scope="col" className="w-28 py-2 px-3 text-center font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {isAdding && (
                  <tr className="border-t border-slate-800 bg-slate-900/70">
                    <td className="py-3 px-3">
                      <input
                        type="text"
                        value={draft.name}
                        onChange={event => {
                          setDraft(prev => ({ ...prev, name: event.target.value }));
                          clearFieldError("name");
                        }}
                        className={`w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none ${fieldErrors?.name
                          ? "border border-red-700 focus:border-red-500"
                          : "border border-slate-700 focus:border-emerald-500"
                          }`}
                        placeholder="Server name"
                        aria-label="Server name"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={handleDraftKeyDown}
                        autoComplete="off"
                      />
                      {fieldErrors?.name ? (
                        <p className="mt-1 text-[11px] text-red-400">{fieldErrors.name}</p>
                      ) : null}
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
                          clearFieldError("url");
                        }}
                        className={`w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none ${fieldErrors?.url
                          ? "border border-red-700 focus:border-red-500"
                          : "border border-slate-700 focus:border-emerald-500"
                          }`}
                        placeholder={
                          draft.type === "satellite"
                            ? "https://satellite.earth/api/v1"
                            : "https://example.com"
                        }
                        aria-label="Server URL"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={handleDraftKeyDown}
                        autoComplete="off"
                      />
                      {fieldErrors?.url ? (
                        <p className="mt-1 text-[11px] text-red-400">{fieldErrors.url}</p>
                      ) : null}
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
                            sync: nextType === "satellite" ? false : prev.sync,
                          }));
                          clearFieldErrors();
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
                          checked={draft.sync}
                          onChange={event => {
                            if (draft.type === "satellite") return;
                            setDraft(prev => ({ ...prev, sync: event.target.checked }));
                            clearFieldErrors();
                          }}
                          aria-label="Sync server"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={handleDraftKeyDown}
                          disabled={saving || draft.type === "satellite"}
                          readOnly={draft.type === "satellite"}
                        />
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs text-slate-950 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={saving}
                          onClick={event => {
                            event.stopPropagation();
                            handleSubmit();
                          }}
                        >
                          {saving ? <RefreshIcon size={16} className="animate-spin" /> : "Add"}
                          {saving ? <span className="sr-only">Saving server</span> : null}
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
                    </td>
                  </tr>
                )}
                {servers.map(server => {
                  const isEditing = editingUrl === server.url;
                  const isDefault = defaultServerUrl === server.url;
                  const usageRowId = `server-usage-${server.url.replace(/[^a-z0-9]/gi, "-")}`;
                  const rowHighlightClass =
                    selected === server.url
                      ? "bg-emerald-500/10"
                      : isDefault
                        ? "bg-slate-800/40"
                        : "hover:bg-slate-800/50";
                  const isUsageExpanded = Boolean(expandedUsage[server.url]);
                  const usageRow = isUsageExpanded ? renderUsageRow(server, usageRowId) : null;

                  if (isEditing) {
                    return (
                      <React.Fragment key={server.url}>
                        <tr className="border-t border-slate-800 bg-slate-900/70">
                          <td className="py-3 px-3">
                            <input
                              type="text"
                              value={draft.name}
                              onChange={event => {
                                setDraft(prev => ({ ...prev, name: event.target.value }));
                                clearFieldError("name");
                              }}
                              className={`w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none ${fieldErrors?.name
                                ? "border border-red-700 focus:border-red-500"
                                : "border border-slate-700 focus:border-emerald-500"
                                }`}
                              placeholder="Server name"
                              aria-label="Server name"
                              onClick={event => event.stopPropagation()}
                              onKeyDown={handleDraftKeyDown}
                              autoComplete="off"
                            />
                            {fieldErrors?.name ? (
                              <p className="mt-1 text-[11px] text-red-400">{fieldErrors.name}</p>
                            ) : null}
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
                                clearFieldError("url");
                              }}
                              className={`w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none ${fieldErrors?.url
                                ? "border border-red-700 focus:border-red-500"
                                : "border border-slate-700 focus:border-emerald-500"
                                }`}
                              placeholder={
                                draft.type === "satellite"
                                  ? "https://satellite.earth/api/v1"
                                  : "https://example.com"
                              }
                              aria-label="Server URL"
                              onClick={event => event.stopPropagation()}
                              onKeyDown={handleDraftKeyDown}
                              autoComplete="off"
                            />
                            {fieldErrors?.url ? (
                              <p className="mt-1 text-[11px] text-red-400">{fieldErrors.url}</p>
                            ) : null}
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
                                  sync: nextType === "satellite" ? false : prev.sync,
                                }));
                                clearFieldErrors();
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
                                checked={draft.sync}
                                onChange={event => {
                                  if (draft.type === "satellite") return;
                                  setDraft(prev => ({ ...prev, sync: event.target.checked }));
                                  clearFieldErrors();
                                }}
                                aria-label="Sync server"
                                onClick={event => event.stopPropagation()}
                                onKeyDown={handleDraftKeyDown}
                                disabled={saving || draft.type === "satellite"}
                              />
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                className="flex items-center justify-center rounded-lg bg-emerald-600 p-2 text-slate-50 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={saving}
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
                          </td>
                        </tr>
                        {usageRow}
                      </React.Fragment>
                    );
                  }

                  return (
                    <React.Fragment key={server.url}>
                      <tr
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
                        <td className="py-3 px-3 font-medium text-slate-100">
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                              <FolderIcon size={18} className="text-slate-300" />
                              <span className="truncate">{server.name}</span>
                              {isDefault ? (
                                <StarIcon
                                  size={16}
                                  className="text-emerald-300"
                                  aria-label="Default server"
                                />
                              ) : null}
                            </div>
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation();
                                toggleUsage(server.url);
                              }}
                              onKeyDown={event => event.stopPropagation()}
                              className={`self-start text-[11px] font-medium transition ${isLightTheme
                                ? "text-blue-800 hover:text-blue-600"
                                : "text-emerald-300 hover:text-emerald-200"
                                }`}
                              style={isLightTheme ? { color: "#1e3a8a" } : undefined}
                              aria-expanded={isUsageExpanded}
                              aria-controls={usageRowId}
                            >
                              {isUsageExpanded ? "Hide server usage" : "View server usage"}
                            </button>
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
                            className="inline-flex cursor-not-allowed items-center gap-2 text-xs text-slate-400 opacity-60"
                            onClick={e => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onKeyDown={e => e.stopPropagation()}
                            aria-disabled
                            title="Edit this server to change sync"
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(server.sync)}
                              disabled={server.type === "satellite"}
                              readOnly
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
                      {usageRow}
                    </React.Fragment>
                  );
                })}
                {servers.length === 0 && !isAdding && !editingUrl && (
                  <tr>
                    <td colSpan={6} className="py-6 px-3 text-sm text-center text-slate-400">
                      No servers yet. Add your first Blossom or NIP-96 server.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
};
