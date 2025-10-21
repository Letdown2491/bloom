import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NDKRelay, NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";
import type { EventTemplate, SignedEvent } from "../../shared/api/blossomClient";
import { loadNdkModule, type NdkModule } from "../../shared/api/ndkModule";
import {
  createRelayConnectionManager,
  type RelayConnectionManager,
  type RelayPreparationOptions,
  type RelayPreparationResult,
} from "../../shared/api/ndkRelayManager";
import {
  type RelayHealth,
  type RelayPersistenceSnapshot,
  type PersistableRelayHealth,
  type PersistedSignerPreference,
  seedRelayHealth,
  loadPersistedRelayHealth,
  buildRelayHealthSnapshot,
  persistRelayHealthSnapshot,
  normalizeRelayUrl,
  loadSignerPreference,
  persistSignerPreference,
} from "../services/ndkRelayPersistence";

export type { RelayHealth } from "../services/ndkRelayPersistence";

type NdkInstance = InstanceType<NdkModule["default"]>;

export type NdkConnectionStatus = "idle" | "connecting" | "connected" | "error";

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
    options?: RelayPreparationOptions,
  ) => Promise<RelayPreparationResult>;
  prepareRelaySet: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions,
  ) => Promise<RelayPreparationResult>;
};

const NdkContext = createContext<NdkContextValue | undefined>(undefined);

const RAW_DEFAULT_RELAYS = ["wss://purplepag.es", "wss://user.kindpag.es"] as const;

const getNormalizedFallbackRelays = (): string[] => {
  return RAW_DEFAULT_RELAYS.map(url => normalizeRelayUrl(url)).filter((url): url is string =>
    Boolean(url),
  );
};

const removeFallbackRelays = (instance: NdkInstance | null | undefined) => {
  if (!instance) return;
  const fallbackSet = new Set(getNormalizedFallbackRelays());
  if (!fallbackSet.size) return;
  const pool = instance.pool;
  if (pool) {
    fallbackSet.forEach(url => {
      if (!url) return;
      if (pool.relays.has(url)) {
        pool.removeRelay(url);
      } else if (pool.relays.has(`${url}/`)) {
        pool.removeRelay(`${url}/`);
      }
    });
  }
  const explicit = instance.explicitRelayUrls ?? [];
  const filtered = explicit.filter(url => {
    const normalized = normalizeRelayUrl(url);
    return normalized ? !fallbackSet.has(normalized) : true;
  });
  if (filtered.length !== explicit.length) {
    instance.explicitRelayUrls = filtered;
  }
};

const isFallbackRelay = (url: string | undefined | null): boolean => {
  const normalized = normalizeRelayUrl(url);
  if (!normalized) return false;
  return getNormalizedFallbackRelays().includes(normalized);
};

const RELAY_HEALTH_PERSIST_IDLE_DELAY_MS = 3000;
const RELAY_HEALTH_MIN_WRITE_INTERVAL_MS = 15000;
const RELAY_HEALTH_MAX_ENTRIES = 60;
const RELAY_HEALTH_CRITICAL_LIMIT = 24;

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
    return seedRelayHealth(cached ?? undefined, getNormalizedFallbackRelays());
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
    const cached = loadPersistedRelayHealth();
    if (!cached) {
      lastPersistedRelaySignatureRef.current = "[]";
      lastPersistedRelayMapRef.current = new Map();
    } else {
      const snapshot = buildRelayHealthSnapshot(cached, new Map(), cached.length);
      lastPersistedRelaySignatureRef.current = snapshot.serialized;
      lastPersistedRelayMapRef.current = snapshot.map;
    }
    lastRelayPersistAtRef.current = Date.now();
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
      ndkRef.current = new mod.default({ explicitRelayUrls: getNormalizedFallbackRelays() });
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
      current.map(relay => ({
        ...relay,
        status: "connecting",
        lastError: null,
        lastEventAt: relay.lastEventAt,
      })),
    );

    attempt
      .then(() => {
        setStatus("connected");
        return undefined;
      })
      .catch(error => {
        const normalized =
          error instanceof Error ? error : new Error("Failed to connect to relays");
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
    async (
      relayUrls: readonly string[],
      options?: RelayPreparationOptions,
    ): Promise<RelayPreparationResult> => {
      const { ndk: instance } = await ensureNdkInstance();
      if (!relayManagerRef.current && instance) {
        relayManagerRef.current = createRelayConnectionManager(instance, ensureNdkModule);
      }
      if (!relayManagerRef.current) {
        return { relaySet: null, connected: [], pending: [] };
      }
      return relayManagerRef.current.prepareRelaySet(relayUrls, options);
    },
    [ensureNdkInstance, ensureNdkModule],
  );

  const ensureRelays = useCallback(
    async (
      relayUrls: readonly string[],
      options?: RelayPreparationOptions,
    ): Promise<RelayPreparationResult> => {
      return prepareRelaySet(relayUrls, options);
    },
    [prepareRelaySet],
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
        const explicitRelays = ndk.explicitRelayUrls ?? [];
        const baseRelays =
          explicitRelays.length > 0
            ? explicitRelays
            : pool.relays.size > 0
              ? []
              : getNormalizedFallbackRelays();

        baseRelays.forEach(url => {
          const normalized = normalizeRelayUrl(url);
          if (!normalized) return;
          const existing = previousMap.get(normalized);
          next.set(
            normalized,
            existing ?? {
              url: normalized,
              status: "connecting",
              lastError: null,
              lastEventAt: null,
            },
          );
        });

        pool.relays.forEach(relay => {
          const url = normalizeRelayUrl(relay.url);
          if (!url) return;
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
            const nextLastError =
              patch.lastError !== undefined ? patch.lastError : (entry.lastError ?? null);
            const nextLastEventAt =
              patch.lastEventAt !== undefined ? patch.lastEventAt : (entry.lastEventAt ?? null);

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
      const schedule =
        typeof window === "undefined" ? (fn: () => void) => fn() : window.requestAnimationFrame;
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
      updateRelay(relay.url, {
        status: "error",
        lastError: "Disconnected",
        lastEventAt: Date.now(),
      });
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

    const builderLimit = relayHealthQuotaLimitedRef.current
      ? RELAY_HEALTH_CRITICAL_LIMIT
      : RELAY_HEALTH_MAX_ENTRIES;
    const snapshot = buildRelayHealthSnapshot(
      relayHealth,
      lastPersistedRelayMapRef.current,
      builderLimit,
    );
    latestRelaySnapshotRef.current = snapshot;

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
          removeFallbackRelays(instance);
          setRelayHealth(current => current.filter(entry => !isFallbackRelay(entry.url)));
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
            const fallbackRelays = getNormalizedFallbackRelays();
            if (fallbackRelays.length) {
              instance.explicitRelayUrls = fallbackRelays;
            }
          }
          setSigner(null);
          setUser(null);
          setStatus("idle");
          setRelayHealth(seedRelayHealth(undefined, getNormalizedFallbackRelays()));
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
    [ensureNdkConnection],
  );

  const connect = useCallback(async () => {
    const nostrApi = (
      typeof window !== "undefined"
        ? (window as typeof window & { nostr?: unknown }).nostr
        : undefined
    ) as object | undefined;
    if (!nostrApi) {
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
      const normalized =
        error instanceof Error ? error : new Error("Failed to connect Nostr signer");
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
    [ensureNdkInstance, signer],
  );

  useEffect(() => {
    if (signerPreferenceRef.current !== "nip07") return;
    if (autoConnectAttemptedRef.current) return;
    if (signer) return;
    if (typeof window === "undefined") return;
    const nostrApi = (window as typeof window & { nostr?: unknown }).nostr;
    if (!nostrApi) return;

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
    ],
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
