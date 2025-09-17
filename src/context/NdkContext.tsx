import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import NDK, { NDKEvent, NDKNip07Signer, NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";
import type { EventTemplate, SignedEvent } from "../lib/blossomClient";

export type NdkContextValue = {
  ndk: NDK | null;
  signer: NDKSigner | null;
  user: NDKUser | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signEventTemplate: (template: EventTemplate) => Promise<SignedEvent>;
};

const NdkContext = createContext<NdkContextValue | undefined>(undefined);

const DEFAULT_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export const NdkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ndk] = useState(() => new NDK({ explicitRelayUrls: DEFAULT_RELAYS }));
  const [signer, setSigner] = useState<NDKSigner | null>(null);
  const [user, setUser] = useState<NDKUser | null>(null);

  useEffect(() => {
    ndk.connect().catch(() => undefined);
  }, [ndk]);

  const connect = useCallback(async () => {
    if (!(window as any).nostr) {
      throw new Error("A NIP-07 signer is required (e.g. Alby, nos2x).");
    }
    const nip07Signer = new NDKNip07Signer();
    await nip07Signer.blockUntilReady();
    const nip07User = await nip07Signer.user();
    setSigner(nip07Signer);
    setUser(nip07User);
    ndk.signer = nip07Signer;
  }, [ndk]);

  const disconnect = useCallback(() => {
    setSigner(null);
    setUser(null);
    ndk.signer = undefined;
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

  const value = useMemo<NdkContextValue>(() => ({ ndk, signer, user, connect, disconnect, signEventTemplate }), [ndk, signer, user, connect, disconnect, signEventTemplate]);

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
