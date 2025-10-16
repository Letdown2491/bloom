import React, { Suspense, memo } from "react";

import type { ManagedServer } from "../hooks/useServers";
import type { BlossomBlob } from "../lib/blossomClient";
import type { StatusMessageTone } from "../types/status";
import type { TabId } from "../types/tabs";
import type { FilterMode } from "../types/filter";
import type { DefaultSortOption, SortDirection } from "../context/UserPreferencesContext";
import type { SyncStateSnapshot } from "../features/workspace/TransferTabContainer";
import type { BrowseActiveListState, BrowseNavigationState } from "../features/workspace/BrowseTabContainer";
import type { SharePayload, ShareCompletion } from "./ShareComposer";
import type { ProfileMetadataPayload } from "../features/profile/ProfilePanel";
import type { NdkContextValue } from "../context/NdkContext";
import type { useShareWorkflow } from "../features/share/useShareWorkflow";
import type { ShareFolderRequest } from "../types/shareFolder";

import { WorkspaceProvider } from "../features/workspace/WorkspaceContext";

const WorkspaceLazy = React.lazy(() =>
  import("../features/workspace/Workspace").then(module => ({ default: module.Workspace }))
);

const ServerListLazy = React.lazy(() =>
  import("./ServerList").then(module => ({ default: module.ServerList }))
);

const ShareComposerLazy = React.lazy(() =>
  import("../features/share/ShareComposerPanel").then(module => ({ default: module.ShareComposerPanel }))
);

const SettingsPanelLazy = React.lazy(() =>
  import("../features/settings/SettingsPanel").then(module => ({ default: module.SettingsPanel }))
);

const PrivateLinksPanelLazy = React.lazy(() =>
  import("../features/privateLinks/PrivateLinksPanel").then(module => ({ default: module.PrivateLinksPanel }))
);

const ProfilePanelLazy = React.lazy(() =>
  import("../features/profile/ProfilePanel").then(module => ({ default: module.ProfilePanel }))
);

const RelayListLazy = React.lazy(() =>
  import("./RelayList").then(module => ({ default: module.RelayList }))
);

type ShareWorkflowState = ReturnType<typeof useShareWorkflow>;

export type WorkspaceSectionProps = {
  tab: TabId;
  localServers: ManagedServer[];
  selectedServer: string | null;
  onSelectServer: (value: string | null) => void;
  homeNavigationKey: number;
  defaultViewMode: "grid" | "list";
  defaultFilterMode: FilterMode;
  showGridPreviews: boolean;
  showListPreviews: boolean;
  defaultSortOption: DefaultSortOption;
  sortDirection: SortDirection;
  onStatusMetricsChange: (metrics: { count: number; size: number }) => void;
  onSyncStateChange: (snapshot: SyncStateSnapshot) => void;
  onProvideSyncStarter: (runner: () => void) => void;
  onRequestRename: (blob: BlossomBlob) => void;
  onRequestFolderRename: (path: string) => void;
  onRequestShare: (payload: SharePayload) => void;
  onShareFolder: (request: ShareFolderRequest) => void;
  onUnshareFolder: (request: ShareFolderRequest) => void;
  folderShareBusyPath: string | null;
  onSetTab: (tab: TabId) => void;
  onUploadCompleted: (success: boolean) => void;
  showStatusMessage: (message: string, tone?: StatusMessageTone, duration?: number) => void;
  onProvideBrowseControls: (controls: React.ReactNode | null) => void;
  onProvideBrowseNavigation: (navigation: BrowseNavigationState | null) => void;
  onFilterModeChange: (mode: FilterMode) => void;
  searchQuery: string;
  onBrowseActiveListChange: (state: BrowseActiveListState | null) => void;
  browseRestoreState: BrowseActiveListState | null;
  browseRestoreKey: number | null;
  onBrowseRestoreHandled: () => void;
  uploadFolderSuggestion: string | null;
  shareState: ShareWorkflowState["shareState"];
  onClearShareState: () => void;
  onShareComplete: (result: ShareCompletion) => void;
  defaultServerUrl: string | null;
  keepSearchExpanded: boolean;
  theme: "dark" | "light";
  syncEnabled: boolean;
  syncLoading: boolean;
  syncError: string | null;
  syncPending: boolean;
  syncLastSyncedAt: number | null;
  onToggleSyncEnabled: (value: boolean) => Promise<void> | void;
  onSetDefaultViewMode: (mode: "grid" | "list") => void;
  onSetDefaultFilterMode: (mode: FilterMode) => void;
  onSetDefaultSortOption: (option: DefaultSortOption) => void;
  onSetSortDirection: (direction: SortDirection) => void;
  onSetDefaultServer: (url: string | null) => void;
  onSetShowGridPreviews: (value: boolean) => void;
  onSetShowListPreviews: (value: boolean) => void;
  onSetKeepSearchExpanded: (value: boolean) => void;
  onSetTheme: (theme: "dark" | "light") => void;
  saving: boolean;
  signer: NdkContextValue["signer"];
  onAddServer: (server: ManagedServer) => void;
  onUpdateServer: (originalUrl: string, updated: ManagedServer) => void;
  onRemoveServer: (url: string) => void;
  onSyncSelectedServers: () => void;
  syncButtonDisabled: boolean;
  syncBusy: boolean;
  serverValidationError: string | null;
  onProfileUpdated: (metadata: ProfileMetadataPayload) => void;
};

export const WorkspaceSection = memo(function WorkspaceSection({
  tab,
  localServers,
  selectedServer,
  onSelectServer,
  homeNavigationKey,
  defaultViewMode,
  defaultFilterMode,
  showGridPreviews,
  showListPreviews,
  defaultSortOption,
  sortDirection,
  onStatusMetricsChange,
  onSyncStateChange,
  onProvideSyncStarter,
  onRequestRename,
  onRequestFolderRename,
  onRequestShare,
  onShareFolder,
  onUnshareFolder,
  folderShareBusyPath,
  onSetTab,
  onUploadCompleted,
  showStatusMessage,
  onProvideBrowseControls,
  onProvideBrowseNavigation,
  onFilterModeChange,
  searchQuery,
  onBrowseActiveListChange,
  browseRestoreState,
  browseRestoreKey,
  onBrowseRestoreHandled,
  uploadFolderSuggestion,
  shareState,
  onClearShareState,
  onShareComplete,
  defaultServerUrl,
  keepSearchExpanded,
  theme,
  syncEnabled,
  syncLoading,
  syncError,
  syncPending,
  syncLastSyncedAt,
  onToggleSyncEnabled,
  onSetDefaultViewMode,
  onSetDefaultFilterMode,
  onSetDefaultSortOption,
  onSetSortDirection,
  onSetDefaultServer,
  onSetShowGridPreviews,
  onSetShowListPreviews,
  onSetKeepSearchExpanded,
  onSetTheme,
  saving,
  signer,
  onAddServer,
  onUpdateServer,
  onRemoveServer,
  onSyncSelectedServers,
  syncButtonDisabled,
  syncBusy,
  serverValidationError,
  onProfileUpdated,
}: WorkspaceSectionProps) {
  return (
    <div
      className={`flex flex-1 min-h-0 flex-col box-border p-4 ${
        tab === "browse" || tab === "share" ? "overflow-hidden" : "overflow-y-auto"
      }`}
    >
      <WorkspaceProvider servers={localServers} selectedServer={selectedServer} onSelectServer={onSelectServer}>
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading workspace…
            </div>
          }
        >
          <WorkspaceLazy
            tab={tab}
            servers={localServers}
            selectedServer={selectedServer}
            homeNavigationKey={homeNavigationKey}
            theme={theme}
            showGridPreviews={showGridPreviews}
            showListPreviews={showListPreviews}
            defaultSortOption={defaultSortOption}
            onStatusMetricsChange={onStatusMetricsChange}
            onSyncStateChange={onSyncStateChange}
            onProvideSyncStarter={onProvideSyncStarter}
          onRequestRename={onRequestRename}
          onRequestFolderRename={onRequestFolderRename}
          onRequestShare={onRequestShare}
          onShareFolder={onShareFolder}
          onUnshareFolder={onUnshareFolder}
          folderShareBusyPath={folderShareBusyPath}
          onSetTab={onSetTab}
            onUploadCompleted={onUploadCompleted}
            showStatusMessage={showStatusMessage}
            onProvideBrowseControls={onProvideBrowseControls}
            onProvideBrowseNavigation={onProvideBrowseNavigation}
            onFilterModeChange={onFilterModeChange}
            searchQuery={searchQuery}
            onBrowseActiveListChange={onBrowseActiveListChange}
            browseRestoreState={browseRestoreState}
            browseRestoreKey={browseRestoreKey}
            onBrowseRestoreHandled={onBrowseRestoreHandled}
            uploadFolderSuggestion={uploadFolderSuggestion}
          />
        </Suspense>

        {tab === "servers" && (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Loading servers…
              </div>
            }
          >
            <ServerListLazy
              servers={localServers}
              selected={selectedServer}
              defaultServerUrl={defaultServerUrl}
              onSelect={onSelectServer}
              onSetDefaultServer={onSetDefaultServer}
              onAdd={onAddServer}
              onUpdate={onUpdateServer}
              saving={saving}
              disabled={!signer}
              onRemove={onRemoveServer}
              onSync={onSyncSelectedServers}
              syncDisabled={syncButtonDisabled}
              syncInProgress={syncBusy}
              validationError={serverValidationError}
              showStatusMessage={showStatusMessage}
            />
          </Suspense>
        )}

        {tab === "profile" && (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Loading profile editor…
              </div>
            }
          >
            <ProfilePanelLazy onProfileUpdated={onProfileUpdated} showStatusMessage={showStatusMessage} />
          </Suspense>
        )}
      </WorkspaceProvider>

      {tab === "share" && (
        <div className="flex flex-1 min-h-0">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Loading share composer…
              </div>
            }
          >
            <ShareComposerLazy
              embedded
              payload={shareState.payload}
              shareKey={shareState.shareKey}
              onClose={() => {
                onClearShareState();
                onSetTab("browse");
              }}
              onShareComplete={onShareComplete}
            />
          </Suspense>
        </div>
      )}

      {tab === "settings" && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading settings…
            </div>
          }
        >
          <SettingsPanelLazy
            servers={localServers}
            defaultServerUrl={defaultServerUrl}
            selectedServerUrl={selectedServer}
            showIconsPreviews={showGridPreviews}
            showListPreviews={showListPreviews}
            defaultViewMode={defaultViewMode}
            defaultFilterMode={defaultFilterMode}
            defaultSortOption={defaultSortOption}
            sortDirection={sortDirection}
            keepSearchExpanded={keepSearchExpanded}
            theme={theme}
            syncEnabled={syncEnabled}
            syncLoading={syncLoading}
            syncError={syncError}
            syncPending={syncPending}
            lastSyncedAt={syncLastSyncedAt}
            onToggleSyncEnabled={onToggleSyncEnabled}
            onSetDefaultViewMode={onSetDefaultViewMode}
            onSetDefaultFilterMode={onSetDefaultFilterMode}
            onSetDefaultSortOption={onSetDefaultSortOption}
            onSetSortDirection={onSetSortDirection}
            onSetDefaultServer={onSetDefaultServer}
            onSelectServer={onSelectServer}
            onAddServer={onAddServer}
            onUpdateServer={onUpdateServer}
            onRemoveServer={onRemoveServer}
            onSyncServers={onSyncSelectedServers}
            serverSyncDisabled={syncButtonDisabled}
            serverSyncInProgress={syncBusy}
            savingServers={saving}
            serverActionsDisabled={!signer}
            serverValidationError={serverValidationError}
            onSetShowIconsPreviews={onSetShowGridPreviews}
            onSetShowListPreviews={onSetShowListPreviews}
            onSetKeepSearchExpanded={onSetKeepSearchExpanded}
            onSetTheme={onSetTheme}
            showStatusMessage={showStatusMessage}
            onShareFolder={onShareFolder}
            onUnshareFolder={onUnshareFolder}
            folderShareBusyPath={folderShareBusyPath}
          />
        </Suspense>
      )}

      {tab === "private-links" && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading private links…
            </div>
          }
        >
          <PrivateLinksPanelLazy />
        </Suspense>
      )}

      {tab === "relays" && (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              Loading relays…
            </div>
          }
        >
          <RelayListLazy showStatusMessage={showStatusMessage} />
        </Suspense>
      )}
    </div>
  );
});

WorkspaceSection.displayName = "WorkspaceSection";

export default WorkspaceSection;
