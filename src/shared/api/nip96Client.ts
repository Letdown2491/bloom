import axios, { type AxiosProgressEvent } from "axios";
import { BloomHttpError, fromAxiosError, httpRequest, requestJson } from "./httpService";
import { buildNip98AuthHeader } from "./nip98";
import {
  resolveUploadSource,
  type BlossomBlob,
  type SignTemplate,
  type UploadSource,
  type BlobListResult,
} from "./blossomClient";

export type Nip96ResolvedConfig = {
  apiUrl: string;
  downloadUrl: string;
  raw: Record<string, unknown>;
};

type Nip96ListItem =
  | Nip94Event
  | {
      nip94_event?: Nip94Event;
      event?: Nip94Event;
      tags?: string[][];
      [key: string]: unknown;
    };

export type Nip96ListResponse = {
  count?: number;
  total?: number;
  page?: number;
  files?: Nip96ListItem[];
};

type Nip94Event = {
  tags: string[][];
  content?: string;
  created_at?: number;
};

type Nip96UploadResponse = {
  status?: "success" | "error";
  message?: string;
  nip94_event?: Nip94Event & { id?: string; pubkey?: string; sig?: string };
  processing_url?: string;
};

type Nip96DeleteResponse = {
  status?: string;
  message?: string;
};

const configCache = new Map<string, Promise<Nip96ResolvedConfig>>();

function normalizeBase(url: string) {
  return url.replace(/\/$/, "");
}

function ensureTrailingSlash(url: string) {
  return url.endsWith("/") ? url : `${url}/`;
}

function resolveAbsolute(base: string, value?: string) {
  if (!value) return base;
  try {
    return new URL(value, ensureTrailingSlash(base)).toString().replace(/\/$/, "");
  } catch (error) {
    return value;
  }
}

async function fetchConfig(baseUrl: string, depth = 0): Promise<Nip96ResolvedConfig> {
  if (depth > 4) throw new Error("Too many NIP-96 delegation redirects");
  const normalizedBase = normalizeBase(baseUrl);
  const wellKnownUrl = new URL(
    "/.well-known/nostr/nip96.json",
    ensureTrailingSlash(normalizedBase),
  ).toString();
  const data = await requestJson<Record<string, unknown>>({
    url: wellKnownUrl,
    method: "GET",
    headers: { Accept: "application/json" },
    retries: depth === 0 ? 2 : 1,
    retryDelayMs: 500,
    retryJitterRatio: 0.3,
    source: "nip96",
  });
  if (data && typeof data === "object") {
    const delegated = typeof data.delegated_to_url === "string" ? data.delegated_to_url.trim() : "";
    const apiUrlRaw = typeof data.api_url === "string" ? data.api_url.trim() : "";
    if (!apiUrlRaw && delegated) {
      return fetchConfig(delegated, depth + 1);
    }
    if (!apiUrlRaw) {
      throw new BloomHttpError(`Invalid NIP-96 config from ${wellKnownUrl} (missing api_url)`, {
        request: { url: wellKnownUrl, method: "GET" },
        source: "nip96",
        data,
      });
    }
    const apiUrl = resolveAbsolute(normalizedBase, apiUrlRaw);
    const downloadUrl = resolveAbsolute(
      apiUrl,
      typeof data.download_url === "string" ? data.download_url.trim() : "",
    );
    return { apiUrl, downloadUrl, raw: data };
  }
  throw new BloomHttpError(`Invalid response from ${wellKnownUrl}`, {
    request: { url: wellKnownUrl, method: "GET" },
    source: "nip96",
    data,
  });
}

export async function getNip96Config(serverUrl: string): Promise<Nip96ResolvedConfig> {
  const key = normalizeBase(serverUrl);
  const cached = configCache.get(key);
  if (cached) return cached;
  const promise = fetchConfig(serverUrl).then(config => {
    configCache.set(key, Promise.resolve(config));
    return config;
  });
  configCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    configCache.delete(key);
    throw error;
  }
}

function tagsToMap(tags: string[][] = []) {
  const map = new Map<string, string>();
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    const [key, value] = tag;
    if (typeof key === "string" && typeof value === "string" && !map.has(key)) {
      map.set(key, value);
    }
  }
  return map;
}

async function ensureUploadFile(
  source: Awaited<ReturnType<typeof resolveUploadSource>>,
): Promise<File> {
  if (source.originalFile instanceof File) {
    return source.originalFile;
  }
  const blob = await new Response(source.stream).blob();
  return new File([blob], source.fileName, { type: source.contentType });
}

function buildDefaultUrl(config: Nip96ResolvedConfig, sha256: string, extension?: string) {
  const base = config.downloadUrl || config.apiUrl;
  const normalized = ensureTrailingSlash(base);
  const suffix = extension ? `${sha256}.${extension.replace(/^\./, "")}` : sha256;
  return `${normalized}${suffix}`;
}

function extractNip94Event(entry: Nip96ListItem | undefined): Nip94Event | null {
  if (!entry || typeof entry !== "object") return null;
  if (Array.isArray((entry as Nip94Event).tags)) {
    return entry as Nip94Event;
  }
  const candidate =
    (entry as { nip94_event?: Nip94Event; event?: Nip94Event; nip94?: Nip94Event }).nip94_event ??
    (entry as { event?: Nip94Event }).event ??
    (entry as { nip94?: Nip94Event }).nip94;
  if (candidate && Array.isArray(candidate.tags)) {
    return candidate;
  }
  return null;
}

function nip94ToBlob(
  config: Nip96ResolvedConfig,
  serverUrl: string,
  event: Nip94Event,
  requiresAuth: boolean,
): BlossomBlob | null {
  const tags = tagsToMap(event.tags);
  const ox = tags.get("ox") || tags.get("x");
  if (!ox) return null;
  const urlTag = tags.get("url");
  const mime = tags.get("m");
  const sizeRaw = tags.get("size");
  const extension = (() => {
    const url = urlTag || "";
    const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    if (match) return match[1];
    if (mime) {
      const [, subtype] = mime.split("/");
      if (subtype) return subtype;
    }
    return undefined;
  })();
  const url = urlTag || buildDefaultUrl(config, ox, extension);
  const blob: BlossomBlob = {
    sha256: ox,
    url,
    type: mime,
    size: sizeRaw ? Number(sizeRaw) || undefined : undefined,
    name: tags.get("name") || event.content || undefined,
    uploaded: event.created_at,
    serverUrl: normalizeBase(serverUrl),
    requiresAuth,
    serverType: "nip96",
  };
  return blob;
}

export async function listNip96Files(
  serverUrl: string,
  options: { requiresAuth: boolean; signTemplate?: SignTemplate; page?: number; count?: number } = {
    requiresAuth: true,
  },
): Promise<BlobListResult> {
  const config = await getNip96Config(serverUrl);
  const page = options.page ?? 0;
  const count = options.count ?? 100;
  const listUrl = new URL(config.apiUrl);
  listUrl.searchParams.set("page", String(page));
  listUrl.searchParams.set("count", String(count));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.requiresAuth) {
    if (!options.signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    headers.Authorization = await buildNip98AuthHeader(options.signTemplate, {
      url: listUrl.toString(),
      method: "GET",
    });
  }
  const data = await requestJson<Nip96ListResponse | undefined>({
    url: listUrl.toString(),
    method: "GET",
    headers,
    source: "nip96",
    retries: 2,
    retryDelayMs: 700,
    retryJitterRatio: 0.35,
    retryOn: err => {
      const status = err.status ?? 0;
      return status === 0 || status >= 500 || status === 429;
    },
  }).catch(error => {
    if (error instanceof BloomHttpError) throw error;
    throw new BloomHttpError("Failed to list NIP-96 files", {
      request: { url: listUrl.toString(), method: "GET" },
      source: "nip96",
      cause: error instanceof Error ? error : undefined,
    });
  });
  const files = Array.isArray(data?.files) ? data.files : [];
  const blobs: BlossomBlob[] = [];
  for (const file of files) {
    const event = extractNip94Event(file);
    if (!event) continue;
    const blob = nip94ToBlob(config, serverUrl, event, options.requiresAuth);
    if (blob) blobs.push(blob);
  }
  return {
    items: blobs,
    reset: (options.page ?? 0) === 0,
    updatedAt: Date.now(),
  };
}

export async function uploadBlobToNip96(
  serverUrl: string,
  file: UploadSource,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  onProgress?: (event: AxiosProgressEvent) => void,
): Promise<BlossomBlob> {
  const config = await getNip96Config(serverUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  const url = config.apiUrl;
  if (requiresAuth) {
    if (!signTemplate) {
      throw new BloomHttpError("Server requires auth. Connect your signer first.", {
        request: { url, method: "POST" },
        source: "nip96",
      });
    }
    headers.Authorization = await buildNip98AuthHeader(signTemplate, {
      url,
      method: "POST",
    });
  }
  const source = await resolveUploadSource(file);
  const uploadFile = await ensureUploadFile(source);

  const formData = new FormData();
  formData.append("file", uploadFile, source.fileName);
  formData.append("caption", source.fileName);
  formData.append("alt", source.fileName);
  if (uploadFile.size) {
    formData.append("size", String(uploadFile.size));
  }
  if (uploadFile.type) {
    formData.append("content_type", uploadFile.type);
  }
  formData.append("no_transform", "true");

  try {
    const response = await axios.post(url, formData, {
      headers,
      onUploadProgress: progressEvent => {
        if (onProgress) onProgress(progressEvent as AxiosProgressEvent);
      },
    });

    const payload = response.data as Nip96UploadResponse | undefined;

    if (!payload || payload.status !== "success" || !payload.nip94_event) {
      const message = payload?.message || payload?.status || "Upload failed";
      throw new BloomHttpError(message, {
        request: { url, method: "POST" },
        source: "nip96",
        data: payload,
      });
    }

    const blob = nip94ToBlob(config, serverUrl, payload.nip94_event, requiresAuth);
    if (!blob) {
      throw new BloomHttpError("Upload succeeded but response missing file metadata", {
        request: { url, method: "POST" },
        source: "nip96",
        data: payload,
      });
    }
    if (!blob.name) blob.name = source.fileName;
    if (!blob.type) blob.type = uploadFile.type || source.contentType;
    return blob;
  } catch (error) {
    throw fromAxiosError(error, { url, method: "POST", source: "nip96" });
  }
}

export async function deleteNip96File(
  serverUrl: string,
  hash: string,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
): Promise<Nip96DeleteResponse | undefined> {
  const config = await getNip96Config(serverUrl);
  const targetUrl = `${ensureTrailingSlash(config.apiUrl)}${hash}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (requiresAuth) {
    if (!signTemplate) {
      throw new BloomHttpError("Server requires auth. Connect your signer first.", {
        request: { url: targetUrl, method: "DELETE" },
        source: "nip96",
      });
    }
    headers.Authorization = await buildNip98AuthHeader(signTemplate, {
      url: targetUrl,
      method: "DELETE",
    });
  }
  const response = await httpRequest({
    url: targetUrl,
    method: "DELETE",
    headers,
    source: "nip96",
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
