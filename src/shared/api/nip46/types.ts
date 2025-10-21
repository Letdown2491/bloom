export type Nip46Method =
  | "connect"
  | "sign_event"
  | "ping"
  | "get_public_key"
  | "nip04_encrypt"
  | "nip04_decrypt"
  | "nip44_encrypt"
  | "nip44_decrypt";

export interface Nip46RequestPayload {
  id: string;
  method: Nip46Method;
  params: string[];
}

export interface Nip46ResponsePayload {
  id: string;
  result?: string;
  error?: string;
}

export interface Nip46AuthChallengePayload extends Nip46ResponsePayload {
  result: "auth_url";
  error: string;
}

export type Nip46AnyResponse = Nip46ResponsePayload | Nip46AuthChallengePayload;

export type Nip46EncryptionAlgorithm = "nip44" | "nip04";

export interface Nip46EncryptionContext {
  /** Local private key (32-byte scalar) used for ECDH */
  localPrivateKey: Uint8Array;
  /** Remote party hex public key (66-char compressed) */
  remotePublicKey: string;
  /** Which algorithm to use when encrypting/decrypting */
  algorithm: Nip46EncryptionAlgorithm;
}

export type Nip46EncryptFn = (
  plaintext: string,
  context: Nip46EncryptionContext,
) => Promise<string>;

export type Nip46DecryptFn = (
  ciphertext: string,
  context: Nip46EncryptionContext,
) => Promise<string>;

export interface Nip46CodecConfig {
  encrypt: Nip46EncryptFn;
  decrypt: Nip46DecryptFn;
}

export type Nip46CodecErrorCode =
  | "NIP46_DECODE_ERROR"
  | "NIP46_ENCODE_ERROR"
  | "NIP46_UNEXPECTED_PAYLOAD";

export class Nip46CodecError extends Error {
  readonly code: Nip46CodecErrorCode;

  constructor(code: Nip46CodecErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.name = "Nip46CodecError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, enumerable: false, configurable: true });
    }
  }
}
