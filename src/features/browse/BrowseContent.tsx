import React from "react";
import type { BlossomBlob, SignTemplate } from "../../lib/blossomClient";
import type { ServerSnapshot } from "../../hooks/useServerData";
import type { BlobListProps, BlobReplicaSummary } from "../../components/BlobList";
import type { FilterMode } from "../../types/filter";
import type { DefaultSortOption, SortDirection } from "../../context/UserPreferencesContext";

export type BrowseContentProps = {
  viewMode: "grid" | "list";
  browsingAllServers: boolean;
  aggregatedBlobs: BlossomBlob[];
  currentSnapshot?: ServerSnapshot;
  currentVisibleBlobs?: BlossomBlob[];
  selectedBlobs: Set<string>;
  signTemplate?: SignTemplate;
  replicaInfo?: Map<string, BlobReplicaSummary>;
  onToggle: (sha: string) => void;
  onSelectMany: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onShare: (blob: BlossomBlob) => void;
  onRename: (blob: BlossomBlob) => void;
  onPlay: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
  filterMode: FilterMode;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  renderBlobList: (props: BlobListProps) => React.ReactNode;
  onOpenList?: (blob: BlossomBlob) => void;
  defaultSortOption: DefaultSortOption;
  sortDirection: SortDirection;
};

export const BrowseContent: React.FC<BrowseContentProps> = ({
  viewMode,
  browsingAllServers,
  aggregatedBlobs,
  currentSnapshot,
  currentVisibleBlobs,
  selectedBlobs,
  signTemplate,
  replicaInfo,
  onToggle,
  onSelectMany,
  onDelete,
  onCopy,
  onShare,
  onRename,
  onPlay,
  currentTrackUrl,
  currentTrackStatus,
  filterMode,
  showGridPreviews,
  showListPreviews,
  renderBlobList,
  onOpenList,
  defaultSortOption,
  sortDirection,
}) => {
  const isMusicView = filterMode === "music";
  const commonProps: Pick<
    BlobListProps,
    | "selected"
    | "viewMode"
    | "onToggle"
    | "onSelectMany"
    | "onDelete"
    | "onCopy"
    | "onShare"
    | "onRename"
    | "onPlay"
    | "currentTrackUrl"
    | "currentTrackStatus"
    | "isMusicView"
    | "showGridPreviews"
    | "showListPreviews"
    | "onOpenList"
    | "defaultSortOption"
    | "sortDirection"
  > = {
    selected: selectedBlobs,
    viewMode,
    onToggle,
    onSelectMany,
    onDelete,
    onCopy,
    onShare,
    onRename,
    onPlay,
    currentTrackUrl,
    currentTrackStatus,
    isMusicView,
    showGridPreviews,
    showListPreviews,
    onOpenList,
    defaultSortOption,
    sortDirection,
  };

  if (browsingAllServers) {
    return (
      <div className={`flex flex-1 min-h-0 flex-col overflow-hidden ${viewMode === "grid" ? "pr-1" : ""}`}>
        {renderBlobList({
          blobs: aggregatedBlobs,
          signTemplate,
          replicaInfo,
          showGridPreviews,
          showListPreviews,
          ...commonProps,
        })}
      </div>
    );
  }

  if (!currentSnapshot) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Select a server to browse its contents.
      </div>
    );
  }

  const effectiveBlobs = currentVisibleBlobs ?? currentSnapshot.blobs;

  return (
    <div className={`flex flex-1 min-h-0 flex-col overflow-hidden ${viewMode === "grid" ? "pr-1" : ""}`}>
      {renderBlobList({
        blobs: effectiveBlobs,
        baseUrl: currentSnapshot.server.url,
        requiresAuth: currentSnapshot.server.requiresAuth,
        signTemplate: currentSnapshot.server.requiresAuth ? signTemplate : undefined,
        serverType: currentSnapshot.server.type,
        replicaInfo,
        showGridPreviews,
        showListPreviews,
        ...commonProps,
      })}
    </div>
  );
};
