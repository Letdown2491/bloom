import React, { Suspense, useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FilterMode } from "../../types/filter";
import { useWorkspace } from "./WorkspaceContext";
import { useSelection } from "../selection/SelectionContext";
import { useAudio } from "../../context/AudioContext";
import { matchesFilter, createAudioTrack } from "../browse/browseUtils";
import { useAudioMetadataMap } from "../browse/useAudioMetadata";
import type { StatusMessageTone } from "../../types/status";
import type { SharePayload } from "../../components/ShareComposer";
import type { BlossomBlob, SignTemplate } from "../../lib/blossomClient";
import type { ManagedServer } from "../../hooks/useServers";
import type { TabId } from "../../types/tabs";
import { deleteUserBlob } from "../../lib/blossomClient";
import { deleteNip96File } from "../../lib/nip96Client";
import { deleteSatelliteFile } from "../../lib/satelliteClient";
import { useNdk, useCurrentPubkey } from "../../context/NdkContext";
import { isMusicBlob } from "../../utils/blobClassification";

const BrowsePanelLazy = React.lazy(() =>
  import("../browse/BrowseTab").then(module => ({ default: module.BrowsePanel }))
);

export type BrowseTabContainerProps = {
  active: boolean;
  onStatusMetricsChange: (metrics: { count: number; size: number }) => void;
  onRequestRename: (blob: BlossomBlob) => void;
  onRequestShare: (payload: SharePayload) => void;
  onSetTab: (tab: TabId) => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  viewMode: "grid" | "list";
  filterMode: FilterMode;
  filterMenuRef: React.RefObject<HTMLDivElement>;
  isFilterMenuOpen: boolean;
  onCloseFilterMenu: () => void;
  onBrowseTabChange: (tabId: string) => void;
  showGridPreviews: boolean;
  showListPreviews: boolean;
};

export const BrowseTabContainer: React.FC<BrowseTabContainerProps> = ({
  active,
  onStatusMetricsChange,
  onRequestRename,
  onRequestShare,
  onSetTab,
  showStatusMessage,
  viewMode,
  filterMode,
  filterMenuRef,
  isFilterMenuOpen,
  onCloseFilterMenu,
  onBrowseTabChange,
  showGridPreviews,
  showListPreviews,
}) => {
  const { aggregated, blobReplicaInfo, browsingAllServers, currentSnapshot, selectedServer } = useWorkspace();
  const { selected: selectedBlobs, toggle: toggleBlob, selectMany: selectManyBlobs, clear: clearSelection } = useSelection();
  const audio = useAudio();
  const queryClient = useQueryClient();
  const { signer, signEventTemplate } = useNdk();
  const pubkey = useCurrentPubkey();

  useEffect(() => {
    onBrowseTabChange(active ? "browse" : "");
  }, [active, onBrowseTabChange]);

  useEffect(() => {
    if (!active) return;
    if (!isFilterMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      onCloseFilterMenu();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      onCloseFilterMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseFilterMenu();
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
  }, [active, filterMenuRef, isFilterMenuOpen, onCloseFilterMenu]);

  useEffect(() => {
    clearSelection();
  }, [clearSelection, selectedServer]);

  const metadataMap = useAudioMetadataMap(aggregated.blobs);

  const visibleAggregatedBlobs = useMemo(() => {
    if (filterMode === "all") return aggregated.blobs;
    return aggregated.blobs.filter(blob => matchesFilter(blob, filterMode));
  }, [aggregated.blobs, filterMode]);

  const currentVisibleBlobs = useMemo(() => {
    if (!currentSnapshot) return undefined;
    if (filterMode === "all") return currentSnapshot.blobs;
    return currentSnapshot.blobs.filter(blob => matchesFilter(blob, filterMode));
  }, [currentSnapshot, filterMode]);

  const statusCount = currentSnapshot ? currentVisibleBlobs?.length ?? 0 : visibleAggregatedBlobs.length;
  const statusSize = currentSnapshot
    ? (currentVisibleBlobs ?? []).reduce((acc, blob) => acc + (blob.size || 0), 0)
    : visibleAggregatedBlobs.reduce((acc, blob) => acc + (blob.size || 0), 0);

  useEffect(() => {
    onStatusMetricsChange({ count: statusCount, size: statusSize });
  }, [onStatusMetricsChange, statusCount, statusSize]);

  const musicQueueTracks = useMemo(() => {
    return aggregated.blobs
      .filter(isMusicBlob)
      .map(blob => createAudioTrack(blob, metadataMap.get(blob.sha256)))
      .filter((track): track is NonNullable<typeof track> => Boolean(track));
  }, [aggregated.blobs, metadataMap]);

  const handleDeleteBlob = useCallback(
    async (blob: BlossomBlob) => {
      if (!currentSnapshot) {
        showStatusMessage("Select a specific server to delete files.", "error", 2000);
        return;
      }
      const confirmed = window.confirm(
        `Delete ${blob.sha256.slice(0, 10)}… from ${currentSnapshot.server.name}?`
      );
      if (!confirmed) return;
      const requiresSigner =
        currentSnapshot.server.type === "satellite" || Boolean(currentSnapshot.server.requiresAuth);
      if (requiresSigner && !signer) {
        showStatusMessage("Connect your signer to delete from this server.", "error", 2000);
        return;
      }
      try {
        await performDelete(blob, currentSnapshot.server.requiresAuth ? signEventTemplate : undefined, currentSnapshot.server.type, currentSnapshot.server.url, requiresSigner);
        if (pubkey) {
          queryClient.invalidateQueries({
            queryKey: ["server-blobs", currentSnapshot.server.url, pubkey, currentSnapshot.server.type],
          });
        }
        selectManyBlobs([blob.sha256], false);
        showStatusMessage("Blob deleted", "success", 2000);
      } catch (error: any) {
        showStatusMessage(error?.message || "Delete failed", "error", 5000);
      }
    },
    [currentSnapshot, pubkey, queryClient, selectManyBlobs, showStatusMessage, signEventTemplate, signer]
  );

  const handleCopyUrl = useCallback(
    (blob: BlossomBlob) => {
      if (!blob.url) return;
      navigator.clipboard.writeText(blob.url).catch(() => undefined);
      showStatusMessage("URL copied to clipboard", "success", 1500);
    },
    [showStatusMessage]
  );

  const handleShareBlob = useCallback(
    (blob: BlossomBlob) => {
      if (!blob.url) {
        showStatusMessage("This file does not have a shareable URL.", "error", 3000);
        return;
      }
      const payload: SharePayload = {
        url: blob.url,
        name: blob.name ?? null,
        sha256: blob.sha256,
        serverUrl: blob.serverUrl ?? null,
        size: typeof blob.size === "number" ? blob.size : null,
      };
      onRequestShare(payload);
      onSetTab("share");
    },
    [onRequestShare, onSetTab, showStatusMessage]
  );

  const handlePlayBlob = useCallback(
    (blob: BlossomBlob) => {
      const track = createAudioTrack(blob, metadataMap.get(blob.sha256));
      if (!track) return;
      audio.toggle(track, musicQueueTracks);
    },
    [audio, metadataMap, musicQueueTracks]
  );

  const handleRenameBlob = useCallback(
    (blob: BlossomBlob) => {
      onRequestRename(blob);
    },
    [onRequestRename]
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading library…
            </div>
          }
        >
          <BrowsePanelLazy
            viewMode={viewMode}
            browsingAllServers={browsingAllServers}
            aggregatedBlobs={visibleAggregatedBlobs}
            currentSnapshot={currentSnapshot}
            currentVisibleBlobs={currentVisibleBlobs}
            selectedBlobs={selectedBlobs}
            signTemplate={signEventTemplate as SignTemplate | undefined}
            replicaInfo={blobReplicaInfo}
            onToggle={toggleBlob}
            onSelectMany={selectManyBlobs}
            onDelete={handleDeleteBlob}
            onCopy={handleCopyUrl}
            onShare={handleShareBlob}
            onRename={handleRenameBlob}
            onPlay={handlePlayBlob}
            currentTrackUrl={audio.current?.url}
            currentTrackStatus={audio.status}
            filterMode={filterMode}
            showGridPreviews={showGridPreviews}
            showListPreviews={showListPreviews}
          />
        </Suspense>
      </div>
    </div>
  );
};

const performDelete = async (
  blob: BlossomBlob,
  signTemplate: SignTemplate | undefined,
  serverType: ManagedServer["type"],
  serverUrl: string,
  requiresSigner: boolean
) => {
  if (serverType === "nip96") {
    await deleteNip96File(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
    return;
  }
  if (serverType === "satellite") {
    await deleteSatelliteFile(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
    return;
  }
  await deleteUserBlob(serverUrl, blob.sha256, requiresSigner ? signTemplate : undefined, requiresSigner);
};
