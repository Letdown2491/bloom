import type { NDKEvent as NdkEvent } from "@nostr-dev-kit/ndk";
import type { NdkContextValue } from "../context/NdkContext";
import { parseNip94Event, type Nip94ParsedEvent } from "./nip94";
import { loadNdkModule } from "./ndkModule";

type NdkInstance = NdkContextValue["ndk"];

const sanitizeHashes = (hashes: readonly string[]) =>
  Array.from(
    new Set(
      hashes
        .map(hash => (typeof hash === "string" ? hash.trim().toLowerCase() : ""))
        .filter(hash => hash.length === 64 && /^[0-9a-f]+$/.test(hash))
    )
  );

export const fetchNip94ByHashes = async (
  ndk: NdkInstance | null,
  hashes: readonly string[],
  relayUrls?: readonly string[],
  options?: { timeoutMs?: number }
): Promise<Map<string, Nip94ParsedEvent>> => {
  if (!ndk) return new Map();
  const targets = sanitizeHashes(hashes);
  if (!targets.length) return new Map();
  await ndk.connect().catch(() => undefined);
  const limit = Math.min(Math.max(targets.length * 2, 12), 200);
  const filters = [
    {
      kinds: [1063],
      "#x": targets,
      limit,
    },
    {
      kinds: [1063],
      "#ox": targets,
      limit,
    },
  ];
  let relaySet: InstanceType<Awaited<ReturnType<typeof loadNdkModule>>["NDKRelaySet"]> | undefined;
  if (relayUrls && relayUrls.length > 0) {
    try {
      const module = await loadNdkModule();
      relaySet = module.NDKRelaySet.fromRelayUrls(relayUrls, ndk);
    } catch (error) {
      console.warn("Unable to build relay set for NIP-94 lookup", error);
    }
  }
  const timeoutMs = options?.timeoutMs ?? 7000;
  let fetchTimedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let eventsSet: Set<NdkEvent> = new Set();
  try {
    const fetchPromise = ndk.fetchEvents(filters, { closeOnEose: true, groupable: false }, relaySet);
    if (timeoutMs > 0) {
      eventsSet = (await Promise.race([
        fetchPromise.finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
        }),
        new Promise<Set<NdkEvent>>(resolve => {
          timeoutHandle = setTimeout(() => {
            fetchTimedOut = true;
            timeoutHandle = null;
            resolve(new Set());
          }, timeoutMs);
        }),
      ])) as Set<NdkEvent>;
    } else {
      eventsSet = (await fetchPromise) as Set<NdkEvent>;
    }
  } catch (error) {
    console.warn("Unable to fetch NIP-94 metadata", error);
    eventsSet = new Set();
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
  if (fetchTimedOut) {
    console.warn(`Timeout fetching NIP-94 metadata after ${timeoutMs}ms`);
  }
  if (!eventsSet || eventsSet.size === 0) return new Map();
  const events = Array.from(eventsSet).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const map = new Map<string, Nip94ParsedEvent>();
  events.forEach(event => {
    const parsed = parseNip94Event(event);
    if (!parsed?.sha256) return;
    const key = parsed.sha256.toLowerCase();
    if (!map.has(key)) {
      map.set(key, parsed);
    }
  });
  return map;
};
