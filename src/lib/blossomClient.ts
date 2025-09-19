import type { AxiosProgressEvent } from "axios";
import { createMultipartStream } from "./multipartStream";

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
  file: UploadSource,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  onProgress?: (event: AxiosProgressEvent) => void,
  options?: UploadOptions
): Promise<BlossomBlob> {
  const url = new URL(`/upload`, serverUrl).toString();
  const normalizedServer = serverUrl.replace(/\/$/, "");

  const attempt = async (skipSizeTag: boolean): Promise<BlossomBlob> => {
    const source = await resolveUploadSource(file);
    const headers: Record<string, string> = { Accept: "application/json" };

    let authEvent: SignedEvent | undefined;
    if (requiresAuth) {
      if (!signTemplate) throw new Error("Server requires auth. Connect your signer first.");
      authEvent = await createAuthEvent(signTemplate, "upload", {
        file: source.originalFile,
        fileName: source.fileName,
        fileType: source.contentType,
        fileSize: source.size,
        serverUrl,
        urlPath: "/upload",
        sizeOverride: options?.sizeOverride,
        skipSizeTag,
      });
      headers.Authorization = encodeAuthHeader(authEvent);
    }

    const { boundary, stream, contentLength } = createMultipartStream({
      file: {
        field: "file",
        fileName: source.fileName,
        contentType: source.contentType,
        size: source.size,
        stream: source.stream,
      },
      fields: authEvent ? [{ name: "event", value: JSON.stringify(authEvent) }] : undefined,
      onProgress: (loaded, total) => {
        if (onProgress) {
          const totalHint = total ?? source.size ?? options?.sizeOverride;
          onProgress({ loaded, total: typeof totalHint === "number" ? totalHint : undefined } as AxiosProgressEvent);
        }
      },
    });

    const requestHeaders: Record<string, string> = {
      ...headers,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };
    if (typeof contentLength === "number") {
      requestHeaders["Content-Length"] = String(contentLength);
    }

    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: requestHeaders,
        body: stream,
      });

      if (!response.ok) {
        let serverMessage: string | undefined;
        try {
          const data = await response.json();
          serverMessage = typeof data === "string" ? data : data?.error || data?.message;
        } catch (error) {
          serverMessage = undefined;
        }
        const normalizedMessage = serverMessage || `Upload failed with status ${response.status}`;
        const uploadError = new Error(normalizedMessage) as Error & { status?: number };
        uploadError.status = response.status;
        throw uploadError;
      }

      const data = await response.json();
      const rawSize = (data as any)?.size;
      const size = rawSize === undefined || rawSize === null ? undefined : Number(rawSize);
      return {
        ...data,
        size: Number.isFinite(size) ? size : undefined,
        url: data.url || `${normalizedServer}/${data.sha256}`,
        serverUrl: normalizedServer,
        requiresAuth: Boolean(requiresAuth),
        serverType: "blossom",
      } as BlossomBlob;
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message || "Upload failed";
        if (requiresAuth && !skipSizeTag && message.toLowerCase().includes("size tag")) {
          return attempt(true);
        }
        const status = (error as any)?.status;
        if (status === 413) {
          throw new Error(
            "Upload rejected: the server responded with 413 (payload too large). Reduce the file size or ask the server admin to raise the limit."
          );
        }
        throw error;
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
