import { sanitizeRelayUrl } from "../../shared/utils/relays";
import { checkLocalStorageQuota } from "../../shared/utils/storageQuota";

export type RelayHealthStatus = "connecting" | "connected" | "error";

export type RelayHealth = {
  url: string;
  status: RelayHealthStatus;
  lastError?: string | null;
  lastEventAt?: number | null;
};

export type PersistableRelayHealth = {
  url: string;
  status: RelayHealthStatus;
  lastError?: string | null;
  lastEventAt?: number | null;
  updatedAt?: number | null;
};

export type RelayPersistenceSnapshot = {
  payload: PersistableRelayHealth[];
  serialized: string;
  map: Map<string, PersistableRelayHealth>;
};

export type RelayPersistenceResult = RelayPersistenceSnapshot & {
  quotaLimited: boolean;
};

const RELAY_HEALTH_STORAGE_KEY = "bloom.ndk.relayHealth.v1";
const RELAY_HEALTH_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const RELAY_HEALTH_TTL_SECONDS = Math.round(RELAY_HEALTH_TTL_MS / 1000);
const MAX_PERSISTED_RELAY_ENTRIES = 60;
const CRITICAL_RELAY_ENTRY_LIMIT = 24;

const relayHealthStorageState = {
  blocked: false,
  warned: false,
};

export const normalizeRelayUrl = (url: string | undefined | null): string | null => {
  if (!url) return null;
  const sanitized = sanitizeRelayUrl(url);
  if (!sanitized) return null;
  return `${sanitized.replace(/\/+$/, "")}/`;
};

const toEpochSeconds = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  if (normalized > 1_000_000_000_000) {
    return Math.trunc(normalized / 1000);
  }
  return normalized;
};

const secondsToMillis = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 1_000_000_000_000) {
    return Math.trunc(value);
  }
  return Math.trunc(value * 1000);
};

const dedupeRelayEntries = (entries: RelayHealth[], maxCount: number) => {
  const map = new Map<string, RelayHealth>();
  entries.forEach(entry => {
    const existing = map.get(entry.url);
    if (!existing) {
      map.set(entry.url, entry);
      return;
    }
    const existingTime = existing.lastEventAt ?? 0;
    const incomingTime = entry.lastEventAt ?? 0;
    if (incomingTime >= existingTime) {
      map.set(entry.url, entry);
    }
  });
  const deduped = Array.from(map.values());
  deduped.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
  if (deduped.length > maxCount) {
    return deduped.slice(0, maxCount);
  }
  return deduped;
};

export const buildRelayHealthSnapshot = (
  entries: RelayHealth[],
  previous: Map<string, PersistableRelayHealth>,
  limit: number
): RelayPersistenceSnapshot => {
  const nowMs = Date.now();
  const nowSeconds = Math.trunc(nowMs / 1000);
  const deduped = dedupeRelayEntries(entries, limit);
  const payload: PersistableRelayHealth[] = [];
  const map = new Map<string, PersistableRelayHealth>();

  deduped.forEach(entry => {
    const normalizedUrl = normalizeRelayUrl(entry.url);
    if (!normalizedUrl) return;

    const lastEventMs =
      typeof entry.lastEventAt === "number" && Number.isFinite(entry.lastEventAt) ? entry.lastEventAt : null;
    const previousEntry = previous.get(normalizedUrl);
    const previousFreshMs =
      typeof previousEntry?.updatedAt === "number" && Number.isFinite(previousEntry.updatedAt)
        ? previousEntry.updatedAt * 1000
        : null;
    const freshestMs = lastEventMs ?? previousFreshMs ?? null;
    if (freshestMs && nowMs - freshestMs > RELAY_HEALTH_TTL_MS) {
      return;
    }

    const lastEventSeconds = toEpochSeconds(lastEventMs) ?? null;
    const status = entry.status;
    const lastError = entry.lastError ?? null;

    const prevSameStatus = previousEntry?.status === status;
    const prevSameError = (previousEntry?.lastError ?? null) === lastError;
    const prevSameEvent = previousEntry?.lastEventAt === lastEventSeconds;
    const previousUpdatedAt =
      typeof previousEntry?.updatedAt === "number" && Number.isFinite(previousEntry.updatedAt)
        ? previousEntry.updatedAt
        : lastEventSeconds ?? null;

    const updatedAt =
      prevSameStatus && prevSameError && prevSameEvent
        ? previousUpdatedAt ?? nowSeconds
        : nowSeconds;

    const normalized: PersistableRelayHealth = {
      url: normalizedUrl,
      status,
      lastError,
      lastEventAt: lastEventSeconds,
      updatedAt,
    };
    payload.push(normalized);
    map.set(normalizedUrl, normalized);
  });

  payload.sort((a, b) => {
    const aEvent = a.lastEventAt ?? 0;
    const bEvent = b.lastEventAt ?? 0;
    if (aEvent !== bEvent) return bEvent - aEvent;
    const aUpdated = a.updatedAt ?? 0;
    const bUpdated = b.updatedAt ?? 0;
    if (aUpdated !== bUpdated) return bUpdated - aUpdated;
    return a.url.localeCompare(b.url);
  });

  const serialized = payload.length > 0 ? JSON.stringify(payload) : "[]";
  return { payload, serialized, map };
};

const isQuotaExceededError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.code === 22 || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

export const persistRelayHealthSnapshot = (
  snapshot: RelayPersistenceSnapshot
): RelayPersistenceResult | null => {
  if (typeof window === "undefined" || relayHealthStorageState.blocked) return null;
  try {
    if (snapshot.payload.length === 0) {
      window.localStorage.removeItem(RELAY_HEALTH_STORAGE_KEY);
      return { payload: [], serialized: "[]", map: new Map(), quotaLimited: false };
    }

    let storedPayload = snapshot.payload;
    let storedSerialized = snapshot.serialized;
    let quotaLimited = false;

    window.localStorage.removeItem(RELAY_HEALTH_STORAGE_KEY);
    window.localStorage.setItem(RELAY_HEALTH_STORAGE_KEY, storedSerialized);

    const quota = checkLocalStorageQuota("relay-health");
    if (quota.status === "critical" && storedPayload.length > CRITICAL_RELAY_ENTRY_LIMIT) {
      storedPayload = storedPayload.slice(0, CRITICAL_RELAY_ENTRY_LIMIT);
      storedSerialized = JSON.stringify(storedPayload);
      window.localStorage.setItem(RELAY_HEALTH_STORAGE_KEY, storedSerialized);
      checkLocalStorageQuota("relay-health-pruned", { log: false });
      quotaLimited = true;
    }

    const map = new Map<string, PersistableRelayHealth>();
    storedPayload.forEach(entry => {
      map.set(entry.url, entry);
    });

    return { payload: storedPayload, serialized: storedSerialized, map, quotaLimited };
  } catch (error) {
    if (isQuotaExceededError(error)) {
      relayHealthStorageState.blocked = true;
      if (!relayHealthStorageState.warned) {
        relayHealthStorageState.warned = true;
        console.info("Relay health caching disabled: storage quota exceeded.");
      }
      return null;
    }
    console.warn("Unable to persist relay health cache", error);
    return null;
  }
};

export const loadPersistedRelayHealth = (): RelayHealth[] | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RELAY_HEALTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries: RelayHealth[] = [];
    const nowSeconds = Math.trunc(Date.now() / 1000);
    parsed.forEach(item => {
      const normalizedUrl = normalizeRelayUrl((item as PersistableRelayHealth)?.url);
      const status = (item as PersistableRelayHealth)?.status;
      if (!normalizedUrl) return;
      if (status !== "connecting" && status !== "connected" && status !== "error") return;
      const persistedLastEvent = toEpochSeconds((item as PersistableRelayHealth)?.lastEventAt);
      const persistedUpdatedAt = toEpochSeconds((item as PersistableRelayHealth)?.updatedAt);
      const freshest = Math.max(persistedLastEvent ?? 0, persistedUpdatedAt ?? 0);
      if (freshest && freshest > 0 && nowSeconds - freshest > RELAY_HEALTH_TTL_SECONDS) {
        return;
      }
      entries.push({
        url: normalizedUrl,
        status,
        lastError: (item as PersistableRelayHealth)?.lastError ?? null,
        lastEventAt: secondsToMillis(persistedLastEvent),
      });
    });
    if (entries.length === 0) return null;
    const deduped = dedupeRelayEntries(entries, MAX_PERSISTED_RELAY_ENTRIES);
    return deduped.length > 0 ? deduped : null;
  } catch (error) {
    console.warn("Unable to load relay health cache", error);
    return null;
  }
};

export const seedRelayHealth = (seed?: RelayHealth[], fallbackRelays: readonly string[] = []) => {
  const map = new Map<string, RelayHealth>();
  const addEntry = (entry: RelayHealth) => {
    const normalizedUrl = normalizeRelayUrl(entry.url);
    if (!normalizedUrl) return;
    if (entry.status !== "connecting" && entry.status !== "connected" && entry.status !== "error") return;
    map.set(normalizedUrl, {
      url: normalizedUrl,
      status: entry.status,
      lastError: entry.lastError ?? null,
      lastEventAt: typeof entry.lastEventAt === "number" ? entry.lastEventAt : null,
    });
  };

  seed?.forEach(addEntry);
  fallbackRelays.forEach(url => {
    const normalizedUrl = normalizeRelayUrl(url);
    if (!normalizedUrl || map.has(normalizedUrl)) return;
    map.set(normalizedUrl, {
      url: normalizedUrl,
      status: "error",
      lastError: "Not connected",
      lastEventAt: null,
    });
  });
  return Array.from(map.values());
};

export type PersistedSignerPreference = "nip07";

const SIGNER_PREFERENCE_STORAGE_KEY = "bloom.ndk.signerPreference.v1";

export const loadSignerPreference = (): PersistedSignerPreference | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SIGNER_PREFERENCE_STORAGE_KEY);
    return raw === "nip07" ? "nip07" : null;
  } catch (error) {
    console.warn("Unable to load signer preference", error);
    return null;
  }
};

export const persistSignerPreference = (preference: PersistedSignerPreference | null) => {
  if (typeof window === "undefined") return;
  try {
    if (!preference) {
      window.localStorage.removeItem(SIGNER_PREFERENCE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SIGNER_PREFERENCE_STORAGE_KEY, preference);
    }
  } catch (error) {
    console.warn("Unable to persist signer preference", error);
  }
};
