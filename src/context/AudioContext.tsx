import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type Track = {
  id?: string;
  url: string;
  title?: string;
  artist?: string;
};

type AudioStatus = "idle" | "playing" | "paused";
type RepeatMode = "all" | "track";

type AudioContextValue = {
  current?: Track;
  status: AudioStatus;
  queue: Track[];
  repeatMode: RepeatMode;
  hasNext: boolean;
  hasPrevious: boolean;
  currentTime: number;
  duration: number;
  play: (track: Track, queue?: Track[]) => void;
  pause: () => void;
  toggle: (track: Track, queue?: Track[]) => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  toggleRepeatMode: () => void;
  seek: (time: number) => void;
  getFrequencyData: () => Uint8Array | null;
  visualizerAvailable: boolean;
};

const AudioCtx = createContext<AudioContextValue | undefined>(undefined);

const getTrackSortKey = (track: Track) => (track.title?.trim().toLowerCase() || track.url.toLowerCase());

const normalizeQueue = (tracks: Track[]): Track[] => {
  const map = new Map<string, Track>();
  tracks.forEach(track => {
    if (!track?.url) return;
    if (!map.has(track.url)) {
      map.set(track.url, track);
    }
  });
  const list = Array.from(map.values());
  list.sort((a, b) => getTrackSortKey(a).localeCompare(getTrackSortKey(b)));
  return list;
};

const prepareQueue = (tracks: Track[], focus: Track): { queue: Track[]; index: number } => {
  const source = tracks.length ? tracks : focus.url ? [focus] : [];
  const queue = normalizeQueue(focus.url ? [...source, focus] : source);
  const index = focus.url ? queue.findIndex(item => item.url === focus.url) : -1;
  return { queue, index };
};

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Track | undefined>();
  const [status, setStatus] = useState<AudioStatus>("idle");
  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("all");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array | null>(null);
  const graphConnectedRef = useRef(false);
  const visualizerEnabledRef = useRef(true);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.controls = false;
      audio.crossOrigin = "anonymous";
      audio.preload = "metadata";
      audioRef.current = audio;
    }
    if (audioRef.current) {
      audioRef.current.crossOrigin = "anonymous";
    }
    return audioRef.current;
  }, []);

  const ensureAudioGraph = useCallback(() => {
    if (!visualizerEnabledRef.current) return;
    if (typeof window === "undefined") return;
    const audio = ensureAudio();
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    let audioCtx = audioContextRef.current;
    if (!audioCtx) {
      audioCtx = new AudioContextCtor();
      audioContextRef.current = audioCtx;
    }

    if (!mediaSourceRef.current) {
      try {
        mediaSourceRef.current = audioCtx.createMediaElementSource(audio);
      } catch (error) {
        console.warn("Visualizer disabled: media source unavailable", error);
        visualizerEnabledRef.current = false;
        analyserRef.current = null;
        analyserDataRef.current = null;
        graphConnectedRef.current = false;
        try {
          audioContextRef.current?.close();
        } catch {
          // ignore close errors
        }
        audioContextRef.current = null;
        return;
      }
    }

    if (!analyserRef.current) {
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;
      analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      graphConnectedRef.current = false;
    }

    if (!graphConnectedRef.current && mediaSourceRef.current && analyserRef.current) {
      try {
        mediaSourceRef.current.disconnect();
      } catch {
        // ignore if already disconnected
      }
      mediaSourceRef.current.connect(analyserRef.current);
      try {
        analyserRef.current.connect(audioCtx.destination);
      } catch {
        // destination connection may already exist
      }
      graphConnectedRef.current = true;
    }
  }, [ensureAudio]);

  const playTrackAtIndex = useCallback(
    (queueToUse: Track[], indexToUse: number, updateQueueState: boolean) => {
      if (!queueToUse.length || indexToUse < 0 || indexToUse >= queueToUse.length) return;
      const target = queueToUse[indexToUse];
      if (!target || !target.url) return;
      const audio = ensureAudio();
      ensureAudioGraph();
      const audioCtx = audioContextRef.current;
      if (audioCtx?.state === "suspended") {
        audioCtx.resume().catch(() => undefined);
      }
      if (updateQueueState) {
        setQueue(queueToUse);
      }
      setCurrentIndex(indexToUse);
      setCurrent(target);
      setCurrentTime(0);
      setDuration(audio.duration || 0);
      if (audio.src !== target.url) {
        audio.src = target.url;
      }
      audio.play().catch(() => undefined);
      setStatus("playing");
    },
    [ensureAudio, ensureAudioGraph]
  );

  useEffect(() => {
    const audio = ensureAudio();

    const handlePlay = () => {
      setStatus("playing");
      if (visualizerEnabledRef.current) {
        const audioCtx = audioContextRef.current;
        if (audioCtx?.state === "suspended") {
          audioCtx.resume().catch(() => undefined);
        }
      }
    };

    const handlePause = () => {
      if (audio.ended) return;
      if (audio.currentTime > 0) setStatus("paused");
      else setStatus("idle");
      if (visualizerEnabledRef.current && audioContextRef.current?.state === "running") {
        audioContextRef.current.suspend().catch(() => undefined);
      }
    };

    const handleEnded = () => {
      if (repeatMode === "track") {
        audio.currentTime = 0;
        audio.play().catch(() => undefined);
        return;
      }
      if (!queue.length) {
        setCurrent(undefined);
        setCurrentIndex(null);
        setStatus("idle");
        setCurrentTime(0);
        setDuration(0);
        if (visualizerEnabledRef.current && audioContextRef.current?.state === "running") {
          audioContextRef.current.suspend().catch(() => undefined);
        }
        return;
      }
      const idx = currentIndex ?? -1;
      if (idx < 0) {
        setStatus("idle");
        setCurrent(undefined);
        setCurrentIndex(null);
        setCurrentTime(0);
        setDuration(0);
        if (visualizerEnabledRef.current && audioContextRef.current?.state === "running") {
          audioContextRef.current.suspend().catch(() => undefined);
        }
        return;
      }
      const nextIndex = idx + 1;
      if (nextIndex < queue.length) {
        playTrackAtIndex(queue, nextIndex, false);
      } else {
        playTrackAtIndex(queue, 0, false);
      }
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime || 0);
    };

    const handleDurationChange = () => {
      setDuration(Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0);
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("loadedmetadata", handleDurationChange);

    handleDurationChange();
    handleTimeUpdate();

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("loadedmetadata", handleDurationChange);
    };
  }, [ensureAudio, queue, currentIndex, repeatMode, playTrackAtIndex]);

  const play = useCallback(
    (track: Track, queueTracks?: Track[]) => {
      if (!track?.url) return;
      const queueSource = queueTracks?.length ? queueTracks : queue;
      const { queue: preparedQueue, index } = prepareQueue(queueSource, track);
      const targetIndex = index >= 0 ? index : 0;
      playTrackAtIndex(preparedQueue, targetIndex, true);
    },
    [queue, playTrackAtIndex]
  );

  const pause = useCallback(() => {
    const audio = ensureAudio();
    audio.pause();
    if (audio.currentTime > 0) setStatus("paused");
    else setStatus("idle");
    if (visualizerEnabledRef.current && audioContextRef.current?.state === "running") {
      audioContextRef.current.suspend().catch(() => undefined);
    }
  }, [ensureAudio]);

  const toggle = useCallback(
    (track: Track, queueTracks?: Track[]) => {
      if (!track?.url) return;
      const queueSource = queueTracks?.length ? queueTracks : queue;
      const { queue: preparedQueue, index } = prepareQueue(queueSource, track);
      const targetIndex = index >= 0 ? index : 0;
      const isSameTrack = current?.url === track.url;

      if (isSameTrack) {
        setQueue(preparedQueue);
        if (index >= 0) {
          setCurrentIndex(index);
        }
        if (status === "playing") {
          pause();
          return;
        }
        playTrackAtIndex(preparedQueue, targetIndex, false);
        return;
      }

      playTrackAtIndex(preparedQueue, targetIndex, true);
    },
    [queue, current?.url, status, pause, playTrackAtIndex]
  );

  const next = useCallback(() => {
    if (!queue.length || currentIndex === null) return;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) return;
    playTrackAtIndex(queue, nextIndex, false);
  }, [queue, currentIndex, playTrackAtIndex]);

  const previous = useCallback(() => {
    if (!queue.length || currentIndex === null) return;
    const prevIndex = currentIndex - 1;
    if (prevIndex < 0) return;
    playTrackAtIndex(queue, prevIndex, false);
  }, [queue, currentIndex, playTrackAtIndex]);

  const stop = useCallback(() => {
    const audio = ensureAudio();
    audio.pause();
    audio.currentTime = 0;
    audio.src = "";
    setStatus("idle");
    setCurrent(undefined);
    setCurrentIndex(null);
    setCurrentTime(0);
    setDuration(0);
    if (visualizerEnabledRef.current) {
      const audioCtx = audioContextRef.current;
      if (audioCtx?.state === "running") {
        audioCtx.suspend().catch(() => undefined);
      }
    }
  }, [ensureAudio]);

  const toggleRepeatMode = useCallback(() => {
    setRepeatMode(prev => (prev === "track" ? "all" : "track"));
  }, []);

  const seek = useCallback(
    (time: number) => {
      const audio = ensureAudio();
      const safeDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      const clamped = Math.max(0, Math.min(isFinite(safeDuration) && safeDuration > 0 ? safeDuration : Number.MAX_SAFE_INTEGER, time));
      audio.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [ensureAudio, duration]
  );

  const getFrequencyData = useCallback(() => {
    if (!visualizerEnabledRef.current) return null;
    const analyser = analyserRef.current;
    if (!analyser) return null;
    let data = analyserDataRef.current;
    if (!data || data.length !== analyser.frequencyBinCount) {
      data = new Uint8Array(analyser.frequencyBinCount);
      analyserDataRef.current = data;
    }
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    buffer.set(data);
    analyser.getByteFrequencyData(buffer);
    analyserDataRef.current = buffer;
    return buffer;
  }, []);

  const hasNext = currentIndex !== null && currentIndex < queue.length - 1;
  const hasPrevious = currentIndex !== null && currentIndex > 0;

  const visualizerAvailable = visualizerEnabledRef.current && Boolean(analyserRef.current);

  const value = useMemo<AudioContextValue>(
    () => ({
      current,
      status,
      queue,
      repeatMode,
      hasNext,
      hasPrevious,
      currentTime,
      duration,
      play,
      pause,
      toggle,
      stop,
      next,
      previous,
      toggleRepeatMode,
      seek,
      getFrequencyData,
      visualizerAvailable,
    }),
    [
      current,
      status,
      queue,
      repeatMode,
      hasNext,
      hasPrevious,
      currentTime,
      duration,
      play,
      pause,
      toggle,
      stop,
      next,
      previous,
      toggleRepeatMode,
      seek,
      getFrequencyData,
      visualizerAvailable,
    ]
  );

  return <AudioCtx.Provider value={value}>{children}</AudioCtx.Provider>;
};

export const useAudio = () => {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error("useAudio must be used inside AudioProvider");
  return ctx;
};
