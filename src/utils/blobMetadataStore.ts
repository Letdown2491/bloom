import type { BlossomBlob } from "../lib/blossomClient";

const METADATA_STORAGE_VERSION = "v2";

type StoredAudioMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  durationSeconds?: number;
  genre?: string;
  year?: number;
};

export type BlobAudioMetadata = StoredAudioMetadata;

type StoredMetadata = {
  name?: string | null;
  type?: string | null;
  audio?: StoredAudioMetadata | null;
  updatedAt?: number;
  lastCheckedAt?: number;
};

const STORAGE_KEY = `bloom:blob-metadata:${METADATA_STORAGE_VERSION}`;
const GLOBAL_METADATA_KEY = "__global__";

let cache: Record<string, Record<string, StoredMetadata>> | null = null;
let metadataVersion = 0;
const listeners = new Set<() => void>();

type PendingMetadataWrite = {
  serverUrl: string | undefined;
  sha256: string;
  metadata: StoredMetadata;
};

const pendingMetadataWrites = new Map<string, PendingMetadataWrite>();
let metadataWriteScheduled = false;

const enqueueMicrotask = (cb: () => void) => {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(cb);
    return;
  }
  Promise.resolve()
    .then(cb)
    .catch(() => undefined);
};

const metadataWriteKey = (serverUrl: string | undefined, sha256: string) => `${serverUrl ?? ""}\u0000${sha256}`;

const flushPendingMetadataWrites = () => {
  metadataWriteScheduled = false;
  if (pendingMetadataWrites.size === 0) return;

  const entries = Array.from(pendingMetadataWrites.values());
  pendingMetadataWrites.clear();

  for (const entry of entries) {
    setStoredBlobMetadata(entry.serverUrl, entry.sha256, entry.metadata);
  }
};

const scheduleMetadataWrite = () => {
  if (metadataWriteScheduled) return;
  metadataWriteScheduled = true;
  enqueueMicrotask(flushPendingMetadataWrites);
};

const queueStoredBlobMetadata = (serverUrl: string | undefined, sha256: string, metadata: StoredMetadata) => {
  if (!sha256) return;
  const key = metadataWriteKey(serverUrl, sha256);
  const existing = pendingMetadataWrites.get(key);
  if (existing) {
    pendingMetadataWrites.set(key, {
      serverUrl,
      sha256,
      metadata: { ...existing.metadata, ...metadata },
    });
  } else {
    pendingMetadataWrites.set(key, { serverUrl, sha256, metadata });
  }
  scheduleMetadataWrite();
};

function normalizeServerKey(serverUrl?: string) {
  if (!serverUrl) return GLOBAL_METADATA_KEY;
  return serverUrl.replace(/\/+$/, "");
}

function readCache() {
  if (cache) return cache;
  cache = {};
  if (typeof window === "undefined") {
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return cache;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      cache = parsed as Record<string, Record<string, StoredMetadata>>;
    }
  } catch (error) {
    cache = {};
  }
  return cache;
}

function persist() {
  if (typeof window === "undefined" || !cache) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    // Ignore persistence errors (quota, privacy mode, etc.).
  }
}

function notifyChange() {
  metadataVersion += 1;
  listeners.forEach(listener => {
    try {
      listener();
    } catch (error) {
      // Ignore listener failures.
    }
  });
}

export const subscribeToBlobMetadataChanges = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getBlobMetadataVersion = () => metadataVersion;

export function getStoredBlobMetadata(serverUrl: string | undefined, sha256: string) {
  if (!sha256) return undefined;
  const serverKey = normalizeServerKey(serverUrl);
  if (!serverKey) return undefined;
  const store = readCache();
  const entry = store[serverKey]?.[sha256];
  const globalEntry = store[GLOBAL_METADATA_KEY]?.[sha256];
  if (entry && globalEntry) {
    const entryUpdated = entry.updatedAt ?? 0;
    const globalUpdated = globalEntry.updatedAt ?? 0;
    if (globalUpdated >= entryUpdated) {
      return { ...entry, ...globalEntry };
    }
    return { ...globalEntry, ...entry };
  }
  return entry ?? globalEntry;
}

export function setStoredBlobMetadata(serverUrl: string | undefined, sha256: string, metadata: StoredMetadata) {
  if (!sha256) return;
  const serverKey = normalizeServerKey(serverUrl);
  if (!serverKey) return;
  const store = readCache();
  const serverStore = store[serverKey] ?? (store[serverKey] = {});
  const current = serverStore[sha256] ?? {};
  const nameProvided = Object.prototype.hasOwnProperty.call(metadata, "name");
  const typeProvided = Object.prototype.hasOwnProperty.call(metadata, "type");
  const audioProvided = Object.prototype.hasOwnProperty.call(metadata, "audio");
  const updatedProvided = Object.prototype.hasOwnProperty.call(metadata, "updatedAt");
  const checkedProvided = Object.prototype.hasOwnProperty.call(metadata, "lastCheckedAt");

  const next: StoredMetadata = {};

  const rawName = nameProvided ? metadata.name : current.name;
  const rawType = typeProvided ? metadata.type : current.type;
  const rawAudio = audioProvided ? metadata.audio : current.audio;

  if (typeof rawName === "string") {
    next.name = rawName;
  } else if (rawName === null) {
    // Explicit removal requested; leave name undefined.
  } else if (typeof current.name === "string" && !nameProvided) {
    next.name = current.name;
  }

  if (typeof rawType === "string") {
    next.type = rawType;
  } else if (rawType === null) {
    // Explicit removal requested; leave type undefined.
  } else if (typeof current.type === "string" && !typeProvided) {
    next.type = current.type;
  }

  if (audioProvided) {
    const normalizedAudio = normalizeStoredAudio(rawAudio ?? undefined);
    if (normalizedAudio) {
      next.audio = normalizedAudio;
    }
  } else if (current.audio) {
    next.audio = current.audio;
  }

  if (updatedProvided) {
    if (typeof metadata.updatedAt === "number" && Number.isFinite(metadata.updatedAt)) {
      next.updatedAt = metadata.updatedAt;
    }
  } else if (
    (nameProvided && typeof metadata.name === "string") ||
    (typeProvided && typeof metadata.type === "string") ||
    (audioProvided && metadata.audio !== undefined)
  ) {
    next.updatedAt = Date.now();
  } else if (typeof current.updatedAt === "number") {
    next.updatedAt = current.updatedAt;
  }

  if (checkedProvided) {
    if (typeof metadata.lastCheckedAt === "number" && Number.isFinite(metadata.lastCheckedAt)) {
      next.lastCheckedAt = metadata.lastCheckedAt;
    }
  } else if (typeof current.lastCheckedAt === "number") {
    next.lastCheckedAt = current.lastCheckedAt;
  }

  if (typeof next.name !== "string") delete next.name;
  if (typeof next.type !== "string") delete next.type;
  if (typeof next.lastCheckedAt !== "number") delete next.lastCheckedAt;
  if (!next.audio || Object.keys(next.audio).length === 0) delete next.audio;
  if (typeof next.updatedAt !== "number") delete next.updatedAt;
  let changed = false;
  if (!next.name && !next.type && !next.audio && !next.lastCheckedAt && !next.updatedAt) {
    if (serverStore[sha256]) {
      delete serverStore[sha256];
      if (Object.keys(serverStore).length === 0) {
        delete store[serverKey];
      }
      changed = true;
    }
  } else {
    const unchanged =
      current.name === next.name &&
      current.type === next.type &&
      isAudioEqual(current.audio, next.audio) &&
      current.updatedAt === next.updatedAt &&
      current.lastCheckedAt === next.lastCheckedAt;
    if (!unchanged) {
      serverStore[sha256] = next;
      changed = true;
    }
  }

  if (changed) {
    persist();
    notifyChange();
  }
}

export function mergeBlobWithStoredMetadata(serverUrl: string | undefined, blob: BlossomBlob): BlossomBlob {
  const stored = getStoredBlobMetadata(serverUrl, blob.sha256);
  const merged: BlossomBlob = { ...blob };
  if (typeof stored?.name === "string") {
    merged.name = stored.name;
  } else if (!merged.name && stored?.name === null) {
    merged.name = undefined;
  }
  if (stored?.type && !merged.type) {
    merged.type = stored.type;
  }
  if (merged.name && merged.name !== stored?.name) {
    queueStoredBlobMetadata(serverUrl, blob.sha256, { name: merged.name });
  }
  if (merged.type && merged.type !== stored?.type) {
    queueStoredBlobMetadata(serverUrl, blob.sha256, { type: merged.type });
  }
  return merged;
}

export function mergeBlobsWithStoredMetadata(serverUrl: string | undefined, blobs: BlossomBlob[]) {
  return blobs.map(blob => combineGlobalAlias(blob, mergeBlobWithStoredMetadata(serverUrl, blob)));
}

export function rememberBlobMetadata(serverUrl: string | undefined, blob: BlossomBlob) {
  if (!blob.sha256) return;
  setStoredBlobMetadata(serverUrl, blob.sha256, {
    name: blob.name,
    type: blob.type,
  });
}

export function rememberAudioMetadata(
  serverUrl: string | undefined,
  sha256: string,
  metadata: StoredAudioMetadata | null
) {
  if (!sha256) return;
  const normalized = normalizeStoredAudio(metadata ?? undefined);
  if (normalized) {
    const payload: StoredMetadata = { audio: normalized, updatedAt: Date.now() };
    setStoredBlobMetadata(serverUrl, sha256, payload);
    setStoredBlobMetadata(undefined, sha256, payload);
  } else {
    setStoredBlobMetadata(serverUrl, sha256, { audio: null, updatedAt: Date.now() });
    setStoredBlobMetadata(undefined, sha256, { audio: null, updatedAt: Date.now() });
  }
}

export function getStoredAudioMetadata(serverUrl: string | undefined, sha256: string) {
  return getStoredBlobMetadata(serverUrl, sha256)?.audio;
}

export function applyAliasUpdate(
  serverUrl: string | undefined,
  sha256: string,
  alias: string | null,
  createdAtSeconds: number | undefined
) {
  if (!sha256) return false;
  const updatedAt = typeof createdAtSeconds === "number" && Number.isFinite(createdAtSeconds)
    ? Math.max(0, createdAtSeconds) * 1000
    : Date.now();
  const existing = getStoredBlobMetadata(undefined, sha256);
  const existingUpdatedAt = existing?.updatedAt ?? 0;
  if (existingUpdatedAt >= updatedAt) {
    return false;
  }
  const normalizedAlias = alias === null ? null : alias;
  setStoredBlobMetadata(undefined, sha256, {
    name: normalizedAlias,
    updatedAt,
  });
  return true;
}

export function markBlobMetadataChecked(serverUrl: string | undefined, sha256: string, checkedAt = Date.now()) {
  setStoredBlobMetadata(serverUrl, sha256, { lastCheckedAt: checkedAt });
}

export function isMetadataFresh(stored: StoredMetadata | undefined, ttlMs: number) {
  if (!stored) return false;
  if (stored.name && stored.type) return true;
  if (typeof stored.lastCheckedAt === "number") {
    return Date.now() - stored.lastCheckedAt < ttlMs;
  }
  return false;
}

function combineGlobalAlias(original: BlossomBlob, merged: BlossomBlob): BlossomBlob {
  const global = getStoredBlobMetadata(undefined, merged.sha256);
  if (!global) return merged;
  const combined: BlossomBlob = { ...merged };
  if (typeof global.name === "string") {
    combined.name = global.name;
  } else if (global.name === null && original.name === undefined) {
    delete combined.name;
  }
  if (!combined.type && typeof global.type === "string") {
    combined.type = global.type;
  }
  return combined;
}

function normalizeStoredAudio(audio?: StoredAudioMetadata | null): StoredAudioMetadata | undefined {
  if (!audio) return undefined;
  const normalized: StoredAudioMetadata = {};
  if (typeof audio.title === "string" && audio.title.trim()) normalized.title = audio.title.trim();
  if (typeof audio.artist === "string" && audio.artist.trim()) normalized.artist = audio.artist.trim();
  if (typeof audio.album === "string" && audio.album.trim()) normalized.album = audio.album.trim();
  if (isPositiveInteger(audio.trackNumber)) normalized.trackNumber = Math.trunc(audio.trackNumber!);
  if (isPositiveInteger(audio.trackTotal)) normalized.trackTotal = Math.trunc(audio.trackTotal!);
  if (isPositiveInteger(audio.durationSeconds)) normalized.durationSeconds = Math.trunc(audio.durationSeconds!);
  if (typeof audio.genre === "string" && audio.genre.trim()) normalized.genre = audio.genre.trim();
  if (isPositiveInteger(audio.year)) normalized.year = Math.trunc(audio.year!);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isPositiveInteger(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0;
}

function isAudioEqual(a?: StoredAudioMetadata | null, b?: StoredAudioMetadata | null) {
  const normalizedA = normalizeStoredAudio(a ?? undefined);
  const normalizedB = normalizeStoredAudio(b ?? undefined);
  if (!normalizedA && !normalizedB) return true;
  if (!normalizedA || !normalizedB) return false;
  return (
    normalizedA.title === normalizedB.title &&
    normalizedA.artist === normalizedB.artist &&
    normalizedA.album === normalizedB.album &&
    normalizedA.trackNumber === normalizedB.trackNumber &&
    normalizedA.trackTotal === normalizedB.trackTotal &&
    normalizedA.durationSeconds === normalizedB.durationSeconds &&
    normalizedA.genre === normalizedB.genre &&
    normalizedA.year === normalizedB.year
  );
}
