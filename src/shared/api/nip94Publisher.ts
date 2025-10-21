import { loadNdkModule } from "./ndkModule";
import { buildNip94EventTemplate, type BlurhashMetadata } from "./nip94";
import type { BlossomBlob } from "./blossomClient";
import { normalizeRelayOrigin } from "../utils/relays";
import { normalizeFolderPathInput } from "../utils/blobMetadataStore";
import type { NdkContextValue } from "../../app/context/NdkContext";

const CORE_NIP94_TAG_KEYS = new Set(["url", "m", "x", "size", "name", "folder"]);

export const extractExtraNip94Tags = (tags?: string[][]): string[][] | undefined => {
  if (!Array.isArray(tags)) return undefined;
  const extras: string[][] = [];
  tags.forEach(tag => {
    if (!Array.isArray(tag) || tag.length < 2) return;
    const key = tag[0];
    if (typeof key !== "string" || CORE_NIP94_TAG_KEYS.has(key)) return;
    extras.push(tag.slice());
  });
  return extras.length > 0 ? extras : undefined;
};

type PublishRelayResult = {
  relayUrl: string;
  success: boolean;
  error?: Error;
};

export type PublishNip94Options = {
  ndk: NdkContextValue["ndk"];
  signer: NdkContextValue["signer"];
  blob: BlossomBlob;
  relays?: readonly (string | null | undefined)[];
  alias?: string | null | undefined;
  folderPath?: string | null | undefined;
  blurhash?: BlurhashMetadata;
  extraTags?: string[][];
  timeoutMs?: number;
};

export type PublishNip94Result = {
  createdAt: number;
  relayResults: PublishRelayResult[];
};

const normalizeRelayList = (relays?: readonly (string | null | undefined)[]) => {
  if (!Array.isArray(relays)) return [];
  const normalized = new Set<string>();
  relays.forEach(candidate => {
    if (!candidate) return;
    const trimmed = candidate.trim();
    if (!trimmed) return;
    const origin = normalizeRelayOrigin(trimmed) ?? trimmed;
    if (origin) {
      normalized.add(origin);
    }
  });
  return Array.from(normalized);
};

const buildFolderTag = (folderPath: string | null | undefined): string[][] => {
  if (folderPath === undefined) {
    return [];
  }
  const normalized = normalizeFolderPathInput(folderPath);
  if (normalized === undefined) {
    return [];
  }
  if (normalized === null) {
    return [["folder", ""]];
  }
  return [["folder", normalized]];
};

export const publishNip94Metadata = async ({
  ndk,
  signer,
  blob,
  relays,
  alias,
  folderPath,
  blurhash,
  extraTags,
  timeoutMs,
}: PublishNip94Options): Promise<PublishNip94Result> => {
  if (!ndk) {
    throw new Error("NDK unavailable");
  }
  if (!signer) {
    throw new Error("Signer unavailable");
  }
  const relayList = normalizeRelayList(relays);
  const folderTags = buildFolderTag(folderPath);
  const combinedTags = Array.isArray(extraTags) ? [...extraTags] : [];
  if (folderTags.length) {
    folderTags.forEach(tag => {
      combinedTags.push(tag);
    });
  }

  const aliasForTemplate = typeof alias === "string" ? alias : alias === null ? "" : undefined;

  const template = buildNip94EventTemplate({
    blob,
    alias: aliasForTemplate,
    blurhash,
    extraTags: combinedTags,
  });

  const module = await loadNdkModule();
  const { NDKEvent, NDKRelaySet, NDKPublishError } = module;

  const event = new NDKEvent(ndk, template);
  if (!event.created_at) {
    event.created_at = Math.floor(Date.now() / 1000);
  }
  await event.sign();

  const relayResults: PublishRelayResult[] = [];
  if (relayList.length > 0) {
    for (const relayUrl of relayList) {
      try {
        const relaySet = NDKRelaySet.fromRelayUrls([relayUrl], ndk);
        await event.publish(relaySet, timeoutMs ?? 7000, 1);
        relayResults.push({ relayUrl, success: true });
      } catch (error: unknown) {
        if (error instanceof NDKPublishError) {
          relayResults.push({
            relayUrl,
            success: false,
            error: new Error(error.relayErrors || error.message || "Failed to publish metadata"),
          });
        } else if (error instanceof Error) {
          relayResults.push({ relayUrl, success: false, error });
        } else {
          relayResults.push({
            relayUrl,
            success: false,
            error: new Error("Failed to publish metadata"),
          });
        }
      }
    }
  } else {
    try {
      await event.publish();
      relayResults.push({ relayUrl: "(connected)", success: true });
    } catch (error: unknown) {
      relayResults.push({
        relayUrl: "(connected)",
        success: false,
        error: error instanceof Error ? error : new Error("Failed to publish metadata"),
      });
    }
  }

  const createdAt = event.created_at ?? Math.floor(Date.now() / 1000);
  const successful = relayResults.some(result => result.success);
  if (!successful) {
    const firstError = relayResults.find(result => result.error)?.error;
    throw firstError ?? new Error("No relays accepted the update.");
  }

  return {
    createdAt,
    relayResults,
  };
};

export default publishNip94Metadata;
