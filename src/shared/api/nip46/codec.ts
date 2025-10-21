import type {
  Nip46AnyResponse,
  Nip46CodecConfig,
  Nip46EncryptFn,
  Nip46DecryptFn,
  Nip46EncryptionContext,
  Nip46Method,
  Nip46RequestPayload,
  Nip46ResponsePayload,
} from "./types";
import { Nip46CodecError } from "./types";

export interface Nip46CodecOptions {
  config: Nip46CodecConfig;
  /** Optional custom id generator (defaults to crypto.randomUUID or timestamp fallback) */
  generateId?: () => string;
}

const DEFAULT_ID_GENERATOR = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertMethod = (method: unknown): method is Nip46Method =>
  typeof method === "string" &&
  (method === "connect" ||
    method === "sign_event" ||
    method === "ping" ||
    method === "get_public_key" ||
    method === "nip04_encrypt" ||
    method === "nip04_decrypt" ||
    method === "nip44_encrypt" ||
    method === "nip44_decrypt");

const assertParams = (params: unknown): params is string[] =>
  Array.isArray(params) && params.every(item => typeof item === "string");

const assertResponse = (payload: unknown): payload is Nip46AnyResponse => {
  if (!isPlainRecord(payload)) return false;
  if (typeof payload.id !== "string" || payload.id.length === 0) return false;
  if (payload.result !== undefined && typeof payload.result !== "string") return false;
  if (payload.error !== undefined && typeof payload.error !== "string") return false;
  return true;
};

const assertRequest = (payload: unknown): payload is Nip46RequestPayload => {
  if (!isPlainRecord(payload)) return false;
  if (typeof payload.id !== "string" || payload.id.length === 0) return false;
  if (!assertMethod(payload.method)) return false;
  if (!assertParams(payload.params)) return false;
  return true;
};

export class Nip46Codec {
  private readonly encrypt: Nip46EncryptFn;
  private readonly decrypt: Nip46DecryptFn;
  private readonly generateId: () => string;

  constructor(options: Nip46CodecOptions) {
    this.encrypt = options.config.encrypt;
    this.decrypt = options.config.decrypt;
    this.generateId = options.generateId ?? DEFAULT_ID_GENERATOR;
  }

  createRequest(method: Nip46Method, params: string[], id?: string): Nip46RequestPayload {
    const request: Nip46RequestPayload = {
      id: id ?? this.generateId(),
      method,
      params,
    };
    return request;
  }

  async encodeRequest(
    payload: Nip46RequestPayload,
    context: Nip46EncryptionContext,
  ): Promise<string> {
    try {
      const json = JSON.stringify(payload);
      return await this.encrypt(json, context);
    } catch (error) {
      throw new Nip46CodecError("NIP46_ENCODE_ERROR", "Failed to encode NIP-46 request", error);
    }
  }

  async decodeRequest(
    ciphertext: string,
    context: Nip46EncryptionContext,
  ): Promise<Nip46RequestPayload> {
    let plaintext: string;
    try {
      plaintext = await this.decrypt(ciphertext, context);
    } catch (error) {
      throw new Nip46CodecError("NIP46_DECODE_ERROR", "Failed to decrypt NIP-46 request", error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (error) {
      throw new Nip46CodecError("NIP46_DECODE_ERROR", "Failed to parse NIP-46 request JSON", error);
    }

    if (!assertRequest(parsed)) {
      throw new Nip46CodecError(
        "NIP46_UNEXPECTED_PAYLOAD",
        "Decrypted payload is not a valid NIP-46 request",
      );
    }
    return parsed;
  }

  async encodeResponse(
    payload: Nip46ResponsePayload,
    context: Nip46EncryptionContext,
  ): Promise<string> {
    try {
      const json = JSON.stringify(payload);
      return await this.encrypt(json, context);
    } catch (error) {
      throw new Nip46CodecError("NIP46_ENCODE_ERROR", "Failed to encode NIP-46 response", error);
    }
  }

  async decodeResponse(
    ciphertext: string,
    context: Nip46EncryptionContext,
  ): Promise<Nip46AnyResponse> {
    let plaintext: string;
    try {
      plaintext = await this.decrypt(ciphertext, context);
    } catch (error) {
      throw new Nip46CodecError("NIP46_DECODE_ERROR", "Failed to decrypt NIP-46 response", error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (error) {
      throw new Nip46CodecError(
        "NIP46_DECODE_ERROR",
        "Failed to parse NIP-46 response JSON",
        error,
      );
    }

    if (!assertResponse(parsed)) {
      throw new Nip46CodecError(
        "NIP46_UNEXPECTED_PAYLOAD",
        "Decrypted payload is not a valid NIP-46 response",
      );
    }
    return parsed;
  }
}

export const noopCodecConfig: Nip46CodecConfig = {
  encrypt: async plaintext => plaintext,
  decrypt: async ciphertext => ciphertext,
};

export const createNip46Codec = (config: Nip46CodecConfig, generateId?: () => string) =>
  new Nip46Codec({ config, generateId });
