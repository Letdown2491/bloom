const CACHE_NAME = "bloom:preview-cache:v1";
const LOCAL_STORAGE_PREFIX = "bloom:preview-cache:v1:";
const MAX_CACHE_BYTES = 4 * 1024 * 1024; // 4MB cap to avoid storing very large previews
const MAX_LOCAL_STORAGE_BYTES = 200 * 1024; // localStorage fallback cap (~200KB)

function normalizeServerKey(serverUrl?: string) {
  if (!serverUrl) return "default";
  return serverUrl.replace(/\/+$/, "");
}

function buildCacheKey(serverUrl: string | undefined, sha256: string) {
  if (!sha256) return null;
  const serverKey = normalizeServerKey(serverUrl);
  return `${serverKey}|${sha256}`;
}

function buildCacheRequest(key: string) {
  if (typeof window === "undefined") return null;
  let origin: string | undefined;
  try {
    origin = window.location?.origin;
  } catch (error) {
    origin = undefined;
  }
  if (!origin) return null;
  const url = new URL(`/__bloom-preview-cache/${encodeURIComponent(key)}`, origin);
  return new Request(url.toString(), { method: "GET" });
}

async function readFromLocalStorage(key: string): Promise<Blob | null> {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const response = await fetch(raw);
    if (!response.ok) return null;
    return await response.blob();
  } catch (error) {
    return null;
  }
}

async function writeToLocalStorage(key: string, blob: Blob) {
  if (typeof window === "undefined") return;
  if (blob.size === 0 || blob.size > MAX_LOCAL_STORAGE_BYTES) return;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") resolve(result);
        else reject(new Error("Failed to encode preview"));
      };
      reader.readAsDataURL(blob);
    });
    window.localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, dataUrl);
  } catch (error) {
    try {
      window.localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    } catch (cleanupError) {
      // Ignore cleanup errors.
    }
  }
}

async function readFromCacheStorage(key: string): Promise<Blob | null> {
  if (typeof window === "undefined" || !("caches" in window)) return null;
  try {
    const request = buildCacheRequest(key);
    if (!request) return null;
    const cache = await window.caches.open(CACHE_NAME);
    const match = await cache.match(request);
    if (!match) return null;
    return await match.blob();
  } catch (error) {
    return null;
  }
}

async function writeToCacheStorage(key: string, blob: Blob) {
  if (typeof window === "undefined" || !("caches" in window)) return;
  if (blob.size === 0 || blob.size > MAX_CACHE_BYTES) return;
  try {
    const request = buildCacheRequest(key);
    if (!request) return;
    const cache = await window.caches.open(CACHE_NAME);
    const headers = new Headers();
    if (blob.type) headers.set("Content-Type", blob.type);
    headers.set("Content-Length", String(blob.size));
    const response = new Response(blob.slice(0, MAX_CACHE_BYTES), {
      headers,
    });
    await cache.put(request, response);
  } catch (error) {
    // Swallow cache write errors (quota, private mode, etc.).
  }
}

export async function getCachedPreviewBlob(serverUrl: string | undefined, sha256: string) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return null;
  const cacheHit = await readFromCacheStorage(key);
  if (cacheHit) return cacheHit;
  return await readFromLocalStorage(key);
}

export async function cachePreviewBlob(serverUrl: string | undefined, sha256: string, blob: Blob) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return;
  if (!blob.type?.startsWith("image/")) return; // only cache image previews
  await writeToCacheStorage(key, blob);
  await writeToLocalStorage(key, blob);
}

export async function invalidateCachedPreview(serverUrl: string | undefined, sha256: string) {
  const key = buildCacheKey(serverUrl, sha256);
  if (!key) return;
  if (typeof window !== "undefined" && "caches" in window) {
    try {
      const request = buildCacheRequest(key);
      if (request) {
        const cache = await window.caches.open(CACHE_NAME);
        await cache.delete(request);
      }
    } catch (error) {
      // Ignore cache deletion errors.
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    } catch (error) {
      // Ignore localStorage deletion errors.
    }
  }
}
