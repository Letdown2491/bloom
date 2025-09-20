import type { BlossomBlob } from "../lib/blossomClient";

const METADATA_STORAGE_VERSION = "v2";

type StoredMetadata = {
  name?: string;
  type?: string;
  updatedAt?: number;
  lastCheckedAt?: number;
};

const STORAGE_KEY = `bloom:blob-metadata:${METADATA_STORAGE_VERSION}`;

let cache: Record<string, Record<string, StoredMetadata>> | null = null;

function normalizeServerKey(serverUrl?: string) {
  if (!serverUrl) return undefined;
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

export function getStoredBlobMetadata(serverUrl: string | undefined, sha256: string) {
  if (!sha256) return undefined;
  const serverKey = normalizeServerKey(serverUrl);
  if (!serverKey) return undefined;
  const store = readCache();
  return store[serverKey]?.[sha256];
}

export function setStoredBlobMetadata(
  serverUrl: string | undefined,
  sha256: string,
  metadata: StoredMetadata
) {
  if (!sha256) return;
  const serverKey = normalizeServerKey(serverUrl);
  if (!serverKey) return;
  const store = readCache();
  const serverStore = store[serverKey] ?? (store[serverKey] = {});
  const current = serverStore[sha256] ?? {};
  const next: StoredMetadata = {
    name: metadata.name ?? current.name,
    type: metadata.type ?? current.type,
    updatedAt: metadata.updatedAt ?? (metadata.name || metadata.type ? Date.now() : current.updatedAt),
    lastCheckedAt: metadata.lastCheckedAt ?? current.lastCheckedAt,
  };
  if (!next.name) delete next.name;
  if (!next.type) delete next.type;
  if (!next.updatedAt && (current.name || current.type)) {
    next.updatedAt = current.updatedAt;
  }
  if (!next.lastCheckedAt) delete next.lastCheckedAt;
  if (!next.name && !next.type && !next.lastCheckedAt) {
    if (serverStore[sha256]) {
      delete serverStore[sha256];
      if (Object.keys(serverStore).length === 0) {
        delete store[serverKey];
      }
      persist();
    }
    return;
  }
  if (
    current.name === next.name &&
    current.type === next.type &&
    current.updatedAt === next.updatedAt &&
    current.lastCheckedAt === next.lastCheckedAt
  ) {
    return;
  }
  serverStore[sha256] = next;
  persist();
}

export function mergeBlobWithStoredMetadata(serverUrl: string | undefined, blob: BlossomBlob): BlossomBlob {
  const stored = getStoredBlobMetadata(serverUrl, blob.sha256);
  const merged: BlossomBlob = { ...blob };
  if (stored?.name && !merged.name) {
    merged.name = stored.name;
  }
  if (stored?.type && !merged.type) {
    merged.type = stored.type;
  }
  if (merged.name && merged.name !== stored?.name) {
    setStoredBlobMetadata(serverUrl, blob.sha256, { name: merged.name });
  }
  if (merged.type && merged.type !== stored?.type) {
    setStoredBlobMetadata(serverUrl, blob.sha256, { type: merged.type });
  }
  return merged;
}

export function mergeBlobsWithStoredMetadata(serverUrl: string | undefined, blobs: BlossomBlob[]) {
  return blobs.map(blob => mergeBlobWithStoredMetadata(serverUrl, blob));
}

export function rememberBlobMetadata(serverUrl: string | undefined, blob: BlossomBlob) {
  if (!blob.sha256) return;
  setStoredBlobMetadata(serverUrl, blob.sha256, {
    name: blob.name,
    type: blob.type,
  });
}

export function markBlobMetadataChecked(serverUrl: string | undefined, sha256: string, checkedAt = Date.now()) {
  if (!sha256) return;
  const serverKey = normalizeServerKey(serverUrl);
  if (!serverKey) return;
  const store = readCache();
  const serverStore = store[serverKey] ?? (store[serverKey] = {});
  const current = serverStore[sha256] ?? {};
  const next: StoredMetadata = {
    ...current,
    lastCheckedAt: checkedAt,
  };
  serverStore[sha256] = next;
  persist();
}

export function isMetadataFresh(stored: StoredMetadata | undefined, ttlMs: number) {
  if (!stored) return false;
  if (stored.name && stored.type) return true;
  if (typeof stored.lastCheckedAt === "number") {
    return Date.now() - stored.lastCheckedAt < ttlMs;
  }
  return false;
}
