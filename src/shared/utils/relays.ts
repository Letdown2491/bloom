const FALLBACK_RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.nsec.app",
] as const;

export const DEFAULT_PUBLIC_RELAYS: readonly string[] = FALLBACK_RELAYS;

export const sanitizeRelayUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/$/, "");
  if (!/^wss?:\/\//i.test(normalized)) return null;
  return normalized;
};

export const normalizeRelayUrls = (
  relays: readonly (string | null | undefined)[] | null | undefined
): string[] => {
  if (!relays || relays.length === 0) return [];
  const normalized = new Set<string>();
  relays.forEach(url => {
    const sanitized = sanitizeRelayUrl(url);
    if (sanitized) {
      normalized.add(sanitized);
    }
  });
  return Array.from(normalized);
};

export const collectRelayTargets = (
  relays: readonly (string | null | undefined)[] | null | undefined,
  fallback: readonly string[] = DEFAULT_PUBLIC_RELAYS
): string[] => {
  const normalized = normalizeRelayUrls(relays);
  if (normalized.length > 0) {
    return normalized;
  }
  return normalizeRelayUrls(fallback) ?? [];
};

export const extractPreferredRelays = (metadata: unknown): string[] => {
  if (!metadata || typeof metadata !== "object") return [];
  const urls = new Set<string>();
  const record = metadata as Record<string, unknown>;

  const relaysField = record.relays;
  if (relaysField && typeof relaysField === "object") {
    Object.entries(relaysField as Record<string, unknown>).forEach(([rawUrl, config]) => {
      const url = sanitizeRelayUrl(rawUrl);
      if (!url) return;
      if (config === true || config === undefined || config === null) {
        urls.add(url);
        return;
      }
      if (typeof config === "object" && config) {
        const writeFlag = (config as Record<string, unknown>).write;
        if (writeFlag === false) return;
        urls.add(url);
        return;
      }
      if (config === "write") {
        urls.add(url);
      }
    });
  }

  const candidateArrays: unknown[] = [
    record.writeRelays,
    record.preferredRelays,
    record.preferred_relays,
    record.write_relays,
  ];
  candidateArrays.forEach(entry => {
    if (!Array.isArray(entry)) return;
    entry.forEach(item => {
      const url = sanitizeRelayUrl(item);
      if (url) urls.add(url);
    });
  });

  const candidateStrings: unknown[] = [record.relay, record.relay_url, record.preferredRelay];
  candidateStrings.forEach(entry => {
    const url = sanitizeRelayUrl(entry);
    if (url) urls.add(url);
  });

  return Array.from(urls);
};

export const normalizeRelayOrigin = (url: string | undefined | null): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (_error) {
    return sanitizeRelayUrl(url);
  }
};
