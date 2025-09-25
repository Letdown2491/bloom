import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

export const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) ?? []);

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

export interface Nip46Keypair {
  privateKey: Uint8Array;
  publicKey: string;
}

export const generateKeypair = (): Nip46Keypair => {
  const privateKey = generateSecretKey();
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
  };
};

export const importPrivateKey = (hex: string): Nip46Keypair => {
  const normalized = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Private key must be 64 hex characters");
  }
  const privateKey = hexToBytes(normalized);
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
  };
};

export const exportPrivateKey = (keypair: Nip46Keypair): string => bytesToHex(keypair.privateKey);
