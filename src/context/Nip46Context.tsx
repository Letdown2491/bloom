import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createDefaultCodecConfig,
  createNip46Codec,
  LocalStorageAdapter,
  MemoryStorageAdapter,
  Nip46Codec,
  Nip46Service,
  SessionManager,
  SessionSnapshot,
  TransportConfig,
  createNdkTransport,
  Nip46DelegatedSigner,
} from "../lib/nip46";
import { useNdk } from "./NdkContext";

export interface Nip46ContextValue {
  codec: Nip46Codec;
  sessionManager: SessionManager;
  service: Nip46Service;
  snapshot: SessionSnapshot;
  ready: boolean;
}

const defaultSnapshot: SessionSnapshot = {
  sessions: [],
  activeSessionId: null,
};

const Nip46Context = createContext<Nip46ContextValue | undefined>(undefined);

export const Nip46Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ndk, adoptSigner } = useNdk();

  const [sessionManager] = useState(() => {
    const storage = typeof window === "undefined" ? new MemoryStorageAdapter() : new LocalStorageAdapter();
    return new SessionManager(storage);
  });
  const codec = useMemo(() => createNip46Codec(createDefaultCodecConfig()), []);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(defaultSnapshot);
  const [ready, setReady] = useState(false);

  const missingTransport = useMemo<TransportConfig>(
    () => ({
      publish: async () => {
        throw new Error("NIP-46 transport is not configured");
      },
      subscribe: () => () => undefined,
    }),
    []
  );

  const [service, setService] = useState(() => new Nip46Service({ codec, sessionManager, transport: missingTransport }));
  const fetchTrackerRef = useRef(new Map<string, number>());
  const activeSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ndk) return;
    const nextService = new Nip46Service({
      codec,
      sessionManager,
      transport: createNdkTransport(ndk),
    });

    setService(prev => {
      void prev.destroy().catch(() => undefined);
      return nextService;
    });

    return () => {
      void nextService.destroy().catch(() => undefined);
    };
  }, [codec, ndk, sessionManager]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    sessionManager
      .hydrate()
      .then(hydratedSnapshot => {
        setSnapshot(hydratedSnapshot);
        setReady(true);
        unsubscribe = sessionManager.onChange(setSnapshot);
      })
      .catch(error => {
        console.error("Failed to hydrate NIP-46 sessions", error);
        setReady(true);
        unsubscribe = sessionManager.onChange(setSnapshot);
      });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [sessionManager]);

  useEffect(() => {
    if (!ready) return;
    snapshot.sessions.forEach(session => {
      if (
        session.status !== "active" ||
        !session.remoteSignerPubkey ||
        session.userPubkey ||
        session.lastError
      ) {
        return;
      }
      const tracker = fetchTrackerRef.current;
      const lastProcessed = tracker.get(session.id);
      if (lastProcessed && lastProcessed >= session.updatedAt) return;
      tracker.set(session.id, session.updatedAt);
      void service.fetchUserPublicKey(session.id);
    });
  }, [snapshot, ready, service]);

  useEffect(() => {
    if (!ndk || !ready) return;

    const candidate = snapshot.sessions.find(
      session => session.status === "active" && session.userPubkey && !session.lastError
    );

    const current = activeSessionRef.current;

    if (!candidate) {
      if (current) {
        activeSessionRef.current = null;
        void adoptSigner(null);
      }
      return;
    }

    if (candidate.id === current) return;

    const signer = new Nip46DelegatedSigner(ndk, service, sessionManager, candidate.id);
    activeSessionRef.current = candidate.id;
    void adoptSigner(signer).catch(error => {
      console.error("Failed to adopt NIP-46 signer", error);
    });
  }, [adoptSigner, ndk, ready, service, sessionManager, snapshot.sessions]);

  const value = useMemo<Nip46ContextValue>(
    () => ({
      codec,
      sessionManager,
      service,
      snapshot,
      ready,
    }),
    [codec, sessionManager, service, snapshot, ready]
  );

  return <Nip46Context.Provider value={value}>{children}</Nip46Context.Provider>;
};

export const useNip46 = (): Nip46ContextValue => {
  const ctx = useContext(Nip46Context);
  if (!ctx) {
    throw new Error("useNip46 must be used within a Nip46Provider");
  }
  return ctx;
};
