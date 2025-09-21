import { useEffect, useMemo, useState } from "react";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { DEFAULT_PUBLIC_RELAYS, extractPreferredRelays, normalizeRelayOrigin } from "../utils/relays";

export const usePreferredRelays = () => {
  const { ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const [preferredRelays, setPreferredRelays] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ndk || !pubkey) {
      setPreferredRelays([]);
      return;
    }
    let disposed = false;
    setLoading(true);
    ndk
      .fetchEvent({ kinds: [0], authors: [pubkey] })
      .then(evt => {
        if (disposed) return;
        if (!evt?.content) {
          setPreferredRelays([]);
          return;
        }
        try {
          const metadata = JSON.parse(evt.content);
          setPreferredRelays(extractPreferredRelays(metadata));
        } catch (_error) {
          setPreferredRelays([]);
        }
      })
      .catch(() => {
        if (!disposed) setPreferredRelays([]);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [ndk, pubkey]);

  const poolRelays = useMemo(() => {
    if (!ndk?.pool) return [] as string[];
    const urls = new Set<string>();
    ndk.pool.relays.forEach(relay => {
      const normalized = normalizeRelayOrigin(relay.url);
      if (normalized) urls.add(normalized);
    });
    return Array.from(urls);
  }, [ndk]);

  const effectiveRelays = useMemo(() => {
    if (preferredRelays.length > 0) return preferredRelays;
    if (poolRelays.length > 0) return poolRelays;
    return Array.from(DEFAULT_PUBLIC_RELAYS);
  }, [preferredRelays, poolRelays]);

  return {
    preferredRelays,
    poolRelays,
    effectiveRelays,
    loading,
  };
};

export type PreferredRelayState = ReturnType<typeof usePreferredRelays>;
