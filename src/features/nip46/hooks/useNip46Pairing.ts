import { useCallback, useEffect, useRef } from "react";
import { useNip46 } from "../../../app/context/Nip46Context";
import type {
  CreateSessionFromUriOptions,
  CreatedSessionResult,
  CreateInvitationOptions,
  Nip46Invitation,
} from "../../../shared/api/nip46";

const SERVICE_WAIT_TIMEOUT_MS = 5000;
const SERVICE_WAIT_INTERVAL_MS = 150;

export const useNip46Pairing = () => {
  const { service, ready, transportReady } = useNip46();
  const stateRef = useRef({ service, ready, transportReady });

  useEffect(() => {
    stateRef.current = { service, ready, transportReady };
  }, [service, ready, transportReady]);

  const ensureServiceReady = useCallback(async () => {
    const start = Date.now();
    while (Date.now() - start < SERVICE_WAIT_TIMEOUT_MS) {
      const snapshot = stateRef.current;
      if (snapshot.service && snapshot.ready && snapshot.transportReady) {
        return snapshot.service;
      }
      await new Promise(resolve => setTimeout(resolve, SERVICE_WAIT_INTERVAL_MS));
    }
    const finalSnapshot = stateRef.current;
    if (finalSnapshot.service && finalSnapshot.ready && finalSnapshot.transportReady) {
      return finalSnapshot.service;
    }
    throw new Error("Remote signer service is not available yet. Please try again in a moment.");
  }, []);

  const pairWithUri = useCallback(
    async (uri: string, options?: CreateSessionFromUriOptions): Promise<CreatedSessionResult> => {
      const nip46Service = await ensureServiceReady();
      return nip46Service.pairWithUri(uri, options);
    },
    [ensureServiceReady],
  );

  const createInvitation = useCallback(
    async (options?: CreateInvitationOptions): Promise<Nip46Invitation> => {
      const nip46Service = await ensureServiceReady();
      return nip46Service.createInvitation(options);
    },
    [ensureServiceReady],
  );

  return {
    pairWithUri,
    createInvitation,
  };
};
