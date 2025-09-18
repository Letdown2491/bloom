const IGNORED_SUBDOMAIN_PREFIXES = new Set([
  "www",
  "cdn",
  "relay",
  "blossom",
]);

const GENERIC_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "app",
  "co",
  "me",
  "dev",
  "xyz",
  "info",
  "biz",
]);

const GENERIC_MULTI_PART_TLDS = new Set([
  "co.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.ar",
  "com.mx",
  "com.co",
  "co.jp",
  "co.kr",
  "co.in",
  "com.sg",
  "com.tw",
]);

const ensureHostname = (rawUrl: string): string | null => {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname;
  } catch (_error) {
    try {
      return new URL(`https://${rawUrl}`).hostname;
    } catch (_nestedError) {
      return null;
    }
  }
};

const capitalizeWord = (word: string): string => {
  if (!word) return word;
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

/**
 * Derive a human-friendly server name from a URL.
 */
export const deriveServerNameFromUrl = (rawUrl: string): string => {
  const hostname = ensureHostname(rawUrl);
  if (!hostname) {
    return "";
  }

  const originalSegments = hostname.split(".").filter(Boolean).map(segment => segment.toLowerCase());
  if (!originalSegments.length) {
    return hostname;
  }

  const segments = [...originalSegments];
  while (segments.length > 1) {
    const firstSegment = segments[0];
    if (!firstSegment || !IGNORED_SUBDOMAIN_PREFIXES.has(firstSegment)) break;
    segments.shift();
  }

  let coreSegments = [...segments];
  if (coreSegments.length > 2) {
    const lastTwo = coreSegments.slice(-2).join(".");
    if (GENERIC_MULTI_PART_TLDS.has(lastTwo)) {
      coreSegments = coreSegments.slice(0, -2);
    }
  }

  if (coreSegments.length > 1) {
    const last = coreSegments[coreSegments.length - 1];
    if (last && GENERIC_TLDS.has(last)) {
      coreSegments = coreSegments.slice(0, -1);
    }
  }

  if (!coreSegments.length) {
    coreSegments = [...segments];
  }

  const words = coreSegments
    .flatMap(segment => segment.split(/[-_]/g))
    .filter(Boolean);

  if (!words.length) {
    return hostname;
  }

  return words.map(capitalizeWord).join(" ");
};
