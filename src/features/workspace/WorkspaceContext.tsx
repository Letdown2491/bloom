import React, { createContext, useContext, useMemo } from "react";
import type { ManagedServer } from "../../hooks/useServers";
import { useServerData } from "../../hooks/useServerData";
import type { ServerSnapshot, BlobDistribution } from "../../hooks/useServerData";
import type { BlobReplicaSummary } from "../../components/BlobList";
import { deriveServerNameFromUrl } from "../../utils/serverName";

type ServerDataResult = ReturnType<typeof useServerData>;

type WorkspaceAggregated = ServerDataResult["aggregated"];

type WorkspaceContextValue = {
  servers: ManagedServer[];
  selectedServer: string | null;
  setSelectedServer: (value: string | null) => void;
  snapshots: ServerSnapshot[];
  distribution: BlobDistribution;
  aggregated: WorkspaceAggregated;
  blobReplicaInfo: Map<string, BlobReplicaSummary>;
  serverNameByUrl: Map<string, string>;
  syncEnabledServers: ManagedServer[];
  syncEnabledServerUrls: string[];
  browsingAllServers: boolean;
  currentSnapshot?: ServerSnapshot;
};

type WorkspaceProviderProps = {
  servers: ManagedServer[];
  selectedServer: string | null;
  onSelectServer: (value: string | null) => void;
  children: React.ReactNode;
};

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  servers,
  selectedServer,
  onSelectServer,
  children,
}) => {
  const syncEnabledServers = useMemo(() => servers.filter(server => server.sync), [servers]);
  const syncEnabledServerUrls = useMemo(() => syncEnabledServers.map(server => server.url), [syncEnabledServers]);

  const serverNameByUrl = useMemo(() => new Map(servers.map(server => [server.url, server.name])), [servers]);

  const eagerServerUrls = useMemo(() => {
    const urls = new Set<string>();
    if (selectedServer) {
      urls.add(selectedServer);
    } else {
      servers.forEach(server => urls.add(server.url));
    }
    syncEnabledServers.forEach(server => urls.add(server.url));
    return Array.from(urls);
  }, [selectedServer, servers, syncEnabledServers]);

  const { snapshots, distribution, aggregated } = useServerData(servers, {
    prioritizedServerUrls: eagerServerUrls,
    foregroundServerUrl: selectedServer ?? servers[0]?.url ?? null,
  });

  const currentSnapshot = useMemo(
    () => snapshots.find(snapshot => snapshot.server.url === selectedServer),
    [snapshots, selectedServer]
  );

  const browsingAllServers = selectedServer === null;

  const blobReplicaInfo = useMemo(() => {
    const map = new Map<string, BlobReplicaSummary>();
    Object.entries(distribution).forEach(([sha, entry]) => {
      const servers = entry.servers.map(url => {
        const name = serverNameByUrl.get(url) || deriveServerNameFromUrl(url) || url;
        return { url, name };
      });
      map.set(sha, { count: servers.length, servers });
    });
    return map;
  }, [distribution, serverNameByUrl]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      servers,
      selectedServer,
      setSelectedServer: onSelectServer,
      snapshots,
      distribution,
      aggregated,
      blobReplicaInfo,
      serverNameByUrl,
      syncEnabledServers,
      syncEnabledServerUrls,
      browsingAllServers,
      currentSnapshot,
    }),
    [
      servers,
      selectedServer,
      onSelectServer,
      snapshots,
      distribution,
      aggregated,
      blobReplicaInfo,
      serverNameByUrl,
      syncEnabledServers,
      syncEnabledServerUrls,
      browsingAllServers,
      currentSnapshot,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
};

export const useWorkspace = () => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
};
