import React, { useCallback, useEffect, useMemo, useState } from "react";

import type { BlossomBlob } from "../../shared/api/blossomClient";
import { buildNip94EventTemplate } from "../../shared/api/nip94";
import {
  applyAliasUpdate,
  getStoredAudioMetadata,
  normalizeFolderPathInput,
  rememberAudioMetadata,
  sanitizeCoverUrl,
  containsReservedFolderSegment,
  type BlobAudioMetadata,
  getBlobMetadataName,
} from "../../shared/utils/blobMetadataStore";
import { isMusicBlob } from "../../shared/utils/blobClassification";
import { EditDialog, type EditDialogAudioFields } from "./ui/EditDialog";
import type { NdkContextValue } from "../../app/context/NdkContext";
import type { StatusMessageTone } from "../../shared/types/status";
import { usePrivateLibrary } from "../../app/context/PrivateLibraryContext";
import type { PrivateListEntry } from "../../shared/domain/privateList";
import { useFolderLists } from "../../app/context/FolderListContext";
import { loadNdkModule } from "../../shared/api/ndkModule";

type NdkInstance = NdkContextValue["ndk"];
type NdkSigner = NdkContextValue["signer"];

const emptyAudioFields = (): EditDialogAudioFields => ({
  title: "",
  artist: "",
  album: "",
  coverUrl: "",
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

const normalizeRelays = (relays: readonly (string | null | undefined)[]) =>
  relays
    .map(url => url?.trim())
    .filter((url): url is string => Boolean(url && url.length > 0));

export type RenameDialogProps = {
  blob: BlossomBlob;
  ndk: NdkInstance | null;
  signer: NdkSigner | null;
  relays: readonly (string | null | undefined)[];
  onClose: () => void;
  onStatus: (message: string, tone?: StatusMessageTone, duration?: number) => void;
};

export const RenameDialog: React.FC<RenameDialogProps> = ({ blob, ndk, signer, relays, onClose, onStatus }) => {
  const { entriesBySha, upsertEntries } = usePrivateLibrary();
  const privateEntry = entriesBySha.get(blob.sha256) ?? null;
  const isPrivate = Boolean(privateEntry);
  const {
    resolveFolderPath,
    getFoldersForBlob,
    setBlobFolderMembership,
  } = useFolderLists();
  const storedAudio = useMemo(
    () => {
      const stored =
        getStoredAudioMetadata(blob.serverUrl, blob.sha256) ?? getStoredAudioMetadata(undefined, blob.sha256);
      if (stored) return stored;
      const privateAudio = blob.privateData?.metadata?.audio ?? undefined;
      return privateAudio ? { ...privateAudio } : undefined;
    },
    [blob]
  );

  const [alias, setAlias] = useState("");
  const [audioFields, setAudioFields] = useState<EditDialogAudioFields>(() => emptyAudioFields());
  const [isMusic, setIsMusic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);

  useEffect(() => {
    const music = isMusicBlob(blob) || Boolean(storedAudio);
    setIsMusic(music);
    setError(null);
    setBusy(false);

    if (music) {
      const parsed = parseMusicAlias(getBlobMetadataName(blob) ?? blob.sha256);
      const nextFields = emptyAudioFields();
      nextFields.title = storedAudio?.title || parsed.title || "";
      nextFields.artist = storedAudio?.artist || parsed.artist || "";
      nextFields.album = storedAudio?.album || "";
      nextFields.coverUrl = storedAudio?.coverUrl || "";
      nextFields.trackNumber = storedAudio?.trackNumber ? String(storedAudio.trackNumber) : "";
      nextFields.trackTotal = storedAudio?.trackTotal ? String(storedAudio.trackTotal) : "";
      nextFields.durationSeconds = storedAudio?.durationSeconds ? String(storedAudio.durationSeconds) : "";
      nextFields.genre = storedAudio?.genre || "";
      nextFields.year = storedAudio?.year ? String(storedAudio.year) : "";
      setAudioFields(nextFields);
      setAlias(computeMusicAlias(nextFields.title, nextFields.artist) || (nextFields.title || nextFields.artist || ""));
    } else {
      setAudioFields(emptyAudioFields());
      setAlias(getBlobMetadataName(blob) ?? "");
    }

    const membershipPaths = getFoldersForBlob(blob.sha256);
    const membershipFolder = membershipPaths[0] ?? null;
    const fallbackFolderPath =
      membershipFolder ??
      normalizeFolderPathInput(blob.folderPath ?? privateEntry?.metadata?.folderPath ?? undefined) ??
      null;
    setCurrentFolderPath(membershipFolder);
    setFolder(fallbackFolderPath ?? "");
  }, [blob, getFoldersForBlob, privateEntry, storedAudio]);

  const handleAliasChange = useCallback(
    (next: string) => {
      if (isMusic) return;
      setAlias(next);
      if (error) setError(null);
    },
    [error, isMusic]
  );

  const handleAudioFieldChange = useCallback(
    (field: keyof EditDialogAudioFields, value: string) => {
      setAudioFields(prev => {
        const next = { ...(prev ?? emptyAudioFields()) };
        next[field] = value;
        if (field === "title" || field === "artist") {
          setAlias(computeMusicAlias(next.title, next.artist));
        }
        return next;
      });
      if (error) setError(null);
    },
    [error]
  );

  const handleCancel = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  const handleFolderChange = useCallback(
    (next: string) => {
      setFolder(next);
      if (error) setError(null);
    },
    [error]
  );

  const handleSubmit = useCallback(async () => {
    if (busy) return;

    if (containsReservedFolderSegment(folder)) {
      setError("Folder names cannot include the word \"private\".");
      return;
    }

    const relayList = normalizeRelays(relays);

    const desiredFolderRaw = normalizeFolderPathInput(folder) ?? null;
    const desiredFolder = desiredFolderRaw ? resolveFolderPath(desiredFolderRaw) : null;
    const currentFolder = currentFolderPath ? resolveFolderPath(currentFolderPath) : null;
    const folderChanged = desiredFolder !== currentFolder;

    const existingStoredAudio =
      getStoredAudioMetadata(blob.serverUrl, blob.sha256) ??
      getStoredAudioMetadata(undefined, blob.sha256) ??
      (blob.privateData?.metadata?.audio ?? undefined);
    const treatAsMusic = isMusic && (isMusicBlob(blob) || Boolean(existingStoredAudio));

    let aliasForEvent: string | null = null;
    let aliasForStore: string | null = null;
    let extraTags: string[][] | undefined;
    let audioMetadata: BlobAudioMetadata | null = null;
    let needsAliasUpdate = false;

    if (treatAsMusic) {
      const title = audioFields.title.trim();
      if (!title) {
        setError("Title is required for audio files.");
        return;
      }
      const artist = audioFields.artist.trim();
      const album = audioFields.album.trim();
      const trackNumber = parsePositiveIntegerString(audioFields.trackNumber);
      const trackTotal = parsePositiveIntegerString(audioFields.trackTotal);
      const durationSeconds = parsePositiveIntegerString(audioFields.durationSeconds);
      const genre = audioFields.genre.trim();
      const year = parsePositiveIntegerString(audioFields.year);
      const coverUrl = sanitizeCoverUrl(audioFields.coverUrl);

      const computedAlias = computeMusicAlias(title, artist) || title;
      if (computedAlias.length > 120) {
        setError("Display name is too long (max 120 characters).");
        return;
      }
      aliasForEvent = computedAlias;
      aliasForStore = computedAlias;
      needsAliasUpdate = true;

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
      if (coverUrl) {
        tags.push(["cover", coverUrl]);
        metadata.coverUrl = coverUrl;
      }

      extraTags = tags;
      audioMetadata = metadata;
    } else {
      const trimmed = alias.trim();
      const currentAlias = getBlobMetadataName(blob)?.trim() ?? "";
      if (trimmed.length > 120) {
        setError("Display name is too long (max 120 characters).");
        return;
      }
      aliasForStore = trimmed.length > 0 ? trimmed : null;
      const aliasChanged = trimmed !== currentAlias;
      if (aliasChanged) {
        aliasForEvent = aliasForStore ?? "";
        needsAliasUpdate = true;
      } else if (folderChanged) {
        aliasForEvent = aliasForStore ?? "";
        needsAliasUpdate = true;
      } else {
        onClose();
        return;
      }
    }

    if (folderChanged) {
      needsAliasUpdate = true;
    }

    if (desiredFolder !== null) {
      if (!extraTags) {
        extraTags = [];
      }
      extraTags.push(["folder", desiredFolder]);
    } else if (folderChanged) {
      if (!extraTags) {
        extraTags = [];
      }
      extraTags.push(["folder", ""]);
    }

    const applyLocalUpdates = (timestampSeconds: number) => {
      applyAliasUpdate(undefined, blob.sha256, aliasForStore, timestampSeconds);
      if (treatAsMusic) {
        rememberAudioMetadata(blob.serverUrl, blob.sha256, audioMetadata ?? null, {
          updatedAt: timestampSeconds * 1000,
        });
      } else if (!treatAsMusic && existingStoredAudio && blob.serverUrl) {
        rememberAudioMetadata(blob.serverUrl, blob.sha256, existingStoredAudio ?? null, {
          updatedAt: timestampSeconds * 1000,
        });
      }
    };

    const canPublish = Boolean(ndk && signer);

    if (!isPrivate && needsAliasUpdate && (!canPublish || relayList.length === 0)) {
      const timestampSeconds = Math.floor(Date.now() / 1000);
      applyLocalUpdates(timestampSeconds);
      const message = !canPublish
        ? "Details updated locally. Connect your signer to sync changes."
        : "Details updated locally. Add a relay to sync changes.";
      onStatus(message, "info", 3500);
      onClose();
      return;
    }

    if (!ndk || !signer) {
      onStatus("Connect your signer to edit file details.", "error", 4000);
      return;
    }

    if (needsAliasUpdate && relayList.length === 0) {
      onStatus("No relays available to publish the update.", "error", 4000);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (!isPrivate) {
        applyLocalUpdates(nowSeconds);
      }
      if (isPrivate) {
        if (!privateEntry) {
          throw new Error("Private file details not found.");
        }
        const existingMeta = privateEntry.metadata ?? {};
        const serverForMetadata = blob.serverUrl ?? privateEntry.servers?.[0];
        const nextAudioMetadata = treatAsMusic ? audioMetadata ?? null : existingMeta.audio ?? null;
        const updatedEntry: PrivateListEntry = {
          sha256: privateEntry.sha256,
          encryption: privateEntry.encryption,
          metadata: {
            name: aliasForStore ?? existingMeta.name ?? getBlobMetadataName(blob) ?? blob.sha256,
            type: existingMeta.type ?? blob.type,
            size: existingMeta.size ?? blob.size,
            audio: nextAudioMetadata === undefined ? undefined : nextAudioMetadata,
            folderPath: desiredFolder,
          },
          servers: privateEntry.servers,
          updatedAt: nowSeconds,
        };
        await upsertEntries([updatedEntry]);
        applyAliasUpdate(undefined, blob.sha256, aliasForStore, nowSeconds);
        if (treatAsMusic) {
          rememberAudioMetadata(serverForMetadata, blob.sha256, audioMetadata ?? null, {
            updatedAt: nowSeconds * 1000,
          });
        }
        if (!treatAsMusic && existingMeta.audio && serverForMetadata) {
          rememberAudioMetadata(serverForMetadata, blob.sha256, existingMeta.audio ?? null, {
            updatedAt: nowSeconds * 1000,
          });
        }
        setCurrentFolderPath(desiredFolder);
        onStatus("Details updated.", "success", 2500);
        onClose();
        return;
      }

      let aliasEventTimestamp: number | undefined;
      if (needsAliasUpdate) {
        const { NDKEvent, NDKRelaySet, NDKPublishError } = await loadNdkModule();
        const template = buildNip94EventTemplate({
          blob,
          alias: aliasForEvent ?? "",
          extraTags,
        });
        const event = new NDKEvent(ndk, template);
        if (!event.created_at) {
          event.created_at = nowSeconds;
        }
        await event.sign();

        let successes = 0;
        let lastError: Error | null = null;
        for (const relayUrl of relayList) {
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

        aliasEventTimestamp = event.created_at ?? nowSeconds;
        applyAliasUpdate(undefined, blob.sha256, aliasForStore, aliasEventTimestamp);
        if (treatAsMusic) {
          const updatedAt = typeof aliasEventTimestamp === "number" ? aliasEventTimestamp * 1000 : undefined;
          rememberAudioMetadata(blob.serverUrl, blob.sha256, audioMetadata ?? null, {
            updatedAt,
          });
        }
        if (!isPrivate && folderChanged) {
          await setBlobFolderMembership(blob.sha256, desiredFolder);
          setCurrentFolderPath(desiredFolder);
        }
      }

      onStatus("Details updated.", "success", 2500);
      onClose();
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Update failed.";
      setError(message);
      onStatus(message, "error", 5000);
    } finally {
      setBusy(false);
    }
  }, [
    alias,
    audioFields,
    blob,
    busy,
    folder,
    ndk,
    signer,
    relays,
    onClose,
    onStatus,
    isMusic,
    upsertEntries,
    isPrivate,
    privateEntry,
    currentFolderPath,
    setBlobFolderMembership,
  ]);

  const folderHasReservedKeyword = containsReservedFolderSegment(folder);

  return (
    <EditDialog
      blob={blob}
      alias={alias}
      busy={busy}
      error={error}
      isMusic={isMusic}
      onAliasChange={handleAliasChange}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
      audioFields={isMusic ? audioFields : undefined}
      onAudioFieldChange={isMusic ? handleAudioFieldChange : undefined}
      folder={folder}
      onFolderChange={handleFolderChange}
      folderInvalid={folderHasReservedKeyword}
    />
  );
};

export default RenameDialog;
