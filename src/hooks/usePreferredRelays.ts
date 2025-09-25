import { useCallback, useEffect, useMemo, useState } from "react";
import type { NDKRelay } from "@nostr-dev-kit/ndk";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { DEFAULT_PUBLIC_RELAYS, extractPreferredRelays, normalizeRelayOrigin, sanitizeRelayUrl } from "../utils/relays";

export type RelayPolicy = {
  url: string;
  read: boolean;
  write: boolean;
};

const parseRelayPoliciesFromTags = (tags: string[][]): RelayPolicy[] => {
  const map = new Map<string, RelayPolicy>();
  tags.forEach(tag => {
    if (!tag || tag.length < 2) return;
    if (tag[0] !== "r") return;
    const rawUrl = sanitizeRelayUrl(tag[1]);
    if (!rawUrl) return;
    const markers = tag.slice(2).map(marker => marker.toLowerCase());
    let read = true;
    let write = true;
    if (markers.length > 0) {
      const hasRead = markers.includes("read");
      const hasWrite = markers.includes("write");
      read = hasRead || (!hasRead && !hasWrite);
      write = hasWrite || (!hasRead && !hasWrite);
    }
    const existing = map.get(rawUrl);
    if (existing) {
      existing.read = existing.read || read;
      existing.write = existing.write || write;
    } else {
      map.set(rawUrl, { url: rawUrl, read, write });
    }
  });
  return Array.from(map.values());
};

export const usePreferredRelays = () => {
  const { ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const [relayPolicies, setRelayPolicies] = useState<RelayPolicy[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRelayPolicies = useCallback(async (): Promise<RelayPolicy[]> => {
    if (!ndk || !pubkey) return [];

    try {
      const relayEvent = await ndk.fetchEvent({ kinds: [10002], authors: [pubkey] });
      let policies: RelayPolicy[] = relayEvent ? parseRelayPoliciesFromTags(relayEvent.tags) : [];

      if (policies.length === 0) {
        const metadataEvent = await ndk.fetchEvent({ kinds: [0], authors: [pubkey] });
        if (metadataEvent?.content) {
          try {
            const metadata = JSON.parse(metadataEvent.content);
            const extracted = extractPreferredRelays(metadata);
            policies = extracted.map(url => ({ url, read: true, write: true }));
          } catch (_error) {
            // Ignore metadata parse errors; fallback remains empty.
          }
        }
      }

      return policies;
    } catch (_error) {
      return [];
    }
  }, [ndk, pubkey]);

  const refresh = useCallback(async () => {
    if (!ndk || !pubkey) {
      setRelayPolicies([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const policies = await fetchRelayPolicies();
    setRelayPolicies(policies);
    setLoading(false);
  }, [fetchRelayPolicies, ndk, pubkey]);

  useEffect(() => {
    let cancelled = false;
    if (!ndk || !pubkey) {
      setRelayPolicies([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchRelayPolicies()
      .then(policies => {
        if (!cancelled) setRelayPolicies(policies);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRelayPolicies, ndk, pubkey]);

  useEffect(() => {
    if (!ndk) return;
    const urls = relayPolicies.map(policy => policy.url);
    if (urls.length > 0) {
      ndk.explicitRelayUrls = urls;
    } else {
      ndk.explicitRelayUrls = Array.from(DEFAULT_PUBLIC_RELAYS);
    }
  }, [ndk, relayPolicies]);

  const poolRelays = useMemo(() => {
    if (!ndk?.pool) return [] as string[];
    const urls = new Set<string>();
    ndk.pool.relays.forEach((relay: NDKRelay) => {
      const normalized = normalizeRelayOrigin(relay.url);
      if (normalized) urls.add(normalized);
    });
    return Array.from(urls);
  }, [ndk]);

  const preferredRelays = useMemo(() => {
    return relayPolicies
      .filter(policy => policy.read || policy.write)
      .map(policy => policy.url);
  }, [relayPolicies]);

  const effectiveRelays = useMemo(() => {
    if (preferredRelays.length > 0) return preferredRelays;
    if (poolRelays.length > 0) return poolRelays;
    return Array.from(DEFAULT_PUBLIC_RELAYS);
  }, [preferredRelays, poolRelays]);

  return {
    relayPolicies,
    preferredRelays,
    poolRelays,
    effectiveRelays,
    loading,
    refresh,
  };
};

export type PreferredRelayState = ReturnType<typeof usePreferredRelays>;
