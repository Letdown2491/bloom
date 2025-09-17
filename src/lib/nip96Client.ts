import axios, { AxiosProgressEvent } from "axios";
import type { BlossomBlob, SignTemplate } from "./blossomClient";
import { buildNip98AuthHeader } from "./nip98";

export type Nip96ResolvedConfig = {
  apiUrl: string;
  downloadUrl: string;
  raw: Record<string, any>;
};

export type Nip96ListResponse = {
  count?: number;
  total?: number;
  page?: number;
  files?: Nip94Event[];
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
  const wellKnownUrl = new URL("/.well-known/nostr/nip96.json", ensureTrailingSlash(normalizedBase)).toString();
  const res = await fetch(wellKnownUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Failed to load NIP-96 config from ${wellKnownUrl} (${res.status})`);
  }
  const data = await res.json();
  if (data && typeof data === "object") {
    const delegated = typeof data.delegated_to_url === "string" ? data.delegated_to_url.trim() : "";
    const apiUrlRaw = typeof data.api_url === "string" ? data.api_url.trim() : "";
    if (!apiUrlRaw && delegated) {
      return fetchConfig(delegated, depth + 1);
    }
    if (!apiUrlRaw) throw new Error(`Invalid NIP-96 config from ${wellKnownUrl} (missing api_url)`);
    const apiUrl = resolveAbsolute(normalizedBase, apiUrlRaw);
    const downloadUrl = resolveAbsolute(apiUrl, typeof data.download_url === "string" ? data.download_url.trim() : "");
    return { apiUrl, downloadUrl, raw: data as Record<string, any> };
  }
  throw new Error(`Invalid response from ${wellKnownUrl}`);
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

function buildDefaultUrl(config: Nip96ResolvedConfig, sha256: string, extension?: string) {
  const base = config.downloadUrl || config.apiUrl;
  const normalized = ensureTrailingSlash(base);
  const suffix = extension ? `${sha256}.${extension.replace(/^\./, "")}` : sha256;
  return `${normalized}${suffix}`;
}

function nip94ToBlob(config: Nip96ResolvedConfig, serverUrl: string, event: Nip94Event, requiresAuth: boolean): BlossomBlob | null {
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
  options: { requiresAuth: boolean; signTemplate?: SignTemplate; page?: number; count?: number } = { requiresAuth: true }
): Promise<BlossomBlob[]> {
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
  const res = await fetch(listUrl.toString(), {
    method: "GET",
    headers,
  });
  if (!res.ok) throw new Error(`List failed with status ${res.status}`);
  const data = (await res.json().catch(() => undefined)) as Nip96ListResponse | undefined;
  const files = Array.isArray(data?.files) ? data!.files! : [];
  const blobs: BlossomBlob[] = [];
  for (const file of files) {
    const blob = nip94ToBlob(config, serverUrl, file, options.requiresAuth);
    if (blob) blobs.push(blob);
  }
  return blobs;
}

export async function uploadBlobToNip96(
  serverUrl: string,
  file: File,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  onProgress?: (event: AxiosProgressEvent) => void
): Promise<BlossomBlob> {
  const config = await getNip96Config(serverUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  const url = config.apiUrl;
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    headers.Authorization = await buildNip98AuthHeader(signTemplate, {
      url,
      method: "POST",
    });
  }
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("size", String(file.size));
  if (file.type) form.append("content_type", file.type);
  form.append("caption", file.name);
  const response = await axios.post<Nip96UploadResponse>(url, form, {
    headers,
    onUploadProgress: onProgress,
  });
  const payload = response.data;
  if (payload.status !== "success" || !payload.nip94_event) {
    throw new Error(payload.message || "Upload failed");
  }
  const blob = nip94ToBlob(config, serverUrl, payload.nip94_event, requiresAuth);
  if (!blob) throw new Error("Upload succeeded but response missing file metadata");
  if (!blob.name) blob.name = file.name;
  if (!blob.type) blob.type = file.type;
  return blob;
}

export async function deleteNip96File(
  serverUrl: string,
  hash: string,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean
): Promise<Nip96DeleteResponse | undefined> {
  const config = await getNip96Config(serverUrl);
  const targetUrl = `${ensureTrailingSlash(config.apiUrl)}${hash}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    headers.Authorization = await buildNip98AuthHeader(signTemplate, {
      url: targetUrl,
      method: "DELETE",
    });
  }
  const res = await fetch(targetUrl, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(`Delete failed with status ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => undefined);
  }
  return undefined;
}
