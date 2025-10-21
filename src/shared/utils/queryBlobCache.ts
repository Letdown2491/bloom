import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { BlossomBlob } from "../api/blossomClient";
import { mergeBlobWithStoredMetadata } from "./blobMetadataStore";

type CachedBlobUpdater = (blob: BlossomBlob, queryKey: QueryKey) => BlossomBlob | null | undefined;

export const updateCachedBlobEntries = (
  queryClient: QueryClient | null | undefined,
  sha256: string,
  updater: CachedBlobUpdater,
) => {
  if (!queryClient) return;
  if (!sha256) return;
  const cache = queryClient.getQueryCache();
  const queries = cache.findAll({ queryKey: ["server-blobs"] });
  queries.forEach(query => {
    const queryKey = query.queryKey;
    queryClient.setQueryData<BlossomBlob[]>(queryKey, previous => {
      if (!Array.isArray(previous)) return previous;
      const index = previous.findIndex(blob => blob?.sha256 === sha256);
      if (index === -1) return previous;
      const current = previous[index];
      if (!current) return previous;
      const next = updater(current, queryKey);
      if (!next || next === current) return previous;
      const updated = [...previous];
      updated[index] = next;
      return updated;
    });
  });
};

export const reconcileBlobWithStoredMetadata = (
  queryClient: QueryClient | null | undefined,
  sha256: string,
) => {
  updateCachedBlobEntries(queryClient, sha256, blob =>
    mergeBlobWithStoredMetadata(blob.serverUrl, blob),
  );
};
