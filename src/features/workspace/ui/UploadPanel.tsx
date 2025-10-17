import React, { useCallback, useId, useMemo, useRef, useState } from "react";
import pLimit from "p-limit";
import type { AxiosProgressEvent } from "axios";
import type { ManagedServer } from "../../../shared/types/servers";
import { useCurrentPubkey, useNdk } from "../../../app/context/NdkContext";
import { uploadBlobToServer, type BlossomBlob } from "../../../shared/api/blossomClient";
import { uploadBlobToNip96 } from "../../../shared/api/nip96Client";
import { uploadBlobToSatellite } from "../../../shared/api/satelliteClient";
import { prettyBytes } from "../../../shared/utils/format";
import { useQueryClient } from "@tanstack/react-query";
import {
  rememberBlobMetadata,
  applyAliasUpdate,
  rememberAudioMetadata,
  sanitizeCoverUrl,
  normalizeFolderPathInput,
  containsReservedFolderSegment,
  type BlobAudioMetadata,
} from "../../../shared/utils/blobMetadataStore";
import { deriveNameFromPath, isPrivateFolderName } from "../../../shared/domain/folderList";
import { buildNip94EventTemplate } from "../../../shared/api/nip94";
import type { ExtractedAudioMetadata } from "../../../shared/utils/audioMetadata";
import { encryptFileForPrivateUpload } from "../../../shared/domain/privateEncryption";
import { usePrivateLibrary } from "../../../app/context/PrivateLibraryContext";
import type { PrivateListEntry } from "../../../shared/domain/privateList";
import { useFolderLists } from "../../../app/context/FolderListContext";
import { loadNdkModule } from "../../../shared/api/ndkModule";
import { FolderIcon, LockIcon, WarningIcon, UploadIcon, EditIcon, TrashIcon } from "../../../shared/ui/icons";

const RESIZE_OPTIONS = [
  { id: 0, label: "Original" },
  { id: 1, label: "Large (2048px)", size: 2048 },
  { id: 2, label: "Medium (1280px)", size: 1280 },
  { id: 3, label: "Small (720px)", size: 720 },
];

let audioMetadataModule: Promise<typeof import("../../../shared/utils/audioMetadata")> | null = null;

const loadAudioMetadataModule = () => {
  if (!audioMetadataModule) {
    audioMetadataModule = import("../../../shared/utils/audioMetadata");
  }
  return audioMetadataModule;
};

let imageUtilsModule: Promise<typeof import("../../../shared/utils/image")> | null = null;

const loadImageUtilsModule = () => {
  if (!imageUtilsModule) {
    imageUtilsModule = import("../../../shared/utils/image");
  }
  return imageUtilsModule;
};

let blurhashModule: Promise<typeof import("../../../shared/utils/blurhash")> | null = null;

const loadBlurhashModule = () => {
  if (!blurhashModule) {
    blurhashModule = import("../../../shared/utils/blurhash");
  }
  return blurhashModule;
};

type UploadEntryKind = "audio" | "image" | "other";

type GenericMetadataFormState = {
  kind: "generic";
  alias: string;
  folder: string;
};

type AudioMetadataFormState = {
  kind: "audio";
  alias: string;
  folder: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  trackNumber: string;
  trackTotal: string;
  durationSeconds: string;
  genre: string;
  year: string;
};

type UploadMetadataFormState = GenericMetadataFormState | AudioMetadataFormState;

type AudioMetadataOverrides = {
  alias?: string;
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  durationSeconds?: number;
  genre?: string;
  year?: number;
  coverUrl?: string;
};

type UploadEntryStatus = "idle" | "uploading" | "success" | "error";

const ENTRY_STATUS_LABEL: Record<UploadEntryStatus, string> = {
  idle: "Ready",
  uploading: "Uploading",
  success: "Uploaded",
  error: "Needs attention",
};

const ENTRY_STATUS_BADGE: Record<UploadEntryStatus, string> = {
  idle: "bg-slate-800 text-slate-300",
  uploading: "bg-emerald-500/20 text-emerald-300",
  success: "bg-emerald-500/20 text-emerald-200",
  error: "bg-red-500/20 text-red-300",
};

const ENTRY_STATUS_HEADING: Record<UploadEntryStatus, string> = {
  uploading: "Uploading",
  idle: "Ready to upload",
  success: "Uploaded",
  error: "Needs attention",
};

const resetEntryProgress = (entry: UploadEntry): UploadEntry => {
  const serverStatuses = Object.keys(entry.serverStatuses).reduce<Record<string, UploadEntryStatus>>((acc, key) => {
    acc[key] = "idle";
    return acc;
  }, {});
  return {
    ...entry,
    status: "idle",
    serverStatuses,
  };
};

type UploadEntry = {
  id: string;
  file: File;
  kind: UploadEntryKind;
  metadata: UploadMetadataFormState;
  extractedAudioMetadata?: ExtractedAudioMetadata | null;
  showMetadata: boolean;
  isPrivate: boolean;
  status: UploadEntryStatus;
  serverStatuses: Record<string, UploadEntryStatus>;
};

type PrivatePreparedInfo = {
  algorithm: string;
  key: string;
  iv: string;
  name?: string;
  type?: string;
  size?: number;
  servers: Set<string>;
  sha256?: string;
  audioMetadata?: BlobAudioMetadata | null;
  folderPath?: string | null;
};

export type TransferState = {
  id: string;
  serverUrl: string;
  fileName: string;
  transferred: number;
  total: number;
  status: "idle" | "uploading" | "success" | "error";
  message?: string;
  kind?: "manual" | "sync" | "transfer";
};

export type UploadPanelProps = {
  servers: ManagedServer[];
  selectedServerUrl?: string | null;
  onUploaded: (success: boolean) => void;
  syncTransfers?: TransferState[];
  defaultFolderPath?: string | null;
};

export const UploadPanel: React.FC<UploadPanelProps> = ({
  servers,
  selectedServerUrl,
  onUploaded,
  syncTransfers = [],
  defaultFolderPath,
}) => {
  const [selectedServers, setSelectedServers] = useState<string[]>(() => {
    if (selectedServerUrl) {
      const match = servers.find(server => server.url === selectedServerUrl);
      if (match) return [match.url];
    }
    return servers.slice(0, 1).map(s => s.url);
  });
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [cleanMetadata, setCleanMetadata] = useState(true);
  const [resizeOption, setResizeOption] = useState(0);
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [entryFilter, setEntryFilter] = useState<"all" | "pending" | "completed" | "errors">("all");
  const [feedback, setFeedback] = useState<{ id: number; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectionRef = useRef(0);
  const dropZoneDescriptionId = useId();
  const queryClient = useQueryClient();
  const { signEventTemplate, ndk, signer, user } = useNdk();
  const { upsertEntries: upsertPrivateEntries, entries: privateLibraryEntries } = usePrivateLibrary();
  const pubkey = useCurrentPubkey();
  const { folders, addBlobToFolder, resolveFolderPath } = useFolderLists();
  const normalizedFolderSuggestion = useMemo(() => {
    if (defaultFolderPath === undefined) return undefined;
    const normalized = normalizeFolderPathInput(defaultFolderPath);
    if (normalized === undefined) return undefined;
    return normalized ?? "";
  }, [defaultFolderPath]);

  const serverMap = useMemo(() => new Map(servers.map(server => [server.url, server])), [servers]);

  const transferMap = useMemo(
    () => new Map([...syncTransfers, ...transfers].map(item => [item.id, item])),
    [syncTransfers, transfers]
  );

  const requiresAuthSelected = useMemo(
    () =>
      selectedServers.some(url => {
        const server = serverMap.get(url);
        if (!server) return false;
        return Boolean(server.requiresAuth);
      }),
    [selectedServers, serverMap]
  );

  const activeSigner = ndk?.signer ?? signer ?? null;
  const signerMissing = requiresAuthSelected && !activeSigner;
  const folderNamesInvalid = useMemo(
    () => entries.some(entry => containsReservedFolderSegment(entry.metadata.folder)),
    [entries]
  );
  const canUpload = !signerMissing && !folderNamesInvalid;
  const hasPendingUploads = useMemo(
    () =>
      entries.some(entry =>
        selectedServers.some(serverUrl => entry.serverStatuses[serverUrl] !== "success")
      ),
    [entries, selectedServers]
  );
  const hasImageEntries = useMemo(() => entries.some(entry => entry.kind === "image"), [entries]);
  const hasCompletedEntries = useMemo(() => entries.some(entry => entry.status === "success"), [entries]);
  const entryCounts = useMemo(() => {
    let pending = 0;
    let completed = 0;
    let errors = 0;
    for (const entry of entries) {
      if (entry.status === "success") {
        completed += 1;
      } else if (entry.status === "error") {
        errors += 1;
      } else {
        pending += 1;
      }
    }
    return { total: entries.length, pending, completed, errors };
  }, [entries]);
  const filteredEntries = useMemo(() => {
    switch (entryFilter) {
      case "pending":
        return entries.filter(entry => entry.status === "idle" || entry.status === "uploading");
      case "completed":
        return entries.filter(entry => entry.status === "success");
      case "errors":
        return entries.filter(entry => entry.status === "error");
      default:
        return entries;
    }
  }, [entries, entryFilter]);
  const sortedEntries = useMemo(() => {
    const statusPriority: Record<UploadEntryStatus, number> = {
      uploading: 0,
      idle: 1,
      error: 2,
      success: 3,
    };
    return [...filteredEntries].sort((a, b) => {
      const diff = statusPriority[a.status] - statusPriority[b.status];
      if (diff !== 0) return diff;
      return a.file.name.localeCompare(b.file.name, undefined, { sensitivity: "base" });
    });
  }, [filteredEntries]);
  const allMetadataExpanded = useMemo(
    () => entries.length > 0 && entries.every(entry => entry.showMetadata),
    [entries]
  );
  const uploadSummary = useMemo(() => {
    if (entries.length === 0) return null;
    const totalBytes = entries.reduce((acc, entry) => acc + entry.file.size, 0);
    const privateCount = entries.reduce((count, entry) => (entry.isPrivate ? count + 1 : count), 0);
    const folderGroupsMap = new Map<
      string,
      {
        key: string;
        label: string;
        invalid: boolean;
        count: number;
      }
    >();
    let noFolderCount = 0;
    for (const entry of entries) {
      const trimmed = entry.metadata.folder?.trim();
      if (!trimmed) {
        noFolderCount += 1;
        continue;
      }
      const normalized = normalizeFolderPathInput(entry.metadata.folder);
      const key = normalized ?? `invalid:${trimmed}`;
      if (!folderGroupsMap.has(key)) {
        folderGroupsMap.set(key, {
          key,
          label: normalized ?? trimmed,
          invalid: !normalized,
          count: 0,
        });
      }
      folderGroupsMap.get(key)!.count += 1;
    }

    return {
      count: entries.length,
      totalBytes,
      privateCount,
      folderGroups: Array.from(folderGroupsMap.values()),
      noFolderCount,
    };
  }, [entries]);

  const [bulkFolderSelector, setBulkFolderSelector] = useState<{ value: string; isPrivate: boolean; error: string | null } | null>(null);

  const formatFolderLabel = useCallback((value: string | null) => {
    if (!value) return "Home";
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0) return "Home";
    return segments.join(" / ");
  }, []);

  const formatPrivateFolderLabel = useCallback((value: string | null) => {
    if (!value) return "Private";
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0) return "Private";
    return `Private / ${segments.join(" / ")}`;
  }, []);

  const publicFolderOptions = useMemo<UploadFolderOption[]>(() => {
    const paths = new Set<string>();
    folders.forEach(record => {
      const normalized = normalizeFolderPathInput(record.path) ?? null;
      if (!normalized) return;
      const name = deriveNameFromPath(normalized);
      if (isPrivateFolderName(name)) return;
      const canonical = resolveFolderPath(normalized);
      if (canonical) {
        paths.add(canonical);
      }
    });
    const sorted = Array.from(paths).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return [
      { value: null, label: "Home" },
      ...sorted.map(path => ({ value: path, label: formatFolderLabel(path) })),
    ];
  }, [folders, formatFolderLabel, resolveFolderPath]);

  const privateFolderOptions = useMemo<UploadFolderOption[]>(() => {
    const paths = new Set<string>();
    privateLibraryEntries.forEach(entry => {
      const raw = entry.metadata?.folderPath;
      if (typeof raw === "string" && raw.trim().length > 0) {
        paths.add(raw.trim());
      }
    });
    const sorted = Array.from(paths).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return [
      { value: null, label: "Private" },
      ...sorted.map(path => ({ value: path, label: formatPrivateFolderLabel(path) })),
    ];
  }, [formatPrivateFolderLabel, privateLibraryEntries]);

  const handleOpenBulkFolderSelector = useCallback(() => {
    if (!entries.length || busy) return;
    const isPrivateBatch = entries.every(entry => entry.isPrivate);
    const firstFolder = entries.find(entry => entry.metadata.folder?.trim())?.metadata.folder.trim() ?? "";
    setBulkFolderSelector({ value: firstFolder, isPrivate: isPrivateBatch, error: null });
  }, [busy, entries]);

  const handleBulkFolderValueChange = useCallback((value: string) => {
    setBulkFolderSelector(prev => (prev ? { ...prev, value, error: null } : prev));
  }, []);

  const handleBulkFolderApply = useCallback(() => {
    if (!bulkFolderSelector) return;
    const raw = bulkFolderSelector.value ?? "";
    const trimmed = raw.trim();
    if (trimmed && containsReservedFolderSegment(trimmed)) {
      setBulkFolderSelector(prev => (prev ? { ...prev, error: 'Folder names cannot include the word "private".' } : prev));
      return;
    }
    let nextFolder = trimmed;
    if (trimmed) {
      const normalized = normalizeFolderPathInput(trimmed);
      if (normalized === null) {
        setBulkFolderSelector(prev => (prev ? { ...prev, error: 'Folder names cannot include the word "private".' } : prev));
        return;
      }
      nextFolder = normalized ?? trimmed;
    }
    setEntries(prev =>
      prev.map(entry => {
        if (entry.metadata.kind === "audio") {
          return resetEntryProgress({ ...entry, metadata: { ...entry.metadata, folder: nextFolder } });
        }
        if (entry.metadata.kind === "generic") {
          return resetEntryProgress({ ...entry, metadata: { ...entry.metadata, folder: nextFolder } });
        }
        return entry;
      })
    );
    setBulkFolderSelector(null);
  }, [bulkFolderSelector, setEntries]);

  const handleCloseBulkFolderSelector = useCallback(() => {
    setBulkFolderSelector(null);
  }, []);

  React.useEffect(() => {
    if (!entries.length) {
      setBulkFolderSelector(null);
    }
  }, [entries.length]);

  React.useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  React.useEffect(() => {
    setSelectedServers(prev => {
      const available = servers.map(server => server.url);
      const filtered = prev.filter(url => available.includes(url));

      if (selectedServerUrl && available.includes(selectedServerUrl)) {
        if (filtered.length === 1 && filtered[0] === selectedServerUrl) {
          return filtered;
        }
        return [selectedServerUrl];
      }

      if (filtered.length > 0) return filtered;

      const fallback = available[0];
      return fallback ? [fallback] : [];
    });
  }, [servers, selectedServerUrl]);

  const toggleServer = (url: string) => {
    setSelectedServers(prev => (prev.includes(url) ? prev.filter(item => item !== url) : [...prev, url]));
  };

  const setEntryServerStatus = useCallback((id: string, serverUrl: string, status: UploadEntryStatus) => {
    setEntries(prev =>
      prev.map(entry =>
        entry.id === id
          ? {
              ...entry,
              serverStatuses: {
                ...entry.serverStatuses,
                [serverUrl]: status,
              },
            }
          : entry
      )
    );
  }, []);

  const removeEntry = useCallback((id: string) => {
    setEntries(prev => {
      const target = prev.find(entry => entry.id === id);
      if (!target) return prev;
      setFeedback({
        id: Date.now(),
        message: `Removed ${target.file.name} from the queue.`,
      });
      return prev.filter(entry => entry.id !== id);
    });
    setTransfers(prev => prev.filter(item => !item.id.endsWith(`-${id}`)));
  }, [setFeedback]);

  const clearCompletedEntries = useCallback(() => {
    setEntries(prev => {
      const completedEntries = prev.filter(entry => entry.status === "success");
      if (completedEntries.length === 0) {
        return prev;
      }
      const suffixes = completedEntries.map(entry => `-${entry.id}`);
      setTransfers(current =>
        current.filter(item => !suffixes.some(suffix => item.id.endsWith(suffix)))
      );
      setFeedback({
        id: Date.now(),
        message: `Cleared ${completedEntries.length} uploaded ${completedEntries.length === 1 ? "file" : "files"}.`,
      });
      return prev.filter(entry => entry.status !== "success");
    });
  }, [setFeedback, setTransfers]);
  const reset = () => {
    setEntries([]);
    setTransfers([]);
    setEntryFilter("all");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setFeedback({
      id: Date.now(),
      message: "Upload queue reset.",
    });
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    const selectionId = ++pendingSelectionRef.current;
    if (!fileList || fileList.length === 0) {
      return;
    }
    const selectedFiles = Array.from(fileList);
    const nextEntries: UploadEntry[] = [];

    for (const file of selectedFiles) {
      const kind = detectEntryKind(file);
      if (kind === "audio") {
        const { extractAudioMetadata } = await loadAudioMetadataModule();
        const extracted = await extractAudioMetadata(file);
        const metadata = createAudioMetadataFormState(file, extracted, normalizedFolderSuggestion);
        nextEntries.push({
          id: createUploadEntryId(),
          file,
          kind,
          metadata,
          extractedAudioMetadata: extracted ?? null,
          showMetadata: false,
          isPrivate: false,
          status: "idle",
          serverStatuses: {},
        });
      } else {
        nextEntries.push({
          id: createUploadEntryId(),
          file,
          kind,
          metadata: createGenericMetadataFormState(file, normalizedFolderSuggestion),
          extractedAudioMetadata: null,
          showMetadata: false,
          isPrivate: false,
          status: "idle",
          serverStatuses: {},
        });
      }
    }

    setEntries(prevEntries => {
      if (pendingSelectionRef.current !== selectionId) {
        return prevEntries;
      }
      return [...prevEntries, ...nextEntries];
    });
  };

  const handlePickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDropZoneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handlePickFiles();
      }
    },
    [handlePickFiles]
  );

  const hasFiles = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return false;
    if (dataTransfer.items && dataTransfer.items.length > 0) {
      return Array.from(dataTransfer.items).some(item => item.kind === "file");
    }
    const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
    if (types.includes("Files")) return true;
    return dataTransfer.files && dataTransfer.files.length > 0;
  }, []);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!hasFiles(event)) return;
      setIsDragActive(true);
    },
    [hasFiles]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!hasFiles(event)) {
        if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
      return;
    }
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    setIsDragActive(true);
  },
    [hasFiles]
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!hasFiles(event)) {
        setIsDragActive(false);
        return;
      }
      setIsDragActive(false);
      const fileList = event.dataTransfer?.files ?? null;
      if (!fileList || fileList.length === 0) return;
      void handleFilesSelected(fileList);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [handleFilesSelected, hasFiles]
  );

  const toggleMetadataVisibility = (id: string) => {
    setEntries(prev => prev.map(entry => (entry.id === id ? { ...entry, showMetadata: !entry.showMetadata } : entry)));
  };

  const setAllMetadataVisibility = (visible: boolean) => {
    setEntries(prev =>
      prev.map(entry => (entry.showMetadata === visible ? entry : { ...entry, showMetadata: visible }))
    );
  };

  const updateEntryMetadata = (
    id: string,
    updater: (metadata: UploadMetadataFormState) => UploadMetadataFormState
  ) => {
    setEntries(prev =>
      prev.map(entry => {
        if (entry.id !== id) return entry;
        const nextMetadata = updater(entry.metadata);
        if (nextMetadata === entry.metadata) return entry;
        return resetEntryProgress({ ...entry, metadata: nextMetadata });
      })
    );
  };

  const updateGenericMetadata = (id: string, changes: Partial<GenericMetadataFormState>) => {
    updateEntryMetadata(id, metadata => {
      if (metadata.kind !== "generic") return metadata;
      return { ...metadata, ...changes };
    });
  };

  const updateAudioMetadata = (id: string, changes: Partial<AudioMetadataFormState>) => {
    updateEntryMetadata(id, metadata => {
      if (metadata.kind !== "audio") return metadata;
      return { ...metadata, ...changes };
    });
  };

  const setEntryPrivacy = (id: string, value: boolean) => {
    setEntries(prev =>
      prev.map(entry => (entry.id === id ? resetEntryProgress({ ...entry, isPrivate: value }) : entry))
    );
  };

  const publishMetadata = async (
    blob: BlossomBlob,
    options: {
      blurHash?: { hash: string; width: number; height: number };
      alias?: string | null;
      extraTags?: string[][];
    } = {}
  ) => {
    if (!ndk || !activeSigner) return;
    const template = buildNip94EventTemplate({
      blob,
      alias: typeof options.alias === "string" ? options.alias : undefined,
      blurhash: options.blurHash,
      extraTags: options.extraTags,
    });
    const { NDKEvent } = await loadNdkModule();
    const event = new NDKEvent(ndk, template);
    await event.sign();
    await event.publish().catch(() => undefined);
  };

  const handleUpload = async (entryIds?: string[]) => {
    if (!entries.length || !selectedServers.length) return;
    if (requiresAuthSelected && !activeSigner) {
      alert("Connect your NIP-07 signer to upload to servers that require auth.");
      return;
    }
    if (folderNamesInvalid) {
      return;
    }
    const privateEntries = entries.filter(entry => entry.isPrivate);
    if (privateEntries.length > 0) {
      if (!ndk || !activeSigner || !user) {
        alert("Marking files as private requires a connected Nostr signer.");
        return;
      }
    }

    const entryIdFilter = entryIds ? new Set(entryIds) : null;

    const targetEntries = entries
      .filter(entry => (entryIdFilter ? entryIdFilter.has(entry.id) : true))
      .map(entry => {
        const pendingServers = selectedServers.filter(serverUrl => entry.serverStatuses[serverUrl] !== "success");
        if (pendingServers.length === 0) return null;
        return { entry, servers: pendingServers };
      })
      .filter((item): item is { entry: UploadEntry; servers: string[] } => item !== null);

    if (targetEntries.length === 0) {
      setFeedback({
        id: Date.now(),
        message: entryIds && entryIds.length === 1 ? "Nothing left to upload for that file." : "All files are already uploaded.",
      });
      return;
    }

    const targetEntryMap = new Map(targetEntries.map(item => [item.entry.id, item.servers] as const));

    setEntries(prev =>
      prev.map(entry => {
        const servers = targetEntryMap.get(entry.id);
        if (!servers) return entry;
        const nextServerStatuses = { ...entry.serverStatuses };
        servers.forEach(serverUrl => {
          nextServerStatuses[serverUrl] = "idle";
        });
        return {
          ...entry,
          status: "uploading",
          serverStatuses: nextServerStatuses,
        };
      })
    );

    setBusy(true);
    const limit = pLimit(2);
    const preparedUploads: { entry: UploadEntry; file: File; buffer: ArrayBuffer; privateInfo?: PrivatePreparedInfo; servers: string[] }[] = [];

    type ImageUtils = Awaited<ReturnType<typeof loadImageUtilsModule>>;
    let imageUtils: ImageUtils | null = null;
    const ensureImageUtils = async () => {
      if (!imageUtils) {
        imageUtils = await loadImageUtilsModule();
      }
      return imageUtils;
    };

    for (const { entry, servers } of targetEntries) {
      let processed = entry.file;
      if (cleanMetadata && entry.kind === "image") {
        const { stripImageMetadata } = await ensureImageUtils();
        processed = await stripImageMetadata(processed);
      }
      const resize = RESIZE_OPTIONS.find(r => r.id === resizeOption && r.size);
      if (resize && entry.kind === "image") {
        const { resizeImage } = await ensureImageUtils();
        processed = await resizeImage(processed, resize.size!, resize.size!);
      }

      if (entry.isPrivate) {
        const encrypted = await encryptFileForPrivateUpload(processed);
        const privateInfo: PrivatePreparedInfo = {
          algorithm: encrypted.metadata.algorithm,
          key: encrypted.metadata.key,
          iv: encrypted.metadata.iv,
          name: encrypted.metadata.originalName,
          type: encrypted.metadata.originalType,
          size: encrypted.metadata.originalSize,
          servers: new Set<string>(),
          folderPath: normalizeFolderPathInput(entry.metadata.folder) ?? null,
        };
        preparedUploads.push({ entry, file: encrypted.file, buffer: encrypted.buffer, privateInfo, servers });
      } else {
        const buffer = await processed.arrayBuffer();
        preparedUploads.push({ entry, file: processed, buffer, servers });
      }
    }

    const blurhashCache = new Map<string, { hash: string; width: number; height: number } | undefined>();
    const pendingPrivateUpdates = new Map<string, PrivateListEntry>();
    const pendingFolderUpdates = new Map<string, string>();

    let encounteredError = false;
    const entryHadError = new Map<string, boolean>();

    type BlurhashUtils = Awaited<ReturnType<typeof loadBlurhashModule>>;
    let blurhashUtils: BlurhashUtils | null = null;
    const ensureBlurhashUtils = async () => {
      if (!blurhashUtils) {
        blurhashUtils = await loadBlurhashModule();
      }
      return blurhashUtils;
    };

    const performUpload = async (
      entry: UploadEntry,
      file: File,
      buffer: ArrayBuffer,
      serverUrl: string,
      privateInfo?: PrivatePreparedInfo
    ) => {
      const server = serverMap.get(serverUrl);
      if (!server) return;
      const clonedBuffer = buffer.slice(0);
      const serverFile = new File([clonedBuffer], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      });
      const transferLabel = resolveEntryDisplayName(entry);
      const transferKey = `${serverUrl}-${entry.id}`;
      setEntryServerStatus(entry.id, serverUrl, "uploading");
      setTransfers(prev => [
        ...prev.filter(t => t.id !== transferKey),
        {
          id: transferKey,
          serverUrl,
          fileName: transferLabel,
          transferred: 0,
          total: serverFile.size,
          status: "uploading",
          kind: "manual",
        },
      ]);
      try {
        const isPrivate = entry.isPrivate && Boolean(privateInfo);
        if (entry.isPrivate && !privateInfo) {
          console.warn("Missing private metadata for entry", entry.id);
        }
        let blurHash: { hash: string; width: number; height: number } | undefined;
        if (entry.kind === "image") {
          blurHash = blurhashCache.get(entry.id);
          if (!blurHash) {
            const { computeBlurhash } = await ensureBlurhashUtils();
            blurHash = await computeBlurhash(serverFile);
            if (blurHash) {
              blurhashCache.set(entry.id, blurHash);
            }
          }
        }
        const requiresAuthForServer = Boolean(server.requiresAuth);
        const handleProgress = (progress: AxiosProgressEvent) => {
          setTransfers(prev =>
            prev.map(item =>
                  item.id === transferKey
                    ? {
                        ...item,
                        transferred: progress.loaded,
                        total: progress.total || serverFile.size,
                      }
                    : item
            )
          );
        };

        let uploaded: BlossomBlob;
        if (server.type === "nip96") {
          uploaded = await uploadBlobToNip96(
            server.url,
            serverFile,
            requiresAuthForServer ? signEventTemplate : undefined,
            requiresAuthForServer,
            handleProgress
          );
        } else if (server.type === "satellite") {
          const satelliteLabel =
            entry.metadata.kind === "audio"
              ? entry.metadata.alias || entry.metadata.title || entry.file.name
              : entry.metadata.kind === "generic"
              ? entry.metadata.alias || entry.file.name
              : entry.file.name;
          uploaded = await uploadBlobToSatellite(
            server.url,
            serverFile,
            requiresAuthForServer ? signEventTemplate : undefined,
            requiresAuthForServer,
            handleProgress,
            { label: satelliteLabel }
          );
        } else {
          uploaded = await uploadBlobToServer(
            server.url,
            serverFile,
            requiresAuthForServer ? signEventTemplate : undefined,
            requiresAuthForServer,
            handleProgress
          );
        }
        const blob: BlossomBlob = {
          ...uploaded,
          name: uploaded.name || entry.file.name,
          type: uploaded.type || serverFile.type || entry.file.type,
        };

        const normalizedFolder = normalizeFolderPathInput(entry.metadata.folder);
        const folderPathValue = normalizedFolder ? resolveFolderPath(normalizedFolder) : null;
        if (normalizedFolder !== undefined) {
          blob.folderPath = folderPathValue;
        }
        if (privateInfo && normalizedFolder !== undefined) {
          privateInfo.folderPath = folderPathValue;
        }

        let aliasForEvent: string | undefined;
        let extraTags: string[][] | undefined;

        const aliasTimestamp = Math.floor(Date.now() / 1000);

        if (entry.metadata.kind === "audio") {
          const overrides = createAudioOverridesFromForm(entry.metadata);
          const audioDetails = buildAudioEventDetails(
            entry.extractedAudioMetadata ?? null,
            blob,
            entry.file.name,
            overrides
          );
          aliasForEvent = audioDetails.alias ?? undefined;
          extraTags = audioDetails.tags;
          rememberAudioMetadata(server.url, blob.sha256, audioDetails.stored ?? null);
          if (audioDetails.alias) {
            blob.name = audioDetails.alias;
            applyAliasUpdate(undefined, blob.sha256, audioDetails.alias, aliasTimestamp);
            if (privateInfo) {
              privateInfo.name = audioDetails.alias;
            }
          }
          if (privateInfo) {
            privateInfo.audioMetadata = audioDetails.stored ?? null;
          }
        } else if (entry.metadata.kind === "generic") {
          const alias = sanitizePart(entry.metadata.alias);
          if (alias) {
            aliasForEvent = alias;
            blob.name = alias;
            applyAliasUpdate(undefined, blob.sha256, alias, aliasTimestamp);
            if (privateInfo) {
              privateInfo.name = alias;
            }
          }
        } else if (privateInfo && !privateInfo.name) {
          privateInfo.name = entry.file.name;
        }

        if (privateInfo) {
          privateInfo.name = privateInfo.name ?? entry.file.name;
          const resolvedType = privateInfo.type ?? entry.file.type ?? blob.type;
          privateInfo.type = resolvedType;
          privateInfo.size = privateInfo.size ?? entry.file.size;
          privateInfo.servers.add(server.url);
          blob.type = resolvedType ?? blob.type;
          blob.privateData = {
            encryption: {
              algorithm: privateInfo.algorithm,
              key: privateInfo.key,
              iv: privateInfo.iv,
            },
            metadata: {
              name: privateInfo.name,
              type: privateInfo.type,
              size: privateInfo.size,
              audio:
                privateInfo.audioMetadata === undefined ? undefined : privateInfo.audioMetadata,
              folderPath: privateInfo.folderPath ?? null,
            },
            servers: Array.from(privateInfo.servers),
          };
        }

        if (folderPathValue !== null) {
          if (!extraTags) {
            extraTags = [];
          }
          extraTags.push(["folder", folderPathValue]);
        }

        rememberBlobMetadata(server.url, blob, { folderPath: folderPathValue });
        if (!isPrivate && folderPathValue) {
          pendingFolderUpdates.set(blob.sha256, folderPathValue);
        }
        if (pubkey) {
          queryClient.setQueryData<BlossomBlob[]>(["server-blobs", server.url, pubkey, server.type], prev => {
            if (!prev) return [blob];
            const index = prev.findIndex(item => item.sha256 === blob.sha256);
            if (index >= 0) {
              const next = [...prev];
              next[index] = { ...prev[index], ...blob };
              return next;
            }
            return [...prev, blob];
          });
        }
        setEntryServerStatus(entry.id, serverUrl, "success");
        setTransfers(prev =>
          prev.map(item => (item.id === transferKey ? { ...item, transferred: item.total, status: "success" } : item))
        );
        if (!isPrivate) {
          await publishMetadata(blob, {
            blurHash,
            alias: aliasForEvent ?? null,
            extraTags,
          });
        } else if (privateInfo) {
          privateInfo.sha256 = blob.sha256;
          pendingPrivateUpdates.set(entry.id, {
            sha256: blob.sha256,
            encryption: {
              algorithm: privateInfo.algorithm,
              key: privateInfo.key,
              iv: privateInfo.iv,
            },
            metadata: {
              name: privateInfo.name,
              type: privateInfo.type,
              size: privateInfo.size,
              audio:
                privateInfo.audioMetadata === undefined ? undefined : privateInfo.audioMetadata,
              folderPath: privateInfo.folderPath ?? null,
            },
            servers: Array.from(privateInfo.servers),
            updatedAt: blob.uploaded ?? Math.floor(Date.now() / 1000),
          });
        }
        queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url, pubkey, server.type] });
      } catch (err: any) {
        encounteredError = true;
        entryHadError.set(entry.id, true);
        setEntryServerStatus(entry.id, serverUrl, "error");
        setTransfers(prev =>
          prev.map(item =>
            item.id === transferKey
              ? {
                  ...item,
                  status: "error",
                  message: err?.message || "Upload failed",
                }
              : item
          )
        );
      }
    };

    await Promise.all(
      preparedUploads.map(({ entry, file, buffer, privateInfo, servers }) =>
        (async () => {
          for (const serverUrl of servers) {
            await limit(() => performUpload(entry, file, buffer, serverUrl, privateInfo));
          }
        })()
      )
    );

    if (pendingFolderUpdates.size > 0) {
      for (const [sha, path] of pendingFolderUpdates) {
        try {
          await addBlobToFolder(path, sha);
        } catch (error) {
          console.warn("Failed to update folder list after upload", error);
        }
      }
    }

    if (pendingPrivateUpdates.size > 0 && ndk && activeSigner && user) {
      try {
        await upsertPrivateEntries(Array.from(pendingPrivateUpdates.values()));
      } catch (error) {
        console.warn("Failed to update private list", error);
      }
    }

    setEntries(prev =>
      prev.map(entry => {
        const servers = targetEntryMap.get(entry.id);
        if (!servers) return entry;
        const hadError = entryHadError.get(entry.id) ?? false;
        return {
          ...entry,
          status: hadError ? "error" : "success",
        };
      })
    );

    setBusy(false);
    onUploaded(!encounteredError);
  };

  const retryEntry = useCallback(
    (id: string) => {
      setEntries(prev =>
        prev.map(entry => {
          if (entry.id !== id) return entry;
          const nextServerStatuses: Record<string, UploadEntryStatus> = { ...entry.serverStatuses };
          selectedServers.forEach(serverUrl => {
            nextServerStatuses[serverUrl] = "idle";
          });
          return {
            ...entry,
            status: "idle",
            serverStatuses: nextServerStatuses,
          };
        })
      );
      setTransfers(prev => prev.filter(item => !item.id.endsWith(`-${id}`)));
      setFeedback({
        id: Date.now(),
        message: "Retry queued.",
      });
      void handleUpload([id]);
    },
    [handleUpload, selectedServers, setFeedback, setTransfers]
  );


  return (
    <section className="relative rounded-2xl border border-slate-800 bg-slate-900/70 p-4 space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Upload Files</h2>
        <p className="text-xs text-slate-400">After adding a file for upload, you will be able to edit metadata before publishing to your selected server. Bloom will automatically post metadata for music files with embedded ID3 tags.</p>
      </header>
      <div className="space-y-3">
        <div className="space-y-2">
          <span className="text-sm text-slate-300">Upload to</span>
          <div className="flex flex-wrap gap-3">
            {servers.map(server => (
              <label key={server.url} className={`px-3 py-2 rounded-xl border text-sm cursor-pointer ${
                selectedServers.includes(server.url)
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-slate-800 bg-slate-900/60"
              }`}>
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={selectedServers.includes(server.url)}
                  onChange={() => toggleServer(server.url)}
                />
                {server.name}
              </label>
            ))}
            {servers.length === 0 && <span className="text-xs text-slate-400">Add a server first.</span>}
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-sm text-slate-300">Files</span>
          <div
            role="button"
            tabIndex={0}
            aria-describedby={dropZoneDescriptionId}
            onClick={handlePickFiles}
            onKeyDown={handleDropZoneKeyDown}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative flex min-h-[32px] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-4 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
              isDragActive
                ? "border-emerald-400 bg-emerald-500/10"
                : entries.length
                ? "border-emerald-500/40 bg-slate-900/60"
                : "border-slate-700 bg-slate-900/60"
            } cursor-pointer hover:border-emerald-400 ${busy ? "opacity-60" : ""}`}
          >
            <UploadIcon size={32} className="text-emerald-300" aria-hidden="true" />
            <div className="text-sm font-semibold text-slate-100">
              {isDragActive ? "Release to add files" : "Drag and drop files here"}
            </div>
            <div id={dropZoneDescriptionId} className="text-xs text-slate-400">
              {busy ? "Uploads are in progress. Finish before adding more files." : "Or click to browse your device"}
            </div>
            <input
              id="upload-panel-input"
              type="file"
              multiple
              ref={fileInputRef}
              onChange={e => {
                setIsDragActive(false);
                void handleFilesSelected(e.target.files);
              }}
              className="sr-only"
              tabIndex={-1}
            />
          </div>
        </div>
        {signerMissing && (
          <div className="text-xs text-red-400">Connect your NIP-07 signer to upload.</div>
        )}
        {folderNamesInvalid && (
          <div className="text-xs text-red-400">Folder names cannot include the word "private".</div>
        )}
        {uploadSummary && entries.length > 1 && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">
                {uploadSummary.count} {uploadSummary.count === 1 ? "file" : "files"} ·{" "}
                {prettyBytes(uploadSummary.totalBytes)}
              </span>
              {uploadSummary.privateCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                  <LockIcon size={14} className="text-emerald-300" />
                  <span>
                    {uploadSummary.privateCount}{" "}
                    {uploadSummary.privateCount === 1 ? "private file" : "private files"}
                  </span>
                </span>
              ) : null}
            </div>
            {(uploadSummary.folderGroups.length > 0 || uploadSummary.noFolderCount > 0) && (
              <div className="flex flex-col gap-1 text-xs text-slate-400">
                {uploadSummary.folderGroups.map(group => (
                  <span
                    key={group.key}
                    className={`inline-flex items-center gap-2 ${
                      group.invalid ? "text-amber-300" : "text-emerald-300"
                    }`}
                  >
                    {group.invalid ? (
                      <WarningIcon size={14} aria-hidden="true" />
                    ) : (
                      <FolderIcon size={14} />
                    )}
                    <span className="font-medium">{group.label}</span>
                    <span className="text-slate-400">
                      · {group.count} {group.count === 1 ? "file" : "files"}
                    </span>
                  </span>
                ))}
                {uploadSummary.noFolderCount > 0 ? (
                  <span className="inline-flex items-center gap-2 text-slate-400">
                    <FolderIcon size={14} className="text-slate-400" />
                    <span className="font-medium text-slate-300">No folder selected</span>
                    <span>· {uploadSummary.noFolderCount} {uploadSummary.noFolderCount === 1 ? "file" : "files"}</span>
                  </span>
                ) : null}
              </div>
            )}
          </div>
        )}
        {entries.length > 0 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/20 px-3 py-1 font-semibold text-emerald-200">
                  Queue {entryCounts.total}
                </span>
                <span className="text-slate-400">
                  {entryCounts.pending} pending · {entryCounts.completed} done · {entryCounts.errors} errors
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {[
                  { id: "all" as const, label: "All", count: entryCounts.total },
                  { id: "pending" as const, label: "Pending", count: entryCounts.pending },
                  { id: "completed" as const, label: "Completed", count: entryCounts.completed },
                  { id: "errors" as const, label: "Errors", count: entryCounts.errors },
                ].map(filter => {
                  const isActive = entryFilter === filter.id;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      onClick={() => setEntryFilter(filter.id)}
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 font-medium transition ${
                        isActive
                          ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                          : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-emerald-400 hover:text-emerald-200"
                      }`}
                    >
                      <span>{filter.label}</span>
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200">
                        {filter.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300">
              <div className="flex flex-wrap items-center gap-2">
                {entries.length > 1 && (
                  <>
                    <span className="font-medium text-slate-400">Bulk actions:</span>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                      onClick={handleOpenBulkFolderSelector}
                      disabled={busy}
                    >
                      Apply folder…
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                      onClick={() => {
                        const shouldSetPrivate = entries.some(entry => !entry.isPrivate);
                        setEntries(prev =>
                          prev.map(entry =>
                            entry.isPrivate === shouldSetPrivate
                              ? entry
                              : resetEntryProgress({ ...entry, isPrivate: shouldSetPrivate })
                          )
                        );
                      }}
                      disabled={busy}
                    >
                      Set {entries.some(entry => !entry.isPrivate) ? "all private" : "all public"}
                    </button>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {entries.length > 1 && (
                  <button
                    type="button"
                    className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    onClick={() => setAllMetadataVisibility(!allMetadataExpanded)}
                    disabled={busy}
                  >
                    {allMetadataExpanded ? "Collapse metadata" : "Expand metadata"}
                  </button>
                )}
                {hasCompletedEntries ? (
                  <button
                    type="button"
                    className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:border-red-500 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={clearCompletedEntries}
                    disabled={busy}
                  >
                    Clear completed
                  </button>
                ) : null}
              </div>
            </div>
            {bulkFolderSelector ? (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
                <div className="w-64 min-w-[16rem]">
                  <UploadFolderSelect
                    value={bulkFolderSelector.value}
                    onChange={handleBulkFolderValueChange}
                    options={bulkFolderSelector.isPrivate ? privateFolderOptions : publicFolderOptions}
                    invalid={Boolean(bulkFolderSelector.error)}
                    customDefaultPath={
                      bulkFolderSelector.value?.trim() ||
                      (bulkFolderSelector.isPrivate ? DEFAULT_PRIVATE_FOLDER_PATH : DEFAULT_PUBLIC_FOLDER_PATH)
                    }
                    placeholder={bulkFolderSelector.isPrivate ? "e.g. Trips/2024" : "e.g. Pictures/2024"}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-emerald-600 px-3 py-1 font-semibold text-slate-900 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={handleBulkFolderApply}
                    disabled={busy}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-700 px-3 py-1 font-medium text-slate-200 transition hover:border-slate-600 hover:text-slate-100"
                    onClick={handleCloseBulkFolderSelector}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
                {bulkFolderSelector.error ? (
                  <span className="text-red-400">{bulkFolderSelector.error}</span>
                ) : (
                  <span className="text-slate-500">
                    {bulkFolderSelector.isPrivate
                      ? "Applies to encrypted uploads in your Private library."
                      : "Organize public uploads across Blossom-compatible servers."}
                  </span>
                )}
              </div>
            ) : null}
            {sortedEntries.length === 0 ? (
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-6 text-center text-xs text-slate-400">
                No files match this view. Try switching filters or add new uploads.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {(() => {
                  const elements: React.ReactNode[] = [];
                  let lastStatus: UploadEntryStatus | null = null;
                  for (const entry of sortedEntries) {
                    const showHeading = entry.status !== lastStatus;
                    if (showHeading) {
                      elements.push(
                        <div
                          key={`heading-${entry.status}`}
                          className="text-xs font-semibold uppercase tracking-wide text-slate-400"
                        >
                          {ENTRY_STATUS_HEADING[entry.status]}
                        </div>
                      );
                      lastStatus = entry.status;
                    }
                    const { file, metadata, kind, showMetadata } = entry;
                    const typeLabel = describeUploadEntryKind(kind);
                    const folderInputValue = metadata.folder?.trim() ?? "";
                    const normalizedFolderPreview = normalizeFolderPathInput(metadata.folder);
                    const folderInvalid = containsReservedFolderSegment(metadata.folder);
                    const effectiveFolderLabel =
                      folderInputValue && normalizedFolderPreview
                        ? normalizedFolderPreview
                        : folderInputValue;
                    const showFolderWarning = Boolean(folderInputValue && (!normalizedFolderPreview || folderInvalid));
                    const showStatusIcons = showFolderWarning || entry.isPrivate;
                    const entryStatusBadge = ENTRY_STATUS_BADGE[entry.status];
                    const entryStatusLabel = ENTRY_STATUS_LABEL[entry.status];
                    const isEntryUploading = entry.status === "uploading";
                    const serverOrder = [...selectedServers, ...Object.keys(entry.serverStatuses)];
                    const seenServers = new Set<string>();
                    const serverDetails = serverOrder.reduce(
                      (acc, serverUrl) => {
                        if (seenServers.has(serverUrl)) return acc;
                        seenServers.add(serverUrl);
                        const serverName = serverMap.get(serverUrl)?.name || serverUrl;
                        const status = entry.serverStatuses[serverUrl] ?? "idle";
                        const transferKey = `${serverUrl}-${entry.id}`;
                        const transfer = transferMap.get(transferKey);
                        const percent =
                          transfer && transfer.total ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : 0;
                        acc.push({ serverUrl, serverName, status, transfer, percent });
                        return acc;
                      },
                      [] as {
                        serverUrl: string;
                        serverName: string;
                        status: UploadEntryStatus;
                        transfer?: TransferState;
                        percent: number;
                      }[]
                    );
                    elements.push(
                      <div
                        key={entry.id}
                        className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3 text-sm text-slate-200 shadow-sm"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-slate-100">{file.name}</div>
                            <div className="text-xs text-slate-400">
                              {typeLabel} • {prettyBytes(file.size)}
                              {file.type ? ` • ${file.type}` : ""}
                            </div>
                            {folderInputValue ? (
                              <div
                                className={`mt-1 text-xs ${
                                  folderInvalid || !normalizedFolderPreview ? "text-amber-300" : "text-emerald-300"
                                }`}
                              >
                                {folderInvalid || !normalizedFolderPreview ? "Invalid folder path" : "Uploading to"}{" "}
                                <span className="font-medium">
                                  {folderInvalid || !normalizedFolderPreview ? folderInputValue : effectiveFolderLabel}
                                </span>
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-400">
                              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${entryStatusBadge}`}>
                                {entryStatusLabel}
                              </span>
                              {showStatusIcons ? (
                                <>
                                  {showFolderWarning ? (
                                    <span className="inline-flex items-center gap-1 text-amber-300">
                                      <WarningIcon size={16} aria-hidden="true" title="Folder path needs attention" />
                                      <span className="sr-only">Folder path needs attention</span>
                                    </span>
                                  ) : null}
                                  {entry.isPrivate ? (
                                    <span className="inline-flex items-center gap-1 text-emerald-300">
                                      <LockIcon size={16} aria-hidden="true" title="Private upload" />
                                      <span className="sr-only">Private upload</span>
                                    </span>
                                  ) : null}
                                </>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => toggleMetadataVisibility(entry.id)}
                                className="flex items-center justify-center rounded-lg border border-slate-700 p-2 text-xs text-slate-200 transition hover:border-emerald-500 hover:text-emerald-400"
                                title={showMetadata ? "Hide metadata" : "Edit metadata"}
                              >
                                <EditIcon size={16} aria-hidden="true" />
                                <span className="sr-only">{showMetadata ? "Hide metadata" : "Edit metadata"}</span>
                              </button>
                              {entry.status === "error" ? (
                                <button
                                  type="button"
                                  onClick={() => retryEntry(entry.id)}
                                  className="rounded-lg border border-amber-500 px-3 py-1 text-xs font-medium uppercase tracking-wide text-amber-200 hover:border-amber-400 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                                  disabled={isEntryUploading}
                                  title="Retry this upload"
                                >
                                  Retry
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => removeEntry(entry.id)}
                                className="flex items-center justify-center rounded-lg border border-slate-700 p-2 text-xs text-slate-200 transition hover:border-red-500 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={isEntryUploading}
                                title="Remove from upload queue"
                              >
                                <TrashIcon size={16} aria-hidden="true" />
                                <span className="sr-only">Remove</span>
                              </button>
                            </div>
                          </div>
                        </div>
                        {serverDetails.length > 0 ? (
                          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
                            {serverDetails.map(detail => {
                              const indicatorClass =
                                detail.status === "error"
                                  ? "bg-red-500"
                                  : detail.status === "success"
                                  ? "bg-emerald-500"
                                  : "bg-emerald-400/70";
                              const progressWidth =
                                detail.status === "success" || detail.status === "error"
                                  ? 100
                                  : detail.percent;
                              return (
                                <div key={`${entry.id}-${detail.serverUrl}`} className="space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="font-medium text-slate-200">{detail.serverName}</span>
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-200">
                                      {ENTRY_STATUS_LABEL[detail.status]}
                                      {detail.status === "uploading" ? ` · ${detail.percent}%` : null}
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
                                    <div className={`h-full ${indicatorClass}`} style={{ width: `${progressWidth}%` }} />
                                  </div>
                                  {detail.transfer && detail.transfer.status === "error" ? (
                                    <div className="text-[11px] text-red-300">
                                      {detail.transfer.message || "Upload failed"}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        <div className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-3">
                          <label className="flex items-start gap-3 text-sm text-slate-200">
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                              checked={entry.isPrivate}
                              onChange={event => setEntryPrivacy(entry.id, event.target.checked)}
                              disabled={isEntryUploading}
                            />
                            <span className="flex flex-col gap-1 text-left">
                              <span className="font-medium text-slate-100">Private upload</span>
                              <span className="text-xs leading-relaxed text-slate-400">
                                Encrypts the file on your device. Private files cannot be shared publicly as they require your
                                private key to decrypt.
                              </span>
                            </span>
                          </label>
                        </div>
                        {showMetadata ? (
                          <div className="space-y-3">
                            {metadata.kind === "audio" ? (
                              <AudioMetadataForm
                                metadata={metadata}
                                onChange={changes => updateAudioMetadata(entry.id, changes)}
                                folderOptions={entry.isPrivate ? privateFolderOptions : publicFolderOptions}
                                isPrivate={entry.isPrivate}
                                disabled={isEntryUploading}
                              />
                            ) : (
                              <GenericMetadataForm
                                metadata={metadata}
                                onChange={changes => updateGenericMetadata(entry.id, changes)}
                                folderOptions={entry.isPrivate ? privateFolderOptions : publicFolderOptions}
                                isPrivate={entry.isPrivate}
                                disabled={isEntryUploading}
                              />
                            )}
                          </div>
                        ) : metadata.kind === "audio" ? (
                          <div className="text-xs text-slate-400">
                            Metadata detected{entry.extractedAudioMetadata ? " from the file." : "."} Click "Edit metadata" to review.
                          </div>
                        ) : (
                          <div className="text-xs text-slate-400">
                            Click "Edit metadata" to override the display name, upload location, and other file specific metadata.
                          </div>
                        )}
                      </div>
                    );
                  }
                  return elements;
                })()}
              </div>
            )}
          </div>
        ) : null}
        {entries.length > 0 && hasImageEntries && (
          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cleanMetadata} onChange={e => setCleanMetadata(e.target.checked)} />
              Remove EXIF metadata from images
            </label>
            <label className="flex items-center gap-2">
              <span>Resize:</span>
              <select value={resizeOption} onChange={e => setResizeOption(Number(e.target.value))} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-sm">
                {RESIZE_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => handleUpload()}
            disabled={!entries.length || !selectedServers.length || busy || !canUpload || !hasPendingUploads}
            title="Upload selected files"
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <UploadIcon size={18} aria-hidden="true" />
            <span>{busy ? "Uploading…" : "Upload"}</span>
          </button>
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy}
            title="Reset upload queue"
          >
            <TrashIcon size={18} aria-hidden="true" />
            <span>Reset</span>
          </button>
        </div>
      </div>
      {transfers.length + syncTransfers.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2 text-xs text-slate-300">
          {Array.from(new Map([...syncTransfers, ...transfers].map(item => [item.id, item])).values()).map(item => {
            const serverName = serverMap.get(item.serverUrl)?.name || item.serverUrl;
            const percentRaw = item.total ? (item.transferred / item.total) * 100 : item.status === "success" ? 100 : 0;
            const percent = Math.min(100, Math.max(0, Math.round(percentRaw)));
            return (
              <div key={item.id} className="space-y-1">
                <div className="flex justify-between">
                  <span>{item.fileName}</span>
                  <span>
                  {item.status === "uploading" && `${percent}%`}
                  {item.status === "success" && "done"}
                  {item.status === "error" && (item.message || "error")}
                </span>
              </div>
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div
                  className={`h-full ${item.status === "error" ? "bg-red-500" : "bg-emerald-500"}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="text-slate-300">{serverName}</div>
            </div>
            );
          })}
        </div>
      )}
      {feedback ? (
        <div className="pointer-events-none absolute bottom-4 right-4 z-50">
          <div className="pointer-events-auto rounded-lg border border-emerald-400/60 bg-slate-900/90 px-4 py-2 text-sm text-emerald-100 shadow-lg backdrop-blur">
            {feedback.message}
          </div>
        </div>
      ) : null}
    </section>
  );
};

type UploadFolderOption = {
  value: string | null;
  label: string;
};

const HOME_FOLDER_OPTION_VALUE = "__upload_folder_home__";
const CUSTOM_FOLDER_OPTION_VALUE = "__upload_folder_custom__";
const DEFAULT_PUBLIC_FOLDER_PATH = "Images/Trips";
const DEFAULT_PRIVATE_FOLDER_PATH = "Trips";

type GenericMetadataFormProps = {
  metadata: GenericMetadataFormState;
  onChange: (changes: Partial<GenericMetadataFormState>) => void;
  folderOptions: UploadFolderOption[];
  isPrivate: boolean;
  disabled?: boolean;
};

const inputClasses =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

const invalidInputClasses =
  "mt-1 w-full rounded-lg border border-red-500 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500";

type UploadFolderSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: UploadFolderOption[];
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  customOptionLabel?: string;
  customDefaultPath?: string;
};

const UploadFolderSelect: React.FC<UploadFolderSelectProps> = ({
  value,
  onChange,
  options,
  invalid = false,
  disabled = false,
  placeholder = "e.g. Pictures/2024",
  customOptionLabel = "Custom folder…",
  customDefaultPath = DEFAULT_PUBLIC_FOLDER_PATH,
}) => {
  const normalizedValue = value?.trim() ?? "";
  const normalizedOptions = useMemo(
    () =>
      options.map(option => ({
        id: option.value === null ? HOME_FOLDER_OPTION_VALUE : option.value,
        label: option.label,
      })),
    [options]
  );

  const optionIds = useMemo(() => new Set(normalizedOptions.map(option => option.id)), [normalizedOptions]);

  const selectValue = normalizedValue === ""
    ? HOME_FOLDER_OPTION_VALUE
    : optionIds.has(normalizedValue)
      ? normalizedValue
      : CUSTOM_FOLDER_OPTION_VALUE;

  const [customValue, setCustomValue] = useState(() =>
    selectValue === CUSTOM_FOLDER_OPTION_VALUE ? normalizedValue || customDefaultPath : customDefaultPath
  );

  React.useEffect(() => {
    if (selectValue === CUSTOM_FOLDER_OPTION_VALUE) {
      setCustomValue(normalizedValue || customDefaultPath);
    }
  }, [customDefaultPath, normalizedValue, selectValue]);

  const handleSelectChange: React.ChangeEventHandler<HTMLSelectElement> = event => {
    const next = event.target.value;
    if (next === HOME_FOLDER_OPTION_VALUE) {
      onChange("");
      return;
    }
    if (next === CUSTOM_FOLDER_OPTION_VALUE) {
      const fallback = normalizedValue && !optionIds.has(normalizedValue) ? normalizedValue : customDefaultPath;
      setCustomValue(fallback);
      onChange(fallback);
      return;
    }
    onChange(next);
  };

  const handleCustomChange: React.ChangeEventHandler<HTMLInputElement> = event => {
    const next = event.target.value;
    setCustomValue(next);
    onChange(next);
  };

  const selectClassName = invalid ? invalidInputClasses : inputClasses;
  const inputClassName = invalid ? invalidInputClasses : inputClasses;

  return (
    <div className="space-y-2">
      <select
        value={selectValue}
        onChange={handleSelectChange}
        disabled={disabled}
        className={selectClassName}
      >
        {normalizedOptions.map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        <option value={CUSTOM_FOLDER_OPTION_VALUE}>{customOptionLabel}</option>
      </select>
      {selectValue === CUSTOM_FOLDER_OPTION_VALUE ? (
        <input
          type="text"
          value={customValue}
          onChange={handleCustomChange}
          disabled={disabled}
          placeholder={placeholder}
          className={inputClassName}
        />
      ) : null}
    </div>
  );
};

const GenericMetadataForm: React.FC<GenericMetadataFormProps> = ({ metadata, onChange, folderOptions, isPrivate, disabled = false }) => {
  const folderInvalid = containsReservedFolderSegment(metadata.folder);
  const customDefaultPath = metadata.folder?.trim() || (isPrivate ? DEFAULT_PRIVATE_FOLDER_PATH : DEFAULT_PUBLIC_FOLDER_PATH);

  return (
    <div className="space-y-2">
      <label className="block text-xs uppercase text-slate-400">
        Display name
        <input
          className={inputClasses}
          value={metadata.alias}
          onChange={event => onChange({ alias: event.target.value })}
          placeholder="Friendly name"
          disabled={disabled}
        />
      </label>
      <div className="space-y-1">
        <span className="block text-xs uppercase text-slate-400">Folder</span>
        <UploadFolderSelect
          value={metadata.folder}
          onChange={folder => onChange({ folder })}
          options={folderOptions}
          invalid={folderInvalid}
          customDefaultPath={customDefaultPath}
          placeholder={isPrivate ? "e.g. Trips/2024" : "e.g. Pictures/2024"}
          disabled={disabled}
        />
        {folderInvalid && (
          <p className="mt-1 text-xs text-red-400">Folder names cannot include the word "private".</p>
        )}
      </div>
      <p className="text-xs text-slate-500">The display name will be included in the metadata event.</p>
    </div>
  );
};

type AudioMetadataFormProps = {
  metadata: AudioMetadataFormState;
  onChange: (changes: Partial<AudioMetadataFormState>) => void;
  folderOptions: UploadFolderOption[];
  isPrivate: boolean;
  disabled?: boolean;
};

const AudioMetadataForm: React.FC<AudioMetadataFormProps> = ({ metadata, onChange, folderOptions, isPrivate, disabled = false }) => {
  const folderInvalid = containsReservedFolderSegment(metadata.folder);
  const customDefaultPath = metadata.folder?.trim() || (isPrivate ? DEFAULT_PRIVATE_FOLDER_PATH : DEFAULT_PUBLIC_FOLDER_PATH);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-xs uppercase text-slate-400">
          Display name
          <input
            className={inputClasses}
            value={metadata.alias}
            onChange={event => onChange({ alias: event.target.value })}
            placeholder="Artist - Title"
            disabled={disabled}
          />
        </label>
        <div className="space-y-1 text-xs uppercase text-slate-400">
          <span>Folder</span>
          <UploadFolderSelect
            value={metadata.folder}
            onChange={folder => onChange({ folder })}
            options={folderOptions}
            invalid={folderInvalid}
            customDefaultPath={customDefaultPath}
            placeholder={isPrivate ? "e.g. Trips/2024" : "e.g. Videos/Chernobyl"}
            disabled={disabled}
          />
          {folderInvalid && (
            <p className="mt-1 text-xs text-red-400">Folder names cannot include the word "private".</p>
          )}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-xs uppercase text-slate-400">
          Title
          <input
            className={inputClasses}
            value={metadata.title}
            onChange={event => onChange({ title: event.target.value })}
            placeholder="Track title"
            disabled={disabled}
          />
        </label>
        <label className="block text-xs uppercase text-slate-400">
          Artist
          <input
            className={inputClasses}
            value={metadata.artist}
            onChange={event => onChange({ artist: event.target.value })}
            placeholder="Artist"
            disabled={disabled}
          />
        </label>
        <label className="block text-xs uppercase text-slate-400">
          Album
          <input
            className={inputClasses}
            value={metadata.album}
            onChange={event => onChange({ album: event.target.value })}
            placeholder="Album"
            disabled={disabled}
          />
        </label>
        <label className="block text-xs uppercase text-slate-400 md:col-span-2">
          Cover URL
          <input
            className={inputClasses}
            value={metadata.coverUrl}
            onChange={event => onChange({ coverUrl: event.target.value })}
            placeholder="https://example.com/cover.jpg"
            type="url"
            inputMode="url"
            pattern="https?://.*"
            disabled={disabled}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block text-xs uppercase text-slate-400">
          Track #
          <input
            className={inputClasses}
            value={metadata.trackNumber}
            onChange={event => onChange({ trackNumber: event.target.value })}
            inputMode="numeric"
            placeholder="e.g. 1"
            disabled={disabled}
          />
        </label>
        <label className="block text-xs uppercase text-slate-400">
          Track total
          <input
            className={inputClasses}
            value={metadata.trackTotal}
            onChange={event => onChange({ trackTotal: event.target.value })}
            inputMode="numeric"
            placeholder="e.g. 12"
            disabled={disabled}
          />
        </label>
        <label className="block text-xs uppercase text-slate-400">
          Duration (seconds)
          <input
            className={inputClasses}
            value={metadata.durationSeconds}
            onChange={event => onChange({ durationSeconds: event.target.value })}
            inputMode="numeric"
            placeholder="e.g. 215"
            disabled={disabled}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-xs uppercase text-slate-400">
          Genre
          <input
            className={inputClasses}
            value={metadata.genre}
            onChange={event => onChange({ genre: event.target.value })}
            placeholder="Genre"
            disabled={disabled}
          />
        </label>
        <label className="block text-xs uppercase text-slate-400">
          Year
          <input
            className={inputClasses}
            value={metadata.year}
            onChange={event => onChange({ year: event.target.value })}
            inputMode="numeric"
            placeholder="e.g. 2024"
            disabled={disabled}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">These details will be published with the upload and saved locally.</p>
    </div>
  );
};

type AudioEventDetails = {
  alias?: string;
  tags?: string[][];
  stored?: BlobAudioMetadata | null;
};

const buildAudioEventDetails = (
  metadata: ExtractedAudioMetadata | null,
  blob: BlossomBlob,
  fallbackFileName: string,
  overrides?: AudioMetadataOverrides
): AudioEventDetails => {
  const fallback = blob.name || fallbackFileName;
  const resolvedTitleSource = overrides?.title ?? metadata?.title;
  const title = deriveTitle(resolvedTitleSource, fallback);
  const artist = sanitizePart(overrides?.artist ?? metadata?.artist);
  const album = sanitizePart(overrides?.album ?? metadata?.album);
  const trackNumber = normalizePositiveInteger(overrides?.trackNumber ?? metadata?.trackNumber);
  const trackTotal = normalizePositiveInteger(overrides?.trackTotal ?? metadata?.trackTotal);
  const durationSeconds = normalizePositiveInteger(overrides?.durationSeconds ?? metadata?.durationSeconds);
  const genre = sanitizePart(overrides?.genre ?? metadata?.genre);
  const year = normalizePositiveInteger(overrides?.year ?? metadata?.year);
  const coverUrl = sanitizeCoverUrl(overrides?.coverUrl);

  let alias = overrides?.alias;
  if (alias === undefined || alias === null) {
    alias = artist ? `${artist} - ${title}` : title;
  }

  const tags: string[][] = [["title", title]];
  const stored: BlobAudioMetadata = { title };

  if (artist) {
    tags.push(["artist", artist]);
    stored.artist = artist;
  }
  if (album) {
    tags.push(["album", album]);
    stored.album = album;
  }
  if (trackNumber) {
    const trackValue = trackTotal ? `${trackNumber}/${trackTotal}` : String(trackNumber);
    tags.push(["track", trackValue]);
    stored.trackNumber = trackNumber;
    if (trackTotal) {
      stored.trackTotal = trackTotal;
    }
  } else if (trackTotal) {
    stored.trackTotal = trackTotal;
  }
  if (durationSeconds) {
    tags.push(["duration", String(durationSeconds)]);
    stored.durationSeconds = durationSeconds;
  }
  if (genre) {
    tags.push(["genre", genre]);
    stored.genre = genre;
  }
  if (year) {
    tags.push(["year", String(year)]);
    stored.year = year;
  }
  if (coverUrl) {
    tags.push(["cover", coverUrl]);
    stored.coverUrl = coverUrl;
  }

  return { alias, tags, stored };
};

const deriveTitle = (candidate: string | undefined, fallback: string): string => {
  const sanitized = sanitizePart(candidate);
  if (sanitized) return sanitized;
  const fallbackName = sanitizePart(fallback) ?? "Untitled";
  return fallbackName;
};

const sanitizePart = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizePositiveInteger = (value: number | undefined | null): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
};

const AUDIO_EXTENSIONS = [".mp3", ".aac", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".oga", ".alac", ".aiff"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".tiff"];

const detectEntryKind = (file: File): UploadEntryKind => {
  const mimeType = (file.type || "").toLowerCase();
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  const name = file.name.toLowerCase();
  if (AUDIO_EXTENSIONS.some(ext => name.endsWith(ext))) return "audio";
  if (IMAGE_EXTENSIONS.some(ext => name.endsWith(ext))) return "image";
  return "other";
};

const createUploadEntryId = () => {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const stripExtension = (fileName: string) => fileName.replace(/\.[^/.]+$/, "");

const createGenericMetadataFormState = (file: File, initialFolder?: string): GenericMetadataFormState => {
  const withoutExt = stripExtension(file.name);
  const alias = sanitizePart(withoutExt) ?? sanitizePart(file.name) ?? "Untitled";
  return {
    kind: "generic",
    alias,
    folder: initialFolder ?? "",
  };
};

const createAudioMetadataFormState = (
  file: File,
  extracted: ExtractedAudioMetadata | null | undefined,
  initialFolder?: string
): AudioMetadataFormState => {
  const fallbackAlias = stripExtension(file.name);
  const title = deriveTitle(extracted?.title, fallbackAlias);
  const artist = sanitizePart(extracted?.artist);
  const alias = artist ? `${artist} - ${title}` : title;
  return {
    kind: "audio",
    alias,
    folder: initialFolder ?? "",
    title: extracted?.title ?? "",
    artist: artist ?? "",
    album: extracted?.album ?? "",
    coverUrl: "",
    trackNumber: extracted?.trackNumber ? String(extracted.trackNumber) : "",
    trackTotal: extracted?.trackTotal ? String(extracted.trackTotal) : "",
    durationSeconds: extracted?.durationSeconds ? String(extracted.durationSeconds) : "",
    genre: extracted?.genre ?? "",
    year: extracted?.year ? String(extracted.year) : "",
  };
};

const describeUploadEntryKind = (kind: UploadEntryKind) => {
  switch (kind) {
    case "audio":
      return "Audio";
    case "image":
      return "Image";
    default:
      return "File";
  }
};

const parsePositiveIntegerInput = (value: string): number | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : undefined;
};

const createAudioOverridesFromForm = (form: AudioMetadataFormState): AudioMetadataOverrides => {
  const overrides: AudioMetadataOverrides = {};
  const alias = sanitizePart(form.alias);
  if (alias) overrides.alias = alias;
  const title = sanitizePart(form.title);
  if (title) overrides.title = title;
  const artist = sanitizePart(form.artist);
  if (artist) overrides.artist = artist;
  const album = sanitizePart(form.album);
  if (album) overrides.album = album;
  const trackNumber = parsePositiveIntegerInput(form.trackNumber);
  if (trackNumber) overrides.trackNumber = trackNumber;
  const trackTotal = parsePositiveIntegerInput(form.trackTotal);
  if (trackTotal) overrides.trackTotal = trackTotal;
  const durationSeconds = parsePositiveIntegerInput(form.durationSeconds);
  if (durationSeconds) overrides.durationSeconds = durationSeconds;
  const genre = sanitizePart(form.genre);
  if (genre) overrides.genre = genre;
  const year = parsePositiveIntegerInput(form.year);
  if (year) overrides.year = year;
  const coverUrl = sanitizeCoverUrl(form.coverUrl);
  if (coverUrl) overrides.coverUrl = coverUrl;
  return overrides;
};

const resolveEntryDisplayName = (entry: UploadEntry): string => {
  if (entry.metadata.kind === "audio") {
    const alias = sanitizePart(entry.metadata.alias);
    if (alias) return alias;
    const title = deriveTitle(entry.metadata.title, entry.file.name);
    const artist = sanitizePart(entry.metadata.artist);
    return artist ? `${artist} - ${title}` : title;
  }
  if (entry.metadata.kind === "generic") {
    const alias = sanitizePart(entry.metadata.alias);
    if (alias) return alias;
  }
  return entry.file.name;
};
