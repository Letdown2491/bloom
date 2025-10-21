import type { NDKEvent as NdkEvent, NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";
import { normalizeFolderPathInput } from "../utils/blobMetadataStore";
import { loadNdkModule } from "../api/ndkModule";

const FOLDER_LIST_KIND = 30000;
const FOLDER_LIST_PREFIX = "bloom-folder:";
const ROOT_IDENTIFIER = `${FOLDER_LIST_PREFIX}__root__`;
const VISIBILITY_TAG_NAMESPACE = "bloom";
const VISIBILITY_TAG_KEY = "visibility";
const SHARE_POLICY_TAG_KEY = "share-policy";

type LoadedNdkModule = Awaited<ReturnType<typeof loadNdkModule>>;
type NdkInstance = InstanceType<LoadedNdkModule["default"]> | null;
type NdkSignerInstance = NDKSigner | null | undefined;
type NdkUserInstance = NDKUser | null | undefined;

type RawNdkEvent = NdkEvent;

export type FolderListVisibility = "public" | "private";
export type FolderSharePolicy = "all" | "private-only" | "public-only";

export type FolderFileHint = {
  sha: string;
  url?: string | null;
  serverUrl?: string | null;
  requiresAuth?: boolean | null;
  serverType?: string | null;
  mimeType?: string | null;
  size?: number | null;
  name?: string | null;
  privateLinkAlias?: string | null;
};

export type FolderListRecord = {
  path: string;
  name: string;
  shas: string[];
  eventId?: string;
  updatedAt?: number;
  identifier: string;
  visibility: FolderListVisibility;
  pubkey?: string;
  fileHints?: Record<string, FolderFileHint>;
  sharePolicy?: FolderSharePolicy | null;
};

export type FolderListAddress = {
  identifier: string;
  pubkey: string;
  kind: number;
  relays?: string[];
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

const parseVisibility = (event: RawNdkEvent): FolderListVisibility => {
  const tag = event.tags.find(
    entry =>
      Array.isArray(entry) &&
      entry[0] === VISIBILITY_TAG_NAMESPACE &&
      entry[1] === VISIBILITY_TAG_KEY,
  );
  const value = typeof tag?.[2] === "string" ? tag[2].toLowerCase() : null;
  return value === "public" ? "public" : "private";
};

const parseSharePolicy = (event: RawNdkEvent): FolderSharePolicy | null => {
  const tag = event.tags.find(
    entry =>
      Array.isArray(entry) &&
      entry[0] === VISIBILITY_TAG_NAMESPACE &&
      entry[1] === SHARE_POLICY_TAG_KEY,
  );
  if (!tag) return null;
  const raw = typeof tag[2] === "string" ? tag[2].toLowerCase() : null;
  if (raw === "private-only" || raw === "public-only" || raw === "all") {
    return raw;
  }
  return null;
};

export const parseFolderEvent = (event: RawNdkEvent): FolderListRecord | null => {
  const dTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === "d");
  if (!dTag || typeof dTag[1] !== "string") return null;
  const identifier = dTag[1];
  if (!identifier.startsWith(FOLDER_LIST_PREFIX)) return null;
  const path = extractPathTag(event);
  if (path === null) return null;
  const nameTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === "name");
  const contentName = typeof event.content === "string" ? event.content.trim() : "";
  const name =
    typeof nameTag?.[1] === "string" && nameTag[1].trim().length > 0
      ? nameTag[1].trim()
      : contentName || deriveNameFromPath(path);
  const fileHints: Record<string, FolderFileHint> = {};
  event.tags.forEach(tag => {
    if (!Array.isArray(tag) || tag.length < 3) return;
    if (tag[0] !== VISIBILITY_TAG_NAMESPACE || tag[1] !== "file") {
      return;
    }
    const sha = typeof tag[2] === "string" ? tag[2].trim().toLowerCase() : "";
    if (!sha || sha.length !== 64) return;
    const payloadRaw = tag[3];
    if (typeof payloadRaw !== "string" || !payloadRaw.trim()) return;
    try {
      const parsed = JSON.parse(payloadRaw) as {
        url?: string | null;
        serverUrl?: string | null;
        requiresAuth?: boolean | string | null;
        serverType?: string | null;
        mimeType?: string | null;
        size?: number | string | null;
        name?: string | null;
        privateLinkAlias?: string | null;
      };
      const requiresAuth =
        typeof parsed.requiresAuth === "boolean"
          ? parsed.requiresAuth
          : typeof parsed.requiresAuth === "string"
            ? ["1", "true", "yes"].includes(parsed.requiresAuth.toLowerCase())
            : undefined;
      const sizeValue =
        typeof parsed.size === "number"
          ? parsed.size
          : typeof parsed.size === "string"
            ? Number(parsed.size)
            : undefined;
      fileHints[sha] = {
        sha,
        url: parsed.url ?? undefined,
        serverUrl: parsed.serverUrl ?? undefined,
        requiresAuth: requiresAuth ?? undefined,
        serverType: parsed.serverType ?? undefined,
        mimeType: parsed.mimeType ?? undefined,
        size: Number.isFinite(sizeValue) ? Number(sizeValue) : undefined,
        name: parsed.name ?? undefined,
        privateLinkAlias: parsed.privateLinkAlias ?? undefined,
      };
    } catch {
      // ignore malformed payloads
    }
  });
  return {
    identifier,
    path,
    name,
    shas: extractShas(event),
    eventId: event.id,
    updatedAt: event.created_at ?? undefined,
    visibility: parseVisibility(event),
    pubkey: event.pubkey,
    fileHints: Object.keys(fileHints).length > 0 ? fileHints : undefined,
    sharePolicy: parseSharePolicy(event),
  };
};

export const loadFolderLists = async (
  ndk: NdkInstance | null,
  pubkey: string | null | undefined,
) => {
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

export const buildFolderEventTemplate = (
  record: FolderListRecord,
  pubkey: string,
  options?: {
    createdAt?: number;
    fileHints?: Iterable<FolderFileHint>;
    sharePolicy?: FolderSharePolicy | null;
  },
) => {
  const normalizedPath = normalizeFolderPathInput(record.path) ?? "";
  const identifier = encodeIdentifier(normalizedPath);
  const baseName = record.name?.trim() || deriveNameFromPath(normalizedPath);
  const createdAt =
    typeof options?.createdAt === "number" && Number.isFinite(options.createdAt)
      ? Math.max(0, Math.trunc(options.createdAt))
      : Math.floor(Date.now() / 1000);
  const shaTags = Array.from(
    new Set(
      (record.shas || [])
        .map(sha => (typeof sha === "string" ? sha.trim() : ""))
        .filter(sha => sha.length > 0),
    ),
  );
  const tags: string[][] = [
    ["d", identifier],
    ["folder", normalizedPath],
  ];
  if (baseName) {
    tags.push(["name", baseName]);
  }
  shaTags.forEach(sha => tags.push(["x", sha]));
  const visibility = record.visibility ?? "private";
  tags.push([VISIBILITY_TAG_NAMESPACE, VISIBILITY_TAG_KEY, visibility]);
  const sharePolicy = options?.sharePolicy ?? record.sharePolicy ?? null;
  if (sharePolicy && sharePolicy !== "all") {
    tags.push([VISIBILITY_TAG_NAMESPACE, SHARE_POLICY_TAG_KEY, sharePolicy]);
  } else {
    // Ensure previously published share-policy tags are cleared by emitting explicit "all"
    // Consumers treat absence as "all", but including the tag keeps multi-device clients aligned.
    tags.push([VISIBILITY_TAG_NAMESPACE, SHARE_POLICY_TAG_KEY, "all"]);
  }
  if (options?.fileHints) {
    for (const hint of options.fileHints) {
      if (!hint || typeof hint.sha !== "string" || hint.sha.trim().length !== 64) continue;
      const sha = hint.sha.trim().toLowerCase();
      if (!sha) continue;
      try {
        const payload = JSON.stringify({
          url: hint.url ?? undefined,
          serverUrl: hint.serverUrl ?? undefined,
          requiresAuth: typeof hint.requiresAuth === "boolean" ? hint.requiresAuth : undefined,
          serverType: hint.serverType ?? undefined,
          mimeType: hint.mimeType ?? undefined,
          size:
            typeof hint.size === "number" && Number.isFinite(hint.size)
              ? Math.trunc(hint.size)
              : undefined,
          name: hint.name ?? undefined,
          privateLinkAlias: hint.privateLinkAlias ?? undefined,
        });
        if (payload && payload !== "{}") {
          tags.push([VISIBILITY_TAG_NAMESPACE, "file", sha, payload]);
        }
      } catch {
        // ignore serialization errors
      }
    }
  }
  return {
    kind: FOLDER_LIST_KIND,
    pubkey,
    created_at: createdAt,
    content: baseName || "",
    tags,
  };
};

const buildFolderEvent = async (
  ndk: NdkInstance,
  signer: NdkSignerInstance,
  user: NdkUserInstance,
  record: FolderListRecord,
) => {
  if (!ndk) throw new Error("NDK unavailable");
  if (!signer) throw new Error("Connect your signer to update folders.");
  if (!user) throw new Error("Connect your Nostr account to update folders.");
  const { NDKEvent } = await loadNdkModule();
  const template = buildFolderEventTemplate(record, user.pubkey, {
    fileHints: record.fileHints ? Object.values(record.fileHints) : undefined,
    sharePolicy: record.sharePolicy ?? null,
  });
  const event = new NDKEvent(ndk);
  event.kind = template.kind;
  event.pubkey = template.pubkey;
  event.created_at = template.created_at;
  event.tags = template.tags;
  event.content = template.content;
  return event;
};

export const publishFolderList = async (
  ndk: NdkInstance,
  signer: NdkSignerInstance,
  user: NdkUserInstance,
  record: FolderListRecord,
): Promise<FolderListRecord> => {
  if (!ndk) {
    throw new Error("NDK unavailable");
  }
  if (!signer) {
    throw new Error("Connect your signer to update folders.");
  }
  if (!user) {
    throw new Error("Connect your Nostr account to update folders.");
  }
  const event = await buildFolderEvent(ndk, signer, user, record);
  await event.sign();
  await event.publish();
  return {
    ...record,
    identifier: encodeIdentifier(record.path),
    eventId: event.id,
    updatedAt: event.created_at ?? Math.floor(Date.now() / 1000),
    visibility: record.visibility ?? "private",
    pubkey: user.pubkey,
    sharePolicy: record.sharePolicy ?? null,
  };
};

export const normalizeFolderPath = (value: string | null | undefined) =>
  normalizeFolderPathInput(value) ?? "";

export const buildDefaultFolderRecord = (
  path: string,
  options?: {
    name?: string;
    shas?: string[];
    visibility?: FolderListVisibility;
    pubkey?: string;
    fileHints?: Record<string, FolderFileHint>;
    sharePolicy?: FolderSharePolicy | null;
  },
): FolderListRecord => {
  const normalized = normalizeFolderPath(path);
  const shas = Array.from(new Set(options?.shas ?? [])).filter(
    sha => typeof sha === "string" && sha.length > 0,
  );
  const name = options?.name?.trim() || deriveNameFromPath(normalized);
  const visibility = options?.visibility ?? "private";
  return {
    path: normalized,
    name,
    shas,
    identifier: encodeIdentifier(normalized),
    visibility,
    pubkey: options?.pubkey,
    fileHints: options?.fileHints,
    sharePolicy: options?.sharePolicy ?? null,
  };
};

export const removeShaFromRecord = (record: FolderListRecord, sha: string): FolderListRecord => {
  const nextHints = record.fileHints
    ? Object.fromEntries(
        Object.entries(record.fileHints).filter(([key]) => key !== sha.toLowerCase()),
      )
    : undefined;
  return {
    ...record,
    shas: record.shas.filter(entry => entry !== sha),
    fileHints: nextHints && Object.keys(nextHints).length > 0 ? nextHints : undefined,
  };
};

export const addShaToRecord = (record: FolderListRecord, sha: string): FolderListRecord => {
  if (!sha) return record;
  if (record.shas.includes(sha)) return record;
  return {
    ...record,
    shas: [...record.shas, sha],
    fileHints: record.fileHints,
  };
};

export const FOLDER_LIST_CONSTANTS = {
  KIND: FOLDER_LIST_KIND,
  PREFIX: FOLDER_LIST_PREFIX,
};

export const encodeFolderNaddr = (
  record: FolderListRecord,
  ownerPubkey?: string | null,
  relays?: readonly string[] | null,
) => {
  const pubkey = ownerPubkey ?? record.pubkey;
  if (!pubkey) return null;
  const identifier = record.identifier ?? encodeIdentifier(record.path);
  const relayList =
    Array.isArray(relays) && relays.length > 0
      ? relays
          .map(entry => {
            try {
              const normalized = new URL(entry);
              normalized.search = "";
              normalized.hash = "";
              return normalized.toString().replace(/\/+$/, "");
            } catch {
              const trimmed = (entry ?? "").trim().replace(/\/+$/, "");
              return trimmed || null;
            }
          })
          .filter((value): value is string => Boolean(value))
      : undefined;
  try {
    return nip19.naddrEncode({
      identifier,
      pubkey,
      kind: FOLDER_LIST_KIND,
      relays: relayList && relayList.length > 0 ? relayList : undefined,
    });
  } catch {
    return null;
  }
};

export const decodeFolderNaddr = (value: string): FolderListAddress | null => {
  if (!value) return null;
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "naddr") return null;
    const data = decoded.data as
      | { identifier?: string; pubkey?: string; kind?: number; relays?: string[] }
      | undefined;
    const identifier = typeof data?.identifier === "string" ? data.identifier : null;
    const pubkey = typeof data?.pubkey === "string" ? data.pubkey : null;
    const kind = typeof data?.kind === "number" ? data.kind : null;
    if (!identifier || !pubkey || kind !== FOLDER_LIST_KIND) return null;
    return {
      identifier,
      pubkey,
      kind,
      relays: Array.isArray(data?.relays) ? data.relays : undefined,
    };
  } catch {
    return null;
  }
};

type NdkRelaySetInstance = InstanceType<Awaited<ReturnType<typeof loadNdkModule>>["NDKRelaySet"]>;

type FetchFolderRecordOptions = {
  timeoutMs?: number;
  relaySet?: NdkRelaySetInstance | null;
};

export const fetchFolderRecordByAddress = async (
  ndk: NdkInstance | null,
  address: FolderListAddress,
  relayUrls?: readonly string[],
  options?: FetchFolderRecordOptions,
): Promise<FolderListRecord | null> => {
  if (!ndk) return null;
  const filters = [
    {
      kinds: [address.kind],
      authors: [address.pubkey],
      "#d": [address.identifier],
      limit: 1,
    },
  ];
  let relaySet: NdkRelaySetInstance | undefined;
  if (options?.relaySet) {
    relaySet = options.relaySet;
  } else if (relayUrls && relayUrls.length > 0) {
    try {
      const module = await loadNdkModule();
      relaySet = module.NDKRelaySet.fromRelayUrls(relayUrls, ndk);
    } catch (error) {
      console.warn("Unable to build relay set for folder lookup", error);
    }
  }
  const timeoutMs = options?.timeoutMs ?? 7000;
  let fetchTimedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let eventsSet: Set<RawNdkEvent> = new Set();
  try {
    const fetchPromise = ndk.fetchEvents(
      filters,
      { closeOnEose: true, groupable: false },
      relaySet,
    );
    if (timeoutMs > 0) {
      eventsSet = (await Promise.race([
        fetchPromise.finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
        }),
        new Promise<Set<RawNdkEvent>>(resolve => {
          timeoutHandle = setTimeout(() => {
            fetchTimedOut = true;
            timeoutHandle = null;
            resolve(new Set());
          }, timeoutMs);
        }),
      ])) as Set<RawNdkEvent>;
    } else {
      eventsSet = (await fetchPromise) as Set<RawNdkEvent>;
    }
  } catch (error) {
    console.warn("Unable to fetch folder record", error);
    eventsSet = new Set();
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
  if (fetchTimedOut) {
    console.warn(`Timeout fetching folder record ${address.identifier} after ${timeoutMs}ms`);
  }
  if (!eventsSet || eventsSet.size === 0) return null;
  const events = Array.from(eventsSet).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const latest = events[0];
  if (!latest) return null;
  return parseFolderEvent(latest);
};
