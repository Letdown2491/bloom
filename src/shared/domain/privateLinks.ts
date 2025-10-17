import type { NDKEvent as NdkEvent, NDKSigner, NDKUser as NdkUser } from "@nostr-dev-kit/ndk";
import {
  PRIVATE_LINK_EVENT_KIND,
  PRIVATE_LINK_SERVICE_HOST,
  PRIVATE_LINK_SERVICE_PUBKEY,
  PRIVATE_LINK_REQUIRED_RELAY,
  isPrivateLinkServiceConfigured,
} from "../constants/privateLinks";
import { extractSha256FromUrl } from "../api/blossomClient";
import { DEFAULT_PUBLIC_RELAYS } from "../utils/relays";
import { loadNdkModule, type NdkModule } from "../api/ndkModule";

const ALIAS_ALLOWED = "abcdefghijklmnopqrstuvwxyz0123456789";

const normalizeAlias = (input: string) => {
  const trimmed = input.trim().toLowerCase();
  let normalized = "";
  for (const char of trimmed) {
    if (ALIAS_ALLOWED.includes(char)) {
      normalized += char;
    }
  }
  return normalized;
};

type LoadedNdkModule = Awaited<ReturnType<typeof loadNdkModule>>;
type NdkInstance = InstanceType<LoadedNdkModule["default"]> | null;
type NdkSignerInstance = NDKSigner | null | undefined;
type NdkUserInstance = NdkUser | null | undefined;
type NdkInternalUser = NdkUser;

type EncryptionCapableSigner = NDKSigner & {
  encrypt: (recipient: NdkInternalUser, value: string, scheme?: "nip44" | "nip04") => Promise<string>;
  decrypt: (sender: NdkInternalUser, value: string, scheme?: "nip44" | "nip04") => Promise<string>;
};

const ensureEncryptionSigner = (signer: NdkSignerInstance | null | undefined): signer is EncryptionCapableSigner =>
  Boolean(
    signer &&
      typeof (signer as EncryptionCapableSigner).encrypt === "function" &&
      typeof (signer as EncryptionCapableSigner).decrypt === "function"
  );

export type PrivateLinkStatus = "active" | "revoked";

export type PrivateLinkTarget = {
  url: string | null;
  server: string | null;
  sha256: string | null;
};

export type PrivateLinkEnvelope = {
  version: 1;
  alias: string;
  status: PrivateLinkStatus;
  createdAt: number;
  revokedAt?: number | null;
  target?: PrivateLinkTarget | null;
  displayName?: string | null;
  expiresAt?: number | null;
};

export type PrivateLinkRecord = {
  alias: string;
  status: PrivateLinkStatus;
  createdAt: number;
  revokedAt?: number | null;
  target?: PrivateLinkTarget | null;
  displayName?: string | null;
  eventId?: string;
  updatedAt?: number;
  expiresAt?: number | null;
  isExpired?: boolean;
};

export type CreatePrivateLinkInput = {
  alias: string;
  url: string;
  serverUrl?: string | null;
  sha256?: string | null;
  displayName?: string | null;
  expiresAt?: number | null;
};

type PublishPrivateLinkOptions = {
  alias: string;
  status: PrivateLinkStatus;
  target: PrivateLinkTarget | null;
  displayName?: string | null;
  createdAt?: number;
  revokedAt?: number | null;
  expiresAt?: number | null;
};

const getServiceUser = async (ndk: NdkInstance | null, module?: NdkModule) => {
  if (!isPrivateLinkServiceConfigured()) {
    throw new Error("Private link service is not configured.");
  }
  if (!ndk) throw new Error("NDK unavailable");
  const runtime = module ?? (await loadNdkModule());
  return new runtime.NDKUser({ pubkey: PRIVATE_LINK_SERVICE_PUBKEY });
};

const encryptPayload = async (signer: EncryptionCapableSigner, serviceUser: NdkUser, payload: PrivateLinkEnvelope) => {
  const serialized = JSON.stringify(payload);
  try {
    return await signer.encrypt(serviceUser, serialized, "nip44");
  } catch (error) {
    // Fallback to nip04 for signers without nip44 support.
    return signer.encrypt(serviceUser, serialized, "nip04");
  }
};

const decryptPayload = async (
  signer: EncryptionCapableSigner,
  serviceUser: NdkUser,
  content: string
): Promise<PrivateLinkEnvelope | null> => {
  if (!content) return null;
  let plaintext: string | null = null;
  try {
    plaintext = await signer.decrypt(serviceUser, content, "nip44");
  } catch (error) {
    try {
      plaintext = await signer.decrypt(serviceUser, content, "nip04");
    } catch (err) {
      return null;
    }
  }
  if (!plaintext) return null;
  try {
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object") return null;
    if ((parsed as PrivateLinkEnvelope).version !== 1) return null;
    return parsed as PrivateLinkEnvelope;
  } catch (error) {
    return null;
  }
};

const normalizeTarget = (target: PrivateLinkTarget | null | undefined): PrivateLinkTarget | null => {
  if (!target) return null;
  const url = typeof target.url === "string" && target.url.trim().length > 0 ? target.url.trim() : null;
  const server = typeof target.server === "string" && target.server.trim().length > 0 ? target.server.trim() : null;
  const sha = typeof target.sha256 === "string" && target.sha256.trim().length > 0 ? target.sha256.trim() : null;
  return { url, server, sha256: sha };
};

const normalizeExpiration = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const normalized = Math.floor(numeric);
  if (normalized <= 0) return null;
  return normalized;
};

const buildRecordFromPayload = (
  event: NdkEvent,
  payload: PrivateLinkEnvelope,
  fallbackAlias: string | null,
  expirationFromTag: number | null
): PrivateLinkRecord | null => {
  const alias = normalizeAlias(payload.alias || fallbackAlias || "");
  if (!alias) return null;
  const createdAt = Number(payload.createdAt) || event.created_at || Math.floor(Date.now() / 1000);
  const status = payload.status === "revoked" ? "revoked" : "active";
  const target = normalizeTarget(status === "revoked" ? null : payload.target);
  const expiresAt = normalizeExpiration(payload.expiresAt ?? expirationFromTag);
  const isExpired = typeof expiresAt === "number" ? expiresAt <= Math.floor(Date.now() / 1000) : false;
  return {
    alias,
    status,
    createdAt,
    revokedAt: status === "revoked" ? Number(payload.revokedAt) || createdAt : null,
    target,
    displayName: typeof payload.displayName === "string" ? payload.displayName : null,
    eventId: event.id,
    updatedAt: event.created_at ?? createdAt,
    expiresAt,
    isExpired,
  };
};

const extractAliasTag = (event: NdkEvent): string | null => {
  const tag = event.tags.find(entry => Array.isArray(entry) && entry[0] === "d" && typeof entry[1] === "string");
  if (!tag) return null;
  const value = typeof tag[1] === "string" ? tag[1] : null;
  if (!value) return null;
  return normalizeAlias(value);
};

const extractStatusTag = (event: NdkEvent): PrivateLinkStatus | null => {
  const tag = event.tags.find(entry => Array.isArray(entry) && entry[0] === "status" && typeof entry[1] === "string");
  if (!tag) return null;
  const raw = typeof tag[1] === "string" ? tag[1] : "";
  const value = raw.trim().toLowerCase();
  if (value === "active" || value === "revoked") return value;
  return null;
};

const extractExpirationTag = (event: NdkEvent): number | null => {
  const tag = event.tags.find(entry => Array.isArray(entry) && entry[0] === "expiration" && typeof entry[1] === "string");
  if (!tag) return null;
  return normalizeExpiration(tag[1]);
};

const resolveTargetFromInput = (url: string, serverUrl?: string | null, sha?: string | null): PrivateLinkTarget => {
  const trimmedUrl = url.trim();
  const normalizedSha = sha?.trim() || extractSha256FromUrl(trimmedUrl) || null;
  let normalizedServer = serverUrl?.trim() || null;
  if (!normalizedServer && normalizedSha && trimmedUrl.includes(normalizedSha)) {
    try {
      const parsed = new URL(trimmedUrl);
      normalizedServer = `${parsed.origin}${parsed.pathname.replace(new RegExp(`${normalizedSha}.*$`), "")}`.replace(/\/$/, "");
    } catch {
      normalizedServer = null;
    }
  }
  return {
    url: trimmedUrl,
    server: normalizedServer,
    sha256: normalizedSha,
  };
};

const publishPrivateLinkEvent = async (
  ndk: NdkInstance | null,
  signer: NdkSignerInstance | null,
  user: NdkUserInstance | null,
  options: PublishPrivateLinkOptions
): Promise<PrivateLinkRecord> => {
  if (!ndk) throw new Error("NDK unavailable");
  if (!signer) throw new Error("Connect a Nostr signer to continue.");
  if (!user) throw new Error("Connect your Nostr account to continue.");
  if (!isPrivateLinkServiceConfigured()) {
    throw new Error("Private link service is not configured.");
  }
  if (!ensureEncryptionSigner(signer)) {
    throw new Error("Connected signer does not support encryption.");
  }

  const alias = normalizeAlias(options.alias);
  if (!alias) throw new Error("Alias is required.");

  const module = await loadNdkModule();
  const serviceUser = await getServiceUser(ndk, module);
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = normalizeExpiration(options.expiresAt);
  const normalizedTarget = options.status === "revoked" ? null : normalizeTarget(options.target);
  const envelope: PrivateLinkEnvelope = {
    version: 1,
    alias,
    status: options.status,
    createdAt,
    revokedAt: options.revokedAt ?? null,
    target: normalizedTarget,
    displayName: options.displayName ?? null,
    expiresAt: expiresAt ?? null,
  };

  const event = new module.NDKEvent(ndk);
  event.kind = PRIVATE_LINK_EVENT_KIND;
  event.pubkey = user.pubkey;
  event.created_at = createdAt;
  event.tags = [["d", alias], ["status", options.status]];
  if (typeof expiresAt === "number") {
    event.tags.push(["expiration", String(expiresAt)]);
  }
  event.tags.push(["proxy", PRIVATE_LINK_SERVICE_HOST]);
  if (options.displayName && options.displayName.trim()) {
    event.tags.push(["label", options.displayName.trim()]);
  }
  event.content = await encryptPayload(signer, serviceUser, envelope);
  await event.sign();

  const baseRelayUrls = ndk.explicitRelayUrls?.length ? ndk.explicitRelayUrls : Array.from(DEFAULT_PUBLIC_RELAYS);
  const relayUrls = new Set<string>();
  baseRelayUrls.forEach((url: string | null | undefined) => {
    if (typeof url === "string" && url.trim()) {
      relayUrls.add(url.trim());
    }
  });
  relayUrls.add(PRIVATE_LINK_REQUIRED_RELAY);

  const relaySet = module.NDKRelaySet.fromRelayUrls(Array.from(relayUrls), ndk);

  await event.publish(relaySet);

  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    alias,
    status: options.status,
    createdAt,
    revokedAt: options.revokedAt ?? (options.status === "revoked" ? createdAt : null),
    target: normalizedTarget,
    displayName: options.displayName ?? null,
    eventId: event.id,
    updatedAt: event.created_at ?? createdAt,
    expiresAt: expiresAt ?? null,
    isExpired: typeof expiresAt === "number" ? expiresAt <= nowSeconds : false,
  };
};

export const createPrivateLink = async (
  ndk: NdkInstance | null,
  signer: NdkSignerInstance | null,
  user: NdkUserInstance | null,
  input: CreatePrivateLinkInput
): Promise<PrivateLinkRecord> => {
  const alias = normalizeAlias(input.alias);
  if (!alias) throw new Error("Alias must contain letters or numbers.");
  const target = resolveTargetFromInput(input.url, input.serverUrl, input.sha256);
  return publishPrivateLinkEvent(ndk, signer, user, {
    alias,
    status: "active",
    target,
    displayName: input.displayName ?? null,
    expiresAt: input.expiresAt ?? null,
  });
};

export const revokePrivateLink = async (
  ndk: NdkInstance | null,
  signer: NdkSignerInstance | null,
  user: NdkUserInstance | null,
  alias: string
): Promise<PrivateLinkRecord> => {
  const normalizedAlias = normalizeAlias(alias);
  if (!normalizedAlias) throw new Error("Alias is required.");
  const now = Math.floor(Date.now() / 1000);
  return publishPrivateLinkEvent(ndk, signer, user, {
    alias: normalizedAlias,
    status: "revoked",
    target: null,
    revokedAt: now,
    createdAt: now,
  });
};

export const loadPrivateLinks = async (
  ndk: NdkInstance | null,
  signer: NdkSignerInstance | null,
  user: NdkUserInstance | null
): Promise<PrivateLinkRecord[]> => {
  if (!ndk || !signer || !user) return [];
  if (!isPrivateLinkServiceConfigured()) return [];
  if (!ensureEncryptionSigner(signer)) return [];

  const module = await loadNdkModule();
  const serviceUser = await getServiceUser(ndk, module);
  await ndk.connect().catch(() => undefined);
  const relaySet = module.NDKRelaySet.fromRelayUrls([PRIVATE_LINK_REQUIRED_RELAY], ndk);
  const eventsSet = (await ndk.fetchEvents(
    {
      kinds: [PRIVATE_LINK_EVENT_KIND],
      authors: [user.pubkey],
    },
    undefined,
    relaySet
  )) as Set<NdkEvent>;

  const map = new Map<string, PrivateLinkRecord>();
  const now = Math.floor(Date.now() / 1000);
  for (const event of eventsSet) {
    const aliasFromTag = extractAliasTag(event);
    if (!aliasFromTag) continue;
    const payload = await decryptPayload(signer, serviceUser, event.content || "");
    if (!payload) continue;
    const expirationTag = extractExpirationTag(event);
    const record = buildRecordFromPayload(event, payload, aliasFromTag, expirationTag);
    if (!record) continue;
    record.status = extractStatusTag(event) ?? record.status;
    record.isExpired = typeof record.expiresAt === "number" ? record.expiresAt <= now : false;
    const existing = map.get(record.alias);
    const existingUpdated = existing?.updatedAt ?? 0;
    const candidateUpdated = record.updatedAt ?? event.created_at ?? 0;
    if (!existing || candidateUpdated >= existingUpdated) {
      map.set(record.alias, record);
    }
  }

  return Array.from(map.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
};

export const generatePrivateLinkAlias = (length = 24): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const chars: string[] = [];
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    while (chars.length < length) {
      const index = Math.floor(Math.random() * alphabet.length);
    const char = alphabet.charAt(index) || alphabet.charAt(0);
    chars.push(char);
    }
    return chars.join("");
  }
  const bytes = new Uint8Array(length);
  cryptoObj.getRandomValues(bytes);
  for (let i = 0; i < length; i += 1) {
    const value = bytes[i] ?? 0;
    const index = value % alphabet.length;
    const char = alphabet.charAt(index) || alphabet.charAt(0);
    chars.push(char);
  }
  return chars.join("");
};
