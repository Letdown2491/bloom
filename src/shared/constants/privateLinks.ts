const DEFAULT_HOST = "https://bloomapp.me";

const rawHost = typeof import.meta.env.VITE_PRIVATE_LINK_SERVICE_HOST === "string"
  ? import.meta.env.VITE_PRIVATE_LINK_SERVICE_HOST.trim()
  : "";

const rawPubkey = typeof import.meta.env.VITE_PRIVATE_LINK_SERVICE_PUBKEY === "string"
  ? import.meta.env.VITE_PRIVATE_LINK_SERVICE_PUBKEY.trim()
  : "";

const normalizeHost = (value: string): string => {
  if (!value) return DEFAULT_HOST;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    const trimmed = value.trim();
    if (!trimmed) return DEFAULT_HOST;
    if (!/^https?:\/\//i.test(trimmed)) {
      return `https://${trimmed.replace(/^\/*/, "").replace(/\/$/, "")}`;
    }
    return trimmed.replace(/\/$/, "");
  }
};

const sanitizeHex = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalized)) {
    return normalized;
  }
  return "";
};

export const PRIVATE_LINK_EVENT_KIND = 30001;

export const PRIVATE_LINK_SERVICE_HOST = normalizeHost(rawHost);

export const PRIVATE_LINK_SERVICE_PUBKEY = sanitizeHex(rawPubkey);

export const isPrivateLinkServiceConfigured = () => PRIVATE_LINK_SERVICE_PUBKEY.length === 64;

export const DEFAULT_PRIVATE_LINK_HOST = DEFAULT_HOST;

export const PRIVATE_LINK_REQUIRED_RELAY = "wss://relay.primal.net";
