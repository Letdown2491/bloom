import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NDKRelayStatus, NDKRelay } from "@nostr-dev-kit/ndk";
import { useCurrentPubkey, useNdk } from "../../../app/context/NdkContext";
import {
  DEFAULT_PUBLIC_RELAYS,
  extractPreferredRelays,
  sanitizeRelayUrl,
} from "../../../shared/utils/relays";
import { nip19 } from "nostr-tools";
import { PrivateLinkPanel } from "../PrivateLinkPanel";
import { prettyBytes } from "../../../shared/utils/format";
import { ShareIcon } from "../../../shared/ui/icons";
import { checkLocalStorageQuota } from "../../../shared/utils/storageQuota";
import { loadNdkModule, type NdkModule } from "../../../shared/api/ndkModule";
import { useUserPreferences } from "../../../app/context/UserPreferencesContext";
import { usePrivateLinks } from "../../privateLinks/hooks/usePrivateLinks";

export type SharePayload = {
  url: string;
  name?: string | null;
  sha256?: string | null;
  serverUrl?: string | null;
  size?: number | null;
};

export type ShareMode = "note" | "dm" | "dm-private" | "private-link";

export type ShareCompletion = {
  mode: ShareMode;
  success: boolean;
  recipient?: {
    pubkey: string;
    npub: string;
    displayName: string | null;
    username: string | null;
    nip05: string | null;
  };
  successes?: number;
  failures?: number;
  message?: string | null;
  alias?: string;
  link?: string;
};

type ShareComposerProps = {
  shareKey?: string | null;
  payload?: SharePayload | null;
  embedded?: boolean;
  onClose?: () => void;
  onShareComplete?: (result: ShareCompletion) => void;
  initialMode?: ShareMode | null;
  onShareLinkRequest?: (payload: SharePayload, options?: { mode?: ShareMode }) => void;
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
  connected: {
    label: "Reachable",
    dotClass: "bg-emerald-500",
  },
  "connected-auth": {
    label: "Reachable (auth)",
    dotClass: "bg-emerald-500",
  },
  authenticating: {
    label: "Authenticating…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  connecting: {
    label: "Connecting…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  reconnecting: {
    label: "Reconnecting…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  flapping: {
    label: "Unstable connection",
    dotClass: "bg-amber-500",
  },
  disconnecting: {
    label: "Disconnecting…",
    dotClass: "bg-slate-500",
  },
  disconnected: {
    label: "Disconnected",
    dotClass: "bg-red-500",
  },
  missing: {
    label: "Not connected",
    dotClass: "bg-slate-500",
  },
  unknown: {
    label: "Status unknown",
    dotClass: "bg-slate-500",
  },
};

const mapRelayStatus = (
  status: NDKRelayStatus | undefined,
  enums: NdkModule["NDKRelayStatus"] | null,
): ConnectionVariant => {
  if (status === undefined || !enums) return "unknown";
  switch (status) {
    case enums.AUTHENTICATED:
      return "connected-auth";
    case enums.AUTHENTICATING:
    case enums.AUTH_REQUESTED:
      return "authenticating";
    case enums.CONNECTED:
      return "connected";
    case enums.CONNECTING:
      return "connecting";
    case enums.RECONNECTING:
      return "reconnecting";
    case enums.FLAPPING:
      return "flapping";
    case enums.DISCONNECTING:
      return "disconnecting";
    case enums.DISCONNECTED:
      return "disconnected";
    default:
      return "unknown";
  }
};

const safeNormalizeRelayUrl = (
  value: string,
  normalizeRelayUrlFn: ((value: string) => string) | null,
): string | null => {
  if (!value) return null;
  if (normalizeRelayUrlFn) {
    try {
      return normalizeRelayUrlFn(value);
    } catch {
      // fall back to manual normalization below
    }
  }
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    const trimmed = value.trim();
    return trimmed ? trimmed.replace(/\/+$/, "") : null;
  }
};

function describeConnectionState(state?: RelayConnectionState): {
  label: string;
  dotClass: string;
} {
  if (!state) {
    const base = CONNECTION_VARIANT_STYLES.unknown;
    return { label: base.label, dotClass: base.dotClass };
  }
  const base = CONNECTION_VARIANT_STYLES[state.variant] ?? CONNECTION_VARIANT_STYLES.unknown;
  return { label: base.label, dotClass: base.dotClass };
}

const emptyProfileInfo = (): ProfileInfo => ({
  displayName: null,
  username: null,
  nip05: null,
  picture: null,
});

const computeInitials = (source: string | null | undefined): string => {
  if (!source) return "??";
  const trimmed = source.trim();
  if (!trimmed) return "??";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
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

type RecipientProfile = {
  pubkey: string;
  npub: string;
  displayName: string | null;
  username: string | null;
  nip05: string | null;
  picture: string | null;
  lastFetched?: number;
};

type RecipientSuggestion = RecipientProfile & {
  origin: "recent" | "direct" | "nip05" | "cache";
};

const RECIPIENT_STORAGE_KEY = "bloom-share-dm-recipients";

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

const formatByteSize = (value: number | null | undefined): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const formatted = size >= 100 ? Math.round(size).toString() : size.toFixed(1).replace(/\.0$/, "");
  return `${formatted} ${units[unitIndex]}`;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

const buildMetadataBlock = (payload: SharePayload | null): string | null => {
  if (!payload) return null;
  const lines: string[] = [];
  lines.push("Shared file:");
  const nameLine = payload.name ? payload.name : undefined;
  if (nameLine) lines.push(`• Name: ${nameLine}`);
  if (payload.sha256) lines.push(`• SHA-256: ${payload.sha256}`);
  const sizeText = formatByteSize(payload.size ?? null);
  if (sizeText) lines.push(`• Size: ${sizeText}`);
  const link = payload.url;
  if (link) lines.push(`• URL: ${link}`);
  return lines.join("\n");
};

const combineContent = (message: string, appendix: string | null): string => {
  const trimmedMessage = message.trimEnd();
  if (!appendix) return trimmedMessage;
  if (!trimmedMessage) return appendix;
  const needsSpacing = !trimmedMessage.endsWith("\n\n") && !trimmedMessage.endsWith("\n");
  const separator = needsSpacing ? "\n\n" : "";
  return `${trimmedMessage}${separator}${appendix}`;
};

const RECIPIENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_STORED_RECIPIENTS = 80;
const CRITICAL_RECIPIENT_LIMIT = 30;

const pruneRecipientProfiles = (profiles: RecipientProfile[], maxCount = MAX_STORED_RECIPIENTS) => {
  const now = Date.now();
  const deduped = new Map<string, RecipientProfile>();
  for (const profile of profiles) {
    const existing = deduped.get(profile.pubkey);
    if (!existing) {
      deduped.set(profile.pubkey, profile);
      continue;
    }
    const existingFetched = existing.lastFetched ?? 0;
    const incomingFetched = profile.lastFetched ?? 0;
    if (incomingFetched > existingFetched) {
      deduped.set(profile.pubkey, profile);
    }
  }
  const filtered = Array.from(deduped.values()).filter(profile => {
    if (!profile.lastFetched) return true;
    return now - profile.lastFetched <= RECIPIENT_CACHE_TTL_MS;
  });
  filtered.sort((a, b) => (b.lastFetched ?? 0) - (a.lastFetched ?? 0));
  if (filtered.length > maxCount) {
    return filtered.slice(0, maxCount);
  }
  return filtered;
};

const readStoredRecipients = (): RecipientProfile[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECIPIENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RecipientProfile[] = [];
    for (const item of parsed) {
      if (!item || typeof item.pubkey !== "string") continue;
      try {
        const npub = nip19.npubEncode(item.pubkey);
        entries.push({
          pubkey: item.pubkey,
          npub,
          displayName: typeof item.displayName === "string" ? item.displayName : null,
          username: typeof item.username === "string" ? item.username : null,
          nip05: typeof item.nip05 === "string" ? item.nip05 : null,
          picture: typeof item.picture === "string" ? item.picture : null,
          lastFetched: typeof item.lastFetched === "number" ? item.lastFetched : undefined,
        });
      } catch {
        // Ignore decode errors for stored entries.
      }
    }
    return pruneRecipientProfiles(entries);
  } catch {
    return [];
  }
};

const storeRecipients = (profiles: RecipientProfile[]) => {
  if (typeof window === "undefined") return;
  try {
    const pruned = pruneRecipientProfiles(profiles);
    const serialized = pruned.map(profile => ({
      pubkey: profile.pubkey,
      displayName: profile.displayName,
      username: profile.username,
      nip05: profile.nip05,
      picture: profile.picture,
      lastFetched: profile.lastFetched ?? Date.now(),
    }));
    window.localStorage.setItem(RECIPIENT_STORAGE_KEY, JSON.stringify(serialized));
    const quota = checkLocalStorageQuota("share-recipients");
    if (quota.status === "critical" && pruned.length > CRITICAL_RECIPIENT_LIMIT) {
      const trimmed = pruneRecipientProfiles(pruned, CRITICAL_RECIPIENT_LIMIT);
      const trimmedSerialized = trimmed.map(profile => ({
        pubkey: profile.pubkey,
        displayName: profile.displayName,
        username: profile.username,
        nip05: profile.nip05,
        picture: profile.picture,
        lastFetched: profile.lastFetched ?? Date.now(),
      }));
      window.localStorage.setItem(RECIPIENT_STORAGE_KEY, JSON.stringify(trimmedSerialized));
      checkLocalStorageQuota("share-recipients-pruned", { log: false });
    }
  } catch {
    // Ignore storage errors.
  }
};

const toRecipientProfile = (
  pubkey: string,
  metadata?: Record<string, unknown>,
  existing?: RecipientProfile,
): RecipientProfile => {
  let npub: string;
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    npub = pubkey;
  }
  const safeString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  };
  const result: RecipientProfile = {
    pubkey,
    npub,
    displayName: existing?.displayName ?? null,
    username: existing?.username ?? null,
    nip05: existing?.nip05 ?? null,
    picture: existing?.picture ?? null,
    lastFetched: Date.now(),
  };
  if (metadata) {
    const meta = metadata as Record<string, unknown>;
    result.displayName =
      safeString(meta["display_name"]) ?? safeString(meta["displayName"]) ?? result.displayName;
    result.username = safeString(meta["name"]) ?? result.username;
    result.nip05 = safeString(meta["nip05"]) ?? result.nip05;
    result.picture = safeString(meta["picture"]) ?? result.picture;
  }
  return result;
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

const CloseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M6 6 18 18" />
    <path {...strokeProps} d="M6 18 18 6" />
  </svg>
);

const NoteIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M8 4h7l3 3v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
    <path {...strokeProps} d="M15 4v4h4" />
  </svg>
);

const SendIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...strokeProps} d="M3.5 5.5 20.5 12 3.5 18.5l3-6.5-3-6.5Z" />
    <path {...strokeProps} d="m6.5 12 4 1-1 4" />
  </svg>
);

const PREVIEW_ACTIONS: PreviewAction[] = [
  { key: "reply", label: "Reply", icon: ReplyIcon },
  { key: "zap", label: "Zap", icon: ZapIcon },
  { key: "like", label: "Like", icon: HeartIcon },
  { key: "repost", label: "Repost", icon: RepostIcon },
  { key: "bookmark", label: "Bookmark", icon: BookmarkIcon },
];

export const ShareComposer: React.FC<ShareComposerProps> = ({
  shareKey,
  payload: initialPayload = null,
  embedded = false,
  onClose,
  onShareComplete,
  initialMode = null,
  onShareLinkRequest,
}) => {
  const { connect, signer, ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const profileCacheRef = useRef<Map<string, RecipientProfile>>(new Map());
  const [profileCacheTick, setProfileCacheTick] = useState(0);
  const [recentRecipients, setRecentRecipients] = useState<RecipientProfile[]>(() => {
    const stored = readStoredRecipients();
    stored.forEach(profile => {
      profileCacheRef.current.set(profile.pubkey, profile);
    });
    return stored;
  });
  const [shareMode, setShareMode] = useState<ShareMode>(initialMode ?? "note");
  const initialModeRef = useRef<ShareMode | null | undefined>(initialMode);
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipientResults, setRecipientResults] = useState<RecipientSuggestion[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState<RecipientProfile | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [isSearchingRecipients, setIsSearchingRecipients] = useState(false);
  const [payload, setPayload] = useState<SharePayload | null>(initialPayload);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [noteContent, setNoteContent] = useState("");
  const [preferredRelays, setPreferredRelays] = useState<string[]>([]);
  const [relayStatuses, setRelayStatuses] = useState<Record<string, RelayState>>({});
  const [connectionStatuses, setConnectionStatuses] = useState<
    Record<string, RelayConnectionState>
  >({});
  const [mediaError, setMediaError] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [privateLinkDetails, setPrivateLinkDetails] = useState<{
    link: string;
    alias: string | null;
  } | null>(null);
  const [showRelayDetails, setShowRelayDetails] = useState(false);
  const [profileInfo, setProfileInfo] = useState<ProfileInfo>(() => emptyProfileInfo());
  const {
    preferences: { theme },
  } = useUserPreferences();
  const isLightTheme = theme === "light";
  const privateLinkState = usePrivateLinks({ enabled: shareMode === "private-link" });

  const runtimeRef = useRef<NdkModule | null>(null);
  const normalizeRelayUrlRef = useRef<NdkModule["normalizeRelayUrl"] | null>(null);
  const [relayStatusEnum, setRelayStatusEnum] = useState<NdkModule["NDKRelayStatus"] | null>(null);

  useEffect(() => {
    if (initialModeRef.current === initialMode) return;
    initialModeRef.current = initialMode;
    setShareMode(initialMode ?? "note");
  }, [initialMode]);

  const ensureRuntime = useCallback(async () => {
    if (!runtimeRef.current) {
      const module = await loadNdkModule();
      runtimeRef.current = module;
      normalizeRelayUrlRef.current = module.normalizeRelayUrl;
      setRelayStatusEnum(module.NDKRelayStatus);
    }
    return runtimeRef.current;
  }, []);

  useEffect(() => {
    void ensureRuntime();
  }, [ensureRuntime]);

  const isLegacyDmMode = shareMode === "dm";
  const isPrivateDmMode = shareMode === "dm-private";
  const isDmMode = isLegacyDmMode || isPrivateDmMode;

  const ensureRecipientProfile = useCallback(
    async (targetPubkey: string): Promise<RecipientProfile> => {
      const existing = profileCacheRef.current.get(targetPubkey);
      const shouldRefresh =
        !existing || !existing.lastFetched || Date.now() - existing.lastFetched > 5 * 60 * 1000;
      let metadata: Record<string, unknown> | undefined;
      if (shouldRefresh && ndk) {
        try {
          const evt = await ndk.fetchEvent({ kinds: [0], authors: [targetPubkey] });
          if (evt?.content) {
            try {
              metadata = JSON.parse(evt.content);
            } catch {
              metadata = undefined;
            }
          }
        } catch {
          metadata = undefined;
        }
      }
      const profile = toRecipientProfile(targetPubkey, metadata, existing);
      profileCacheRef.current.set(targetPubkey, profile);
      setProfileCacheTick(prev => prev + 1);
      return profile;
    },
    [ndk],
  );

  const resolveNip05 = useCallback(
    async (value: string): Promise<RecipientProfile | null> => {
      const trimmed = value.replace(/^@/, "").trim();
      const atIndex = trimmed.indexOf("@");
      if (atIndex <= 0 || atIndex >= trimmed.length - 1) return null;
      const namePart = trimmed.slice(0, atIndex).toLowerCase();
      const domainPart = trimmed.slice(atIndex + 1).toLowerCase();
      if (!namePart || !domainPart) return null;
      const url = `https://${domainPart}/.well-known/nostr.json?name=${encodeURIComponent(namePart)}`;
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) return null;
        const data = (await response.json()) as { names?: Record<string, string> };
        const pubkey = data?.names?.[namePart];
        if (!pubkey || !HEX_64_REGEX.test(pubkey)) return null;
        const profile = await ensureRecipientProfile(pubkey.toLowerCase());
        return { ...profile, nip05: `${namePart}@${domainPart}` };
      } catch {
        return null;
      }
    },
    [ensureRecipientProfile],
  );

  const interpretRecipientInput = useCallback(
    async (value: string): Promise<RecipientSuggestion | null> => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (HEX_64_REGEX.test(trimmed)) {
        const profile = await ensureRecipientProfile(trimmed.toLowerCase());
        return { ...profile, origin: "direct" };
      }
      const lowered = trimmed.toLowerCase();
      if (lowered.startsWith("npub1")) {
        try {
          const decoded = nip19.decode(trimmed);
          if (decoded.type === "npub") {
            const data = decoded.data;
            const hex = typeof data === "string" ? data : bytesToHex(data as Uint8Array);
            if (HEX_64_REGEX.test(hex)) {
              const profile = await ensureRecipientProfile(hex.toLowerCase());
              return { ...profile, origin: "direct" };
            }
          }
        } catch {
          // Ignore decode errors and continue.
        }
      }
      if (lowered.includes("@")) {
        const profile = await resolveNip05(lowered.startsWith("@") ? lowered : `@${lowered}`);
        if (profile) {
          return { ...profile, origin: "nip05" };
        }
      }
      return null;
    },
    [ensureRecipientProfile, resolveNip05],
  );

  const handleRecipientSelect = useCallback((profile: RecipientProfile) => {
    setSelectedRecipient(profile);
    setRecipientQuery(profile.nip05 ?? profile.displayName ?? profile.username ?? profile.npub);
    setRecipientResults([{ ...profile, origin: "direct" }]);
    setRecipientError(null);
  }, []);

  const handleRecipientInputChange = useCallback((value: string) => {
    setRecipientQuery(value);
    setSelectedRecipient(null);
  }, []);

  const handleClearRecipient = useCallback(() => {
    setSelectedRecipient(null);
    setRecipientQuery("");
    setRecipientError(null);
  }, []);

  useEffect(() => {
    if (shareMode === "note") return;
    let ignore = false;
    const run = async () => {
      const trimmed = recipientQuery.trim();
      if (!trimmed) {
        if (!ignore) {
          setRecipientResults(recentRecipients.map(profile => ({ ...profile, origin: "recent" })));
          setRecipientError(null);
          setIsSearchingRecipients(false);
        }
        return;
      }
      setIsSearchingRecipients(true);
      setRecipientError(null);
      try {
        const suggestions = new Map<string, RecipientSuggestion>();
        const direct = await interpretRecipientInput(trimmed);
        if (direct) {
          suggestions.set(direct.pubkey, direct);
        }

        const normalizedQuery = trimmed.replace(/^@/, "").toLowerCase();
        profileCacheRef.current.forEach(profile => {
          const haystack = [
            profile.displayName?.toLowerCase(),
            profile.username?.toLowerCase(),
            profile.nip05?.toLowerCase(),
            profile.npub.toLowerCase(),
          ];
          if (haystack.some(entry => entry && entry.includes(normalizedQuery))) {
            if (!suggestions.has(profile.pubkey)) {
              suggestions.set(profile.pubkey, { ...profile, origin: "cache" });
            }
          }
        });

        if (!suggestions.size && normalizedQuery.includes("@")) {
          const nip05Profile = await resolveNip05(
            normalizedQuery.startsWith("@") ? normalizedQuery : `@${normalizedQuery}`,
          );
          if (nip05Profile) {
            suggestions.set(nip05Profile.pubkey, { ...nip05Profile, origin: "nip05" });
          }
        }

        const ordered = Array.from(suggestions.values()).sort((a, b) => {
          if (a.origin === b.origin) {
            return (a.displayName || a.username || a.nip05 || a.npub).localeCompare(
              b.displayName || b.username || b.nip05 || b.npub,
            );
          }
          const priority: Record<RecipientSuggestion["origin"], number> = {
            direct: 0,
            nip05: 1,
            recent: 2,
            cache: 3,
          };
          return priority[a.origin] - priority[b.origin];
        });

        if (!ignore) {
          setRecipientResults(ordered);
          if (!ordered.length) {
            setRecipientError("No cached matches. Paste an npub, hex key, or full NIP-05 handle.");
          } else {
            setRecipientError(null);
          }
        }
      } finally {
        if (!ignore) setIsSearchingRecipients(false);
      }
    };

    run();
    return () => {
      ignore = true;
    };
  }, [
    shareMode,
    recipientQuery,
    interpretRecipientInput,
    recentRecipients,
    resolveNip05,
    profileCacheTick,
  ]);

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
    setShareMode(initialMode ?? "note");
    setPrivateLinkDetails(null);
    setRecipientQuery("");
    setRecipientResults([]);
    setSelectedRecipient(null);
    setRecipientError(null);
    setIsSearchingRecipients(false);
  }, [initialPayload]);

  useEffect(() => {
    setMediaError(false);
  }, [payload?.url]);

  useEffect(() => {
    if (shareMode !== "private-link") {
      setPrivateLinkDetails(null);
    }
  }, [shareMode]);

  useEffect(() => {
    setShowRelayDetails(false);
  }, [shareMode]);

  const handlePrivateLinkCompletion = useCallback(
    (result: ShareCompletion) => {
      if (result.mode === "private-link") {
        if (result.success && result.link) {
          setPrivateLinkDetails({ link: result.link, alias: result.alias ?? null });
        } else {
          setPrivateLinkDetails(null);
        }
        if (!result.success) {
          onShareComplete?.(result);
        }
        return;
      }
      onShareComplete?.(result);
    },
    [onShareComplete],
  );

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
    ndk.pool.relays.forEach((relay: NDKRelay) => {
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

  const [relaySelections, setRelaySelections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setRelaySelections(prev => {
      let changed = false;
      const next: Record<string, boolean> = {};
      effectiveRelays.forEach(url => {
        if (prev[url] === undefined) changed = true;
        next[url] = prev[url] ?? true;
      });
      Object.keys(prev).forEach(url => {
        if (!effectiveRelays.includes(url)) changed = true;
      });
      if (!changed) {
        const prevKeys = Object.keys(prev);
        if (prevKeys.length !== effectiveRelays.length) changed = true;
      }
      return changed ? next : prev;
    });
  }, [effectiveRelays]);

  const selectedRelays = useMemo(
    () => effectiveRelays.filter(url => relaySelections[url] !== false),
    [effectiveRelays, relaySelections],
  );

  useEffect(() => {
    setRelayStatuses(prev => {
      let changed = false;
      const next: Record<string, RelayState> = {};
      selectedRelays.forEach(url => {
        if (prev[url]) {
          next[url] = prev[url];
        } else {
          changed = true;
        }
      });
      Object.keys(prev).forEach(url => {
        if (!selectedRelays.includes(url)) {
          changed = true;
        }
      });
      if (!changed) {
        if (Object.keys(prev).length !== Object.keys(next).length) {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedRelays]);

  useEffect(() => {
    if (selectedRelays.length > 0) {
      setGlobalError(prev => (prev === "Select at least one relay to share." ? null : prev));
    }
  }, [selectedRelays]);

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
    const source =
      profileInfo.displayName ?? profileInfo.username ?? profileInfo.nip05 ?? pubkey ?? null;
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
          const normalized = safeNormalizeRelayUrl(relayUrl, normalizeRelayUrlRef.current);
          const relay = normalized ? pool.relays.get(normalized) : undefined;
          if (!relay) {
            next[relayUrl] = { variant: "missing" };
          } else {
            next[relayUrl] = {
              variant: mapRelayStatus(relay.status as NDKRelayStatus | undefined, relayStatusEnum),
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
  }, [ndk, effectiveRelays, relayStatusEnum]);

  const usingFallbackRelays = preferredRelays.length === 0;
  const usingDefaultFallback = usingFallbackRelays && poolRelays.length === 0;

  useEffect(() => {
    if (embedded || !payload?.name) return;
    if (typeof document === "undefined") return;
    const originalTitle = document.title;
    const nextTitle =
      shareMode === "private-link"
        ? `Create private link – ${payload.name}`
        : `Share ${payload.name} – Bloom`;
    document.title = nextTitle;
    return () => {
      document.title = originalTitle;
    };
  }, [embedded, payload?.name, shareMode]);

  const successes = useMemo(
    () => selectedRelays.filter(url => relayStatuses[url]?.status === "success"),
    [relayStatuses, selectedRelays],
  );

  const failures = useMemo(
    () =>
      selectedRelays
        .filter(url => relayStatuses[url]?.status === "error")
        .map(url => ({ url, message: relayStatuses[url]?.message })),
    [relayStatuses, selectedRelays],
  );

  const allComplete = useMemo(() => {
    if (!publishing && Object.keys(relayStatuses).length === 0) return false;
    return selectedRelays.length > 0
      ? selectedRelays.every(url => {
          const status = relayStatuses[url]?.status;
          return status === "success" || status === "error";
        })
      : false;
  }, [selectedRelays, relayStatuses, publishing]);

  const handleShare = async () => {
    if (!payload?.url) {
      setGlobalError("Share link is missing.");
      return;
    }
    if (!ndk || !signer) {
      setGlobalError("Connect your NIP-07 signer to share.");
      return;
    }
    if (!pubkey) {
      setGlobalError("Unable to resolve your pubkey. Reconnect your signer and try again.");
      return;
    }
    const relays = selectedRelays;
    if (!relays.length) {
      setGlobalError(
        effectiveRelays.length === 0
          ? "No relays available. Update your profile with preferred relays and try again."
          : "Select at least one relay to share.",
      );
      return;
    }

    if (isDmMode && !selectedRecipient) {
      setGlobalError("Choose a DM recipient before sending.");
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
    const finalContent = composedContent || payload.url || "";
    const module = await ensureRuntime();
    const { NDKEvent, NDKRelaySet, NDKPublishError, NDKUser, giftWrap } = module;

    if (isLegacyDmMode) {
      if (!signer.encryptionEnabled || !signer.encryptionEnabled("nip04")) {
        setGlobalError("Connected signer does not support encrypted DMs (NIP-04).");
        setPublishing(false);
        return;
      }
      const recipientProfile = selectedRecipient!;
      const recipientUser = new NDKUser({ pubkey: recipientProfile.pubkey });
      const dmEvent = new NDKEvent(ndk);
      dmEvent.kind = 4;
      dmEvent.created_at = createdAt;
      dmEvent.tags = [["p", recipientProfile.pubkey]];
      dmEvent.content = finalContent;
      dmEvent.pubkey = pubkey;

      try {
        await dmEvent.encrypt(recipientUser, signer, "nip04");
        await dmEvent.sign(signer);
        let dmSuccessCount = 0;
        let dmFailureCount = 0;

        for (const relayUrl of relays) {
          try {
            const relaySet = NDKRelaySet.fromRelayUrls([relayUrl], ndk);
            await dmEvent.publish(relaySet, 7000, 1);
            dmSuccessCount += 1;
            setRelayStatuses(prev => ({ ...prev, [relayUrl]: { status: "success" } }));
          } catch (error) {
            dmFailureCount += 1;
            let message = "Failed to send DM.";
            if (error instanceof NDKPublishError) {
              message = error.relayErrors || error.message;
            } else if (error instanceof Error) {
              message = error.message;
            }
            setRelayStatuses(prev => ({ ...prev, [relayUrl]: { status: "error", message } }));
          }
        }

        const dmResult: ShareCompletion = {
          mode: shareMode,
          success: dmSuccessCount > 0,
          recipient: {
            pubkey: recipientProfile.pubkey,
            npub: recipientProfile.npub,
            displayName: recipientProfile.displayName,
            username: recipientProfile.username,
            nip05: recipientProfile.nip05,
          },
          successes: dmSuccessCount,
          failures: dmFailureCount,
          message:
            dmFailureCount > 0 && dmSuccessCount > 0
              ? `${dmFailureCount} relay${dmFailureCount === 1 ? "" : "s"} reported errors.`
              : dmSuccessCount === 0
                ? "All relay deliveries failed."
                : null,
        };

        const nextRecent = [
          recipientProfile,
          ...recentRecipients.filter(item => item.pubkey !== recipientProfile.pubkey),
        ].slice(0, 10);
        setRecentRecipients(nextRecent);
        storeRecipients(nextRecent);
        onShareComplete?.(dmResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sending DM failed.";
        setGlobalError(message);
        onShareComplete?.({
          mode: shareMode,
          success: false,
          recipient: {
            pubkey: recipientProfile.pubkey,
            npub: recipientProfile.npub,
            displayName: recipientProfile.displayName,
            username: recipientProfile.username,
            nip05: recipientProfile.nip05,
          },
          successes: 0,
          failures: relays.length,
          message,
        });
      } finally {
        setPublishing(false);
      }
    } else if (isPrivateDmMode) {
      if (!signer.encryptionEnabled || !signer.encryptionEnabled("nip44")) {
        setGlobalError("Connected signer does not support encrypted DMs (NIP-44).");
        setPublishing(false);
        return;
      }
      const recipientProfile = selectedRecipient!;
      const recipientUser = new NDKUser({ pubkey: recipientProfile.pubkey });
      const senderUser = new NDKUser({ pubkey });
      const rumorEvent = new NDKEvent(ndk);
      rumorEvent.kind = 14;
      rumorEvent.created_at = createdAt;
      rumorEvent.tags = [["p", recipientProfile.pubkey]];
      rumorEvent.content = finalContent;
      rumorEvent.pubkey = pubkey;

      try {
        const wrapForRecipient = await giftWrap(rumorEvent, recipientUser, signer);
        const wrapForSender = await giftWrap(rumorEvent, senderUser, signer);
        let dmSuccessCount = 0;
        let dmFailureCount = 0;

        for (const relayUrl of relays) {
          try {
            const relaySet = NDKRelaySet.fromRelayUrls([relayUrl], ndk);
            await wrapForRecipient.publish(relaySet, 7000, 1);
            await wrapForSender.publish(relaySet, 7000, 1);
            dmSuccessCount += 1;
            setRelayStatuses(prev => ({ ...prev, [relayUrl]: { status: "success" } }));
          } catch (error) {
            dmFailureCount += 1;
            let message = "Failed to send DM.";
            if (error instanceof NDKPublishError) {
              message = error.relayErrors || error.message;
            } else if (error instanceof Error) {
              message = error.message;
            }
            setRelayStatuses(prev => ({ ...prev, [relayUrl]: { status: "error", message } }));
          }
        }

        const dmResult: ShareCompletion = {
          mode: shareMode,
          success: dmSuccessCount > 0,
          recipient: {
            pubkey: recipientProfile.pubkey,
            npub: recipientProfile.npub,
            displayName: recipientProfile.displayName,
            username: recipientProfile.username,
            nip05: recipientProfile.nip05,
          },
          successes: dmSuccessCount,
          failures: dmFailureCount,
          message:
            dmFailureCount > 0 && dmSuccessCount > 0
              ? `${dmFailureCount} relay${dmFailureCount === 1 ? "" : "s"} reported errors.`
              : dmSuccessCount === 0
                ? "All relay deliveries failed."
                : null,
        };

        const nextRecent = [
          recipientProfile,
          ...recentRecipients.filter(item => item.pubkey !== recipientProfile.pubkey),
        ].slice(0, 10);
        setRecentRecipients(nextRecent);
        storeRecipients(nextRecent);
        onShareComplete?.(dmResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sending DM failed.";
        setGlobalError(message);
        onShareComplete?.({
          mode: shareMode,
          success: false,
          recipient: {
            pubkey: recipientProfile.pubkey,
            npub: recipientProfile.npub,
            displayName: recipientProfile.displayName,
            username: recipientProfile.username,
            nip05: recipientProfile.nip05,
          },
          successes: 0,
          failures: relays.length,
          message,
        });
      } finally {
        setPublishing(false);
      }
    } else {
      for (const relayUrl of relays) {
        try {
          const event = new NDKEvent(ndk, {
            kind: 1,
            content: finalContent,
            tags: [],
            created_at: createdAt,
          });
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
    }
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
      if (publishState.status === "pending")
        return <span className="text-amber-300">Publishing…</span>;
      if (publishState.status === "success")
        return <span className="text-emerald-300">Published</span>;
      if (publishState.status === "error")
        return (
          <span className="text-red-400">
            Error{publishState.message ? `: ${publishState.message}` : ""}
          </span>
        );
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
          className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          <CloseIcon className="h-4 w-4" />
          <span>Close</span>
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

  const contentUnavailable = payloadError
    ? renderUnavailable(payloadError)
    : !payload
      ? renderLoading()
      : null;

  const renderPrivateLinkComposer = () => {
    const containerClasses = embedded
      ? "flex flex-1 min-h-0 w-full overflow-hidden text-slate-100"
      : "min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6";

    if (contentUnavailable) {
      return <div className={containerClasses}>{contentUnavailable}</div>;
    }

    if (!payload) {
      return <div className={containerClasses}>{renderLoading()}</div>;
    }

    const data = payload;

    const infoCardClass = isLightTheme
      ? "rounded-2xl border border-slate-200 bg-white/95 p-6 text-slate-700 shadow"
      : "rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-slate-200 shadow-lg";
    const infoLabelClass = "text-xs uppercase tracking-wide text-slate-500";
    const infoNameClass = isLightTheme
      ? "text-lg font-semibold text-slate-900"
      : "text-lg font-semibold text-slate-100";
    const infoMetaClass = isLightTheme ? "text-xs text-slate-500" : "text-xs text-slate-400";
    const infoHashClass = isLightTheme
      ? "font-mono text-[11px] text-slate-600"
      : "font-mono text-[11px] text-slate-300";
    const urlPanelClass = isLightTheme
      ? "mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600"
      : "mt-4 rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-xs text-slate-300";
    const urlAnchorClass = isLightTheme
      ? "mt-1 block truncate font-mono text-[11px] text-emerald-600 hover:text-emerald-500"
      : "mt-1 block truncate font-mono text-[11px] text-emerald-300 hover:text-emerald-200";
    const previewContainerClass = isLightTheme
      ? "mt-5 overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
      : "mt-5 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70";
    const previewFallbackClass = isLightTheme
      ? "p-6 text-sm text-slate-600"
      : "p-6 text-sm text-slate-300";

    let privateMediaType: "image" | "video" | null = null;
    if (!mediaError && data.url) {
      const source = (() => {
        try {
          return new URL(data.url).pathname.toLowerCase();
        } catch {
          return data.url.toLowerCase();
        }
      })();
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(source)) {
        privateMediaType = "image";
      } else if (/\.(mp4|webm|ogg|mov|m4v)$/.test(source)) {
        privateMediaType = "video";
      }
    }

    const mediaPreview =
      privateMediaType === "image" ? (
        <img
          src={data.url}
          alt={data.name ? `Preview of ${data.name}` : "Shared media preview"}
          className="w-full max-h-[300px] object-contain"
          onError={() => setMediaError(true)}
        />
      ) : privateMediaType === "video" ? (
        <video
          src={data.url}
          controls
          className="h-full w-full bg-black"
          onError={() => setMediaError(true)}
        />
      ) : (
        <div className={previewFallbackClass}>
          <p>Preview is not available for this file type.</p>
          {data.url ? (
            <a href={data.url} target="_blank" rel="noreferrer" className={urlAnchorClass}>
              Open Blossom URL
            </a>
          ) : null}
        </div>
      );

    const previewContainerDynamicClass =
      privateMediaType === "image"
        ? `${previewContainerClass} max-h-[300px]`
        : previewContainerClass;
    const canSharePrivateLink = Boolean(privateLinkDetails?.link && onShareLinkRequest);
    const shareButtonBaseClass =
      "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition";
    const shareButtonClass = shareButtonBaseClass.concat(
      canSharePrivateLink
        ? isLightTheme
          ? " border border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500"
          : " border border-emerald-400 bg-emerald-600/90 text-white hover:bg-emerald-500"
        : isLightTheme
          ? " border border-slate-300 bg-slate-200 text-slate-500 cursor-not-allowed"
          : " border border-slate-700 bg-slate-800 text-slate-500 cursor-not-allowed",
    );
    const closeButtonClass = isLightTheme
      ? "inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 hover:text-slate-900"
      : "inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-600";

    const handleShareButtonClick = () => {
      if (!privateLinkDetails?.link || !onShareLinkRequest) return;
      const sharePayload: SharePayload = {
        url: privateLinkDetails.link,
        name: data.name ?? null,
        sha256: data.sha256 ?? null,
        serverUrl: data.serverUrl ?? null,
        size: typeof data.size === "number" ? data.size : null,
      };
      onShareLinkRequest(sharePayload, { mode: "note" });
    };

    return (
      <div className={containerClasses}>
        <div className="flex flex-1 min-h-0 w-full flex-col gap-6 py-2">
          <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <PrivateLinkPanel
              payload={data}
              onShareComplete={handlePrivateLinkCompletion}
              links={privateLinkState}
              tone={isLightTheme ? "light" : "dark"}
              className={
                isLightTheme
                  ? "rounded-2xl border border-slate-200 bg-white p-6"
                  : "rounded-2xl border border-slate-800 bg-slate-900/80 p-6"
              }
            />
            <section className={infoCardClass}>
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className={infoLabelClass}>File summary</div>
                  <div className={infoNameClass}>{data.name ?? "Unnamed file"}</div>
                  {typeof data.size === "number" && Number.isFinite(data.size) ? (
                    <div className={infoMetaClass}>
                      Size: {prettyBytes(Math.max(0, Math.round(data.size)))}
                    </div>
                  ) : null}
                  {data.sha256 ? (
                    <div className={infoMetaClass}>
                      SHA-256: <span className={infoHashClass}>{data.sha256}</span>
                    </div>
                  ) : null}
                </div>
                {data.url ? (
                  <div className={urlPanelClass}>
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">
                      Blossom URL
                    </div>
                    <a href={data.url} target="_blank" rel="noreferrer" className={urlAnchorClass}>
                      {data.url}
                    </a>
                  </div>
                ) : null}
              </div>
              <div className={previewContainerDynamicClass}>{mediaPreview}</div>
              {!privateLinkState.serviceConfigured && (
                <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                  Configure{" "}
                  <code className="font-mono text-xs text-amber-100">
                    VITE_PRIVATE_LINK_SERVICE_PUBKEY
                  </code>{" "}
                  to enable private links.
                </div>
              )}
              {privateLinkState.serviceConfigured && !canSharePrivateLink ? (
                <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                  Share controls unlock once a private link is created.
                </div>
              ) : null}
              <div className="mt-6 flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={handleShareButtonClick}
                  className={shareButtonClass}
                  disabled={!canSharePrivateLink}
                >
                  <ShareIcon size={16} className="shrink-0" />
                  <span>Share</span>
                </button>
                <button type="button" onClick={handleClose} className={closeButtonClass}>
                  <CloseIcon className="h-4 w-4" />
                  <span>Close</span>
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  };

  if (shareMode === "private-link") {
    return renderPrivateLinkComposer();
  }

  const containerClasses = embedded
    ? "flex flex-1 min-h-0 w-full overflow-hidden text-slate-100"
    : "min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6";

  const wrapperClasses = embedded
    ? "flex flex-1 min-h-0 w-full flex-col lg:flex-row gap-6 p-2"
    : "flex flex-1 min-h-0 w-full max-w-5xl flex-col lg:flex-row gap-6 mx-auto";

  const shareCardClasses =
    "flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-lg";
  const previewCardClasses = `hidden lg:flex lg:w-1/2 flex-col rounded-2xl border ${
    isLightTheme
      ? "border-slate-200 bg-white text-slate-700"
      : "border-slate-800 bg-slate-900/70 text-slate-100"
  }`;
  const previewTitleClass = isLightTheme
    ? "text-xl font-semibold text-slate-900"
    : "text-xl font-semibold text-slate-100";
  const previewMessageCardClass = isLightTheme
    ? "rounded-xl border border-slate-200 bg-slate-50 p-5"
    : "rounded-xl border border-slate-800 bg-slate-950/70 p-5";
  const previewAvatarClass = isLightTheme
    ? "flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-sm font-semibold text-slate-600"
    : "flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-slate-800 text-sm font-semibold text-slate-300";
  const previewDisplayNameClass = isLightTheme
    ? "truncate text-sm font-semibold text-slate-900"
    : "truncate text-sm font-semibold text-slate-100";
  const previewHandleClass = isLightTheme
    ? "truncate text-xs text-slate-500"
    : "truncate text-xs text-slate-500";
  const previewNoteTextClass = isLightTheme
    ? "whitespace-pre-wrap break-words text-sm text-slate-800"
    : "whitespace-pre-wrap break-words text-sm text-slate-100";
  const previewPlaceholderClass = isLightTheme ? "text-slate-500" : "text-slate-500";
  const previewMediaContainerClass = isLightTheme
    ? "flex max-h-72 w-full items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
    : "flex max-h-72 w-full items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/80";
  const previewActionCircleClass = isLightTheme
    ? "flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-500"
    : "flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/60 text-slate-300";
  const relayOptionBaseClass = "flex items-center gap-3";
  const relayCheckboxClass = isLightTheme
    ? "mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
    : "mt-1 h-4 w-4 rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500";
  const relayUrlTextClass = isLightTheme
    ? "font-mono text-[11px] text-slate-700 sm:text-xs"
    : "font-mono text-[11px] text-slate-200 sm:text-xs";
  const relaySelectionHintClass = isLightTheme ? "text-xs text-red-500" : "text-xs text-red-300";
  const relayStatusWrapperClass = isLightTheme
    ? "flex items-center gap-2 text-xs text-slate-500"
    : "flex items-center gap-2 text-xs text-slate-400";

  const shareAppendix = useMemo(() => {
    if (!payload) return null;
    if (isDmMode) return buildMetadataBlock(payload);
    return payload.url ?? null;
  }, [payload, isDmMode]);

  const composedContent = useMemo(
    () => combineContent(noteContent, shareAppendix),
    [noteContent, shareAppendix],
  );

  const previewNote = composedContent.trim().length > 0 ? composedContent : "";
  const mediaSourcePath = useMemo(() => {
    if (!payload?.url) return "";
    try {
      return new URL(payload.url).pathname.toLowerCase();
    } catch {
      return payload.url.toLowerCase();
    }
  }, [payload?.url]);
  const isImage = useMemo(
    () => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(mediaSourcePath),
    [mediaSourcePath],
  );
  const isVideo = useMemo(
    () => /\.(mp4|webm|ogg|mov|m4v)$/.test(mediaSourcePath),
    [mediaSourcePath],
  );
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

  const shareButtonLabel = publishing
    ? isDmMode
      ? "Sending…"
      : "Publishing…"
    : isDmMode
      ? "Send DM"
      : "Publish note";
  const ShareActionIcon = isDmMode ? SendIcon : NoteIcon;

  const baseRelayLabel = isDmMode
    ? "Using connected relays"
    : usingFallbackRelays
      ? usingDefaultFallback
        ? "Using default Bloom relays"
        : "Using connected relays"
      : "Your preferred relays";
  const relayLabelSuffix =
    effectiveRelays.length > 0 ? ` (${selectedRelays.length}/${effectiveRelays.length})` : "";
  const relayLabel = `${baseRelayLabel}${relayLabelSuffix}`;
  const RelayIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M5.05 5.05a10 10 0 0 1 0 13.9" />
      <path d="M18.95 5.05a10 10 0 0 0 0 13.9" />
    </svg>
  );
  return (
    <div className={containerClasses}>
      <div className={wrapperClasses}>
        <div className="flex w-full min-h-0 lg:w-1/2">
          <div className={`${shareCardClasses} ${embedded ? "p-4 sm:p-6" : "p-6"}`}>
            <header className="space-y-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <h1 className="text-xl font-semibold text-slate-100">Share Composer</h1>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex rounded-2xl border border-slate-800 bg-slate-900/70 p-1 text-xs">
                  <button
                    type="button"
                    className={`rounded-xl px-3 py-1 font-medium transition-colors ${
                      shareMode === "note"
                        ? "bg-emerald-600 text-white shadow"
                        : "text-slate-300 hover:text-white"
                    }`}
                    onClick={() => setShareMode("note")}
                    disabled={publishing}
                  >
                    Public note
                  </button>
                  <button
                    type="button"
                    className={`rounded-xl px-3 py-1 font-medium transition-colors ${
                      isLegacyDmMode
                        ? "bg-emerald-600 text-white shadow"
                        : "text-slate-300 hover:text-white"
                    }`}
                    onClick={() => setShareMode("dm")}
                    disabled={publishing}
                  >
                    DM (NIP-04)
                  </button>
                  <button
                    type="button"
                    className={`rounded-xl px-3 py-1 font-medium transition-colors ${
                      isPrivateDmMode
                        ? "bg-emerald-600 text-white shadow"
                        : "text-slate-300 hover:text-white"
                    }`}
                    onClick={() => setShareMode("dm-private")}
                    disabled={publishing}
                  >
                    Private DM (NIP-17)
                  </button>
                </div>
                <span className="w-full text-xs text-slate-400">
                  {shareMode === "note"
                    ? "Publish a public note with a share link to your file directly to Nostr."
                    : ""}
                </span>
              </div>
            </header>

            <div className="flex-1 overflow-auto pr-1">
              {isDmMode && (
                <section className="space-y-3 mb-[7px]">
                  <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {isSearchingRecipients && <span className="text-emerald-300">Searching…</span>}
                  </div>
                  <div className="relative">
                    <input
                      id="share-dm-recipient"
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      placeholder="Paste npub, hex, or @name@domain"
                      value={recipientQuery}
                      onChange={event => handleRecipientInputChange(event.target.value)}
                      disabled={publishing}
                      autoComplete="off"
                    />
                    {recipientQuery && (
                      <button
                        type="button"
                        onClick={handleClearRecipient}
                        className="absolute inset-y-0 right-2 flex items-center text-xs text-slate-500 hover:text-slate-300"
                        aria-label="Clear recipient"
                        disabled={publishing}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {recipientError && !isSearchingRecipients && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      {recipientError}
                    </div>
                  )}
                  {recipientResults.length > 0 && (
                    <ul className="max-h-48 space-y-2 overflow-auto rounded-xl border border-slate-800 bg-slate-950/80 p-2 text-sm">
                      {recipientResults.map(result => {
                        const display =
                          result.displayName || result.username || result.nip05 || result.npub;
                        const handle =
                          result.nip05 || (result.username ? `@${result.username}` : result.npub);
                        const initials = computeInitials(display);
                        const isActive = selectedRecipient?.pubkey === result.pubkey;
                        return (
                          <li key={`${result.pubkey}-${result.origin}`}>
                            <button
                              type="button"
                              onClick={() => handleRecipientSelect(result)}
                              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                                isActive
                                  ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-100"
                                  : "border-transparent bg-slate-900/60 text-slate-200 hover:border-slate-700 hover:bg-slate-900"
                              }`}
                              disabled={publishing}
                            >
                              <div className="flex items-center gap-3">
                                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-800 text-xs font-semibold">
                                  {result.picture ? (
                                    <img
                                      src={result.picture}
                                      alt={`${display}'s avatar`}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <span>{initials}</span>
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium">{display}</div>
                                  <div className="truncate text-xs text-slate-400">{handle}</div>
                                </div>
                                <span className="text-[10px] uppercase text-slate-500">
                                  {result.origin}
                                </span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {selectedRecipient && (
                    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                      Sending to{" "}
                      {selectedRecipient.displayName ||
                        selectedRecipient.username ||
                        selectedRecipient.nip05 ||
                        selectedRecipient.npub}
                    </div>
                  )}
                </section>
              )}

              <section className={`space-y-[7px] ${isDmMode ? "" : "mt-6"}`}>
                {isLegacyDmMode && (
                  <div className="text-xs text-slate-400">
                    Send a DM with file summary and download details to another user.
                  </div>
                )}
                {isPrivateDmMode && (
                  <div className="text-xs text-slate-400">
                    Send an encrypted DM with file summary and download details. NOTE: Not all Nostr
                    clients support private DMs. If you're unsure, please choose Share via DM
                    instead.
                  </div>
                )}
                <textarea
                  id="share-note"
                  className="min-h-[160px] w-full resize-none rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  placeholder={
                    isDmMode
                      ? "Add a message to include with the DM…"
                      : "Write something about this file…"
                  }
                  value={noteContent}
                  onChange={event => setNoteContent(event.target.value)}
                  disabled={publishing}
                />
              </section>

              <section className="mt-[7px] space-y-1">
                <button
                  type="button"
                  onClick={() => setShowRelayDetails(value => !value)}
                  className="flex w-full items-center justify-between text-left text-xs tracking-wide text-slate-400 rounded-md border border-transparent px-2 py-1 hover:border-slate-700 hover:text-slate-200"
                >
                  <span className="flex items-center gap-2">
                    <RelayIcon className="h-3 w-3" />
                    <span>{relayLabel}</span>
                    {!metadataLoaded && (
                      <span className="text-[10px] text-slate-500">Loading…</span>
                    )}
                  </span>
                  <svg
                    className={`h-3 w-3 transition-transform ${showRelayDetails ? "rotate-180" : ""}`}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                {showRelayDetails && (
                  <>
                    {metadataError && (
                      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        {metadataError}
                      </div>
                    )}
                    <ul className="space-y-2">
                      {effectiveRelays.map(url => {
                        const checked = relaySelections[url] !== false;
                        return (
                          <li key={url}>
                            <label
                              className={`${relayOptionBaseClass} ${publishing ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                            >
                              <input
                                type="checkbox"
                                className={relayCheckboxClass}
                                checked={checked}
                                onChange={() =>
                                  setRelaySelections(prev => ({
                                    ...prev,
                                    [url]: !checked,
                                  }))
                                }
                                disabled={publishing}
                              />
                              <div className="flex flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                <span className={relayUrlTextClass}>{url}</span>
                                <span className={relayStatusWrapperClass}>
                                  {renderRelayStatus(url)}
                                </span>
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {selectedRelays.length === 0 && (
                      <p className={relaySelectionHintClass}>
                        Select at least one relay before sharing.
                      </p>
                    )}
                  </>
                )}
              </section>

              <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleShare}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={
                    publishing ||
                    !data.url ||
                    (isDmMode && !selectedRecipient) ||
                    selectedRelays.length === 0
                  }
                >
                  <ShareActionIcon className="h-4 w-4" />
                  <span>{shareButtonLabel}</span>
                </button>
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
              </div>

              {globalError && (
                <div className="mt-4 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {globalError}
                </div>
              )}

              {allComplete && (
                <div className="mt-3 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                  {failures.length === 0
                    ? `${isDmMode ? "Successfully delivered" : "Successfully published"} to ${successes.length} relay${
                        successes.length === 1 ? "" : "s"
                      }.`
                    : `${isDmMode ? "Delivered" : "Published"} to ${successes.length} relay${
                        successes.length === 1 ? "" : "s"
                      }. ${failures.length} ${isDmMode ? "delivery" : "publish"} failure${
                        failures.length === 1 ? "" : "s"
                      }.`}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className={previewCardClasses}>
          <div className="flex flex-col gap-5 p-5">
            <div>
              <h1 className={previewTitleClass}>
                {shareMode === "note"
                  ? "Note Preview"
                  : isPrivateDmMode
                    ? "Private DM Preview"
                    : "DM Preview"}
              </h1>
            </div>

            <div className="flex-1 overflow-auto">
              <div className={`${previewMessageCardClass} min-h-[250px] flex flex-col`}>
                <div className="flex flex-col gap-5">
                  <div className="flex items-start gap-4">
                    <div className={previewAvatarClass}>
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
                      <span className={previewDisplayNameClass}>{previewDisplayName}</span>
                      <span className={previewHandleClass}>{previewHandle}</span>
                    </div>
                  </div>
                  <div className={previewNoteTextClass}>
                    {previewNote ? (
                      previewNote
                    ) : (
                      <span className={previewPlaceholderClass}>Start typing to add a note…</span>
                    )}
                  </div>
                  <div className={previewMediaContainerClass}>
                    {mediaType === "image" ? (
                      <img
                        src={payload?.url}
                        alt={payload?.name ? `Preview of ${payload.name}` : "Shared media preview"}
                        className="h-full w-full object-contain"
                        onError={() => setMediaError(true)}
                      />
                    ) : mediaType === "video" ? (
                      <video
                        className="h-full w-full"
                        src={payload?.url}
                        controls
                        onError={() => setMediaError(true)}
                      />
                    ) : payload?.url ? (
                      <a
                        href={payload.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-emerald-400 hover:text-emerald-300"
                      >
                        View shared file
                      </a>
                    ) : (
                      <span className="text-sm text-slate-500">
                        File preview will appear here once available.
                      </span>
                    )}
                  </div>
                  {shareMode === "note" && (
                    <div className="flex items-center justify-between pt-1 text-slate-500">
                      {PREVIEW_ACTIONS.map(action => (
                        <span
                          key={action.key}
                          className={previewActionCircleClass}
                          title={action.label}
                        >
                          <action.icon className="h-4 w-4" />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end px-5 pb-5">
            <button
              type="button"
              onClick={handleClose}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-600"
            >
              <CloseIcon className="h-3 w-3" />
              <span>Close</span>
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
};
