import type { NDKEvent as NdkEvent, NDKUser, NDKSigner } from "@nostr-dev-kit/ndk";
import { normalizeFolderPathInput } from "../utils/blobMetadataStore";
import { loadNdkModule } from "../api/ndkModule";

type LoadedModule = Awaited<ReturnType<typeof loadNdkModule>>;
type NdkRelaySetInstance = InstanceType<LoadedModule["NDKRelaySet"]>;
type NdkInstance = InstanceType<LoadedModule["default"]>;

type PrivateListOptions = {
  relaySet?: NdkRelaySetInstance | null;
};

export const PRIVATE_LIST_KIND = 30000;
export const PRIVATE_LIST_IDENTIFIER = "private";

type PrivateAudioMetadata = {
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

export type PrivateEncryptionInfo = {
  algorithm: string;
  key: string;
  iv: string;
};

export type PrivateListEntry = {
  sha256: string;
  encryption?: PrivateEncryptionInfo;
  metadata?: {
    name?: string;
    type?: string;
    size?: number;
    audio?: PrivateAudioMetadata | null;
    folderPath?: string | null;
  };
  servers?: string[];
  updatedAt?: number;
};

export type PrivateListPayload = {
  version: 1;
  entries: PrivateListEntry[];
};

type EncryptionCapableSigner = NDKSigner & {
  encrypt: (recipient: NDKUser, value: string, scheme?: "nip44" | "nip04") => Promise<string>;
  decrypt: (sender: NDKUser, value: string, scheme?: "nip44" | "nip04") => Promise<string>;
};

const ensureSigner = (signer: NDKSigner | null | undefined): signer is EncryptionCapableSigner =>
  Boolean(
    signer &&
      typeof (signer as Partial<EncryptionCapableSigner>).encrypt === "function" &&
      typeof (signer as Partial<EncryptionCapableSigner>).decrypt === "function"
  );

const sanitizeEntry = (entry: unknown): PrivateListEntry | null => {
  if (!entry || typeof entry !== "object") return null;
  const source = entry as Record<string, unknown>;
  const sha256 = typeof source.sha256 === "string" ? source.sha256 : null;
  if (!sha256) return null;
  const encryptionSource = source.encryption as Record<string, unknown> | undefined;
  const algorithm = typeof encryptionSource?.algorithm === "string" ? encryptionSource.algorithm : undefined;
  const key = typeof encryptionSource?.key === "string" ? encryptionSource.key : undefined;
  const iv = typeof encryptionSource?.iv === "string" ? encryptionSource.iv : undefined;
  const metadataSource = source.metadata as Record<string, unknown> | undefined;
  const audioMetadata = sanitizeAudioMetadata(metadataSource?.audio);
  const rawFolderPath = metadataSource?.folderPath;
  const normalizedFolder =
    typeof rawFolderPath === "string"
      ? normalizeFolderPathInput(rawFolderPath) ?? null
      : rawFolderPath === null
        ? null
        : undefined;
  const metadata = metadataSource && typeof metadataSource === "object"
    ? {
        name: typeof metadataSource.name === "string" ? metadataSource.name : undefined,
        type: typeof metadataSource.type === "string" ? metadataSource.type : undefined,
        size: typeof metadataSource.size === "number" ? metadataSource.size : undefined,
        audio: audioMetadata,
        folderPath: normalizedFolder,
      }
    : undefined;
  const serversValue = source.servers;
  const servers = Array.isArray(serversValue)
    ? (() => {
        const cleaned = serversValue
          .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value: string) => value.trim());
        if (!cleaned.length) return undefined;
        const unique = Array.from(new Set<string>(cleaned.map((value: string) => value.replace(/\/+$/, ""))));
        return unique.length ? unique : undefined;
      })()
    : undefined;
  const updatedAt = typeof source.updatedAt === "number" ? source.updatedAt : undefined;
  const encryption =
    algorithm && key && iv
      ? { algorithm, key, iv }
      : undefined;

  return {
    sha256,
    encryption,
    metadata,
    servers,
    updatedAt,
  };
};

const sanitizeAudioMetadata = (value: unknown): PrivateAudioMetadata | null | undefined => {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const audio: PrivateAudioMetadata = {};
  const source = value as Record<string, unknown>;
  if (typeof source.title === "string") audio.title = source.title;
  if (typeof source.artist === "string") audio.artist = source.artist;
  if (typeof source.album === "string") audio.album = source.album;
  if (typeof source.trackNumber === "number" && Number.isFinite(source.trackNumber)) {
    audio.trackNumber = Math.floor(source.trackNumber);
  }
  if (typeof source.trackTotal === "number" && Number.isFinite(source.trackTotal)) {
    audio.trackTotal = Math.floor(source.trackTotal);
  }
  if (typeof source.durationSeconds === "number" && Number.isFinite(source.durationSeconds)) {
    audio.durationSeconds = source.durationSeconds;
  }
  if (typeof source.genre === "string") audio.genre = source.genre;
  if (typeof source.year === "number" && Number.isFinite(source.year)) {
    audio.year = Math.floor(source.year);
  }
  if (typeof source.coverUrl === "string") audio.coverUrl = source.coverUrl;
  return Object.keys(audio).length > 0 ? audio : undefined;
};

export const loadPrivateList = async (
  ndk: NdkInstance | null,
  signer: NDKSigner | null,
  user: NDKUser | null,
  options?: PrivateListOptions
): Promise<PrivateListEntry[]> => {
  if (!ndk || !signer || !user) return [];
  const events = (await ndk.fetchEvents(
    {
      authors: [user.pubkey],
      kinds: [PRIVATE_LIST_KIND],
      "#d": [PRIVATE_LIST_IDENTIFIER],
    },
    { closeOnEose: true },
    options?.relaySet ?? undefined
  )) as Set<NdkEvent>;
  if (!events || events.size === 0) return [];
  const sorted = Array.from(events).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const latest = sorted[0];
  if (!latest || !latest.content) return [];
  if (!ensureSigner(signer)) return [];
  try {
    const decrypted = await signer.decrypt(user, latest.content, "nip44");
    if (!decrypted) return [];
    const payload = JSON.parse(decrypted) as PrivateListPayload | null;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.entries)) return [];
    const entries: PrivateListEntry[] = [];
    payload.entries.forEach(item => {
      const normalized = sanitizeEntry(item);
      if (normalized) entries.push(normalized);
    });
    return entries;
  } catch (error) {
    console.warn("Failed to decrypt private list", error);
    return [];
  }
};

export const publishPrivateList = async (
  ndk: NdkInstance | null,
  signer: NDKSigner | null,
  user: NDKUser | null,
  entries: PrivateListEntry[],
  options?: PrivateListOptions
) => {
  if (!ndk || !signer || !user) throw new Error("Nostr signer unavailable");
  if (!ensureSigner(signer)) throw new Error("Signer does not support encryption");
  const { NDKEvent } = await loadNdkModule();
  const event = new NDKEvent(ndk);
  event.kind = PRIVATE_LIST_KIND;
  event.created_at = Math.floor(Date.now() / 1000);
  event.pubkey = user.pubkey;
  event.tags = [["d", PRIVATE_LIST_IDENTIFIER]];
  const serialized: PrivateListPayload = {
    version: 1,
    entries: entries.map(entry => ({
      sha256: entry.sha256,
      encryption: entry.encryption
        ? {
            algorithm: entry.encryption.algorithm,
            key: entry.encryption.key,
            iv: entry.encryption.iv,
          }
        : undefined,
      metadata: entry.metadata,
      servers: entry.servers,
      updatedAt: entry.updatedAt ?? Math.floor(Date.now() / 1000),
    })),
  };
  const plaintext = JSON.stringify(serialized);
  event.content = await signer.encrypt(user, plaintext, "nip44");
  await event.sign();
  if (options?.relaySet) {
    await event.publish(options.relaySet);
  } else {
    await event.publish();
  }
};

export const mergePrivateEntries = (
  existing: PrivateListEntry[],
  updates: PrivateListEntry[]
): PrivateListEntry[] => {
  const map = new Map<string, PrivateListEntry>();
  existing.forEach(entry => {
    map.set(entry.sha256, {
      ...entry,
      servers: entry.servers ? Array.from(new Set(entry.servers)) : undefined,
    });
  });
  updates.forEach(entry => {
    const current = map.get(entry.sha256);
    if (!current) {
      map.set(entry.sha256, {
        ...entry,
        servers: entry.servers ? Array.from(new Set(entry.servers)) : undefined,
      });
      return;
    }
    const mergedServers = new Set<string>();
    (current.servers || []).forEach(server => mergedServers.add(server));
    (entry.servers || []).forEach(server => mergedServers.add(server));
    map.set(entry.sha256, {
      sha256: entry.sha256,
      encryption: entry.encryption ?? current.encryption,
      metadata: mergeMetadata(current.metadata, entry.metadata),
      servers: mergedServers.size > 0 ? Array.from(mergedServers) : undefined,
      updatedAt: entry.updatedAt ?? current.updatedAt ?? Math.floor(Date.now() / 1000),
    });
  });
  return Array.from(map.values());
};

const mergeMetadata = (
  base: PrivateListEntry["metadata"] | undefined,
  update: PrivateListEntry["metadata"] | undefined
): PrivateListEntry["metadata"] | undefined => {
  if (!base) return update;
  if (!update) return base;
  return {
    name: update.name ?? base.name,
    type: update.type ?? base.type,
    size: update.size ?? base.size,
    audio: update.audio !== undefined ? update.audio : base.audio,
    folderPath: update.folderPath !== undefined ? update.folderPath : base.folderPath,
  };
};
