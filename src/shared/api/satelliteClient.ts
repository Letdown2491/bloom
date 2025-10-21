import axios, { type AxiosProgressEvent } from "axios";
import {
  resolveUploadSource,
  type BlossomBlob,
  type SignTemplate,
  type UploadSource,
  type SignedEvent,
  type EventTemplate,
} from "./blossomClient";
import { canonicalizeSatelliteApiBase } from "../domain/satelliteUtils";

export type SatelliteAccountFile = {
  sha256: string;
  url?: string;
  name?: string;
  type?: string;
  size?: number | string;
  created?: number | string;
  uploaded?: number | string;
  label?: string;
  infohash?: string;
  magnet?: string;
  nip94?: string[][];
};

export type SatelliteAccount = {
  storageTotal?: number;
  creditTotal?: number;
  usageTotal?: number;
  paidThrough?: number;
  timeRemaining?: number;
  rateFiat?: Record<string, number>;
  exchangeFiat?: Record<string, number>;
  files?: SatelliteAccountFile[];
};

export type SatelliteCreditOffer = {
  callback: string;
  amount: number;
  rateFiat?: Record<string, number>;
  offer?: Record<string, unknown>;
  payment?: Record<string, unknown>;
};

type SatelliteAuthPurpose = "account" | "credit" | "upload" | "delete";

type SatelliteUploadOptions = {
  label?: string;
};

type SatelliteAuthData = {
  fileName?: string;
  fileSize?: number;
  label?: string;
  gbMonths?: number;
  hash?: string;
};

const SATELLITE_AUTH_KIND = 22242;

const sanitizeFileName = (value: string | undefined) => {
  if (!value) return undefined;
  return value.replace(/[\\/]/g, "_");
};

const normalizeBase = (url: string) => canonicalizeSatelliteApiBase(url);

const ensureTrailingSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

const buildEndpointUrl = (baseUrl: string, path: string) =>
  new URL(path, ensureTrailingSlash(baseUrl)).toString();

const generateNonce = () => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buffer = new Uint32Array(2);
    crypto.getRandomValues(buffer);
    return Array.from(buffer)
      .map(value => value.toString(16).padStart(8, "0"))
      .join("");
  }
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
};

async function createSatelliteAuthEvent(
  signTemplate: SignTemplate,
  purpose: SatelliteAuthPurpose,
  data: SatelliteAuthData = {},
): Promise<SignedEvent> {
  const createdAt = Math.floor(Date.now() / 1000);
  const tags: string[][] = [["nonce", generateNonce()]];
  let content: string;

  switch (purpose) {
    case "upload": {
      content = "Authorize Upload";
      const name = sanitizeFileName(data.fileName);
      if (name) tags.push(["name", name]);
      if (typeof data.fileSize === "number" && Number.isFinite(data.fileSize)) {
        tags.push(["size", String(Math.max(0, Math.round(data.fileSize)))]);
      }
      if (data.label) tags.push(["label", data.label]);
      break;
    }
    case "delete": {
      content = "Delete Item";
      if (data.hash) tags.push(["sha256", data.hash]);
      break;
    }
    case "credit": {
      content = "Request Storage";
      if (
        typeof data.gbMonths === "number" &&
        Number.isInteger(data.gbMonths) &&
        data.gbMonths > 0
      ) {
        tags.push(["gb_months", String(data.gbMonths)]);
      }
      break;
    }
    case "account":
    default: {
      content = "Authenticate User";
      break;
    }
  }

  const template: EventTemplate = {
    kind: SATELLITE_AUTH_KIND,
    created_at: createdAt,
    content,
    tags,
  };

  return signTemplate(template);
}

const encodeAuthParam = (event: SignedEvent) => encodeURIComponent(JSON.stringify(event));

const coerceNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const satelliteFileToBlob = (file: SatelliteAccountFile, serverUrl: string): BlossomBlob => {
  const size = coerceNumber(file.size);
  const uploaded = coerceNumber(file.created ?? file.uploaded);
  return {
    sha256: file.sha256,
    url: file.url,
    name: file.name,
    type: file.type,
    size,
    uploaded,
    serverUrl: normalizeBase(serverUrl),
    requiresAuth: true,
    serverType: "satellite",
    label: file.label,
    infohash: file.infohash,
    magnet: file.magnet,
    nip94: Array.isArray(file.nip94) ? file.nip94 : undefined,
  };
};

async function ensureUploadFile(
  source: Awaited<ReturnType<typeof resolveUploadSource>>,
): Promise<File> {
  // If the source already exposes a File, reuse it to avoid buffering.
  if ((source as { originalFile?: unknown }).originalFile instanceof File) {
    return (source as { originalFile: File }).originalFile;
  }
  const blob = await new Response((source as { stream: ReadableStream<Uint8Array> }).stream).blob();
  return new File([blob], (source as { fileName: string }).fileName, {
    type: (source as { contentType: string }).contentType,
  });
}

export async function getSatelliteAccount(
  serverUrl: string,
  signTemplate: SignTemplate,
): Promise<SatelliteAccount> {
  const base = normalizeBase(serverUrl);
  const authEvent = await createSatelliteAuthEvent(signTemplate, "account");
  const url = buildEndpointUrl(base, "account");
  const requestUrl = `${url}?auth=${encodeAuthParam(authEvent)}`;
  const res = await fetch(requestUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Account fetch failed with status ${res.status}`);
  }
  const data = (await res.json().catch(() => undefined)) as SatelliteAccount | undefined;
  if (!data || typeof data !== "object") {
    throw new Error("Satellite account response malformed");
  }
  return data;
}

export async function listSatelliteFiles(
  serverUrl: string,
  options: { signTemplate?: SignTemplate },
): Promise<BlossomBlob[]> {
  if (!options.signTemplate) {
    throw new Error("Satellite servers require a connected signer.");
  }
  const account = await getSatelliteAccount(serverUrl, options.signTemplate);
  const files = Array.isArray(account.files) ? account.files : [];
  return files
    .filter((item): item is SatelliteAccountFile => Boolean(item?.sha256))
    .map(file => satelliteFileToBlob(file, serverUrl));
}

export async function uploadBlobToSatellite(
  serverUrl: string,
  file: UploadSource,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
  onProgress?: (event: AxiosProgressEvent) => void,
  options: SatelliteUploadOptions = {},
): Promise<BlossomBlob> {
  const base = normalizeBase(serverUrl);
  const endpoint = buildEndpointUrl(base, "item");
  const source = await resolveUploadSource(file);
  const uploadFile = await ensureUploadFile(source);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type":
      uploadFile.type ||
      (source as { contentType?: string }).contentType ||
      "application/octet-stream",
  };

  let requestUrl = endpoint;
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Satellite upload requires a connected signer.");
    const authEvent = await createSatelliteAuthEvent(signTemplate, "upload", {
      fileName: (source as { fileName?: string }).fileName,
      fileSize: uploadFile.size,
      label: options.label,
    });
    requestUrl = `${endpoint}?auth=${encodeAuthParam(authEvent)}`;
  }

  try {
    const response = await axios.put(requestUrl, uploadFile, {
      headers,
      onUploadProgress: progressEvent => {
        if (onProgress) onProgress(progressEvent as AxiosProgressEvent);
      },
    });
    const payload = response.data as SatelliteAccountFile & { message?: string };
    if (!payload || !payload.sha256) {
      const message = payload?.message || "Satellite upload failed";
      throw new Error(message);
    }
    const blob = satelliteFileToBlob(payload, base);
    if (!blob.name) blob.name = (source as { fileName?: string }).fileName;
    if (!blob.type) blob.type = uploadFile.type || (source as { contentType?: string }).contentType;
    return blob;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const serverMessage =
        (error.response?.data as { message?: string } | undefined)?.message || error.message;
      const uploadError = new Error(
        serverMessage || `Satellite upload failed with status ${status ?? "unknown"}`,
      ) as Error & {
        status?: number;
      };
      uploadError.status = status;
      throw uploadError;
    }
    throw error;
  }
}

export async function deleteSatelliteFile(
  serverUrl: string,
  hash: string,
  signTemplate: SignTemplate | undefined,
  requiresAuth: boolean,
): Promise<void> {
  const base = normalizeBase(serverUrl);
  const endpoint = buildEndpointUrl(base, "item");
  let requestUrl = `${endpoint}?sha256=${encodeURIComponent(hash)}`;
  if (requiresAuth) {
    if (!signTemplate) throw new Error("Satellite delete requires a connected signer.");
    const authEvent = await createSatelliteAuthEvent(signTemplate, "delete", { hash });
    const authParam = encodeAuthParam(authEvent);
    requestUrl = `${endpoint}?sha256=${encodeURIComponent(hash)}&auth=${authParam}`;
  }
  const res = await fetch(requestUrl, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    mode: "cors",
  });
  if (!res.ok) {
    let message: string | null = null;
    try {
      const data = await res.json();
      message = typeof data?.message === "string" ? data.message : null;
    } catch {
      try {
        const text = await res.text();
        message = text || null;
      } catch {
        message = null;
      }
    }
    throw new Error(
      message
        ? `Delete failed with status ${res.status}: ${message}`
        : `Delete failed with status ${res.status}`,
    );
  }
}

export async function requestSatelliteCreditOffer(
  serverUrl: string,
  gbMonths: number,
  signTemplate: SignTemplate | undefined,
): Promise<SatelliteCreditOffer> {
  if (!signTemplate) throw new Error("Satellite credit purchase requires a connected signer.");
  const base = normalizeBase(serverUrl);
  const endpoint = buildEndpointUrl(base, "account/credit");
  const authEvent = await createSatelliteAuthEvent(signTemplate, "credit", { gbMonths });
  const requestUrl = `${endpoint}?auth=${encodeAuthParam(authEvent)}`;
  const res = await fetch(requestUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Credit offer failed with status ${res.status}`);
  }
  const data = (await res.json().catch(() => undefined)) as SatelliteCreditOffer | undefined;
  if (!data || typeof data !== "object") {
    throw new Error("Satellite credit offer response malformed");
  }
  return data;
}
