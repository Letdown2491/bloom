import axios, { AxiosProgressEvent } from "axios";

export type BlossomBlob = {
  sha256: string;
  size?: number;
  type?: string;
  uploaded?: number;
  url?: string;
  name?: string;
  serverUrl?: string;
  requiresAuth?: boolean;
  serverType?: "blossom" | "nip96";
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
  hash?: string;
  sourceUrl?: string;
  serverUrl?: string;
  urlPath?: string;
  expiresInSeconds?: number;
  sizeOverride?: number;
  skipSizeTag?: boolean;
};

async function createAuthEvent(signTemplate: SignTemplate, kind: AuthKind, data?: AuthData) {
  const expiration = Math.floor(Date.now() / 1000) + (data?.expiresInSeconds ?? 300);
  const tags: string[][] = [["t", kind], ["expiration", String(expiration)]];
  if (data?.serverUrl) {
    const normalized = data.serverUrl.replace(/\/$/, "");
    tags.push(["server", normalized]);
  }
  if (data?.urlPath) {
    tags.push(["url", data.urlPath]);
  }
  if (kind === "upload" && data?.file) {
    tags.push(["name", data.file.name]);
    if (data.skipSizeTag !== true) {
      const rawSize = typeof data.sizeOverride === "number" ? data.sizeOverride : data.file.size;
      const normalizedSize = Number.isFinite(rawSize) ? Math.max(0, Math.round(rawSize)) : undefined;
      if (typeof normalizedSize === "number") {
        tags.push(["size", String(normalizedSize)]);
      }
    }
    if (data.file.type) tags.push(["type", data.file.type]);
  }
  if ((kind === "delete" || kind === "get") && data?.hash) {
    tags.push(["x", data.hash]);
  }
  if (kind === "mirror" && data?.sourceUrl) {
    tags.push(["source", data.sourceUrl]);
    tags.push(["url", data.sourceUrl]);
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

export async function buildAuthorizationHeader(signTemplate: SignTemplate, kind: AuthKind, data?: AuthData) {
  const event = await createAuthEvent(signTemplate, kind, data);
  return encodeAuthHeader(event);
}

export async function listUserBlobs(
  serverUrl: string,
  pubkey: string,
  options?: { requiresAuth?: boolean; signTemplate?: SignTemplate }
): Promise<BlossomBlob[]> {
  const url = new URL(`/list/${pubkey}`, serverUrl).toString();
  const headers: Record<string, string> = {};
  if (options?.requiresAuth) {
    if (!options.signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    const auth = await createAuthEvent(options.signTemplate, "list", {
      serverUrl,
      urlPath: `/list/${pubkey}`,
    });
    headers.Authorization = encodeAuthHeader(auth);
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`List failed with status ${res.status}`);
  const data = await res.json();
  const items: BlossomBlob[] = Array.isArray(data) ? data : data.items ?? [];
  const now = Math.floor(Date.now() / 1000);
  const normalizedServer = serverUrl.replace(/\/$/, "");
  return items.map(item => {
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
    };
  });
}

type UploadOptions = {
  skipSizeTag?: boolean;
  sizeOverride?: number;
};

export async function uploadBlobToServer(
  serverUrl: string,
  file: File,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  onProgress?: (event: AxiosProgressEvent) => void,
  options?: UploadOptions
): Promise<BlossomBlob> {
  const url = new URL(`/upload`, serverUrl).toString();
  const normalizedServer = serverUrl.replace(/\/$/, "");

  const attempt = async (skipSizeTag: boolean): Promise<BlossomBlob> => {
    const form = new FormData();
    form.append("file", file);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (requiresAuth) {
      if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
      const authEvent = await createAuthEvent(signTemplate, "upload", {
        file,
        serverUrl,
        urlPath: "/upload",
        sizeOverride: options?.sizeOverride,
        skipSizeTag,
      });
      form.append("event", JSON.stringify(authEvent));
      headers.Authorization = encodeAuthHeader(authEvent);
    }
    try {
      const response = await axios.put<BlossomBlob>(url, form, {
        headers,
        onUploadProgress: onProgress,
      });
      const rawSize = (response.data as any)?.size;
      const size = rawSize === undefined || rawSize === null ? undefined : Number(rawSize);
      return {
        ...response.data,
        size: Number.isFinite(size) ? size : undefined,
        url: response.data.url || `${normalizedServer}/${response.data.sha256}`,
        serverUrl: normalizedServer,
        requiresAuth: Boolean(requiresAuth),
        serverType: "blossom",
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (!error.response) {
          if (error.request) {
            throw new Error("Upload failed before the server responded. This often happens when CORS is misconfigured or the server blocks large uploads.");
          }
          throw error;
        }
        const status = error.response.status;
        if (status === 413) {
          throw new Error("Upload rejected: the server responded with 413 (payload too large). Reduce the file size or ask the server admin to raise the limit.");
        }
        const data = error.response.data;
        const serverMessage = typeof data === "string" ? data : (data && typeof data === "object" ? (data.error || data.message) : undefined);
        const normalizedMessage = serverMessage || `Upload failed with status ${status}`;
        if (requiresAuth && !skipSizeTag && normalizedMessage.toLowerCase().includes("size tag")) {
          return attempt(true);
        }
        throw new Error(normalizedMessage);
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
  const res = await fetch(url, {
    method: "DELETE",
    headers,
    body,
    mode: "cors",
  });
  if (!res.ok) throw new Error(`Delete failed with status ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => undefined);
  }
  return undefined;
}

export async function mirrorBlobToServer(
  serverUrl: string,
  sourceUrl: string,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean
): Promise<BlossomBlob> {
  const url = new URL(`/mirror`, serverUrl).toString();
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: any = JSON.stringify({ url: sourceUrl });
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
    const authEvent = await createAuthEvent(signTemplate, "mirror", {
      sourceUrl,
      serverUrl,
      urlPath: "/mirror",
    });
    headers.Authorization = encodeAuthHeader(authEvent);
    body = JSON.stringify({ url: sourceUrl, event: authEvent });
  }
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body,
  });
  if (!res.ok) throw new Error(`Mirror failed with status ${res.status}`);
  const data = await res.json();
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
