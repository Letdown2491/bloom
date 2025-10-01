import React, { createContext, useContext, useMemo } from "react";
import type { ManagedServer } from "../../hooks/useServers";
import { useServerData } from "../../hooks/useServerData";
import type { ServerSnapshot, BlobDistribution } from "../../hooks/useServerData";
import type { BlobReplicaSummary } from "../../components/BlobList";
import { deriveServerNameFromUrl } from "../../utils/serverName";
import { normalizeFolderPathInput, mergeBlobsWithStoredMetadata } from "../../utils/blobMetadataStore";
import { usePrivateLibrary } from "../../context/PrivateLibraryContext";
import type { PrivateListEntry } from "../../lib/privateList";
import type { BlossomBlob } from "../../lib/blossomClient";
import { PRIVATE_SERVER_NAME } from "../../constants/private";

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
  privateEntries: PrivateListEntry[];
  privateBlobs: BlossomBlob[];
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
  const { entries: privateEntries } = usePrivateLibrary();
  const syncEnabledServers = useMemo(() => servers.filter(server => server.sync), [servers]);
  const syncEnabledServerUrls = useMemo(() => syncEnabledServers.map(server => server.url), [syncEnabledServers]);

  const serverNameByUrl = useMemo(() => new Map(servers.map(server => [server.url, server.name])), [servers]);

  const eagerServerUrls = useMemo(() => {
    const urls = new Set<string>();
    if (selectedServer) {
      const hasMatchingServer = servers.some(server => server.url === selectedServer);
      if (hasMatchingServer) {
        urls.add(selectedServer);
      }
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

  const privateServerMap = useMemo(() => new Map(servers.map(server => [server.url, server])), [servers]);

  const privateBlobs = useMemo(() => {
    return privateEntries.map(entry => {
      const [primaryServer] = entry.servers ?? [];
      const server = primaryServer ? privateServerMap.get(primaryServer) : null;
      const normalizedServerUrl = primaryServer ? primaryServer.replace(/\/$/, "") : undefined;
      const downloadUrl = normalizedServerUrl ? `${normalizedServerUrl}/${entry.sha256}` : undefined;
      const metadata = entry.metadata;
      const encryption = entry.encryption;
      const normalizedFolder = normalizeFolderPathInput(metadata?.folderPath ?? undefined) ?? null;
      const displayName = metadata?.name
        ? metadata.name
        : encryption
          ? `Encrypted ${entry.sha256.slice(0, 8)}`
          : `Private ${entry.sha256.slice(0, 8)}`;
      const normalizedSize = (() => {
        if (typeof metadata?.size === "number") return metadata.size;
        if (typeof metadata?.size === "string") {
          const parsed = Number(metadata.size);
          return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
      })();

      const privateMetadata = metadata ? { ...metadata, size: normalizedSize, folderPath: normalizedFolder } : undefined;
      const privateData: BlossomBlob["privateData"] | undefined = encryption
        ? {
            encryption,
            metadata: privateMetadata,
            servers: entry.servers,
          }
        : undefined;

      const baseBlob: BlossomBlob = {
        sha256: entry.sha256,
        size: normalizedSize,
        type: metadata?.type ?? (metadata?.audio ? "audio/*" : undefined),
        uploaded: entry.updatedAt,
        url: downloadUrl,
        name: displayName,
        serverUrl: normalizedServerUrl,
        requiresAuth: server ? Boolean(server.requiresAuth) : false,
        serverType: server?.type ?? "blossom",
        folderPath: normalizedFolder,
        privateData,
        label: PRIVATE_SERVER_NAME,
      };

      const [merged] = mergeBlobsWithStoredMetadata(normalizedServerUrl, [baseBlob]);
      return merged ?? baseBlob;
    });
  }, [privateEntries, privateServerMap]);

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
      privateEntries,
      privateBlobs,
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
      privateEntries,
      privateBlobs,
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
