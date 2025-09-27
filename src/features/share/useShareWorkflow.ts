import { useCallback, useState } from "react";
import type { ShareCompletion, SharePayload } from "../../components/ShareComposer";

export const useShareWorkflow = () => {
  const [shareState, setShareState] = useState<{ payload: SharePayload | null; shareKey: string | null }>(() => ({
    payload: null,
    shareKey: null,
  }));

  const openShareForPayload = useCallback((payload: SharePayload) => {
    setShareState({ payload, shareKey: null });
  }, []);

  const openShareByKey = useCallback((shareKey: string) => {
    setShareState({ payload: null, shareKey });
  }, []);

  const clearShareState = useCallback(() => {
    setShareState({ payload: null, shareKey: null });
  }, []);

  const handleShareComplete = useCallback(
    (result: ShareCompletion) => {
      const isDm = result.mode === "dm" || result.mode === "dm-private";
      if (!isDm) {
        if (result.success) {
          clearShareState();
        }
        return null;
      }
      const info = result.recipient;
      let label = "recipient";
      if (info) {
        if (info.displayName) label = info.displayName;
        else if (info.username) label = `@${info.username}`;
        else if (info.nip05) label = info.nip05;
        else if (info.npub) label = info.npub.length > 12 ? `${info.npub.slice(0, 6)}…${info.npub.slice(-4)}` : info.npub;
      }
      if (result.success) {
        clearShareState();
      }
      return label;
    },
    [clearShareState]
  );

  return {
    shareState,
    setShareState,
    openShareForPayload,
    openShareByKey,
    clearShareState,
    handleShareComplete,
  };
};
