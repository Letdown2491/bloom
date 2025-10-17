import React, { useCallback, useEffect, useMemo, useState } from "react";
import { nip19 } from "nostr-tools";
import { useNdk } from "../../app/context/NdkContext";
import {
  decodeFolderNaddr,
  encodeFolderNaddr,
  fetchFolderRecordByAddress,
  type FolderListAddress,
  type FolderListRecord,
  type FolderFileHint,
} from "../../shared/domain/folderList";
import { fetchNip94ByHashes } from "../../shared/api/nip94Fetch";
import type { Nip94ParsedEvent } from "../../shared/api/nip94";
import { prettyBytes, prettyDate } from "../../shared/utils/format";
import { DEFAULT_PUBLIC_RELAYS } from "../../shared/utils/relays";
import { DocumentIcon, RefreshIcon, LinkIcon, DownloadIcon } from "../../shared/ui/icons";

type PublicFolderPageProps = {
  naddr: string;
};

type FolderItem = {
  sha256: string;
  metadata: Nip94ParsedEvent | null;
  requiresAuth: boolean;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading"; address?: FolderListAddress | null }
  | {
      status: "ready";
      address: FolderListAddress;
      record: FolderListRecord;
      items: FolderItem[];
      fetchedAt: number;
    }
  | {
      status: "error";
      reason: "invalid-link" | "not-found" | "not-public" | "network";
      address?: FolderListAddress | null;
      record?: FolderListRecord | null;
    };

const shortenHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

const normalizeRelayUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    const trimmed = value.trim();
    return trimmed ? trimmed.replace(/\/+$/, "") : trimmed;
  }
};

const describeUpdatedAt = (timestamp?: number) => {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.trunc(timestamp));
  const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const diffSeconds = seconds - nowSeconds;
  const magnitude = Math.abs(diffSeconds);
  let value = diffSeconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  if (magnitude >= 365 * 24 * 3600) {
    value = Math.round(diffSeconds / (365 * 24 * 3600));
    unit = "year";
  } else if (magnitude >= 30 * 24 * 3600) {
    value = Math.round(diffSeconds / (30 * 24 * 3600));
    unit = "month";
  } else if (magnitude >= 7 * 24 * 3600) {
    value = Math.round(diffSeconds / (7 * 24 * 3600));
    unit = "week";
  } else if (magnitude >= 24 * 3600) {
    value = Math.round(diffSeconds / (24 * 3600));
    unit = "day";
  } else if (magnitude >= 3600) {
    value = Math.round(diffSeconds / 3600);
    unit = "hour";
  } else {
    value = Math.round(diffSeconds / 60);
    unit = "minute";
  }
  return {
    relative: relativeFormatter.format(value, unit),
    absolute: prettyDate(seconds),
  };
};

const isImageMime = (mime?: string | null) => (mime ? mime.toLowerCase().startsWith("image/") : false);

const buildUrlFromHint = (hint: FolderFileHint | null | undefined, sha: string) => {
  if (!hint) return undefined;
  if (hint.url && hint.url.trim()) return hint.url.trim();
  if (hint.serverUrl && hint.serverUrl.trim()) {
    const normalized = hint.serverUrl.trim().replace(/\/+$/, "");
    if (normalized) {
      return `${normalized}/${sha}`;
    }
  }
  return undefined;
};

const mergeMetadataWithHint = (
  sha: string,
  nip94: Nip94ParsedEvent | null | undefined,
  hint: FolderFileHint | null | undefined
): Nip94ParsedEvent | null => {
  if (!nip94 && !hint) return null;
  const base: Nip94ParsedEvent = nip94 ? { ...nip94 } : { sha256: sha, name: hint?.name ?? null };

  if (hint) {
    if (!base.url) {
      const inferredUrl = buildUrlFromHint(hint, sha);
      if (inferredUrl) base.url = inferredUrl;
    }
    if ((base.name == null || base.name === "") && hint.name) {
      base.name = hint.name;
    }
    if (!base.mimeType && hint.mimeType) {
      base.mimeType = hint.mimeType;
    }
    if ((base.size == null || !Number.isFinite(base.size)) && typeof hint.size === "number") {
      base.size = hint.size;
    }
  }

  if (!base.url && nip94?.url) {
    base.url = nip94.url;
  }

  return base;
};

export const PublicFolderPage: React.FC<PublicFolderPageProps> = ({ naddr }) => {
  const { ensureConnection } = useNdk();
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [refreshKey, setRefreshKey] = useState(0);

  const sanitizedNaddr = useMemo(() => naddr.trim(), [naddr]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const address = decodeFolderNaddr(sanitizedNaddr);
      if (!address) {
        if (!cancelled) {
          setState({ status: "error", reason: "invalid-link" });
        }
        return;
      }
      setState({ status: "loading", address });
      try {
        const ndk = await ensureConnection();
        let relayHints: string[] | undefined;
        if (ndk) {
          const candidateRelays = Array.isArray(address.relays) && address.relays.length > 0
            ? address.relays
            : Array.from(DEFAULT_PUBLIC_RELAYS);
          const normalizedRelays = candidateRelays
            .map(url => normalizeRelayUrl(url))
            .filter(url => url.length > 0);
          relayHints = normalizedRelays.length > 0 ? normalizedRelays : undefined;
          let addedExplicitRelay = false;
          normalizedRelays.forEach(url => {
            if (!url) return;
            const relay = ndk.pool?.relays.get(url);
            if (relay) {
              try {
                relay.connect();
              } catch (error) {
                console.warn("Unable to reconnect relay for shared link", url, error);
              }
              return;
            }
            try {
              ndk.addExplicitRelay(url, undefined, true);
              addedExplicitRelay = true;
            } catch (error) {
              console.warn("Unable to add relay from shared link", url, error);
            }
          });
          if (addedExplicitRelay) {
            await ndk.connect().catch(() => undefined);
          }
        }
        const record = await fetchFolderRecordByAddress(ndk, address, relayHints, { timeoutMs: 7000 });
        if (!record) {
          if (!cancelled) {
            setState({ status: "error", reason: "not-found", address });
          }
          return;
        }
        if (record.visibility !== "public") {
          if (!cancelled) {
            setState({ status: "error", reason: "not-public", address, record });
          }
          return;
        }
        const nip94Map = await fetchNip94ByHashes(ndk, record.shas, relayHints, { timeoutMs: 7000 });
        const items: FolderItem[] = record.shas.map(sha => {
          const normalizedSha = sha.toLowerCase();
          const hint = record.fileHints?.[normalizedSha] ?? null;
          const metadata = mergeMetadataWithHint(sha, nip94Map.get(normalizedSha) ?? null, hint);
          return {
            sha256: sha,
            metadata,
            requiresAuth: Boolean(hint?.requiresAuth),
          };
        });
        if (!cancelled) {
          setState({
            status: "ready",
            address,
            record,
            items,
            fetchedAt: Date.now(),
          });
        }
      } catch (error) {
        console.error("Failed to load shared folder", error);
        if (!cancelled) {
          setState({ status: "error", reason: "network" });
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [ensureConnection, sanitizedNaddr, refreshKey]);

  useEffect(() => {
    if (state.status === "ready") {
      const baseTitle = state.record.name || "Shared Folder";
      document.title = `${baseTitle} • Bloom`;
    } else {
      document.title = "Bloom";
    }
  }, [state]);

  const handleRefresh = useCallback(() => {
    setRefreshKey(current => current + 1);
  }, []);

  const ownerLabel = useMemo(() => {
    if (state.status !== "ready" && state.status !== "error") return null;
    const pubkey = state.address?.pubkey;
    if (!pubkey) return null;
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return pubkey;
    }
  }, [state]);

  const shareLink = useMemo(() => {
    if (state.status !== "ready") return null;
    const origin =
      typeof window !== "undefined" && window.location?.origin ? window.location.origin : "https://bloomapp.me";
    const encodedNaddr = encodeFolderNaddr(
      state.record,
      state.address.pubkey,
      state.address.relays
    );
    const encoded = encodeURIComponent(encodedNaddr ?? sanitizedNaddr);
    return `${origin}/folders/${encoded}`;
  }, [sanitizedNaddr, state]);

  const renderContent = () => {
    if (state.status === "loading" || state.status === "idle") {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-center">
          <p className="text-sm text-slate-300">Loading shared folder…</p>
        </div>
      );
    }
    if (state.status === "error") {
      const message =
        state.reason === "invalid-link"
          ? "This folder link is invalid."
          : state.reason === "not-found"
            ? "This folder could not be found on the relays."
            : state.reason === "not-public"
              ? "This folder is no longer public."
              : "We couldn't reach the relays to load this folder.";
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-center">
          <p className="text-sm text-slate-300">{message}</p>
          {state.reason === "network" ? (
            <button
              type="button"
              onClick={handleRefresh}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-emerald-500/60 bg-transparent px-4 py-2 text-sm font-medium text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
            >
              Retry
            </button>
          ) : null}
        </div>
      );
    }

    const { record, items } = state;
    const updatedAt = describeUpdatedAt(record.updatedAt);
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-xl font-semibold text-slate-100 sm:text-2xl">{record.name || "Shared Folder"}</h1>
              <p className="mt-1 text-sm text-slate-400">
                Shared by{" "}
                {ownerLabel ? (
                  <span className="font-mono text-slate-300 break-all">{ownerLabel}</span>
                ) : (
                  "Unknown owner"
                )}
              </p>
              {updatedAt ? (
                <p className="mt-1 text-xs text-slate-500">
                  Updated {updatedAt.absolute}
                  {updatedAt.relative ? ` (${updatedAt.relative})` : ""}
                </p>
              ) : null}
              <p className="mt-3 text-sm text-slate-300">
                This view is read-only. Content is fetched from Nostr relays each time you load the page.
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:w-52 sm:items-end">
              {shareLink ? (
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                  onClick={() => {
                    navigator.clipboard.writeText(shareLink).catch(() => undefined);
                  }}
                >
                  <LinkIcon size={16} /> Copy Link
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleRefresh}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/60 bg-transparent px-3 py-2 text-sm text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
              >
                <RefreshIcon size={16} /> Refresh
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">
              Folder Contents<span className="ml-2 text-sm font-normal text-slate-500">({items.length})</span>
            </h2>
          </div>
          {items.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-center">
              <p className="text-sm text-slate-400">This folder is currently empty.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {items.map(item => {
                const meta = item.metadata;
                const label = meta?.name?.trim() || item.sha256;
                const sizeLabel = meta?.size ? prettyBytes(meta.size) : null;
                const hasImagePreview = Boolean(meta?.url) && (isImageMime(meta?.mimeType) || /\.(png|jpe?g|gif|webp|avif)$/i.test(meta?.url ?? ""));
                return (
                  <li
                    key={item.sha256}
                    className="rounded-xl border border-slate-800/80 bg-slate-900/60 p-4 transition hover:border-slate-700/80 sm:p-5"
                  >
                    <div className="flex items-start gap-3 sm:gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
                        {hasImagePreview && meta?.url ? (
                          <img
                            src={meta.url}
                            alt={label}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <DocumentIcon size={22} className="text-slate-300" aria-hidden="true" />
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-base font-semibold text-slate-100">{label}</p>
                          <p className="mt-1 text-xs font-mono text-slate-500 break-all">
                            {shortenHash(item.sha256)}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                            {meta?.mimeType ? <span>{meta.mimeType}</span> : null}
                            {sizeLabel ? <span>{sizeLabel}</span> : null}
                            {meta?.createdAt ? <span>Shared {prettyDate(meta.createdAt)}</span> : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-2">
                          {meta?.url ? (
                            <a
                              href={meta.url}
                              download
                              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/60 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-200 transition hover:border-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                            >
                              <DownloadIcon size={16} aria-hidden="true" />
                              <span>Download</span>
                            </a>
                          ) : (
                            <span className="text-xs text-slate-500">{item.requiresAuth ? "Protected file" : "URL unavailable"}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-900/80 bg-slate-950/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div>
            <span className="text-lg font-semibold text-emerald-300">Bloom</span>
            <span className="ml-2 text-sm text-slate-500">Shared Folder</span>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">{renderContent()}</main>
      <footer className="mt-auto border-t border-slate-900/60 bg-slate-950/80"></footer>
    </div>
  );
};

export default PublicFolderPage;
