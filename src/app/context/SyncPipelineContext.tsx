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
import { useUserPreferences } from "./UserPreferencesContext";

type SyncPipelineStage = "idle" | "settings" | "server" | "relays" | "complete";

type SyncPipelineContextValue = {
  stage: SyncPipelineStage;
  statusMessage: string | null;
  statusTone: "syncing" | "info" | "success" | "warning" | "error";
  settingsReady: boolean;
  serverReady: boolean;
  relaysReady: boolean;
  allowServerFetch: boolean;
  allowRelayRefresh: boolean;
  markServerStageComplete: () => void;
  markRelayStageComplete: () => void;
};

const SyncPipelineContext = createContext<SyncPipelineContextValue | undefined>(undefined);

const SETTINGS_MESSAGE = "Syncing settings…";
const SERVER_MESSAGE = "Syncing files…";
const RELAY_MESSAGE = "Syncing folders…";
const SETTINGS_TIMEOUT_MESSAGE =
  "Settings are taking longer than expected. Loading files with your last saved preferences.";
const SERVER_TIMEOUT_MESSAGE =
  "Files are still syncing in the background. Some updates may appear shortly.";
const RELAY_TIMEOUT_MESSAGE =
  "Folders are still syncing in the background. Recently shared items may be missing.";

const SETTINGS_TIMEOUT_MS = 12_000;
const SERVER_TIMEOUT_MS = 20_000;
const RELAY_TIMEOUT_MS = 20_000;

const clearTimeoutRef = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
};

export const SyncPipelineProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, status } = useNdk();
  const { preferencesReady } = useUserPreferences();

  const isSignedIn = Boolean(user?.pubkey) && status === "connected";

  const [stage, setStage] = useState<SyncPipelineStage>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<SyncPipelineContextValue["statusTone"]>("syncing");
  const [settingsReady, setSettingsReady] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [relaysReady, setRelaysReady] = useState(false);
  const [allowServerFetch, setAllowServerFetch] = useState(false);
  const [allowRelayRefresh, setAllowRelayRefresh] = useState(false);

  const hasStartedRef = useRef(false);
  const settingsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetPipeline = useCallback(() => {
    clearTimeoutRef(settingsTimeoutRef);
    clearTimeoutRef(serverTimeoutRef);
    clearTimeoutRef(relayTimeoutRef);
    setStage("idle");
    setStatusMessage(null);
    setStatusTone("syncing");
    setSettingsReady(false);
    setServerReady(false);
    setRelaysReady(false);
    setAllowServerFetch(false);
    setAllowRelayRefresh(false);
    hasStartedRef.current = false;
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      resetPipeline();
    }
  }, [isSignedIn, resetPipeline]);

  useEffect(() => {
    if (!isSignedIn) return;
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    setStage("server");
    setStatusMessage(SETTINGS_MESSAGE);
    setStatusTone("syncing");
    setAllowServerFetch(true);
  }, [isSignedIn]);

  useEffect(() => {
    if (!isSignedIn || preferencesReady) {
      clearTimeoutRef(settingsTimeoutRef);
      return;
    }
    if (settingsTimeoutRef.current) return;
    settingsTimeoutRef.current = setTimeout(() => {
      settingsTimeoutRef.current = null;
      if (!isSignedIn || preferencesReady) return;
      setStatusTone("warning");
      setStatusMessage(SETTINGS_TIMEOUT_MESSAGE);
    }, SETTINGS_TIMEOUT_MS);
    return () => {
      clearTimeoutRef(settingsTimeoutRef);
    };
  }, [isSignedIn, preferencesReady]);

  useEffect(() => {
    if (!isSignedIn) return;
    if (!preferencesReady) return;
    setSettingsReady(true);
    setAllowServerFetch(true);
    clearTimeoutRef(settingsTimeoutRef);
    if (statusMessage === SETTINGS_MESSAGE || statusMessage === SETTINGS_TIMEOUT_MESSAGE) {
      setStatusTone("syncing");
      setStatusMessage(SERVER_MESSAGE);
    } else if (statusMessage === RELAY_TIMEOUT_MESSAGE && stage === "relays") {
      setStatusTone("syncing");
      setStatusMessage(RELAY_MESSAGE);
    }
  }, [isSignedIn, preferencesReady, stage, statusMessage]);

  const markServerStageComplete = useCallback(() => {
    setServerReady(true);
    setAllowRelayRefresh(true);
    setStage(prevStage => {
      if (prevStage !== "server") {
        return prevStage;
      }
      setStatusMessage(RELAY_MESSAGE);
      setStatusTone("syncing");
      return "relays";
    });
  }, []);

  const markRelayStageComplete = useCallback(() => {
    setRelaysReady(true);
    setStage(prevStage => {
      if (prevStage !== "relays") {
        return prevStage;
      }
      setStatusMessage(null);
      setStatusTone("syncing");
      return "complete";
    });
  }, []);

  useEffect(() => {
    if (!isSignedIn || stage !== "server" || serverReady) {
      clearTimeoutRef(serverTimeoutRef);
      return;
    }
    if (serverTimeoutRef.current) return;
    serverTimeoutRef.current = setTimeout(() => {
      serverTimeoutRef.current = null;
      if (!isSignedIn || serverReady || stage !== "server") return;
      markServerStageComplete();
      setStatusTone("warning");
      setStatusMessage(SERVER_TIMEOUT_MESSAGE);
    }, SERVER_TIMEOUT_MS);
    return () => {
      clearTimeoutRef(serverTimeoutRef);
    };
  }, [isSignedIn, markServerStageComplete, serverReady, stage]);

  useEffect(() => {
    if (!isSignedIn || stage !== "relays" || relaysReady) {
      clearTimeoutRef(relayTimeoutRef);
      return;
    }
    if (relayTimeoutRef.current) return;
    relayTimeoutRef.current = setTimeout(() => {
      relayTimeoutRef.current = null;
      if (!isSignedIn || relaysReady || stage !== "relays") return;
      markRelayStageComplete();
      setStatusTone("warning");
      setStatusMessage(RELAY_TIMEOUT_MESSAGE);
    }, RELAY_TIMEOUT_MS);
    return () => {
      clearTimeoutRef(relayTimeoutRef);
    };
  }, [isSignedIn, markRelayStageComplete, relaysReady, stage]);

  useEffect(() => {
    if (stage !== "complete") return;
    if (statusMessage !== SERVER_TIMEOUT_MESSAGE && statusMessage !== RELAY_TIMEOUT_MESSAGE) return;
    const timeout = setTimeout(() => {
      setStatusMessage(null);
      setStatusTone("info");
    }, 8_000);
    return () => {
      clearTimeout(timeout);
    };
  }, [stage, statusMessage]);

  useEffect(() => {
    return () => {
      clearTimeoutRef(settingsTimeoutRef);
      clearTimeoutRef(serverTimeoutRef);
      clearTimeoutRef(relayTimeoutRef);
    };
  }, []);

  const value = useMemo<SyncPipelineContextValue>(
    () => ({
      stage,
      statusMessage,
      statusTone,
      settingsReady,
      serverReady,
      relaysReady,
      allowServerFetch,
      allowRelayRefresh,
      markServerStageComplete,
      markRelayStageComplete,
    }),
    [
      stage,
      statusMessage,
      statusTone,
      settingsReady,
      serverReady,
      relaysReady,
      allowServerFetch,
      allowRelayRefresh,
      markServerStageComplete,
      markRelayStageComplete,
    ],
  );

  return <SyncPipelineContext.Provider value={value}>{children}</SyncPipelineContext.Provider>;
};

export const useSyncPipeline = () => {
  const ctx = useContext(SyncPipelineContext);
  if (!ctx) {
    throw new Error("useSyncPipeline must be used within a SyncPipelineProvider");
  }
  return ctx;
};
