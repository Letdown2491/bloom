import { finalizeEvent } from "nostr-tools";

import { Nip46Codec } from "../codec";
import { RemoteSignerSession, SessionManager } from "../session";
import { hexToBytes } from "../keys";
import { Nip46AnyResponse, Nip46CodecError, Nip46RequestPayload, Nip46ResponsePayload } from "../types";
import { PendingRequest, TransportConfig, NostrEvent, NostrFilter } from "./types";

const REQUEST_KIND = 24133;

const seconds = () => Math.floor(Date.now() / 1000);

interface QueueOptions {
  codec: Nip46Codec;
  sessionManager: SessionManager;
  transport: TransportConfig;
  /** number of milliseconds to wait before timing out a request */
  requestTimeoutMs?: number;
}

type InflightRecord = {
  resolve: (response: Nip46AnyResponse) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

const TAG_P = "p";

export class RequestQueue {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly inflight = new Map<string, InflightRecord>();
  private unsubscribe: (() => void) | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private initialized = false;

  constructor(private readonly options: QueueOptions) {
    this.sessionUnsubscribe = this.options.sessionManager.onChange(() => {
      if (this.initialized) {
        this.refreshSubscription();
      }
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.refreshSubscription();
  }

  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
    this.initialized = false;
    this.requests.clear();
    this.inflight.forEach(record => {
      if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
    });
    this.inflight.clear();
  }

  async enqueue(session: RemoteSignerSession, payload: Nip46RequestPayload): Promise<Nip46AnyResponse> {
    if (!session.remoteSignerPubkey) {
      throw new Error("Session does not yet know remote signer pubkey");
    }

    const request: PendingRequest = {
      id: payload.id,
      method: payload.method,
      sessionId: session.id,
      createdAt: Date.now(),
      state: "pending",
      payload,
    };
    this.requests.set(request.id, request);

    try {
      return await new Promise<Nip46AnyResponse>((resolve, reject) => {
        const inflightRecord: InflightRecord = { resolve, reject, timeoutHandle: null };
        this.inflight.set(request.id, inflightRecord);
        this.scheduleTimeout(request.id, inflightRecord);
        this.publishRequest(session, request).catch(async error => {
          if (inflightRecord.timeoutHandle) clearTimeout(inflightRecord.timeoutHandle);
          this.inflight.delete(request.id);
          const message = error instanceof Error ? error.message : String(error);
          const pending = session.relays.length ? [...session.relays] : null;
          const status = message.startsWith("relay-not-connected") ? "pairing" : session.status;
          await this.options.sessionManager.updateSession(session.id, {
            lastError: message,
            pendingRelays: pending,
            status,
          });
          reject(error instanceof Error ? error : new Error(message));
        });
      });
    } finally {
      this.requests.delete(request.id);
    }
  }

  private scheduleTimeout(requestId: string, inflight: InflightRecord): void {
    const timeoutMs = this.options.requestTimeoutMs ?? 60_000;
    if (!timeoutMs) return;
    inflight.timeoutHandle = setTimeout(() => {
      this.inflight.delete(requestId);
      this.updateRequestState(requestId, { state: "expired" });
      inflight.reject(new Error("NIP-46 request timed out"));
    }, timeoutMs);
  }

  private async publishRequest(session: RemoteSignerSession, request: PendingRequest): Promise<void> {
    const privateKey = hexToBytes(session.clientPrivateKey);
    const context = {
      localPrivateKey: privateKey,
      remotePublicKey: session.remoteSignerPubkey,
      algorithm: session.algorithm,
    } as const;

    if (session.relays.length) {
      await this.options.sessionManager.updateSession(session.id, {
        pendingRelays: [...session.relays],
      });
    }

    let ciphertext: string;
    try {
      ciphertext = await this.options.codec.encodeRequest(request.payload, context);
    } catch (error) {
      const message =
        error instanceof Nip46CodecError ? error.message : "Failed to encode NIP-46 request payload";
      throw new Error(message);
    }

    const tags = [[TAG_P, session.remoteSignerPubkey]] as string[][];
    const created_at = seconds();
    const unsigned = {
      kind: REQUEST_KIND,
      content: ciphertext,
      tags,
      created_at,
    } as const;

    let signed;
    try {
      signed = finalizeEvent(unsigned, privateKey);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Failed to sign NIP-46 request event");
    }

    const event: NostrEvent = {
      ...signed,
      relays: session.relays.length ? session.relays : undefined,
      sessionId: session.id,
    };

    await this.options.transport.publish(event);
    this.updateRequestState(request.id, {
      state: "sent",
      lastSentAt: Date.now(),
    });

    await this.options.sessionManager.updateSession(session.id, {
      pendingRelays: null,
    });
  }

  private updateRequestState(id: string, update: Partial<PendingRequest>) {
    const current = this.requests.get(id);
    if (!current) return;
    const next: PendingRequest = { ...current, ...update };
    this.requests.set(id, next);
  }

  private async refreshSubscription(): Promise<void> {
    this.unsubscribe?.();
    const clientKeys = this.options.sessionManager
      .getSessions()
      .map(session => session.clientPublicKey)
      .filter(Boolean);

    if (!clientKeys.length) {
      this.unsubscribe = null;
      return;
    }

    const timestampCandidates: number[] = [];
    this.options.sessionManager.getSessions().forEach(session => {
      if (session.lastSeenAt) {
        timestampCandidates.push(session.lastSeenAt);
      } else if (session.updatedAt) {
        timestampCandidates.push(session.updatedAt);
      } else {
        timestampCandidates.push(session.createdAt);
      }
    });
    this.requests.forEach(request => {
      timestampCandidates.push(request.createdAt);
      if (request.lastSentAt) timestampCandidates.push(request.lastSentAt);
    });

    const defaultWindowSeconds = 60;
    const nowSeconds = seconds();
    const sinceSeconds = timestampCandidates.length
      ? Math.max(0, Math.floor(Math.min(...timestampCandidates) / 1000) - 30)
      : Math.max(0, nowSeconds - defaultWindowSeconds);

    const filter: NostrFilter = {
      kinds: [REQUEST_KIND],
      since: sinceSeconds,
    };
    filter["#p"] = clientKeys;

    const filters: NostrFilter[] = [filter];

    this.unsubscribe = this.options.transport.subscribe(filters, this.handleEvent);
  }

  private handleEvent = (event: NostrEvent) => {
    this.processEvent(event).catch(error => {
      console.error("Failed to process NIP-46 response", error);
    });
  };

  private async processEvent(event: NostrEvent): Promise<void> {
    if (event.kind !== REQUEST_KIND) return;

    const clientTag = event.tags.find(
      (tag): tag is [string, string, ...string[]] => tag[0] === TAG_P && typeof tag[1] === "string"
    );
    if (!clientTag) return;
    const clientPubkey = clientTag[1];
    const session = this.options.sessionManager.getSessionByClientPubkey(clientPubkey);
    if (!session) return;

    const context = {
      localPrivateKey: hexToBytes(session.clientPrivateKey),
      remotePublicKey: event.pubkey,
      algorithm: session.algorithm,
    } as const;

    let payload: Nip46AnyResponse;
    try {
      payload = await this.options.codec.decodeResponse(event.content, context);
    } catch (error) {
      if (error instanceof Nip46CodecError) {
        try {
          const requestPayload = await this.options.codec.decodeRequest(event.content, context);
          await this.handleIncomingRequest(session, requestPayload, event);
          return;
        } catch (innerError) {
          throw new Error(
            innerError instanceof Nip46CodecError
              ? innerError.message
              : "Failed to decode NIP-46 response payload"
          );
        }
      }
      throw new Error(error instanceof Error ? error.message : "Failed to decode NIP-46 response payload");
    }

    const pendingRequest = this.requests.get(payload.id);
    const inflight = this.inflight.get(payload.id);

    const pendingMethod = pendingRequest?.method;

    const isAuthChallenge = payload.result === "auth_url" && typeof payload.error === "string";
    if (isAuthChallenge) {
      if (inflight?.timeoutHandle) clearTimeout(inflight.timeoutHandle);
      if (inflight) this.scheduleTimeout(payload.id, inflight);
      await this.options.sessionManager.updateSession(session.id, {
        lastSeenAt: Date.now(),
        status: "pairing",
        authChallengeUrl: payload.error,
        lastError: null,
        pendingRelays: null,
      });
      this.updateRequestState(payload.id, {
        state: "challenge",
        response: payload,
        error: undefined,
      });
      return;
    }

    const rawError = typeof payload.error === "string" ? payload.error : undefined;
    const normalizedErrorText = rawError?.toLowerCase() ?? null;
    const isAlreadyConnectedError =
      normalizedErrorText !== null &&
      normalizedErrorText.includes("already") &&
      normalizedErrorText.includes("connect") &&
      (pendingMethod === "connect" || (!pendingMethod && session.status === "active"));
    const normalizedPayloadError = isAlreadyConnectedError ? undefined : rawError;
    const responseRecord = isAlreadyConnectedError ? { ...payload, error: undefined } : payload;

    const baseUpdate: Partial<RemoteSignerSession> = {
      lastSeenAt: Date.now(),
      authChallengeUrl: null,
    };

    const validateSecret = (): string | undefined => {
      if (!session.nostrConnectSecret) return undefined;
      const normalized = payload.result?.toLowerCase();
      if (!normalized || normalized === "ack") {
        baseUpdate.nostrConnectSecret = undefined;
        return undefined;
      }
      if (payload.result === session.nostrConnectSecret) {
        baseUpdate.nostrConnectSecret = undefined;
        return undefined;
      }
      return "Remote signer failed secret validation";
    };

    if (!session.remoteSignerPubkey) {
      baseUpdate.remoteSignerPubkey = event.pubkey;
    }

    let resultingError: string | undefined;

    const finalizeWithoutPending = async () => {
      resultingError = validateSecret();
      if (resultingError) {
        baseUpdate.status = "revoked";
      } else if (normalizedPayloadError) {
        baseUpdate.status = "pairing";
      } else {
        baseUpdate.status = "active";
      }
      baseUpdate.lastError = resultingError ?? normalizedPayloadError ?? session.lastError ?? null;
      baseUpdate.pendingRelays = null;
      await this.options.sessionManager.updateSession(session.id, baseUpdate);
      if (resultingError) {
        console.warn(resultingError);
      }
    };

    if (!pendingRequest) {
      if (inflight?.timeoutHandle) clearTimeout(inflight.timeoutHandle);
      if (inflight) this.inflight.delete(payload.id);
      await finalizeWithoutPending();
      return;
    }

    if (!inflight) return;

    if (inflight.timeoutHandle) clearTimeout(inflight.timeoutHandle);
    this.inflight.delete(payload.id);

    if (pendingRequest.method === "connect") {
      resultingError = validateSecret();
      if (resultingError) {
        baseUpdate.status = "revoked";
      } else if (normalizedPayloadError) {
        baseUpdate.status = "pairing";
      } else {
        baseUpdate.status = "active";
      }
    } else {
      baseUpdate.status = normalizedPayloadError ? "pairing" : "active";
    }

    const effectiveError = resultingError ?? normalizedPayloadError ?? undefined;
    baseUpdate.lastError = effectiveError ?? null;

    await this.options.sessionManager.updateSession(session.id, baseUpdate);

    this.updateRequestState(payload.id, {
      state: effectiveError ? "error" : "resolved",
      response: responseRecord,
      error: effectiveError,
    });

    if (effectiveError) {
      inflight.reject(new Error(effectiveError));
      return;
    }

    inflight.resolve(responseRecord);
  }

  private async handleIncomingRequest(
    session: RemoteSignerSession,
    request: Nip46RequestPayload,
    event: NostrEvent
  ): Promise<void> {
    if (request.method !== "connect") {
      await this.publishResponse(session, event.pubkey, {
        id: request.id,
        error: "unsupported_method",
      });
      return;
    }

    const update: Partial<RemoteSignerSession> = {
      lastSeenAt: Date.now(),
      authChallengeUrl: null,
      pendingRelays: null,
    };

    const remoteSignerPubkey = event.pubkey;
    if (!session.remoteSignerPubkey) {
      update.remoteSignerPubkey = remoteSignerPubkey;
    }

    const providedSecret = request.params[1]?.trim();
    let responseResult: string | undefined = undefined;
    let responseError: string | undefined = undefined;

    const expectSecret = Boolean(session.nostrConnectSecret);
    if (expectSecret && providedSecret && providedSecret !== session.nostrConnectSecret) {
      update.status = "revoked";
      update.lastError = "Signer failed secret validation";
      responseError = "invalid_secret";
    } else {
      update.status = "active";
      update.lastError = null;
      update.nostrConnectSecret = undefined;
      responseResult = session.nostrConnectSecret ?? "ack";
    }

    await this.options.sessionManager.updateSession(session.id, update);

    if (!responseError) {
      void this.options.sessionManager.setActiveSession(session.id).catch(() => undefined);
      const refreshed = this.options.sessionManager.getSession(session.id);
      if (
        refreshed &&
        !refreshed.userPubkey &&
        refreshed.permissions.includes("get_public_key") &&
        refreshed.remoteSignerPubkey
      ) {
        const requestPayload = this.options.codec.createRequest("get_public_key", []);
        void this.enqueue(refreshed, requestPayload).catch(error => {
          console.warn("Failed to auto-fetch user public key", error);
        });
      }
    }

    await this.publishResponse(session, remoteSignerPubkey, {
      id: request.id,
      result: responseResult,
      error: responseError,
    });
  }

  private async publishResponse(
    session: RemoteSignerSession,
    remotePubkey: string,
    payload: Nip46ResponsePayload
  ): Promise<void> {
    const privateKey = hexToBytes(session.clientPrivateKey);
    const context = {
      localPrivateKey: privateKey,
      remotePublicKey: remotePubkey,
      algorithm: session.algorithm,
    } as const;

    let ciphertext: string;
    try {
      ciphertext = await this.options.codec.encodeResponse(payload, context);
    } catch (error) {
      throw new Error(
        error instanceof Nip46CodecError ? error.message : "Failed to encode NIP-46 response payload"
      );
    }

    const tags = [[TAG_P, remotePubkey]] as string[][];
    const created_at = seconds();
    const unsigned = {
      kind: REQUEST_KIND,
      content: ciphertext,
      tags,
      created_at,
    } as const;

    let signed;
    try {
      signed = finalizeEvent(unsigned, privateKey);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Failed to sign NIP-46 response event");
    }

    const event = {
      ...signed,
      relays: session.relays.length ? session.relays : undefined,
      sessionId: session.id,
    } as NostrEvent;

    await this.options.transport.publish(event);
  }
}
