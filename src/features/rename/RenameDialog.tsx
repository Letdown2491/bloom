import React, { useCallback, useEffect, useMemo, useState } from "react";
import { NDKEvent, NDKPublishError, NDKRelaySet } from "@nostr-dev-kit/ndk";

import type { BlossomBlob } from "../../lib/blossomClient";
import { buildNip94EventTemplate } from "../../lib/nip94";
import {
  applyAliasUpdate,
  getStoredAudioMetadata,
  rememberAudioMetadata,
  sanitizeCoverUrl,
  type BlobAudioMetadata,
} from "../../utils/blobMetadataStore";
import { isMusicBlob } from "../../utils/blobClassification";
import { EditDialog, type EditDialogAudioFields } from "../../components/RenameDialog";
import type { NdkContextValue } from "../../context/NdkContext";
import type { StatusMessageTone } from "../../types/status";

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
  const storedAudio = useMemo(
    () => getStoredAudioMetadata(blob.serverUrl, blob.sha256) ?? getStoredAudioMetadata(undefined, blob.sha256),
    [blob]
  );

  const [alias, setAlias] = useState("");
  const [audioFields, setAudioFields] = useState<EditDialogAudioFields>(() => emptyAudioFields());
  const [isMusic, setIsMusic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const music = isMusicBlob(blob) || Boolean(storedAudio);
    setIsMusic(music);
    setError(null);
    setBusy(false);

    if (music) {
      const parsed = parseMusicAlias(blob.name || blob.url || blob.sha256);
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
      setAlias(blob.name ?? "");
    }
  }, [blob, storedAudio]);

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

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    if (!ndk || !signer) {
      onStatus("Connect your signer to edit file details.", "error", 4000);
      return;
    }

    const relayList = normalizeRelays(relays);
    if (relayList.length === 0) {
      onStatus("No relays available to publish the update.", "error", 4000);
      return;
    }

    const existingStoredAudio =
      getStoredAudioMetadata(blob.serverUrl, blob.sha256) ?? getStoredAudioMetadata(undefined, blob.sha256);
    const treatAsMusic = isMusic && (isMusicBlob(blob) || Boolean(existingStoredAudio));

    let aliasForEvent: string;
    let aliasForStore: string | null;
    let extraTags: string[][] | undefined;
    let audioMetadata: BlobAudioMetadata | null = null;

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

      aliasForEvent = computeMusicAlias(title, artist) || title;
      if (aliasForEvent.length > 120) {
        setError("Display name is too long (max 120 characters).");
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
      if (coverUrl) {
        tags.push(["cover", coverUrl]);
        metadata.coverUrl = coverUrl;
      }

      extraTags = tags;
      audioMetadata = metadata;
    } else {
      const trimmed = alias.trim();
      const currentAlias = (blob.name ?? "").trim();
      if (trimmed === currentAlias) {
        onClose();
        return;
      }
      if (trimmed.length > 120) {
        setError("Display name is too long (max 120 characters).");
        return;
      }
      aliasForStore = trimmed.length > 0 ? trimmed : null;
      aliasForEvent = aliasForStore ?? "";
    }

    setBusy(true);
    setError(null);
    try {
      const template = buildNip94EventTemplate({
        blob,
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

      applyAliasUpdate(undefined, blob.sha256, aliasForStore, event.created_at);
      if (treatAsMusic) {
        const updatedAt = typeof event.created_at === "number" ? event.created_at * 1000 : undefined;
        rememberAudioMetadata(blob.serverUrl, blob.sha256, audioMetadata ?? null, {
          updatedAt,
        });
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
    ndk,
    signer,
    relays,
    onClose,
    onStatus,
    isMusic,
  ]);

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
    />
  );
};

export default RenameDialog;
