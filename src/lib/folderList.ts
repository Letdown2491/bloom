import { NDKEvent } from "@nostr-dev-kit/ndk";
import { normalizeFolderPathInput } from "../utils/blobMetadataStore";
import type { NdkContextValue } from "../context/NdkContext";

const FOLDER_LIST_KIND = 30000;
const FOLDER_LIST_PREFIX = "bloom-folder:";
const ROOT_IDENTIFIER = `${FOLDER_LIST_PREFIX}__root__`;

type NdkInstance = NdkContextValue["ndk"];
type NdkSigner = NdkContextValue["signer"];
type NdkUser = NdkContextValue["user"];

type RawNdkEvent = InstanceType<typeof NDKEvent>;

export type FolderListRecord = {
  path: string;
  name: string;
  shas: string[];
  eventId?: string;
  updatedAt?: number;
  identifier: string;
};

const encodeIdentifier = (path: string) => {
  const normalized = normalizeFolderPathInput(path) ?? "";
  if (!normalized) return ROOT_IDENTIFIER;
  return `${FOLDER_LIST_PREFIX}${encodeURIComponent(normalized)}`;
};

const decodeIdentifier = (identifier: string): string | null => {
  if (!identifier.startsWith(FOLDER_LIST_PREFIX)) return null;
  const suffix = identifier.slice(FOLDER_LIST_PREFIX.length);
  if (suffix === "__root__") return "";
  try {
    const decoded = decodeURIComponent(suffix);
    return normalizeFolderPathInput(decoded) ?? "";
  } catch {
    return null;
  }
};

export const deriveNameFromPath = (path: string) => {
  if (!path) return "Home";
  const segments = path.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment || path;
};

export const isPrivateFolderName = (name?: string | null) =>
  typeof name === "string" && name.trim().toLowerCase() === "private";

const extractPathTag = (event: RawNdkEvent) => {
  const folderTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === "folder");
  if (folderTag && typeof folderTag[1] === "string") {
    const normalized = normalizeFolderPathInput(folderTag[1]);
    return normalized ?? "";
  }
  const dTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === "d");
  if (!dTag || typeof dTag[1] !== "string") return null;
  return decodeIdentifier(dTag[1]);
};

const extractShas = (event: RawNdkEvent) => {
  const shas = new Set<string>();
  event.tags.forEach(tag => {
    if (!Array.isArray(tag) || tag.length < 2) return;
    if (tag[0] === "x" && typeof tag[1] === "string" && tag[1].length > 0) {
      shas.add(tag[1]);
    }
  });
  return Array.from(shas);
};

const parseFolderEvent = (event: RawNdkEvent): FolderListRecord | null => {
  const dTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === "d");
  if (!dTag || typeof dTag[1] !== "string") return null;
  const identifier = dTag[1];
  if (!identifier.startsWith(FOLDER_LIST_PREFIX)) return null;
  const path = extractPathTag(event);
  if (path === null) return null;
  const nameTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === "name");
  const contentName = typeof event.content === "string" ? event.content.trim() : "";
  const name = typeof nameTag?.[1] === "string" && nameTag[1].trim().length > 0
    ? nameTag[1].trim()
    : contentName || deriveNameFromPath(path);
  return {
    identifier,
    path,
    name,
    shas: extractShas(event),
    eventId: event.id,
    updatedAt: event.created_at ?? undefined,
  };
};

export const loadFolderLists = async (ndk: NdkInstance | null, pubkey: string | null | undefined) => {
  if (!ndk || !pubkey) return [] as FolderListRecord[];
  const eventsSet = (await ndk.fetchEvents({
    kinds: [FOLDER_LIST_KIND],
    authors: [pubkey],
  })) as Set<RawNdkEvent>;
  const events = Array.from(eventsSet);
  const records: FolderListRecord[] = [];
  events.forEach(event => {
    const record = parseFolderEvent(event);
    if (record) {
      records.push(record);
    }
  });
  return records;
};

const buildFolderEvent = (
  ndk: NdkInstance,
  signer: NdkSigner,
  user: NdkUser,
  record: FolderListRecord
) => {
  if (!ndk) throw new Error("NDK unavailable");
  if (!signer) throw new Error("Connect your signer to update folders.");
  if (!user) throw new Error("Connect your Nostr account to update folders.");
  const event = new NDKEvent(ndk);
  event.kind = FOLDER_LIST_KIND;
  event.pubkey = user.pubkey;
  event.created_at = Math.floor(Date.now() / 1000);
  const normalizedPath = normalizeFolderPathInput(record.path) ?? "";
  const identifier = encodeIdentifier(normalizedPath);
  event.tags = [["d", identifier], ["folder", normalizedPath]];
  const baseName = record.name?.trim() || deriveNameFromPath(normalizedPath);
  if (baseName) {
    event.tags.push(["name", baseName]);
  }
  record.shas
    .filter(sha => typeof sha === "string" && sha.length > 0)
    .forEach(sha => event.tags.push(["x", sha]));
  event.content = baseName || "";
  return event;
};

export const publishFolderList = async (
  ndk: NdkInstance,
  signer: NdkSigner,
  user: NdkUser,
  record: FolderListRecord
): Promise<FolderListRecord> => {
  const event = buildFolderEvent(ndk, signer, user, record);
  await event.sign();
  await event.publish();
  return {
    ...record,
    identifier: encodeIdentifier(record.path),
    eventId: event.id,
    updatedAt: event.created_at ?? Math.floor(Date.now() / 1000),
  };
};

export const normalizeFolderPath = (value: string | null | undefined) => normalizeFolderPathInput(value) ?? "";

export const buildDefaultFolderRecord = (path: string, options?: { name?: string; shas?: string[] }): FolderListRecord => {
  const normalized = normalizeFolderPath(path);
  const shas = Array.from(new Set(options?.shas ?? [])).filter(sha => typeof sha === "string" && sha.length > 0);
  const name = options?.name?.trim() || deriveNameFromPath(normalized);
  return {
    path: normalized,
    name,
    shas,
    identifier: encodeIdentifier(normalized),
  };
};

export const removeShaFromRecord = (record: FolderListRecord, sha: string): FolderListRecord => ({
  ...record,
  shas: record.shas.filter(entry => entry !== sha),
});

export const addShaToRecord = (record: FolderListRecord, sha: string): FolderListRecord => {
  if (!sha) return record;
  if (record.shas.includes(sha)) return record;
  return {
    ...record,
    shas: [...record.shas, sha],
  };
};

export const FOLDER_LIST_CONSTANTS = {
  KIND: FOLDER_LIST_KIND,
  PREFIX: FOLDER_LIST_PREFIX,
};
