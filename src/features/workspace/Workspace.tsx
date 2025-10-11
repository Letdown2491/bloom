import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagedServer } from "../../hooks/useServers";
import type { BlossomBlob } from "../../lib/blossomClient";
import type { SharePayload } from "../../components/ShareComposer";
import type { StatusMessageTone } from "../../types/status";
import type { TabId } from "../../types/tabs";
import type { TransferState } from "../../components/UploadPanel";
import type { DefaultSortOption } from "../../context/UserPreferencesContext";
import { BrowseTabContainer, type BrowseActiveListState, type BrowseNavigationState } from "./BrowseTabContainer";
import type { FilterMode } from "../../types/filter";
import { useBrowseControls } from "../browse/useBrowseControls";
import { BrowseControls } from "../browse/BrowseTab";
import type { SyncStateSnapshot } from "./TransferTabContainer";
import { useIsCompactScreen } from "../../hooks/useIsCompactScreen";

const UploadPanelLazy = React.lazy(() =>
  import("../../components/UploadPanel").then(module => ({ default: module.UploadPanel }))
);

const TransferTabLazy = React.lazy(() =>
  import("./TransferTabContainer").then(module => ({ default: module.TransferTabContainer }))
);

type WorkspaceProps = {
  tab: TabId;
  servers: ManagedServer[];
  selectedServer: string | null;
  homeNavigationKey: number;
  theme: "dark" | "light";
  onStatusMetricsChange: (metrics: { count: number; size: number }) => void;
  onSyncStateChange: (snapshot: SyncStateSnapshot) => void;
  onProvideSyncStarter: (runner: () => void) => void;
  onRequestRename: (blob: BlossomBlob) => void;
  onRequestFolderRename: (path: string) => void;
  onRequestShare: (payload: SharePayload) => void;
  onSetTab: (tab: TabId) => void;
  onUploadCompleted: (success: boolean) => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  onProvideBrowseControls?: (controls: React.ReactNode | null) => void;
  onFilterModeChange?: (mode: FilterMode) => void;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  defaultSortOption: DefaultSortOption;
  onProvideBrowseNavigation?: (navigation: BrowseNavigationState | null) => void;
  searchQuery: string;
  onBrowseActiveListChange?: (state: BrowseActiveListState | null) => void;
  browseRestoreState?: BrowseActiveListState | null;
  browseRestoreKey?: number | null;
  onBrowseRestoreHandled?: () => void;
  uploadFolderSuggestion?: string | null;
};

export const Workspace: React.FC<WorkspaceProps> = ({
  tab,
  servers,
  selectedServer,
  theme,
  showGridPreviews,
  showListPreviews,
  defaultSortOption,
  onStatusMetricsChange,
  onSyncStateChange,
  onProvideSyncStarter,
  onRequestRename,
  onRequestFolderRename,
  onRequestShare,
  onSetTab,
  homeNavigationKey,
  onUploadCompleted,
  showStatusMessage,
  onProvideBrowseControls,
  onFilterModeChange,
  onProvideBrowseNavigation,
  searchQuery,
  onBrowseActiveListChange,
  browseRestoreState,
  browseRestoreKey,
  onBrowseRestoreHandled,
  uploadFolderSuggestion,
}) => {
  const browseControls = useBrowseControls();
  const isSmallScreen = useIsCompactScreen();
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
    sortDirection,
    toggleSortDirection,
  } = browseControls;
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isSmallScreen && viewMode === "list") {
      setViewMode("grid");
    }
  }, [isSmallScreen, setViewMode, viewMode]);

  useEffect(() => {
    onFilterModeChange?.(filterMode);
  }, [filterMode, onFilterModeChange]);

  const browseHeaderControls = useMemo(() => {
    if (tab !== "browse") return null;
    return (
      <BrowseControls
        viewMode={viewMode}
        disabled={false}
        onSelectViewMode={mode => setViewMode(mode)}
        sortDirection={sortDirection}
        onToggleSortDirection={toggleSortDirection}
        filterButtonLabel={filterButtonLabel}
        filterButtonAriaLabel={filterButtonAriaLabel}
        filterButtonActive={filterButtonActive}
        isFilterMenuOpen={isFilterMenuOpen}
        onToggleFilterMenu={toggleFilterMenu}
        onSelectFilter={selectFilter}
        filterMode={filterMode}
        filterMenuRef={filterMenuRef}
        theme={theme}
        showViewToggle={!isSmallScreen}
        showSortToggle={!isSmallScreen}
        showFilterButton={!isSmallScreen}
        variant="grouped"
      />
    );
  }, [
    tab,
    viewMode,
    setViewMode,
    sortDirection,
    toggleSortDirection,
    filterButtonLabel,
    filterButtonAriaLabel,
    filterButtonActive,
    isFilterMenuOpen,
    toggleFilterMenu,
    selectFilter,
    filterMode,
    theme,
    isSmallScreen,
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
    <>
      {tab === "browse" && (
        <BrowseTabContainer
          active
          onStatusMetricsChange={onStatusMetricsChange}
          onRequestRename={onRequestRename}
          onRequestFolderRename={onRequestFolderRename}
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
          homeResetKey={homeNavigationKey}
          defaultSortOption={defaultSortOption}
          sortDirection={sortDirection}
          onNavigationChange={onProvideBrowseNavigation}
          searchTerm={searchQuery}
          onActiveListChange={onBrowseActiveListChange}
          restoreActiveList={browseRestoreState ?? null}
          restoreActiveListKey={browseRestoreKey ?? null}
          onRestoreActiveList={onBrowseRestoreHandled}
        />
      )}
      {tab === "transfer" && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading transfer tools…
            </div>
          }
        >
          <TransferTabLazy
            active
            onBackToBrowse={() => onSetTab("browse")}
            showStatusMessage={showStatusMessage}
            onSyncStateChange={onSyncStateChange}
            onSyncTransfersChange={handleSyncTransfersChange}
            onProvideSyncStarter={onProvideSyncStarter}
          />
        </Suspense>
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
            defaultFolderPath={uploadFolderSuggestion ?? null}
          />
        </Suspense>
      )}
    </>
  );
};

export default Workspace;
