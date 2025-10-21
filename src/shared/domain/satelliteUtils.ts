const SATELLITE_API_HOST = "api.satellite.earth";
const SATELLITE_API_BASE_PATH = "/v1/media";

export const canonicalizeSatelliteApiBase = (rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;

  try {
    const parsed = new URL(trimmed);
    const host = parsed.host.toLowerCase();

    if (
      host === "cdn.satellite.earth" ||
      host === "satellite.earth" ||
      host === "www.satellite.earth"
    ) {
      return `https://${SATELLITE_API_HOST}${SATELLITE_API_BASE_PATH}`;
    }

    if (host === SATELLITE_API_HOST) {
      let path = parsed.pathname || "";
      if (!path || path === "/") {
        path = SATELLITE_API_BASE_PATH;
      } else if (path === "/v1") {
        path = SATELLITE_API_BASE_PATH;
      } else if (!path.startsWith("/v1/")) {
        path = SATELLITE_API_BASE_PATH;
      }
      return `https://${SATELLITE_API_HOST}${path.replace(/\/$/, "")}`;
    }

    return trimmed.replace(/\/$/, "");
  } catch {
    if (
      /^https?:\/\/cdn\.satellite\.earth/i.test(trimmed) ||
      /^https?:\/\/(www\.)?satellite\.earth\/?$/i.test(trimmed)
    ) {
      return `https://${SATELLITE_API_HOST}${SATELLITE_API_BASE_PATH}`;
    }
    return trimmed.replace(/\/$/, "");
  }
};
