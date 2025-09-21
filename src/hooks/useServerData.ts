import { useMemo, useSyncExternalStore } from "react";
import { useQueries } from "@tanstack/react-query";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import type { ManagedServer } from "./useServers";
import { listUserBlobs, type BlossomBlob } from "../lib/blossomClient";
import { listNip96Files } from "../lib/nip96Client";
import { listSatelliteFiles } from "../lib/satelliteClient";
import {
  mergeBlobsWithStoredMetadata,
  subscribeToBlobMetadataChanges,
  getBlobMetadataVersion,
} from "../utils/blobMetadataStore";

const filterHiddenBlobTypes = (blobs: BlossomBlob[]) =>
  blobs.filter(blob => (blob.type?.toLowerCase() ?? "") !== "inode/x-empty");

export type ServerSnapshot = {
  server: ManagedServer;
  blobs: BlossomBlob[];
  isLoading: boolean;
  isError: boolean;
};

export type BlobDistribution = {
  [sha: string]: { blob: BlossomBlob; servers: string[] };
};

export const useServerData = (servers: ManagedServer[]) => {
  const pubkey = useCurrentPubkey();
  const { signer, signEventTemplate } = useNdk();
  const metadataVersion = useSyncExternalStore(
    subscribeToBlobMetadataChanges,
    getBlobMetadataVersion,
    getBlobMetadataVersion
  );

  const queries = useQueries({
    queries: servers.map(server => ({
      queryKey: ["server-blobs", server.url, pubkey, server.type],
      enabled: !!pubkey && (!(server.type === "satellite" || server.requiresAuth) || !!signer),
      queryFn: async (): Promise<BlossomBlob[]> => {
        if (!pubkey) return [];
        if (server.type === "blossom") {
          const blobs = await listUserBlobs(
            server.url,
            pubkey,
            server.requiresAuth && signer ? { requiresAuth: true, signTemplate: signEventTemplate } : undefined
          );
          return filterHiddenBlobTypes(mergeBlobsWithStoredMetadata(server.url, blobs));
        }
        if (server.type === "nip96") {
          const blobs = await listNip96Files(server.url, {
            requiresAuth: Boolean(server.requiresAuth),
            signTemplate: server.requiresAuth ? signEventTemplate : undefined,
          });
          return filterHiddenBlobTypes(mergeBlobsWithStoredMetadata(server.url, blobs));
        }
        if (server.type === "satellite") {
          if (!signEventTemplate) throw new Error("Satellite servers require a connected signer.");
          const blobs = await listSatelliteFiles(server.url, {
            signTemplate: signEventTemplate,
          });
          return filterHiddenBlobTypes(mergeBlobsWithStoredMetadata(server.url, blobs));
        }
        return [];
      },
      staleTime: 1000 * 60,
    })),
  });

  const snapshots: ServerSnapshot[] = useMemo(() => {
    return servers.map((server, index) => ({
      server,
      blobs: mergeBlobsWithStoredMetadata(server.url, queries[index]?.data ?? []),
      isLoading: queries[index]?.isLoading ?? false,
      isError: queries[index]?.isError ?? false,
    }));
  }, [servers, queries, metadataVersion]);

  const distribution = useMemo<BlobDistribution>(() => {
    const dict: BlobDistribution = {};
    snapshots.forEach(snapshot => {
      snapshot.blobs.forEach(blob => {
        const entry = dict[blob.sha256] || { blob, servers: [] };
        if (!entry.servers.includes(snapshot.server.url)) {
          entry.servers.push(snapshot.server.url);
        }
        dict[blob.sha256] = entry;
      });
    });
    return dict;
  }, [snapshots]);

  const aggregated = useMemo(() => {
    const allBlobs: BlossomBlob[] = Object.values(distribution).map(item => item.blob);
    return {
      count: allBlobs.length,
      size: allBlobs.reduce((total, blob) => total + (blob.size || 0), 0),
      lastChange: allBlobs.reduce((acc, blob) => Math.max(acc, blob.uploaded || 0), 0),
      blobs: allBlobs,
    };
  }, [distribution]);

  return { snapshots, distribution, aggregated };
};
