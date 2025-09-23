import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import NDK, {
  NDKEvent,
  NDKNip07Signer,
  NDKRelay,
  NDKRelayStatus,
  NDKSigner,
  NDKUser,
} from "@nostr-dev-kit/ndk";
import type { EventTemplate, SignedEvent } from "../lib/blossomClient";

export type NdkConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type RelayHealth = {
  url: string;
  status: "connecting" | "connected" | "error";
  lastError?: string | null;
  lastEventAt?: number | null;
};

export type NdkContextValue = {
  ndk: NDK | null;
  signer: NDKSigner | null;
  user: NDKUser | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signEventTemplate: (template: EventTemplate) => Promise<SignedEvent>;
  status: NdkConnectionStatus;
  connectionError: Error | null;
  relayHealth: RelayHealth[];
};

const NdkContext = createContext<NdkContextValue | undefined>(undefined);

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nos.social",
  "wss://relay.primal.net",
];

const enqueueMicrotask = (cb: () => void) => {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(cb);
    return;
  }
  Promise.resolve()
    .then(cb)
    .catch(() => undefined);
};

export const NdkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ndk] = useState(() => new NDK({ explicitRelayUrls: DEFAULT_RELAYS }));
  const [signer, setSigner] = useState<NDKSigner | null>(null);
  const [user, setUser] = useState<NDKUser | null>(null);
  const [status, setStatus] = useState<NdkConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState<Error | null>(null);
  const [relayHealth, setRelayHealth] = useState<RelayHealth[]>(() =>
    DEFAULT_RELAYS.map(url => ({ url, status: "connecting" as const, lastError: null, lastEventAt: null }))
  );
  const pendingRelayUpdatesRef = useRef<Map<string, Partial<RelayHealth>> | null>(null);
  const relayUpdateScheduledRef = useRef(false);

  const ensureNdkConnection = useCallback(async () => {
    const attempt = ndk.connect();
    setStatus(prev => (prev === "connected" ? prev : "connecting"));
    setConnectionError(null);
    setRelayHealth(current =>
      current.map(relay => ({ ...relay, status: "connecting", lastError: relay.lastError, lastEventAt: relay.lastEventAt }))
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
      return;
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
  }, [ndk]);

  useEffect(() => {
    const pool = ndk.pool;
    if (!pool) return;

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
        const next = new Map<string, RelayHealth>();
        for (const relay of current) {
          next.set(relay.url, relay);
        }
        const baseRelays = ndk.explicitRelayUrls?.length ? ndk.explicitRelayUrls : DEFAULT_RELAYS;
        baseRelays.forEach(url => {
          const normalized = url.replace(/\/$/, "");
          if (!next.has(normalized)) {
            next.set(normalized, { url: normalized, status: "connecting", lastError: null, lastEventAt: null });
          }
        });
        pool.relays.forEach(relay => {
          const url = relay.url;
          const previous = next.get(url);
          next.set(url, {
            url,
            status: statusFromRelay(relay),
            lastError: previous?.lastError ?? null,
            lastEventAt: previous?.lastEventAt ?? null,
          });
        });
        return Array.from(next.values());
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
      if (typeof window === "undefined") {
        flushRelayUpdates();
        return;
      }
      if (relayUpdateScheduledRef.current) {
        return;
      }
      relayUpdateScheduledRef.current = true;
      enqueueMicrotask(flushRelayUpdates);
    };

    const updateRelay = (url: string, patch: Partial<RelayHealth>) => {
      let pending = pendingRelayUpdatesRef.current;
      if (!pending) {
        pending = new Map();
        pendingRelayUpdatesRef.current = pending;
      }
      const existing = pending.get(url);
      if (existing) {
        pending.set(url, { ...existing, ...patch });
      } else {
        pending.set(url, patch);
      }
      scheduleRelayUpdate();
    };

    primeKnownRelays();

    const handleConnecting = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "connecting", lastEventAt: Date.now() });
    };

    const handleConnect = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "connected", lastError: null, lastEventAt: Date.now() });
    };

    const handleReady = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "connected", lastError: null, lastEventAt: Date.now() });
    };

    const handleDisconnect = (relay: NDKRelay) => {
      updateRelay(relay.url, { status: "error", lastError: "Disconnected", lastEventAt: Date.now() });
    };

    const handleNotice = (relay: NDKRelay, message?: string) => {
      updateRelay(relay.url, { status: "error", lastError: message ?? "Relay notice", lastEventAt: Date.now() });
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
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    const connectIfActive = () => {
      if (cancelled) return;
      ensureNdkConnection().catch(() => undefined);
    };

    const win = window as typeof window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof win.requestIdleCallback === "function") {
      const idleHandle = win.requestIdleCallback(() => connectIfActive());
      return () => {
        cancelled = true;
        win.cancelIdleCallback?.(idleHandle);
      };
    }

    const timeoutHandle = window.setTimeout(connectIfActive, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
    };
  }, [ensureNdkConnection]);

  const connect = useCallback(async () => {
    if (!(window as any).nostr) {
      const error = new Error("A NIP-07 signer is required (e.g. Alby, nos2x).");
      setConnectionError(error);
      setStatus("error");
      throw error;
    }
    try {
      await ensureNdkConnection();
      const nip07Signer = new NDKNip07Signer();
      await nip07Signer.blockUntilReady();
      const nip07User = await nip07Signer.user();
      setSigner(nip07Signer);
      setUser(nip07User);
      ndk.signer = nip07Signer;
      setStatus("connected");
      setConnectionError(null);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Failed to connect Nostr signer");
      setConnectionError(normalized);
      setStatus("error");
      throw normalized;
    }
  }, [ensureNdkConnection, ndk]);

  const disconnect = useCallback(() => {
    setSigner(null);
    setUser(null);
    ndk.signer = undefined;
    setStatus("idle");
    setConnectionError(null);
  }, [ndk]);

  const signEventTemplate = useCallback<
    NdkContextValue["signEventTemplate"]
  >(async template => {
    if (!signer || !ndk) throw new Error("Connect a signer first.");
    const event = new NDKEvent(ndk, template);
    if (!event.created_at) {
      event.created_at = Math.floor(Date.now() / 1000);
    }
    await event.sign();
    return event.rawEvent();
  }, [signer, ndk]);

  const value = useMemo<NdkContextValue>(
    () => ({ ndk, signer, user, connect, disconnect, signEventTemplate, status, connectionError, relayHealth }),
    [ndk, signer, user, connect, disconnect, signEventTemplate, status, connectionError, relayHealth]
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
