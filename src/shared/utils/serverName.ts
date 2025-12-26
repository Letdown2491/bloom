/**
 * Derive a server name from a URL by extracting the hostname.
 */
export const deriveServerNameFromUrl = (rawUrl: string): string => {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).hostname;
  } catch {
    try {
      return new URL(`https://${rawUrl}`).hostname;
    } catch {
      return "";
    }
  }
};
