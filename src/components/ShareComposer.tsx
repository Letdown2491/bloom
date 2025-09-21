import React, { useEffect, useMemo, useState } from "react";
import { NDKEvent, NDKPublishError, NDKRelaySet, NDKRelayStatus, normalizeRelayUrl } from "@nostr-dev-kit/ndk";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { DEFAULT_PUBLIC_RELAYS, extractPreferredRelays, sanitizeRelayUrl } from "../utils/relays";

export type SharePayload = {
  url: string;
  name?: string | null;
  sha256?: string | null;
  serverUrl?: string | null;
};

type ShareComposerProps = {
  shareKey?: string | null;
  payload?: SharePayload | null;
  embedded?: boolean;
  onClose?: () => void;
};

type RelayStatus = "idle" | "pending" | "success" | "error";

type RelayState = {
  status: RelayStatus;
  message?: string;
};

type ConnectionVariant =
  | "connected"
  | "connected-auth"
  | "connecting"
  | "authenticating"
  | "reconnecting"
  | "flapping"
  | "disconnecting"
  | "disconnected"
  | "missing"
  | "unknown";

type RelayConnectionState = {
  variant: ConnectionVariant;
  ndkStatus?: NDKRelayStatus;
  connectedAt?: number;
};

type ProfileInfo = {
  displayName: string | null;
  username: string | null;
  nip05: string | null;
  picture: string | null;
};

const DEFAULT_RELAYS = DEFAULT_PUBLIC_RELAYS;

const CONNECTION_VARIANT_STYLES: Record<ConnectionVariant, { label: string; dotClass: string }> = {
  "connected": {
    label: "Reachable",
    dotClass: "bg-emerald-500",
  },
  "connected-auth": {
    label: "Reachable (auth)",
    dotClass: "bg-emerald-500",
  },
  "authenticating": {
    label: "Authenticating…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  "connecting": {
    label: "Connecting…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  "reconnecting": {
    label: "Reconnecting…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  "flapping": {
    label: "Unstable connection",
    dotClass: "bg-amber-500",
  },
  "disconnecting": {
    label: "Disconnecting…",
    dotClass: "bg-slate-500",
  },
  "disconnected": {
    label: "Disconnected",
    dotClass: "bg-red-500",
  },
  "missing": {
    label: "Not connected",
    dotClass: "bg-slate-500",
  },
  "unknown": {
    label: "Status unknown",
    dotClass: "bg-slate-500",
  },
};

function mapRelayStatus(status: NDKRelayStatus): ConnectionVariant {
  switch (status) {
    case NDKRelayStatus.AUTHENTICATED:
      return "connected-auth";
    case NDKRelayStatus.AUTHENTICATING:
    case NDKRelayStatus.AUTH_REQUESTED:
      return "authenticating";
    case NDKRelayStatus.CONNECTED:
      return "connected";
    case NDKRelayStatus.CONNECTING:
      return "connecting";
    case NDKRelayStatus.RECONNECTING:
      return "reconnecting";
    case NDKRelayStatus.FLAPPING:
      return "flapping";
    case NDKRelayStatus.DISCONNECTING:
      return "disconnecting";
    case NDKRelayStatus.DISCONNECTED:
    default:
      return "disconnected";
  }
}

function safeNormalizeRelayUrl(value: string): string | null {
  if (!value) return null;
  try {
    return normalizeRelayUrl(value);
  } catch {
    try {
      const url = new URL(value);
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/+$/, "");
    } catch {
      const trimmed = value.trim();
      return trimmed ? trimmed.replace(/\/+$/, "") : null;
    }
  }
}

function describeConnectionState(state?: RelayConnectionState): { label: string; dotClass: string } {
  if (!state) {
    const base = CONNECTION_VARIANT_STYLES.unknown;
    return { label: base.label, dotClass: base.dotClass };
  }
  const base = CONNECTION_VARIANT_STYLES[state.variant] ?? CONNECTION_VARIANT_STYLES.unknown;
  return { label: base.label, dotClass: base.dotClass };
}

const emptyProfileInfo = (): ProfileInfo => ({ displayName: null, username: null, nip05: null, picture: null });

const computeInitials = (source: string | null | undefined): string => {
  if (!source) return "??";
  const trimmed = source.trim();
  if (!trimmed) return "??";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[1]?.[0] ?? "" : parts[0]?.[1] ?? "";
  const letters = `${first}${second}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  if (letters) return letters.toUpperCase();
  const fallback = trimmed.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return fallback ? fallback.toUpperCase() : "??";
};

const formatPubkeyHandle = (pubkey: string | null): string | null => {
  if (!pubkey) return null;
  const normalized = pubkey.trim();
  if (normalized.length <= 12) return `npub:${normalized}`;
  return `npub:${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
};

type PreviewAction = {
  key: string;
  label: string;
  icon: React.FC<{ className?: string }>;
};

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ReplyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M6 14v3.5L10.5 14H16a4 4 0 0 0 0-8H9a4 4 0 0 0-4 4v4" />
  </svg>
);

const ZapIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M12 3 7 13h4l-1 8 7-10h-4l1-8Z" />
  </svg>
);

const HeartIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      {...strokeProps}
      d="M12 19.5s-5.5-3.3-5.5-7.5A3.5 3.5 0 0 1 10 8.5a3 3 0 0 1 2 1 3 3 0 0 1 2-1 3.5 3.5 0 0 1 3.5 3.5c0 4.2-5.5 7.5-5.5 7.5Z"
    />
  </svg>
);

const RepostIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M7 7h8l-2-2m2 2-2 2" />
    <path {...strokeProps} d="M17 17H9l2 2m-2-2 2-2" />
    <path {...strokeProps} d="M7 12V9a3 3 0 0 1 3-3h8" />
    <path {...strokeProps} d="M17 12v3a3 3 0 0 1-3 3H6" />
  </svg>
);

const BookmarkIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M8 4h8a1 1 0 0 1 1 1v14l-5-3-5 3V5a1 1 0 0 1 1-1Z" />
  </svg>
);

const PREVIEW_ACTIONS: PreviewAction[] = [
  { key: "reply", label: "Reply", icon: ReplyIcon },
  { key: "zap", label: "Zap", icon: ZapIcon },
  { key: "like", label: "Like", icon: HeartIcon },
  { key: "repost", label: "Repost", icon: RepostIcon },
  { key: "bookmark", label: "Bookmark", icon: BookmarkIcon },
];

export const ShareComposer: React.FC<ShareComposerProps> = ({ shareKey, payload: initialPayload = null, embedded = false, onClose }) => {
  const { connect, signer, ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const [payload, setPayload] = useState<SharePayload | null>(initialPayload);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [noteContent, setNoteContent] = useState("");
  const [preferredRelays, setPreferredRelays] = useState<string[]>([]);
  const [relayStatuses, setRelayStatuses] = useState<Record<string, RelayState>>({});
  const [connectionStatuses, setConnectionStatuses] = useState<Record<string, RelayConnectionState>>({});
  const [mediaError, setMediaError] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [profileInfo, setProfileInfo] = useState<ProfileInfo>(() => emptyProfileInfo());

  const shareKeyDetails = useMemo(() => {
    if (!shareKey) return null;
    const separatorIndex = shareKey.indexOf(":");
    if (separatorIndex <= 0) {
      return { storageHint: "local" as const, storageKey: shareKey };
    }
    const prefix = shareKey.slice(0, separatorIndex);
    const remainder = shareKey.slice(separatorIndex + 1);
    if (prefix === "local" || prefix === "session") {
      return { storageHint: prefix as "local" | "session", storageKey: remainder };
    }
    return { storageHint: "local" as const, storageKey: shareKey };
  }, [shareKey]);

  useEffect(() => {
    if (!initialPayload) return;
    setPayload(initialPayload);
    setPayloadError(null);
    setRelayStatuses({});
    setGlobalError(null);
    setPublishing(false);
    setNoteContent("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPayload]);

  useEffect(() => {
    setMediaError(false);
  }, [payload?.url]);

  useEffect(() => {
    if (payload || !shareKeyDetails) return;
    if (typeof window === "undefined") return;
    const storageCandidates: Array<{ storage: Storage | null; type: "local" | "session" }> = [];
    if (shareKeyDetails.storageHint === "session") {
      storageCandidates.push({ storage: window.sessionStorage ?? null, type: "session" });
      storageCandidates.push({ storage: window.localStorage ?? null, type: "local" });
    } else {
      storageCandidates.push({ storage: window.localStorage ?? null, type: "local" });
      storageCandidates.push({ storage: window.sessionStorage ?? null, type: "session" });
    }

    let raw: string | null = null;
    for (const candidate of storageCandidates) {
      if (!candidate.storage) continue;
      try {
        const value = candidate.storage.getItem(shareKeyDetails.storageKey);
        if (value) {
          raw = value;
        }
        candidate.storage.removeItem(shareKeyDetails.storageKey);
        if (raw) break;
      } catch (_error) {
        // Try next storage option.
      }
    }

    if (!raw) {
      setPayloadError("Share details were not found. Try sharing the file again.");
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === "string") {
        setPayload(parsed);
        setPayloadError(null);
        setRelayStatuses({});
        setGlobalError(null);
        setPublishing(false);
        setNoteContent("");
      } else {
        setPayloadError("Share details were incomplete. Try sharing the file again.");
      }
    } catch (error) {
      setPayloadError("Share details could not be read. Try sharing the file again.");
    }
  }, [payload, shareKeyDetails]);

  useEffect(() => {
    if (!ndk || !pubkey) {
      setPreferredRelays([]);
      setMetadataLoaded(true);
      setProfileInfo(emptyProfileInfo());
      return;
    }
    let ignore = false;
    setMetadataLoaded(false);
    setMetadataError(null);
    setProfileInfo(emptyProfileInfo());
    ndk
      .fetchEvent({ kinds: [0], authors: [pubkey] })
      .then(evt => {
        if (ignore) return;
        if (!evt?.content) {
          setPreferredRelays([]);
          setProfileInfo(emptyProfileInfo());
          return;
        }
        try {
          const metadataRaw = JSON.parse(evt.content);
          setPreferredRelays(extractPreferredRelays(metadataRaw));
          const metadata = (metadataRaw ?? {}) as Record<string, unknown>;
          const pickString = (key: string): string | null => {
            const value = metadata[key];
            if (typeof value !== "string") return null;
            const trimmed = value.trim();
            return trimmed || null;
          };
          const nextProfile: ProfileInfo = {
            displayName: pickString("display_name") ?? pickString("displayName") ?? null,
            username: pickString("name"),
            nip05: pickString("nip05"),
            picture: pickString("picture"),
          };
          setProfileInfo(nextProfile);
        } catch (error) {
          setPreferredRelays([]);
          setMetadataError("Profile metadata could not be parsed.");
          setProfileInfo(emptyProfileInfo());
        }
      })
      .catch(() => {
        if (!ignore) {
          setPreferredRelays([]);
          setMetadataError("Profile metadata could not be loaded.");
          setProfileInfo(emptyProfileInfo());
        }
      })
      .finally(() => {
        if (!ignore) setMetadataLoaded(true);
      });
    return () => {
      ignore = true;
    };
  }, [ndk, pubkey]);

  const poolRelays = useMemo(() => {
    if (!ndk?.pool) return [] as string[];
    const urls = new Set<string>();
    ndk.pool.relays.forEach(relay => {
      const url = sanitizeRelayUrl(relay.url);
      if (url) urls.add(url);
    });
    return Array.from(urls);
  }, [ndk]);

  const effectiveRelays = useMemo(() => {
    if (preferredRelays.length > 0) return preferredRelays;
    if (poolRelays.length > 0) return poolRelays;
    return Array.from(DEFAULT_RELAYS);
  }, [preferredRelays, poolRelays]);

  const previewDisplayName = useMemo(() => {
    if (profileInfo.displayName) return profileInfo.displayName;
    if (profileInfo.username) return profileInfo.username;
    if (profileInfo.nip05) {
      const [namePart] = profileInfo.nip05.split("@");
      return namePart || profileInfo.nip05;
    }
    const formatted = formatPubkeyHandle(pubkey);
    return formatted ? formatted.replace(/^npub:/, "") : "Bloom user";
  }, [profileInfo.displayName, profileInfo.username, profileInfo.nip05, pubkey]);

  const previewHandle = useMemo(() => {
    if (profileInfo.nip05) return profileInfo.nip05;
    if (profileInfo.username) return `@${profileInfo.username}`;
    return formatPubkeyHandle(pubkey) ?? "npub:unknown";
  }, [profileInfo.nip05, profileInfo.username, pubkey]);

  const previewInitials = useMemo(() => {
    const source = profileInfo.displayName ?? profileInfo.username ?? profileInfo.nip05 ?? pubkey ?? null;
    return computeInitials(source);
  }, [profileInfo.displayName, profileInfo.username, profileInfo.nip05, pubkey]);

  const previewAvatar = profileInfo.picture;

  useEffect(() => {
    if (!ndk || typeof window === "undefined") {
      setConnectionStatuses({});
      return;
    }
    const pool = ndk.pool;
    if (!pool) {
      setConnectionStatuses({});
      return;
    }

    let disposed = false;

    const resolveStatus = () => {
      if (disposed) return;
      setConnectionStatuses(() => {
        const next: Record<string, RelayConnectionState> = {};
        effectiveRelays.forEach(relayUrl => {
          const normalized = safeNormalizeRelayUrl(relayUrl);
          const relay = normalized ? pool.relays.get(normalized) : undefined;
          if (!relay) {
            next[relayUrl] = { variant: "missing" };
          } else {
            next[relayUrl] = {
              variant: mapRelayStatus(relay.status),
              ndkStatus: relay.status,
              connectedAt: relay.connectionStats.connectedAt,
            };
          }
        });
        return next;
      });
    };

    resolveStatus();
    const interval = window.setInterval(resolveStatus, 5000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [ndk, effectiveRelays]);

  const usingFallbackRelays = preferredRelays.length === 0;
  const usingDefaultFallback = usingFallbackRelays && poolRelays.length === 0;

  useEffect(() => {
    if (embedded || !payload?.name) return;
    if (typeof document === "undefined") return;
    const originalTitle = document.title;
    document.title = `Share ${payload.name} – Bloom`;
    return () => {
      document.title = originalTitle;
    };
  }, [embedded, payload?.name]);

  const successes = useMemo(
    () =>
      Object.entries(relayStatuses)
        .filter(([, state]) => state.status === "success")
        .map(([url]) => url),
    [relayStatuses]
  );

  const failures = useMemo(
    () =>
      Object.entries(relayStatuses)
        .filter(([, state]) => state.status === "error")
        .map(([url, state]) => ({ url, message: state.message })),
    [relayStatuses]
  );

  const allComplete = useMemo(() => {
    if (!publishing && Object.keys(relayStatuses).length === 0) return false;
    return effectiveRelays.every(url => relayStatuses[url]?.status === "success" || relayStatuses[url]?.status === "error");
  }, [effectiveRelays, relayStatuses, publishing]);

  const handleShare = async () => {
    if (!payload?.url) {
      setGlobalError("Share link is missing.");
      return;
    }
    if (!ndk || !signer) {
      setGlobalError("Connect your NIP-07 signer to share.");
      return;
    }
    const relays = effectiveRelays;
    if (!relays.length) {
      setGlobalError("No relays available. Update your profile with preferred relays and try again.");
      return;
    }

    setGlobalError(null);
    const initialStatuses: Record<string, RelayState> = {};
    relays.forEach(url => {
      initialStatuses[url] = { status: "pending" };
    });
    setRelayStatuses(initialStatuses);
    setPublishing(true);

    const createdAt = Math.floor(Date.now() / 1000);
    const baseContent = noteContent.trimEnd();
    const finalContent = baseContent
      ? `${baseContent}${baseContent.endsWith("\n") ? "" : "\n\n"}${payload.url}`
      : payload.url;

    for (const relayUrl of relays) {
      try {
        const event = new NDKEvent(ndk, { kind: 1, content: finalContent, tags: [], created_at: createdAt });
        await event.sign();
        const relaySet = NDKRelaySet.fromRelayUrls([relayUrl], ndk);
        await event.publish(relaySet, 7000, 1);
        setRelayStatuses(prev => ({ ...prev, [relayUrl]: { status: "success" } }));
      } catch (error) {
        let message = "Failed to publish.";
        if (error instanceof NDKPublishError) {
          message = error.relayErrors || error.message;
        } else if (error instanceof Error) {
          message = error.message;
        }
        setRelayStatuses(prev => ({ ...prev, [relayUrl]: { status: "error", message } }));
      }
    }

    setPublishing(false);
  };

  const handleConnectClick = async () => {
    try {
      await connect();
      setGlobalError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to connect signer.";
      setGlobalError(message);
    }
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else if (typeof window !== "undefined") {
      window.close();
    }
  };

  const renderRelayStatus = (url: string) => {
    const publishState = relayStatuses[url];
    if (publishState) {
      if (publishState.status === "pending") return <span className="text-amber-300">Publishing…</span>;
      if (publishState.status === "success") return <span className="text-emerald-300">Published</span>;
      if (publishState.status === "error") return <span className="text-red-400">Error{publishState.message ? `: ${publishState.message}` : ""}</span>;
    }

    const connectionState = connectionStatuses[url];
    const { label, dotClass } = describeConnectionState(connectionState);
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center">
        <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
        <span className="sr-only">{label}</span>
      </span>
    );
  };

  const renderUnavailable = (message: string) => (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-center space-y-4">
        <h1 className="text-xl font-semibold">Sharing unavailable</h1>
        <p className="text-sm text-slate-400">{message}</p>
        <button
          onClick={handleClose}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Close
        </button>
      </div>
    </div>
  );

  const renderLoading = () => (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-center space-y-4">
        <h1 className="text-xl font-semibold">Preparing share</h1>
        <p className="text-sm text-slate-400">Loading file details…</p>
      </div>
    </div>
  );

  const contentUnavailable = payloadError ? renderUnavailable(payloadError) : !payload ? renderLoading() : null;

  const containerClasses = embedded
    ? "flex flex-1 min-h-0 w-full overflow-hidden text-slate-100"
    : "min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6";

  const wrapperClasses = embedded
    ? "flex flex-1 min-h-0 w-full flex-col lg:flex-row gap-6 p-4"
    : "flex flex-1 min-h-0 w-full max-w-5xl flex-col lg:flex-row gap-6 mx-auto";

  const shareCardClasses = "flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-lg";
  const previewCardClasses = "hidden lg:flex lg:w-1/2 flex-col rounded-2xl border border-slate-800 bg-slate-900/70";

  const previewNote = noteContent.trim();
  const mediaSourcePath = useMemo(() => {
    if (!payload?.url) return "";
    try {
      return new URL(payload.url).pathname.toLowerCase();
    } catch {
      return payload.url.toLowerCase();
    }
  }, [payload?.url]);
  const isImage = useMemo(() => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(mediaSourcePath), [mediaSourcePath]);
  const isVideo = useMemo(() => /\.(mp4|webm|ogg|mov|m4v)$/.test(mediaSourcePath), [mediaSourcePath]);
  const mediaType = useMemo(() => {
    if (mediaError || !payload?.url) return null;
    if (isImage) return "image";
    if (isVideo) return "video";
    return null;
  }, [mediaError, isImage, isVideo, payload?.url]);

  if (contentUnavailable) {
    return <div className={containerClasses}>{contentUnavailable}</div>;
  }

  const data = payload!;

  const relayLabel = usingFallbackRelays
    ? usingDefaultFallback
      ? "Using default Bloom relays"
      : "Using connected relays"
    : "Your preferred relays";
  return (
    <div className={containerClasses}>
      <div className={wrapperClasses}>
        <div className="flex w-full min-h-0 lg:w-1/2">
          <div className={`${shareCardClasses} ${embedded ? "p-4 sm:p-6" : "p-6"}`}>
            <header className="space-y-2">
              <h1 className="text-xl font-semibold">Note Composer</h1>
              <span className="text-xs text-slate-400">
                &nbsp;
              </span>
            </header>
        
            <div className="flex-1 overflow-auto space-y-6 pr-1">
              <section className="space-y-3">
                <textarea
                  id="share-note"
                  className="min-h-[160px] w-full resize-none rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  placeholder="Write something about this file…"
                  value={noteContent}
                  onChange={event => setNoteContent(event.target.value)}
                  disabled={publishing}
                />
                <div className="text-xs text-slate-400">
                  Shared file will be appended automatically:
                  <div className="mt-1 truncate text-slate-200">
                    <a href={data.url} target="_blank" rel="noopener noreferrer" className="hover:text-emerald-300">
                      {data.url}
                    </a>
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between text-xs uppercase tracking-wide text-slate-400">
                  <span>{relayLabel}</span>
                  {!metadataLoaded && <span className="text-slate-500">Loading…</span>}
                </div>
                {metadataError && (
                  <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    {metadataError}
                  </div>
                )}
                <ul className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">
                  {effectiveRelays.map(url => (
                    <li key={url} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-slate-200 sm:text-sm">{url}</span>
                      {renderRelayStatus(url)}
                    </li>
                  ))}
                </ul>
              </section>

              {globalError && (
                <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {globalError}
                </div>
              )}

              {allComplete && (
                <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                  {failures.length === 0
                    ? `Successfully published to ${successes.length} relay${successes.length === 1 ? "" : "s"}.`
                    : `Published to ${successes.length} relay${successes.length === 1 ? "" : "s"}. ${failures.length} failure${
                        failures.length === 1 ? "" : "s"
                      }.`}
                </div>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-600"
              >
                Close
              </button>
              <div className="flex flex-wrap items-center gap-2">
                {!signer && (
                  <button
                    type="button"
                    onClick={handleConnectClick}
                    className="rounded-xl border border-emerald-500/70 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:border-emerald-400"
                    disabled={publishing}
                  >
                    Connect signer
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleShare}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={publishing || !data.url}
                >
                  {publishing ? "Publishing…" : "Publish note"}
                </button>
              </div>
            </footer>
          </div>
        </div>

        <aside className={previewCardClasses}>
          <div className="flex flex-col gap-5 p-5">
            <div>
              <h1 className="text-xl font-semibold text-slate-100">Note Preview</h1>
            </div>

            <div className="flex-1 overflow-auto">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-5">
                <div className="flex flex-col gap-5">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-slate-800 text-sm font-semibold text-slate-300">
                      {previewAvatar ? (
                        <img
                          src={previewAvatar}
                          alt={`${previewDisplayName}'s avatar`}
                          className="h-full w-full object-cover"
                          onError={() => setProfileInfo(prev => ({ ...prev, picture: null }))}
                        />
                      ) : (
                        <span>{previewInitials}</span>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-semibold text-slate-100">{previewDisplayName}</span>
                      <span className="truncate text-xs text-slate-500">{previewHandle} | just now</span>
                    </div>
                  </div>

                  <div className="whitespace-pre-wrap break-words text-sm text-slate-100">
                    {previewNote ? previewNote : <span className="text-slate-500">Start typing to add a message.</span>}
                  </div>

                  {mediaType ? (
                    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/80">
                      {mediaType === "image" ? (
                        <img
                          src={data.url}
                          alt={data.name ? `Preview of ${data.name}` : "Shared media preview"}
                          className="w-full object-cover"
                          onError={() => setMediaError(true)}
                        />
                      ) : (
                        <video
                          src={data.url}
                          className="w-full bg-black"
                          controls
                          playsInline
                          muted
                          onError={() => setMediaError(true)}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-12 text-center text-xs text-slate-500">
                      {mediaError ? "Unable to load media preview." : "Media preview not available."}
                    </div>
                  )}

                  <div className="pt-1">
                    <div className="flex items-center justify-between text-slate-500">
                      {PREVIEW_ACTIONS.map(action => (
                        <span
                          key={action.key}
                          className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/60"
                          title={action.label}
                        >
                          <action.icon className="h-4 w-4" />
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
