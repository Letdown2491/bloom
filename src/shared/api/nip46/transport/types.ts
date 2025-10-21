import type { Nip46AnyResponse, Nip46RequestPayload } from "../types";

export type RequestState = "pending" | "sent" | "resolved" | "error" | "expired" | "challenge";

export interface PendingRequest {
  id: string;
  method: Nip46RequestPayload["method"];
  sessionId: string;
  createdAt: number;
  lastSentAt?: number;
  state: RequestState;
  payload: Nip46RequestPayload;
  error?: string;
  response?: Nip46AnyResponse;
}

export interface TransportPublishOptions {
  relayUrls: string[];
  timeoutMs?: number;
}

export interface QueuedRequest {
  request: PendingRequest;
  resolve: (response: Nip46AnyResponse) => void;
  reject: (reason: Error) => void;
}

export interface TransportConfig {
  publish: (event: NostrEvent) => Promise<void>;
  subscribe: (filters: NostrFilter[], handler: (event: NostrEvent) => void) => () => void;
}

export interface NostrEvent {
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  id?: string;
  sig?: string;
  relays?: string[];
  sessionId?: string;
}

export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  "#p"?: string[];
  since?: number;
  limit?: number;
  relays?: string[];
}
