const AES_ALGORITHM = "AES-GCM";
const DEFAULT_IV_LENGTH = 12;

const sanitizeFileName = (value: string): string => {
  return value.replace(/[\\/]/g, "_");
};

export type PrivateEncryptionMetadata = {
  algorithm: typeof AES_ALGORITHM;
  key: string;
  iv: string;
  originalName?: string;
  originalType?: string;
  originalSize?: number;
};

export type PrivateEncryptionResult = {
  file: File;
  buffer: ArrayBuffer;
  metadata: PrivateEncryptionMetadata;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const importKey = async (rawKey: Uint8Array) => {
  const view =
    rawKey.byteOffset === 0 && rawKey.byteLength === rawKey.buffer.byteLength
      ? rawKey
      : rawKey.slice();
  const keyBuffer = view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.importKey("raw", keyBuffer, { name: AES_ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const deriveEncryptedFileName = (originalName: string) => {
  const sanitized = sanitizeFileName(originalName) || "blob";
  const extIndex = sanitized.lastIndexOf(".");
  const base = extIndex >= 0 ? sanitized.slice(0, extIndex) : sanitized;
  return `${base || "file"}.bloom`;
};

export const encryptFileForPrivateUpload = async (file: File): Promise<PrivateEncryptionResult> => {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const iv = new Uint8Array(DEFAULT_IV_LENGTH);
  crypto.getRandomValues(iv);

  const cryptoKey = await importKey(keyBytes);
  const data = await file.arrayBuffer();
  const encryptedBuffer = await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, cryptoKey, data);

  const encryptedFile = new File([encryptedBuffer], deriveEncryptedFileName(file.name), {
    type: "application/octet-stream",
    lastModified: Date.now(),
  });

  return {
    file: encryptedFile,
    buffer: encryptedBuffer,
    metadata: {
      algorithm: AES_ALGORITHM,
      key: toBase64(keyBytes),
      iv: toBase64(iv),
      originalName: file.name,
      originalType: file.type,
      originalSize: file.size,
    },
  };
};

export const decryptPrivateBlob = async (
  data: ArrayBuffer,
  metadata: PrivateEncryptionMetadata,
) => {
  const keyBytes = fromBase64(metadata.key);
  const ivBytes = fromBase64(metadata.iv);
  const cryptoKey = await importKey(keyBytes);
  const ivBuffer = ivBytes.slice().buffer as ArrayBuffer;
  return crypto.subtle.decrypt({ name: AES_ALGORITHM, iv: ivBuffer }, cryptoKey, data);
};
