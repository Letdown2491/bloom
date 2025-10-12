import type NDK from "@nostr-dev-kit/ndk";
import type { NDKRelay, NDKFilter, NDKSubscription, NDKRelayStatus } from "@nostr-dev-kit/ndk";
import { loadNdkModule, type NdkModule } from "../../ndkModule";

import type { NostrFilter, TransportConfig } from "./types";

const RELAY_WARNING_THROTTLE_MS = 10_000;
const relayWarningTimestamps = new Map<string, number>();
const RELAY_CONNECT_TIMEOUT_MS = 5_000;
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
  const now = Date.now();
  const previous = relayWarningTimestamps.get(url) ?? 0;
  if (now - previous < RELAY_WARNING_THROTTLE_MS) return;
  relayWarningTimestamps.set(url, now);
  console.warn("Relay not connected yet for NIP-46 publish", url);
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
    return true;
  }

  return isConnectedStatus(relay.status as NDKRelayStatus, runtime);
};

const convertFilter = (filter: NostrFilter): NDKFilter => {
  const { relays: _ignoredRelays, ...rest } = filter;
  return { ...rest } as NDKFilter;
};

export const createNdkTransport = (ndk: NDK): TransportConfig => {
  return {
    publish: async event => {
      const runtime = await getRuntime();
      if (!event.id || !event.sig) {
        throw new Error("NIP-46 event must be signed before publishing");
      }

      const relayUrls = event.relays ?? [];
      const ndkEvent = new runtime.NDKEvent(ndk, event);
      let relaySet: InstanceType<NdkModule["NDKRelaySet"]> | undefined;
      let effectiveRelaySet: InstanceType<NdkModule["NDKRelaySet"]> | undefined;
      if (relayUrls.length) {
        relaySet = runtime.NDKRelaySet.fromRelayUrls(relayUrls, ndk);
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
