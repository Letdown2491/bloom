import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagedServer } from "../../hooks/useServers";
import type { BlossomBlob } from "../../lib/blossomClient";
import type { SharePayload } from "../../components/ShareComposer";
import type { StatusMessageTone } from "../../types/status";
import type { TabId } from "../../types/tabs";
import type { TransferState } from "../../components/UploadPanel";
import { WorkspaceProvider } from "./WorkspaceContext";
import { BrowseTabContainer } from "./BrowseTabContainer";
import type { FilterMode } from "../../types/filter";
import { useBrowseControls } from "../browse/useBrowseControls";
import { BrowseControls } from "../browse/BrowseTab";
import { TransferTabContainer, type SyncStateSnapshot } from "./TransferTabContainer";

const UploadPanelLazy = React.lazy(() =>
  import("../../components/UploadPanel").then(module => ({ default: module.UploadPanel }))
);

type WorkspaceProps = {
  tab: TabId;
  servers: ManagedServer[];
  selectedServer: string | null;
  onSelectServer: (value: string | null) => void;
  onStatusMetricsChange: (metrics: { count: number; size: number }) => void;
  onSyncStateChange: (snapshot: SyncStateSnapshot) => void;
  onProvideSyncStarter: (runner: () => void) => void;
  onRequestRename: (blob: BlossomBlob) => void;
  onRequestShare: (payload: SharePayload) => void;
  onSetTab: (tab: TabId) => void;
  onUploadCompleted: (success: boolean) => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  onProvideBrowseControls?: (controls: React.ReactNode | null) => void;
  onFilterModeChange?: (mode: FilterMode) => void;
  showGridPreviews: boolean;
  showListPreviews: boolean;
};

export const Workspace: React.FC<WorkspaceProps> = ({
  tab,
  servers,
  selectedServer,
  showGridPreviews,
  showListPreviews,
  onSelectServer,
  onStatusMetricsChange,
  onSyncStateChange,
  onProvideSyncStarter,
  onRequestRename,
  onRequestShare,
  onSetTab,
  onUploadCompleted,
  showStatusMessage,
  onProvideBrowseControls,
  onFilterModeChange,
}) => {
  const browseControls = useBrowseControls();
  const {
    viewMode,
    setViewMode,
    filterMode,
    selectFilter,
    filterButtonLabel,
    filterButtonAriaLabel,
    filterButtonActive,
    isFilterMenuOpen,
    toggleFilterMenu,
    closeFilterMenu,
    handleTabChange,
  } = browseControls;
  const filterMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onFilterModeChange?.(filterMode);
  }, [filterMode, onFilterModeChange]);

  const browseHeaderControls = useMemo(() => {
    if (tab !== "browse") return null;
    return (
      <BrowseControls
        viewMode={viewMode}
        gridDisabled={false}
        listDisabled={false}
        disabled={false}
        onViewModeChange={mode => setViewMode(mode)}
        filterButtonLabel={filterButtonLabel}
        filterButtonAriaLabel={filterButtonAriaLabel}
        filterButtonActive={filterButtonActive}
        isFilterMenuOpen={isFilterMenuOpen}
        onToggleFilterMenu={toggleFilterMenu}
        onSelectFilter={selectFilter}
        filterMode={filterMode}
        filterMenuRef={filterMenuRef}
      />
    );
  }, [
    tab,
    viewMode,
    setViewMode,
    filterButtonLabel,
    filterButtonAriaLabel,
    filterButtonActive,
    isFilterMenuOpen,
    toggleFilterMenu,
    selectFilter,
    filterMode,
  ]);

  useEffect(() => {
    if (!onProvideBrowseControls) return;
    onProvideBrowseControls(browseHeaderControls);
    return () => {
      if (browseHeaderControls) {
        onProvideBrowseControls(null);
      }
    };
  }, [browseHeaderControls, onProvideBrowseControls]);

  const [syncTransfers, setSyncTransfers] = useState<TransferState[]>([]);

  const handleSyncTransfersChange = useCallback((transfers: TransferState[]) => {
    setSyncTransfers(transfers);
  }, []);

  return (
    <WorkspaceProvider servers={servers} selectedServer={selectedServer} onSelectServer={onSelectServer}>
      {tab === "browse" && (
      <BrowseTabContainer
        active
        onStatusMetricsChange={onStatusMetricsChange}
        onRequestRename={onRequestRename}
        onRequestShare={onRequestShare}
        onSetTab={onSetTab}
        showStatusMessage={showStatusMessage}
        viewMode={viewMode}
        filterMode={filterMode}
        filterMenuRef={filterMenuRef}
        isFilterMenuOpen={isFilterMenuOpen}
        onCloseFilterMenu={closeFilterMenu}
        onBrowseTabChange={handleTabChange}
        showGridPreviews={showGridPreviews}
        showListPreviews={showListPreviews}
      />
    )}
      {tab === "transfer" && (
        <TransferTabContainer
          active
          onBackToBrowse={() => onSetTab("browse")}
          showStatusMessage={showStatusMessage}
          onSyncStateChange={onSyncStateChange}
          onSyncTransfersChange={handleSyncTransfersChange}
          onProvideSyncStarter={onProvideSyncStarter}
        />
      )}
      {tab === "upload" && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading uploader…
            </div>
          }
        >
          <UploadPanelLazy
            servers={servers}
            selectedServerUrl={selectedServer}
            onUploaded={onUploadCompleted}
            syncTransfers={syncTransfers}
          />
        </Suspense>
      )}
    </WorkspaceProvider>
  );
};

export default Workspace;
