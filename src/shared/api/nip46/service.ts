import type { Nip46Codec } from "./codec";
import type {
  SessionManager,
  CreateSessionFromUriOptions,
  CreatedSessionResult,
  RemoteSignerMetadata,
  ParsedNostrConnectToken,
} from "./session";
import { createSessionFromUri } from "./session";
import { generateKeypair } from "./keys";
import type { Nip46Method, Nip46EncryptionAlgorithm } from "./types";
import { RequestQueue } from "./transport/requestQueue";
import type { TransportConfig } from "./transport";
import { sanitizeRelayUrl } from "../../utils/relays";

interface ServiceOptions {
  codec: Nip46Codec;
  sessionManager: SessionManager;
  transport: TransportConfig;
  requestTimeoutMs?: number;
}

export class Nip46Service {
  private readonly queue: RequestQueue;
  private initialized = false;

  constructor(private readonly options: ServiceOptions) {
    this.queue = new RequestQueue({
      codec: options.codec,
      sessionManager: options.sessionManager,
      transport: options.transport,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.queue.init();
    this.initialized = true;
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    await this.queue.shutdown();
    this.initialized = false;
  }

  async pairWithUri(
    uri: string,
    options?: CreateSessionFromUriOptions,
  ): Promise<CreatedSessionResult> {
    const result = await createSessionFromUri(this.options.sessionManager, uri, options);
    await this.init();

    const { session } = result;
    if (session.remoteSignerPubkey) {
      await this.initiateConnect(session.id);
    }

    return result;
  }

  async createInvitation(options?: CreateInvitationOptions): Promise<Nip46Invitation> {
    const keypair = generateKeypair();
    const relays = normalizeRelays(options?.relays);
    if (!relays.length) {
      throw new Error("NIP-46 invitations must include at least one relay URL.");
    }
    const algorithm = options?.algorithm ?? "nip44";
    let secret = options?.secret?.trim() ?? "";
    if (!secret) {
      secret = generateSecret();
    }
    const permissions = options?.permissions ?? [];
    const metadata = options?.metadata;

    const token = createTokenFromInvitation({
      clientPubkey: keypair.publicKey,
      relays,
      secret,
      permissions,
      metadata,
      algorithm,
    });

    const result = await this.options.sessionManager.createSession({
      token,
      keypair,
      metadata,
      algorithm,
    });

    await this.init();

    const uri = buildNostrConnectUri(token);
    return {
      ...result,
      uri,
    };
  }

  async sendRequest(sessionId: string, method: Nip46Method, params: string[], requestId?: string) {
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Unknown NIP-46 session: ${sessionId}`);
    await this.init();
    const payload = this.options.codec.createRequest(method, params, requestId);
    return this.queue.enqueue(session, payload);
  }

  async connectSession(sessionId: string): Promise<void> {
    await this.init();
    await this.initiateConnect(sessionId);
  }

  private async initiateConnect(sessionId: string) {
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session) return;
    if (!session.remoteSignerPubkey) return;

    const params: string[] = [session.remoteSignerPubkey];
    const { nostrConnectSecret, permissions } = session;

    if (nostrConnectSecret) {
      params.push(nostrConnectSecret);
    } else if (permissions.length) {
      params.push("");
    }

    if (permissions.length) {
      params.push(permissions.join(","));
    }

    try {
      await this.sendRequest(sessionId, "connect", params);
    } catch (error) {
      console.error("NIP-46 connect request failed", error);
      return;
    }

    const shouldFetchUserPubkey =
      !session.userPubkey && session.permissions.includes("get_public_key");
    if (shouldFetchUserPubkey) {
      await this.fetchUserPublicKey(sessionId);
    }
  }

  async fetchUserPublicKey(sessionId: string): Promise<void> {
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session) return;
    try {
      const response = await this.sendRequest(sessionId, "get_public_key", []);
      if (!response.error && response.result) {
        await this.options.sessionManager.updateSession(sessionId, {
          userPubkey: response.result,
          lastError: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Failed to fetch user pubkey for session", sessionId, message);
      await this.options.sessionManager.updateSession(sessionId, {
        lastError: message,
      });
    }
  }
}

interface InvitationTokenInput {
  clientPubkey: string;
  relays: string[];
  secret: string;
  permissions: string[];
  metadata?: RemoteSignerMetadata;
  algorithm: Nip46EncryptionAlgorithm;
}

const createTokenFromInvitation = (input: InvitationTokenInput): ParsedNostrConnectToken => {
  const { clientPubkey, relays, secret, permissions, metadata, algorithm } = input;
  const rawParams: Record<string, string | string[]> = {};
  if (relays.length) rawParams.relay = [...relays];
  if (secret) rawParams.secret = secret;
  if (permissions.length) rawParams.perms = permissions.join(",");
  if (metadata?.name) rawParams.name = metadata.name;
  if (metadata?.url) rawParams.url = metadata.url;
  if (metadata?.image) rawParams.image = metadata.image;
  if (metadata) rawParams.metadata = JSON.stringify(metadata);
  if (algorithm) rawParams.alg = algorithm;

  return {
    type: "nostrconnect",
    clientPubkey,
    relays,
    secret,
    permissions,
    metadata,
    algorithm,
    rawParams,
  };
};

const normalizeRelays = (relays?: string[]): string[] => {
  if (!relays?.length) return [];
  const unique = new Set<string>();
  relays.forEach(relay => {
    if (typeof relay !== "string") return;
    const sanitized = sanitizeRelayUrl(relay);
    if (!sanitized) return;
    const normalized = sanitized.endsWith("/") ? sanitized : `${sanitized}/`;
    unique.add(normalized);
  });
  return Array.from(unique);
};

const generateSecret = (byteLength = 16): string => {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(bytes);
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

const buildNostrConnectUri = (token: ParsedNostrConnectToken): string => {
  const params = new URLSearchParams();
  token.relays.forEach(relay => {
    params.append("relay", relay);
  });
  if (token.secret) {
    params.set("secret", token.secret);
  }
  if (token.permissions.length) {
    params.set("perms", token.permissions.join(","));
  }
  if (token.algorithm) {
    params.set("alg", token.algorithm);
  }
  if (token.metadata) {
    if (token.metadata.name) {
      params.set("name", token.metadata.name);
    }
    if (token.metadata.url) {
      params.set("url", token.metadata.url);
    }
    if (token.metadata.image) {
      params.set("image", token.metadata.image);
    }
    params.set("metadata", JSON.stringify(token.metadata));
  }
  const query = params.toString();
  const encodedPubkey = encodeURIComponent(token.clientPubkey);
  return query ? `nostrconnect://${encodedPubkey}?${query}` : `nostrconnect://${encodedPubkey}`;
};

export interface CreateInvitationOptions {
  relays?: string[];
  metadata?: RemoteSignerMetadata;
  permissions?: string[];
  secret?: string;
  algorithm?: Nip46EncryptionAlgorithm;
}

export interface Nip46Invitation extends CreatedSessionResult {
  uri: string;
}
