import { Nip46EncryptionAlgorithm } from "./types";
import { generateKeypair, Nip46Keypair, exportPrivateKey } from "./keys";

export type RemoteSignerStatus = "pairing" | "active" | "revoked";

export interface RemoteSignerMetadata {
  name?: string | null;
  image?: string | null;
  url?: string | null;
  description?: string | null;
}

export interface RemoteSignerSession {
  id: string;
  remoteSignerPubkey: string;
  userPubkey?: string | null;
  clientPublicKey: string;
  clientPrivateKey: string;
  relays: string[];
  permissions: string[];
  status: RemoteSignerStatus;
  algorithm: Nip46EncryptionAlgorithm;
  nostrConnectSecret?: string;
  metadata?: RemoteSignerMetadata;
  lastSeenAt?: number | null;
  lastError?: string | null;
  pendingRelays?: string[] | null;
  authChallengeUrl?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSnapshot {
  sessions: RemoteSignerSession[];
  activeSessionId: string | null;
}

export interface Nip46SessionStore {
  load: () => Promise<SessionSnapshot | null>;
  save: (snapshot: SessionSnapshot) => Promise<void>;
}

export class InMemorySessionStore implements Nip46SessionStore {
  private snapshot: SessionSnapshot | null = null;

  async load(): Promise<SessionSnapshot | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

export type SessionListener = (snapshot: SessionSnapshot) => void;

export class SessionManager {
  private readonly sessions = new Map<string, RemoteSignerSession>();
  private activeSessionId: string | null = null;
  private readonly listeners = new Set<SessionListener>();
  private hydrated = false;

  constructor(private readonly store: Nip46SessionStore) {}

  async hydrate(): Promise<SessionSnapshot> {
    if (this.hydrated) return this.snapshot();
    let needsPersist = false;
    const snapshot = await this.store.load();
    if (snapshot) {
      snapshot.sessions.forEach(session => {
        const normalized: RemoteSignerSession = {
          ...session,
        };
        if (normalized.authChallengeUrl === undefined) {
          normalized.authChallengeUrl = null;
        }
        if (
          !normalized.userPubkey &&
          normalized.remoteSignerPubkey &&
          normalized.id.startsWith("bunker:")
        ) {
          normalized.userPubkey = normalized.remoteSignerPubkey;
          needsPersist = true;
        }
        this.sessions.set(normalized.id, normalized);
      });
      this.activeSessionId = snapshot.activeSessionId;
    }
    this.hydrated = true;
    if (needsPersist) {
      await this.persist();
    }
    return this.snapshot();
  }

  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSessions(): RemoteSignerSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveSession(): RemoteSignerSession | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  getSession(id: string): RemoteSignerSession | null {
    return this.sessions.get(id) ?? null;
  }

  getSessionByClientPubkey(pubkey: string): RemoteSignerSession | null {
    for (const session of this.sessions.values()) {
      if (session.clientPublicKey === pubkey) return session;
    }
    return null;
  }

  async upsertSession(partial: Omit<RemoteSignerSession, "createdAt" | "updatedAt"> & {
    createdAt?: number;
    updatedAt?: number;
  }): Promise<RemoteSignerSession> {
    const now = Date.now();
    const existing = this.sessions.get(partial.id);
    const session: RemoteSignerSession = {
      ...partial,
      createdAt: existing?.createdAt ?? partial.createdAt ?? now,
      updatedAt: partial.updatedAt ?? now,
    };
    this.sessions.set(session.id, session);
    if (!this.activeSessionId) {
      this.activeSessionId = session.id;
    }
    await this.persist();
    this.emit();
    return session;
  }

  async setActiveSession(id: string | null): Promise<void> {
    this.activeSessionId = id;
    await this.persist();
    this.emit();
  }

  async updateSession(id: string, update: Partial<RemoteSignerSession>): Promise<RemoteSignerSession | null> {
    const current = this.sessions.get(id);
    if (!current) return null;
    const next: RemoteSignerSession = {
      ...current,
      ...update,
      updatedAt: Date.now(),
    };
    this.sessions.set(id, next);
    await this.persist();
    this.emit();
    return next;
  }

  async removeSession(id: string): Promise<void> {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    if (this.activeSessionId === id) {
      const first = this.sessions.values().next();
      this.activeSessionId = first.done ? null : first.value.id;
    }
    await this.persist();
    this.emit();
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSessionResult> {
    const keypair = input.keypair ?? generateKeypair();
    const now = Date.now();
    const baseId =
      input.token.type === "nostrconnect" ? input.token.clientPubkey : input.token.remoteSignerPubkey;
    const sessionId = `${input.token.type}:${baseId}:${now}`;
    const relays = Array.from(new Set(input.token.relays.filter(relay => relay.trim().length > 0)));
    const basePermissions =
      input.token.type === "nostrconnect"
        ? Array.from(new Set(input.token.permissions))
        : [];
    const permissions = mergePermissions(basePermissions);

    const session: RemoteSignerSession = {
      id: sessionId,
      remoteSignerPubkey: input.token.type === "bunker" ? input.token.remoteSignerPubkey : "",
      userPubkey: input.token.type === "bunker" ? input.token.remoteSignerPubkey : undefined,
      clientPublicKey: keypair.publicKey,
      clientPrivateKey: exportPrivateKey(keypair),
      relays,
      permissions,
      status: "pairing",
      algorithm: input.algorithm ?? "nip44",
      nostrConnectSecret: input.token.secret,
      metadata: input.metadata ?? input.token.metadata,
      lastError: null,
      authChallengeUrl: null,
      pendingRelays: relays.length ? [...relays] : null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.token.type === "nostrconnect") {
      session.remoteSignerPubkey = "";
    }
    await this.upsertSession(session);
    return {
      session,
      keypair,
    };
  }

  snapshot(): SessionSnapshot {
    return {
      sessions: Array.from(this.sessions.values()),
      activeSessionId: this.activeSessionId,
    };
  }

  private async persist(): Promise<void> {
    if (!this.hydrated) return;
    await this.store.save(this.snapshot());
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }
}

export interface ParsedNostrConnectToken {
  type: "nostrconnect";
  clientPubkey: string;
  relays: string[];
  secret: string;
  permissions: string[];
  metadata?: RemoteSignerMetadata;
  rawParams: Record<string, string | string[]>;
}

export interface ParsedBunkerToken {
  type: "bunker";
  remoteSignerPubkey: string;
  relays: string[];
  secret?: string;
  metadata?: RemoteSignerMetadata;
  rawParams: Record<string, string | string[]>;
}

export type ParsedPairingToken = ParsedNostrConnectToken | ParsedBunkerToken;

export interface CreateSessionInput {
  token: ParsedNostrConnectToken | ParsedBunkerToken;
  algorithm?: Nip46EncryptionAlgorithm;
  metadata?: RemoteSignerMetadata;
  keypair?: Nip46Keypair;
}

export interface CreatedSessionResult {
  session: RemoteSignerSession;
  keypair: Nip46Keypair;
}

const DEFAULT_PERMISSIONS = [
  "sign_event",
  "nip44_encrypt",
  "nip44_decrypt",
  "nip04_encrypt",
  "nip04_decrypt",
  "get_public_key",
] as const;

const mergePermissions = (tokenPermissions: string[]): string[] => {
  const permissions: string[] = [...DEFAULT_PERMISSIONS];
  tokenPermissions.forEach(permission => {
    if (!permission) return;
    if (!permissions.includes(permission)) permissions.push(permission);
  });
  return permissions;
};

const decodeMetadata = (value: string | null): RemoteSignerMetadata | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const metadata: RemoteSignerMetadata = {};
    if (typeof record.name === "string") metadata.name = record.name;
    if (typeof record.image === "string") metadata.image = record.image;
    if (typeof record.url === "string") metadata.url = record.url;
    if (typeof record.description === "string") metadata.description = record.description;
    return metadata;
  } catch (error) {
    console.warn("Unable to parse NIP-46 metadata", error);
    return undefined;
  }
};

const collectParams = (params: URLSearchParams): Record<string, string | string[]> => {
  const entries: Record<string, string | string[]> = {};
  params.forEach((value, key) => {
    if (entries[key]) {
      const existing = entries[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        entries[key] = [existing, value];
      }
    } else {
      const all = params.getAll(key);
      entries[key] = all.length > 1 ? all : value;
    }
  });
  return entries;
};

const parsePermissions = (value: string | null): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
};

export const parseNostrConnectUri = (uri: string): ParsedNostrConnectToken => {
  if (!uri.startsWith("nostrconnect://")) {
    throw new Error("Invalid nostrconnect URI");
  }
  const payload = uri.slice("nostrconnect://".length);
  const [idPart, query = ""] = payload.split("?");
  if (!idPart) throw new Error("nostrconnect URI missing client pubkey");
  const clientPubkey = decodeURIComponent(idPart);
  const params = new URLSearchParams(query);
  const relayValues = params
    .getAll("relay")
    .map(relay => decodeURIComponent(relay).trim())
    .filter(relay => relay.length > 0);
  const uniqueRelays = Array.from(new Set(relayValues));
  if (!uniqueRelays.length) {
    throw new Error("nostrconnect URI must include at least one relay parameter");
  }
  const secretValue = params.get("secret");
  const secret = secretValue?.trim();
  if (!secret) {
    throw new Error("nostrconnect URI must include a non-empty secret parameter");
  }
  const metadata = decodeMetadata(params.get("metadata"));
  const perms = parsePermissions(params.get("perms"));

  return {
    type: "nostrconnect",
    clientPubkey,
    relays: uniqueRelays,
    secret,
    metadata,
    permissions: perms,
    rawParams: collectParams(params),
  };
};

export const parseBunkerUri = (uri: string): ParsedBunkerToken => {
  if (!uri.startsWith("bunker://")) {
    throw new Error("Invalid bunker URI");
  }
  const payload = uri.slice("bunker://".length);
  const [idPart, query = ""] = payload.split("?");
  if (!idPart) throw new Error("bunker URI missing signer pubkey");
  const remoteSignerPubkey = decodeURIComponent(idPart);
  const params = new URLSearchParams(query);
  const relays = params.getAll("relay").map(relay => decodeURIComponent(relay));
  const secret = params.get("secret") ?? undefined;
  const metadata = decodeMetadata(params.get("metadata"));

  return {
    type: "bunker",
    remoteSignerPubkey,
    relays,
    secret,
    metadata,
    rawParams: collectParams(params),
  };
};

export const parsePairingUri = (uri: string): ParsedPairingToken => {
  if (uri.startsWith("nostrconnect://")) {
    return parseNostrConnectUri(uri);
  }
  if (uri.startsWith("bunker://")) {
    return parseBunkerUri(uri);
  }
  throw new Error("Unsupported NIP-46 pairing URI");
};

export interface CreateSessionFromUriOptions {
  algorithm?: Nip46EncryptionAlgorithm;
  metadata?: RemoteSignerMetadata;
}

export const createSessionFromUri = async (
  manager: SessionManager,
  uri: string,
  options?: CreateSessionFromUriOptions
): Promise<CreatedSessionResult> => {
  const token = parsePairingUri(uri);
  return manager.createSession({
    token,
    algorithm: options?.algorithm,
    metadata: options?.metadata,
  });
};
