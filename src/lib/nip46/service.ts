import { Nip46Codec } from "./codec";
import {
  SessionManager,
  createSessionFromUri,
  CreateSessionFromUriOptions,
  CreatedSessionResult,
} from "./session";
import { Nip46Method } from "./types";
import { RequestQueue } from "./transport/requestQueue";
import { TransportConfig } from "./transport";

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

  async pairWithUri(uri: string, options?: CreateSessionFromUriOptions): Promise<CreatedSessionResult> {
    const result = await createSessionFromUri(this.options.sessionManager, uri, options);
    await this.init();

    const { session } = result;
    if (session.remoteSignerPubkey) {
      await this.initiateConnect(session.id);
    }

    return result;
  }

  async sendRequest(
    sessionId: string,
    method: Nip46Method,
    params: string[],
    requestId?: string
  ) {
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

    const shouldFetchUserPubkey = !session.userPubkey && session.permissions.includes("get_public_key");
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
