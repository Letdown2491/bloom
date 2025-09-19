import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNdk, useCurrentPubkey } from "./context/NdkContext";
import { useServers, ManagedServer, sortServersByName } from "./hooks/useServers";
import { useServerData } from "./hooks/useServerData";
import { ServerList } from "./components/ServerList";
import { BlobList } from "./components/BlobList";
import { UploadPanel, type TransferState } from "./components/UploadPanel";
import { useAudio } from "./context/AudioContext";
import { deleteUserBlob, mirrorBlobToServer, buildAuthorizationHeader, uploadBlobToServer } from "./lib/blossomClient";
import { deleteNip96File, uploadBlobToNip96 } from "./lib/nip96Client";
import { buildNip98AuthHeader } from "./lib/nip98";
import { useQueryClient } from "@tanstack/react-query";
import type { BlossomBlob } from "./lib/blossomClient";
import { prettyBytes } from "./utils/format";
import { deriveServerNameFromUrl } from "./utils/serverName";
import { BrowseIcon, GridIcon, ListIcon, TransferIcon, UploadIcon } from "./components/icons";

type TabId = "browse" | "upload" | "servers" | "transfer";

type StatusMessageTone = "success" | "info" | "error";

const NAV_TABS = [
  { id: "browse" as const, label: "Browse", icon: BrowseIcon },
  { id: "upload" as const, label: "Upload", icon: UploadIcon },
];

const ALL_SERVERS_VALUE = "__all__";

const normalizeManagedServer = (server: ManagedServer): ManagedServer => {
  const trimmedUrl = (server.url || "").trim();
  const normalizedUrl = trimmedUrl.replace(/\/$/, "");
  const derivedName = deriveServerNameFromUrl(normalizedUrl);
  const fallbackName = derivedName || normalizedUrl.replace(/^https?:\/\//, "");
  const name = (server.name || "").trim() || fallbackName;

  return {
    ...server,
    url: normalizedUrl,
    name,
    requiresAuth: Boolean(server.requiresAuth),
    sync: Boolean(server.sync),
  };
};

const validateManagedServers = (servers: ManagedServer[]): string | null => {
  const seen = new Set<string>();
  for (const server of servers) {
    const trimmedUrl = (server.url || "").trim();
    if (!trimmedUrl) return "Enter a server URL for every entry.";
    if (!/^https?:\/\//i.test(trimmedUrl)) return "Server URLs must start with http:// or https://.";
    const normalizedUrl = trimmedUrl.replace(/\/$/, "").toLowerCase();
    if (seen.has(normalizedUrl)) return "Server URLs must be unique.";
    seen.add(normalizedUrl);
    const name = (server.name || "").trim();
    if (!name) return "Enter a server name for every entry.";
  }
  return null;
};

export default function App() {
  const { connect, disconnect, user, signer, signEventTemplate, ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const queryClient = useQueryClient();

  const { servers, saveServers, saving } = useServers();
  const [localServers, setLocalServers] = useState<ManagedServer[]>(servers);
  const [selectedServer, setSelectedServer] = useState<string | null>(servers[0]?.url ?? null);
  const [tab, setTab] = useState<TabId>("browse");
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedBlobs, setSelectedBlobs] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusMessageTone, setStatusMessageTone] = useState<StatusMessageTone>("info");
  const statusMessageTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncQueueRef = useRef<Set<string>>(new Set());
  const nextSyncAttemptRef = useRef<Map<string, number>>(new Map());
  const unsupportedMirrorTargetsRef = useRef<Set<string>>(new Set());
  const unauthorizedSyncTargetsRef = useRef<Set<string>>(new Set());
  const [syncTransfers, setSyncTransfers] = useState<TransferState[]>([]);
  const [syncStatus, setSyncStatus] = useState<{ state: "idle" | "syncing" | "synced" | "error"; progress: number }>({
    state: "idle",
    progress: 0,
  });
  const [manualTransfers, setManualTransfers] = useState<TransferState[]>([]);
  const [transferTargets, setTransferTargets] = useState<string[]>([]);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferFeedback, setTransferFeedback] = useState<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const mainWidgetRef = useRef<HTMLDivElement | null>(null);

  const syncEnabledServers = useMemo(() => localServers.filter(server => server.sync), [localServers]);
  const serverValidationError = useMemo(() => validateManagedServers(localServers), [localServers]);
  const { snapshots, distribution, aggregated } = useServerData(localServers);
  const selectedBlobSources = useMemo(() => {
    const map = new Map<string, { blob: BlossomBlob; server: ManagedServer }>();
    snapshots.forEach(snapshot => {
      if (!snapshot.blobs.length) return;
      snapshot.blobs.forEach(blob => {
        if (!selectedBlobs.has(blob.sha256)) return;
        if (selectedServer) {
          if (snapshot.server.url === selectedServer && !map.has(blob.sha256)) {
            map.set(blob.sha256, { blob, server: snapshot.server });
          }
          return;
        }
        if (!map.has(blob.sha256)) {
          map.set(blob.sha256, { blob, server: snapshot.server });
        }
      });
    });
    return map;
  }, [snapshots, selectedBlobs, selectedServer]);
  const selectedBlobItems = useMemo(() => Array.from(selectedBlobSources.values()), [selectedBlobSources]);
  const selectedBlobTotalSize = useMemo(
    () => selectedBlobItems.reduce((total, item) => total + (item.blob.size || 0), 0),
    [selectedBlobItems]
  );
  const sourceServerUrls = useMemo(() => {
    const set = new Set<string>();
    selectedBlobItems.forEach(item => {
      set.add(item.server.url);
    });
    return set;
  }, [selectedBlobItems]);
  const missingSourceCount = useMemo(() => {
    if (selectedBlobs.size === selectedBlobSources.size) return 0;
    return selectedBlobs.size - selectedBlobSources.size;
  }, [selectedBlobs, selectedBlobSources]);
  const serverNameMap = useMemo(() => new Map(localServers.map(server => [server.url, server.name])), [localServers]);
  const transferFeedbackTone = useMemo(() => {
    if (!transferFeedback) return "text-slate-400";
    const normalized = transferFeedback.toLowerCase();
    if (normalized.includes("issue") || normalized.includes("try again")) return "text-amber-300";
    if (normalized.includes("failed") || normalized.includes("unable") || normalized.includes("error")) return "text-red-400";
    return "text-emerald-300";
  }, [transferFeedback]);
  const transferActivity = useMemo(() => manualTransfers.slice().reverse(), [manualTransfers]);
  const userInitials = useMemo(() => {
    const npub = user?.npub;
    if (!npub) return "??";
    return npub.slice(0, 2).toUpperCase();
  }, [user]);

  const toggleUserMenu = useCallback(() => {
    setIsUserMenuOpen(prev => !prev);
  }, [setIsUserMenuOpen]);

  const handleSelectServers = useCallback(() => {
    setTab("servers");
    setIsUserMenuOpen(false);
  }, [setIsUserMenuOpen, setTab]);

  const handleDisconnectClick = useCallback(() => {
    setIsUserMenuOpen(false);
    disconnect();
  }, [disconnect, setIsUserMenuOpen]);

  useEffect(() => {
    setLocalServers(servers);
    setSelectedServer(prev => {
      if (!prev) return prev;
      return servers.some(server => server.url === prev) ? prev : servers[0]?.url ?? null;
    });
  }, [servers]);

  // Auto-sync blobs across all servers marked for synchronization.
  useEffect(() => {
    setSelectedBlobs(new Set());
  }, [selectedServer]);

  useEffect(() => {
    if (!isUserMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!userMenuRef.current || userMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsUserMenuOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!userMenuRef.current || userMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isUserMenuOpen]);

  useEffect(() => {
    if (tab === "transfer" && selectedBlobs.size === 0) {
      setTab("upload");
    }
  }, [selectedBlobs.size, tab]);

  useEffect(() => {
    if (!user) {
      setIsUserMenuOpen(false);
    }
  }, [setIsUserMenuOpen, user]);

  const showAuthPrompt = !user;

  useEffect(() => {
    const element = mainWidgetRef.current;
    if (!element) return;
    if (showAuthPrompt) {
      element.setAttribute("inert", "");
      return () => {
        element.removeAttribute("inert");
      };
    }
    element.removeAttribute("inert");
    return () => {
      element.removeAttribute("inert");
    };
  }, [showAuthPrompt]);

  useEffect(() => {
    if (tab !== "transfer") return;
    setTransferTargets(prev => {
      const validTargetUrls = localServers.map(server => server.url);
      const filtered = prev.filter(url => validTargetUrls.includes(url));

      if (localServers.length <= 1) {
        return [];
      }

      if (localServers.length === 2) {
        const fallback = localServers.find(server => server.url !== selectedServer) ?? localServers[0];
        const fallbackUrl = fallback?.url;
        return fallbackUrl ? [fallbackUrl] : [];
      }

      if (filtered.length > 0) {
        const sameLength = filtered.length === prev.length;
        const sameOrder = sameLength && filtered.every((url, index) => url === prev[index]);
        return sameOrder ? prev : filtered;
      }

      const preferred = localServers.filter(server => !sourceServerUrls.has(server.url));
      const firstPreferred = preferred[0];
      if (firstPreferred?.url) return [firstPreferred.url];
      const firstValid = validTargetUrls[0];
      if (firstValid) return [firstValid];
      return [];
    });
  }, [localServers, selectedServer, sourceServerUrls, tab]);

  useEffect(() => {
    if (tab !== "transfer") {
      setTransferBusy(false);
      setTransferFeedback(null);
    }
  }, [tab]);

  useEffect(() => {
    return () => {
      if (statusMessageTimeout.current) {
        clearTimeout(statusMessageTimeout.current);
      }
    };
  }, []);

  const showStatusMessage = useCallback(
    (message: string, tone: StatusMessageTone = "info", duration = 5000) => {
      if (statusMessageTimeout.current) {
        clearTimeout(statusMessageTimeout.current);
        statusMessageTimeout.current = null;
      }
      setStatusMessage(message);
      setStatusMessageTone(tone);
      if (duration > 0) {
        statusMessageTimeout.current = setTimeout(() => {
          setStatusMessage(null);
          setStatusMessageTone("info");
          statusMessageTimeout.current = null;
        }, duration);
      }
    },
    []
  );

  const fetchBlobAsFile = useCallback(
    async (sourceBlob: BlossomBlob, sourceServer: ManagedServer): Promise<File | null> => {
      if (!sourceBlob.url) return null;
      const template = signEventTemplate;
      if (sourceServer.requiresAuth && !template) return null;

      const inferExtensionFromType = (type?: string) => {
        if (!type) return undefined;
        const [mime] = type.split(";");
        if (!mime) return undefined;
        const lookup: Record<string, string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/jpg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/bmp": "bmp",
          "image/svg+xml": "svg",
          "image/avif": "avif",
          "image/heic": "heic",
          "video/mp4": "mp4",
          "video/quicktime": "mov",
          "video/webm": "webm",
          "video/x-matroska": "mkv",
          "audio/mpeg": "mp3",
          "audio/wav": "wav",
          "audio/ogg": "ogg",
          "application/pdf": "pdf",
        };
        const key = mime.trim().toLowerCase();
        return lookup[key];
      };

      const extractExtensionFromPath = (value: string) => {
        const match = value.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        return match ? match[1] : undefined;
      };

      const buildFileName = (fallbackHash: string) => {
        const rawName = sourceBlob.name?.trim();
        if (rawName && /\.[a-zA-Z0-9]{1,8}$/.test(rawName)) {
          return rawName.replace(/[\\/]/g, "_");
        }
        if (rawName) {
          const safeRaw = rawName.replace(/[\\/]/g, "_");
          const inferredExt = inferExtensionFromType(sourceBlob.type);
          if (inferredExt) return `${safeRaw}.${inferredExt}`;
          return safeRaw;
        }
        let derived = fallbackHash;
        const sourceUrl = sourceBlob.url!;
        try {
          const url = new URL(sourceUrl);
          const tail = url.pathname.split("/").pop();
          if (tail) derived = tail;
        } catch (error) {
          const tail = sourceUrl.split("/").pop();
          if (tail) derived = tail;
        }
        derived = derived.replace(/[?#].*$/, "");
        if (!/\.[a-zA-Z0-9]{1,8}$/.test(derived)) {
          const urlExt = extractExtensionFromPath(sourceUrl);
          const typeExt = inferExtensionFromType(sourceBlob.type);
          const extension = urlExt || typeExt;
          if (extension) {
            return `${derived}.${extension}`.replace(/[\\/]/g, "_");
          }
        }
        return derived.replace(/[\\/]/g, "_");
      };

      const headers: Record<string, string> = {};
      try {
        const sourceUrl = sourceBlob.url!;
        if (sourceServer.requiresAuth && template) {
          if (sourceServer.type === "blossom") {
            const url = new URL(sourceUrl);
            const auth = await buildAuthorizationHeader(template, "get", {
              hash: sourceBlob.sha256,
              serverUrl: sourceServer.url,
              urlPath: url.pathname || `/${sourceBlob.sha256}`,
            });
            headers.Authorization = auth;
          } else if (sourceServer.type === "nip96") {
            const auth = await buildNip98AuthHeader(template, {
              url: sourceUrl,
              method: "GET",
            });
            headers.Authorization = auth;
          }
        }
        const response = await fetch(sourceUrl, { headers });
        if (!response.ok) {
          return null;
        }
        const blobData = await response.blob();
        const preferredType = sourceBlob.type || blobData.type || "application/octet-stream";
        const fileName = buildFileName(sourceBlob.sha256);
        return new File([blobData], fileName, { type: preferredType });
      } catch (error) {
        console.error("Failed to fetch blob for sync", error);
        return null;
      }
    },
    [signEventTemplate]
  );


  useEffect(() => {
    if (signer) {
      unauthorizedSyncTargetsRef.current.clear();
    }
  }, [signer]);

  useEffect(() => {
    if (syncEnabledServers.length < 2) {
      setSyncStatus({ state: "idle", progress: 0 });
      return;
    }
    const activeTransfers = syncTransfers.filter(item => item.status === "uploading" || item.status === "success");
    const uploading = syncTransfers.some(item => item.status === "uploading");
    if (uploading && activeTransfers.length > 0) {
      const totals = activeTransfers.reduce(
        (acc, item) => {
          const total = item.total || 0;
          const transferred = item.status === "success" ? total : Math.min(total, item.transferred);
          return {
            transferred: acc.transferred + transferred,
            total: acc.total + total,
          };
        },
        { transferred: 0, total: 0 }
      );
      const progress = totals.total > 0 ? totals.transferred / totals.total : 0;
      setSyncStatus({ state: "syncing", progress });
      return;
    }
    if (syncTransfers.some(item => item.status === "error")) {
      setSyncStatus({ state: "error", progress: 0 });
      return;
    }
    setSyncStatus({ state: "synced", progress: 1 });
  }, [syncEnabledServers.length, syncTransfers]);

  useEffect(() => {
    if (syncEnabledServers.length < 2) return;

    let cancelled = false;
    const syncUrlSet = new Set(syncEnabledServers.map(server => server.url));

    const run = async () => {
      for (const target of syncEnabledServers) {
        if (cancelled) break;
        const targetSnapshot = snapshots.find(snapshot => snapshot.server.url === target.url);
        if (!targetSnapshot || targetSnapshot.isLoading) continue;

        const existing = new Set(targetSnapshot.blobs.map(blob => blob.sha256));

        for (const [sha, entry] of Object.entries(distribution)) {
          if (cancelled) break;
          if (existing.has(sha)) continue;
          if (!entry.servers.some(url => syncUrlSet.has(url) && url !== target.url)) continue;

          const key = `${target.url}::${sha}`;
          const nextAllowedAt = nextSyncAttemptRef.current.get(key) ?? 0;
          if (Date.now() < nextAllowedAt) continue;
          if (syncQueueRef.current.has(key)) continue;

          const sourceUrl = entry.servers.find(url => url !== target.url && syncUrlSet.has(url));
          if (!sourceUrl) continue;

          const sourceSnapshot = snapshots.find(snapshot => snapshot.server.url === sourceUrl);
          if (!sourceSnapshot || sourceSnapshot.isLoading) continue;

          const sourceBlob = sourceSnapshot.blobs.find(blob => blob.sha256 === sha);
          if (!sourceBlob || !sourceBlob.url) continue;

          if (target.requiresAuth && !signer) continue;
          if (target.requiresAuth && !signEventTemplate) continue;

          if (target.type !== "blossom" && target.type !== "nip96") continue;

          const transferId = `sync-${target.url}-${sha}`;
          const fileName = sourceBlob.name || sha;
          const totalSize = sourceBlob.size && sourceBlob.size > 0 ? sourceBlob.size : 1;
          const baseTransfer: TransferState = {
            id: transferId,
            serverUrl: target.url,
            fileName,
            transferred: 0,
            total: totalSize,
            status: "uploading",
            kind: "sync",
          };

          if (unauthorizedSyncTargetsRef.current.has(target.url)) {
            setSyncTransfers(prev => {
              const filtered = prev.filter(item => item.id !== transferId);
              return [
                ...filtered,
                { ...baseTransfer, status: "error", message: "Sync auth failed" },
              ];
            });
            nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
            continue;
          }

          syncQueueRef.current.add(key);
          setSyncTransfers(prev => {
            const filtered = prev.filter(item => item.id !== transferId);
            const next = [...filtered, baseTransfer];
            return next.slice(-40);
          });
          try {
            let completed = false;
            const mirrorUnsupported = unsupportedMirrorTargetsRef.current.has(target.url);
            const uploadDirectlyToBlossom = async () => {
              const file = await fetchBlobAsFile(sourceBlob, sourceSnapshot.server);
              if (!file) {
                nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              const fallbackTotal = file.size > 0 ? file.size : totalSize;
              const sourceSizeRaw = sourceBlob.size;
              const parsedSourceSize =
                sourceSizeRaw === undefined || sourceSizeRaw === null ? undefined : Number(sourceSizeRaw);
              const sourceSize =
                typeof parsedSourceSize === "number" && Number.isFinite(parsedSourceSize)
                  ? Math.round(parsedSourceSize)
                  : undefined;
              const shouldSkipSizeTag = typeof sourceSize === "number" && sourceSize > 0 && sourceSize !== file.size;
              await uploadBlobToServer(
                target.url,
                file,
                target.requiresAuth ? signEventTemplate : undefined,
                Boolean(target.requiresAuth),
                progress => {
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setSyncTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                },
                shouldSkipSizeTag ? { skipSizeTag: true } : undefined
              );
              return fallbackTotal;
            };
            if (target.type === "blossom") {
              if (!mirrorUnsupported) {
                try {
                  await mirrorBlobToServer(
                    target.url,
                    sourceBlob.url,
                    target.requiresAuth ? signEventTemplate : undefined,
                    Boolean(target.requiresAuth)
                  );
                  completed = true;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const statusMatch = message.match(/status\s*(\d{3})/i);
                  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
                  const canFallback = statusCode === 405 || statusCode === 404;
                  if (!canFallback) {
                    nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                    throw error;
                  }
                  unsupportedMirrorTargetsRef.current.add(target.url);
                  await uploadDirectlyToBlossom();
                  completed = true;
                }
              }
              if (!completed) {
                await uploadDirectlyToBlossom();
                completed = true;
              }
            } else {
              const file = await fetchBlobAsFile(sourceBlob, sourceSnapshot.server);
              if (!file) {
                nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              await uploadBlobToNip96(
                target.url,
                file,
                target.requiresAuth ? signEventTemplate : undefined,
                Boolean(target.requiresAuth),
                progress => {
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : totalSize;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setSyncTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              completed = true;
            }
            if (!completed) {
              throw new Error("Unknown sync completion state");
            }
            nextSyncAttemptRef.current.set(key, Date.now() + 60 * 1000);
            setSyncTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      transferred: item.total || totalSize,
                      total: item.total || totalSize,
                      status: "success",
                    }
                  : item
              )
            );
            if (!cancelled) {
              queryClient.invalidateQueries({ queryKey: ["server-blobs", target.url, pubkey, target.type] });
            }
          } catch (error) {
            console.error("Auto-sync failed", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const statusMatch = errorMessage.match(/status\s*(\d{3})/i);
            const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
            if (statusCode === 404 || statusCode === 405) {
              unsupportedMirrorTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
            } else if (statusCode === 401) {
              unauthorizedSyncTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
              showStatusMessage("Sync auth failed – reconnect your signer.", "error", 6000);
            } else {
              nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
            }
            setSyncTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      status: "error",
                      message:
                        statusCode === 404 || statusCode === 405
                          ? "Sync unsupported: target blocks mirroring"
                          : statusCode === 401
                          ? "Sync auth failed"
                          : errorMessage || "Sync failed",
                    }
                  : item
              )
            );
          } finally {
            syncQueueRef.current.delete(key);
          }
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    distribution,
    fetchBlobAsFile,
    pubkey,
    queryClient,
    signEventTemplate,
    signer,
    snapshots,
    syncEnabledServers,
  ]);

  const currentSnapshot = useMemo(() => snapshots.find(snapshot => snapshot.server.url === selectedServer), [snapshots, selectedServer]);
  const browsingAllServers = selectedServer === null;

  const audio = useAudio();
  const { play } = audio;

  useEffect(() => {
    let ignore = false;
    async function loadProfile() {
      if (!ndk || !user?.pubkey) {
        setAvatarUrl(null);
        return;
      }
      try {
        const evt = await ndk.fetchEvent({ kinds: [0], authors: [user.pubkey] });
        if (evt?.content && !ignore) {
          try {
            const metadata = JSON.parse(evt.content);
            setAvatarUrl(metadata.picture || null);
          } catch (error) {
            if (!ignore) setAvatarUrl(null);
          }
        }
      } catch (error) {
        if (!ignore) setAvatarUrl(null);
      }
    }
    loadProfile();
    return () => {
      ignore = true;
    };
  }, [ndk, user?.pubkey]);

  const handleAddServer = (server: ManagedServer) => {
    const normalized = normalizeManagedServer(server);
    const trimmedUrl = normalized.url;
    if (!trimmedUrl) return;

    setLocalServers(prev => {
      if (prev.find(existing => existing.url === trimmedUrl)) {
        return prev;
      }
      const next = [...prev, normalized];
      return sortServersByName(next);
    });
    setSelectedServer(trimmedUrl);
  };

  const handleUpdateServer = (originalUrl: string, updated: ManagedServer) => {
    const normalized = normalizeManagedServer(updated);
    const normalizedUrl = normalized.url;
    if (!normalizedUrl) return;

    setLocalServers(prev => {
      if (prev.some(server => server.url !== originalUrl && server.url === normalizedUrl)) {
        return prev;
      }
      const updatedList = prev.map(server => (server.url === originalUrl ? normalized : server));
      return sortServersByName(updatedList);
    });

    setSelectedServer(prev => {
      if (prev === originalUrl) {
        return normalizedUrl;
      }
      return prev;
    });
  };

  const handleRemoveServer = (url: string) => {
    setLocalServers(prev => prev.filter(server => server.url !== url));
    if (selectedServer === url) {
      setSelectedServer(null);
    }
  };

  const handleToggleRequiresAuth = (url: string, value: boolean) => {
    setLocalServers(prev => prev.map(server => (server.url === url ? { ...server, requiresAuth: value } : server)));
  };

  const handleToggleSync = (url: string, value: boolean) => {
    setLocalServers(prev => prev.map(server => (server.url === url ? { ...server, sync: value } : server)));
  };

  const handleSaveServers = async () => {
    if (!signer) {
      setBanner("Connect your signer to save servers");
      return;
    }
    if (saving) {
      setBanner("Server list update already in progress.");
      setTimeout(() => setBanner(null), 2000);
      return;
    }
    if (serverValidationError) {
      setBanner(serverValidationError);
      setTimeout(() => setBanner(null), 3000);
      return;
    }
    const normalized = sortServersByName(localServers.map(normalizeManagedServer));
    setLocalServers(normalized);
    try {
      await saveServers(normalized);
      setBanner("Server list updated");
      setTimeout(() => setBanner(null), 2500);
    } catch (error: any) {
      setBanner(error?.message || "Failed to save servers");
    }
  };

  const toggleBlob = (sha: string) => {
    setSelectedBlobs(prev => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });
  };

  const selectManyBlobs = (shas: string[], value: boolean) => {
    setSelectedBlobs(prev => {
      const next = new Set(prev);
      shas.forEach(sha => {
        if (value) {
          next.add(sha);
        } else {
          next.delete(sha);
        }
      });
      return next;
    });
  };

  const toggleTransferTarget = (url: string) => {
    if (localServers.length <= 1) return;
    if (localServers.length === 2 && selectedServer && url === selectedServer) return;
    setTransferTargets(prev => (prev.includes(url) ? prev.filter(item => item !== url) : [...prev, url]));
  };

  const handleStartTransfer = async () => {
    if (transferBusy) return;
    if (selectedBlobItems.length === 0) {
      setTransferFeedback("Select files in Browse to start a transfer.");
      return;
    }
    const targets = transferTargets
      .map(url => localServers.find(server => server.url === url))
      .filter((server): server is ManagedServer => Boolean(server));
    if (targets.length === 0) {
      setTransferFeedback("Choose at least one destination server.");
      return;
    }
    if (selectedBlobItems.some(item => item.server.requiresAuth) && !signEventTemplate) {
      setTransferFeedback("Connect your signer to read from the selected servers.");
      return;
    }
    if (targets.some(server => server.requiresAuth) && (!signer || !signEventTemplate)) {
      setTransferFeedback("Connect your signer to upload to servers that require authorization.");
      return;
    }
    if (missingSourceCount > 0) {
      setTransferFeedback("Bloom couldn't load details for every selected file. Refresh and try again.");
      return;
    }

    setTransferBusy(true);
    setTransferFeedback(null);
    let encounteredError = false;

    const serverNameByUrl = new Map(localServers.map(server => [server.url, server.name]));

    try {
      for (const target of targets) {
        for (const { blob, server: sourceServer } of selectedBlobItems) {
          const sha = blob.sha256;
          const transferId = `transfer-${target.url}-${sha}`;
          const fileName = blob.name || sha;
          const totalSize = blob.size && blob.size > 0 ? blob.size : 1;
          const baseTransfer: TransferState = {
            id: transferId,
            serverUrl: target.url,
            fileName,
            transferred: 0,
            total: totalSize,
            status: "uploading",
            kind: "transfer",
          };

          const existing = distribution[sha];
          if (existing?.servers.includes(target.url)) {
            setManualTransfers(prev => {
              const filtered = prev.filter(item => item.id !== transferId);
              const completedTransfer: TransferState = {
                ...baseTransfer,
                transferred: totalSize,
                total: totalSize,
                status: "success",
                message: "Already present",
              };
              const next: TransferState[] = [...filtered, completedTransfer];
              return next.slice(-60);
            });
            continue;
          }

          setManualTransfers(prev => {
            const filtered = prev.filter(item => item.id !== transferId);
            const next: TransferState[] = [...filtered, baseTransfer];
            return next.slice(-60);
          });

          try {
            let completed = false;
            if (target.type === "blossom") {
              const mirrorUnsupported = unsupportedMirrorTargetsRef.current.has(target.url);
              if (!mirrorUnsupported) {
                try {
                  if (!blob.url) {
                    throw new Error("Missing source URL for mirror operation");
                  }
                  await mirrorBlobToServer(
                    target.url,
                    blob.url,
                    target.requiresAuth ? signEventTemplate : undefined,
                    Boolean(target.requiresAuth)
                  );
                  completed = true;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const statusMatch = message.match(/status\s*(\d{3})/i);
                  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
                  if (statusCode === 404 || statusCode === 405) {
                    unsupportedMirrorTargetsRef.current.add(target.url);
                  } else if (statusCode === 401) {
                    unauthorizedSyncTargetsRef.current.add(target.url);
                    throw new Error("Transfer auth failed");
                  } else {
                    throw error;
                  }
                }
              }

              if (!completed) {
                const file = await fetchBlobAsFile(blob, sourceServer);
                if (!file) {
                  throw new Error(
                    `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`
                  );
                }
                const fallbackTotal = file.size > 0 ? file.size : totalSize;
                const sourceSizeRaw = blob.size;
                const parsedSourceSize =
                  sourceSizeRaw === undefined || sourceSizeRaw === null ? undefined : Number(sourceSizeRaw);
                const sourceSize =
                  typeof parsedSourceSize === "number" && Number.isFinite(parsedSourceSize)
                    ? Math.round(parsedSourceSize)
                    : undefined;
                const shouldSkipSizeTag = typeof sourceSize === "number" && sourceSize > 0 && sourceSize !== file.size;
                await uploadBlobToServer(
                  target.url,
                  file,
                  target.requiresAuth ? signEventTemplate : undefined,
                  Boolean(target.requiresAuth),
                  progress => {
                    const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                    const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                    const loaded = Math.min(totalProgress, loadedRaw);
                    setManualTransfers(prev =>
                      prev.map(item =>
                        item.id === transferId
                          ? {
                              ...item,
                              transferred: loaded,
                              total: totalProgress,
                            }
                          : item
                      )
                    );
                  },
                  shouldSkipSizeTag ? { skipSizeTag: true } : undefined
                );
                completed = true;
              }
            } else {
              const file = await fetchBlobAsFile(blob, sourceServer);
              if (!file) {
                throw new Error(
                  `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`
                );
              }
              await uploadBlobToNip96(
                target.url,
                file,
                target.requiresAuth ? signEventTemplate : undefined,
                Boolean(target.requiresAuth),
                progress => {
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : file.size || totalSize;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setManualTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              completed = true;
            }

            if (!completed) {
              throw new Error("Unknown transfer completion state");
            }

            setManualTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      transferred: item.total || totalSize,
                      total: item.total || totalSize,
                      status: "success",
                    }
                  : item
              )
            );
            if (pubkey) {
              await queryClient.invalidateQueries({ queryKey: ["server-blobs", target.url, pubkey, target.type] });
            }
          } catch (error) {
            encounteredError = true;
            const message = error instanceof Error ? error.message : String(error);
            const statusMatch = message.match(/status\s*(\d{3})/i);
            const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
            if (statusCode === 401) {
              unauthorizedSyncTargetsRef.current.add(target.url);
            }
            if (statusCode === 404 || statusCode === 405) {
              unsupportedMirrorTargetsRef.current.add(target.url);
            }
            setManualTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      status: "error",
                      message: message || "Transfer failed",
                    }
                  : item
              )
            );
          }
        }
      }

      if (!encounteredError) {
        setTransferFeedback("Transfer complete.");
      } else {
        setTransferFeedback("Transfer finished with some issues. Review the activity log below.");
      }
    } finally {
      setTransferBusy(false);
    }
  };

  const handleDeleteBlob = async (blob: BlossomBlob) => {
    if (!currentSnapshot) {
      showStatusMessage("Select a specific server to delete files.", "error", 2000);
      return;
    }
    const confirmDelete = window.confirm(`Delete ${blob.sha256.slice(0, 10)}… from ${currentSnapshot.server.name}?`);
    if (!confirmDelete) return;
    if (currentSnapshot.server.requiresAuth && !signer) {
      showStatusMessage("Connect your signer to delete from this server.", "error", 2000);
      return;
    }
    try {
      if (currentSnapshot.server.type === "nip96") {
        await deleteNip96File(
          currentSnapshot.server.url,
          blob.sha256,
          currentSnapshot.server.requiresAuth ? signEventTemplate : undefined,
          Boolean(currentSnapshot.server.requiresAuth)
        );
      } else {
        await deleteUserBlob(
          currentSnapshot.server.url,
          blob.sha256,
          currentSnapshot.server.requiresAuth ? signEventTemplate : undefined,
          Boolean(currentSnapshot.server.requiresAuth)
        );
      }
      queryClient.invalidateQueries({ queryKey: ["server-blobs", currentSnapshot.server.url, pubkey, currentSnapshot.server.type] });
      setSelectedBlobs(prev => {
        const next = new Set(prev);
        next.delete(blob.sha256);
        return next;
      });
      setBanner("Blob deleted");
      setTimeout(() => setBanner(null), 2000);
    } catch (error: any) {
      showStatusMessage(error?.message || "Delete failed", "error", 5000);
    }
  };

  const handleCopyUrl = (blob: BlossomBlob) => {
    if (!blob.url) return;
    navigator.clipboard.writeText(blob.url).catch(() => undefined);
    showStatusMessage("URL copied to clipboard", "success", 1500);
  };

  const handleUploadCompleted = (success: boolean) => {
    if (!success) return;

    servers.forEach(server => queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url] }));
    setTab("browse");
    showStatusMessage("All files uploaded successfully", "success", 5000);
  };

  const handleStatusServerChange: React.ChangeEventHandler<HTMLSelectElement> = event => {
    const value = event.target.value;
    if (value === ALL_SERVERS_VALUE) {
      setSelectedServer(null);
    } else {
      setSelectedServer(value);
    }
    setTab("browse");
  };

  const currentSize = useMemo(() => {
    if (!currentSnapshot) return 0;
    return currentSnapshot.blobs.reduce((acc, blob) => acc + (blob.size || 0), 0);
  }, [currentSnapshot]);

  const statusCount = currentSnapshot?.blobs.length ?? aggregated.count;
  const statusSize = currentSnapshot ? currentSize : aggregated.size;
  const statusSelectValue = selectedServer ?? ALL_SERVERS_VALUE;
  const syncIndicator = useMemo(() => {
    if (syncEnabledServers.length < 2) return null;
    if (syncStatus.state === "syncing") {
      const percent = Math.min(100, Math.max(0, Math.round((syncStatus.progress || 0) * 100)));
      return `Syncing servers - ${percent}%`;
    }
    if (syncStatus.state === "synced") {
      return "Synced";
    }
    if (syncStatus.state === "error") {
      return "Sync issue";
    }
    return null;
  }, [syncEnabledServers.length, syncStatus]);
  const centerMessage = statusMessage ?? syncIndicator;
  const centerClass = statusMessage
    ? statusMessageTone === "error"
      ? "text-red-400"
      : statusMessageTone === "success"
      ? "text-emerald-300"
      : "text-slate-400"
    : syncStatus.state === "syncing"
    ? "text-emerald-300"
    : syncStatus.state === "synced"
    ? "text-emerald-200"
    : syncStatus.state === "error"
    ? "text-red-400"
    : "text-slate-500";
  const disableTransferAction =
    transferBusy || transferTargets.length === 0 || selectedBlobItems.length === 0 || localServers.length <= 1;

  return (
    <div className="flex min-h-screen max-h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full flex-1 min-h-0 flex-col gap-6 overflow-hidden px-6 py-8 max-w-7xl">
        <header className="flex flex-wrap items-center gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Bloom</h1>
            <p className="text-xs text-slate-400">
              Manage your content, upload media, and mirror files across servers.
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
            {user && (
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={toggleUserMenu}
                  className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-800 bg-slate-900/70 p-0 text-xs text-slate-200 transition hover:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  aria-haspopup="menu"
                  aria-expanded={isUserMenuOpen}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt="User avatar"
                      className="block h-full w-full object-cover"
                      onError={() => setAvatarUrl(null)}
                    />
                  ) : (
                    <span className="font-semibold">{userInitials}</span>
                  )}
                </button>
                {isUserMenuOpen && (
                  <div className="absolute right-0 z-10 mt-2 min-w-[8rem] rounded-md bg-slate-900 px-2 py-1 text-sm shadow-lg">
                    <ul className="flex flex-col gap-1 text-slate-200">
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleSelectServers();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Servers
                        </a>
                      </li>
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleDisconnectClick();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Disconnect
                        </a>
                      </li>
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {banner && <div className="rounded-xl border border-emerald-500 bg-emerald-500/10 px-4 py-2 text-sm">{banner}</div>}

        <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70">
          <div
            ref={mainWidgetRef}
            className={`flex flex-1 min-h-0 flex-col ${showAuthPrompt ? "pointer-events-none opacity-40" : ""}`}
            aria-hidden={showAuthPrompt || undefined}
          >
            <nav className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800">
              <div className="flex gap-3">
                {NAV_TABS.map(item => {
                  const selectedCount = selectedBlobs.size;
                  const isUploadTab = item.id === "upload";
                  const isTransferView = tab === "transfer";
                  const showTransfer = isUploadTab && selectedCount > 0;
                  const isActive = tab === item.id || (isUploadTab && isTransferView);
                  const IconComponent = showTransfer ? TransferIcon : item.icon;
                  const label = showTransfer ? "Transfer" : item.label;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setTab(showTransfer ? "transfer" : item.id)}
                      disabled={showAuthPrompt}
                      className={`px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        isActive
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                      }`}
                    >
                      <IconComponent size={16} />
                      <span className="flex items-center gap-2">
                        {label}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {tab === "browse" && (
                  <>
                    <button
                      onClick={() => setViewMode("grid")}
                      disabled={showAuthPrompt}
                      className={`rounded-xl border px-3 py-2 text-sm flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        viewMode === "grid"
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                      }`}
                      title="Icon view"
                    >
                      <GridIcon size={18} />
                      <span className="hidden sm:inline">Icons</span>
                    </button>
                    <button
                      onClick={() => setViewMode("list")}
                      disabled={showAuthPrompt}
                      className={`rounded-xl border px-3 py-2 text-sm flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        viewMode === "list"
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                      }`}
                      title="List view"
                    >
                      <ListIcon size={18} />
                      <span className="hidden sm:inline">List</span>
                    </button>
                  </>
                )}
              </div>
            </nav>

          <div className={`flex flex-1 min-h-0 flex-col p-4 ${tab === "browse" ? "" : "overflow-y-auto"}`}>
            {tab === "browse" && (
              <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                {browsingAllServers ? (
                  <BlobList
                    blobs={aggregated.blobs}
                    signTemplate={signEventTemplate}
                    selected={selectedBlobs}
                    viewMode={viewMode}
                    onToggle={toggleBlob}
                    onSelectMany={selectManyBlobs}
                    onDelete={handleDeleteBlob}
                    onCopy={handleCopyUrl}
                    onPlay={blob => blob.url && play({ url: blob.url, title: blob.name })}
                  />
                ) : currentSnapshot ? (
                  <BlobList
                    blobs={currentSnapshot.blobs}
                    baseUrl={currentSnapshot.server.url}
                    requiresAuth={currentSnapshot.server.requiresAuth}
                    signTemplate={currentSnapshot.server.requiresAuth ? signEventTemplate : undefined}
                    serverType={currentSnapshot.server.type}
                    selected={selectedBlobs}
                    viewMode={viewMode}
                    onToggle={toggleBlob}
                    onSelectMany={selectManyBlobs}
                    onDelete={handleDeleteBlob}
                    onCopy={handleCopyUrl}
                    onPlay={blob => blob.url && play({ url: blob.url, title: blob.name })}
                  />
                ) : (
                  <div className="text-sm text-slate-400">Select a server to browse its contents.</div>
                )}
              </div>
            )}

            {tab === "upload" && (
              <UploadPanel
                servers={servers}
                onUploaded={handleUploadCompleted}
                syncTransfers={syncTransfers}
              />
            )}

            {tab === "transfer" && (
              <div className="space-y-6">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-5">
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">Transfer files</h2>
                    <p className="text-sm text-slate-400">Select where Bloom should copy the files you picked in Browse.</p>
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
                          From {Array.from(sourceServerUrls)
                            .map(url => serverNameMap.get(url) || url)
                            .join(", ") || "unknown server"}
                        </div>
                        {missingSourceCount > 0 && (
                          <div className="text-xs text-amber-300">
                            {missingSourceCount} item{missingSourceCount === 1 ? "" : "s"} could not be fetched right now.
                          </div>
                        )}
                        <ul className="mt-1 space-y-1 text-xs text-slate-400">
                          {selectedBlobItems.slice(0, 6).map(item => (
                            <li key={item.blob.sha256} className="flex items-center justify-between gap-3">
                              <span className="truncate">{item.blob.name || `${item.blob.sha256.slice(0, 12)}…`}</span>
                              <span>{prettyBytes(item.blob.size || 0)}</span>
                            </li>
                          ))}
                          {selectedBlobItems.length > 6 && (
                            <li className="text-xs text-slate-500">+ {selectedBlobItems.length - 6} more</li>
                          )}
                        </ul>
                      </div>
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
                              const requiresAuth = Boolean(server.requiresAuth);
                              const isDisabled =
                                localServers.length <= 1 ||
                                (localServers.length === 2 && Boolean(selectedServer) && server.url === selectedServer);
                              return (
                                <label
                                  key={server.url}
                                  className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition ${
                                    isChecked
                                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                                      : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                                  } ${
                                    isDisabled ? "opacity-60 cursor-not-allowed" : ""
                                  }`}
                                  aria-disabled={isDisabled}
                                >
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium truncate">{server.name}</div>
                                    <div className="text-xs text-slate-500 truncate">{server.url}</div>
                                    {requiresAuth && (!signer || !signEventTemplate) && (
                                      <div className="mt-1 text-[11px] text-amber-300">Signer required</div>
                                    )}
                                  </div>
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    checked={isChecked}
                                    disabled={isDisabled}
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
                          onClick={() => setTab("browse")}
                          className="px-4 py-2 rounded-xl border border-slate-800 bg-slate-900/60 text-sm text-slate-300 hover:border-slate-700"
                        >
                          Back to Browse
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
                              <div className="mt-2 text-xs text-red-400">{item.message || "Transfer failed"}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "servers" && (
              <ServerList
                servers={localServers}
                selected={selectedServer}
                onSelect={setSelectedServer}
                onAdd={handleAddServer}
                onUpdate={handleUpdateServer}
                onSave={handleSaveServers}
                saving={saving}
                disabled={!signer}
                onRemove={handleRemoveServer}
                onToggleAuth={handleToggleRequiresAuth}
                onToggleSync={handleToggleSync}
                validationError={serverValidationError}
              />
            )}

          </div>
          <footer className="border-t border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="status-server" className="text-[11px] uppercase tracking-wide text-slate-500">
                Server
              </label>
              <select
                id="status-server"
                value={statusSelectValue}
                onChange={handleStatusServerChange}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value={ALL_SERVERS_VALUE}>All servers</option>
                {servers.map(server => (
                  <option key={server.url} value={server.url}>
                    {server.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={`flex-1 text-center ${centerClass}`}>{centerMessage ?? ""}</div>
            <div className="ml-auto flex gap-4">
              <span>{statusCount} item{statusCount === 1 ? "" : "s"}</span>
              <span>{prettyBytes(statusSize)}</span>
            </div>
          </footer>
          </div>

          {showAuthPrompt && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-slate-950/80 px-6 text-center backdrop-blur-sm">
              <p className="text-sm text-slate-200">Connect your Nostr account to use Bloom.</p>
              <button
                onClick={connect}
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
              >
                Connect (NIP-07)
              </button>
            </div>
          )}
        </div>

        {audio.current && (
          <div className="fixed bottom-4 right-4 bg-slate-900/80 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 shadow-lg">
            <div className="font-medium">Now playing</div>
            <div className="text-xs text-slate-400">{audio.current.title || audio.current.url}</div>
            <div className="flex gap-2 mt-2">
              <button onClick={audio.stop} className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs">Stop</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
