import type { BlossomBlob, EventTemplate } from "./blossomClient";

export type BlurhashMetadata = {
  hash: string;
  width: number;
  height: number;
};

export type Nip94EventOptions = {
  blob: BlossomBlob;
  alias?: string | null;
  blurhash?: BlurhashMetadata;
  extraTags?: string[][];
};

export type Nip94ParsedEvent = {
  sha256: string;
  name: string | null;
  mimeType?: string;
  size?: number;
  url?: string;
  createdAt?: number;
};

const formatDimensions = (blurhash?: BlurhashMetadata) => {
  if (!blurhash) return null;
  const width = Number.isFinite(blurhash.width) ? Math.max(0, Math.round(blurhash.width)) : null;
  const height = Number.isFinite(blurhash.height) ? Math.max(0, Math.round(blurhash.height)) : null;
  if (!width || !height) return null;
  return `${width}x${height}`;
};

const normalizeAlias = (alias?: string | null) => {
  if (typeof alias !== "string") return undefined;
  const trimmed = alias.trim();
  return trimmed.length > 0 ? trimmed : "";
};

export const buildNip94EventTemplate = ({
  blob,
  alias,
  blurhash,
  extraTags,
}: Nip94EventOptions): EventTemplate => {
  const resolvedName = normalizeAlias(alias);
  const fallbackName = typeof alias === "undefined" ? blob.name?.trim() || undefined : undefined;
  const content = resolvedName !== undefined ? resolvedName : fallbackName;
  const tags: string[][] = [];

  tags.push(["url", blob.url || ""]);
  tags.push(["m", blob.type || ""]);
  if (blob.sha256) {
    tags.push(["x", blob.sha256]);
  }
  if (blob.size !== undefined) {
    const size = Number(blob.size);
    if (Number.isFinite(size) && size >= 0) {
      tags.push(["size", String(Math.round(size))]);
    }
  }
  const nameTag = resolvedName ?? fallbackName;
  if (typeof nameTag === "string") {
    tags.push(["name", nameTag]);
  }
  if (blurhash) {
    tags.push(["blurhash", blurhash.hash]);
    const dim = formatDimensions(blurhash);
    if (dim) {
      tags.push(["dim", dim]);
    }
  }

  if (Array.isArray(extraTags)) {
    extraTags.forEach(tag => {
      if (
        Array.isArray(tag) &&
        tag.length >= 2 &&
        typeof tag[0] === "string" &&
        typeof tag[1] === "string"
      ) {
        tags.push(tag);
      }
    });
  }

  return {
    kind: 1063,
    content: content || "",
    created_at: Math.floor(Date.now() / 1000),
    tags,
  };
};

const getTagValue = (tags: string[][], key: string) => {
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    if (tag[0] === key) {
      return typeof tag[1] === "string" ? tag[1] : undefined;
    }
  }
  return undefined;
};

export const parseNip94Event = (
  event: { tags?: string[][]; content?: string; created_at?: number } | null | undefined,
): Nip94ParsedEvent | null => {
  if (!event?.tags) return null;
  const { tags } = event;
  const hash = getTagValue(tags, "x") || getTagValue(tags, "ox");
  if (!hash) return null;
  const rawName = getTagValue(tags, "name");
  const contentName = typeof event.content === "string" ? event.content.trim() : "";
  const name = rawName !== undefined ? rawName : contentName ? contentName : null;
  const mimeType = getTagValue(tags, "m");
  const url = getTagValue(tags, "url");
  const sizeRaw = getTagValue(tags, "size");
  const size = sizeRaw ? Number(sizeRaw) : undefined;
  return {
    sha256: hash,
    name,
    mimeType: mimeType || undefined,
    size: Number.isFinite(size) ? Number(size) : undefined,
    url: url || undefined,
    createdAt: event.created_at,
  };
};
