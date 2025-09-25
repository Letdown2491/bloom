import { v2 as nip44v2 } from "nostr-tools/nip44";
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from "nostr-tools/nip04";
import {
  Nip46CodecConfig,
  Nip46CodecError,
  Nip46EncryptionAlgorithm,
  Nip46EncryptionContext,
  Nip46EncryptFn,
  Nip46DecryptFn,
} from "./types";

const HEX_REGEX = /^[0-9a-f]+$/i;

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

const normalizeHexKey = (hex: string, label: string): string => {
  const trimmed = hex.trim().toLowerCase().replace(/^0x/, "");
  if (trimmed.startsWith("npub")) {
    throw new Nip46CodecError("NIP46_ENCODE_ERROR", `${label} must be in hex format, received npub`);
  }
  if (!HEX_REGEX.test(trimmed)) {
    throw new Nip46CodecError("NIP46_ENCODE_ERROR", `${label} must be hex-encoded`);
  }
  if (trimmed.length === 66 && (trimmed.startsWith("02") || trimmed.startsWith("03"))) {
    return trimmed.slice(2);
  }
  if (trimmed.length !== 64) {
    throw new Nip46CodecError(
      "NIP46_ENCODE_ERROR",
      `${label} must be 32-byte hex (64 chars), received length ${trimmed.length}`
    );
  }
  return trimmed;
};

const deriveConversationKey = (context: Nip46EncryptionContext): Uint8Array => {
  const remote = normalizeHexKey(context.remotePublicKey, "remote public key");
  try {
    return nip44v2.utils.getConversationKey(context.localPrivateKey, remote);
  } catch (error) {
    throw new Nip46CodecError("NIP46_ENCODE_ERROR", "Failed to derive NIP-44 conversation key", error);
  }
};

const createNip44Encrypt: Nip46EncryptFn = async (plaintext, context) => {
  const conversationKey = deriveConversationKey(context);
  try {
    return nip44v2.encrypt(plaintext, conversationKey);
  } catch (error) {
    throw new Nip46CodecError("NIP46_ENCODE_ERROR", "Failed to encrypt payload with NIP-44", error);
  }
};

const createNip44Decrypt: Nip46DecryptFn = async (ciphertext, context) => {
  const conversationKey = deriveConversationKey(context);
  try {
    return nip44v2.decrypt(ciphertext, conversationKey);
  } catch (error) {
    throw new Nip46CodecError("NIP46_DECODE_ERROR", "Failed to decrypt payload with NIP-44", error);
  }
};

const createNip04Encrypt: Nip46EncryptFn = async (plaintext, context) => {
  const remote = normalizeHexKey(context.remotePublicKey, "remote public key");
  const privkeyHex = bytesToHex(context.localPrivateKey);
  try {
    return nip04Encrypt(privkeyHex, remote, plaintext);
  } catch (error) {
    throw new Nip46CodecError("NIP46_ENCODE_ERROR", "Failed to encrypt payload with NIP-04", error);
  }
};

const createNip04Decrypt: Nip46DecryptFn = async (ciphertext, context) => {
  const remote = normalizeHexKey(context.remotePublicKey, "remote public key");
  const privkeyHex = bytesToHex(context.localPrivateKey);
  try {
    return nip04Decrypt(privkeyHex, remote, ciphertext);
  } catch (error) {
    throw new Nip46CodecError("NIP46_DECODE_ERROR", "Failed to decrypt payload with NIP-04", error);
  }
};

export const getCodecConfigForAlgorithm = (algorithm: Nip46EncryptionAlgorithm): Nip46CodecConfig => {
  if (algorithm === "nip44") {
    return {
      encrypt: createNip44Encrypt,
      decrypt: createNip44Decrypt,
    };
  }
  return {
    encrypt: createNip04Encrypt,
    decrypt: createNip04Decrypt,
  };
};

export const combineCodecConfigs = (
  primary: Nip46CodecConfig,
  fallback: Nip46CodecConfig
): Nip46CodecConfig => ({
  encrypt: async (plaintext, context) => {
    try {
      return await primary.encrypt(plaintext, context);
    } catch (error) {
      if (error instanceof Nip46CodecError) throw error;
      return fallback.encrypt(plaintext, context);
    }
  },
  decrypt: async (ciphertext, context) => {
    try {
      return await primary.decrypt(ciphertext, context);
    } catch (error) {
      if (error instanceof Nip46CodecError) throw error;
      return fallback.decrypt(ciphertext, context);
    }
  },
});

export const createDefaultCodecConfig = (): Nip46CodecConfig => getCodecConfigForAlgorithm("nip44");
