import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  Nip46Codec,
  Nip46Service,
  SessionManager,
  SessionSnapshot,
  TransportConfig,
} from "../lib/nip46";
import { useNdk } from "./NdkContext";

export interface Nip46ContextValue {
  codec: Nip46Codec | null;
  sessionManager: SessionManager | null;
  service: Nip46Service | null;
  snapshot: SessionSnapshot;
  ready: boolean;
}

const defaultSnapshot: SessionSnapshot = {
  sessions: [],
  activeSessionId: null,
};

const Nip46Context = createContext<Nip46ContextValue | undefined>(undefined);

type Nip46Module = typeof import("../lib/nip46");

let nip46ModuleLoader: Promise<Nip46Module> | null = null;

const loadNip46Module = async (): Promise<Nip46Module> => {
  if (!nip46ModuleLoader) {
    nip46ModuleLoader = import("../lib/nip46");
  }
  return nip46ModuleLoader;
};

export const Nip46Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ndk, adoptSigner } = useNdk();

  const moduleRef = useRef<Nip46Module | null>(null);
  const [codec, setCodec] = useState<Nip46Codec | null>(null);
  const [sessionManager, setSessionManager] = useState<SessionManager | null>(null);
  const [service, setService] = useState<Nip46Service | null>(null);
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

  const fetchTrackerRef = useRef(new Map<string, number>());
  const activeSessionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadNip46Module()
      .then(mod => {
        if (cancelled) return;
        moduleRef.current = mod;
        const storage = typeof window === "undefined" ? new mod.MemoryStorageAdapter() : new mod.LocalStorageAdapter();
        const manager = new mod.SessionManager(storage);
        const codecInstance = mod.createNip46Codec(mod.createDefaultCodecConfig());
        setSessionManager(manager);
        setCodec(codecInstance);
        setService(new mod.Nip46Service({ codec: codecInstance, sessionManager: manager, transport: missingTransport }));
      })
      .catch(error => {
        console.error("Failed to load NIP-46 module", error);
      });
    return () => {
      cancelled = true;
    };
  }, [missingTransport]);

  useEffect(() => {
    if (!sessionManager) return;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    sessionManager
      .hydrate()
      .then(hydratedSnapshot => {
        if (disposed) return;
        setSnapshot(hydratedSnapshot);
        setReady(true);
        unsubscribe = sessionManager.onChange(setSnapshot);
      })
      .catch(error => {
        if (disposed) return;
        console.error("Failed to hydrate NIP-46 sessions", error);
        setReady(true);
        unsubscribe = sessionManager.onChange(setSnapshot);
      });

    return () => {
      disposed = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [sessionManager]);

  useEffect(() => {
    const mod = moduleRef.current;
    if (!mod || !ndk || !sessionManager || !codec) return;
    const nextService = new mod.Nip46Service({
      codec,
      sessionManager,
      transport: mod.createNdkTransport(ndk),
    });

    setService(prev => {
      void prev?.destroy().catch(() => undefined);
      return nextService;
    });

    return () => {
      void nextService.destroy().catch(() => undefined);
    };
  }, [codec, ndk, sessionManager]);

  useEffect(() => {
    if (!ready || !service) return;
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
    const mod = moduleRef.current;
    if (!mod || !ndk || !ready || !service || !sessionManager) return;

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

    const signer = new mod.Nip46DelegatedSigner(ndk, service, sessionManager, candidate.id);
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
