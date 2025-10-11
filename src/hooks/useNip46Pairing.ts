import { useCallback } from "react";
import { useNip46 } from "../context/Nip46Context";
import type {
  CreateSessionFromUriOptions,
  CreatedSessionResult,
  CreateInvitationOptions,
  Nip46Invitation,
} from "../lib/nip46";

export const useNip46Pairing = () => {
  const { service, ready, transportReady } = useNip46();

  const pairWithUri = useCallback(
    async (uri: string, options?: CreateSessionFromUriOptions): Promise<CreatedSessionResult> => {
      if (!service || !ready || !transportReady) {
        throw new Error("Remote signer service is not available yet. Please try again in a moment.");
      }
      return service.pairWithUri(uri, options);
    },
    [ready, service, transportReady]
  );

  const createInvitation = useCallback(
    async (options?: CreateInvitationOptions): Promise<Nip46Invitation> => {
      if (!service || !ready || !transportReady) {
        throw new Error("Remote signer service is not available yet. Please try again in a moment.");
      }
      return service.createInvitation(options);
    },
    [ready, service, transportReady]
  );

  return {
    pairWithUri,
    createInvitation,
  };
};
