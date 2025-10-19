import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { NDKRelay, NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";
import type { EventTemplate, SignedEvent } from "../../shared/api/blossomClient";
import { loadNdkModule, type NdkModule } from "../../shared/api/ndkModule";
import {
  createRelayConnectionManager,
  type RelayConnectionManager,
  type RelayPreparationOptions,
  type RelayPreparationResult,
} from "../../shared/api/ndkRelayManager";
import { checkLocalStorageQuota } from "../../shared/utils/storageQuota";

type NdkInstance = InstanceType<NdkModule["default"]>;

export type NdkConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type RelayHealth = {
  url: string;
  status: "connecting" | "connected" | "error";
  lastError?: string | null;
  lastEventAt?: number | null;
};

export type NdkContextValue = {
  ndk: NdkInstance | null;
  signer: NDKSigner | null;
  user: NDKUser | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  adoptSigner: (signer: NDKSigner | null) => Promise<void>;
  signEventTemplate: (template: EventTemplate) => Promise<SignedEvent>;
  status: NdkConnectionStatus;
  connectionError: Error | null;
  relayHealth: RelayHealth[];
  ensureConnection: () => Promise<NdkInstance>;
  getModule: () => Promise<NdkModule>;
  ensureRelays: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions
  ) => Promise<RelayPreparationResult>;
  prepareRelaySet: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions
  ) => Promise<RelayPreparationResult>;
};

const NdkContext = createContext<NdkContextValue | undefined>(undefined);

const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nsec.app",
];

const RELAY_HEALTH_STORAGE_KEY = "bloom.ndk.relayHealth.v1";
const SIGNER_PREFERENCE_STORAGE_KEY = "bloom.ndk.signerPreference.v1";
const RELAY_HEALTH_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const RELAY_HEALTH_TTL_SECONDS = Math.round(RELAY_HEALTH_TTL_MS / 1000);
const MAX_PERSISTED_RELAY_ENTRIES = 60;
const CRITICAL_RELAY_ENTRY_LIMIT = 24;
const RELAY_HEALTH_PERSIST_IDLE_DELAY_MS = 3000;
const RELAY_HEALTH_MIN_WRITE_INTERVAL_MS = 15000;

type PersistedSignerPreference = "nip07";

let relayHealthStorageBlocked = false;
let relayHealthStorageWarned = false;

const isQuotaExceededError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.code === 22 || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

type PersistableRelayHealth = {
  url: string;
  status: RelayHealth["status"];
  lastError?: string | null;
  lastEventAt?: number | null;
  updatedAt?: number | null;
};

type RelayPersistenceSnapshot = {
  payload: PersistableRelayHealth[];
  serialized: string;
  map: Map<string, PersistableRelayHealth>;
};

type RelayPersistenceResult = RelayPersistenceSnapshot & {
  quotaLimited: boolean;
};

const normalizeRelayUrl = (url: string | undefined | null) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
};

const toEpochSeconds = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.max(0, Math.trunc(value));
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

const buildRelayHealthSnapshot = (
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

const persistRelayHealthSnapshot = (snapshot: RelayPersistenceSnapshot): RelayPersistenceResult | null => {
  if (typeof window === "undefined" || relayHealthStorageBlocked) return null;
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
      relayHealthStorageBlocked = true;
      if (!relayHealthStorageWarned) {
        relayHealthStorageWarned = true;
        console.info("Relay health caching disabled: storage quota exceeded.");
      }
      return null;
    }
    console.warn("Unable to persist relay health cache", error);
    return null;
  }
};

const seedRelayHealth = (seed?: RelayHealth[]) => {
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
  DEFAULT_RELAYS.forEach(url => {
    const normalizedUrl = normalizeRelayUrl(url);
    if (!normalizedUrl) return;
    if (!map.has(normalizedUrl)) {
      map.set(normalizedUrl, {
        url: normalizedUrl,
        status: "error",
        lastError: "Not connected",
        lastEventAt: null,
      });
    }
  });
  return Array.from(map.values());
};

const loadPersistedRelayHealth = (): RelayHealth[] | null => {
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

const loadSignerPreference = (): PersistedSignerPreference | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SIGNER_PREFERENCE_STORAGE_KEY);
    return raw === "nip07" ? "nip07" : null;
  } catch (error) {
    console.warn("Unable to load signer preference", error);
    return null;
  }
};

const persistSignerPreference = (preference: PersistedSignerPreference | null) => {
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

export const NdkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ndkRef = useRef<NdkInstance | null>(null);
  const ndkModuleRef = useRef<NdkModule | null>(null);
  const [ndk, setNdk] = useState<NdkInstance | null>(null);
  const [signer, setSigner] = useState<NDKSigner | null>(null);
  const [user, setUser] = useState<NDKUser | null>(null);
  const [status, setStatus] = useState<NdkConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState<Error | null>(null);
  const [relayHealth, setRelayHealth] = useState<RelayHealth[]>(() => {
    const cached = loadPersistedRelayHealth();
    return seedRelayHealth(cached ?? undefined);
  });
  const relayHealthRef = useRef<RelayHealth[]>([]);
  const pendingRelayUpdatesRef = useRef<Map<string, Partial<RelayHealth>> | null>(null);
  const relayUpdateScheduledRef = useRef(false);
  const signerPreferenceRef = useRef<PersistedSignerPreference | null>(loadSignerPreference());
  const autoConnectAttemptedRef = useRef(false);
  const relayPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRelaySnapshotRef = useRef<RelayPersistenceSnapshot | null>(null);
  const lastPersistedRelaySignatureRef = useRef<string | null>(null);
  const lastPersistedRelayMapRef = useRef<Map<string, PersistableRelayHealth>>(new Map());
  const lastRelayPersistAtRef = useRef<number>(0);
  const relayHealthQuotaLimitedRef = useRef(false);
  const relayManagerRef = useRef<RelayConnectionManager | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(RELAY_HEALTH_STORAGE_KEY);
      if (!raw) {
        lastPersistedRelaySignatureRef.current = "[]";
        lastPersistedRelayMapRef.current = new Map();
        lastRelayPersistAtRef.current = Date.now();
        return;
      }
      lastPersistedRelaySignatureRef.current = raw;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const map = new Map<string, PersistableRelayHealth>();
        parsed.forEach(item => {
          const normalizedUrl = normalizeRelayUrl((item as PersistableRelayHealth)?.url);
          if (!normalizedUrl) return;
          map.set(normalizedUrl, {
            url: normalizedUrl,
            status: (item as PersistableRelayHealth)?.status,
            lastError: (item as PersistableRelayHealth)?.lastError ?? null,
            lastEventAt:
              typeof (item as PersistableRelayHealth)?.lastEventAt === "number"
                ? (item as PersistableRelayHealth).lastEventAt
                : null,
            updatedAt:
              typeof (item as PersistableRelayHealth)?.updatedAt === "number"
                ? (item as PersistableRelayHealth).updatedAt
                : null,
          });
        });
        lastPersistedRelayMapRef.current = map;
      } else {
        lastPersistedRelayMapRef.current = new Map();
      }
      lastRelayPersistAtRef.current = Date.now();
    } catch (error) {
      lastPersistedRelaySignatureRef.current = "[]";
      lastPersistedRelayMapRef.current = new Map();
      lastRelayPersistAtRef.current = Date.now();
    }
  }, []);

  const ensureNdkModule = useCallback(async (): Promise<NdkModule> => {
    if (!ndkModuleRef.current) {
      ndkModuleRef.current = await loadNdkModule();
    }
    return ndkModuleRef.current;
  }, []);

  const ensureNdkInstance = useCallback(async () => {
    const mod = await ensureNdkModule();

    if (!ndkRef.current) {
      ndkRef.current = new mod.default({ explicitRelayUrls: DEFAULT_RELAYS });
      setNdk(ndkRef.current);
      relayManagerRef.current = createRelayConnectionManager(ndkRef.current, ensureNdkModule);
    }

    if (!relayManagerRef.current && ndkRef.current) {
      relayManagerRef.current = createRelayConnectionManager(ndkRef.current, ensureNdkModule);
    }

    return { ndk: ndkRef.current, module: mod } as { ndk: NdkInstance; module: NdkModule };
  }, [ensureNdkModule]);

  const ensureNdkConnection = useCallback(async (): Promise<NdkInstance> => {
    const { ndk: instance } = await ensureNdkInstance();
    const attempt = instance.connect();
    setStatus(prev => (prev === "connected" ? prev : "connecting"));
    setConnectionError(null);
    setRelayHealth(current =>
      current.map(relay => ({ ...relay, status: "connecting", lastError: null, lastEventAt: relay.lastEventAt }))
    );

    attempt
      .then(() => {
        setStatus("connected");
        return undefined;
      })
      .catch(error => {
        const normalized = error instanceof Error ? error : new Error("Failed to connect to relays");
        setConnectionError(normalized);
        setStatus("error");
        return undefined;
      });

    if (typeof window === "undefined") {
      await attempt.catch(() => undefined);
      return instance;
    }

    let timeoutHandle: number | null = null;
    const settleOrTimeout = Promise.race([
      attempt.catch(() => undefined),
      new Promise(resolve => {
        timeoutHandle = window.setTimeout(() => {
          timeoutHandle = null;
          resolve(undefined);
        }, 2000);
      }),
    ]);

    try {
      await settleOrTimeout;
    } finally {
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
    }

    return instance;
  }, [ensureNdkInstance]);

  const getNdkModule = useCallback(async () => {
    return ensureNdkModule();
  }, [ensureNdkModule]);

  const prepareRelaySet = useCallback(
    async (relayUrls: readonly string[], options?: RelayPreparationOptions): Promise<RelayPreparationResult> => {
      const { ndk: instance } = await ensureNdkInstance();
      if (!relayManagerRef.current && instance) {
        relayManagerRef.current = createRelayConnectionManager(instance, ensureNdkModule);
      }
      if (!relayManagerRef.current) {
        return { relaySet: null, connected: [], pending: [] };
      }
      return relayManagerRef.current.prepareRelaySet(relayUrls, options);
    },
    [ensureNdkInstance, ensureNdkModule]
  );

  const ensureRelays = useCallback(
    async (relayUrls: readonly string[], options?: RelayPreparationOptions): Promise<RelayPreparationResult> => {
      return prepareRelaySet(relayUrls, options);
    },
    [prepareRelaySet]
  );

  useEffect(() => {
    if (!ndk) return;
    const module = ndkModuleRef.current;
    if (!module) return;
    const pool = ndk.pool;
    if (!pool) return;

    const { NDKRelayStatus } = module;

    const statusFromRelay = (relay: NDKRelay): RelayHealth["status"] => {
      switch (relay.status) {
        case NDKRelayStatus.CONNECTED:
        case NDKRelayStatus.AUTH_REQUESTED:
        case NDKRelayStatus.AUTHENTICATING:
        case NDKRelayStatus.AUTHENTICATED:
          return "connected";
        case NDKRelayStatus.DISCONNECTING:
        case NDKRelayStatus.DISCONNECTED:
        case NDKRelayStatus.FLAPPING:
          return "error";
        default:
          return "connecting";
      }
    };

    const primeKnownRelays = () => {
    setRelayHealth(current => {
      const previousMap = new Map<string, RelayHealth>();
      current.forEach(entry => {
        previousMap.set(entry.url, entry);
      });

      const next = new Map<string, RelayHealth>();
      const baseRelays = ndk.explicitRelayUrls?.length ? ndk.explicitRelayUrls : DEFAULT_RELAYS;
      baseRelays.forEach(url => {
        const normalized = url.replace(/\/$/, "");
        if (!normalized) return;
        const existing = previousMap.get(normalized);
        next.set(normalized, existing ?? { url: normalized, status: "connecting", lastError: null, lastEventAt: null });
      });

      pool.relays.forEach(relay => {
        const url = relay.url.replace(/\/$/, "");
        const previous = next.get(url) ?? previousMap.get(url);
        next.set(url, {
          url,
          status: statusFromRelay(relay),
          lastError: previous?.lastError ?? null,
          lastEventAt: previous?.lastEventAt ?? null,
        });
      });

      const nextArray = Array.from(next.values());
      const unchanged =
        nextArray.length === current.length &&
        nextArray.every((entry, index) => {
          const currentEntry = current[index];
          return (
            currentEntry &&
            currentEntry.url === entry.url &&
            currentEntry.status === entry.status &&
            (currentEntry.lastError ?? null) === (entry.lastError ?? null) &&
            (currentEntry.lastEventAt ?? null) === (entry.lastEventAt ?? null)
          );
        });

      return unchanged ? current : nextArray;
    });
    };

    const flushRelayUpdates = () => {
      relayUpdateScheduledRef.current = false;
      const pending = pendingRelayUpdatesRef.current;
      pendingRelayUpdatesRef.current = null;
      if (!pending || pending.size === 0) return;

      setRelayHealth(current => {
        let changed = false;
        const next = current.slice();

        const applyPatch = (url: string, patch: Partial<RelayHealth>) => {
          let foundIndex = -1;
          for (let index = 0; index < next.length; index += 1) {
            if (next[index]?.url === url) {
              foundIndex = index;
              break;
            }
          }

          if (foundIndex >= 0) {
            const entry = next[foundIndex]!;
            const nextStatus = patch.status ?? entry.status;
            const nextLastError = patch.lastError !== undefined ? patch.lastError : entry.lastError ?? null;
            const nextLastEventAt = patch.lastEventAt !== undefined ? patch.lastEventAt : entry.lastEventAt ?? null;

            if (
              nextStatus === entry.status &&
              nextLastError === (entry.lastError ?? null) &&
              nextLastEventAt === (entry.lastEventAt ?? null)
            ) {
              return;
            }

            next[foundIndex] = {
              ...entry,
              status: nextStatus,
              lastError: nextLastError,
              lastEventAt: nextLastEventAt,
            };
            changed = true;
          } else {
            next.push({
              url,
              status: patch.status ?? "connecting",
              lastError: patch.lastError ?? null,
              lastEventAt: patch.lastEventAt ?? null,
            });
            changed = true;
          }
        };

        pending.forEach((patch, url) => applyPatch(url, patch));
        return changed ? next : current;
      });
    };

    const scheduleRelayUpdate = () => {
      if (relayUpdateScheduledRef.current) {
        return;
      }
      relayUpdateScheduledRef.current = true;
      const schedule = typeof window === "undefined" ? (fn: () => void) => fn() : window.requestAnimationFrame;
      schedule(() => flushRelayUpdates());
    };

    const updateRelay = (url: string, patch: Partial<RelayHealth>) => {
      const normalized = normalizeRelayUrl(url);
      if (!normalized) return;
      let pending = pendingRelayUpdatesRef.current;
      if (!pending) {
        pending = new Map();
        pendingRelayUpdatesRef.current = pending;
      }
      const existing = pending.get(normalized);
      if (existing) {
        pending.set(normalized, { ...existing, ...patch });
      } else {
        pending.set(normalized, patch);
      }
      scheduleRelayUpdate();
    };

    primeKnownRelays();

    const handleConnecting = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "connecting", lastEventAt: Date.now() });
      relayManagerRef.current?.handlePoolEvent(relay, "connecting");
    };

    const handleConnect = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "connected", lastError: null, lastEventAt: Date.now() });
      relayManagerRef.current?.handlePoolEvent(relay, "connected");
    };

    const handleReady = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "connected", lastError: null, lastEventAt: Date.now() });
      relayManagerRef.current?.handlePoolEvent(relay, "connected");
    };

    const handleDisconnect = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "error", lastError: "Disconnected", lastEventAt: Date.now() });
      relayManagerRef.current?.handlePoolEvent(relay, "error");
    };

    const handleNotice = (relay: NDKRelay, message?: string) => {
      const normalizedUrl = normalizeRelayUrl(relay.url);
      if (!normalizedUrl) return;
      const current = relayHealthRef.current.find(entry => entry.url === normalizedUrl);
      const resolvedMessage = message ?? "Relay notice";
      if (current && current.lastError === resolvedMessage) {
        return;
      }
      updateRelay(normalizedUrl, { lastError: resolvedMessage });
    };

    pool.on("relay:connecting", handleConnecting);
    pool.on("relay:connect", handleConnect);
    pool.on("relay:ready", handleReady);
    pool.on("relay:disconnect", handleDisconnect);
    pool.on("notice", handleNotice);

    return () => {
      pendingRelayUpdatesRef.current = null;
      relayUpdateScheduledRef.current = false;
      pool.off("relay:connecting", handleConnecting);
      pool.off("relay:connect", handleConnect);
      pool.off("relay:ready", handleReady);
      pool.off("relay:disconnect", handleDisconnect);
      pool.off("notice", handleNotice);
    };
  }, [ndk]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (relayPersistTimerRef.current) {
      clearTimeout(relayPersistTimerRef.current);
      relayPersistTimerRef.current = null;
    }

    const builderLimit = relayHealthQuotaLimitedRef.current ? CRITICAL_RELAY_ENTRY_LIMIT : MAX_PERSISTED_RELAY_ENTRIES;
    const snapshot = buildRelayHealthSnapshot(relayHealth, lastPersistedRelayMapRef.current, builderLimit);
    latestRelaySnapshotRef.current = snapshot;

    if (relayHealthStorageBlocked) {
      return;
    }

    if (lastPersistedRelaySignatureRef.current === snapshot.serialized) {
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - lastRelayPersistAtRef.current;
    const minIntervalRemaining =
      timeSinceLast >= RELAY_HEALTH_MIN_WRITE_INTERVAL_MS
        ? 0
        : RELAY_HEALTH_MIN_WRITE_INTERVAL_MS - timeSinceLast;
    const delay = Math.max(RELAY_HEALTH_PERSIST_IDLE_DELAY_MS, minIntervalRemaining);

    relayPersistTimerRef.current = window.setTimeout(() => {
      const latest = latestRelaySnapshotRef.current;
      if (!latest) return;
      if (lastPersistedRelaySignatureRef.current === latest.serialized) return;
      const result = persistRelayHealthSnapshot(latest);
      if (result) {
        lastPersistedRelaySignatureRef.current = result.serialized;
        lastPersistedRelayMapRef.current = result.map;
        lastRelayPersistAtRef.current = Date.now();
        latestRelaySnapshotRef.current = result;
        relayHealthQuotaLimitedRef.current = result.quotaLimited;
      }
      relayPersistTimerRef.current = null;
    }, delay);
  }, [relayHealth]);

  useEffect(() => {
    relayHealthRef.current = relayHealth;
  }, [relayHealth]);

  useEffect(() => {
    return () => {
      if (relayPersistTimerRef.current) {
        clearTimeout(relayPersistTimerRef.current);
        relayPersistTimerRef.current = null;
        const latest = latestRelaySnapshotRef.current;
        if (latest && lastPersistedRelaySignatureRef.current !== latest.serialized) {
          const result = persistRelayHealthSnapshot(latest);
          if (result) {
            lastPersistedRelaySignatureRef.current = result.serialized;
            lastPersistedRelayMapRef.current = result.map;
            lastRelayPersistAtRef.current = Date.now();
            relayHealthQuotaLimitedRef.current = result.quotaLimited;
          }
        }
      }
    };
  }, []);

  const adoptSigner = useCallback(
    async (nextSigner: NDKSigner | null) => {
      try {
        if (nextSigner) {
          const instance = await ensureNdkConnection();
          const nextUser = await nextSigner.user();
          instance.signer = nextSigner;
          setSigner(nextSigner);
          setUser(nextUser);
          setStatus("connected");
          setConnectionError(null);
          const module = ndkModuleRef.current;
          const nip07Ctor = module?.NDKNip07Signer;
          if (nip07Ctor && nextSigner instanceof nip07Ctor) {
            persistSignerPreference("nip07");
            signerPreferenceRef.current = "nip07";
          } else {
            persistSignerPreference(null);
            signerPreferenceRef.current = null;
          }
        } else {
          const instance = ndkRef.current;
          if (instance) {
            instance.signer = undefined;
          }
          setSigner(null);
          setUser(null);
          setStatus("idle");
          persistSignerPreference(null);
          signerPreferenceRef.current = null;
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error("Failed to adopt signer");
        setConnectionError(normalized);
        setStatus("error");
        throw normalized;
      }
    },
    [ensureNdkConnection]
  );

  const connect = useCallback(async () => {
    if (!(window as any).nostr) {
      const error = new Error("A NIP-07 signer is required (e.g. Alby, nos2x).");
      setConnectionError(error);
      setStatus("error");
      throw error;
    }
    try {
      const { module } = await ensureNdkInstance();
      const nip07Signer = new module.NDKNip07Signer();
      await nip07Signer.blockUntilReady();
      await adoptSigner(nip07Signer);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Failed to connect Nostr signer");
      setConnectionError(normalized);
      setStatus("error");
      throw normalized;
    }
  }, [adoptSigner, ensureNdkInstance]);

  const disconnect = useCallback(() => {
    void adoptSigner(null);
    setConnectionError(null);
  }, [adoptSigner]);

  const signEventTemplate = useCallback<NdkContextValue["signEventTemplate"]>(
    async template => {
      if (!signer) throw new Error("Connect a signer first.");
      const { ndk: instance, module } = await ensureNdkInstance();
      const event = new module.NDKEvent(instance, template);
      if (!event.created_at) {
        event.created_at = Math.floor(Date.now() / 1000);
      }
      await event.sign();
      return event.rawEvent();
    },
    [ensureNdkInstance, signer]
  );

  useEffect(() => {
    if (signerPreferenceRef.current !== "nip07") return;
    if (autoConnectAttemptedRef.current) return;
    if (signer) return;
    if (typeof window === "undefined") return;
    if (!(window as any).nostr) return;

    autoConnectAttemptedRef.current = true;

    const win = window as typeof window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    let cancelled = false;

    const attemptConnect = () => {
      if (cancelled) return;
      void connect().catch(error => {
        if (cancelled) return;
        console.warn("Automatic NIP-07 reconnect failed", error);
      });
    };

    if (typeof win.requestIdleCallback === "function") {
      const handle = win.requestIdleCallback(() => attemptConnect(), { timeout: 1500 });
      return () => {
        cancelled = true;
        win.cancelIdleCallback?.(handle);
      };
    }

    const timeout = window.setTimeout(() => attemptConnect(), 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [connect, signer]);

  const value = useMemo<NdkContextValue>(
    () => ({
      ndk,
      signer,
      user,
      connect,
      disconnect,
      adoptSigner,
      signEventTemplate,
      status,
      connectionError,
      relayHealth,
      ensureConnection: ensureNdkConnection,
      getModule: getNdkModule,
      ensureRelays,
      prepareRelaySet,
    }),
    [
      ndk,
      signer,
      user,
      connect,
      disconnect,
      adoptSigner,
      signEventTemplate,
      status,
      connectionError,
      relayHealth,
      ensureNdkConnection,
      getNdkModule,
      ensureRelays,
      prepareRelaySet,
    ]
  );

  return <NdkContext.Provider value={value}>{children}</NdkContext.Provider>;
};

export const useNdk = () => {
  const ctx = useContext(NdkContext);
  if (!ctx) throw new Error("useNdk must be used within NdkProvider");
  return ctx;
};

export const useCurrentPubkey = () => {
  const { user } = useNdk();
  return user?.pubkey || null;
};
