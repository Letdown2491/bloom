import React, { useMemo, useRef, useState } from "react";
import pLimit from "p-limit";
import type { AxiosProgressEvent } from "axios";
import type { ManagedServer } from "../hooks/useServers";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { uploadBlobToServer, type BlossomBlob } from "../lib/blossomClient";
import { uploadBlobToNip96 } from "../lib/nip96Client";
import { uploadBlobToSatellite } from "../lib/satelliteClient";
import { resizeImage, stripImageMetadata } from "../utils/image";
import { computeBlurhash } from "../utils/blurhash";
import { prettyBytes } from "../utils/format";
import { useQueryClient } from "@tanstack/react-query";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import {
  rememberBlobMetadata,
  applyAliasUpdate,
  rememberAudioMetadata,
  type BlobAudioMetadata,
} from "../utils/blobMetadataStore";
import { buildNip94EventTemplate } from "../lib/nip94";
import { extractAudioMetadata, type ExtractedAudioMetadata } from "../utils/audioMetadata";

const RESIZE_OPTIONS = [
  { id: 0, label: "Original" },
  { id: 1, label: "Large (2048px)", size: 2048 },
  { id: 2, label: "Medium (1280px)", size: 1280 },
  { id: 3, label: "Small (720px)", size: 720 },
];

type UploadEntryKind = "audio" | "image" | "other";

type GenericMetadataFormState = {
  kind: "generic";
  alias: string;
};

type AudioMetadataFormState = {
  kind: "audio";
  alias: string;
  title: string;
  artist: string;
  album: string;
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
};

type UploadEntry = {
  id: string;
  file: File;
  kind: UploadEntryKind;
  metadata: UploadMetadataFormState;
  extractedAudioMetadata?: ExtractedAudioMetadata | null;
  showMetadata: boolean;
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
};

export const UploadPanel: React.FC<UploadPanelProps> = ({
  servers,
  selectedServerUrl,
  onUploaded,
  syncTransfers = [],
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectionRef = useRef(0);
  const queryClient = useQueryClient();
  const { signEventTemplate, ndk } = useNdk();
  const pubkey = useCurrentPubkey();

  const serverMap = useMemo(() => new Map(servers.map(server => [server.url, server])), [servers]);

  const requiresAuthSelected = useMemo(
    () =>
      selectedServers.some(url => {
        const server = serverMap.get(url);
        if (!server) return false;
        return server.type === "satellite" || Boolean(server.requiresAuth);
      }),
    [selectedServers, serverMap]
  );

  const canUpload = requiresAuthSelected ? Boolean(ndk?.signer) : true;
  const hasImageEntries = useMemo(() => entries.some(entry => entry.kind === "image"), [entries]);

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

  const reset = () => {
    setEntries([]);
    setTransfers([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    const selectionId = ++pendingSelectionRef.current;
    if (!fileList || fileList.length === 0) {
      setEntries([]);
      return;
    }
    const selectedFiles = Array.from(fileList);
    const nextEntries: UploadEntry[] = [];

    for (const file of selectedFiles) {
      const kind = detectEntryKind(file);
      if (kind === "audio") {
        const extracted = await extractAudioMetadata(file);
        const metadata = createAudioMetadataFormState(file, extracted);
        nextEntries.push({
          id: createUploadEntryId(),
          file,
          kind,
          metadata,
          extractedAudioMetadata: extracted ?? null,
          showMetadata: false,
        });
      } else {
        nextEntries.push({
          id: createUploadEntryId(),
          file,
          kind,
          metadata: createGenericMetadataFormState(file),
          extractedAudioMetadata: null,
          showMetadata: false,
        });
      }
    }

    if (pendingSelectionRef.current === selectionId) {
      setEntries(nextEntries);
    }
  };

  const toggleMetadataVisibility = (id: string) => {
    setEntries(prev => prev.map(entry => (entry.id === id ? { ...entry, showMetadata: !entry.showMetadata } : entry)));
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
        return { ...entry, metadata: nextMetadata };
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

  const publishMetadata = async (
    blob: BlossomBlob,
    options: {
      blurHash?: { hash: string; width: number; height: number };
      alias?: string | null;
      extraTags?: string[][];
    } = {}
  ) => {
    if (!ndk || !ndk.signer) return;
    const template = buildNip94EventTemplate({
      blob,
      alias: typeof options.alias === "string" ? options.alias : undefined,
      blurhash: options.blurHash,
      extraTags: options.extraTags,
    });
    const event = new NDKEvent(ndk, template);
    await event.sign();
    await event.publish().catch(() => undefined);
  };

  const handleUpload = async () => {
    if (!entries.length || !selectedServers.length) return;
    if (requiresAuthSelected && !ndk?.signer) {
      alert("Connect your NIP-07 signer to upload to servers that require auth.");
      return;
    }
    setBusy(true);
    const limit = pLimit(2);
    const preparedUploads: { entry: UploadEntry; file: File }[] = [];

    for (const entry of entries) {
      let processed = entry.file;
      if (cleanMetadata && entry.kind === "image") {
        processed = await stripImageMetadata(processed);
      }
      const resize = RESIZE_OPTIONS.find(r => r.id === resizeOption && r.size);
      if (resize && entry.kind === "image") {
        processed = await resizeImage(processed, resize.size!, resize.size!);
      }
      preparedUploads.push({ entry, file: processed });
    }

    const blurhashCache = new Map<string, { hash: string; width: number; height: number } | undefined>();

    let encounteredError = false;

    await Promise.all(
      preparedUploads.map(({ entry, file }) =>
        Promise.all(
          selectedServers.map(serverUrl =>
            limit(async () => {
              const server = serverMap.get(serverUrl);
              if (!server) return;
              const transferLabel = resolveEntryDisplayName(entry);
              const transferKey = `${serverUrl}-${entry.id}`;
              setTransfers(prev => [
                ...prev.filter(t => t.id !== transferKey),
                {
                  id: transferKey,
                  serverUrl,
                  fileName: transferLabel,
                  transferred: 0,
                  total: file.size,
                  status: "uploading",
                  kind: "manual",
                },
              ]);
              try {
                const blurHash = entry.kind === "image"
                  ? blurhashCache.get(entry.id) ?? (await computeBlurhash(file))
                  : undefined;
                if (!blurhashCache.has(entry.id)) {
                  blurhashCache.set(entry.id, blurHash);
                }
                const requiresAuthForServer = server.type === "satellite" || Boolean(server.requiresAuth);
                const handleProgress = (progress: AxiosProgressEvent) => {
                  setTransfers(prev =>
                    prev.map(item =>
                      item.id === transferKey
                        ? {
                            ...item,
                            transferred: progress.loaded,
                            total: progress.total || file.size,
                          }
                        : item
                    )
                  );
                };

                let uploaded: BlossomBlob;
                if (server.type === "nip96") {
                  uploaded = await uploadBlobToNip96(
                    server.url,
                    file,
                    requiresAuthForServer ? signEventTemplate : undefined,
                    requiresAuthForServer,
                    handleProgress
                  );
                } else if (server.type === "satellite") {
                  uploaded = await uploadBlobToSatellite(
                    server.url,
                    file,
                    signEventTemplate,
                    true,
                    handleProgress
                  );
                } else {
                  uploaded = await uploadBlobToServer(
                    server.url,
                    file,
                    requiresAuthForServer ? signEventTemplate : undefined,
                    requiresAuthForServer,
                    handleProgress
                  );
                }
                const blob: BlossomBlob = {
                  ...uploaded,
                  name: uploaded.name || entry.file.name,
                  type: uploaded.type || file.type || entry.file.type,
                };

                let aliasForEvent: string | undefined;
                let extraTags: string[][] | undefined;

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
                  if (audioDetails.alias) {
                    blob.name = audioDetails.alias;
                  }
                  rememberAudioMetadata(server.url, blob.sha256, audioDetails.stored ?? null);
                  if (audioDetails.alias) {
                    applyAliasUpdate(undefined, blob.sha256, audioDetails.alias, Math.floor(Date.now() / 1000));
                  }
                } else if (entry.metadata.kind === "generic") {
                  const alias = sanitizePart(entry.metadata.alias);
                  if (alias) {
                    aliasForEvent = alias;
                    blob.name = alias;
                    applyAliasUpdate(undefined, blob.sha256, alias, Math.floor(Date.now() / 1000));
                  }
                }

                rememberBlobMetadata(server.url, blob);
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
                setTransfers(prev =>
                  prev.map(item => (item.id === transferKey ? { ...item, transferred: item.total, status: "success" } : item))
                );
                await publishMetadata(blob, {
                  blurHash,
                  alias: aliasForEvent ?? null,
                  extraTags,
                });
                queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url, pubkey, server.type] });
              } catch (err: any) {
                encounteredError = true;
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
            })
          )
        )
      )
    );

    setBusy(false);
    onUploaded(!encounteredError);
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Upload Files</h2>
        <p className="text-xs text-slate-400">After adding a file for upload, you will be able to edit metadata before publishing to your selected server. Bloom will automatically post metadata for music files with embedded ID3 tags.</p>
      </header>
      <div className="space-y-3">
        <div>
          <label className="text-sm text-slate-300">Choose files</label>
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={e => {
              void handleFilesSelected(e.target.files);
            }}
            className="mt-1 w-full"
          />
          {!canUpload && (
            <div className="mt-2 text-xs text-red-400">Connect your NIP-07 signer to upload.</div>
          )}
          {entries.length > 0 && (
            <div className="mt-2 text-xs text-slate-400">
              {entries.length} file(s), total {prettyBytes(entries.reduce((acc, item) => acc + item.file.size, 0))}
            </div>
          )}
        </div>
        {entries.length > 0 && (
          <div className="space-y-3">
            {entries.map(entry => {
              const { file, metadata, kind, showMetadata } = entry;
              const typeLabel = describeUploadEntryKind(kind);
              return (
                <div
                  key={entry.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3 text-sm text-slate-200"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-slate-100">{file.name}</div>
                      <div className="text-xs text-slate-400">
                        {typeLabel} • {prettyBytes(file.size)}
                        {file.type ? ` • ${file.type}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleMetadataVisibility(entry.id)}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-200 hover:border-emerald-500 hover:text-emerald-400"
                    >
                      {showMetadata ? "Hide metadata" : "Edit metadata"}
                    </button>
                  </div>
                  {showMetadata ? (
                    <div className="space-y-3">
                      {metadata.kind === "audio" ? (
                        <AudioMetadataForm
                          metadata={metadata}
                          onChange={(changes) => updateAudioMetadata(entry.id, changes)}
                        />
                      ) : (
                        <GenericMetadataForm
                          metadata={metadata}
                          onChange={(changes) => updateGenericMetadata(entry.id, changes)}
                        />
                      )}
                    </div>
                  ) : metadata.kind === "audio" ? (
                    <div className="text-xs text-slate-400">
                      Metadata detected{entry.extractedAudioMetadata ? " from the file." : "."} Click "Edit metadata" to review.
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400">Click "Edit metadata" to override the display name.</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {hasImageEntries && (
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
        <div className="flex gap-3">
          <button
            onClick={handleUpload}
            disabled={!entries.length || !selectedServers.length || busy || !canUpload}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
          <button onClick={reset} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" disabled={busy}>
            Reset
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
    </section>
  );
};

type GenericMetadataFormProps = {
  metadata: GenericMetadataFormState;
  onChange: (changes: Partial<GenericMetadataFormState>) => void;
};

const inputClasses =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

const GenericMetadataForm: React.FC<GenericMetadataFormProps> = ({ metadata, onChange }) => (
  <div className="space-y-2">
    <label className="block text-xs uppercase text-slate-400">
      Display name
      <input
        className={inputClasses}
        value={metadata.alias}
        onChange={event => onChange({ alias: event.target.value })}
        placeholder="Friendly name"
      />
    </label>
    <p className="text-xs text-slate-500">The display name will be included in the metadata event.</p>
  </div>
);

type AudioMetadataFormProps = {
  metadata: AudioMetadataFormState;
  onChange: (changes: Partial<AudioMetadataFormState>) => void;
};

const AudioMetadataForm: React.FC<AudioMetadataFormProps> = ({ metadata, onChange }) => (
  <div className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2">
      <label className="block text-xs uppercase text-slate-400">
        Display name
        <input
          className={inputClasses}
          value={metadata.alias}
          onChange={event => onChange({ alias: event.target.value })}
          placeholder="Artist - Title"
        />
      </label>
      <label className="block text-xs uppercase text-slate-400">
        Title
        <input
          className={inputClasses}
          value={metadata.title}
          onChange={event => onChange({ title: event.target.value })}
          placeholder="Track title"
        />
      </label>
      <label className="block text-xs uppercase text-slate-400">
        Artist
        <input
          className={inputClasses}
          value={metadata.artist}
          onChange={event => onChange({ artist: event.target.value })}
          placeholder="Artist"
        />
      </label>
      <label className="block text-xs uppercase text-slate-400">
        Album
        <input
          className={inputClasses}
          value={metadata.album}
          onChange={event => onChange({ album: event.target.value })}
          placeholder="Album"
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
        />
      </label>
    </div>
    <p className="text-xs text-slate-500">These details will be published with the upload and saved locally.</p>
  </div>
);

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

const createGenericMetadataFormState = (file: File): GenericMetadataFormState => {
  const withoutExt = stripExtension(file.name);
  const alias = sanitizePart(withoutExt) ?? sanitizePart(file.name) ?? "Untitled";
  return {
    kind: "generic",
    alias,
  };
};

const createAudioMetadataFormState = (
  file: File,
  extracted: ExtractedAudioMetadata | null | undefined
): AudioMetadataFormState => {
  const fallbackAlias = stripExtension(file.name);
  const title = deriveTitle(extracted?.title, fallbackAlias);
  const artist = sanitizePart(extracted?.artist);
  const alias = artist ? `${artist} - ${title}` : title;
  return {
    kind: "audio",
    alias,
    title: extracted?.title ?? "",
    artist: artist ?? "",
    album: extracted?.album ?? "",
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
