import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import NDK, { NDKEvent, NDKNip07Signer, NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";
import type { EventTemplate, SignedEvent } from "../lib/blossomClient";

export type NdkConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type NdkContextValue = {
  ndk: NDK | null;
  signer: NDKSigner | null;
  user: NDKUser | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signEventTemplate: (template: EventTemplate) => Promise<SignedEvent>;
  status: NdkConnectionStatus;
  connectionError: Error | null;
};

const NdkContext = createContext<NdkContextValue | undefined>(undefined);

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.nos.social",
  "wss://relay.primal.net",
];

export const NdkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ndk] = useState(() => new NDK({ explicitRelayUrls: DEFAULT_RELAYS }));
  const [signer, setSigner] = useState<NDKSigner | null>(null);
  const [user, setUser] = useState<NDKUser | null>(null);
  const [status, setStatus] = useState<NdkConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState<Error | null>(null);

  const ensureNdkConnection = useCallback(async () => {
    const attempt = ndk.connect();
    setStatus(prev => (prev === "connected" ? prev : "connecting"));
    setConnectionError(null);

    attempt
      .then(() => {
        setStatus("connected");
        return undefined;
      })
      .catch(error => {
        const normalized = error instanceof Error ? error : new Error("Failed to connect to relays");
        setConnectionError(normalized);
        setStatus("error");
        return undefined;
      });

    if (typeof window === "undefined") {
      await attempt.catch(() => undefined);
      return;
    }

    let timeoutHandle: number | null = null;
    const settleOrTimeout = Promise.race([
      attempt.catch(() => undefined),
      new Promise(resolve => {
        timeoutHandle = window.setTimeout(() => {
          timeoutHandle = null;
          resolve(undefined);
        }, 2000);
      }),
    ]);

    try {
      await settleOrTimeout;
    } finally {
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
    }
  }, [ndk]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    const connectIfActive = () => {
      if (cancelled) return;
      ensureNdkConnection().catch(() => undefined);
    };

    const win = window as typeof window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof win.requestIdleCallback === "function") {
      const idleHandle = win.requestIdleCallback(() => connectIfActive());
      return () => {
        cancelled = true;
        win.cancelIdleCallback?.(idleHandle);
      };
    }

    const timeoutHandle = window.setTimeout(connectIfActive, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
    };
  }, [ensureNdkConnection]);

  const connect = useCallback(async () => {
    if (!(window as any).nostr) {
      const error = new Error("A NIP-07 signer is required (e.g. Alby, nos2x).");
      setConnectionError(error);
      setStatus("error");
      throw error;
    }
    try {
      await ensureNdkConnection();
      const nip07Signer = new NDKNip07Signer();
      await nip07Signer.blockUntilReady();
      const nip07User = await nip07Signer.user();
      setSigner(nip07Signer);
      setUser(nip07User);
      ndk.signer = nip07Signer;
      setStatus("connected");
      setConnectionError(null);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Failed to connect Nostr signer");
      setConnectionError(normalized);
      setStatus("error");
      throw normalized;
    }
  }, [ensureNdkConnection, ndk]);

  const disconnect = useCallback(() => {
    setSigner(null);
    setUser(null);
    ndk.signer = undefined;
    setStatus("idle");
    setConnectionError(null);
  }, [ndk]);

  const signEventTemplate = useCallback<
    NdkContextValue["signEventTemplate"]
  >(async template => {
    if (!signer || !ndk) throw new Error("Connect a signer first.");
    const event = new NDKEvent(ndk, template);
    if (!event.created_at) {
      event.created_at = Math.floor(Date.now() / 1000);
    }
    await event.sign();
    return event.rawEvent();
  }, [signer, ndk]);

  const value = useMemo<NdkContextValue>(
    () => ({ ndk, signer, user, connect, disconnect, signEventTemplate, status, connectionError }),
    [ndk, signer, user, connect, disconnect, signEventTemplate, status, connectionError]
  );

  return <NdkContext.Provider value={value}>{children}</NdkContext.Provider>;
};

export const useNdk = () => {
  const ctx = useContext(NdkContext);
  if (!ctx) throw new Error("useNdk must be used within NdkProvider");
  return ctx;
};

export const useCurrentPubkey = () => {
  const { user } = useNdk();
  return user?.pubkey || null;
};
