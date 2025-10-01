import { useCallback, useMemo, useState } from "react";
import type { BlossomBlob, SignTemplate } from "../../lib/blossomClient";

type ServerType = "blossom" | "nip96" | "satellite";

export type PreviewTarget = {
  blob: BlossomBlob;
  displayName: string;
  previewUrl: string | null;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType: ServerType;
  disablePreview: boolean;
  baseUrl?: string;
  kind?: string;
};

export type OpenPreviewContext = {
  displayName: string;
  requiresAuth: boolean;
  detectedKind?: "image" | "video";
  baseUrl?: string;
  previewUrl?: string | null;
  disablePreview?: boolean;
  kind?: string;
};

type PreviewOptions = {
  defaultServerType?: ServerType;
  defaultSignTemplate?: SignTemplate;
};

export const useBlobPreview = (options?: PreviewOptions) => {
  const { defaultServerType = "blossom", defaultSignTemplate } = options ?? {};
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const openPreview = useCallback(
    (blob: BlossomBlob, context: OpenPreviewContext) => {
      const serverType = blob.serverType ?? defaultServerType;
      const baseUrl = context.baseUrl ?? blob.serverUrl;
      const requiresAuth = context.requiresAuth;
      const signTemplate = requiresAuth ? defaultSignTemplate : undefined;
      const disablePreview =
        context.disablePreview ?? shouldDisableBlobPreview(blob, context.detectedKind, context.kind);
      const rawUrl = context.previewUrl ?? blob.url ?? (baseUrl ? `${baseUrl.replace(/\/$/, "")}/${blob.sha256}` : null);
      const previewUrl = disablePreview ? null : rawUrl;

      setPreviewTarget({
        blob,
        displayName: context.displayName,
        previewUrl,
        requiresAuth,
        signTemplate,
        serverType,
        disablePreview: disablePreview || !previewUrl,
        baseUrl,
        kind: context.kind ?? context.detectedKind,
      });
    },
    [defaultServerType, defaultSignTemplate]
  );

  const closePreview = useCallback(() => {
    setPreviewTarget(null);
  }, []);

  return useMemo(
    () => ({
      previewTarget,
      openPreview,
      closePreview,
    }),
    [closePreview, openPreview, previewTarget]
  );
};

export const canBlobPreview = (
  blob: BlossomBlob,
  detectedKind?: "image" | "video",
  declaredKind?: string
) => !shouldDisableBlobPreview(blob, detectedKind, declaredKind);

function shouldDisableBlobPreview(
  blob: BlossomBlob,
  detectedKind?: "image" | "video",
  declaredKind?: string
) {
  if (declaredKind && declaredKind.toLowerCase() === "pdf") {
    return false;
  }
  const normalizedKind = normalizeKind(declaredKind);
  const effectiveKind = detectedKind ?? normalizedKind;
  if (effectiveKind === "image" || effectiveKind === "video") {
    return false;
  }

  const privateMime = blob.privateData?.metadata?.type;
  const mime = (privateMime ?? blob.type ?? "").split(";")[0]?.toLowerCase() ?? "";
  if (mime === "application/pdf") {
    return false;
  }
  if (mime.startsWith("image/") || mime.startsWith("video/")) {
    return false;
  }

  const nipMime = readNip94Value(blob, "m")?.toLowerCase() ?? "";
  if (nipMime === "application/pdf") {
    return false;
  }
  if (nipMime.startsWith("image/") || nipMime.startsWith("video/")) {
    return false;
  }

  const candidates = collectFilenameCandidates(blob);
  if (candidates.some(value => PDF_EXTENSION_REGEX.test(value))) {
    return false;
  }
  if (candidates.some(value => IMAGE_EXTENSION_REGEX.test(value))) {
    return false;
  }
  if (candidates.some(value => VIDEO_EXTENSION_REGEX.test(value))) {
    return false;
  }

  return true;
}

function normalizeKind(kind?: string): "image" | "video" | undefined {
  if (!kind) return undefined;
  const lower = kind.toLowerCase();
  if (lower === "image" || lower === "video") {
    return lower;
  }
  return undefined;
}

function collectFilenameCandidates(blob: BlossomBlob) {
  const candidates: string[] = [];
  const primaryRefs = [
    blob.name,
    blob.url,
    blob.privateData?.metadata?.name,
    readNip94Value(blob, "name"),
    readNip94Value(blob, "url"),
  ];
  for (const value of primaryRefs) {
    if (typeof value === "string" && value) {
      candidates.push(value.toLowerCase());
    }
  }
  return candidates;
}

function readNip94Value(blob: BlossomBlob, key: string) {
  const tags = Array.isArray(blob.nip94) ? blob.nip94 : null;
  if (!tags) return undefined;
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    if (tag[0] === key && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return undefined;
}

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i;
const VIDEO_EXTENSION_REGEX = /\.(mp4|m4v|mov|webm|mkv|avi|hevc|mpe?g|mpg|ogv|3gp|3g2|ts|m2ts)$/i;
const PDF_EXTENSION_REGEX = /\.pdf(?:\?|#|$)/i;
