import { useEffect, useMemo, useState } from "react";
import type { BlossomBlob } from "../../shared/api/blossomClient";
import {
  getStoredAudioMetadata,
  sanitizeCoverUrl,
  subscribeToBlobMetadataChanges,
  type BlobAudioMetadata,
} from "../../shared/utils/blobMetadataStore";

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
      const metadata =
        getStoredAudioMetadata(blob.serverUrl, blob.sha256) ?? deriveMetadataFromPrivateBlob(blob);
      if (metadata) {
        lookup.set(blob.sha256, metadata);
      }
    });
    return lookup;
  }, [blobs, version]);

  return map;
};

const deriveMetadataFromPrivateBlob = (blob: BlossomBlob): BlobAudioMetadata | undefined => {
  const audio = blob.privateData?.metadata?.audio;
  if (!audio || typeof audio !== "object") return undefined;
  const normalized: BlobAudioMetadata = {};
  if (typeof audio.title === "string" && audio.title.trim()) normalized.title = audio.title.trim();
  if (typeof audio.artist === "string" && audio.artist.trim())
    normalized.artist = audio.artist.trim();
  if (typeof audio.album === "string" && audio.album.trim()) normalized.album = audio.album.trim();
  if (typeof audio.genre === "string" && audio.genre.trim()) normalized.genre = audio.genre.trim();
  if (typeof audio.trackNumber === "number" && Number.isFinite(audio.trackNumber)) {
    normalized.trackNumber = Math.max(1, Math.trunc(audio.trackNumber));
  }
  if (typeof audio.trackTotal === "number" && Number.isFinite(audio.trackTotal)) {
    normalized.trackTotal = Math.max(1, Math.trunc(audio.trackTotal));
  }
  if (typeof audio.durationSeconds === "number" && Number.isFinite(audio.durationSeconds)) {
    normalized.durationSeconds = Math.max(0, Math.trunc(audio.durationSeconds));
  }
  if (typeof audio.year === "number" && Number.isFinite(audio.year)) {
    normalized.year = Math.trunc(audio.year);
  }
  if (typeof audio.coverUrl === "string") {
    const cover = sanitizeCoverUrl(audio.coverUrl);
    if (cover) normalized.coverUrl = cover;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};
