import React from "react";
import { CopyIcon, FileTypeIcon, TrashIcon, type FileKind } from "../../shared/ui/icons";
import { usePrivateLinks } from "./hooks/usePrivateLinks";
import type { PrivateLinkRecord } from "../../shared/domain/privateLinks";
import { describeExpiration } from "../../shared/utils/format";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".avif",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".hevc"]);
const MUSIC_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".opus"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const DOC_EXTENSIONS = new Set([".doc", ".docx", ".docm", ".dot", ".dotx", ".odt", ".pages"]);
const SHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".csv", ".ods", ".numbers"]);

const deriveLinkLabel = (link: PrivateLinkRecord) => {
  if (link.displayName && link.displayName.trim()) {
    return link.displayName.trim();
  }
  const targetUrl = link.target?.url;
  if (targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const candidate = parts[parts.length - 1];
      if (candidate) {
        return decodeURIComponent(candidate);
      }
    } catch (_error) {
      // Ignore parse errors; fall back to alias.
    }
  }
  return link.alias;
};

export const PrivateLinksPanel: React.FC = () => {
  const { links, isLoading, isFetching, error, serviceConfigured, serviceHost, revoke, revoking } =
    usePrivateLinks({
      enabled: true,
    });
  const [pendingAlias, setPendingAlias] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const activeLinks = React.useMemo(() => links.filter(link => link.status === "active"), [links]);
  const isBusy = revoking || pendingAlias !== null;
  const feedback = React.useMemo(() => {
    if (actionError) return { kind: "error" as const, message: actionError };
    if (error) return { kind: "error" as const, message: error.message };
    return null;
  }, [actionError, error]);

  const handleRevoke = React.useCallback(
    async (alias: string) => {
      setActionError(null);
      setPendingAlias(alias);
      try {
        await revoke(alias);
        setActionError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to revoke link.";
        setActionError(message);
      } finally {
        setPendingAlias(null);
      }
    },
    [revoke],
  );

  const handleCopyLink = React.useCallback(async (url: string, expired: boolean) => {
    setActionError(null);
    if (expired) {
      setActionError("This link has expired. Create a new one to share again.");
      return;
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("private-link:copied", {
            detail: { url },
          }),
        );
      }
    } catch (err) {
      console.error("Failed to copy private link", err);
      setActionError("Unable to copy link to clipboard.");
    }
  }, []);

  return (
    <div
      id="private-links-panel"
      className="w-full space-y-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow"
    >
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Manage Private Links</h2>
        <p className="mt-2 text-sm text-slate-400">
          Review the private download links you've created, copy their proxy URLs, or revoke access
          when sharing is no longer required.
        </p>
      </header>

      {feedback && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            feedback.kind === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-200"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {!serviceConfigured ? (
        <p className="text-sm text-slate-400">
          Configure the private link service to manage shared links.
        </p>
      ) : isLoading || isFetching ? (
        <p className="text-sm text-slate-400">Loading private links…</p>
      ) : activeLinks.length === 0 ? (
        <p className="text-sm text-slate-400">You haven't created any private links yet.</p>
      ) : (
        <ul className="w-full divide-y divide-slate-800 rounded-xl border border-slate-800/70">
          {activeLinks.map(link => {
            const shareUrl = `${serviceHost}/${link.alias}`;
            const label = deriveLinkLabel(link);
            const aliasBusy = pendingAlias === link.alias && isBusy;
            const { previewUrl, kind } = derivePreviewMeta(link);
            const expirationInfo = describeExpiration(link.expiresAt ?? null);
            const isExpired = Boolean(link.isExpired ?? expirationInfo.isExpired);
            const expirationTextClass = isExpired
              ? "text-red-300"
              : expirationInfo.isExpiringSoon
                ? "text-amber-300"
                : "text-slate-400";
            const copyDisabled = isBusy || isExpired;
            return (
              <li
                key={link.alias}
                className="flex flex-col gap-3 px-4 py-4 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-center sm:gap-4"
              >
                <div className="flex items-center gap-3">
                  <div className="relative h-12 w-12 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/50">
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt={`${label} preview`}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-400">
                        <FileTypeIcon kind={kind} size={28} />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="text-sm font-medium text-slate-200">{label}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={expirationTextClass}>{expirationInfo.summary}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs sm:justify-self-start">
                  <button
                    type="button"
                    onClick={() => handleCopyLink(shareUrl, isExpired)}
                    disabled={copyDisabled}
                    className={`group inline-flex items-center gap-2 rounded-md px-2 py-1 font-mono text-[11px] transition focus:outline-none focus:ring-1 focus:ring-emerald-400 ${
                      copyDisabled
                        ? "cursor-not-allowed border border-slate-800 bg-slate-900/40 text-slate-500"
                        : "border border-transparent text-emerald-300 hover:border-emerald-400/60 hover:bg-emerald-500/10 hover:text-emerald-100"
                    }`}
                    title={isExpired ? "Link expired" : "Copy proxy URL"}
                    aria-label={isExpired ? "Link expired" : "Copy proxy URL"}
                  >
                    <span className="break-all text-left">{shareUrl}</span>
                    <CopyIcon
                      size={14}
                      className={`opacity-70 transition ${copyDisabled ? "text-slate-500" : "group-hover:opacity-100"}`}
                    />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevoke(link.alias)}
                  disabled={isBusy}
                  className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition sm:justify-self-start ${
                    isBusy
                      ? "border-slate-700 bg-slate-800/70 text-slate-500"
                      : "border-red-500/50 text-red-300 hover:border-red-400 hover:text-red-200"
                  }`}
                >
                  <TrashIcon size={14} className={aliasBusy ? "opacity-60" : "opacity-80"} />
                  {aliasBusy ? "Revoking…" : "Revoke"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const derivePreviewMeta = (
  link: PrivateLinkRecord,
): { previewUrl: string | null; kind: FileKind } => {
  const reference = (link.target?.url ?? link.displayName ?? link.alias).toLowerCase();
  const extension = extractExtension(reference);
  if (extension && IMAGE_EXTENSIONS.has(extension)) {
    return { previewUrl: link.target?.url ?? null, kind: "image" };
  }
  if (extension && VIDEO_EXTENSIONS.has(extension)) {
    return { previewUrl: null, kind: "video" };
  }
  if (extension && MUSIC_EXTENSIONS.has(extension)) {
    return { previewUrl: null, kind: "music" };
  }
  if (extension && PDF_EXTENSIONS.has(extension)) {
    return { previewUrl: null, kind: "pdf" };
  }
  if (extension && DOC_EXTENSIONS.has(extension)) {
    return { previewUrl: null, kind: "doc" };
  }
  if (extension && SHEET_EXTENSIONS.has(extension)) {
    return { previewUrl: null, kind: "sheet" };
  }
  if (/(?:image\/|\.(png|jpg|jpeg|gif|webp|bmp|heic|avif)$)/.test(reference)) {
    return { previewUrl: link.target?.url ?? null, kind: "image" };
  }
  if (/(?:video\/|\.(mp4|mov|webm|mkv|avi|hevc)$)/.test(reference)) {
    return { previewUrl: null, kind: "video" };
  }
  if (/(?:audio\/|\.(mp3|wav|flac|aac|ogg|m4a|opus)$)/.test(reference)) {
    return { previewUrl: null, kind: "music" };
  }
  return { previewUrl: null, kind: "document" };
};

const extractExtension = (value: string | undefined | null) => {
  if (!value) return null;
  const match = value.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
  if (!match) return null;
  const matchedExtension = match[1];
  if (!matchedExtension) return null;
  return `.${matchedExtension.toLowerCase()}`;
};

export default PrivateLinksPanel;
