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
      const requiresAuth = serverType === "satellite" ? false : context.requiresAuth;
      const signTemplate = requiresAuth ? defaultSignTemplate : undefined;
      const disablePreview = context.disablePreview ?? shouldDisablePreview(blob, context.detectedKind);
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

function shouldDisablePreview(blob: BlossomBlob, detectedKind?: "image" | "video") {
  const mime = blob.type?.split(";")[0]?.toLowerCase() ?? "";
  if (detectedKind === "image" || mime.startsWith("image/")) return false;
  if (detectedKind === "video" || mime.startsWith("video/")) return false;
  return true;
}
