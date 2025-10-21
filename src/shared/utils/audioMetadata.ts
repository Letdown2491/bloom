import type { IAudioMetadata } from "music-metadata";
import type * as MusicMetadataModule from "music-metadata";

export type ExtractedAudioMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  durationSeconds?: number;
  genre?: string;
  year?: number;
};

const MAX_PARSE_BYTES = 16 * 1024 * 1024; // 16 MB is plenty for metadata parsing.

let musicMetadataModule: Promise<typeof MusicMetadataModule> | null = null;

const loadMusicMetadata = async () => {
  if (!musicMetadataModule) {
    musicMetadataModule = import("music-metadata") as Promise<typeof MusicMetadataModule>;
  }
  return musicMetadataModule;
};

export async function extractAudioMetadata(file: File): Promise<ExtractedAudioMetadata | null> {
  try {
    const slice = file.slice(0, Math.min(file.size, MAX_PARSE_BYTES));
    const { parseBlob } = await loadMusicMetadata();
    const metadata = await parseBlob(slice);
    return normalizeAudioMetadata(metadata);
  } catch (error) {
    console.warn("Unable to read audio metadata", error);
    return null;
  }
}

function normalizeAudioMetadata(metadata: IAudioMetadata): ExtractedAudioMetadata {
  const { common, format } = metadata;
  const primaryArtist = resolvePrimaryArtist(common.artist, common.artists);
  const primaryGenre = Array.isArray(common.genre) ? common.genre[0] : common.genre;
  const durationSeconds =
    typeof format.duration === "number" && Number.isFinite(format.duration)
      ? Math.round(format.duration)
      : undefined;

  return {
    title: sanitize(common.title),
    artist: sanitize(primaryArtist),
    album: sanitize(common.album),
    trackNumber: common.track?.no && Number.isFinite(common.track.no) ? common.track.no : undefined,
    trackTotal: common.track?.of && Number.isFinite(common.track.of) ? common.track.of : undefined,
    durationSeconds,
    genre: sanitize(primaryGenre),
    year: typeof common.year === "number" && Number.isFinite(common.year) ? common.year : undefined,
  };
}

function resolvePrimaryArtist(artist?: string | null, artists?: string[]): string | undefined {
  if (artist && artist.trim()) return artist;
  if (Array.isArray(artists) && artists.length > 0) {
    const first = artists.find(entry => entry && entry.trim());
    if (first) return first;
  }
  return undefined;
}

function sanitize(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
