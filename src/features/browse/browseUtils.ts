import type { BlossomBlob } from "../../lib/blossomClient";
import type { Track } from "../../context/AudioContext";
import type { BlobAudioMetadata } from "../../utils/blobMetadataStore";
import { isDocumentBlob, isImageBlob, isMusicBlob, isPdfBlob, isVideoBlob } from "../../utils/blobClassification";
import type { FilterMode } from "../../types/filter";

const deriveTrackTitle = (blob: BlossomBlob) => {
  const explicit = blob.name?.trim();
  if (explicit) return explicit;
  const rawUrl = blob.url;
  if (rawUrl) {
    const segments = rawUrl.split("/");
    const tail = segments[segments.length - 1];
    if (tail) {
      try {
        const decoded = decodeURIComponent(tail);
        if (decoded) return decoded;
      } catch {
        return tail;
      }
      return tail;
    }
  }
  return `${blob.sha256.slice(0, 12)}…`;
};

export const createAudioTrack = (
  blob: BlossomBlob,
  metadata: BlobAudioMetadata | null | undefined
): Track | null => {
  if (!blob.url) return null;
  const title = metadata?.title || deriveTrackTitle(blob);
  const track: Track = {
    id: blob.sha256,
    url: blob.url,
    title,
  };
  if (metadata?.artist) track.artist = metadata.artist;
  if (metadata?.coverUrl) track.coverUrl = metadata.coverUrl;
  return track;
};

export const matchesFilter = (blob: BlossomBlob, filter: FilterMode) => {
  switch (filter) {
    case "music":
      return isMusicBlob(blob);
    case "images":
      return isImageBlob(blob);
    case "videos":
      return isVideoBlob(blob);
    case "pdfs":
      return isPdfBlob(blob);
    case "documents":
      return isDocumentBlob(blob);
    case "all":
    default:
      return true;
  }
};
