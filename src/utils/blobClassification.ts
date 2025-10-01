import type { BlossomBlob } from "../lib/blossomClient";

const MUSIC_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|oga|flac|aac|m4a|weba|webm|alac|aiff|aif|wma|mid|midi|amr|opus)(?:\?|#|$)/i;

const ADDITIONAL_AUDIO_MIME_TYPES = new Set([
  "application/ogg",
  "application/x-ogg",
  "application/flac",
  "application/x-flac",
]);

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)(?:\?|#|$)/i;
const VIDEO_EXTENSION_REGEX = /\.(mp4|mov|webm|mkv|avi|hevc|m4v|mpg|mpeg)(?:\?|#|$)/i;
const PDF_EXTENSION_REGEX = /\.pdf(?:\?|#|$)/i;
const ADDITIONAL_VIDEO_MIME_TYPES = new Set([
  "application/x-matroska",
  "video/x-matroska",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
]);

const DOCUMENT_MIME_PREFIXES = ["text/"];

const DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.apple.pages",
  "application/vnd.apple.numbers",
  "application/vnd.apple.keynote",
  "text/markdown",
  "application/javascript",
  "text/javascript",
  "application/typescript",
  "text/x-typescript",
  "application/x-yaml",
  "text/yaml",
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "application/sql",
]);

const DOCUMENT_EXTENSION_REGEX =
  /\.(txt|text|md|markdown|rst|adoc|log|json|yaml|yml|toml|ini|cfg|conf|csv|tsv|xml|html?|xhtml|js|mjs|cjs|ts|tsx|jsx|css|scss|less|rtf|docx?|odt|pages|pptx?|ppsx?|odp|key|xls|xlsx|xlsm|ods|numbers|tex|sql)(?:\?|#|$)/i;

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

export const isDocumentBlob = (blob: BlossomBlob) => {
  if (isMusicBlob(blob) || isImageBlob(blob) || isVideoBlob(blob) || isPdfBlob(blob)) {
    return false;
  }

  const rawType = normalizeMime(blob.type);
  if (rawType) {
    if (DOCUMENT_MIME_PREFIXES.some(prefix => rawType.startsWith(prefix))) return true;
    if (DOCUMENT_MIME_TYPES.has(rawType)) return true;
  }

  if (matchesExtension(blob.name, DOCUMENT_EXTENSION_REGEX)) return true;
  if (matchesExtension(blob.url, DOCUMENT_EXTENSION_REGEX)) return true;

  return false;
};
