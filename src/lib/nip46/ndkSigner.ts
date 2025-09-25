import type NDK from "@nostr-dev-kit/ndk";
import { NDKUser, type NostrEvent, type NDKSigner, type NDKRelay } from "@nostr-dev-kit/ndk";
import { validateEvent, verifyEvent, type Event as NostrToolsEvent } from "nostr-tools";

import type { Nip46Service } from "./service";
import type { SessionManager, RemoteSignerSession } from "./session";

const ensureSession = (session: RemoteSignerSession | null): RemoteSignerSession => {
  if (!session) {
    throw new Error("NIP-46 session unavailable");
  }
  if (!session.userPubkey) {
    throw new Error("NIP-46 session not ready");
  }
  return session;
};

export class Nip46DelegatedSigner implements NDKSigner {
  constructor(
    private readonly ndk: NDK,
    private readonly service: Nip46Service,
    private readonly sessions: SessionManager,
    private readonly sessionId: string
  ) {}

  private cachedUser?: NDKUser;

  private getSession(): RemoteSignerSession {
    const session = this.sessions.getSession(this.sessionId);
    return ensureSession(session);
  }

  get pubkey(): string {
    return this.getSession().userPubkey!;
  }

  async blockUntilReady(): Promise<NDKUser> {
    return this.user();
  }

  async user(): Promise<NDKUser> {
    if (!this.cachedUser) {
      const session = this.getSession();
      const user = new NDKUser({ pubkey: session.userPubkey! });
      user.ndk = this.ndk;
      this.cachedUser = user;
    }
    return this.cachedUser;
  }

  get userSync(): NDKUser {
    if (!this.cachedUser) throw new Error("Not ready");
    return this.cachedUser;
  }

  async sign(event: NostrEvent): Promise<string> {
    const session = this.getSession();
    const response = await this.service.sendRequest(session.id, "sign_event", [JSON.stringify(event)]);
    if (response.error) {
      throw new Error(response.error);
    }

    if (!response.result) {
      throw new Error("Signer returned empty result");
    }

    let signed: NostrEvent;
    try {
      signed = JSON.parse(response.result);
    } catch (error) {
      throw new Error("Unable to parse signed event");
    }

    const nostrEvent = signed as NostrToolsEvent;
    if (!validateEvent(nostrEvent) || !verifyEvent(nostrEvent)) {
      throw new Error("Remote signer returned an invalid signature");
    }

    if (signed.pubkey !== session.userPubkey) {
      throw new Error("Remote signer pubkey did not match session user pubkey");
    }

    event.id = signed.id;
    event.sig = signed.sig;
    event.pubkey = signed.pubkey;
    event.tags = signed.tags ?? event.tags;
    event.content = signed.content ?? event.content;
    event.created_at = signed.created_at ?? event.created_at;

    return event.sig!;
  }

  async encrypt(recipient: NDKUser, value: string, scheme: "nip44" | "nip04" = "nip44"): Promise<string> {
    const session = this.getSession();
    const method = scheme === "nip44" ? "nip44_encrypt" : "nip04_encrypt";
    const response = await this.service.sendRequest(session.id, method, [recipient.pubkey, value]);
    if (response.error || !response.result) {
      throw new Error(response.error ?? "Encryption failed");
    }
    return response.result;
  }

  async decrypt(sender: NDKUser, value: string, scheme: "nip44" | "nip04" = "nip44"): Promise<string> {
    const session = this.getSession();
    const method = scheme === "nip44" ? "nip44_decrypt" : "nip04_decrypt";
    const response = await this.service.sendRequest(session.id, method, [sender.pubkey, value]);
    if (response.error || !response.result) {
      throw new Error(response.error ?? "Decryption failed");
    }
    return response.result;
  }

  async relays(): Promise<NDKRelay[]> {
    const session = this.getSession();
    if (!this.ndk.pool) return [];
    const relays: NDKRelay[] = [];
    session.relays.forEach(url => {
      const relay = this.ndk.pool!.getRelay(url, false, false);
      if (relay) relays.push(relay);
    });
    return relays;
  }

  toPayload(): string {
    return JSON.stringify({ type: "nip46-delegated", sessionId: this.sessionId });
  }
}
