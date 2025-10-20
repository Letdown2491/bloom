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

  const resetPipeline = useCallback(() => {
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
    setStage("settings");
    setStatusMessage(SETTINGS_MESSAGE);
    setStatusTone("syncing");
  }, [isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) return;
    if (stage !== "settings") return;
    if (!preferencesReady) return;
    setSettingsReady(true);
    setAllowServerFetch(true);
    setStage("server");
    setStatusMessage(SERVER_MESSAGE);
    setStatusTone("syncing");
  }, [isSignedIn, preferencesReady, stage]);

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
    ]
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
