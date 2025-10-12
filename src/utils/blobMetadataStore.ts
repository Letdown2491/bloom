import type { BlossomBlob } from "../lib/blossomClient";
import { checkLocalStorageQuota } from "./storageQuota";

const METADATA_STORAGE_VERSION = "v3";

type StoredAudioMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  durationSeconds?: number;
  genre?: string;
  year?: number;
  coverUrl?: string;
};

export type BlobAudioMetadata = StoredAudioMetadata;

type StoredMetadata = {
  name?: string | null;
  type?: string | null;
  folderPath?: string | null;
  audio?: StoredAudioMetadata | null;
  updatedAt?: number;
  lastCheckedAt?: number;
};

const STORAGE_KEY = `bloom:blob-metadata:${METADATA_STORAGE_VERSION}`;
const GLOBAL_METADATA_KEY = "__global__";
const METADATA_STALE_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

type StoredMetadataRecord = Record<string, Record<string, StoredMetadata>>;

let cache: StoredMetadataRecord | null = null;
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
  let changed = false;

  for (const entry of entries) {
    const didChange = setStoredBlobMetadata(entry.serverUrl, entry.sha256, entry.metadata, { suppressPersist: true });
    changed = changed || didChange;
  }

  if (changed) {
    persist();
    notifyChange();
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

const MS_THRESHOLD = 1_000_000_000_000;

const toStoredSeconds = (value: number | null | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized > MS_THRESHOLD) {
    return Math.trunc(normalized / 1000);
  }
  return normalized;
};

const fromStoredSeconds = (value: number | null | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value > MS_THRESHOLD) {
    return Math.trunc(value);
  }
  return value * 1000;
};

const collapseStoredMetadata = (metadata: StoredMetadata): StoredMetadata => {
  const collapsed: StoredMetadata = {};
  if (Object.prototype.hasOwnProperty.call(metadata, "name")) {
    collapsed.name = metadata.name ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "type")) {
    collapsed.type = metadata.type ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "folderPath")) {
    collapsed.folderPath = metadata.folderPath ?? null;
  }
  if (metadata.audio) {
    collapsed.audio = metadata.audio;
  }
  const updatedSeconds = toStoredSeconds(metadata.updatedAt ?? undefined);
  if (typeof updatedSeconds === "number") {
    collapsed.updatedAt = updatedSeconds;
  }
  const checkedSeconds = toStoredSeconds(metadata.lastCheckedAt ?? undefined);
  if (typeof checkedSeconds === "number") {
    collapsed.lastCheckedAt = checkedSeconds;
  }
  return collapsed;
};

const expandStoredMetadata = (metadata?: StoredMetadata): StoredMetadata | undefined => {
  if (!metadata) return undefined;
  const expanded: StoredMetadata = {};
  if (Object.prototype.hasOwnProperty.call(metadata, "name")) {
    expanded.name = metadata.name ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "type")) {
    expanded.type = metadata.type ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "folderPath")) {
    expanded.folderPath = metadata.folderPath ?? null;
  }
  if (metadata.audio) {
    expanded.audio = metadata.audio;
  }
  const updatedMs = fromStoredSeconds(metadata.updatedAt ?? undefined);
  if (typeof updatedMs === "number") {
    expanded.updatedAt = updatedMs;
  }
  const checkedMs = fromStoredSeconds(metadata.lastCheckedAt ?? undefined);
  if (typeof checkedMs === "number") {
    expanded.lastCheckedAt = checkedMs;
  }
  return expanded;
};

const migrateStoredMetadata = (store: StoredMetadataRecord) => {
  Object.keys(store).forEach(serverKey => {
    const serverEntries = store[serverKey];
    if (!serverEntries) {
      delete store[serverKey];
      return;
    }
    Object.keys(serverEntries).forEach(sha => {
      const expanded = expandStoredMetadata(serverEntries[sha]);
      if (!expanded) {
        delete serverEntries[sha];
        return;
      }
      const collapsed = collapseStoredMetadata(expanded);
      if (Object.keys(collapsed).length === 0) {
        delete serverEntries[sha];
      } else {
        serverEntries[sha] = collapsed;
      }
    });
    if (!serverEntries || Object.keys(serverEntries).length === 0) {
      delete store[serverKey];
    }
  });
};

const pruneStaleMetadataEntries = (store: StoredMetadataRecord, cutoffMs: number) => {
  const cutoff = Date.now() - cutoffMs;
  let removed = false;
  Object.keys(store).forEach(serverKey => {
    const serverEntries = store[serverKey];
    if (!serverEntries) {
      delete store[serverKey];
      removed = true;
      return;
    }
    Object.keys(serverEntries).forEach(sha => {
      const expanded = expandStoredMetadata(serverEntries[sha]);
      if (!expanded) {
        delete serverEntries[sha];
        removed = true;
        return;
      }
      const hasContent =
        (typeof expanded.name === "string" && expanded.name.trim().length > 0) ||
        (typeof expanded.type === "string" && expanded.type.trim().length > 0) ||
        (expanded.audio && Object.keys(expanded.audio).length > 0) ||
        (typeof expanded.folderPath === "string" && expanded.folderPath.trim().length > 0);
      const freshest =
        Math.max(
          typeof expanded.updatedAt === "number" ? expanded.updatedAt : 0,
          typeof expanded.lastCheckedAt === "number" ? expanded.lastCheckedAt : 0
        ) || 0;
      if (!hasContent && freshest > 0 && freshest < cutoff) {
        delete serverEntries[sha];
        removed = true;
      }
    });
    if (!serverEntries || Object.keys(serverEntries).length === 0) {
      delete store[serverKey];
      removed = true;
    }
  });
  return removed;
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
      cache = parsed as StoredMetadataRecord;
      migrateStoredMetadata(cache);
    }
  } catch (error) {
    cache = {};
  }
  return cache;
}

function persist() {
  if (typeof window === "undefined" || !cache) return;
  try {
    const payload = JSON.stringify(cache);
    window.localStorage.setItem(STORAGE_KEY, payload);
    const quota = checkLocalStorageQuota("blob-metadata");
    if (quota.status === "critical") {
      const pruned = pruneStaleMetadataEntries(cache, METADATA_STALE_TTL_MS);
      if (pruned) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
        checkLocalStorageQuota("blob-metadata-pruned", { log: false });
      }
    }
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
  const entry = expandStoredMetadata(store[serverKey]?.[sha256]);
  const globalEntry = expandStoredMetadata(store[GLOBAL_METADATA_KEY]?.[sha256]);
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

export function setStoredBlobMetadata(
  serverUrl: string | undefined,
  sha256: string,
  metadata: StoredMetadata,
  options?: { suppressPersist?: boolean }
): boolean {
  if (!sha256) return false;
  const serverKey = normalizeServerKey(serverUrl);
  if (!serverKey) return false;
  const store = readCache();
  const serverStore = store[serverKey] ?? (store[serverKey] = {});
  const current = expandStoredMetadata(serverStore[sha256]) ?? {};
  const nameProvided = Object.prototype.hasOwnProperty.call(metadata, "name");
  const typeProvided = Object.prototype.hasOwnProperty.call(metadata, "type");
  const folderProvided = Object.prototype.hasOwnProperty.call(metadata, "folderPath");
  const audioProvided = Object.prototype.hasOwnProperty.call(metadata, "audio");
  const updatedProvided = Object.prototype.hasOwnProperty.call(metadata, "updatedAt");
  const checkedProvided = Object.prototype.hasOwnProperty.call(metadata, "lastCheckedAt");

  const next: StoredMetadata = {};

  const rawName = nameProvided ? metadata.name : current.name;
  const rawType = typeProvided ? metadata.type : current.type;
  const rawFolder = folderProvided ? metadata.folderPath : current.folderPath;
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

  if (folderProvided) {
    const normalizedFolder = normalizeFolderPathInput(rawFolder);
    if (normalizedFolder) {
      next.folderPath = normalizedFolder;
    } else if (rawFolder === null || (typeof rawFolder === "string" && rawFolder.length === 0)) {
      next.folderPath = null;
    }
  } else if (Object.prototype.hasOwnProperty.call(current, "folderPath")) {
    next.folderPath = current.folderPath ?? null;
  }

  if (audioProvided) {
    const normalizedAudio = normalizeStoredAudio(rawAudio ?? undefined);
    if (normalizedAudio) {
      next.audio = normalizedAudio;
    }
  } else if (current.audio) {
    next.audio = current.audio;
  }

  if (checkedProvided) {
    if (typeof metadata.lastCheckedAt === "number" && Number.isFinite(metadata.lastCheckedAt)) {
      next.lastCheckedAt = Math.max(0, Math.trunc(metadata.lastCheckedAt));
    }
  } else if (typeof current.lastCheckedAt === "number") {
    next.lastCheckedAt = current.lastCheckedAt;
  }

  if (typeof next.name !== "string") delete next.name;
  if (typeof next.type !== "string") delete next.type;
  if (typeof next.lastCheckedAt !== "number") delete next.lastCheckedAt;
  if (!next.audio || Object.keys(next.audio).length === 0) delete next.audio;

  const currentName = typeof current.name === "string" ? current.name : undefined;
  const nextName = typeof next.name === "string" ? next.name : undefined;
  const currentType = typeof current.type === "string" ? current.type : undefined;
  const nextType = typeof next.type === "string" ? next.type : undefined;
  const currentFolder = Object.prototype.hasOwnProperty.call(current, "folderPath")
    ? current.folderPath ?? null
    : undefined;
  const nextFolder = Object.prototype.hasOwnProperty.call(next, "folderPath")
    ? next.folderPath ?? null
    : undefined;
  const currentAudio = current.audio;
  const nextAudio = next.audio;
  const currentChecked = typeof current.lastCheckedAt === "number" ? current.lastCheckedAt : undefined;
  const nextChecked = typeof next.lastCheckedAt === "number" ? next.lastCheckedAt : undefined;

  const contentChanged =
    currentName !== nextName ||
    currentType !== nextType ||
    currentFolder !== nextFolder ||
    !isAudioEqual(currentAudio, nextAudio) ||
    currentChecked !== nextChecked;

  let nextUpdatedAt: number | undefined;
  if (updatedProvided) {
    if (typeof metadata.updatedAt === "number" && Number.isFinite(metadata.updatedAt)) {
      nextUpdatedAt = Math.max(0, Math.trunc(metadata.updatedAt));
    }
  } else if (contentChanged) {
    nextUpdatedAt = Date.now();
  } else if (typeof current.updatedAt === "number") {
    nextUpdatedAt = current.updatedAt;
  }

  if (typeof nextUpdatedAt === "number") {
    next.updatedAt = nextUpdatedAt;
  } else {
    delete next.updatedAt;
  }

  let changed = false;
  if (!next.name && !next.type && !next.audio && !next.lastCheckedAt && typeof next.updatedAt !== "number") {
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
      serverStore[sha256] = collapseStoredMetadata(next);
      changed = true;
    }
  }

  if (changed && !options?.suppressPersist) {
    persist();
    notifyChange();
  }

  return changed;
}

export function mergeBlobWithStoredMetadata(serverUrl: string | undefined, blob: BlossomBlob): BlossomBlob {
  const stored = getStoredBlobMetadata(serverUrl, blob.sha256);
  const merged: BlossomBlob = { ...blob };
  const currentMetadataName =
    typeof merged.__bloomMetadataName === "string" && merged.__bloomMetadataName.trim()
      ? merged.__bloomMetadataName.trim()
      : null;
  let metadataName = currentMetadataName;

  const hasStoredName = stored ? Object.prototype.hasOwnProperty.call(stored, "name") : false;
  let storedNameValue: string | null | undefined;
  if (hasStoredName) {
    if (typeof stored?.name === "string") {
      const trimmed = stored.name.trim();
      storedNameValue = trimmed.length > 0 ? trimmed : null;
    } else if (stored?.name == null) {
      storedNameValue = null;
    }
  }

  if (typeof storedNameValue === "string") {
    merged.name = storedNameValue;
    metadataName = storedNameValue;
  } else if (hasStoredName && storedNameValue === null) {
    if (!merged.name) {
      merged.name = undefined;
    }
    metadataName = null;
  }

  if (!metadataName && typeof merged.name === "string") {
    const trimmedName = merged.name.trim();
    if (trimmedName) {
      metadataName = trimmedName;
      merged.name = trimmedName;
    }
  }

  merged.__bloomMetadataName = metadataName ?? null;
  if (stored?.type && !merged.type) {
    merged.type = stored.type;
  }
  if (Object.prototype.hasOwnProperty.call(stored ?? {}, "folderPath")) {
    merged.folderPath = normalizeFolderPathInput(stored?.folderPath) ?? null;
  } else if (typeof merged.folderPath === "string") {
    queueStoredBlobMetadata(serverUrl, blob.sha256, { folderPath: merged.folderPath });
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

export function rememberBlobMetadata(
  serverUrl: string | undefined,
  blob: BlossomBlob,
  options?: { folderPath?: string | null }
) {
  if (!blob.sha256) return;
  const payload: StoredMetadata = {
    name: blob.name,
    type: blob.type,
  };
  if (options && Object.prototype.hasOwnProperty.call(options, "folderPath")) {
    payload.folderPath = options.folderPath ?? null;
  } else if (Object.prototype.hasOwnProperty.call(blob, "folderPath")) {
    payload.folderPath = blob.folderPath ?? null;
  }
  setStoredBlobMetadata(serverUrl, blob.sha256, payload);
}

export function rememberAudioMetadata(
  serverUrl: string | undefined,
  sha256: string,
  metadata: StoredAudioMetadata | null,
  options?: { updatedAt?: number }
) {
  if (!sha256) return;

  const normalized = normalizeStoredAudio(metadata ?? undefined);
  const requestedUpdatedAt = options?.updatedAt;
  const nextUpdatedAt =
    typeof requestedUpdatedAt === "number" && Number.isFinite(requestedUpdatedAt)
      ? Math.max(0, Math.trunc(requestedUpdatedAt))
      : Date.now();

  const existingGlobal = getStoredBlobMetadata(undefined, sha256);
  const existingServer = serverUrl ? getStoredBlobMetadata(serverUrl, sha256) : undefined;

  const shouldUpdate = (existing: StoredMetadata | undefined) => {
    if (!existing) return true;
    const currentUpdatedAt = typeof existing.updatedAt === "number" && Number.isFinite(existing.updatedAt)
      ? existing.updatedAt
      : 0;
    if (currentUpdatedAt > nextUpdatedAt) {
      return false;
    }
    if (currentUpdatedAt === nextUpdatedAt) {
      return !isAudioEqual(existing.audio, normalized);
    }
    return true;
  };

  const payload: StoredMetadata = normalized
    ? { audio: normalized, updatedAt: nextUpdatedAt }
    : { audio: null, updatedAt: nextUpdatedAt };

  const shouldUpdateGlobal = shouldUpdate(existingGlobal);
  const shouldUpdateServer = serverUrl ? shouldUpdate(existingServer) : false;

  if (!shouldUpdateGlobal && !shouldUpdateServer) {
    return;
  }

  if (shouldUpdateServer && serverUrl) {
    setStoredBlobMetadata(serverUrl, sha256, payload);
  }
  if (shouldUpdateGlobal) {
    setStoredBlobMetadata(undefined, sha256, payload);
  }
}

export function getStoredAudioMetadata(serverUrl: string | undefined, sha256: string) {
  return getStoredBlobMetadata(serverUrl, sha256)?.audio;
}

export function getStoredFolderPath(serverUrl: string | undefined, sha256: string) {
  const stored = getStoredBlobMetadata(serverUrl, sha256);
  return normalizeFolderPathInput(stored?.folderPath);
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
  const payload: StoredMetadata = {
    name: normalizedAlias,
    updatedAt,
  };
  setStoredBlobMetadata(undefined, sha256, payload);
  if (serverUrl) {
    setStoredBlobMetadata(serverUrl, sha256, payload);
  }
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
  const currentMetadataName =
    typeof combined.__bloomMetadataName === "string" && combined.__bloomMetadataName.trim()
      ? combined.__bloomMetadataName.trim()
      : null;
  let metadataName = currentMetadataName;

  const hasGlobalName = Object.prototype.hasOwnProperty.call(global, "name");
  let globalNameValue: string | null | undefined;
  if (hasGlobalName) {
    if (typeof global.name === "string") {
      const trimmed = global.name.trim();
      globalNameValue = trimmed.length > 0 ? trimmed : null;
    } else if (global.name == null) {
      globalNameValue = null;
    }
  }

  if (typeof globalNameValue === "string") {
    combined.name = globalNameValue;
    metadataName = globalNameValue;
  } else if (hasGlobalName && globalNameValue === null) {
    if (original.name === undefined) {
      delete combined.name;
    }
    metadataName = null;
  }

  if (!combined.type && typeof global.type === "string") {
    combined.type = global.type;
  }
  if (Object.prototype.hasOwnProperty.call(global, "folderPath")) {
    combined.folderPath = normalizeFolderPathInput(global.folderPath) ?? null;
  }
  combined.__bloomMetadataName = metadataName ?? null;
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
  const coverUrl = sanitizeCoverUrl(audio.coverUrl);
  if (coverUrl) normalized.coverUrl = coverUrl;
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
    normalizedA.year === normalizedB.year &&
    normalizedA.coverUrl === normalizedB.coverUrl
  );
}

export function sanitizeCoverUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("data:image/")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return trimmed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const RESERVED_FOLDER_KEYWORD = "private";

export function getBlobMetadataName(blob: BlossomBlob): string | null {
  const direct = blob.__bloomMetadataName;
  if (typeof direct === "string") {
    const trimmed = direct.trim();
    if (trimmed) {
      return trimmed;
    }
  } else if (direct === null) {
    return null;
  }
  const privateName = blob.privateData?.metadata?.name;
  if (typeof privateName === "string") {
    const trimmed = privateName.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof blob.name === "string") {
    const trimmed = blob.name.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

const splitFolderSegments = (value: string) =>
  value
    .split("/")
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

const normalizeReservedScanTarget = (segment: string) => segment.toLowerCase().replace(/[^a-z0-9]/g, "");

const segmentContainsReservedKeyword = (segment: string) =>
  normalizeReservedScanTarget(segment).includes(RESERVED_FOLDER_KEYWORD);

export function containsReservedFolderSegment(value?: string | null): boolean {
  if (value === undefined || value === null) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return splitFolderSegments(trimmed).some(segmentContainsReservedKeyword);
}

export function normalizeFolderPathInput(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = splitFolderSegments(trimmed);
  if (segments.some(segmentContainsReservedKeyword)) {
    return null;
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

export function rememberFolderPath(
  serverUrl: string | undefined,
  sha256: string,
  folderPath: string | null,
  options?: { updatedAt?: number }
) {
  if (!sha256) return;
  const normalized = normalizeFolderPathInput(folderPath);
  const updatedAt =
    typeof options?.updatedAt === "number" && Number.isFinite(options.updatedAt)
      ? Math.max(0, Math.trunc(options.updatedAt))
      : Date.now();
  const payload: StoredMetadata = {
    folderPath: normalized ?? null,
    updatedAt,
  };
  if (serverUrl) {
    setStoredBlobMetadata(serverUrl, sha256, payload);
  }
  setStoredBlobMetadata(undefined, sha256, payload);
}

export function applyFolderUpdate(
  serverUrl: string | undefined,
  sha256: string,
  folderPath: string | null,
  createdAtSeconds: number | undefined
): boolean {
  if (!sha256) return false;
  const updatedAt = typeof createdAtSeconds === "number" && Number.isFinite(createdAtSeconds)
    ? Math.max(0, createdAtSeconds) * 1000
    : Date.now();
  const existing = getStoredBlobMetadata(undefined, sha256);
  const existingUpdatedAt = existing?.updatedAt ?? 0;
  if (existingUpdatedAt > updatedAt) {
    return false;
  }
  const normalized = normalizeFolderPathInput(folderPath) ?? null;
  const existingFolder = normalizeFolderPathInput(existing?.folderPath) ?? null;
  if (existingUpdatedAt === updatedAt && existingFolder === normalized) {
    return false;
  }
  const payload: StoredMetadata = {
    folderPath: normalized,
    updatedAt,
  };
  setStoredBlobMetadata(undefined, sha256, payload);
  if (serverUrl) {
    setStoredBlobMetadata(serverUrl, sha256, payload);
  }
  return true;
}
