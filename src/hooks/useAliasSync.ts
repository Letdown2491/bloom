import { useEffect, useMemo, useRef } from "react";
import type { NDKEvent, NDKSubscription } from "@nostr-dev-kit/ndk";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { parseNip94Event } from "../lib/nip94";
import {
  applyAliasUpdate,
  applyFolderUpdate,
  normalizeFolderPathInput,
  rememberAudioMetadata,
  sanitizeCoverUrl,
  type BlobAudioMetadata,
} from "../utils/blobMetadataStore";
import { normalizeRelayOrigin } from "../utils/relays";

const normalizeAliasValue = (value: string | null | undefined) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const aliasFilterForAuthor = (pubkey: string) => ({
  kinds: [1063] as number[],
  authors: [pubkey],
});

const applyAliasFromEvent = (event: NDKEvent) => {
  const parsed = parseNip94Event(event);
  if (!parsed) return;
  const alias = normalizeAliasValue(parsed.name);
  applyAliasUpdate(undefined, parsed.sha256, alias, parsed.createdAt);
  const folderTag = event.tags?.find(tag => Array.isArray(tag) && tag[0] === "folder");
  if (folderTag && typeof folderTag[1] === "string") {
    const folderPath = normalizeFolderPathInput(folderTag[1]) ?? null;
    applyFolderUpdate(undefined, parsed.sha256, folderPath, event.created_at);
  }
  const audioMetadata = extractAudioMetadataFromEvent(event);
  if (audioMetadata) {
    const updatedAt = typeof event.created_at === "number" ? event.created_at * 1000 : undefined;
    rememberAudioMetadata(undefined, parsed.sha256, audioMetadata, { updatedAt });
  }
};

export const useAliasSync = (relayUrls: string[], enabled = true) => {
  const { ndk, getModule } = useNdk();
  const pubkey = useCurrentPubkey();
  const normalizedRelays = useMemo(() => {
    const set = new Set<string>();
    relayUrls.forEach(url => {
      const normalized = normalizeRelayOrigin(url) ?? url.trim();
      if (normalized) set.add(normalized);
    });
    return Array.from(set);
  }, [relayUrls]);
  const lastKeyRef = useRef<string | null>(null);
  const subscriptionRef = useRef<NDKSubscription | null>(null);

  useEffect(() => {
    if (!ndk || !pubkey || !enabled) {
      subscriptionRef.current?.stop();
      subscriptionRef.current = null;
      return;
    }

    let disposed = false;
    let activeSubscription: NDKSubscription | null = null;

    const run = async () => {
      const module = await getModule();
      if (disposed) return;

      const relayKey = normalizedRelays.slice().sort().join("|");
      const effectKey = `${pubkey}|${relayKey}`;
      const relaySet = normalizedRelays.length > 0 ? module.NDKRelaySet.fromRelayUrls(normalizedRelays, ndk) : undefined;

      const handleEvent = (event: NDKEvent) => {
        if (disposed) return;
        applyAliasFromEvent(event);
      };

      if (lastKeyRef.current !== effectKey) {
        try {
          const events = await ndk.fetchEvents(aliasFilterForAuthor(pubkey), { closeOnEose: true }, relaySet);
          if (!disposed) {
            events.forEach((event: NDKEvent) => handleEvent(event));
          }
        } catch {
          // Silently ignore history fetch errors; live subscription still delivers updates.
        }
        lastKeyRef.current = effectKey;
      }

      subscriptionRef.current?.stop();
      const filter = aliasFilterForAuthor(pubkey);
      const subscription = ndk.subscribe(filter, { closeOnEose: false, relaySet });
      subscription.on("event", handleEvent);
      activeSubscription = subscription;
      subscriptionRef.current = subscription;
    };

    run().catch(() => undefined);

    return () => {
      disposed = true;
      if (subscriptionRef.current === activeSubscription) {
        subscriptionRef.current?.stop();
        subscriptionRef.current = null;
      } else {
        activeSubscription?.stop();
      }
    };
  }, [ndk, pubkey, normalizedRelays, enabled, getModule]);
};

const extractAudioMetadataFromEvent = (event: NDKEvent): BlobAudioMetadata | null => {
  if (!Array.isArray(event.tags)) return null;
  const map = new Map<string, string>();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    const key = tag[0];
    const value = typeof tag[1] === "string" ? tag[1].trim() : "";
    if (!key || !value) continue;
    if (!map.has(key)) map.set(key, value);
  }

  const title = map.get("title");
  if (!title) return null;

  const metadata: BlobAudioMetadata = { title };
  const artist = map.get("artist");
  if (artist) metadata.artist = artist;
  const album = map.get("album");
  if (album) metadata.album = album;

  const trackValue = map.get("track");
  if (trackValue) {
    const [numberPart, totalPart] = trackValue.split("/");
    const trackNumber = parsePositiveIntegerString(numberPart);
    const trackTotal = parsePositiveIntegerString(totalPart);
    if (trackNumber) metadata.trackNumber = trackNumber;
    if (trackTotal) metadata.trackTotal = trackTotal;
  }

  const durationValue = map.get("duration");
  const durationSeconds = parsePositiveIntegerString(durationValue);
  if (durationSeconds) metadata.durationSeconds = durationSeconds;

  const genre = map.get("genre");
  if (genre) metadata.genre = genre;

  const yearValue = map.get("year");
  const year = parsePositiveIntegerString(yearValue);
  if (year) metadata.year = year;

  const cover = sanitizeCoverUrl(map.get("cover"));
  if (cover) metadata.coverUrl = cover;

  return metadata;
};

const parsePositiveIntegerString = (value?: string | null) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : undefined;
};
