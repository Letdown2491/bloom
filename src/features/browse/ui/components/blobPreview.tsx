import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decode } from "blurhash";
import { prettyBytes, prettyDate } from "../../../../shared/utils/format";
import { buildAuthorizationHeader, type BlossomBlob, type SignTemplate } from "../../../../shared/api/blossomClient";
import { buildNip98AuthHeader } from "../../../../shared/api/nip98";
import { decryptPrivateBlob } from "../../../../shared/domain/privateEncryption";
import { cachePreviewBlob, getCachedPreviewBlob } from "../../../../shared/utils/blobPreviewCache";
import { useInViewport } from "../../../../shared/hooks/useInViewport";
import { useUserPreferences } from "../../../../app/context/UserPreferencesContext";
import { getBlobMetadataName } from "../../../../shared/utils/blobMetadataStore";
import {
  CancelIcon,
  CopyIcon,
  DocumentIcon,
  FileTypeIcon,
  MusicIcon,
  VideoIcon,
} from "../../../../shared/ui/icons";
import type { FileKind } from "../../../../shared/ui/icons";
import type { PreviewTarget } from "../../useBlobPreview";
import type { PrivateListEntry } from "../../../../shared/domain/privateList";

export type BlurhashInfo = {
  hash: string;
  width?: number;
  height?: number;
};

const MUSIC_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|oga|flac|aac|m4a|weba|webm|alac|aiff|aif|wma|mid|midi|amr|opus)(?:\?|#|$)/i;

const ADDITIONAL_AUDIO_MIME_TYPES = new Set(
  ["application/ogg", "application/x-ogg", "application/flac", "application/x-flac"].map(value =>
    value.toLowerCase()
  )
);

const LIST_WORD_REGEX = /(?:^|[+./-])list(?:$|[+./-])/;

const isDirectoryLikeMime = (value?: string | null) => {
  const normalized = normalizeMime(value);
  const raw = value?.toLowerCase() ?? "";
  if (!normalized) return false;
  if (normalized === "application/x-directory" || normalized === "inode/directory") return true;
  if (normalized.startsWith("application/")) {
    if (normalized.includes("directory") || normalized.includes("folder")) return true;
    if (LIST_WORD_REGEX.test(normalized) && (normalized.includes("nostr") || normalized.includes("bloom"))) {
      return true;
    }
  }
  if (raw.includes("type=list") || raw.includes("category=list")) return true;
  return false;
};

export const isListLikeBlob = (blob: BlossomBlob) => {
  if (isDirectoryLikeMime(blob.type)) return true;
  const metadataType = blob.privateData?.metadata?.type;
  if (isDirectoryLikeMime(metadataType)) return true;
  return false;
};


export const PreviewDialog: React.FC<{
  target: PreviewTarget;
  onClose: () => void;
  onDetect: (sha: string, kind: "image" | "video") => void;
  onCopy: (blob: BlossomBlob) => void;
  onBlobVisible: (sha: string) => void;
}> = ({ target, onClose, onDetect, onCopy, onBlobVisible }) => {
  const { blob, displayName, previewUrl, requiresAuth, signTemplate, serverType, disablePreview } = target;
  const derivedKind: FileKind = (target.kind as FileKind | undefined) ?? decideFileKind(blob, undefined);
  const blurhash = extractBlurhash(blob);
  const sizeLabel = typeof blob.size === "number" ? prettyBytes(blob.size) : null;
  const updatedLabel = typeof blob.uploaded === "number" ? prettyDate(blob.uploaded) : null;
  const typeLabel = blob.type || "Unknown";
  const originLabel = target.baseUrl ?? blob.serverUrl ?? null;
  const previewUnavailable = disablePreview || !previewUrl;

  const handleDirectUrlCopy = useCallback(() => {
    if (!blob.url) return;
    onCopy(blob);
  }, [blob, onCopy]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";
  const containerBaseClass = "relative flex h-full w-full flex-1 flex-col";
  const containerClass = isLightTheme
    ? `${containerBaseClass} bg-white text-slate-700`
    : `${containerBaseClass} bg-slate-900 text-slate-100`;
  const headingClass = isLightTheme ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-slate-100";
  const metaContainerClass = isLightTheme
    ? "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"
    : "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400";
  const contentAreaClass = "flex min-h-0 flex-1 flex-col gap-4 pt-4";
  const metaLabelClass = isLightTheme ? "text-slate-500" : "text-slate-300";
  const previewContainerClass = isLightTheme
    ? "relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white"
    : "relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-900/90";
  const fallbackMessageClass = isLightTheme
    ? "flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-sm text-slate-500"
    : "flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-sm text-slate-400";
  const closeButtonClass = isLightTheme
    ? "absolute right-4 top-4 rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-white"
    : "absolute right-4 top-4 rounded-full p-2 text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900";
  const footerContainerClass = isLightTheme
    ? "flex flex-wrap gap-4 border-t border-slate-200 px-6 pt-4 text-[11px] text-slate-500"
    : "flex flex-wrap gap-4 border-t border-slate-800/80 px-6 pt-4 text-[11px] text-slate-400";
  const hashLabelClass = isLightTheme ? "font-mono break-all text-slate-600" : "font-mono break-all text-slate-400";
  const directUrlLabelClass = isLightTheme ? "text-slate-600" : "text-slate-300";
  const copyButtonClass = isLightTheme
    ? "flex max-w-full items-center gap-1 rounded px-1 text-left text-[11px] text-emerald-600 underline decoration-dotted underline-offset-2 hover:text-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-white"
    : "flex max-w-full items-center gap-1 rounded px-1 text-left text-[11px] text-emerald-300 underline decoration-dotted underline-offset-2 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900";

  return (
    <section className="flex h-full w-full flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        <div
          role="region"
          aria-label={`Preview ${displayName}`}
          className={containerClass}
        >
          <button
            type="button"
            className={closeButtonClass}
            onClick={onClose}
            aria-label="Close preview"
          >
            <CancelIcon size={18} />
          </button>
          <div className="px-6 pt-6">
            <h2 className={headingClass}>{displayName}</h2>
            <div className={metaContainerClass}>
              {sizeLabel && (
                <span>
                  <span className={metaLabelClass}>Size:</span> {sizeLabel}
                </span>
              )}
              {updatedLabel && (
                <span>
                  <span className={metaLabelClass}>Updated:</span> {updatedLabel}
                </span>
              )}
              <span>
                <span className={metaLabelClass}>Type:</span> {typeLabel}
              </span>
              {originLabel && (
                <span className="truncate">
                  <span className={metaLabelClass}>Server:</span> {originLabel}
                </span>
              )}
            </div>
          </div>
          <div className={contentAreaClass}>
            <div className={previewContainerClass}>
              {previewUnavailable ? (
                <div className={fallbackMessageClass}>
                  <FileTypeIcon
                    kind={derivedKind}
                    size={112}
                    className={isLightTheme ? "text-slate-400" : "text-slate-500"}
                  />
                  <p className="max-w-sm text-center">Preview not available for this file type.</p>
                </div>
              ) : (
                <BlobPreview
                  sha={blob.sha256}
                  url={previewUrl}
                  name={(blob.__bloomFolderPlaceholder || isListLikeBlob(blob) ? blob.name : getBlobMetadataName(blob)) ?? blob.sha256}
                  type={blob.type}
                  serverUrl={target.baseUrl ?? blob.serverUrl}
                  requiresAuth={requiresAuth}
                  signTemplate={requiresAuth ? signTemplate : undefined}
                  serverType={serverType}
                  onDetect={onDetect}
                  fallbackIconSize={160}
                  className="h-full w-full"
                  variant="dialog"
                  onVisible={onBlobVisible}
                  blurhash={blurhash}
                  blob={blob}
                />
              )}
            </div>
            <div className={footerContainerClass}>
              <span className={hashLabelClass}>Hash: {blob.sha256}</span>
              {blob.url && (
                <button
                  type="button"
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleDirectUrlCopy();
                  }}
                  className={copyButtonClass}
                  title="Copy direct URL"
                  aria-label="Copy direct URL"
                >
                  <span className={directUrlLabelClass}>Direct URL:</span>
                  <span className="truncate font-mono">{blob.url}</span>
                  <span className="mt-[1px] text-current"><CopyIcon size={12} /></span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};


export const BlobPreview: React.FC<{
  sha: string;
  url: string;
  name: string;
  type?: string;
  serverUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  onDetect: (sha: string, kind: "image" | "video") => void;
  className?: string;
  fallbackIconSize?: number;
  variant?: "inline" | "dialog";
  onVisible?: (sha: string) => void;
  blurhash?: BlurhashInfo | null;
  blob?: BlossomBlob;
}> = ({
  sha,
  url,
  name,
  type,
  serverUrl,
  requiresAuth = false,
  signTemplate,
  serverType = "blossom",
  onDetect,
  className,
  fallbackIconSize,
  variant = "inline",
  onVisible,
  blurhash,
  blob,
}) => {
  const privateMeta = blob?.privateData?.metadata;
  const privateEncryption = blob?.privateData?.encryption;
  const isPrivate = Boolean(privateEncryption);
  const effectiveName = privateMeta?.name ?? name;
  const effectiveType = privateMeta?.type ?? type;
  const previewKey = `${serverType}|${sha}|${requiresAuth ? "auth" : "anon"}|${url}|${isPrivate ? "private" : "public"}`;
  const initialCachedSrc = getCachedPreviewSrc(previewKey);

  const [src, setSrc] = useState<string | null>(initialCachedSrc);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewType, setPreviewType] = useState<"image" | "video" | "text" | "pdf" | "doc" | "unknown">(() => {
    if (isPreviewableTextType({ mime: effectiveType, name: effectiveName, url })) return "text";
    if (isPdfType(effectiveType, effectiveName || url)) return "pdf";
    if (isDocType(effectiveType, effectiveName || url)) return "doc";
    return inferKind(effectiveType, effectiveName || url) ?? "unknown";
  });
  const [isReady, setIsReady] = useState(Boolean(initialCachedSrc));
  const [textPreview, setTextPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const objectUrlRef = useRef<string | null>(initialCachedSrc ?? null);
  const lastLoadedKeyRef = useRef<string | null>(initialCachedSrc ? previewKey : null);
  const lastFailureKeyRef = useRef<string | null>(null);
  const activeRequestRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const [observeTarget, isVisible] = useInViewport<HTMLDivElement>({ rootMargin: "400px" });
  const hasReportedVisibilityRef = useRef(false);

  const detectRef = useRef(onDetect);
  useEffect(() => {
    detectRef.current = onDetect;
  }, [onDetect]);

  const fallbackIconKind = useMemo<FileKind>(() => {
    if (previewType === "image" || previewType === "video" || previewType === "pdf" || previewType === "doc") {
      return previewType;
    }
    if (isMusicType(effectiveType, effectiveName, url)) return "music";
    if (isSheetType(effectiveType, effectiveName || url)) return "sheet";
    if (isDocType(effectiveType, effectiveName || url)) return "doc";
    if (isPdfType(effectiveType, effectiveName || url)) return "pdf";
    if (isPreviewableTextType({ mime: effectiveType, name: effectiveName, url })) return "document";
    return "document";
  }, [previewType, effectiveType, effectiveName, url]);

  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      const cached = previewSrcCache.get(previewKey);
      if (!cached || cached.url !== objectUrlRef.current) {
        try {
          URL.revokeObjectURL(objectUrlRef.current);
        } catch (error) {
          // ignore revoke failures
        }
      }
      objectUrlRef.current = null;
    }
  }, [previewKey]);

  const cacheServerHint = useMemo(() => {
    if (serverUrl) return serverUrl.replace(/\/+$/, "");
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch (error) {
      return undefined;
    }
  }, [serverUrl, url]);

  const metaSuggestsText = useMemo(
    () => isPreviewableTextType({ mime: effectiveType, name: effectiveName, url }),
    [effectiveType, effectiveName, url]
  );

  useEffect(() => {
    return () => {
      releaseObjectUrl();
    };
  }, [releaseObjectUrl]);

  useEffect(() => {
    if (isPreviewableTextType({ mime: effectiveType, name: effectiveName, url })) {
      setPreviewType("text");
    } else if (isPdfType(effectiveType, effectiveName || url)) {
      setPreviewType("pdf");
    } else if (isDocType(effectiveType, effectiveName || url)) {
      setPreviewType("doc");
    } else {
      setPreviewType(inferKind(effectiveType, effectiveName || url) ?? "unknown");
    }
  }, [effectiveType, url, effectiveName]);

  useEffect(() => {
    if (!previewKey) return;

    if (lastLoadedKeyRef.current === previewKey && src) {
      setFailed(false);
      setLoading(false);
      setIsReady(true);
      return;
    }

    if (lastFailureKeyRef.current === previewKey) {
      return;
    }

    const cachedSrc = getCachedPreviewSrc(previewKey);
    if (cachedSrc) {
      lastLoadedKeyRef.current = previewKey;
      setSrc(cachedSrc);
      objectUrlRef.current = cachedSrc;
      setFailed(false);
      setLoading(false);
      setIsReady(true);
      if (previewType === "image") detectRef.current?.(sha, "image");
      if (previewType === "video") detectRef.current?.(sha, "video");
      return;
    }

    if (requiresAuth && !signTemplate) {
      lastFailureKeyRef.current = previewKey;
      setFailed(true);
      setLoading(false);
      setIsReady(false);
      return;
    }

    const existingRequest = activeRequestRef.current;
    if (existingRequest) {
      if (existingRequest.key === previewKey) {
        return;
      }
      existingRequest.controller.abort();
      activeRequestRef.current = null;
    }

    const controller = new AbortController();
    activeRequestRef.current = { key: previewKey, controller };
    let cancelled = false;

    setFailed(false);
    setLoading(true);
    setIsReady(Boolean(src));
    setTextPreview(null);

    const finalizeRequest = () => {
      if (activeRequestRef.current?.controller === controller) {
        activeRequestRef.current = null;
      }
    };

    const assignObjectUrl = (blobData: Blob) => {
      if (cancelled) return;
      clearCachedPreviewSrc(previewKey);
      releaseObjectUrl();
      const objectUrl = URL.createObjectURL(blobData);
      objectUrlRef.current = objectUrl;
      setCachedPreviewSrc(previewKey, objectUrl);
      lastLoadedKeyRef.current = previewKey;
      lastFailureKeyRef.current = null;
      setSrc(objectUrl);
      setIsReady(true);
      const resolvedType = blobData.type || effectiveType || privateMeta?.type;
      if (resolvedType === "application/pdf" || isPdfType(resolvedType, effectiveName ?? url)) {
        setPreviewType(previous => (previous === "pdf" ? previous : "pdf"));
      } else if (isDocType(resolvedType, effectiveName ?? url)) {
        setPreviewType(previous => (previous === "doc" ? previous : "doc"));
      } else if (resolvedType?.startsWith("image/") && previewType !== "image") {
        setPreviewType("image");
      } else if (resolvedType?.startsWith("video/") && previewType !== "video") {
        setPreviewType("video");
      }
    };

    const showTextPreview = async (blobData: Blob, mimeHint?: string | null) => {
      const normalizedMime = mimeHint ?? blobData.type ?? effectiveType;
      const shouldRenderText =
        isPreviewableTextType({ mime: normalizedMime, name: effectiveName, url }) ||
        (!normalizedMime && isPreviewableTextType({ name: effectiveName, url })) ||
        metaSuggestsText;
      if (!shouldRenderText) return false;
      try {
        const preview = await buildTextPreview(blobData);
        if (cancelled) return true;
        clearCachedPreviewSrc(previewKey);
        releaseObjectUrl();
        setSrc(null);
        setTextPreview(preview);
        setIsReady(true);
        lastLoadedKeyRef.current = previewKey;
        lastFailureKeyRef.current = null;
        return true;
      } catch (error) {
        return false;
      }
    };

    const load = async () => {
      try {
        if (previewType === "pdf" || previewType === "doc") {
          setLoading(false);
          finalizeRequest();
          return;
        }
        const allowPersistentCache = !isPrivate && !metaSuggestsText;
        const cachedBlob = allowPersistentCache ? await getCachedPreviewBlob(cacheServerHint, sha) : null;
        if (cancelled) return;
        if (cachedBlob) {
          assignObjectUrl(cachedBlob);
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (!isPrivate && previewType === "video" && url && !requiresAuth) {
          setSrc(url);
          setLoading(false);
          setIsReady(true);
          finalizeRequest();
          return;
        }

        const headers: Record<string, string> = {};
        if (requiresAuth && signTemplate) {
          const parsed = new URL(url, window.location.href);
          headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
            hash: sha,
            serverUrl: `${parsed.protocol}//${parsed.host}`,
            urlPath: `${parsed.pathname}${parsed.search}`,
            expiresInSeconds: 120,
          });
        }

        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          if (!controller.signal.aborted) {
            clearCachedPreviewSrc(previewKey);
            lastFailureKeyRef.current = previewKey;
            setFailed(true);
            setIsReady(false);
          }
          return;
        }

        const mimeHint = response.headers.get("content-type");

        if (isPrivate && privateEncryption) {
          const encryptedBuffer = await response.arrayBuffer();
          if (cancelled) return;
          try {
            if (privateEncryption.algorithm !== "AES-GCM") {
              throw new Error(`Unsupported encryption algorithm: ${privateEncryption.algorithm}`);
            }
            const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
              algorithm: "AES-GCM",
              key: privateEncryption.key,
              iv: privateEncryption.iv,
              originalName: privateMeta?.name,
              originalType: privateMeta?.type,
              originalSize: privateMeta?.size,
            });
            const mimeType = effectiveType || mimeHint || "application/octet-stream";
            const decryptedBlob = new Blob([decryptedBuffer], { type: mimeType });
            if (await showTextPreview(decryptedBlob, mimeType)) {
              setLoading(false);
              finalizeRequest();
              return;
            }
            assignObjectUrl(decryptedBlob);
            const inferred =
              inferKind(effectiveType ?? mimeType, effectiveName ?? url) ??
              inferKind(mimeType, effectiveName ?? url);
            if (inferred && inferred !== previewType) {
              if (inferred === "image" || inferred === "video") {
                setPreviewType(inferred);
              }
            }
            setLoading(false);
          } catch (error) {
            if (!controller.signal.aborted && !cancelled) {
              clearCachedPreviewSrc(previewKey);
              lastFailureKeyRef.current = previewKey;
              setFailed(true);
              setIsReady(false);
            }
            setLoading(false);
          } finally {
            finalizeRequest();
          }
          return;
        }

        const blobData = await response.blob();
        if (cancelled) return;

        if (await showTextPreview(blobData, mimeHint)) {
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (!requiresAuth) {
          const resolvedMime = mimeHint ?? effectiveType;
          if (resolvedMime === "application/pdf" || isPdfType(resolvedMime, effectiveName ?? url)) {
            setPreviewType(previous => (previous === "pdf" ? previous : "pdf"));
          } else if (isDocType(resolvedMime, effectiveName ?? url)) {
            setPreviewType(previous => (previous === "doc" ? previous : "doc"));
          } else if (resolvedMime?.startsWith("image/") && previewType !== "image") {
            setPreviewType("image");
          } else if (resolvedMime?.startsWith("video/") && previewType !== "video") {
            setPreviewType("video");
          }
          assignObjectUrl(blobData);
          setLoading(false);
          finalizeRequest();
          return;
        }

        if (allowPersistentCache && cacheServerHint) {
          void cachePreviewBlob(cacheServerHint, sha, blobData).catch(() => undefined);
        }
        assignObjectUrl(blobData);
        setLoading(false);
      } catch (error) {
        if (!controller.signal.aborted && !cancelled) {
          clearCachedPreviewSrc(previewKey);
          lastFailureKeyRef.current = previewKey;
          setFailed(true);
          setIsReady(false);
        }
        setLoading(false);
      } finally {
        finalizeRequest();
      }
    };

    if (!isVisible && variant === "inline") {
      setLoading(false);
      activeRequestRef.current = null;
      return;
    }

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    cacheServerHint,
    isVisible,
    metaSuggestsText,
    previewKey,
    releaseObjectUrl,
    requiresAuth,
    sha,
    signTemplate,
    src,
    effectiveType,
    effectiveName,
    url,
    variant,
    isPrivate,
    privateEncryption,
    previewType,
  ]);

  useEffect(() => {
    if (!previewKey) return;
    if (isVisible) {
      if (!hasReportedVisibilityRef.current) {
        hasReportedVisibilityRef.current = true;
        onVisible?.(sha);
      }
    } else {
      hasReportedVisibilityRef.current = false;
    }
  }, [isVisible, onVisible, previewKey, sha]);

  useEffect(() => {
    if (previewType === "pdf" || previewType === "doc") {
      setIsReady(true);
      setLoading(false);
      setFailed(false);
    }
  }, [previewType]);

  const isPdf = previewType === "pdf";
  const isDoc = previewType === "doc";
  const isStaticPreview = isPdf || isDoc;
  const showMedia = !isStaticPreview && Boolean(src) && !failed && Boolean(url);
  const isVideo = showMedia && previewType === "video";
  const isImage = showMedia && previewType === "image";
  const showLoading = !isStaticPreview && loading && !showMedia && !textPreview;
  const showUnavailable = !isStaticPreview && (failed || (!showMedia && !textPreview && !loading));

  const baseBackgroundClass = isLightTheme ? "bg-white" : "bg-slate-950/80";
  const classNames = `relative flex h-full w-full items-center justify-center overflow-hidden ${baseBackgroundClass} ${
    className ?? ""
  }`;
  const textPreviewWrapperClass = isLightTheme ? "px-4 py-3 text-xs text-slate-700" : "px-4 py-3 text-xs text-slate-200";
  const textPreviewPreClass = isLightTheme
    ? "line-clamp-6 whitespace-pre-wrap break-words text-[11px] leading-snug text-slate-800"
    : "line-clamp-6 whitespace-pre-wrap break-words text-[11px] leading-snug";

  const blurhashPlaceholder = blurhash ? (
    <BlurhashThumbnail
      hash={blurhash.hash}
      width={blurhash.width}
      height={blurhash.height}
      alt={effectiveName}
    />
  ) : null;

  const docBackgroundClass = isLightTheme
    ? "border border-slate-200 bg-gradient-to-br from-purple-100 via-white to-slate-100"
    : "border border-slate-800/80 bg-gradient-to-br from-purple-900/70 via-slate-900 to-slate-950";
  const docIconClass = isLightTheme ? "text-purple-600" : "text-purple-200";
  const pdfBackgroundClass = isLightTheme
    ? "border border-slate-200 bg-gradient-to-br from-red-100 via-white to-slate-100"
    : "border border-slate-800/80 bg-gradient-to-br from-red-900/70 via-slate-900 to-slate-950";
  const pdfIconClass = isLightTheme ? "text-red-500" : "text-red-200";

  const content = textPreview ? (
    <div className={textPreviewWrapperClass}>
      <pre className={textPreviewPreClass}>
        {textPreview.content}
        {textPreview.truncated ? " …" : ""}
      </pre>
    </div>
  ) : isImage ? (
    <img
      src={src ?? undefined}
      alt={effectiveName}
      className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      }`}
      loading="lazy"
      onLoad={() => {
        setIsReady(true);
        setLoading(false);
        setFailed(false);
        detectRef.current?.(sha, "image");
      }}
      onError={() => {
        clearCachedPreviewSrc(previewKey);
        releaseObjectUrl();
        setFailed(true);
      }}
    />
  ) : isVideo ? (
    <video
      src={src ?? undefined}
      className={`max-h-full max-w-full transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      }`}
      controls={variant === "dialog"}
      muted
      onCanPlay={() => {
        setIsReady(true);
        setLoading(false);
        setFailed(false);
        detectRef.current?.(sha, "video");
      }}
      onError={() => {
        clearCachedPreviewSrc(previewKey);
        releaseObjectUrl();
        setFailed(true);
      }}
    />
  ) : isDoc ? (
    <div
      className={`flex h-full w-full items-center justify-center rounded-2xl ${docBackgroundClass} transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      } ${variant === "dialog" ? "mx-4 my-4" : ""}`}
    >
      <DocumentIcon
        size={fallbackIconSize ?? (variant === "dialog" ? 120 : 56)}
        className={docIconClass}
        aria-hidden="true"
      />
    </div>
  ) : isPdf ? (
    <div
      className={`flex h-full w-full items-center justify-center rounded-2xl ${pdfBackgroundClass} transition-opacity duration-200 ${
        isReady ? "opacity-100" : "opacity-0"
      } ${variant === "dialog" ? "mx-4 my-4" : ""}`}
    >
      <FileTypeIcon
        kind="pdf"
        size={fallbackIconSize ?? (variant === "dialog" ? 120 : 56)}
        className={pdfIconClass}
        aria-hidden="true"
      />
    </div>
  ) : null;

  const loadingOverlayClass = isLightTheme
    ? "absolute inset-0 flex items-center justify-center bg-white/80 text-xs text-slate-600 pointer-events-none"
    : "absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs text-slate-300 pointer-events-none";
  const overlayBorderClass = isLightTheme ? "border-slate-200" : "border-slate-800/80";

  const overlayConfig = useMemo(() => {
    const baseSize = fallbackIconSize ?? (variant === "dialog" ? 96 : 48);
    const gradient = (light: string, dark: string) => (isLightTheme ? light : dark);
    const iconColor = (light: string, dark: string) => (isLightTheme ? light : dark);
    switch (fallbackIconKind) {
      case "music":
        return {
          background: gradient(
            "bg-gradient-to-br from-emerald-100 via-white to-slate-100",
            "bg-gradient-to-br from-emerald-900/70 via-slate-900 to-slate-950"
          ),
          icon: <MusicIcon size={baseSize} className={iconColor("text-emerald-600", "text-emerald-200")} aria-hidden="true" />,
        };
      case "video":
        return {
          background: gradient(
            "bg-gradient-to-br from-sky-100 via-white to-slate-100",
            "bg-gradient-to-br from-sky-900/70 via-slate-900 to-slate-950"
          ),
          icon: <VideoIcon size={baseSize} className={iconColor("text-sky-600", "text-sky-200")} aria-hidden="true" />,
        };
      case "pdf":
        return {
          background: gradient(
            "bg-gradient-to-br from-red-100 via-white to-slate-100",
            "bg-gradient-to-br from-red-900/70 via-slate-900 to-slate-950"
          ),
          icon: <FileTypeIcon kind="pdf" size={baseSize} className={iconColor("text-red-500", "text-red-200")} aria-hidden="true" />,
        };
      case "folder":
        return {
          background: gradient(
            "bg-gradient-to-br from-amber-100 via-white to-slate-100",
            "bg-gradient-to-br from-amber-900/70 via-slate-900 to-slate-950"
          ),
          icon: <FileTypeIcon kind="folder" size={baseSize} className={iconColor("text-amber-600", "text-amber-200")} aria-hidden="true" />,
        };
      case "doc":
      case "document":
        return {
          background: gradient(
            "bg-gradient-to-br from-purple-100 via-white to-slate-100",
            "bg-gradient-to-br from-purple-900/70 via-slate-900 to-slate-950"
          ),
          icon: <DocumentIcon size={baseSize} className={iconColor("text-purple-600", "text-purple-200")} aria-hidden="true" />,
        };
      default:
        return {
          background: gradient("bg-slate-200", "bg-slate-950/70"),
          icon: (
            <FileTypeIcon
              kind={fallbackIconKind}
              size={baseSize}
              className={iconColor("text-slate-600", "text-slate-300")}
              aria-hidden="true"
            />
          ),
        };
    }
  }, [fallbackIconKind, fallbackIconSize, variant, isLightTheme]);

  const showBlurhashPlaceholder = Boolean(blurhashPlaceholder && !textPreview && !showMedia && !isStaticPreview);
  const showLoadingOverlay = showLoading && !showBlurhashPlaceholder;
  const showUnavailableOverlay = showUnavailable && !showBlurhashPlaceholder;

  return (
    <div ref={observeTarget} className={classNames}>
      {showBlurhashPlaceholder ? (
        <div className="absolute inset-0">
          {blurhashPlaceholder}
        </div>
      ) : null}
      {content}
      {showLoadingOverlay && <div className={loadingOverlayClass}>Loading preview…</div>}
      {showUnavailableOverlay && (
        <div
          className={`absolute inset-0 flex items-center justify-center rounded-2xl border ${overlayBorderClass} ${overlayConfig.background} ${
            variant === "dialog" ? "mx-4 my-4" : ""
          }`}
        >
          {overlayConfig.icon}
        </div>
      )}
    </div>
  );
};


export function buildPreviewUrl(blob: BlossomBlob, baseUrl?: string | null) {
  if (blob.url) return blob.url;
  const fallback = blob.serverUrl ?? baseUrl;
  if (!fallback) return null;
  return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
}

export function extractBlurhash(blob: BlossomBlob): BlurhashInfo | null {
  const tags = Array.isArray(blob.nip94) ? blob.nip94 : null;
  if (!tags) return null;
  let hash: string | null = null;
  let width: number | undefined;
  let height: number | undefined;

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    const [key, value] = tag;
    if (key === "blurhash" && typeof value === "string" && value.trim()) {
      hash = value.trim();
    } else if (key === "dim" && typeof value === "string") {
      const [w, h] = value.trim().toLowerCase().split("x");
      const parsedWidth = Number(w);
      const parsedHeight = Number(h);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) width = parsedWidth;
      if (Number.isFinite(parsedHeight) && parsedHeight > 0) height = parsedHeight;
    } else if (key === "width" && typeof value === "string") {
      const parsedWidth = Number(value);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) width = parsedWidth;
    } else if (key === "height" && typeof value === "string") {
      const parsedHeight = Number(value);
      if (Number.isFinite(parsedHeight) && parsedHeight > 0) height = parsedHeight;
    }
  }

  if (!hash) return null;
  return { hash, width, height };
}

export function decideFileKind(blob: BlossomBlob, detected?: "image" | "video"): FileKind {
  if (detected) return detected;
  if (isListLikeBlob(blob)) return "folder";
  if (isSheetType(blob.type, blob.name || blob.url)) return "sheet";
  if (isDocType(blob.type, blob.name || blob.url)) return "doc";
  if (isPdfType(blob.type, blob.name || blob.url)) return "pdf";
  if (isMusicType(blob.type, blob.name, blob.url)) return "music";
  const inferred = inferKind(blob.type, blob.name || blob.url);
  if (inferred) return inferred;
  return "document";
}

function inferKind(type?: string, ref?: string | null): "image" | "video" | undefined {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|hevc)$/.test(name)) return "video";
  return undefined;
}

function hasMusicExtension(value?: string | null) {
  if (!value) return false;
  return MUSIC_EXTENSION_REGEX.test(value.toLowerCase());
}

function isMusicType(type?: string, name?: string | null, url?: string | null) {
  const normalizedMime = normalizeMime(type);
  if (normalizedMime?.startsWith("audio/")) return true;
  if (normalizedMime && ADDITIONAL_AUDIO_MIME_TYPES.has(normalizedMime)) return true;
  if (hasMusicExtension(name)) return true;
  if (hasMusicExtension(url)) return true;
  return false;
}

function isPdfType(type?: string, ref?: string | null) {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (mime === "application/pdf") return true;
  return name.endsWith(".pdf");
}

function isDocType(type?: string, ref?: string | null) {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (
    mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.oasis.opendocument.text" ||
    mime === "application/vnd.apple.pages"
  ) {
    return true;
  }
  return /\.(docx?|docm|dotx|dotm|odt|pages)$/i.test(name);
}

function isSheetType(type?: string, ref?: string | null) {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    mime === "application/vnd.apple.numbers"
  ) {
    return true;
  }
  return /\.(xlsx?|ods|numbers)$/i.test(name);
}

const TEXT_PREVIEW_MIME_ALLOWLIST = new Set(
  [
    "text/plain",
    "text/log",
    "text/csv",
    "text/markdown",
    "text/x-markdown",
    "text/css",
    "text/javascript",
    "application/json",
    "application/xml",
    "text/xml",
  ].map(value => value.toLowerCase())
);

const TEXT_PREVIEW_EXTENSION_ALLOWLIST = new Set([
  "txt",
  "log",
  "csv",
  "md",
  "markdown",
  "css",
  "js",
  "mjs",
  "cjs",
  "json",
  "xml",
]);

const TEXT_PREVIEW_MAX_BYTES = 32 * 1024;
const TEXT_PREVIEW_MAX_LINES = 40;
const TEXT_PREVIEW_MAX_CHARS = 2000;

const PREVIEW_OBJECT_URL_TTL_MS = 60_000;
const previewSrcCache = new Map<string, { url: string; expiresAt: number }>();

const getCachedPreviewSrc = (key: string): string | null => {
  const entry = previewSrcCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    URL.revokeObjectURL(entry.url);
    previewSrcCache.delete(key);
    return null;
  }
  entry.expiresAt = Date.now() + PREVIEW_OBJECT_URL_TTL_MS;
  previewSrcCache.set(key, entry);
  return entry.url;
};

const setCachedPreviewSrc = (key: string, url: string) => {
  previewSrcCache.set(key, { url, expiresAt: Date.now() + PREVIEW_OBJECT_URL_TTL_MS });
};

const clearCachedPreviewSrc = (key: string) => {
  const entry = previewSrcCache.get(key);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    previewSrcCache.delete(key);
  }
};

export const AudioCoverImage: React.FC<{
  url: string;
  alt: string;
  className?: string;
  fallback: React.ReactNode;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96" | "satellite";
  blob?: BlossomBlob;
  coverEntry?: PrivateListEntry | null;
  targetSize?: number;
}> = ({
  url,
  alt,
  className,
  fallback,
  requiresAuth = false,
  signTemplate,
  serverType = "blossom",
  blob,
  coverEntry,
  targetSize,
}) => {
  const [failed, setFailed] = useState(false);
  const coverEncryption = coverEntry?.encryption;
  const coverMetadata = coverEntry?.metadata;
  const preferredSize = Math.max(64, Math.min(targetSize ?? 256, 384));
  const optimizedUrl = useMemo(() => {
    if (requiresAuth || coverEncryption) return url;
    try {
      const parsed = new URL(url);
      const candidates = [preferredSize, Math.min(preferredSize * 2, 512)];
      const primary = new URL(parsed.toString());
      primary.searchParams.set("w", String(candidates[0]));
      primary.searchParams.set("h", String(candidates[0]));
      primary.searchParams.set("fit", "cover");
      return primary.toString();
    } catch {
      return url;
    }
  }, [coverEncryption, preferredSize, requiresAuth, url]);
  const [src, setSrc] = useState<string | null>(requiresAuth || coverEncryption ? null : optimizedUrl);
  const [usedOptimized, setUsedOptimized] = useState(() => optimizedUrl !== url);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    if (!url) {
      setSrc(null);
      setFailed(true);
      return () => {
        controller.abort();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
      };
    }

    const isDataUrl = url.startsWith("data:");
    const needsFetch = (requiresAuth || Boolean(coverEncryption)) && !isDataUrl;
    if (!needsFetch) {
      setSrc(optimizedUrl);
      setUsedOptimized(optimizedUrl !== url);
      setFailed(false);
      return () => {
        controller.abort();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
      };
    }

    setFailed(false);
    setSrc(null);

    const loadCover = async () => {
      try {
        const headers: Record<string, string> = {};
        if (requiresAuth && signTemplate) {
          if (serverType === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url,
              method: "GET",
            });
          } else {
            let resource: URL | null = null;
            try {
              resource = new URL(url, window.location.href);
            } catch {
              resource = null;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: coverEntry?.sha256,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob?.serverUrl,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
              expiresInSeconds: 300,
            });
          }
        }

        const fetchTarget = optimizedUrl;
        const response = await fetch(fetchTarget, {
          headers,
          signal: controller.signal,
          mode: "cors",
        });
        if (!response.ok) {
          throw new Error(`Cover fetch failed (${response.status})`);
        }

        let imageBlob: Blob;
        if (coverEncryption) {
          try {
            if (coverEncryption.algorithm !== "AES-GCM") {
              throw new Error(`Unsupported encryption algorithm: ${coverEncryption.algorithm}`);
            }
            const encryptedBuffer = await response.arrayBuffer();
            const decryptedBuffer = await decryptPrivateBlob(encryptedBuffer, {
              algorithm: "AES-GCM",
              key: coverEncryption.key,
              iv: coverEncryption.iv,
              originalName: coverMetadata?.name,
              originalType: coverMetadata?.type,
              originalSize: coverMetadata?.size,
            });
            const mimeType = coverMetadata?.type || response.headers.get("content-type") || "image/jpeg";
            imageBlob = new Blob([decryptedBuffer], { type: mimeType });
          } catch (error) {
            if (!cancelled) {
              console.warn("Cover fetch decrypt failed", error);
              setFailed(true);
            }
            return;
          }
        } else {
          imageBlob = await response.blob();
        }

        if (cancelled) return;
        const objectUrl = URL.createObjectURL(imageBlob);
        objectUrlRef.current = objectUrl;
        setSrc(objectUrl);
        setUsedOptimized(false);
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
        }
      }
    };

    loadCover();

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [coverEncryption, coverMetadata, optimizedUrl, requiresAuth, serverType, signTemplate, url]);

  if (!src || failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => {
        if (usedOptimized) {
          setUsedOptimized(false);
          setSrc(url);
          return;
        }
        setFailed(true);
      }}
      draggable={false}
    />
  );
};

const blurhashDataUrlCache = new Map<string, string>();

const buildBlurhashCacheKey = (hash: string, width?: number, height?: number) =>
  `${hash}|${width ?? ""}|${height ?? ""}`;

type IdleCancel = () => void;

const scheduleIdle = (work: () => void): IdleCancel => {
  if (typeof window === "undefined") {
    work();
    return () => undefined;
  }

  const win = window as typeof window & {
    requestIdleCallback?: (callback: (...args: any[]) => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(() => work(), { timeout: 150 });
    return () => {
      win.cancelIdleCallback?.(handle);
    };
  }

  const timeout = window.setTimeout(work, 32);
  return () => {
    window.clearTimeout(timeout);
  };
};

let blurhashCanvas: HTMLCanvasElement | null = null;
let blurhashContext: CanvasRenderingContext2D | null = null;

const ensureDecodeSurface = (width: number, height: number) => {
  if (!blurhashCanvas) {
    blurhashCanvas = document.createElement("canvas");
    blurhashContext = blurhashCanvas.getContext("2d");
  }
  if (!blurhashCanvas || !blurhashContext) return null;
  if (blurhashCanvas.width !== width) blurhashCanvas.width = width;
  if (blurhashCanvas.height !== height) blurhashCanvas.height = height;
  return { canvas: blurhashCanvas, ctx: blurhashContext } as const;
};

const decodeBlurhashToDataUrl = (hash: string, width?: number, height?: number): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const aspectRatio = width && height && height > 0 ? width / height : 1;
    const baseSize = 32;
    const maxSize = 64;
    let decodeWidth = baseSize;
    let decodeHeight = baseSize;
    if (aspectRatio > 1) {
      decodeWidth = Math.min(maxSize, Math.max(8, Math.round(baseSize * aspectRatio)));
      decodeHeight = Math.max(8, Math.round(decodeWidth / aspectRatio));
    } else if (aspectRatio > 0 && aspectRatio < 1) {
      decodeHeight = Math.min(maxSize, Math.max(8, Math.round(baseSize / Math.max(aspectRatio, 0.01))));
      decodeWidth = Math.max(8, Math.round(decodeHeight * aspectRatio));
    }
    decodeWidth = Math.max(4, Math.min(maxSize, decodeWidth));
    decodeHeight = Math.max(4, Math.min(maxSize, decodeHeight));

    const surface = ensureDecodeSurface(decodeWidth, decodeHeight);
    if (!surface) return null;
    const { canvas, ctx } = surface;
    const pixels = decode(hash, decodeWidth, decodeHeight);
    const imageData = ctx.createImageData(decodeWidth, decodeHeight);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  } catch (error) {
    console.warn("Failed to decode blurhash preview", error);
    return null;
  }
};

type BlurhashThumbnailProps = {
  hash: string;
  width?: number;
  height?: number;
  alt: string;
};

export function BlurhashThumbnail({ hash, width, height, alt }: BlurhashThumbnailProps) {
  const cacheKey = useMemo(() => buildBlurhashCacheKey(hash, width, height), [hash, width, height]);
  const [dataUrl, setDataUrl] = useState<string | null>(() => blurhashDataUrlCache.get(cacheKey) ?? null);

  useEffect(() => {
    const cached = blurhashDataUrlCache.get(cacheKey);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    let cancelled = false;
    const cancel = scheduleIdle(() => {
      if (cancelled) return;
      const result = decodeBlurhashToDataUrl(hash, width, height);
      if (cancelled) return;
      if (result) {
        blurhashDataUrlCache.set(cacheKey, result);
        setDataUrl(result);
      } else {
        setDataUrl(null);
      }
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [cacheKey, hash, width, height]);

  if (!dataUrl) {
    return <div className="h-full w-full bg-slate-900/70" />;
  }

  return <img src={dataUrl} alt={alt} className="h-full w-full object-cover" loading="lazy" draggable={false} />;
}

type TextPreviewMeta = {
  mime?: string | null;
  name?: string | null;
  url?: string | null;
};

function isPreviewableTextType(meta: TextPreviewMeta): boolean {
  const mime = normalizeMime(meta.mime);
  if (mime) {
    if (TEXT_PREVIEW_MIME_ALLOWLIST.has(mime)) return true;
    // Explicitly avoid treating other text types as previews unless they match the allow list.
  }

  if (hasTextPreviewExtension(meta.name)) return true;
  if (hasTextPreviewExtension(meta.url)) return true;

  return false;
}

async function buildTextPreview(blob: Blob): Promise<{ content: string; truncated: boolean }> {
  const limitedBlob = blob.size > TEXT_PREVIEW_MAX_BYTES ? blob.slice(0, TEXT_PREVIEW_MAX_BYTES) : blob;
  const raw = await limitedBlob.text();
  let truncated = blob.size > TEXT_PREVIEW_MAX_BYTES;

  // eslint-disable-next-line no-control-regex -- Expected to normalize NUL bytes from binary blobs.
  const sanitized = raw.replace(/\u0000/g, "\uFFFD").replace(/\r\n/g, "\n");
  let content = sanitized;

  const lines = content.split("\n");
  if (lines.length > TEXT_PREVIEW_MAX_LINES) {
    content = lines.slice(0, TEXT_PREVIEW_MAX_LINES).join("\n");
    truncated = true;
  }

  if (content.length > TEXT_PREVIEW_MAX_CHARS) {
    content = content.slice(0, TEXT_PREVIEW_MAX_CHARS);
    truncated = true;
  }

  content = content.trimEnd();
  if (!content) {
    return { content: "(empty file)", truncated };
  }

  if (truncated) {
    content = `${content}\n…`;
  }

  return { content, truncated };
}

function normalizeMime(value?: string | null) {
  if (!value) return undefined;
  const [primary] = value.split(";");
  return primary?.trim().toLowerCase() || undefined;
}

function hasTextPreviewExtension(ref?: string | null) {
  if (!ref) return false;
  const lower = ref.toLowerCase();
  const sanitized = lower.split(/[?#]/)[0] ?? "";
  const lastDot = sanitized.lastIndexOf(".");
  if (lastDot === -1 || lastDot === sanitized.length - 1) return false;
  const ext = sanitized.slice(lastDot + 1);
  return TEXT_PREVIEW_EXTENSION_ALLOWLIST.has(ext);
}

export function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[\r\n]+/g, " ");
  const segments = cleaned.split(/[\\/]/);
  return segments[segments.length - 1] || "download";
}

export function inferExtensionFromType(type?: string) {
  if (!type) return undefined;
  const [mime] = type.split(";");
  const lookup: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.apple.pages": "pages",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.apple.numbers": "numbers",
    "text/plain": "txt",
  };
  if (!mime) return undefined;
  return lookup[mime.trim().toLowerCase()];
}

export function ensureExtension(filename: string, extension?: string) {
  if (!extension) return filename;
  const lower = filename.toLowerCase();
  if (lower.endsWith(`.${extension.toLowerCase()}`)) return filename;
  return `${filename}.${extension}`;
}

export function buildDisplayName(blob: BlossomBlob) {
  if (blob.__bloomFolderPlaceholder || isListLikeBlob(blob)) {
    const rawFolderName = blob.name || blob.folderPath || blob.sha256;
    return sanitizeFilename(rawFolderName);
  }

  const metadataName = getBlobMetadataName(blob);
  const raw = metadataName ?? blob.sha256;
  const sanitized = sanitizeFilename(raw);
  const { baseName, extension: existingExtension } = splitNameAndExtension(sanitized);
  const inferredExtension = existingExtension || inferExtensionFromType(blob.type);

  const shouldKeepFullName = Boolean(metadataName) && blob.type?.startsWith("audio/");
  const displayBase = metadataName
    ? shouldKeepFullName
      ? baseName
      : truncateMiddle(baseName, 12, 12)
    : baseName;

  return inferredExtension ? `${displayBase}.${inferredExtension}` : displayBase;
}

function splitNameAndExtension(filename: string) {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return { baseName: trimmed, extension: undefined };
  }
  const baseName = trimmed.slice(0, lastDot);
  const extension = trimmed.slice(lastDot + 1);
  return { baseName, extension };
}

function truncateMiddle(value: string, head: number, tail: number) {
  if (value.length <= head + tail) return value;
  const start = value.slice(0, head);
  const end = value.slice(-tail);
  return `${start}...${end}`;
}
