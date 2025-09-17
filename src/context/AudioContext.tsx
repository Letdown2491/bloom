import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

type Track = {
  url: string;
  title?: string;
  artist?: string;
};

type AudioContextValue = {
  current?: Track;
  play: (track: Track) => void;
  stop: () => void;
};

const AudioCtx = createContext<AudioContextValue | undefined>(undefined);

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Track | undefined>();

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.controls = false;
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  const play = useCallback<AudioContextValue["play"]>((track) => {
    const audio = ensureAudio();
    setCurrent(track);
    audio.src = track.url;
    audio.play().catch(() => undefined);
  }, [ensureAudio]);

  const stop = useCallback(() => {
    const audio = ensureAudio();
    audio.pause();
    setCurrent(undefined);
  }, [ensureAudio]);

  const value = useMemo<AudioContextValue>(() => ({ current, play, stop }), [current, play, stop]);

  return <AudioCtx.Provider value={value}>{children}</AudioCtx.Provider>;
};

export const useAudio = () => {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error("useAudio must be used inside AudioProvider");
  return ctx;
};
