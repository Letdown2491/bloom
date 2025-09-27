import type NDK from "@nostr-dev-kit/ndk";
import {
  NDKEvent,
  NDKRelaySet,
  NDKRelayStatus,
  type NDKFilter,
  NDKRelay,
} from "@nostr-dev-kit/ndk";

import type { NostrFilter, TransportConfig } from "./types";

const RELAY_WARNING_THROTTLE_MS = 10_000;
const relayWarningTimestamps = new Map<string, number>();
const RELAY_CONNECT_TIMEOUT_MS = 5_000;
const CONNECTED_STATUSES = new Set<NDKRelayStatus>([
  NDKRelayStatus.CONNECTED,
  NDKRelayStatus.AUTH_REQUESTED,
  NDKRelayStatus.AUTHENTICATING,
  NDKRelayStatus.AUTHENTICATED,
]);

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
  if (ndk.pool && !ndk.pool.relays.has(relay.url)) {
    ndk.pool.addRelay(relay, false);
  }

  if (CONNECTED_STATUSES.has(relay.status as NDKRelayStatus)) {
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
    timer = setTimeout(() => finish(relay.status === NDKRelayStatus.CONNECTED), timeoutMs);

    relay.once("ready", onReady);
    relay.once("connect", onReady);
    relay.once("disconnect", onDisconnect);

    relay.connect().catch(() => finish(false));
  });

  if (connectionEstablished) {
    return true;
  }

  return CONNECTED_STATUSES.has(relay.status as NDKRelayStatus);
};

const convertFilter = (filter: NostrFilter): NDKFilter => {
  const converted: NDKFilter = {};
  if (filter.kinds) converted.kinds = filter.kinds;
  if (filter.authors) converted.authors = filter.authors;
  if (filter["#p"]) converted["#p"] = filter["#p"];
  if (filter.since !== undefined) converted.since = filter.since;
  if (filter.limit !== undefined) converted.limit = filter.limit;
  return converted;
};

export const createNdkTransport = (ndk: NDK): TransportConfig => {
  return {
    publish: async event => {
      if (!event.id || !event.sig) {
        throw new Error("NIP-46 event must be signed before publishing");
      }

      const relayUrls = event.relays ?? [];
      const ndkEvent = new NDKEvent(ndk, event);
      let relaySet: NDKRelaySet | undefined;
      let effectiveRelaySet: NDKRelaySet | undefined;
      if (relayUrls.length) {
        relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk);
        const relays = Array.from(relaySet.relays);

        if (relays.length) {
          await Promise.all(relays.map(relay => waitForRelayConnection(relay, ndk)));
        }

        const pendingRelays = relays
          .filter(relay => relay.status !== NDKRelayStatus.CONNECTED)
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
      const ndkFilters = filters.map(convertFilter);
      const subscription = ndk.subscribe(ndkFilters, { closeOnEose: false }, {
        onEvent: (ndkEvent: NDKEvent) => {
          const raw = ndkEvent.rawEvent();
          console.debug("NIP-46 raw event", raw);
          handler(raw);
        },
      });
      return () => {
        subscription.removeAllListeners();
        subscription.stop();
      };
    },
  };
};
