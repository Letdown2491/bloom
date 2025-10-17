import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNdk } from "./NdkContext";
import {
  loadPrivateList,
  mergePrivateEntries,
  publishPrivateList,
  type PrivateListEntry,
} from "../../shared/domain/privateList";

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
  const { ndk, signer, user } = useNdk();
  const [entries, setEntries] = useState<PrivateListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const entriesRef = useRef<PrivateListEntry[]>([]);

  const reset = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const refresh = useCallback(async () => {
    if (!ndk || !signer || !user) {
      reset();
      return;
    }
    setLoading(true);
    try {
      const list = await loadPrivateList(ndk, signer, user);
      entriesRef.current = list;
      setEntries(list);
      setError(null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to load private files");
      setError(error);
    } finally {
      setLoading(false);
    }
  }, [ndk, reset, signer, user]);

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
      await publishPrivateList(ndk, signer, user, merged);
      entriesRef.current = merged;
      setEntries(merged);
    },
    [ndk, signer, user]
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
      const targets = Array.from(new Set(shas.filter(sha => typeof sha === "string" && sha.length > 0)));
      if (!targets.length) return;
      if (!ndk || !signer || !user) {
        throw new Error("Connect your Nostr signer to update private files.");
      }
      const targetSet = new Set(targets);
      const next = entriesRef.current.filter(entry => !targetSet.has(entry.sha256));
      if (next.length === entriesRef.current.length) return;
      await publishPrivateList(ndk, signer, user, next);
      entriesRef.current = next;
      setEntries(next);
    },
    [ndk, signer, user]
  );

  const value = useMemo<PrivateLibraryContextValue>(
    () => ({ entries, entriesBySha, loading, error, refresh, upsertEntries, removeEntries }),
    [entries, entriesBySha, loading, error, refresh, upsertEntries, removeEntries]
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
