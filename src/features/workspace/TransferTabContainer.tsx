import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "./WorkspaceContext";
import { useSelection } from "../selection/SelectionContext";
import type { StatusMessageTone } from "../../shared/types/status";
import type { ManagedServer } from "../../shared/types/servers";
import type { BlossomBlob, UploadStreamSource } from "../../shared/api/blossomClient";
import {
  mirrorBlobToServer,
  uploadBlobToServer,
  buildAuthorizationHeader,
} from "../../shared/api/blossomClient";
import { uploadBlobToNip96 } from "../../shared/api/nip96Client";
import { uploadBlobToSatellite } from "../../shared/api/satelliteClient";
import { buildNip98AuthHeader } from "../../shared/api/nip98";
import {
  getBlobMetadataName,
  normalizeFolderPathInput,
} from "../../shared/utils/blobMetadataStore";
import type { TransferState } from "./ui/UploadPanel";
import { BloomHttpError } from "../../shared/api/httpService";
import { useNdk, useCurrentPubkey } from "../../app/context/NdkContext";
import type { SignTemplate } from "../../shared/api/blossomClient";
import { publishNip94Metadata, extractExtraNip94Tags } from "../../shared/api/nip94Publisher";
import { useFolderLists } from "../../app/context/FolderListContext";
import { usePrivateLibrary } from "../../app/context/PrivateLibraryContext";
import { usePreferredRelays } from "../../app/hooks/usePreferredRelays";
import type { PrivateListEntry } from "../../shared/domain/privateList";

const TransferContentLazy = React.lazy(() =>
  import("../transfer/TransferContent").then(module => ({ default: module.TransferContent })),
);

export type SyncStatus = { state: "idle" | "syncing" | "synced" | "error"; progress: number };

export type SyncStateSnapshot = {
  syncStatus: SyncStatus;
  syncAutoReady: boolean;
  allLinkedServersSynced: boolean;
};

export type TransferTabContainerProps = {
  active: boolean;
  onBackToBrowse: () => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  onSyncStateChange: (snapshot: SyncStateSnapshot) => void;
  onSyncTransfersChange: (transfers: TransferState[]) => void;
  onProvideSyncStarter: (runner: () => void) => void;
};

type SelectedBlobItem = {
  blob: BlossomBlob;
  server: ManagedServer;
};

type TransferFeedbackTone =
  | "text-slate-400"
  | "text-emerald-300"
  | "text-amber-300"
  | "text-red-400";

export const TransferTabContainer: React.FC<TransferTabContainerProps> = ({
  active,
  onBackToBrowse,
  showStatusMessage,
  onSyncStateChange,
  onSyncTransfersChange,
  onProvideSyncStarter,
}) => {
  const {
    servers,
    distribution,
    snapshots,
    selectedServer,
    syncEnabledServers,
    syncEnabledServerUrls,
  } = useWorkspace();
  const { selected: selectedBlobs } = useSelection();
  const { signer, signEventTemplate, ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const queryClient = useQueryClient();

  const [transferTargets, setTransferTargets] = useState<string[]>([]);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferFeedback, setTransferFeedback] = useState<string | null>(null);
  const [manualTransfers, setManualTransfers] = useState<TransferState[]>([]);
  const [syncTransfers, setSyncTransfers] = useState<TransferState[]>([]);
  const [autoSyncedServers, setAutoSyncedServers] = useState<string[]>([]);
  const [syncRunToken, setSyncRunToken] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: "idle", progress: 0 });

  const syncQueueRef = useRef<Set<string>>(new Set());
  const nextSyncAttemptRef = useRef<Map<string, number>>(new Map());
  const unsupportedMirrorTargetsRef = useRef<Set<string>>(new Set());
  const unauthorizedSyncTargetsRef = useRef<Set<string>>(new Set());
  const blockedSyncTargetsRef = useRef<Set<string>>(new Set());
  const { setBlobFolderMembership } = useFolderLists();
  const { entriesBySha, upsertEntries } = usePrivateLibrary();
  const { effectiveRelays } = usePreferredRelays();

  useEffect(() => {
    if (signer) {
      unauthorizedSyncTargetsRef.current.clear();
    }
  }, [signer]);

  const selectedBlobSources = useMemo(() => {
    const map = new Map<string, SelectedBlobItem>();
    snapshots.forEach(snapshot => {
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

  const selectedBlobItems = useMemo(
    () => Array.from(selectedBlobSources.values()),
    [selectedBlobSources],
  );

  const selectedBlobTotalSize = useMemo(
    () => selectedBlobItems.reduce((total, item) => total + (item.blob.size || 0), 0),
    [selectedBlobItems],
  );

  const sourceServerUrls = useMemo(() => {
    const set = new Set<string>();
    selectedBlobItems.forEach(item => set.add(item.server.url));
    return set;
  }, [selectedBlobItems]);

  const missingSourceCount = useMemo(() => {
    if (selectedBlobs.size === selectedBlobSources.size) return 0;
    return selectedBlobs.size - selectedBlobSources.size;
  }, [selectedBlobs, selectedBlobSources]);

  const ensurePostTransferMetadata = useCallback(
    async (blob: BlossomBlob, target: ManagedServer) => {
      const normalizeServerUrl = (value: string) => value.replace(/\/+$/, "");
      const rawFolder = blob.privateData?.metadata?.folderPath ?? blob.folderPath ?? undefined;
      const normalizedFolder = normalizeFolderPathInput(rawFolder);
      const folderPathForMetadata =
        typeof normalizedFolder === "string" && normalizedFolder.length > 0
          ? normalizedFolder
          : undefined;
      const folderPathForPrivate =
        normalizedFolder === undefined ? undefined : (normalizedFolder ?? null);

      if (blob.privateData) {
        const entry = entriesBySha.get(blob.sha256);
        if (!entry) return;
        const normalizedTargetUrl = normalizeServerUrl(target.url);
        const existingServers = new Set(
          (entry.servers ?? []).map(server => normalizeServerUrl(server)),
        );
        let needsServerUpdate = false;
        if (!existingServers.has(normalizedTargetUrl)) {
          existingServers.add(normalizedTargetUrl);
          needsServerUpdate = true;
        }
        const existingFolder =
          normalizeFolderPathInput(entry.metadata?.folderPath ?? undefined) ?? null;
        const needsFolderUpdate =
          folderPathForPrivate !== undefined && existingFolder !== folderPathForPrivate;
        if (!needsServerUpdate && !needsFolderUpdate) return;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const nextEntry: PrivateListEntry = {
          ...entry,
          servers: Array.from(existingServers),
          metadata:
            folderPathForPrivate === undefined
              ? entry.metadata
              : {
                  ...(entry.metadata ?? {}),
                  folderPath: folderPathForPrivate,
                },
          updatedAt: nowSeconds,
        };
        try {
          await upsertEntries([nextEntry]);
        } catch (error) {
          console.warn("Failed to update private folder metadata after transfer", error);
        }
        return;
      }

      if (folderPathForMetadata) {
        try {
          await setBlobFolderMembership(blob.sha256, folderPathForMetadata);
        } catch (error) {
          console.warn("Failed to update folder membership after transfer", error);
        }
      }

      if (!ndk || !signer) return;
      try {
        const extraTags = extractExtraNip94Tags(blob.nip94);
        const alias = getBlobMetadataName(blob) ?? blob.name ?? null;
        await publishNip94Metadata({
          ndk,
          signer,
          blob,
          relays: effectiveRelays,
          alias,
          folderPath: folderPathForMetadata,
          extraTags,
        });
      } catch (error) {
        console.warn("Failed to publish NIP-94 metadata after transfer", error);
      }
    },
    [entriesBySha, effectiveRelays, ndk, setBlobFolderMembership, signer, upsertEntries],
  );

  const syncCoverage = useMemo(() => {
    if (selectedBlobItems.length === 0) {
      return {
        shared: new Set<string>(),
        sharedKey: "",
        universe: new Set<string>(),
      };
    }
    const allServerUrls = new Set(servers.map(server => server.url));
    let shared: Set<string> | null = null;
    const universe = new Set<string>();

    selectedBlobItems.forEach(item => {
      const entry = distribution[item.blob.sha256];
      const present = new Set(
        (entry ? entry.servers : [item.server.url]).filter(url => allServerUrls.has(url)),
      );
      present.forEach(url => universe.add(url));
      if (shared === null) {
        shared = new Set(present);
      } else {
        shared.forEach(url => {
          if (!present.has(url)) {
            shared!.delete(url);
          }
        });
      }
    });

    const effectiveShared = shared ?? new Set<string>();
    return {
      shared: effectiveShared,
      sharedKey: Array.from(effectiveShared).sort().join("|"),
      universe,
    };
  }, [distribution, selectedBlobItems, servers]);

  const transferFeedbackTone = useMemo<TransferFeedbackTone>(() => {
    if (!transferFeedback) return "text-slate-400";
    const normalized = transferFeedback.toLowerCase();
    if (normalized.includes("issue") || normalized.includes("try again")) return "text-amber-300";
    if (
      normalized.includes("failed") ||
      normalized.includes("unable") ||
      normalized.includes("error")
    ) {
      return "text-red-400";
    }
    return "text-emerald-300";
  }, [transferFeedback]);

  const transferActivity = useMemo(() => manualTransfers.slice().reverse(), [manualTransfers]);

  const syncEnabledUrlSet = useMemo(() => new Set(syncEnabledServerUrls), [syncEnabledServerUrls]);
  const autoSyncedSet = useMemo(() => new Set(autoSyncedServers), [autoSyncedServers]);
  const syncAutoReady =
    syncEnabledServerUrls.length >= 2 && syncEnabledServerUrls.every(url => autoSyncedSet.has(url));

  const allLinkedServersSynced = useMemo(() => {
    if (syncEnabledServerUrls.length < 2) return true;
    if (syncEnabledUrlSet.size < 2) return true;
    for (const entry of Object.values(distribution)) {
      const presentCount = entry.servers.reduce(
        (acc, url) => acc + (syncEnabledUrlSet.has(url) ? 1 : 0),
        0,
      );
      if (presentCount > 0 && presentCount < syncEnabledUrlSet.size) {
        return false;
      }
    }
    return true;
  }, [distribution, syncEnabledServerUrls.length, syncEnabledUrlSet]);

  useEffect(() => {
    onSyncStateChange({ syncStatus, syncAutoReady, allLinkedServersSynced });
  }, [allLinkedServersSynced, onSyncStateChange, syncAutoReady, syncStatus]);

  useEffect(() => {
    onSyncTransfersChange(syncTransfers);
  }, [onSyncTransfersChange, syncTransfers]);

  useEffect(() => {
    setAutoSyncedServers(prev => {
      if (!prev.length) return prev;
      const filtered = prev.filter(url => syncEnabledServerUrls.includes(url));
      return filtered.length === prev.length ? prev : filtered;
    });

    if (blockedSyncTargetsRef.current.size > 0) {
      const allowed = new Set(syncEnabledServerUrls);
      const stale: string[] = [];
      blockedSyncTargetsRef.current.forEach(url => {
        if (!allowed.has(url)) {
          stale.push(url);
        }
      });
      stale.forEach(url => blockedSyncTargetsRef.current.delete(url));
    }
  }, [syncEnabledServerUrls]);

  const syncedServerCount = syncCoverage.shared.size;
  const syncedServerTotal = syncCoverage.universe.size;

  useEffect(() => {
    if (active) return;
    setTransferBusy(false);
    setTransferFeedback(null);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    setTransferTargets(prev => {
      const eligibleServers = servers.filter(
        server => server.url !== selectedServer && !syncCoverage.shared.has(server.url),
      );
      const eligibleUrls = eligibleServers.map(server => server.url);
      const filtered = prev.filter(url => eligibleUrls.includes(url));
      let next: string[] = [];
      if (eligibleUrls.length === 0) {
        next = [];
      } else if (filtered.length > 0) {
        next = filtered;
      } else {
        const fallback = eligibleUrls.find(Boolean);
        next = fallback ? [fallback] : [];
      }
      const sameLength = next.length === prev.length;
      const sameOrder = sameLength && next.every((url, index) => url === prev[index]);
      return sameOrder ? prev : next;
    });
  }, [active, servers, selectedServer, syncCoverage.sharedKey]);

  useEffect(() => {
    const activeTransfers = syncTransfers.filter(
      item => item.status === "uploading" || item.status === "success",
    );
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
        { transferred: 0, total: 0 },
      );
      const progress = totals.total > 0 ? totals.transferred / totals.total : 0;
      setSyncStatus({ state: "syncing", progress });
      return;
    }
    if (syncTransfers.some(item => item.status === "error")) {
      setSyncStatus({ state: "error", progress: 0 });
      return;
    }
    if (allLinkedServersSynced) {
      setSyncStatus({ state: "synced", progress: 1 });
      return;
    }
    setSyncStatus({ state: "idle", progress: 0 });
  }, [allLinkedServersSynced, syncTransfers]);

  useEffect(() => {
    if (syncEnabledServerUrls.length < 2) return;
    if (!syncAutoReady) return;

    let cancelled = false;
    const syncUrlSet = new Set(syncEnabledServerUrls);

    const run = async () => {
      for (const target of syncEnabledServers) {
        if (cancelled) break;
        if (blockedSyncTargetsRef.current.has(target.url)) continue;
        const targetSnapshot = snapshots.find(snapshot => snapshot.server.url === target.url);
        if (!targetSnapshot || targetSnapshot.isLoading) continue;

        const existing = new Set(targetSnapshot.blobs.map(blob => blob.sha256));

        let skipRemainingForTarget = false;
        for (const [sha, entry] of Object.entries(distribution)) {
          if (cancelled || skipRemainingForTarget) break;
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

          const targetNeedsSigner = Boolean(target.requiresAuth);
          if (targetNeedsSigner && !signer) continue;
          if (targetNeedsSigner && !signEventTemplate) continue;

          if (target.type !== "blossom" && target.type !== "nip96" && target.type !== "satellite")
            continue;

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
            const targetRequiresAuth = Boolean(target.requiresAuth);
            const mirrorUnsupported = unsupportedMirrorTargetsRef.current.has(target.url);
            const finalizeProgress = (loaded: number, total: number) => {
              setSyncTransfers(prev =>
                prev.map(item =>
                  item.id === transferId
                    ? {
                        ...item,
                        transferred: loaded,
                        total,
                      }
                    : item,
                ),
              );
            };

            const uploadDirectlyToBlossom = async () => {
              const streamSource = createBlobStreamSource(
                sourceBlob,
                sourceSnapshot.server,
                signEventTemplate,
              );
              if (!streamSource) {
                nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              const fallbackTotal =
                streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
              await uploadBlobToServer(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const totalProgress =
                    progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  finalizeProgress(loaded, totalProgress);
                },
              );
              return fallbackTotal;
            };

            if (target.type === "blossom") {
              if (!mirrorUnsupported) {
                try {
                  await mirrorBlobToServer(
                    target.url,
                    sourceBlob.url,
                    targetRequiresAuth ? signEventTemplate : undefined,
                    targetRequiresAuth,
                    sourceBlob.sha256,
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
            } else if (target.type === "nip96") {
              const streamSource = createBlobStreamSource(
                sourceBlob,
                sourceSnapshot.server,
                signEventTemplate,
              );
              if (!streamSource) {
                nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              await uploadBlobToNip96(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal =
                    streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress =
                    progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  finalizeProgress(loaded, totalProgress);
                },
              );
              completed = true;
            } else if (target.type === "satellite") {
              const streamSource = createBlobStreamSource(
                sourceBlob,
                sourceSnapshot.server,
                signEventTemplate,
              );
              if (!streamSource) {
                nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              const satelliteLabel = sourceBlob.name || fileName;
              await uploadBlobToSatellite(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal =
                    streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress =
                    progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  finalizeProgress(loaded, totalProgress);
                },
                { label: satelliteLabel },
              );
              completed = true;
            } else {
              throw new Error(`Unsupported target type: ${target.type}`);
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
                  : item,
              ),
            );
            if (!cancelled && pubkey) {
              queryClient.invalidateQueries({
                queryKey: ["server-blobs", target.url, pubkey, target.type],
              });
            }
          } catch (error) {
            console.error("Auto-sync failed", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const statusMatch = errorMessage.match(/status\s*(\d{3})/i);
            const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
            const cause =
              error instanceof BloomHttpError
                ? error.cause
                : error instanceof Error && "cause" in error
                  ? (error as Error & { cause?: unknown }).cause
                  : undefined;
            const isNetworkError =
              error instanceof TypeError ||
              cause instanceof TypeError ||
              (cause &&
                typeof cause === "object" &&
                (cause as { name?: string }).name === "TypeError") ||
              errorMessage.toLowerCase().includes("unable to fetch blob content for sync");
            if (isNetworkError) {
              const alreadyBlocked = blockedSyncTargetsRef.current.has(target.url);
              blockedSyncTargetsRef.current.add(target.url);
              unsupportedMirrorTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
              if (!alreadyBlocked) {
                showStatusMessage(
                  "Sync blocked: remote server disallows cross-origin requests.",
                  "error",
                  6000,
                );
              }
            } else if (statusCode === 404 || statusCode === 405) {
              unsupportedMirrorTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
            } else if (statusCode === 401) {
              unauthorizedSyncTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
              showStatusMessage("Sync auth failed – reconnect your signer.", "error", 6000);
            } else {
              nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
            }
            const syncErrorMessage = isNetworkError
              ? "Sync unsupported: remote server blocks cross-origin requests"
              : statusCode === 404 || statusCode === 405
                ? "Sync unsupported: target blocks mirroring"
                : statusCode === 401
                  ? "Sync auth failed"
                  : errorMessage || "Sync failed";
            setSyncTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      status: "error",
                      message: syncErrorMessage,
                    }
                  : item,
              ),
            );
            if (blockedSyncTargetsRef.current.has(target.url)) {
              skipRemainingForTarget = true;
            }
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
    pubkey,
    queryClient,
    showStatusMessage,
    signEventTemplate,
    signer,
    snapshots,
    syncEnabledServers,
    syncEnabledServerUrls,
    syncAutoReady,
    syncRunToken,
  ]);

  const createBlobStreamSource = useCallback(
    (
      sourceBlob: BlossomBlob,
      sourceServer: ManagedServer,
      template: SignTemplate | undefined,
    ): UploadStreamSource | null => {
      if (!sourceBlob.url) return null;
      const sourceRequiresAuth =
        sourceServer.type === "satellite" ? false : Boolean(sourceServer.requiresAuth);
      if (sourceRequiresAuth && !template) return null;

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
        } catch {
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

      const preferredType = sourceBlob.type || "application/octet-stream";
      const size =
        typeof sourceBlob.size === "number" && Number.isFinite(sourceBlob.size)
          ? Math.max(0, Math.round(sourceBlob.size))
          : undefined;
      const sourceUrl = sourceBlob.url!;

      const buildHeaders = async () => {
        const headers: Record<string, string> = {};
        if (sourceRequiresAuth && template) {
          if (sourceServer.type === "blossom") {
            let url: URL | null = null;
            try {
              url = new URL(sourceUrl);
            } catch {
              url = null;
            }
            const auth = await buildAuthorizationHeader(template, "get", {
              hash: sourceBlob.sha256,
              serverUrl: sourceServer.url,
              urlPath: url ? url.pathname + (url.search || "") : undefined,
              expiresInSeconds: 300,
            });
            headers.Authorization = auth;
          } else if (sourceServer.type === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(template, {
              url: sourceUrl,
              method: "GET",
            });
          }
        }
        return headers;
      };

      return {
        kind: "stream",
        fileName: buildFileName(sourceBlob.sha256),
        contentType: preferredType,
        size,
        async createStream() {
          const headers = await buildHeaders();
          const response = await fetch(sourceUrl, { headers, mode: "cors" });
          if (!response.ok) {
            throw new Error(`Unable to fetch blob from source (${response.status})`);
          }
          if (!response.body) {
            throw new Error("Source response does not support streaming");
          }
          return response.body;
        },
      };
    },
    [signEventTemplate],
  );

  const toggleTransferTarget = (url: string) => {
    if (servers.length <= 1) return;
    if (selectedServer && url === selectedServer) return;
    if (syncCoverage.shared.has(url)) return;
    setTransferTargets(prev =>
      prev.includes(url) ? prev.filter(item => item !== url) : [...prev, url],
    );
  };

  const handleStartTransfer = useCallback(async () => {
    if (transferBusy) return;
    if (selectedBlobItems.length === 0) {
      setTransferFeedback("Select files in Browse to start a transfer.");
      return;
    }
    const targets = transferTargets
      .map(url => servers.find(server => server.url === url))
      .filter((server): server is ManagedServer => Boolean(server));
    if (targets.length === 0) {
      setTransferFeedback("Choose at least one destination server.");
      return;
    }
    if (
      selectedBlobItems.some(
        item => item.server.type !== "satellite" && item.server.requiresAuth,
      ) &&
      !signEventTemplate
    ) {
      setTransferFeedback("Connect your signer to read from the selected servers.");
      return;
    }
    if (targets.some(server => server.requiresAuth) && (!signer || !signEventTemplate)) {
      setTransferFeedback("Connect your signer to upload to servers that require authorization.");
      return;
    }
    if (missingSourceCount > 0) {
      setTransferFeedback(
        "Bloom couldn't load details for every selected file. Refresh and try again.",
      );
      return;
    }

    setTransferBusy(true);
    setTransferFeedback(null);
    let encounteredError = false;
    const serverNameByUrl = new Map(servers.map(server => [server.url, server.name]));

    try {
      for (const target of targets) {
        for (const { blob, server: sourceServer } of selectedBlobItems) {
          const sha = blob.sha256;
          const transferId = `transfer-${target.url}-${sha}`;
          const fileName = getBlobMetadataName(blob) ?? sha;
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
            try {
              await ensurePostTransferMetadata(blob, target);
            } catch (metadataError) {
              console.warn("Failed to refresh metadata for existing blob", metadataError);
            }
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
            const targetRequiresAuth = Boolean(target.requiresAuth);
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
                    targetRequiresAuth ? signEventTemplate : undefined,
                    targetRequiresAuth,
                    blob.sha256,
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
                const streamSource = createBlobStreamSource(blob, sourceServer, signEventTemplate);
                if (!streamSource) {
                  throw new Error(
                    `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`,
                  );
                }
                const fallbackTotal =
                  streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                await uploadBlobToServer(
                  target.url,
                  streamSource,
                  targetRequiresAuth ? signEventTemplate : undefined,
                  targetRequiresAuth,
                  progress => {
                    const totalProgress =
                      progress.total && progress.total > 0 ? progress.total : fallbackTotal;
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
                          : item,
                      ),
                    );
                  },
                );
                completed = true;
              }
            } else if (target.type === "nip96") {
              const streamSource = createBlobStreamSource(blob, sourceServer, signEventTemplate);
              if (!streamSource) {
                throw new Error(
                  `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`,
                );
              }
              await uploadBlobToNip96(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal =
                    streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress =
                    progress.total && progress.total > 0 ? progress.total : fallbackTotal;
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
                        : item,
                    ),
                  );
                },
              );
              completed = true;
            } else if (target.type === "satellite") {
              const streamSource = createBlobStreamSource(blob, sourceServer, signEventTemplate);
              if (!streamSource) {
                throw new Error(
                  `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`,
                );
              }
              const satelliteLabel = getBlobMetadataName(blob) ?? fileName;
              await uploadBlobToSatellite(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal =
                    streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress =
                    progress.total && progress.total > 0 ? progress.total : fallbackTotal;
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
                        : item,
                    ),
                  );
                },
                { label: satelliteLabel },
              );
              completed = true;
            } else {
              throw new Error(`Unsupported target type: ${target.type}`);
            }

            if (!completed) {
              throw new Error("Unknown transfer completion state");
            }

            try {
              await ensurePostTransferMetadata(blob, target);
            } catch (metadataError) {
              console.warn("Failed to update metadata after transfer", metadataError);
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
                  : item,
              ),
            );
            if (pubkey) {
              await queryClient.invalidateQueries({
                queryKey: ["server-blobs", target.url, pubkey, target.type],
              });
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
                  : item,
              ),
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
  }, [
    distribution,
    ensurePostTransferMetadata,
    missingSourceCount,
    queryClient,
    selectedBlobItems,
    servers,
    signEventTemplate,
    signer,
    transferBusy,
    transferTargets,
  ]);

  const startSync = useCallback(() => {
    unauthorizedSyncTargetsRef.current.clear();
    syncQueueRef.current.clear();
    nextSyncAttemptRef.current.clear();
    unsupportedMirrorTargetsRef.current.clear();
    blockedSyncTargetsRef.current.clear();
    setSyncTransfers([]);
    const unique = Array.from(new Set(syncEnabledServerUrls));
    setAutoSyncedServers(unique);
    setSyncRunToken(prev => prev + 1);
    setSyncStatus({ state: "syncing", progress: 0 });
  }, [syncEnabledServerUrls]);

  useEffect(() => {
    onProvideSyncStarter(startSync);
  }, [onProvideSyncStarter, startSync]);

  const currentSignerMissing = !signer || !signEventTemplate;

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          Loading transfer tools…
        </div>
      }
    >
      <TransferContentLazy
        localServers={servers}
        selectedServer={selectedServer}
        selectedBlobItems={selectedBlobItems}
        selectedBlobTotalSize={selectedBlobTotalSize}
        sourceServerUrls={sourceServerUrls}
        missingSourceCount={missingSourceCount}
        transferTargets={transferTargets}
        transferBusy={transferBusy}
        transferFeedback={transferFeedback}
        transferFeedbackTone={transferFeedbackTone}
        transferActivity={transferActivity}
        toggleTransferTarget={toggleTransferTarget}
        handleStartTransfer={handleStartTransfer}
        onBackToBrowse={onBackToBrowse}
        currentSignerMissing={currentSignerMissing}
        syncedServerCount={syncedServerCount}
        syncedServerTotal={syncedServerTotal}
        fullySyncedServerUrls={syncCoverage.shared}
      />
    </Suspense>
  );
};
