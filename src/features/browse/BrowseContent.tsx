import React from "react";
import type { BlossomBlob, SignTemplate } from "../../lib/blossomClient";
import type { ServerSnapshot } from "../../hooks/useServerData";
import { BlobList } from "../../components/BlobList";

export type BrowseContentProps = {
  viewMode: "grid" | "list";
  browsingAllServers: boolean;
  aggregatedBlobs: BlossomBlob[];
  currentSnapshot?: ServerSnapshot;
  currentVisibleBlobs?: BlossomBlob[];
  selectedBlobs: Set<string>;
  signTemplate?: SignTemplate;
  onToggle: (sha: string) => void;
  onSelectMany: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onShare: (blob: BlossomBlob) => void;
  onRename: (blob: BlossomBlob) => void;
  onPlay: (blob: BlossomBlob) => void;
  currentTrackUrl?: string;
  currentTrackStatus?: "idle" | "playing" | "paused";
};

export const BrowseContent: React.FC<BrowseContentProps> = ({
  viewMode,
  browsingAllServers,
  aggregatedBlobs,
  currentSnapshot,
  currentVisibleBlobs,
  selectedBlobs,
  signTemplate,
  onToggle,
  onSelectMany,
  onDelete,
  onCopy,
  onShare,
  onRename,
  onPlay,
  currentTrackUrl,
  currentTrackStatus,
}) => {
  const commonProps = {
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
  } as const;

  if (browsingAllServers) {
    return (
      <div className={`flex flex-1 min-h-0 flex-col overflow-hidden ${viewMode === "grid" ? "pr-1" : ""}`}>
        <BlobList blobs={aggregatedBlobs} signTemplate={signTemplate} {...commonProps} />
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
      <BlobList
        blobs={effectiveBlobs}
        baseUrl={currentSnapshot.server.url}
        requiresAuth={currentSnapshot.server.requiresAuth}
        signTemplate={currentSnapshot.server.requiresAuth ? signTemplate : undefined}
        serverType={currentSnapshot.server.type}
        {...commonProps}
      />
    </div>
  );
};
