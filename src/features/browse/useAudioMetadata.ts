import { useEffect, useMemo, useState } from "react";
import type { BlossomBlob } from "../../lib/blossomClient";
import {
  getStoredAudioMetadata,
  subscribeToBlobMetadataChanges,
  type BlobAudioMetadata,
} from "../../utils/blobMetadataStore";

export const useAudioMetadataMap = (blobs: BlossomBlob[]) => {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeToBlobMetadataChanges(() => {
      setVersion(current => current + 1);
    });
    return unsubscribe;
  }, []);

  const map = useMemo(() => {
    const lookup = new Map<string, BlobAudioMetadata>();
    blobs.forEach(blob => {
      const metadata = getStoredAudioMetadata(blob.serverUrl, blob.sha256);
      if (metadata) {
        lookup.set(blob.sha256, metadata);
      }
    });
    return lookup;
  }, [blobs, version]);

  return map;
};
