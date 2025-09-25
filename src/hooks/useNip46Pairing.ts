import { useCallback } from "react";
import { useNip46 } from "../context/Nip46Context";
import { CreateSessionFromUriOptions, CreatedSessionResult } from "../lib/nip46";

export const useNip46Pairing = () => {
  const { service } = useNip46();

  const pairWithUri = useCallback(
    async (uri: string, options?: CreateSessionFromUriOptions): Promise<CreatedSessionResult> => {
      return service.pairWithUri(uri, options);
    },
    [service]
  );

  return {
    pairWithUri,
  };
};
