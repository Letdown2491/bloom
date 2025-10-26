import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNdk } from "./NdkContext";
import {
  loadPrivateList,
  mergePrivateEntries,
  publishPrivateList,
  type PrivateListEntry,
} from "../../shared/domain/privateList";
import { collectRelayTargets, DEFAULT_PUBLIC_RELAYS } from "../../shared/utils/relays";

type PrivateLibraryContextValue = {
  entries: PrivateListEntry[];
  entriesBySha: Map<string, PrivateListEntry>;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  upsertEntries: (updates: PrivateListEntry[]) => Promise<void>;
  removeEntries: (shas: string[]) => Promise<void>;
};

const PrivateLibraryContext = createContext<PrivateLibraryContextValue | undefined>(undefined);

export const PrivateLibraryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ndk, signer, user, prepareRelaySet } = useNdk();
  const [entries, setEntries] = useState<PrivateListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const entriesRef = useRef<PrivateListEntry[]>([]);

  const reset = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const resolveRelayTargets = useCallback(() => {
    if (!ndk) return [] as string[];
    const base =
      ndk.explicitRelayUrls && ndk.explicitRelayUrls.length > 0 ? ndk.explicitRelayUrls : undefined;
    return collectRelayTargets(base, DEFAULT_PUBLIC_RELAYS);
  }, [ndk]);

  const refresh = useCallback(async () => {
    if (!ndk || !signer || !user) {
      reset();
      return;
    }
    setLoading(true);
    try {
      const relayTargets = resolveRelayTargets();
      let relaySet = undefined;
      if (relayTargets.length > 0) {
        try {
          const preparation = await prepareRelaySet(relayTargets, {
            waitForConnection: false,
            timeoutMs: 2000,
          });
          relaySet = preparation.relaySet ?? undefined;
        } catch (prepError) {
          console.warn("Failed to prepare relays for private list load", prepError);
        }
      }
      const list = await loadPrivateList(ndk, signer, user, { relaySet });
      entriesRef.current = list;
      setEntries(list);
      setError(null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to load private files");
      setError(error);
    } finally {
      setLoading(false);
    }
  }, [ndk, prepareRelaySet, reset, resolveRelayTargets, signer, user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsertEntries = useCallback(
    async (updates: PrivateListEntry[]) => {
      if (!ndk || !signer || !user) {
        throw new Error("Connect your Nostr signer to update private files.");
      }
      if (!updates.length) return;
      const merged = mergePrivateEntries(entriesRef.current, updates);
      const relayTargets = resolveRelayTargets();
      let relaySet = undefined;
      if (relayTargets.length > 0) {
        try {
          const preparation = await prepareRelaySet(relayTargets, { waitForConnection: true });
          relaySet = preparation.relaySet ?? undefined;
        } catch (prepError) {
          console.warn("Failed to prepare relays for private list publish", prepError);
        }
      }
      await publishPrivateList(ndk, signer, user, merged, { relaySet });
      entriesRef.current = merged;
      setEntries(merged);
    },
    [ndk, prepareRelaySet, resolveRelayTargets, signer, user],
  );

  const entriesBySha = useMemo(() => {
    const map = new Map<string, PrivateListEntry>();
    entries.forEach(entry => {
      map.set(entry.sha256, entry);
    });
    return map;
  }, [entries]);

  const removeEntries = useCallback(
    async (shas: string[]) => {
      const targets = Array.from(
        new Set(shas.filter(sha => typeof sha === "string" && sha.length > 0)),
      );
      if (!targets.length) return;
      if (!ndk || !signer || !user) {
        throw new Error("Connect your Nostr signer to update private files.");
      }
      const targetSet = new Set(targets);
      const next = entriesRef.current.filter(entry => !targetSet.has(entry.sha256));
      if (next.length === entriesRef.current.length) return;
      const relayTargets = resolveRelayTargets();
      let relaySet = undefined;
      if (relayTargets.length > 0) {
        try {
          const preparation = await prepareRelaySet(relayTargets, { waitForConnection: true });
          relaySet = preparation.relaySet ?? undefined;
        } catch (prepError) {
          console.warn("Failed to prepare relays for private list removal", prepError);
        }
      }
      await publishPrivateList(ndk, signer, user, next, { relaySet });
      entriesRef.current = next;
      setEntries(next);
    },
    [ndk, prepareRelaySet, resolveRelayTargets, signer, user],
  );

  const value = useMemo<PrivateLibraryContextValue>(
    () => ({ entries, entriesBySha, loading, error, refresh, upsertEntries, removeEntries }),
    [entries, entriesBySha, loading, error, refresh, upsertEntries, removeEntries],
  );

  return <PrivateLibraryContext.Provider value={value}>{children}</PrivateLibraryContext.Provider>;
};

export const usePrivateLibrary = () => {
  const context = useContext(PrivateLibraryContext);
  if (!context) {
    throw new Error("usePrivateLibrary must be used within a PrivateLibraryProvider");
  }
  return context;
};
