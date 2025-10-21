import type { BlossomBlob } from "../../shared/api/blossomClient";
import type { Track } from "../../app/context/AudioContext";
import { getBlobMetadataName, type BlobAudioMetadata } from "../../shared/utils/blobMetadataStore";
import {
  isDocumentBlob,
  isImageBlob,
  isMusicBlob,
  isPdfBlob,
  isVideoBlob,
} from "../../shared/utils/blobClassification";
import type { FilterMode } from "../../shared/types/filter";

const deriveTrackTitle = (blob: BlossomBlob) => {
  const metadataName = getBlobMetadataName(blob);
  if (metadataName) return metadataName;
  return blob.sha256;
};

export const createAudioTrack = (
  blob: BlossomBlob,
  metadata: BlobAudioMetadata | null | undefined,
  overrideUrl?: string,
): Track | null => {
  const sourceUrl = overrideUrl ?? blob.url;
  if (!sourceUrl) return null;
  const title = metadata?.title || deriveTrackTitle(blob);
  const track: Track = {
    id: blob.sha256,
    url: sourceUrl,
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
      return isDocumentBlob(blob) || isPdfBlob(blob);
    case "all":
    default:
      return true;
  }
};
