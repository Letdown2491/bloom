import { getKv, getKvKeys } from "./cacheDb";
import { getManifestStats, type ManifestStats } from "./folderManifestStore";

const measureStringBytes = (text: string): number => {
  if (typeof Blob !== "undefined") {
    return new Blob([text]).size;
  }
  return text.length * 2;
};

const estimateSerializedBytes = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === "string") return measureStringBytes(value);
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    const json = JSON.stringify(value);
    if (json) {
      return measureStringBytes(json);
    }
  } catch (error) {
    // Ignore serialization failures and fall through to zero.
  }
  return 0;
};

export type CacheDbBucketId =
  | "previewInline"
  | "previewMeta"
  | "blobMetadata"
  | "serverSnapshots"
  | "other";

export type CacheDbBucketMetrics = {
  id: CacheDbBucketId;
  label: string;
  approxBytes: number;
  entryCount: number;
  stats: Array<{ label: string; value: string }>;
};

type CacheDbUsage = {
  totalBytes: number;
  buckets: CacheDbBucketMetrics[];
};

const createEmptyBuckets = () => ({
  previewInline: {
    id: "previewInline" as const,
    label: "Preview thumbnails (inline)",
    approxBytes: 0,
    entryCount: 0,
    stats: [] as Array<{ label: string; value: string }>,
    previewCount: 0,
  },
  previewMeta: {
    id: "previewMeta" as const,
    label: "Preview metadata",
    approxBytes: 0,
    entryCount: 0,
    stats: [] as Array<{ label: string; value: string }>,
    trackedPreviews: 0,
    version: null as number | null,
  },
  blobMetadata: {
    id: "blobMetadata" as const,
    label: "File metadata",
    approxBytes: 0,
    entryCount: 0,
    stats: [] as Array<{ label: string; value: string }>,
    serverCount: 0,
    fileCount: 0,
  },
  serverSnapshots: {
    id: "serverSnapshots" as const,
    label: "Server snapshots",
    approxBytes: 0,
    entryCount: 0,
    stats: [] as Array<{ label: string; value: string }>,
    blobCount: 0,
  },
  other: {
    id: "other" as const,
    label: "Other cached data",
    approxBytes: 0,
    entryCount: 0,
    stats: [] as Array<{ label: string; value: string }>,
  },
});

const finalizeBucketStats = (buckets: ReturnType<typeof createEmptyBuckets>): CacheDbBucketMetrics[] => {
  const list: CacheDbBucketMetrics[] = [];

  const previewInline = buckets.previewInline;
  previewInline.stats = [
    { label: "Entries", value: previewInline.entryCount.toString() },
  ];
  list.push({
    id: previewInline.id,
    label: previewInline.label,
    approxBytes: previewInline.approxBytes,
    entryCount: previewInline.entryCount,
    stats: previewInline.stats,
  });

  const previewMeta = buckets.previewMeta;
  previewMeta.stats = [
    { label: "Tracked previews", value: previewMeta.trackedPreviews.toString() },
    { label: "Schema version", value: previewMeta.version == null ? "—" : String(previewMeta.version) },
  ];
  list.push({
    id: previewMeta.id,
    label: previewMeta.label,
    approxBytes: previewMeta.approxBytes,
    entryCount: previewMeta.entryCount,
    stats: previewMeta.stats,
  });

  const blobMetadata = buckets.blobMetadata;
  blobMetadata.stats = [
    { label: "Servers tracked", value: blobMetadata.serverCount.toString() },
    { label: "Files cached", value: blobMetadata.fileCount.toString() },
  ];
  list.push({
    id: blobMetadata.id,
    label: blobMetadata.label,
    approxBytes: blobMetadata.approxBytes,
    entryCount: blobMetadata.entryCount,
    stats: blobMetadata.stats,
  });

  const serverSnapshots = buckets.serverSnapshots;
  serverSnapshots.stats = [
    { label: "Servers cached", value: serverSnapshots.entryCount.toString() },
    { label: "Blobs cached", value: serverSnapshots.blobCount.toString() },
  ];
  list.push({
    id: serverSnapshots.id,
    label: serverSnapshots.label,
    approxBytes: serverSnapshots.approxBytes,
    entryCount: serverSnapshots.entryCount,
    stats: serverSnapshots.stats,
  });

  const other = buckets.other;
  other.stats = [
    { label: "Entries", value: other.entryCount.toString() },
  ];
  list.push({
    id: other.id,
    label: other.label,
    approxBytes: other.approxBytes,
    entryCount: other.entryCount,
    stats: other.stats,
  });

  return list;
};

const measureCacheDbUsage = async (): Promise<CacheDbUsage> => {
  if (typeof indexedDB === "undefined") {
    return { totalBytes: 0, buckets: finalizeBucketStats(createEmptyBuckets()) };
  }

  const buckets = createEmptyBuckets();
  let totalBytes = 0;

  let keys: string[] = [];
  try {
    keys = await getKvKeys();
  } catch (error) {
    keys = [];
  }

  await Promise.all(
    keys.map(async key => {
      let value: unknown;
      try {
        value = await getKv(key);
      } catch (error) {
        value = undefined;
      }
      const bytes = estimateSerializedBytes(value);
      totalBytes += bytes;

      if (key.startsWith("preview:inline:v1:")) {
        buckets.previewInline.approxBytes += bytes;
        buckets.previewInline.entryCount += 1;
        return;
      }

      if (key === "preview:meta:v1") {
        buckets.previewMeta.approxBytes += bytes;
        buckets.previewMeta.entryCount += 1;
        if (value && typeof value === "object") {
          const snapshot = value as { version?: number; entries?: Record<string, unknown> };
          if (typeof snapshot.version === "number") {
            buckets.previewMeta.version = snapshot.version;
          }
          if (snapshot.entries && typeof snapshot.entries === "object") {
            const tracked = Object.values(snapshot.entries).filter(Boolean).length;
            buckets.previewMeta.trackedPreviews = tracked;
          }
        }
        return;
      }

      if (key.startsWith("blobMetadata:")) {
        buckets.blobMetadata.approxBytes += bytes;
        buckets.blobMetadata.entryCount += 1;
        if (value && typeof value === "object") {
          const record = value as Record<string, Record<string, unknown> | undefined>;
          const serverKeys = Object.keys(record);
          buckets.blobMetadata.serverCount = serverKeys.length;
          const fileCount = serverKeys.reduce((total, serverKey) => {
            const entries = record[serverKey];
            if (!entries || typeof entries !== "object") return total;
            return total + Object.keys(entries).length;
          }, 0);
          buckets.blobMetadata.fileCount = fileCount;
        }
        return;
      }

      if (key.startsWith("bloom.serverSnapshot:")) {
        buckets.serverSnapshots.approxBytes += bytes;
        buckets.serverSnapshots.entryCount += 1;
        if (value && typeof value === "object") {
          const payload = value as { blobs?: unknown[] };
          if (Array.isArray(payload.blobs)) {
            buckets.serverSnapshots.blobCount += payload.blobs.length;
          }
        }
        return;
      }

      buckets.other.approxBytes += bytes;
      buckets.other.entryCount += 1;
    })
  );

  buckets.previewInline.approxBytes = Math.max(0, buckets.previewInline.approxBytes);
  buckets.previewMeta.approxBytes = Math.max(0, buckets.previewMeta.approxBytes);
  buckets.blobMetadata.approxBytes = Math.max(0, buckets.blobMetadata.approxBytes);
  buckets.serverSnapshots.approxBytes = Math.max(0, buckets.serverSnapshots.approxBytes);
  buckets.other.approxBytes = Math.max(0, buckets.other.approxBytes);

  return {
    totalBytes,
    buckets: finalizeBucketStats(buckets),
  };
};

export type IndexedDbMeasurement = {
  supported: boolean;
  measuredAt: number;
  totalBytes: number;
  cacheDb?: CacheDbUsage;
  manifest?: ManifestStats | null;
};

export const measureIndexedDbUsage = async (): Promise<IndexedDbMeasurement> => {
  if (typeof indexedDB === "undefined") {
    return {
      supported: false,
      measuredAt: Date.now(),
      totalBytes: 0,
      cacheDb: undefined,
      manifest: null,
    };
  }

  const [cacheUsage, manifestStats] = await Promise.all([measureCacheDbUsage(), getManifestStats()]);
  const cacheBytes = cacheUsage.totalBytes;
  const manifestBytes = manifestStats?.approxBytes ?? 0;

  return {
    supported: true,
    measuredAt: Date.now(),
    totalBytes: cacheBytes + manifestBytes,
    cacheDb: cacheUsage,
    manifest: manifestStats ?? null,
  };
};
