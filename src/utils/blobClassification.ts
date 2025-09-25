import type { BlossomBlob } from "../lib/blossomClient";

const MUSIC_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|oga|flac|aac|m4a|weba|webm|alac|aiff|aif|wma|mid|midi|amr|opus)(?:\?|#|$)/;

const ADDITIONAL_AUDIO_MIME_TYPES = new Set([
  "application/ogg",
  "application/x-ogg",
  "application/flac",
  "application/x-flac",
]);

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)(?:\?|#|$)/;
const VIDEO_EXTENSION_REGEX = /\.(mp4|mov|webm|mkv|avi|hevc|m4v|mpg|mpeg)(?:\?|#|$)/;
const PDF_EXTENSION_REGEX = /\.pdf(?:\?|#|$)/;
const ADDITIONAL_VIDEO_MIME_TYPES = new Set([
  "application/x-matroska",
  "video/x-matroska",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
]);

const normalizeMime = (value?: string) => value?.split(";")[0]?.trim().toLowerCase() ?? "";

const matchesExtension = (value: string | undefined, regex: RegExp) => {
  if (!value) return false;
  return regex.test(value.toLowerCase());
};

export const isImageBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType.startsWith("image/")) return true;
  if (matchesExtension(blob.name, IMAGE_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, IMAGE_EXTENSION_REGEX)) return true;
  return false;
};

export const isVideoBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType.startsWith("video/")) return true;
  if (ADDITIONAL_VIDEO_MIME_TYPES.has(rawType)) return true;
  if (matchesExtension(blob.name, VIDEO_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, VIDEO_EXTENSION_REGEX)) return true;
  return false;
};

export const isPdfBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType === "application/pdf") return true;
  if (matchesExtension(blob.name, PDF_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, PDF_EXTENSION_REGEX)) return true;
  return false;
};

export const isMusicBlob = (blob: BlossomBlob) => {
  const rawType = normalizeMime(blob.type);
  if (rawType) {
    if (rawType.startsWith("audio/")) return true;
    if (ADDITIONAL_AUDIO_MIME_TYPES.has(rawType)) return true;
  }

  if (matchesExtension(blob.name, MUSIC_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, MUSIC_EXTENSION_REGEX)) return true;

  return false;
};

export const isDocumentBlob = (blob: BlossomBlob) =>
  !isMusicBlob(blob) && !isImageBlob(blob) && !isVideoBlob(blob) && !isPdfBlob(blob);
