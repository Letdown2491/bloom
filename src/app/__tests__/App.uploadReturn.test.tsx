import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const queryClientMock = {
  invalidateQueries: vi.fn(),
};

const serversMock = [
  {
    name: "Server Alpha",
    url: "https://server-alpha",
    type: "blossom",
    requiresAuth: true,
    sync: false,
  },
];

const preferencesMock = {
  defaultServerUrl: null,
  defaultViewMode: "list",
  defaultFilterMode: "all",
  defaultSortOption: "updated",
  sortDirection: "descending",
  showGridPreviews: true,
  showListPreviews: true,
  keepSearchExpanded: false,
};

const syncStateMock = {
  enabled: false,
  loading: false,
  error: null,
  lastSyncedAt: null,
  pending: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClientMock,
}));

vi.mock("../hooks/useServers", () => {
  const saveServers = vi.fn(async () => ({ success: true }));
  return {
    useServers: () => ({
      servers: serversMock,
      saveServers,
      saving: false,
      hasFetchedUserServers: true,
    }),
    sortServersByName: <T,>(list: T[]) => list.slice(),
  };
});

vi.mock("../context/UserPreferencesContext", () => ({
  useUserPreferences: () => ({
    preferences: preferencesMock,
    setDefaultServerUrl: vi.fn(),
    setDefaultViewMode: vi.fn(),
    setDefaultFilterMode: vi.fn(),
    setDefaultSortOption: vi.fn(),
    setSortDirection: vi.fn(),
    setShowGridPreviews: vi.fn(),
    setShowListPreviews: vi.fn(),
    setKeepSearchExpanded: vi.fn(),
    setSyncEnabled: vi.fn(async () => undefined),
    syncState: syncStateMock,
  }),
}));

vi.mock("../features/selection/SelectionContext", () => ({
  useSelection: () => ({
    selected: new Set<string>(),
  }),
}));

vi.mock("../features/share/useShareWorkflow", () => ({
  useShareWorkflow: () => ({
    shareState: { payload: null, shareKey: null, mode: null },
    openShareForPayload: vi.fn(),
    openShareByKey: vi.fn(),
    handleShareComplete: vi.fn(),
    clearShareState: vi.fn(),
  }),
}));

vi.mock("../context/AudioContext", () => ({
  useAudio: () => ({
    current: null,
  }),
}));

vi.mock("../hooks/usePreferredRelays", () => ({
  usePreferredRelays: () => ({
    effectiveRelays: [],
  }),
}));

vi.mock("../hooks/useAliasSync", () => ({
  useAliasSync: vi.fn(),
}));

vi.mock("../context/NdkContext", () => {
  const connect = vi.fn();
  const disconnect = vi.fn();
  return {
    useNdk: () => ({
      connect,
      disconnect,
      user: { npub: "npubexample", pubkey: "pubexample" },
      signer: null,
      ndk: null,
    }),
    useCurrentPubkey: () => "pubexample",
  };
});

vi.mock("../context/Nip46Context", () => ({
  useNip46: () => ({
    snapshot: { sessions: [] },
    service: null,
    ready: false,
  }),
}));

vi.mock("../shared/ui/StatusFooter", () => ({
  StatusFooter: () => null,
}));

vi.mock("../../features/rename/ui/FolderRenameDialog", () => ({
  FolderRenameDialog: () => null,
}));

const workspaceMockState = {
  lastProps: null as null | Record<string, unknown>,
  lastRestoreState: null as unknown,
  lastActiveList: null as unknown,
  restoreHandledCount: 0,
  lastFolderSuggestion: undefined as unknown,
};

const mockActiveList = {
  type: "folder",
  scope: "server",
  path: "music/albums",
  serverUrl: "https://server-alpha",
} as const;

vi.mock("../../features/workspace/ui/WorkspaceSection", () => {
  type Props = {
    tab: string;
    onSetTab: (tab: string) => void;
    onUploadCompleted: (success: boolean) => void;
    onBrowseActiveListChange?: (state: unknown) => void;
    browseRestoreState: unknown;
    browseRestoreKey: number | null;
    onBrowseRestoreHandled?: () => void;
    uploadFolderSuggestion?: string | null;
  };

  const WorkspaceSection = ({
    tab,
    onSetTab,
    onUploadCompleted,
    onBrowseActiveListChange,
    browseRestoreState,
    browseRestoreKey,
    onBrowseRestoreHandled,
    uploadFolderSuggestion,
  }: Props) => {
    useEffect(() => {
      workspaceMockState.lastProps = {
        tab,
        browseRestoreState,
        browseRestoreKey,
        uploadFolderSuggestion,
      };
      workspaceMockState.lastFolderSuggestion = uploadFolderSuggestion;
    }, [tab, browseRestoreState, browseRestoreKey, uploadFolderSuggestion]);

    useEffect(() => {
      if (tab === "browse") {
        workspaceMockState.lastActiveList = mockActiveList;
        onBrowseActiveListChange?.(mockActiveList);
      }
    }, [tab, onBrowseActiveListChange]);

    useEffect(() => {
      if (browseRestoreKey != null) {
        workspaceMockState.lastRestoreState = browseRestoreState;
        workspaceMockState.restoreHandledCount += 1;
        onBrowseRestoreHandled?.();
      }
    }, [browseRestoreKey, browseRestoreState, onBrowseRestoreHandled]);

    return (
      <section data-testid="workspace">
        <div data-testid="workspace-tab">{tab}</div>
        <button type="button" onClick={() => onSetTab("upload")}>
          Workspace Upload Tab
        </button>
        {tab === "upload" && (
          <button type="button" onClick={() => onUploadCompleted(true)}>
            Mark Upload Complete
          </button>
        )}
      </section>
    );
  };

  return { WorkspaceSection, __mockState: workspaceMockState, __mockActiveList: mockActiveList };
});

describe("App upload return flow", () => {
  it("restores the previous browse context after a successful upload", async () => {
    const { default: App } = await import("../App");
    const { __mockState, __mockActiveList } = await import(
      "../../features/workspace/ui/WorkspaceSection"
    );
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-tab")).toHaveTextContent("browse");
      expect(__mockState.lastActiveList).toEqual(__mockActiveList);
    });

    await user.click(screen.getByRole("button", { name: "Open Upload Tab" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-tab")).toHaveTextContent("upload");
    });

    await user.click(screen.getByRole("button", { name: "Mark Upload Complete" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-tab")).toHaveTextContent("upload");
      expect(__mockState.lastRestoreState).toEqual(__mockActiveList);
      expect(__mockState.restoreHandledCount).toBeGreaterThan(0);
      expect(__mockState.lastFolderSuggestion).toEqual(__mockActiveList.path);
    });
  });
});
