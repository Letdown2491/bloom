const WARN_THRESHOLD_BYTES = 3 * 1024 * 1024; // ~3MB
const CRITICAL_THRESHOLD_BYTES = 4.5 * 1024 * 1024; // ~4.5MB

export type QuotaStatus = "normal" | "warn" | "critical";

const KB = 1024;
const MB = KB * 1024;

const clampNumber = (value: number) => (Number.isFinite(value) ? value : 0);

export const estimateLocalStorageUsage = (): number => {
  if (typeof window === "undefined" || !window.localStorage) return 0;
  let total = 0;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      const value = window.localStorage.getItem(key) ?? "";
      total += key.length + value.length;
    }
  } catch (error) {
    // Some browsers throw when storage is inaccessible; fall back to zero.
    return 0;
  }
  return total;
};

export const estimateEntryBytes = (key: string, value: string | null | undefined): number => {
  return key.length + (value?.length ?? 0);
};

const classifyQuotaStatus = (bytes: number): QuotaStatus => {
  if (bytes >= CRITICAL_THRESHOLD_BYTES) return "critical";
  if (bytes >= WARN_THRESHOLD_BYTES) return "warn";
  return "normal";
};

export const formatBytes = (bytes: number): string => {
  const normalized = clampNumber(bytes);
  if (normalized >= MB) {
    return `${(normalized / MB).toFixed(2)}MB`;
  }
  if (normalized >= KB) {
    return `${(normalized / KB).toFixed(1)}KB`;
  }
  return `${normalized}B`;
};

export const checkLocalStorageQuota = (
  context: string,
  options?: { log?: boolean }
): { status: QuotaStatus; totalBytes: number } => {
  const totalBytes = estimateLocalStorageUsage();
  const status = classifyQuotaStatus(totalBytes);
  if (status !== "normal" && options?.log !== false) {
    const message = `[storage] localStorage usage ${status} (~${formatBytes(totalBytes)}) after ${context}`;
    if (status === "critical") {
      console.warn(message);
    } else {
      console.info(message);
    }
  }
  return { status, totalBytes };
};

export const LOCAL_STORAGE_WARN_THRESHOLD = WARN_THRESHOLD_BYTES;
export const LOCAL_STORAGE_CRITICAL_THRESHOLD = CRITICAL_THRESHOLD_BYTES;
