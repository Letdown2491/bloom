import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NDKEvent, NDKPublishError, NDKRelaySet } from "@nostr-dev-kit/ndk";
import { useNdk, useCurrentPubkey } from "./context/NdkContext";
import { useServers, ManagedServer, sortServersByName } from "./hooks/useServers";
import { useServerData } from "./hooks/useServerData";
import { BlobList } from "./components/BlobList";
import { ShareComposer, type SharePayload } from "./components/ShareComposer";
import type { TransferState } from "./components/UploadPanel";

const UploadPanelLazy = React.lazy(() =>
  import("./components/UploadPanel").then(module => ({ default: module.UploadPanel }))
);

const ServerListLazy = React.lazy(() =>
  import("./components/ServerList").then(module => ({ default: module.ServerList }))
);
import { useAudio, type Track as AudioTrack } from "./context/AudioContext";
import {
  deleteUserBlob,
  mirrorBlobToServer,
  buildAuthorizationHeader,
  uploadBlobToServer,
  type UploadStreamSource,
} from "./lib/blossomClient";
import { deleteNip96File, uploadBlobToNip96 } from "./lib/nip96Client";
import { deleteSatelliteFile, uploadBlobToSatellite } from "./lib/satelliteClient";
import { buildNip98AuthHeader } from "./lib/nip98";
import { useQueryClient } from "@tanstack/react-query";
import type { BlossomBlob } from "./lib/blossomClient";
import { prettyBytes } from "./utils/format";
import { deriveServerNameFromUrl } from "./utils/serverName";
import { usePreferredRelays } from "./hooks/usePreferredRelays";
import { useAliasSync } from "./hooks/useAliasSync";
import { buildNip94EventTemplate } from "./lib/nip94";
import {
  applyAliasUpdate,
  getStoredAudioMetadata,
  rememberAudioMetadata,
  type BlobAudioMetadata,
} from "./utils/blobMetadataStore";
import { EditDialog, type EditDialogAudioFields } from "./components/RenameDialog";
import {
  DocumentIcon,
  FilterIcon,
  GridIcon,
  HomeIcon,
  ImageIcon,
  ListIcon,
  MusicIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  RepeatIcon,
  RepeatOneIcon,
  StopIcon,
  TransferIcon,
  UploadIcon,
  VideoIcon,
} from "./components/icons";
import { AudioVisualizer } from "./components/AudioVisualizer";

type TabId = "browse" | "upload" | "servers" | "transfer" | "share";

type StatusMessageTone = "success" | "info" | "error";

type FilterMode = "all" | "music" | "documents" | "images" | "pdfs" | "videos";

type FilterOption = {
  id: Exclude<FilterMode, "all">;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
};

const NAV_TABS = [
  { id: "browse" as const, label: "Home", icon: HomeIcon },
  { id: "upload" as const, label: "Upload", icon: UploadIcon },
];

const FILTER_OPTIONS: FilterOption[] = [
  { id: "music", label: "Music", icon: MusicIcon },
  { id: "documents", label: "Documents", icon: DocumentIcon },
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "pdfs", label: "PDFs", icon: DocumentIcon },
  { id: "videos", label: "Videos", icon: VideoIcon },
];

const FILTER_OPTION_MAP = FILTER_OPTIONS.reduce(
  (acc, option) => {
    acc[option.id] = option;
    return acc;
  },
  {} as Record<Exclude<FilterMode, "all">, FilterOption>
);

const ALL_SERVERS_VALUE = "__all__";

const emptyAudioFields = (): EditDialogAudioFields => ({
  title: "",
  artist: "",
  album: "",
  trackNumber: "",
  trackTotal: "",
  durationSeconds: "",
  genre: "",
  year: "",
});

const computeMusicAlias = (titleInput: string, artistInput: string) => {
  const title = titleInput.trim();
  const artist = artistInput.trim();
  if (artist && title) return `${artist} - ${title}`;
  return title || artist;
};

const parseMusicAlias = (value?: string | null) => {
  if (!value) return { artist: "", title: "" };
  const trimmed = value.trim();
  if (!trimmed) return { artist: "", title: "" };
  const separatorIndex = trimmed.indexOf(" - ");
  if (separatorIndex === -1) return { artist: "", title: trimmed };
  const artist = trimmed.slice(0, separatorIndex).trim();
  const title = trimmed.slice(separatorIndex + 3).trim();
  return { artist, title: title || trimmed };
};

const parsePositiveIntegerString = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : undefined;
};

const normalizeManagedServer = (server: ManagedServer): ManagedServer => {
  const trimmedUrl = (server.url || "").trim();
  const normalizedUrl = trimmedUrl.replace(/\/$/, "");
  const derivedName = deriveServerNameFromUrl(normalizedUrl);
  const fallbackName = derivedName || normalizedUrl.replace(/^https?:\/\//, "");
  const name = (server.name || "").trim() || fallbackName;

  const requiresAuth = server.type === "satellite" ? true : Boolean(server.requiresAuth);
  return {
    ...server,
    url: normalizedUrl,
    name,
    requiresAuth,
    sync: Boolean(server.sync),
  };
};

const validateManagedServers = (servers: ManagedServer[]): string | null => {
  const seen = new Set<string>();
  for (const server of servers) {
    const trimmedUrl = (server.url || "").trim();
    if (!trimmedUrl) return "Enter a server URL for every entry.";
    if (!/^https?:\/\//i.test(trimmedUrl)) return "Server URLs must start with http:// or https://.";
    const normalizedUrl = trimmedUrl.replace(/\/$/, "").toLowerCase();
    if (seen.has(normalizedUrl)) return "Server URLs must be unique.";
    seen.add(normalizedUrl);
    const name = (server.name || "").trim();
    if (!name) return "Enter a server name for every entry.";
  }
  return null;
};

const MUSIC_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|oga|flac|aac|m4a|weba|webm|alac|aiff|aif|wma|mid|midi|amr|opus)(?:\?|#|$)/;

const ADDITIONAL_AUDIO_MIME_TYPES = new Set([
  "application/ogg",
  "application/x-ogg",
  "application/flac",
  "application/x-flac",
]);

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)(?:\?|#|$)/;
const VIDEO_EXTENSION_REGEX = /\.(mp4|mov|webm|mkv|avi|hevc|m4v|mpg|mpeg)(?:\?|#|$)/;
const PDF_EXTENSION_REGEX = /\.pdf(?:\?|#|$)/;

const ADDITIONAL_VIDEO_MIME_TYPES = new Set([
  "application/x-matroska",
  "video/x-matroska",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
]);

const normalizeMime = (value?: string) => value?.split(";")[0]?.trim().toLowerCase() ?? "";

const matchesExtension = (value: string | undefined, regex: RegExp) => {
  if (!value) return false;
  return regex.test(value.toLowerCase());
};

const isImageBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType.startsWith("image/")) return true;
  if (matchesExtension(blob.name, IMAGE_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, IMAGE_EXTENSION_REGEX)) return true;
  return false;
};

const isVideoBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType.startsWith("video/")) return true;
  if (ADDITIONAL_VIDEO_MIME_TYPES.has(rawType)) return true;
  if (matchesExtension(blob.name, VIDEO_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, VIDEO_EXTENSION_REGEX)) return true;
  return false;
};

const isPdfBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType === "application/pdf") return true;
  if (matchesExtension(blob.name, PDF_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, PDF_EXTENSION_REGEX)) return true;
  return false;
};

const isMusicBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType) {
    if (rawType.startsWith("audio/")) return true;
    if (ADDITIONAL_AUDIO_MIME_TYPES.has(rawType)) return true;
  }

  if (matchesExtension(blob.name, MUSIC_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, MUSIC_EXTENSION_REGEX)) return true;

  return false;
};

const matchesFilter = (blob: BlossomBlob, filter: FilterMode) => {
  switch (filter) {
    case "music":
      return isMusicBlob(blob);
    case "images":
      return isImageBlob(blob);
    case "videos":
      return isVideoBlob(blob);
    case "pdfs":
      return isPdfBlob(blob);
    case "documents":
      return !isMusicBlob(blob) && !isImageBlob(blob) && !isVideoBlob(blob) && !isPdfBlob(blob);
    case "all":
    default:
      return true;
  }
};

const deriveTrackTitle = (blob: BlossomBlob) => {
  const explicit = blob.name?.trim();
  if (explicit) return explicit;
  if (blob.url) {
    const segments = blob.url.split("/");
    const tail = segments[segments.length - 1];
    if (tail) {
      try {
        const decoded = decodeURIComponent(tail);
        if (decoded) return decoded;
      } catch {
        return tail;
      }
      return tail;
    }
  }
  return `${blob.sha256.slice(0, 12)}…`;
};

const buildAudioTrack = (blob: BlossomBlob): AudioTrack | null => {
  if (!blob.url) return null;
  return {
    id: blob.sha256,
    url: blob.url,
    title: deriveTrackTitle(blob),
  };
};

const formatTime = (value: number) => {
  const total = Math.max(0, Math.floor(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export default function App() {
  const { connect, disconnect, user, signer, signEventTemplate, ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const queryClient = useQueryClient();
  const { effectiveRelays } = usePreferredRelays();
  useAliasSync(effectiveRelays, Boolean(pubkey));

  const { servers, saveServers, saving } = useServers();
  const [localServers, setLocalServers] = useState<ManagedServer[]>(servers);
  const [selectedServer, setSelectedServer] = useState<string | null>(servers[0]?.url ?? null);
  const [tab, setTab] = useState<TabId>("browse");
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedBlobs, setSelectedBlobs] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusMessageTone, setStatusMessageTone] = useState<StatusMessageTone>("info");
  const statusMessageTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousViewModeRef = useRef<"grid" | "list">("list");
  const syncQueueRef = useRef<Set<string>>(new Set());
  const nextSyncAttemptRef = useRef<Map<string, number>>(new Map());
  const unsupportedMirrorTargetsRef = useRef<Set<string>>(new Set());
  const unauthorizedSyncTargetsRef = useRef<Set<string>>(new Set());
  const [syncTransfers, setSyncTransfers] = useState<TransferState[]>([]);
  const [syncStatus, setSyncStatus] = useState<{ state: "idle" | "syncing" | "synced" | "error"; progress: number }>({
    state: "idle",
    progress: 0,
  });
  const [manualTransfers, setManualTransfers] = useState<TransferState[]>([]);
  const [transferTargets, setTransferTargets] = useState<string[]>([]);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferFeedback, setTransferFeedback] = useState<string | null>(null);
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const mainWidgetRef = useRef<HTMLDivElement | null>(null);
  const [shareState, setShareState] = useState<{ payload: SharePayload | null; shareKey: string | null }>({
    payload: null,
    shareKey: null,
  });
  const [renameTarget, setRenameTarget] = useState<BlossomBlob | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameIsMusic, setRenameIsMusic] = useState(false);
  const [renameAudioFields, setRenameAudioFields] = useState<EditDialogAudioFields>(emptyAudioFields);

  const syncEnabledServers = useMemo(() => localServers.filter(server => server.sync), [localServers]);
  const serverValidationError = useMemo(() => validateManagedServers(localServers), [localServers]);
  const { snapshots, distribution, aggregated } = useServerData(localServers);
  const selectedBlobSources = useMemo(() => {
    const map = new Map<string, { blob: BlossomBlob; server: ManagedServer }>();
    snapshots.forEach(snapshot => {
      if (!snapshot.blobs.length) return;
      snapshot.blobs.forEach(blob => {
        if (!selectedBlobs.has(blob.sha256)) return;
        if (selectedServer) {
          if (snapshot.server.url === selectedServer && !map.has(blob.sha256)) {
            map.set(blob.sha256, { blob, server: snapshot.server });
          }
          return;
        }
        if (!map.has(blob.sha256)) {
          map.set(blob.sha256, { blob, server: snapshot.server });
        }
      });
    });
    return map;
  }, [snapshots, selectedBlobs, selectedServer]);
  const selectedBlobItems = useMemo(() => Array.from(selectedBlobSources.values()), [selectedBlobSources]);
  const selectedBlobTotalSize = useMemo(
    () => selectedBlobItems.reduce((total, item) => total + (item.blob.size || 0), 0),
    [selectedBlobItems]
  );
  const sourceServerUrls = useMemo(() => {
    const set = new Set<string>();
    selectedBlobItems.forEach(item => {
      set.add(item.server.url);
    });
    return set;
  }, [selectedBlobItems]);
  const missingSourceCount = useMemo(() => {
    if (selectedBlobs.size === selectedBlobSources.size) return 0;
    return selectedBlobs.size - selectedBlobSources.size;
  }, [selectedBlobs, selectedBlobSources]);
  const serverNameMap = useMemo(() => new Map(localServers.map(server => [server.url, server.name])), [localServers]);
  const transferFeedbackTone = useMemo(() => {
    if (!transferFeedback) return "text-slate-400";
    const normalized = transferFeedback.toLowerCase();
    if (normalized.includes("issue") || normalized.includes("try again")) return "text-amber-300";
    if (normalized.includes("failed") || normalized.includes("unable") || normalized.includes("error")) return "text-red-400";
    return "text-emerald-300";
  }, [transferFeedback]);
  const transferActivity = useMemo(() => manualTransfers.slice().reverse(), [manualTransfers]);
  const userInitials = useMemo(() => {
    const npub = user?.npub;
    if (!npub) return "??";
    return npub.slice(0, 2).toUpperCase();
  }, [user]);

  const toggleUserMenu = useCallback(() => {
    setIsUserMenuOpen(prev => !prev);
  }, [setIsUserMenuOpen]);

  const toggleFilterMenu = useCallback(() => {
    setIsFilterMenuOpen(prev => !prev);
  }, []);

  const handleSelectFilter = useCallback(
    (next: FilterMode) => {
      setFilterMode(prev => {
        const nextValue = prev === next ? "all" : next;
        if (nextValue === "music" && prev !== "music") {
          previousViewModeRef.current = viewMode;
          setViewMode("list");
        } else if (prev === "music" && nextValue !== "music") {
          setViewMode(previousViewModeRef.current);
        }
        return nextValue;
      });
      setIsFilterMenuOpen(false);
    },
    [setViewMode, viewMode]
  );

  const handleSelectServers = useCallback(() => {
    setTab("servers");
    setIsUserMenuOpen(false);
  }, [setIsUserMenuOpen, setTab]);

  const handleDisconnectClick = useCallback(() => {
    setIsUserMenuOpen(false);
    disconnect();
  }, [disconnect, setIsUserMenuOpen]);

  useEffect(() => {
    setLocalServers(servers);
    setSelectedServer(prev => {
      if (!prev) return prev;
      return servers.some(server => server.url === prev) ? prev : servers[0]?.url ?? null;
    });
  }, [servers]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const key = params.get("share");
    if (!key) return;
    setShareState({ payload: null, shareKey: key });
    setTab("share");
    params.delete("share");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [setShareState, setTab]);

  // Auto-sync blobs across all servers marked for synchronization.
  useEffect(() => {
    setSelectedBlobs(new Set());
  }, [selectedServer]);

  useEffect(() => {
    if (!isUserMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!userMenuRef.current || userMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsUserMenuOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!userMenuRef.current || userMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isUserMenuOpen]);

  useEffect(() => {
    if (!isFilterMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsFilterMenuOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!filterMenuRef.current || filterMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsFilterMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFilterMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFilterMenuOpen]);

  useEffect(() => {
    if (tab !== "browse") {
      setIsFilterMenuOpen(false);
    }
  }, [tab]);

  useEffect(() => {
    if (tab === "transfer" && selectedBlobs.size === 0) {
      setTab("upload");
    }
  }, [selectedBlobs.size, tab]);

  useEffect(() => {
    if (!user) {
      setIsUserMenuOpen(false);
    }
  }, [setIsUserMenuOpen, user]);

  const showAuthPrompt = !user;

  useEffect(() => {
    const element = mainWidgetRef.current;
    if (!element) return;
    if (showAuthPrompt) {
      element.setAttribute("inert", "");
      return () => {
        element.removeAttribute("inert");
      };
    }
    element.removeAttribute("inert");
    return () => {
      element.removeAttribute("inert");
    };
  }, [showAuthPrompt]);

  useEffect(() => {
    if (tab !== "transfer") return;
    setTransferTargets(prev => {
      const validTargetUrls = localServers.map(server => server.url);
      const filtered = prev.filter(url => validTargetUrls.includes(url));

      let next: string[] = [];

      if (localServers.length <= 1) {
        next = [];
      } else if (localServers.length === 2) {
        const fallback = localServers.find(server => server.url !== selectedServer) ?? localServers[0];
        next = fallback?.url ? [fallback.url] : [];
      } else if (filtered.length > 0) {
        next = filtered;
      } else {
        const preferred = localServers.filter(server => !sourceServerUrls.has(server.url));
        const firstPreferred = preferred[0];
        if (firstPreferred?.url) {
          next = [firstPreferred.url];
        } else if (validTargetUrls[0]) {
          next = [validTargetUrls[0]];
        } else {
          next = [];
        }
      }

      const sameLength = next.length === prev.length;
      const sameOrder = sameLength && next.every((url, index) => url === prev[index]);
      return sameOrder ? prev : next;
    });
  }, [localServers, selectedServer, sourceServerUrls, tab]);

  useEffect(() => {
    if (tab !== "transfer") {
      setTransferBusy(false);
      setTransferFeedback(null);
    }
  }, [tab]);

  useEffect(() => {
    return () => {
      if (statusMessageTimeout.current) {
        clearTimeout(statusMessageTimeout.current);
      }
    };
  }, []);

  const showStatusMessage = useCallback(
    (message: string, tone: StatusMessageTone = "info", duration = 5000) => {
      if (statusMessageTimeout.current) {
        clearTimeout(statusMessageTimeout.current);
        statusMessageTimeout.current = null;
      }
      setStatusMessage(message);
      setStatusMessageTone(tone);
      if (duration > 0) {
        statusMessageTimeout.current = setTimeout(() => {
          setStatusMessage(null);
          setStatusMessageTone("info");
          statusMessageTimeout.current = null;
        }, duration);
      }
    },
    []
  );

  const handleRequestRename = useCallback(
    (blob: BlossomBlob) => {
      const music = isMusicBlob(blob);
      setRenameTarget(blob);
      setRenameIsMusic(music);
      setRenameError(null);

      if (music) {
        const storedAudio = getStoredAudioMetadata(blob.serverUrl, blob.sha256) ?? getStoredAudioMetadata(undefined, blob.sha256);
        const parsed = parseMusicAlias(blob.name || blob.url || blob.sha256);
        setRenameAudioFields(() => {
          const next = emptyAudioFields();
          next.title = storedAudio?.title || parsed.title || "";
          next.artist = storedAudio?.artist || parsed.artist || "";
          next.album = storedAudio?.album || "";
          next.trackNumber = storedAudio?.trackNumber ? String(storedAudio.trackNumber) : "";
          next.trackTotal = storedAudio?.trackTotal ? String(storedAudio.trackTotal) : "";
          next.durationSeconds = storedAudio?.durationSeconds ? String(storedAudio.durationSeconds) : "";
          next.genre = storedAudio?.genre || "";
          next.year = storedAudio?.year ? String(storedAudio.year) : "";
          return next;
        });
        setRenameValue(
          computeMusicAlias(storedAudio?.title || parsed.title || "", storedAudio?.artist || parsed.artist || "") ||
            (storedAudio?.title || parsed.title || "")
        );
      } else {
        setRenameAudioFields(emptyAudioFields());
        setRenameValue(blob.name ?? "");
      }
    },
    []
  );

  const handleRenameCancel = useCallback(() => {
    if (renameBusy) return;
    setRenameTarget(null);
    setRenameValue("");
    setRenameError(null);
    setRenameIsMusic(false);
    setRenameAudioFields(emptyAudioFields());
  }, [renameBusy]);

  const handleRenameValueChange = useCallback(
    (next: string) => {
      if (renameIsMusic) return;
      setRenameValue(next);
      if (renameError) setRenameError(null);
    },
    [renameError, renameIsMusic]
  );

  const handleRenameAudioFieldChange = useCallback(
    (field: keyof EditDialogAudioFields, value: string) => {
      setRenameAudioFields(prev => {
        const next = { ...(prev ?? emptyAudioFields()) };
        next[field] = value;
        if (field === "title" || field === "artist") {
          setRenameValue(computeMusicAlias(next.title, next.artist));
        }
        return next;
      });
      if (renameError) setRenameError(null);
    },
    [renameError]
  );

  const handleRenameSubmit = useCallback(async () => {
    if (!renameTarget) return;
    if (!ndk || !signer) {
      showStatusMessage("Connect your signer to edit file details.", "error", 4000);
      return;
    }
    const relays = effectiveRelays.filter(url => typeof url === "string" && url.trim().length > 0);
    if (!relays.length) {
      showStatusMessage("No relays available to publish the update.", "error", 4000);
      return;
    }

    const isMusic = renameIsMusic && isMusicBlob(renameTarget);
    let aliasForEvent: string;
    let aliasForStore: string | null;
    let extraTags: string[][] | undefined;
    let audioMetadata: BlobAudioMetadata | null = null;

    if (isMusic) {
      const title = renameAudioFields.title.trim();
      if (!title) {
        setRenameError("Title is required for audio files.");
        return;
      }
      const artist = renameAudioFields.artist.trim();
      const album = renameAudioFields.album.trim();
      const trackNumber = parsePositiveIntegerString(renameAudioFields.trackNumber);
      const trackTotal = parsePositiveIntegerString(renameAudioFields.trackTotal);
      const durationSeconds = parsePositiveIntegerString(renameAudioFields.durationSeconds);
      const genre = renameAudioFields.genre.trim();
      const year = parsePositiveIntegerString(renameAudioFields.year);

      aliasForEvent = computeMusicAlias(title, artist) || title;
      if (aliasForEvent.length > 120) {
        setRenameError("Display name is too long (max 120 characters).");
        return;
      }
      aliasForStore = aliasForEvent;

      const tags: string[][] = [["title", title]];
      const metadata: BlobAudioMetadata = { title };
      if (artist) {
        tags.push(["artist", artist]);
        metadata.artist = artist;
      }
      if (album) {
        tags.push(["album", album]);
        metadata.album = album;
      }
      if (trackNumber) {
        const trackValue = trackTotal ? `${trackNumber}/${trackTotal}` : String(trackNumber);
        tags.push(["track", trackValue]);
        metadata.trackNumber = trackNumber;
        if (trackTotal) metadata.trackTotal = trackTotal;
      } else if (trackTotal) {
        metadata.trackTotal = trackTotal;
      }
      if (durationSeconds) {
        tags.push(["duration", String(durationSeconds)]);
        metadata.durationSeconds = durationSeconds;
      }
      if (genre) {
        tags.push(["genre", genre]);
        metadata.genre = genre;
      }
      if (year) {
        tags.push(["year", String(year)]);
        metadata.year = year;
      }

      extraTags = tags;
      audioMetadata = metadata;
    } else {
      const trimmed = renameValue.trim();
      const currentAlias = (renameTarget.name ?? "").trim();
      if (trimmed === currentAlias) {
        setRenameTarget(null);
        setRenameValue("");
        setRenameError(null);
        setRenameIsMusic(false);
        setRenameAudioFields(emptyAudioFields());
        return;
      }
      if (trimmed.length > 120) {
        setRenameError("Display name is too long (max 120 characters).");
        return;
      }
      aliasForStore = trimmed.length > 0 ? trimmed : null;
      aliasForEvent = aliasForStore ?? "";
    }

    setRenameBusy(true);
    setRenameError(null);
    try {
      const template = buildNip94EventTemplate({
        blob: renameTarget,
        alias: aliasForEvent,
        extraTags,
      });
      const event = new NDKEvent(ndk, template);
      if (!event.created_at) {
        event.created_at = Math.floor(Date.now() / 1000);
      }
      await event.sign();

      let successes = 0;
      let lastError: Error | null = null;
      for (const relayUrl of relays) {
        try {
          const relaySet = NDKRelaySet.fromRelayUrls([relayUrl], ndk);
          await event.publish(relaySet, 7000, 1);
          successes += 1;
        } catch (publishError) {
          if (publishError instanceof NDKPublishError) {
            lastError = new Error(publishError.relayErrors || publishError.message || "Update failed");
          } else if (publishError instanceof Error) {
            lastError = publishError;
          } else {
            lastError = new Error("Update failed");
          }
        }
      }

      if (successes === 0) {
        throw lastError ?? new Error("No relays accepted the update.");
      }

      applyAliasUpdate(undefined, renameTarget.sha256, aliasForStore, event.created_at);
      if (isMusic) {
        rememberAudioMetadata(renameTarget.serverUrl, renameTarget.sha256, audioMetadata ?? null);
      }
      showStatusMessage("Details updated.", "success", 2500);
      setRenameTarget(null);
      setRenameValue("");
      setRenameIsMusic(false);
      setRenameAudioFields(emptyAudioFields());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update failed.";
      setRenameError(message);
      showStatusMessage(message, "error", 5000);
    } finally {
      setRenameBusy(false);
    }
  }, [
    renameTarget,
    ndk,
    signer,
    effectiveRelays,
    renameValue,
    renameIsMusic,
    renameAudioFields,
    showStatusMessage,
  ]);

  const createBlobStreamSource = useCallback(
    (sourceBlob: BlossomBlob, sourceServer: ManagedServer): UploadStreamSource | null => {
      if (!sourceBlob.url) return null;
      const sourceRequiresAuth = sourceServer.type === "satellite" ? false : Boolean(sourceServer.requiresAuth);
      if (sourceRequiresAuth && !signEventTemplate) return null;

      const inferExtensionFromType = (type?: string) => {
        if (!type) return undefined;
        const [mime] = type.split(";");
        if (!mime) return undefined;
        const lookup: Record<string, string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/jpg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/bmp": "bmp",
          "image/svg+xml": "svg",
          "image/avif": "avif",
          "image/heic": "heic",
          "video/mp4": "mp4",
          "video/quicktime": "mov",
          "video/webm": "webm",
          "video/x-matroska": "mkv",
          "audio/mpeg": "mp3",
          "audio/wav": "wav",
          "audio/ogg": "ogg",
          "application/pdf": "pdf",
        };
        const key = mime.trim().toLowerCase();
        return lookup[key];
      };

      const extractExtensionFromPath = (value: string) => {
        const match = value.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        return match ? match[1] : undefined;
      };

      const buildFileName = (fallbackHash: string) => {
        const rawName = sourceBlob.name?.trim();
        if (rawName && /\.[a-zA-Z0-9]{1,8}$/.test(rawName)) {
          return rawName.replace(/[\\/]/g, "_");
        }
        if (rawName) {
          const safeRaw = rawName.replace(/[\\/]/g, "_");
          const inferredExt = inferExtensionFromType(sourceBlob.type);
          if (inferredExt) return `${safeRaw}.${inferredExt}`;
          return safeRaw;
        }
        let derived = fallbackHash;
        const sourceUrl = sourceBlob.url!;
        try {
          const url = new URL(sourceUrl);
          const tail = url.pathname.split("/").pop();
          if (tail) derived = tail;
        } catch (error) {
          const tail = sourceUrl.split("/").pop();
          if (tail) derived = tail;
        }
        derived = derived.replace(/[?#].*$/, "");
        if (!/\.[a-zA-Z0-9]{1,8}$/.test(derived)) {
          const urlExt = extractExtensionFromPath(sourceBlob.url!);
          const typeExt = inferExtensionFromType(sourceBlob.type);
          const extension = urlExt || typeExt;
          if (extension) {
            return `${derived}.${extension}`.replace(/[\\/]/g, "_");
          }
        }
        return derived.replace(/[\\/]/g, "_");
      };

      const template = signEventTemplate;
      const preferredType = sourceBlob.type || "application/octet-stream";
      const size = typeof sourceBlob.size === "number" && Number.isFinite(sourceBlob.size)
        ? Math.max(0, Math.round(sourceBlob.size))
        : undefined;
      const sourceUrl = sourceBlob.url;

      const buildHeaders = async () => {
        const headers: Record<string, string> = {};
        if (sourceRequiresAuth && template) {
          if (sourceServer.type === "blossom") {
            let url: URL | null = null;
            try {
              url = new URL(sourceUrl);
            } catch (error) {
              url = null;
            }
            const auth = await buildAuthorizationHeader(template, "get", {
              hash: sourceBlob.sha256,
              serverUrl: sourceServer.url,
              urlPath: url ? url.pathname + (url.search || "") : undefined,
              expiresInSeconds: 300,
            });
            headers.Authorization = auth;
          } else if (sourceServer.type === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(template, {
              url: sourceUrl,
              method: "GET",
            });
          }
        }
        return headers;
      };

      return {
        kind: "stream",
        fileName: buildFileName(sourceBlob.sha256),
        contentType: preferredType,
        size,
        async createStream() {
          const headers = await buildHeaders();
          const response = await fetch(sourceUrl, { headers, mode: "cors" });
          if (!response.ok) {
            throw new Error(`Unable to fetch blob from source (${response.status})`);
          }
          if (!response.body) {
            throw new Error("Source response does not support streaming");
          }
          return response.body;
        },
      };
    },
    [signEventTemplate]
  );


  useEffect(() => {
    if (signer) {
      unauthorizedSyncTargetsRef.current.clear();
    }
  }, [signer]);

  useEffect(() => {
    if (syncEnabledServers.length < 2) {
      setSyncStatus({ state: "idle", progress: 0 });
      return;
    }
    const activeTransfers = syncTransfers.filter(item => item.status === "uploading" || item.status === "success");
    const uploading = syncTransfers.some(item => item.status === "uploading");
    if (uploading && activeTransfers.length > 0) {
      const totals = activeTransfers.reduce(
        (acc, item) => {
          const total = item.total || 0;
          const transferred = item.status === "success" ? total : Math.min(total, item.transferred);
          return {
            transferred: acc.transferred + transferred,
            total: acc.total + total,
          };
        },
        { transferred: 0, total: 0 }
      );
      const progress = totals.total > 0 ? totals.transferred / totals.total : 0;
      setSyncStatus({ state: "syncing", progress });
      return;
    }
    if (syncTransfers.some(item => item.status === "error")) {
      setSyncStatus({ state: "error", progress: 0 });
      return;
    }
    setSyncStatus({ state: "synced", progress: 1 });
  }, [syncEnabledServers.length, syncTransfers]);

  useEffect(() => {
    if (syncEnabledServers.length < 2) return;

    let cancelled = false;
    const syncUrlSet = new Set(syncEnabledServers.map(server => server.url));

    const run = async () => {
      for (const target of syncEnabledServers) {
        if (cancelled) break;
        const targetSnapshot = snapshots.find(snapshot => snapshot.server.url === target.url);
        if (!targetSnapshot || targetSnapshot.isLoading) continue;

        const existing = new Set(targetSnapshot.blobs.map(blob => blob.sha256));

        for (const [sha, entry] of Object.entries(distribution)) {
          if (cancelled) break;
          if (existing.has(sha)) continue;
          if (!entry.servers.some(url => syncUrlSet.has(url) && url !== target.url)) continue;

          const key = `${target.url}::${sha}`;
          const nextAllowedAt = nextSyncAttemptRef.current.get(key) ?? 0;
          if (Date.now() < nextAllowedAt) continue;
          if (syncQueueRef.current.has(key)) continue;

          const sourceUrl = entry.servers.find(url => url !== target.url && syncUrlSet.has(url));
          if (!sourceUrl) continue;

          const sourceSnapshot = snapshots.find(snapshot => snapshot.server.url === sourceUrl);
          if (!sourceSnapshot || sourceSnapshot.isLoading) continue;

          const sourceBlob = sourceSnapshot.blobs.find(blob => blob.sha256 === sha);
          if (!sourceBlob || !sourceBlob.url) continue;

          const targetNeedsSigner = target.type === "satellite" || Boolean(target.requiresAuth);
          if (targetNeedsSigner && !signer) continue;
          if (targetNeedsSigner && !signEventTemplate) continue;

          if (target.type !== "blossom" && target.type !== "nip96" && target.type !== "satellite") continue;

          const transferId = `sync-${target.url}-${sha}`;
          const fileName = sourceBlob.name || sha;
          const totalSize = sourceBlob.size && sourceBlob.size > 0 ? sourceBlob.size : 1;
          const baseTransfer: TransferState = {
            id: transferId,
            serverUrl: target.url,
            fileName,
            transferred: 0,
            total: totalSize,
            status: "uploading",
            kind: "sync",
          };

          if (unauthorizedSyncTargetsRef.current.has(target.url)) {
            setSyncTransfers(prev => {
              const filtered = prev.filter(item => item.id !== transferId);
              return [
                ...filtered,
                { ...baseTransfer, status: "error", message: "Sync auth failed" },
              ];
            });
            nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
            continue;
          }

          syncQueueRef.current.add(key);
          setSyncTransfers(prev => {
            const filtered = prev.filter(item => item.id !== transferId);
            const next = [...filtered, baseTransfer];
            return next.slice(-40);
          });
          try {
            let completed = false;
            const targetRequiresAuth = target.type === "satellite" || Boolean(target.requiresAuth);
            const mirrorUnsupported = unsupportedMirrorTargetsRef.current.has(target.url);
            const uploadDirectlyToBlossom = async () => {
              const streamSource = createBlobStreamSource(sourceBlob, sourceSnapshot.server);
              if (!streamSource) {
                nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              const fallbackTotal = streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
              await uploadBlobToServer(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setSyncTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              return fallbackTotal;
            };
            if (target.type === "blossom") {
              if (!mirrorUnsupported) {
                try {
                  await mirrorBlobToServer(
                    target.url,
                    sourceBlob.url,
                    targetRequiresAuth ? signEventTemplate : undefined,
                    targetRequiresAuth
                  );
                  completed = true;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const statusMatch = message.match(/status\s*(\d{3})/i);
                  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
                  const canFallback = statusCode === 405 || statusCode === 404;
                  if (!canFallback) {
                    nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                    throw error;
                  }
                  unsupportedMirrorTargetsRef.current.add(target.url);
                  await uploadDirectlyToBlossom();
                  completed = true;
                }
              }
              if (!completed) {
                await uploadDirectlyToBlossom();
                completed = true;
              }
            } else if (target.type === "nip96") {
              const streamSource = createBlobStreamSource(sourceBlob, sourceSnapshot.server);
              if (!streamSource) {
                nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              await uploadBlobToNip96(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal = streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setSyncTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              completed = true;
            } else if (target.type === "satellite") {
              const streamSource = createBlobStreamSource(sourceBlob, sourceSnapshot.server);
              if (!streamSource) {
                nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
                throw new Error("Unable to fetch blob content for sync");
              }
              await uploadBlobToSatellite(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal = streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setSyncTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              completed = true;
            } else {
              throw new Error(`Unsupported target type: ${target.type}`);
            }
            if (!completed) {
              throw new Error("Unknown sync completion state");
            }
            nextSyncAttemptRef.current.set(key, Date.now() + 60 * 1000);
            setSyncTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      transferred: item.total || totalSize,
                      total: item.total || totalSize,
                      status: "success",
                    }
                  : item
              )
            );
            if (!cancelled) {
              queryClient.invalidateQueries({ queryKey: ["server-blobs", target.url, pubkey, target.type] });
            }
          } catch (error) {
            console.error("Auto-sync failed", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const statusMatch = errorMessage.match(/status\s*(\d{3})/i);
            const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
            if (statusCode === 404 || statusCode === 405) {
              unsupportedMirrorTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
            } else if (statusCode === 401) {
              unauthorizedSyncTargetsRef.current.add(target.url);
              nextSyncAttemptRef.current.set(key, Date.now() + 30 * 60 * 1000);
              showStatusMessage("Sync auth failed – reconnect your signer.", "error", 6000);
            } else {
              nextSyncAttemptRef.current.set(key, Date.now() + 15 * 60 * 1000);
            }
            setSyncTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      status: "error",
                      message:
                        statusCode === 404 || statusCode === 405
                          ? "Sync unsupported: target blocks mirroring"
                          : statusCode === 401
                          ? "Sync auth failed"
                          : errorMessage || "Sync failed",
                    }
                  : item
              )
            );
          } finally {
            syncQueueRef.current.delete(key);
          }
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    distribution,
    createBlobStreamSource,
    pubkey,
    queryClient,
    signEventTemplate,
    signer,
    snapshots,
    syncEnabledServers,
  ]);

  const currentSnapshot = useMemo(() => snapshots.find(snapshot => snapshot.server.url === selectedServer), [snapshots, selectedServer]);
  const browsingAllServers = selectedServer === null;

  const visibleAggregatedBlobs = useMemo(() => {
    if (filterMode === "all") return aggregated.blobs;
    return aggregated.blobs.filter(blob => matchesFilter(blob, filterMode));
  }, [aggregated.blobs, filterMode]);

  const currentVisibleBlobs = useMemo(() => {
    if (!currentSnapshot) return undefined;
    if (filterMode === "all") return currentSnapshot.blobs;
    return currentSnapshot.blobs.filter(blob => matchesFilter(blob, filterMode));
  }, [currentSnapshot, filterMode]);

  const aggregatedVisibleSize = useMemo(
    () => visibleAggregatedBlobs.reduce((total, blob) => total + (blob.size || 0), 0),
    [visibleAggregatedBlobs]
  );

  const musicQueueTracks = useMemo(() => {
    return aggregated.blobs
      .filter(isMusicBlob)
      .map(buildAudioTrack)
      .filter((track): track is AudioTrack => Boolean(track));
  }, [aggregated.blobs]);

  const audio = useAudio();
  const { toggle: toggleAudioTrack } = audio;
  const scrubberMax = audio.duration > 0 ? audio.duration : Math.max(audio.currentTime || 0, 1);
  const scrubberValue = Math.min(audio.currentTime || 0, scrubberMax);
  const scrubberDisabled = !audio.current || audio.duration <= 0;

  const handleScrub: React.ChangeEventHandler<HTMLInputElement> = event => {
    const next = Number(event.target.value);
    if (!Number.isFinite(next)) return;
    audio.seek(next);
  };

  useEffect(() => {
    let ignore = false;
    async function loadProfile() {
      if (!ndk || !user?.pubkey) {
        setAvatarUrl(null);
        return;
      }
      try {
        const evt = await ndk.fetchEvent({ kinds: [0], authors: [user.pubkey] });
        if (evt?.content && !ignore) {
          try {
            const metadata = JSON.parse(evt.content);
            setAvatarUrl(metadata.picture || null);
          } catch (error) {
            if (!ignore) setAvatarUrl(null);
          }
        }
      } catch (error) {
        if (!ignore) setAvatarUrl(null);
      }
    }
    loadProfile();
    return () => {
      ignore = true;
    };
  }, [ndk, user?.pubkey]);

  const handleAddServer = (server: ManagedServer) => {
    const normalized = normalizeManagedServer(server);
    const trimmedUrl = normalized.url;
    if (!trimmedUrl) return;

    setLocalServers(prev => {
      if (prev.find(existing => existing.url === trimmedUrl)) {
        return prev;
      }
      const next = [...prev, normalized];
      return sortServersByName(next);
    });
    setSelectedServer(trimmedUrl);
  };

  const handleUpdateServer = (originalUrl: string, updated: ManagedServer) => {
    const normalized = normalizeManagedServer(updated);
    const normalizedUrl = normalized.url;
    if (!normalizedUrl) return;

    setLocalServers(prev => {
      if (prev.some(server => server.url !== originalUrl && server.url === normalizedUrl)) {
        return prev;
      }
      const updatedList = prev.map(server => (server.url === originalUrl ? normalized : server));
      return sortServersByName(updatedList);
    });

    setSelectedServer(prev => {
      if (prev === originalUrl) {
        return normalizedUrl;
      }
      return prev;
    });
  };

  const handleRemoveServer = (url: string) => {
    setLocalServers(prev => prev.filter(server => server.url !== url));
    if (selectedServer === url) {
      setSelectedServer(null);
    }
  };

  const handleToggleRequiresAuth = (url: string, value: boolean) => {
    setLocalServers(prev => prev.map(server => (server.url === url ? { ...server, requiresAuth: value } : server)));
  };

  const handleToggleSync = (url: string, value: boolean) => {
    setLocalServers(prev => prev.map(server => (server.url === url ? { ...server, sync: value } : server)));
  };

  const handleSaveServers = async () => {
    if (!signer) {
      setBanner("Connect your signer to save servers");
      return;
    }
    if (saving) {
      setBanner("Server list update already in progress.");
      setTimeout(() => setBanner(null), 2000);
      return;
    }
    if (serverValidationError) {
      setBanner(serverValidationError);
      setTimeout(() => setBanner(null), 3000);
      return;
    }
    const normalized = sortServersByName(localServers.map(normalizeManagedServer));
    setLocalServers(normalized);
    try {
      await saveServers(normalized);
      setBanner("Server list updated");
      setTimeout(() => setBanner(null), 2500);
    } catch (error: any) {
      setBanner(error?.message || "Failed to save servers");
    }
  };

  const toggleBlob = (sha: string) => {
    setSelectedBlobs(prev => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });
  };

  const selectManyBlobs = (shas: string[], value: boolean) => {
    setSelectedBlobs(prev => {
      const next = new Set(prev);
      shas.forEach(sha => {
        if (value) {
          next.add(sha);
        } else {
          next.delete(sha);
        }
      });
      return next;
    });
  };

  const toggleTransferTarget = (url: string) => {
    if (localServers.length <= 1) return;
    if (localServers.length === 2 && selectedServer && url === selectedServer) return;
    setTransferTargets(prev => (prev.includes(url) ? prev.filter(item => item !== url) : [...prev, url]));
  };

  const handleStartTransfer = async () => {
    if (transferBusy) return;
    if (selectedBlobItems.length === 0) {
      setTransferFeedback("Select files in Browse to start a transfer.");
      return;
    }
    const targets = transferTargets
      .map(url => localServers.find(server => server.url === url))
      .filter((server): server is ManagedServer => Boolean(server));
    if (targets.length === 0) {
      setTransferFeedback("Choose at least one destination server.");
      return;
    }
    if (
      selectedBlobItems.some(item => item.server.type !== "satellite" && item.server.requiresAuth) &&
      !signEventTemplate
    ) {
      setTransferFeedback("Connect your signer to read from the selected servers.");
      return;
    }
    if (targets.some(server => server.type === "satellite" || server.requiresAuth) && (!signer || !signEventTemplate)) {
      setTransferFeedback("Connect your signer to upload to servers that require authorization.");
      return;
    }
    if (missingSourceCount > 0) {
      setTransferFeedback("Bloom couldn't load details for every selected file. Refresh and try again.");
      return;
    }

    setTransferBusy(true);
    setTransferFeedback(null);
    let encounteredError = false;

    const serverNameByUrl = new Map(localServers.map(server => [server.url, server.name]));

    try {
      for (const target of targets) {
        for (const { blob, server: sourceServer } of selectedBlobItems) {
          const sha = blob.sha256;
          const transferId = `transfer-${target.url}-${sha}`;
          const fileName = blob.name || sha;
          const totalSize = blob.size && blob.size > 0 ? blob.size : 1;
          const baseTransfer: TransferState = {
            id: transferId,
            serverUrl: target.url,
            fileName,
            transferred: 0,
            total: totalSize,
            status: "uploading",
            kind: "transfer",
          };

          const existing = distribution[sha];
          if (existing?.servers.includes(target.url)) {
            setManualTransfers(prev => {
              const filtered = prev.filter(item => item.id !== transferId);
              const completedTransfer: TransferState = {
                ...baseTransfer,
                transferred: totalSize,
                total: totalSize,
                status: "success",
                message: "Already present",
              };
              const next: TransferState[] = [...filtered, completedTransfer];
              return next.slice(-60);
            });
            continue;
          }

          setManualTransfers(prev => {
            const filtered = prev.filter(item => item.id !== transferId);
            const next: TransferState[] = [...filtered, baseTransfer];
            return next.slice(-60);
          });

          try {
            let completed = false;
            const targetRequiresAuth = target.type === "satellite" || Boolean(target.requiresAuth);
            if (target.type === "blossom") {
              const mirrorUnsupported = unsupportedMirrorTargetsRef.current.has(target.url);
              if (!mirrorUnsupported) {
                try {
                  if (!blob.url) {
                    throw new Error("Missing source URL for mirror operation");
                  }
                  await mirrorBlobToServer(
                    target.url,
                    blob.url,
                    targetRequiresAuth ? signEventTemplate : undefined,
                    targetRequiresAuth
                  );
                  completed = true;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const statusMatch = message.match(/status\s*(\d{3})/i);
                  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
                  if (statusCode === 404 || statusCode === 405) {
                    unsupportedMirrorTargetsRef.current.add(target.url);
                  } else if (statusCode === 401) {
                    unauthorizedSyncTargetsRef.current.add(target.url);
                    throw new Error("Transfer auth failed");
                  } else {
                    throw error;
                  }
                }
              }

              if (!completed) {
                const streamSource = createBlobStreamSource(blob, sourceServer);
                if (!streamSource) {
                  throw new Error(
                    `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`
                  );
                }
                const fallbackTotal = streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                await uploadBlobToServer(
                  target.url,
                  streamSource,
                  targetRequiresAuth ? signEventTemplate : undefined,
                  targetRequiresAuth,
                  progress => {
                    const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                    const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                    const loaded = Math.min(totalProgress, loadedRaw);
                    setManualTransfers(prev =>
                      prev.map(item =>
                        item.id === transferId
                          ? {
                              ...item,
                              transferred: loaded,
                              total: totalProgress,
                            }
                          : item
                      )
                    );
                  }
                );
                completed = true;
              }
            } else if (target.type === "nip96") {
              const streamSource = createBlobStreamSource(blob, sourceServer);
              if (!streamSource) {
                throw new Error(
                  `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`
                );
              }
              await uploadBlobToNip96(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal = streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setManualTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              completed = true;
            } else if (target.type === "satellite") {
              const streamSource = createBlobStreamSource(blob, sourceServer);
              if (!streamSource) {
                throw new Error(
                  `Unable to fetch ${fileName} from ${serverNameByUrl.get(sourceServer.url) || sourceServer.url}`
                );
              }
              await uploadBlobToSatellite(
                target.url,
                streamSource,
                targetRequiresAuth ? signEventTemplate : undefined,
                targetRequiresAuth,
                progress => {
                  const fallbackTotal = streamSource.size && streamSource.size > 0 ? streamSource.size : totalSize;
                  const totalProgress = progress.total && progress.total > 0 ? progress.total : fallbackTotal;
                  const loadedRaw = typeof progress.loaded === "number" ? progress.loaded : 0;
                  const loaded = Math.min(totalProgress, loadedRaw);
                  setManualTransfers(prev =>
                    prev.map(item =>
                      item.id === transferId
                        ? {
                            ...item,
                            transferred: loaded,
                            total: totalProgress,
                          }
                        : item
                    )
                  );
                }
              );
              completed = true;
            } else {
              throw new Error(`Unsupported target type: ${target.type}`);
            }

            if (!completed) {
              throw new Error("Unknown transfer completion state");
            }

            setManualTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      transferred: item.total || totalSize,
                      total: item.total || totalSize,
                      status: "success",
                    }
                  : item
              )
            );
            if (pubkey) {
              await queryClient.invalidateQueries({ queryKey: ["server-blobs", target.url, pubkey, target.type] });
            }
          } catch (error) {
            encounteredError = true;
            const message = error instanceof Error ? error.message : String(error);
            const statusMatch = message.match(/status\s*(\d{3})/i);
            const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
            if (statusCode === 401) {
              unauthorizedSyncTargetsRef.current.add(target.url);
            }
            if (statusCode === 404 || statusCode === 405) {
              unsupportedMirrorTargetsRef.current.add(target.url);
            }
            setManualTransfers(prev =>
              prev.map(item =>
                item.id === transferId
                  ? {
                      ...item,
                      status: "error",
                      message: message || "Transfer failed",
                    }
                  : item
              )
            );
          }
        }
      }

      if (!encounteredError) {
        setTransferFeedback("Transfer complete.");
      } else {
        setTransferFeedback("Transfer finished with some issues. Review the activity log below.");
      }
    } finally {
      setTransferBusy(false);
    }
  };

  const handleDeleteBlob = async (blob: BlossomBlob) => {
    if (!currentSnapshot) {
      showStatusMessage("Select a specific server to delete files.", "error", 2000);
      return;
    }
    const confirmDelete = window.confirm(`Delete ${blob.sha256.slice(0, 10)}… from ${currentSnapshot.server.name}?`);
    if (!confirmDelete) return;
    const requiresSigner = currentSnapshot.server.type === "satellite" || Boolean(currentSnapshot.server.requiresAuth);
    if (requiresSigner && !signer) {
      showStatusMessage("Connect your signer to delete from this server.", "error", 2000);
      return;
    }
    try {
      if (currentSnapshot.server.type === "nip96") {
        await deleteNip96File(
          currentSnapshot.server.url,
          blob.sha256,
          requiresSigner ? signEventTemplate : undefined,
          requiresSigner
        );
      } else if (currentSnapshot.server.type === "satellite") {
        await deleteSatelliteFile(
          currentSnapshot.server.url,
          blob.sha256,
          requiresSigner ? signEventTemplate : undefined,
          requiresSigner
        );
      } else {
        await deleteUserBlob(
          currentSnapshot.server.url,
          blob.sha256,
          requiresSigner ? signEventTemplate : undefined,
          requiresSigner
        );
      }
      queryClient.invalidateQueries({ queryKey: ["server-blobs", currentSnapshot.server.url, pubkey, currentSnapshot.server.type] });
      setSelectedBlobs(prev => {
        const next = new Set(prev);
        next.delete(blob.sha256);
        return next;
      });
      setBanner("Blob deleted");
      setTimeout(() => setBanner(null), 2000);
    } catch (error: any) {
      showStatusMessage(error?.message || "Delete failed", "error", 5000);
    }
  };

  const handleCopyUrl = (blob: BlossomBlob) => {
    if (!blob.url) return;
    navigator.clipboard.writeText(blob.url).catch(() => undefined);
    showStatusMessage("URL copied to clipboard", "success", 1500);
  };

  const handleShareBlob = useCallback(
    (blob: BlossomBlob) => {
      if (!blob.url) {
        showStatusMessage("This file does not have a shareable URL.", "error", 3000);
        return;
      }
      const payload: SharePayload = {
        url: blob.url,
        name: blob.name ?? null,
        sha256: blob.sha256,
        serverUrl: blob.serverUrl ?? null,
      };
      setShareState({ payload, shareKey: null });
      setTab("share");
    },
    [setShareState, setTab, showStatusMessage]
  );

  const handleUploadCompleted = (success: boolean) => {
    if (!success) return;

    servers.forEach(server => queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url] }));
    setTab("browse");
    showStatusMessage("All files uploaded successfully", "success", 5000);
  };

  const handleStatusServerChange: React.ChangeEventHandler<HTMLSelectElement> = event => {
    const value = event.target.value;
    if (value === ALL_SERVERS_VALUE) {
      setSelectedServer(null);
    } else {
      setSelectedServer(value);
    }
    setTab("browse");
  };

  const currentSize = useMemo(() => {
    if (!currentVisibleBlobs) return 0;
    return currentVisibleBlobs.reduce((acc, blob) => acc + (blob.size || 0), 0);
  }, [currentVisibleBlobs]);

  const statusCount = currentVisibleBlobs ? currentVisibleBlobs.length : visibleAggregatedBlobs.length;
  const statusSize = currentSnapshot ? currentSize : aggregatedVisibleSize;
  const statusSelectValue = selectedServer ?? ALL_SERVERS_VALUE;
  const syncIndicator = useMemo(() => {
    if (syncEnabledServers.length < 2) return null;
    if (syncStatus.state === "syncing") {
      const percent = Math.min(100, Math.max(0, Math.round((syncStatus.progress || 0) * 100)));
      return `Syncing servers - ${percent}%`;
    }
    if (syncStatus.state === "synced") {
      return "Synced";
    }
    if (syncStatus.state === "error") {
      return "Sync issue";
    }
    return null;
  }, [syncEnabledServers.length, syncStatus]);
  const centerMessage = statusMessage ?? syncIndicator;
  const centerClass = statusMessage
    ? statusMessageTone === "error"
      ? "text-red-400"
      : statusMessageTone === "success"
      ? "text-emerald-300"
      : "text-slate-400"
    : syncStatus.state === "syncing"
    ? "text-emerald-300"
    : syncStatus.state === "synced"
    ? "text-emerald-200"
    : syncStatus.state === "error"
    ? "text-red-400"
    : "text-slate-500";
  const disableTransferAction =
    transferBusy || transferTargets.length === 0 || selectedBlobItems.length === 0 || localServers.length <= 1;
  const activeFilterOption = filterMode === "all" ? null : FILTER_OPTION_MAP[filterMode];
  const filterButtonLabel = activeFilterOption ? activeFilterOption.label : "Filter";
  const filterButtonAriaLabel = activeFilterOption ? `Filter: ${activeFilterOption.label}` : "Filter files";
  const filterButtonActive = filterMode !== "all" || isFilterMenuOpen;
  const isMusicFilterActive = filterMode === "music";

  return (
    <div className="flex min-h-screen max-h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full flex-1 min-h-0 flex-col gap-6 overflow-hidden px-6 py-8 max-w-7xl">
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <img src="/bloom.png" alt="Bloom logo" className="h-10 w-10 rounded-xl object-cover" />
            <div>
              <h1 className="text-2xl font-semibold">Bloom</h1>
              <p className="hidden md:block text-xs text-slate-400">
                Manage your content, upload media, and mirror files across servers.
              </p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
            {user && (
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={toggleUserMenu}
                  className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-800 bg-slate-900/70 p-0 text-xs text-slate-200 transition hover:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  aria-haspopup="menu"
                  aria-expanded={isUserMenuOpen}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt="User avatar"
                      className="block h-full w-full object-cover"
                      onError={() => setAvatarUrl(null)}
                    />
                  ) : (
                    <span className="font-semibold">{userInitials}</span>
                  )}
                </button>
                {isUserMenuOpen && (
                  <div className="absolute right-0 z-10 mt-2 min-w-[8rem] rounded-md bg-slate-900 px-2 py-1 text-sm shadow-lg">
                    <ul className="flex flex-col gap-1 text-slate-200">
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleSelectServers();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Servers
                        </a>
                      </li>
                      <li>
                        <a
                          href="#"
                          onClick={event => {
                            event.preventDefault();
                            handleDisconnectClick();
                          }}
                          className="block px-1 py-1 hover:text-emerald-300"
                        >
                          Disconnect
                        </a>
                      </li>
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {banner && <div className="rounded-xl border border-emerald-500 bg-emerald-500/10 px-4 py-2 text-sm">{banner}</div>}

        <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70">
          <div
            ref={mainWidgetRef}
            className={`flex flex-1 min-h-0 flex-col ${showAuthPrompt ? "pointer-events-none opacity-40" : ""}`}
            aria-hidden={showAuthPrompt || undefined}
          >
            <nav className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-800">
              <div className="flex gap-3">
                {NAV_TABS.map(item => {
                  const selectedCount = selectedBlobs.size;
                  const isUploadTab = item.id === "upload";
                  const isTransferView = tab === "transfer";
                  const showTransfer = isUploadTab && selectedCount > 0;
                  const isActive = tab === item.id || (isUploadTab && isTransferView);
                  const IconComponent = showTransfer ? TransferIcon : item.icon;
                  const label = showTransfer ? "Transfer" : item.label;
                  const hideLabelOnMobile = item.id === "browse" || isUploadTab;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setTab(showTransfer ? "transfer" : item.id)}
                      disabled={showAuthPrompt}
                      aria-label={label}
                      className={`px-3 py-2 text-sm rounded-xl border flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        isActive
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                      }`}
                    >
                      <IconComponent size={16} />
                      <span className={hideLabelOnMobile ? "hidden sm:inline" : undefined}>{label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {tab === "browse" && (
                  <>
                    <button
                      onClick={() => setViewMode("grid")}
                      disabled={showAuthPrompt || isMusicFilterActive}
                      className={`rounded-xl border px-3 py-2 text-sm flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        viewMode === "grid"
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                      }`}
                      title="Icon view"
                    >
                      <GridIcon size={18} />
                      <span className="hidden sm:inline">Icons</span>
                    </button>
                    <button
                      onClick={() => setViewMode("list")}
                      disabled={showAuthPrompt}
                      className={`rounded-xl border px-3 py-2 text-sm flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                        viewMode === "list"
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                      }`}
                      title="List view"
                    >
                      <ListIcon size={18} />
                      <span className="hidden sm:inline">List</span>
                    </button>
                    <div className="relative" ref={filterMenuRef}>
                      <button
                        type="button"
                        onClick={toggleFilterMenu}
                        disabled={showAuthPrompt}
                        className={`rounded-xl border px-3 py-2 text-sm flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                          filterButtonActive
                            ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                            : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700"
                        }`}
                        aria-haspopup="menu"
                        aria-expanded={isFilterMenuOpen}
                        title={filterButtonAriaLabel}
                        aria-label={filterButtonAriaLabel}
                      >
                        <FilterIcon size={18} />
                        <span className="hidden sm:inline">{filterButtonLabel}</span>
                      </button>
                      {isFilterMenuOpen && (
                        <div
                          role="menu"
                          className="absolute right-0 z-20 mt-2 w-48 rounded-xl border border-slate-800 bg-slate-950/95 p-1 shadow-lg backdrop-blur"
                        >
                          {FILTER_OPTIONS.map(option => {
                            const isActive = filterMode === option.id;
                            return (
                              <a
                                key={option.id}
                                href="#"
                                onClick={event => {
                                  event.preventDefault();
                                  handleSelectFilter(option.id);
                                }}
                                role="menuitemradio"
                                aria-checked={isActive}
                                className={`flex w-full items-center gap-2 px-2 py-2 text-left text-sm transition focus:outline-none ${
                                  isActive
                                    ? "text-emerald-200"
                                    : "text-slate-100 hover:text-emerald-300"
                                }`}
                              >
                                <option.icon size={16} />
                                <span>{option.label}</span>
                              </a>
                            );
                          })}
                          <div className="mt-1 border-t border-slate-800 pt-1">
                            <a
                              href="#"
                              onClick={event => {
                                event.preventDefault();
                                if (filterMode === "all") return;
                                handleSelectFilter("all");
                              }}
                              role="menuitem"
                              aria-disabled={filterMode === "all"}
                              className={`w-full px-2 py-2 text-left text-sm transition focus:outline-none ${
                                filterMode === "all"
                                  ? "cursor-default text-slate-500"
                                  : "text-slate-100 hover:text-emerald-300"
                              }`}
                              tabIndex={filterMode === "all" ? -1 : 0}
                            >
                              Clear Filters
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </nav>

          <div
            className={`flex flex-1 min-h-0 flex-col p-4 ${tab === "browse" || tab === "share" ? "overflow-hidden" : "overflow-y-auto"}`}
          >
            {tab === "browse" && (
              <div
                className={`flex flex-1 min-h-0 flex-col overflow-hidden ${viewMode === "grid" ? "pr-1" : ""}`}
              >
                {browsingAllServers ? (
                  <BlobList
                    blobs={visibleAggregatedBlobs}
                    signTemplate={signEventTemplate}
                    selected={selectedBlobs}
                    viewMode={viewMode}
                    onToggle={toggleBlob}
                    onSelectMany={selectManyBlobs}
                    onDelete={handleDeleteBlob}
                    onCopy={handleCopyUrl}
                    onShare={handleShareBlob}
                    onRename={handleRequestRename}
                    onPlay={blob => {
                      const track = buildAudioTrack(blob);
                      if (!track) return;
                      toggleAudioTrack(track, musicQueueTracks);
                    }}
                    currentTrackUrl={audio.current?.url}
                    currentTrackStatus={audio.status}
                  />
                ) : currentSnapshot ? (
                  <BlobList
                    blobs={currentVisibleBlobs ?? currentSnapshot.blobs}
                    baseUrl={currentSnapshot.server.url}
                    requiresAuth={currentSnapshot.server.requiresAuth}
                    signTemplate={currentSnapshot.server.requiresAuth ? signEventTemplate : undefined}
                    serverType={currentSnapshot.server.type}
                    selected={selectedBlobs}
                    viewMode={viewMode}
                    onToggle={toggleBlob}
                    onSelectMany={selectManyBlobs}
                    onDelete={handleDeleteBlob}
                    onCopy={handleCopyUrl}
                    onShare={handleShareBlob}
                    onRename={handleRequestRename}
                    onPlay={blob => {
                      const track = buildAudioTrack(blob);
                      if (!track) return;
                      toggleAudioTrack(track, musicQueueTracks);
                    }}
                    currentTrackUrl={audio.current?.url}
                    currentTrackStatus={audio.status}
                  />
                ) : (
                  <div className="text-sm text-slate-400">Select a server to browse its contents.</div>
                )}
              </div>
            )}

            {tab === "upload" && (
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                    Loading uploader…
                  </div>
                }
              >
                <UploadPanelLazy
                  servers={servers}
                  selectedServerUrl={selectedServer}
                  onUploaded={handleUploadCompleted}
                  syncTransfers={syncTransfers}
                />
              </Suspense>
            )}

            {tab === "transfer" && (
              <div className="space-y-6">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-5">
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">Transfer files</h2>
                    <p className="text-sm text-slate-400">Select where Bloom should copy the files you picked in Browse.</p>
                  </div>
                  {selectedBlobItems.length === 0 ? (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
                      Choose one or more files in Browse, then return here to send them to another server.
                    </div>
                  ) : (
                    <>
                      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 space-y-2 text-sm text-slate-200">
                        <div className="flex flex-wrap gap-4 text-slate-200">
                          <span>
                            {selectedBlobItems.length} item{selectedBlobItems.length === 1 ? "" : "s"}
                          </span>
                          <span>{prettyBytes(selectedBlobTotalSize)}</span>
                        </div>
                        <div className="text-xs uppercase tracking-wide text-slate-500">
                          From {Array.from(sourceServerUrls)
                            .map(url => serverNameMap.get(url) || url)
                            .join(", ") || "unknown server"}
                        </div>
                        {missingSourceCount > 0 && (
                          <div className="text-xs text-amber-300">
                            {missingSourceCount} item{missingSourceCount === 1 ? "" : "s"} could not be fetched right now.
                          </div>
                        )}
                        <ul className="mt-1 space-y-1 text-xs text-slate-400">
                          {selectedBlobItems.slice(0, 6).map(item => (
                            <li key={item.blob.sha256} className="flex items-center justify-between gap-3">
                              <span className="truncate">{item.blob.name || `${item.blob.sha256.slice(0, 12)}…`}</span>
                              <span>{prettyBytes(item.blob.size || 0)}</span>
                            </li>
                          ))}
                          {selectedBlobItems.length > 6 && (
                            <li className="text-xs text-slate-500">+ {selectedBlobItems.length - 6} more</li>
                          )}
                        </ul>
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-xs uppercase tracking-wide text-slate-500">Destination servers</h3>
                        {localServers.length === 0 ? (
                          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-400">
                            Add a server in the Servers tab before transferring.
                          </div>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {localServers.map(server => {
                              const isChecked = transferTargets.includes(server.url);
                              const requiresAuth = Boolean(server.requiresAuth);
                              const isDisabled =
                                localServers.length <= 1 ||
                                (localServers.length === 2 && Boolean(selectedServer) && server.url === selectedServer);
                              return (
                                <label
                                  key={server.url}
                                  className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition ${
                                    isChecked
                                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                                      : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                                  } ${
                                    isDisabled ? "opacity-60 cursor-not-allowed" : ""
                                  }`}
                                  aria-disabled={isDisabled}
                                >
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium truncate">{server.name}</div>
                                    <div className="text-xs text-slate-500 truncate">{server.url}</div>
                                    {requiresAuth && (!signer || !signEventTemplate) && (
                                      <div className="mt-1 text-[11px] text-amber-300">Signer required</div>
                                    )}
                                  </div>
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    checked={isChecked}
                                    disabled={isDisabled}
                                    onChange={() => toggleTransferTarget(server.url)}
                                  />
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      {transferFeedback && (
                        <div className={`text-sm ${transferFeedbackTone}`}>{transferFeedback}</div>
                      )}
                      <div className="flex flex-wrap gap-3">
                        <button
                          onClick={handleStartTransfer}
                          disabled={disableTransferAction}
                          className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                            disableTransferAction
                              ? "cursor-not-allowed border border-slate-800 bg-slate-900/60 text-slate-500"
                              : "border border-emerald-500 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                          }`}
                        >
                          {transferBusy ? "Transferring…" : "Start Transfer"}
                        </button>
                        <button
                          onClick={() => setTab("browse")}
                          className="px-4 py-2 rounded-xl border border-slate-800 bg-slate-900/60 text-sm text-slate-300 hover:border-slate-700"
                        >
                          Go Back Home
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {transferActivity.length > 0 && (
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6 space-y-4">
                    <div className="text-sm font-semibold text-slate-100">Transfer activity</div>
                    <div className="space-y-3">
                      {transferActivity.map(item => {
                        const percent = item.total > 0 ? Math.round((item.transferred / item.total) * 100) : 0;
                        const label = serverNameMap.get(item.serverUrl) || item.serverUrl;
                        return (
                          <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-200">
                              <span className="truncate font-medium">{item.fileName}</span>
                              <span className="text-xs text-slate-500">{label}</span>
                            </div>
                            {item.status === "uploading" && (
                              <div className="mt-2">
                                <div className="flex justify-between text-xs text-slate-500">
                                  <span>{percent}%</span>
                                  <span>
                                    {prettyBytes(item.transferred)} / {prettyBytes(item.total)}
                                  </span>
                                </div>
                                <div className="mt-1 h-2 rounded-full bg-slate-800">
                                  <div
                                    className="h-2 rounded-full bg-emerald-500"
                                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                                  />
                                </div>
                              </div>
                            )}
                            {item.status === "success" && (
                              <div className="mt-2 text-xs text-emerald-300">Transfer complete.</div>
                            )}
                            {item.status === "error" && (
                              <div className="mt-2 text-xs text-red-400">{item.message || "Transfer failed"}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "share" && (
              <div className="flex flex-1 min-h-0">
                <ShareComposer
                  embedded
                  payload={shareState.payload}
                  shareKey={shareState.shareKey}
                  onClose={() => {
                    setShareState({ payload: null, shareKey: null });
                    setTab("browse");
                  }}
                />
              </div>
            )}

            {tab === "servers" && (
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                    Loading servers…
                  </div>
                }
              >
                <ServerListLazy
                  servers={localServers}
                  selected={selectedServer}
                  onSelect={setSelectedServer}
                  onAdd={handleAddServer}
                  onUpdate={handleUpdateServer}
                  onSave={handleSaveServers}
                  saving={saving}
                  disabled={!signer}
                  onRemove={handleRemoveServer}
                  onToggleAuth={handleToggleRequiresAuth}
                  onToggleSync={handleToggleSync}
                  validationError={serverValidationError}
                />
              </Suspense>
            )}

          </div>
          <footer className="border-t border-slate-800 bg-slate-900/70 px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="status-server" className="text-[11px] uppercase tracking-wide text-slate-300">
                Server
              </label>
              <select
                id="status-server"
                value={statusSelectValue}
                onChange={handleStatusServerChange}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value={ALL_SERVERS_VALUE}>All servers</option>
                {servers.map(server => (
                  <option key={server.url} value={server.url}>
                    {server.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={`flex-1 text-center ${centerClass}`}>{centerMessage ?? ""}</div>
            <div className="ml-auto flex gap-4">
              <span>{statusCount} item{statusCount === 1 ? "" : "s"}</span>
              <span>{prettyBytes(statusSize)}</span>
            </div>
          </footer>
          </div>

          {showAuthPrompt && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-slate-950/80 px-6 text-center backdrop-blur-sm">
              <img src="/bloom.png" alt="Bloom logo" className="w-24 md:w-32 rounded-xl" />
              <p className="text-sm text-slate-200">Connect your Nostr account to use Bloom.</p>
              <button
                onClick={connect}
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
              >
                Connect (NIP-07)
              </button>
            </div>
          )}

          {renameTarget && (
            <EditDialog
              blob={renameTarget}
              alias={renameValue}
              busy={renameBusy}
              error={renameError}
              isMusic={renameIsMusic}
              audioFields={renameAudioFields}
              onAliasChange={handleRenameValueChange}
              onAudioFieldChange={handleRenameAudioFieldChange}
              onSubmit={handleRenameSubmit}
              onCancel={handleRenameCancel}
            />
          )}
        </div>

        {audio.current && (
          <div className="fixed bottom-4 right-4 w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/85 px-4 py-3 text-sm text-slate-200 shadow-lg">
              <div className="flex flex-col gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">Now playing</div>
                  <div className="text-sm font-medium text-slate-100 truncate">
                    {audio.current.title || audio.current.url}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs tabular-nums text-slate-400 w-10">
                    {formatTime(audio.currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={scrubberMax}
                    step={0.1}
                    value={scrubberValue}
                    onChange={handleScrub}
                    disabled={scrubberDisabled}
                    aria-label="Seek through current track"
                    aria-valuetext={formatTime(scrubberValue)}
                    className="flex-1 h-1.5 cursor-pointer appearance-none rounded-full bg-slate-800 accent-emerald-500"
                  />
                  <span className="text-xs tabular-nums text-slate-400 w-10 text-right">
                    {audio.duration > 0 ? formatTime(audio.duration) : "--:--"}
                  </span>
                </div>
                {audio.status === "playing" && audio.visualizerAvailable && (
                  <div className="h-16 rounded-lg border border-slate-800 bg-slate-900/60 px-1 py-2">
                    <AudioVisualizer className="h-full w-full" />
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={audio.previous}
                    disabled={!audio.hasPrevious}
                    className={`p-2 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                      audio.hasPrevious
                        ? "bg-slate-800 hover:bg-slate-700 text-slate-200"
                        : "bg-slate-800/50 text-slate-500 cursor-not-allowed"
                    }`}
                    aria-label="Play previous track"
                  >
                    <PreviousIcon size={18} />
                    <span className="sr-only">Previous</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => audio.toggle(audio.current!, audio.queue)}
                    className={`p-2 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                      audio.status === "playing"
                        ? "bg-emerald-500 text-slate-900 hover:bg-emerald-400"
                        : "bg-slate-800 hover:bg-slate-700 text-slate-200"
                    }`}
                    aria-label={audio.status === "playing" ? "Pause track" : "Play track"}
                  >
                    {audio.status === "playing" ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                    <span className="sr-only">{audio.status === "playing" ? "Pause" : "Play"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={audio.next}
                    disabled={!audio.hasNext}
                    className={`p-2 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                      audio.hasNext
                        ? "bg-slate-800 hover:bg-slate-700 text-slate-200"
                        : "bg-slate-800/50 text-slate-500 cursor-not-allowed"
                    }`}
                    aria-label="Play next track"
                  >
                    <NextIcon size={18} />
                    <span className="sr-only">Next</span>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={audio.toggleRepeatMode}
                    aria-label="Toggle repeat mode"
                    aria-pressed={audio.repeatMode === "track"}
                    className={`p-2 rounded-lg flex items-center justify-center transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                      audio.repeatMode === "track"
                        ? "bg-emerald-700 text-slate-100 hover:bg-emerald-600"
                        : "bg-slate-800 hover:bg-slate-700 text-slate-200"
                    }`}
                  >
                    {audio.repeatMode === "track" ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
                    <span className="sr-only">
                      {audio.repeatMode === "track" ? "Repeat current track" : "Repeat entire queue"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={audio.stop}
                    className="p-2 rounded-lg flex items-center justify-center transition bg-red-900/80 text-slate-100 hover:bg-red-800 focus:outline-none focus:ring-1 focus:ring-red-400"
                    aria-label="Stop playback"
                  >
                    <StopIcon size={18} />
                    <span className="sr-only">Stop</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
