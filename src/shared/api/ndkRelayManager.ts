import type NDK from "@nostr-dev-kit/ndk";
import type { NDKRelay, NDKRelayStatus } from "@nostr-dev-kit/ndk";

import type { NdkModule } from "./ndkModule";
import { sanitizeRelayUrl } from "../utils/relays";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const MIN_RETRY_INTERVAL_MS = 5_000;

type RelayStatus = "idle" | "connecting" | "connected" | "error";

type RelayState = {
  status: RelayStatus;
  promise: Promise<boolean> | null;
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
};

const isConnectedStatus = (status: NDKRelayStatus, runtime: NdkModule) => {
  const { NDKRelayStatus } = runtime;
  return (
    status === NDKRelayStatus.CONNECTED ||
    status === NDKRelayStatus.AUTH_REQUESTED ||
    status === NDKRelayStatus.AUTHENTICATING ||
    status === NDKRelayStatus.AUTHENTICATED
  );
};

const normalizeRelayKey = (url: string | undefined | null): string | null => {
  if (!url) return null;
  const normalized = sanitizeRelayUrl(url);
  return normalized;
};

export type RelayPreparationOptions = {
  waitForConnection?: boolean;
  timeoutMs?: number;
};

export type RelayPreparationResult = {
  relaySet: InstanceType<NdkModule["NDKRelaySet"]> | null;
  connected: string[];
  pending: string[];
};

export interface RelayConnectionManager {
  prepareRelaySet: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions,
  ) => Promise<RelayPreparationResult>;
  ensureRelays: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions,
  ) => Promise<RelayPreparationResult>;
  getCachedRelaySet: (
    relayUrls: readonly string[],
  ) => InstanceType<NdkModule["NDKRelaySet"]> | null;
  handlePoolEvent: (relay: NDKRelay, status: RelayStatus) => void;
}

export const createRelayConnectionManager = (
  ndk: NDK,
  getRuntime: () => Promise<NdkModule>,
): RelayConnectionManager => {
  const stateMap = new Map<string, RelayState>();
  const relaySetCache = new Map<string, InstanceType<NdkModule["NDKRelaySet"]>>();

  const getState = (url: string): RelayState => {
    const current = stateMap.get(url);
    if (current) return current;
    const fresh: RelayState = {
      status: "idle",
      promise: null,
      lastAttemptAt: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    stateMap.set(url, fresh);
    return fresh;
  };

  const setState = (url: string, next: RelayState) => {
    stateMap.set(url, next);
  };

  const connectRelay = async (
    relay: NDKRelay,
    runtime: NdkModule,
    options?: RelayPreparationOptions,
  ): Promise<boolean> => {
    const normalizedUrl = normalizeRelayKey(relay.url);
    if (!normalizedUrl) return false;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const state = getState(normalizedUrl);

    if (isConnectedStatus(relay.status as NDKRelayStatus, runtime)) {
      setState(normalizedUrl, {
        ...state,
        status: "connected",
        promise: null,
        lastSuccessAt: Date.now(),
      });
      return true;
    }

    if (state.promise) {
      return options?.waitForConnection === false ? false : state.promise;
    }

    const now = Date.now();
    if (now - state.lastAttemptAt < MIN_RETRY_INTERVAL_MS) {
      return false;
    }

    const attempt = new Promise<boolean>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        relay.off("ready", onReady);
        relay.off("connect", onReady);
        relay.off("disconnect", onDisconnect);
        const nextState = getState(normalizedUrl);
        nextState.promise = null;
        nextState.status = value ? "connected" : "error";
        nextState.lastAttemptAt = now;
        if (value) {
          nextState.lastSuccessAt = Date.now();
        } else {
          nextState.lastFailureAt = Date.now();
        }
        setState(normalizedUrl, nextState);
        resolve(value);
      };
      const onReady = () => finish(true);
      const onDisconnect = () => finish(false);
      timer = setTimeout(
        () => finish(isConnectedStatus(relay.status as NDKRelayStatus, runtime)),
        timeoutMs,
      );
      relay.once("ready", onReady);
      relay.once("connect", onReady);
      relay.once("disconnect", onDisconnect);
      try {
        const result = relay.connect();
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch(() => finish(false));
        }
      } catch (_error) {
        finish(false);
      }
    });

    setState(normalizedUrl, {
      ...state,
      promise: attempt,
      status: "connecting",
      lastAttemptAt: now,
    });

    return options?.waitForConnection === false ? false : attempt;
  };

  const ensureRelay = async (
    url: string,
    runtime: NdkModule,
    options?: RelayPreparationOptions,
  ): Promise<boolean> => {
    const pool = ndk.pool;
    if (!pool) return false;
    let relay = pool.relays.get(url);
    if (!relay) {
      try {
        const added = ndk.addExplicitRelay(url, undefined, true);
        if (added) {
          relay = added;
        }
      } catch (_error) {
        relay = pool.relays.get(url);
      }
    }
    if (!relay) return false;
    return connectRelay(relay, runtime, options);
  };

  const prepare = async (
    inputUrls: readonly string[],
    options?: RelayPreparationOptions,
  ): Promise<RelayPreparationResult> => {
    if (!Array.isArray(inputUrls) || inputUrls.length === 0) {
      return { relaySet: null, connected: [], pending: [] };
    }
    const sanitized = inputUrls.map(normalizeRelayKey).filter((url): url is string => Boolean(url));
    if (!sanitized.length) {
      return { relaySet: null, connected: [], pending: [] };
    }

    const unique = Array.from(new Set(sanitized));
    const runtime = await getRuntime();

    const results = await Promise.all(
      unique.map(async url => {
        const connected = await ensureRelay(url, runtime, options);
        return { url, connected };
      }),
    );

    const connected = results.filter(result => result.connected).map(result => result.url);
    const pending = results.filter(result => !result.connected).map(result => result.url);

    if (!unique.length) {
      return { relaySet: null, connected, pending };
    }

    const key = unique.slice().sort().join(",");
    let relaySet = relaySetCache.get(key) ?? null;
    if (!relaySet) {
      relaySet = runtime.NDKRelaySet.fromRelayUrls(unique, ndk);
      relaySetCache.set(key, relaySet);
    }

    return { relaySet, connected, pending };
  };

  const handlePoolEvent = (relay: NDKRelay, status: RelayStatus) => {
    const normalizedUrl = normalizeRelayKey(relay.url);
    if (!normalizedUrl) return;
    const current = getState(normalizedUrl);
    const now = Date.now();
    if (status === "connected") {
      setState(normalizedUrl, {
        ...current,
        status,
        promise: null,
        lastSuccessAt: now,
      });
      return;
    }
    if (status === "connecting") {
      setState(normalizedUrl, {
        ...current,
        status,
        lastAttemptAt: now,
      });
      return;
    }
    setState(normalizedUrl, {
      ...current,
      status,
      promise: null,
      lastFailureAt: now,
    });
  };

  return {
    prepareRelaySet: prepare,
    ensureRelays: prepare,
    getCachedRelaySet: relayUrls => {
      if (!Array.isArray(relayUrls) || !relayUrls.length) return null;
      const sanitized = relayUrls
        .map(normalizeRelayKey)
        .filter((url): url is string => Boolean(url));
      if (!sanitized.length) return null;
      const key = sanitized.slice().sort().join(",");
      return relaySetCache.get(key) ?? null;
    },
    handlePoolEvent,
  };
};
