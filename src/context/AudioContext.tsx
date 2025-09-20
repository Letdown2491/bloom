import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type Track = {
  url: string;
  title?: string;
  artist?: string;
};

type AudioStatus = "idle" | "playing" | "paused";

type AudioContextValue = {
  current?: Track;
  status: AudioStatus;
  play: (track: Track) => void;
  pause: () => void;
  toggle: (track: Track) => void;
  stop: () => void;
};

const AudioCtx = createContext<AudioContextValue | undefined>(undefined);

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Track | undefined>();
  const [status, setStatus] = useState<AudioStatus>("idle");

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.controls = false;
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    const audio = ensureAudio();

    const handlePlay = () => {
      setStatus("playing");
    };

    const handlePause = () => {
      if (audio.ended) return;
      if (audio.currentTime > 0) setStatus("paused");
      else setStatus("idle");
    };

    const handleEnded = () => {
      setStatus("idle");
      setCurrent(undefined);
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [ensureAudio]);

  const play = useCallback<AudioContextValue["play"]>(
    track => {
      const audio = ensureAudio();
      const isSame = current?.url === track.url;
      setCurrent(track);
      if (!isSame) {
        audio.src = track.url;
      }
      audio.play().catch(() => undefined);
      setStatus("playing");
    },
    [ensureAudio, current]
  );

  const pause = useCallback(() => {
    const audio = ensureAudio();
    audio.pause();
    if (audio.currentTime > 0) setStatus("paused");
  }, [ensureAudio]);

  const toggle = useCallback<AudioContextValue["toggle"]>(
    track => {
      const audio = ensureAudio();
      const isSame = current?.url === track.url;
      if (isSame) {
        if (status === "playing") {
          audio.pause();
          setStatus(audio.currentTime > 0 ? "paused" : "idle");
          return;
        }
        if (status === "paused") {
          audio.play().catch(() => undefined);
          setStatus("playing");
          return;
        }
      }

      setCurrent(track);
      if (!isSame) {
        audio.src = track.url;
      }
      audio.play().catch(() => undefined);
      setStatus("playing");
    },
    [ensureAudio, current, status]
  );

  const stop = useCallback(() => {
    const audio = ensureAudio();
    audio.pause();
    audio.currentTime = 0;
    setCurrent(undefined);
    setStatus("idle");
  }, [ensureAudio]);

  const value = useMemo<AudioContextValue>(
    () => ({ current, status, play, pause, toggle, stop }),
    [current, status, play, pause, toggle, stop]
  );

  return <AudioCtx.Provider value={value}>{children}</AudioCtx.Provider>;
};

export const useAudio = () => {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error("useAudio must be used inside AudioProvider");
  return ctx;
};
