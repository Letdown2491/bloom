import type NDK from "@nostr-dev-kit/ndk";
import type { NDKRelay, NDKFilter, NDKSubscription, NDKRelayStatus } from "@nostr-dev-kit/ndk";
import { loadNdkModule, type NdkModule } from "../../ndkModule";
import type { RelayPreparationOptions, RelayPreparationResult } from "../../ndkRelayManager";

import type { NostrFilter, TransportConfig } from "./types";
import { sanitizeRelayUrl } from "../../../utils/relays";

const RELAY_CONNECT_TIMEOUT_MS = 5_000;
const relayWarningTimestamps = new Map<string, number>();
const RELAY_WARNING_INTERVAL_MS = 60_000;
const RELAY_CACHE_TTL_MS = 30_000;
const relaySetCache = new Map<string, { result: RelayPreparationResult; expiresAt: number }>();
const relayWarningKey = (url: string) => sanitizeRelayUrl(url) ?? url.trim();
const clearRelayWarning = (url: string) => {
  const key = relayWarningKey(url);
  if (!key) return;
  relayWarningTimestamps.delete(key);
};
const getRuntime = (() => {
  let promise: Promise<NdkModule> | null = null;
  return () => {
    if (!promise) promise = loadNdkModule();
    return promise;
  };
})();

const isConnectedStatus = (status: NDKRelayStatus, runtime: NdkModule) => {
  const { NDKRelayStatus } = runtime;
  return (
    status === NDKRelayStatus.CONNECTED ||
    status === NDKRelayStatus.AUTH_REQUESTED ||
    status === NDKRelayStatus.AUTHENTICATING ||
    status === NDKRelayStatus.AUTHENTICATED
  );
};

const logRelayWarning = (url: string) => {
  const key = relayWarningKey(url);
  if (!key) return;
  const now = Date.now();
  const previous = relayWarningTimestamps.get(key);
  if (previous && now - previous < RELAY_WARNING_INTERVAL_MS) return;
  relayWarningTimestamps.set(key, now);
  console.debug?.("Relay not connected yet for NIP-46 publish", key);
};

const waitForRelayConnection = async (
  relay: NDKRelay,
  ndk: NDK,
  timeoutMs = RELAY_CONNECT_TIMEOUT_MS
): Promise<boolean> => {
  const runtime = await getRuntime();

  // Ensure relay is in pool before doing anything else
  if (ndk.pool && !ndk.pool.relays.has(relay.url)) {
    ndk.pool.addRelay(relay, false);
    // Give NDK a tick to properly register the relay in its internal structures
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  if (isConnectedStatus(relay.status as NDKRelayStatus, runtime)) {
    return true;
  }

  let resolved = false;

  const connectionEstablished = await new Promise<boolean>(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      relay.off("ready", onReady);
      relay.off("connect", onReady);
      relay.off("disconnect", onDisconnect);
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    const onReady = () => finish(true);
    const onDisconnect = () => finish(false);
    timer = setTimeout(() => finish(relay.status === runtime.NDKRelayStatus.CONNECTED), timeoutMs);

    relay.once("ready", onReady);
    relay.once("connect", onReady);
    relay.once("disconnect", onDisconnect);

    relay.connect().catch(() => finish(false));
  });

  if (connectionEstablished) {
    clearRelayWarning(relay.url);
    return true;
  }

  return isConnectedStatus(relay.status as NDKRelayStatus, runtime);
};

const convertFilter = (filter: NostrFilter): NDKFilter => {
  const { relays: _ignoredRelays, ...rest } = filter;
  return { ...rest } as NDKFilter;
};

type RelayHelpers = {
  prepareRelaySet?: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions
  ) => Promise<RelayPreparationResult>;
};

export const createNdkTransport = (ndk: NDK, helpers?: RelayHelpers): TransportConfig => {
  const canonicalRelayKey = (urls: readonly string[]) =>
    urls
      .map(url => sanitizeRelayUrl(url)?.replace(/\/+$/, ""))
      .filter((url): url is string => Boolean(url))
      .sort()
      .join(",");

  const cacheRelayResult = (urls: readonly string[], result: RelayPreparationResult) => {
    if (!urls.length) return;
    const key = canonicalRelayKey(urls);
    if (!key) return;
    if (relaySetCache.size > 64) {
      const oldestKey = Array.from(relaySetCache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]?.[0];
      if (oldestKey) {
        relaySetCache.delete(oldestKey);
      }
    }
    relaySetCache.set(key, {
      result,
      expiresAt: Date.now() + RELAY_CACHE_TTL_MS,
    });
  };

  const getCachedRelayResult = (urls: readonly string[]): RelayPreparationResult | null => {
    if (!urls.length) return null;
    const key = canonicalRelayKey(urls);
    if (!key) return null;
    const cached = relaySetCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      relaySetCache.delete(key);
      return null;
    }
    return cached.result;
  };

  return {
    publish: async event => {
      const runtime = await getRuntime();
      if (!event.id || !event.sig) {
        throw new Error("NIP-46 event must be signed before publishing");
      }

      const relayUrls = event.relays ?? [];
      const ndkEvent = new runtime.NDKEvent(ndk, event);
      let effectiveRelaySet: InstanceType<NdkModule["NDKRelaySet"]> | undefined;
      if (relayUrls.length) {
        if (helpers?.prepareRelaySet) {
          const cached = getCachedRelayResult(relayUrls);
          const preparation =
            cached ??
            (await helpers.prepareRelaySet(relayUrls, {
              waitForConnection: true,
            }));
          if (!cached) {
            cacheRelayResult(relayUrls, preparation);
          }
          const { relaySet, pending, connected } = preparation;
          connected.forEach(clearRelayWarning);
          if (pending.length) {
            pending.forEach(logRelayWarning);
          }
          effectiveRelaySet = relaySet ?? undefined;
        } else {
          const relaySet = runtime.NDKRelaySet.fromRelayUrls(relayUrls, ndk);
          const relays = Array.from(relaySet.relays);

          if (relays.length) {
            await Promise.all(relays.map(relay => waitForRelayConnection(relay, ndk)));
          }

          const pendingRelays = relays
            .filter(relay => relay.status !== runtime.NDKRelayStatus.CONNECTED)
            .map(relay => relay.url);
          if (pendingRelays.length) {
            pendingRelays.forEach(logRelayWarning);
          }

          effectiveRelaySet = relaySet;
        }
      }

      try {
        await ndkEvent.publish(effectiveRelaySet);
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "Failed to publish NIP-46 request event"
        );
      }
    },
    subscribe: (filters, handler) => {
      if (!filters.length) {
        return () => undefined;
      }
      const runtimePromise = getRuntime();
      const ndkFilters = filters
        .map(convertFilter)
        .filter(filter => Object.keys(filter).length > 0);
      if (!ndkFilters.length) {
        return () => undefined;
      }
      const relayUrls = Array.from(
        new Set(
          filters
            .flatMap(filter => filter.relays ?? [])
            .map(url => url.replace(/\/*$/, ""))
            .filter(url => url.length > 0)
        )
      );
      if (relayUrls.length && helpers?.prepareRelaySet) {
        const cached = getCachedRelayResult(relayUrls);
        const promise = cached
          ? Promise.resolve(cached)
          : helpers.prepareRelaySet(relayUrls, { waitForConnection: true }).then(result => {
              cacheRelayResult(relayUrls, result);
              return result;
            });
        void promise
          .then(result => {
            result.connected.forEach(clearRelayWarning);
            if (result.pending.length) {
              result.pending.forEach(logRelayWarning);
            }
          })
          .catch(() => undefined);
      }
      const options = relayUrls.length
        ? { closeOnEose: false, relayUrls }
        : { closeOnEose: false };
      const subscription = ndk.subscribe(ndkFilters, options, {
        onEvent: async ndkEvent => {
          await runtimePromise;
          const raw = ndkEvent.rawEvent();
          handler(raw);
        },
      }) as NDKSubscription;
      return () => {
        subscription.removeAllListeners();
        subscription.stop();
      };
    },
  };
};
