import axios, { type AxiosProgressEvent } from "axios";
import { BloomHttpError, fromAxiosError, httpRequest, requestJson } from "./httpService";

export type PrivateBlobEncryption = {
  algorithm: string;
  key: string;
  iv: string;
};

export type PrivateBlobAudioMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  durationSeconds?: number;
  genre?: string;
  year?: number;
  coverUrl?: string;
};

export type PrivateBlobMetadata = {
  name?: string;
  type?: string;
  size?: number;
  folderPath?: string | null;
  audio?: PrivateBlobAudioMetadata | null;
};

export type BlossomBlob = {
  sha256: string;
  size?: number;
  type?: string;
  uploaded?: number;
  url?: string;
  name?: string;
  serverUrl?: string;
  requiresAuth?: boolean;
  serverType?: "blossom" | "nip96" | "satellite";
  label?: string;
  infohash?: string;
  magnet?: string;
  nip94?: string[][];
  privateData?: {
    encryption: PrivateBlobEncryption;
    metadata?: PrivateBlobMetadata;
    servers?: string[];
  };
  folderPath?: string | null;
  __bloomMetadataName?: string | null;
  __bloomFolderPlaceholder?: boolean;
  __bloomFolderTargetPath?: string | null;
  __bloomFolderScope?: "aggregated" | "server" | "private";
  __bloomFolderIsParentLink?: boolean;
  __bloomPrivateLinkUrl?: string | null;
  __bloomPrivateLinkAlias?: string | null;
};

export type EventTemplate = {
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
};

export type SignedEvent = EventTemplate & {
  id: string;
  sig: string;
  pubkey: string;
};

export type SignTemplate = (template: EventTemplate) => Promise<SignedEvent>;

const BLOSSOM_KIND_AUTH = 24242;

type AuthKind = "list" | "upload" | "delete" | "mirror" | "get";

type AuthData = {
  file?: File;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  hash?: string;
  sourceUrl?: string;
  serverUrl?: string;
  urlPath?: string;
  expiresInSeconds?: number;
  sizeOverride?: number;
  skipSizeTag?: boolean;
};

export type UploadStreamSource = {
  kind: "stream";
  fileName: string;
  contentType?: string;
  size?: number;
  createStream: () => Promise<ReadableStream<Uint8Array>>;
};

export type UploadSource = File | UploadStreamSource;

const isStreamSource = (value: UploadSource): value is UploadStreamSource =>
  typeof value === "object" && value !== null && (value as UploadStreamSource).kind === "stream";

const sanitizeFileName = (value: string | undefined) => {
  if (!value) return undefined;
  return value.replace(/[\\/]/g, "_");
};

const toHex = (bytes: ArrayLike<number>) =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

const HEX_256_REGEX = /^[0-9a-fA-F]{64}$/;

export const extractSha256FromUrl = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.pop();
    if (!last) return undefined;
    const candidate = last.split(".")[0];
    if (candidate && HEX_256_REGEX.test(candidate)) {
      return candidate.toLowerCase();
    }
  } catch (error) {
    // Ignore URL parse errors; caller will handle missing hash.
  }
  return undefined;
};

const readBlobArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  try {
    return await blob.arrayBuffer();
  } catch (error) {
    if (error instanceof DOMException) {
      const clone = blob.slice(0, blob.size, blob.type);
      return clone.arrayBuffer();
    }
    throw error;
  }
};

async function computeBlobSha256Hex(blob: Blob): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("SHA-256 hashing unavailable in this environment");
  }

  const buffer = await readBlobArrayBuffer(blob);
  const data = new Uint8Array(buffer);

  let hashBuffer: ArrayBuffer;
  try {
    hashBuffer = await crypto.subtle.digest("SHA-256", data);
  } catch (error) {
    if (error instanceof DOMException) {
      throw new Error("Unable to compute SHA-256 hash for the selected file.");
    }
    throw error;
  }

  return toHex(new Uint8Array(hashBuffer));
}

async function createAuthEvent(signTemplate: SignTemplate, kind: AuthKind, data?: AuthData) {
  const expiration = Math.floor(Date.now() / 1000) + (data?.expiresInSeconds ?? 300);
  const authAction = kind === "mirror" ? "upload" : kind;
  const tags: string[][] = [["t", authAction], ["expiration", String(expiration)]];
  if (data?.serverUrl) {
    const normalized = data.serverUrl.replace(/\/$/, "");
    tags.push(["server", normalized]);
  }
  if (data?.urlPath) {
    tags.push(["url", data.urlPath]);
  }
  if (kind === "upload") {
    const fileName = sanitizeFileName(data?.file?.name ?? data?.fileName);
    if (fileName) {
      tags.push(["name", fileName]);
    }
    if (data?.skipSizeTag !== true) {
      const rawSize =
        typeof data?.sizeOverride === "number"
          ? data.sizeOverride
          : typeof data?.fileSize === "number"
          ? data.fileSize
          : data?.file?.size;
      const normalizedSize =
        typeof rawSize === "number" && Number.isFinite(rawSize) ? Math.max(0, Math.round(rawSize)) : undefined;
      if (typeof normalizedSize === "number") {
        tags.push(["size", String(normalizedSize)]);
      }
    }
    const fileType = data?.file?.type ?? data?.fileType;
    if (fileType) {
      tags.push(["type", fileType]);
    }
  }
  if (kind === "mirror" && data?.sourceUrl) {
    tags.push(["source", data.sourceUrl]);
    tags.push(["url", data.sourceUrl]);
  }
  const shouldIncludeHash = Boolean(data?.hash) && (kind === "delete" || kind === "get" || kind === "upload" || kind === "mirror");
  if (shouldIncludeHash && data?.hash) {
    tags.push(["x", data.hash]);
  }
  const template: EventTemplate = {
    kind: BLOSSOM_KIND_AUTH,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags,
  };
  return signTemplate(template);
}

function encodeAuthHeader(event: SignedEvent) {
  const payload = JSON.stringify(event);
  const base64 = btoa(unescape(encodeURIComponent(payload)));
  return `Nostr ${base64}`;
}

const CACHEABLE_AUTH_KINDS = new Set<AuthKind>(["get", "list"]);
const AUTH_CACHE_MAX_TTL_MS = 15_000;
const AUTH_CACHE_MIN_TTL_MS = 1_000;

type AuthCacheRecord = {
  header?: string;
  expiresAt?: number;
  promise?: Promise<string>;
};

const authHeaderCache = new WeakMap<SignTemplate, Map<string, AuthCacheRecord>>();

const normalizeServerUrl = (url: string | undefined) => {
  if (!url) return "";
  return url.replace(/\/$/, "");
};

const buildAuthCacheKey = (kind: AuthKind, data?: AuthData): string | null => {
  if (!CACHEABLE_AUTH_KINDS.has(kind)) return null;
  if (data?.file) return null;
  const parts: string[] = [`kind:${kind}`];
  if (data?.serverUrl) parts.push(`server:${normalizeServerUrl(data.serverUrl)}`);
  if (data?.urlPath) parts.push(`path:${data.urlPath}`);
  if (data?.hash) parts.push(`hash:${data.hash}`);
  if (data?.sourceUrl) parts.push(`source:${data.sourceUrl}`);
  if (typeof data?.expiresInSeconds === "number") parts.push(`expires:${data.expiresInSeconds}`);
  if (typeof data?.sizeOverride === "number") parts.push(`sizeOverride:${data.sizeOverride}`);
  if (typeof data?.skipSizeTag === "boolean") parts.push(`skipSize:${data.skipSizeTag ? 1 : 0}`);
  return parts.join("|");
};

const resolveCacheTtl = (data?: AuthData) => {
  const seconds = typeof data?.expiresInSeconds === "number" ? data.expiresInSeconds : 300;
  const ttlMs = seconds * 1000;
  return Math.max(AUTH_CACHE_MIN_TTL_MS, Math.min(ttlMs, AUTH_CACHE_MAX_TTL_MS));
};

export async function buildAuthorizationHeader(signTemplate: SignTemplate, kind: AuthKind, data?: AuthData) {
  const cacheKey = buildAuthCacheKey(kind, data);
  const ttlMs = cacheKey ? resolveCacheTtl(data) : null;

  if (cacheKey && ttlMs && ttlMs > 0) {
    let cache = authHeaderCache.get(signTemplate);
    if (!cache) {
      cache = new Map();
      authHeaderCache.set(signTemplate, cache);
    }

    const now = Date.now();
    const existing = cache.get(cacheKey);
    if (existing) {
      if (existing.header && existing.expiresAt && existing.expiresAt > now) {
        return existing.header;
      }
      if (existing.promise) {
        return existing.promise;
      }
    }

    const buildPromise = async () => {
      const event = await createAuthEvent(signTemplate, kind, data);
      const header = encodeAuthHeader(event);
      cache!.set(cacheKey, {
        header,
        expiresAt: Date.now() + ttlMs,
      });
      return header;
    };

    const pendingPromise = buildPromise().catch(error => {
      const current = cache!.get(cacheKey);
      if (current?.promise === pendingPromise) {
        cache!.delete(cacheKey);
      }
      throw error;
    });

    cache.set(cacheKey, { promise: pendingPromise });
    return pendingPromise;
  }

  const event = await createAuthEvent(signTemplate, kind, data);
  return encodeAuthHeader(event);
}

type ResolvedUploadSource = {
  fileName: string;
  contentType: string;
  size?: number;
  stream: ReadableStream<Uint8Array>;
  originalFile?: File;
};

export async function resolveUploadSource(file: UploadSource): Promise<ResolvedUploadSource> {
  if (isStreamSource(file)) {
    const stream = await file.createStream();
    if (!stream) {
      throw new Error("Source stream unavailable");
    }
    return {
      fileName: sanitizeFileName(file.fileName) || "upload.bin",
      contentType: file.contentType || "application/octet-stream",
      size: typeof file.size === "number" ? file.size : undefined,
      stream,
    };
  }
  const stream = file.stream();
  return {
    fileName: sanitizeFileName(file.name) || "upload.bin",
    contentType: file.type || "application/octet-stream",
    size: file.size,
    stream,
    originalFile: file,
  };
}

export async function listUserBlobs(
  serverUrl: string,
  pubkey: string,
  options?: { requiresAuth?: boolean; signTemplate?: SignTemplate }
): Promise<BlossomBlob[]> {
  const path = `/list/${pubkey}`;
  const url = new URL(path, serverUrl).toString();
  const headers: Record<string, string> = {};
  if (options?.requiresAuth) {
    if (!options.signTemplate) throw new BloomHttpError("Server requires auth. Connect your signer first.", {
      request: { url, method: "GET" },
      source: "blossom",
    });
    headers.Authorization = await buildAuthorizationHeader(options.signTemplate, "list", {
      serverUrl,
      urlPath: path,
    });
  }

  const normalizedServer = serverUrl.replace(/\/$/, "");
  const now = Math.floor(Date.now() / 1000);

  const data = await requestJson<unknown>({
    url,
    method: "GET",
    headers,
    source: "blossom",
    retries: 2,
    retryDelayMs: 600,
    retryJitterRatio: 0.4,
    retryOn: error => {
      const status = error.status ?? 0;
      return status === 0 || status >= 500 || status === 429;
    },
  });

  const rawItems: BlossomBlob[] = (() => {
    if (Array.isArray(data)) {
      return data as BlossomBlob[];
    }
    if (data && typeof data === "object" && Array.isArray((data as { items?: unknown[] }).items)) {
      return ((data as { items?: unknown[] }).items ?? []) as BlossomBlob[];
    }
    return [];
  })();

  return rawItems.map(item => {
    const rawSize = (item as any)?.size;
    const size = rawSize === undefined || rawSize === null ? undefined : Number(rawSize);
    return {
      ...item,
      size: Number.isFinite(size) ? size : undefined,
      uploaded: item.uploaded ?? now,
      url: item.url || `${normalizedServer}/${item.sha256}`,
      serverUrl: normalizedServer,
      requiresAuth: Boolean(options?.requiresAuth),
      serverType: "blossom",
    } as BlossomBlob;
  });
}

type UploadOptions = {
  skipSizeTag?: boolean;
  sizeOverride?: number;
};

async function ensureUploadFile(source: ResolvedUploadSource): Promise<File> {
  if (source.originalFile instanceof File) {
    return source.originalFile;
  }
  const blob = await new Response(source.stream).blob();
  return new File([blob], source.fileName, { type: source.contentType });
}

export async function uploadBlobToServer(
  serverUrl: string,
  file: UploadSource,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  onProgress?: (event: AxiosProgressEvent) => void,
  options?: UploadOptions
): Promise<BlossomBlob> {
  const url = new URL(`/upload`, serverUrl).toString();
  const normalizedServer = serverUrl.replace(/\/$/, "");

  const source = await resolveUploadSource(file);
  const uploadFile = await ensureUploadFile(source);
  const fileSha256Hex = await computeBlobSha256Hex(uploadFile);

  const attempt = async (skipSizeTag: boolean): Promise<BlossomBlob> => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": uploadFile.type || source.contentType || "application/octet-stream",
    };

    if (fileSha256Hex) {
      headers["X-SHA-256"] = fileSha256Hex;
    }

    if (requiresAuth) {
      if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
      const authEvent = await createAuthEvent(signTemplate, "upload", {
        file: uploadFile,
        fileName: uploadFile.name,
        fileType: uploadFile.type,
        fileSize: uploadFile.size,
        serverUrl,
        urlPath: "/upload",
        sizeOverride: options?.sizeOverride,
        skipSizeTag,
        hash: fileSha256Hex,
      });
      headers.Authorization = encodeAuthHeader(authEvent);
    }

    try {
      const response = await axios.put(url, uploadFile, {
        headers,
        onUploadProgress: progressEvent => {
          if (onProgress) onProgress(progressEvent as AxiosProgressEvent);
        },
      });

      const data = response.data || {};
      const rawSize = (data as any)?.size;
      const size = rawSize === undefined || rawSize === null ? undefined : Number(rawSize);
      return {
        ...data,
        size: Number.isFinite(size) ? size : uploadFile.size,
        url: data.url || `${normalizedServer}/${data.sha256}`,
        serverUrl: normalizedServer,
        requiresAuth: Boolean(requiresAuth),
        serverType: "blossom",
      } as BlossomBlob;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const serverMessage = (error.response?.data as { message?: string } | undefined)?.message || error.message;
        if (requiresAuth && !skipSizeTag && (serverMessage || "").toLowerCase().includes("size tag")) {
          return attempt(true);
        }
        if (error.response?.status === 413) {
          throw new BloomHttpError(
            "Upload rejected: the server responded with 413 (payload too large). Reduce the file size or ask the server admin to raise the limit.",
            {
              status: 413,
              request: { url, method: "PUT" },
              source: "blossom",
            }
          );
        }
        throw fromAxiosError(error, { url, method: "PUT", source: "blossom" });
      }
      throw error;
    }
  };

  const initialSkip = options?.skipSizeTag === true;
  return attempt(initialSkip);
}

export async function deleteUserBlob(
  serverUrl: string,
  hash: string,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean
) {
  const url = new URL(`/${hash}`, serverUrl).toString();
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    const authEvent = await createAuthEvent(signTemplate, "delete", {
      hash,
      serverUrl,
      urlPath: `/${hash}`,
    });
    headers.Authorization = encodeAuthHeader(authEvent);
    headers["content-type"] = "application/json";
    body = JSON.stringify({ event: authEvent });
  }
  const response = await httpRequest({
    url,
    method: "DELETE",
    headers,
    body,
    mode: "cors",
    source: "blossom",
  });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch (error) {
      return undefined;
    }
  }
  return undefined;
}

export async function mirrorBlobToServer(
  serverUrl: string,
  sourceUrl: string,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  sourceSha256?: string
): Promise<BlossomBlob> {
  const url = new URL(`/mirror`, serverUrl).toString();
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: any = JSON.stringify({ url: sourceUrl });
  const resolvedSha256 = sourceSha256?.toLowerCase() ?? extractSha256FromUrl(sourceUrl);
  if (resolvedSha256) {
    headers["X-SHA-256"] = resolvedSha256;
  }
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    if (!resolvedSha256) {
      throw new Error("Unable to determine blob hash for mirror authorization.");
    }
    const authEvent = await createAuthEvent(signTemplate, "mirror", {
      sourceUrl,
      serverUrl,
      urlPath: "/mirror",
      hash: resolvedSha256,
    });
    headers.Authorization = encodeAuthHeader(authEvent);
    body = JSON.stringify({ url: sourceUrl, event: authEvent });
  }
  const data = await requestJson<any>({
    url,
    method: "PUT",
    headers,
    body,
    source: "blossom",
  });
  const normalizedServer = serverUrl.replace(/\/$/, "");
  const rawSize = (data as any)?.size;
  const size = rawSize === undefined || rawSize === null ? undefined : Number(rawSize);
  return {
    ...data,
    size: Number.isFinite(size) ? size : undefined,
    url: data.url || `${normalizedServer}/${data.sha256}`,
    serverUrl: normalizedServer,
    requiresAuth: Boolean(requiresAuth),
    serverType: "blossom",
  };
}
