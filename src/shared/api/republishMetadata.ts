import type { BlossomBlob } from "./blossomClient";
import { publishNip94Metadata, extractExtraNip94Tags } from "./nip94Publisher";
import { getBlobMetadataName } from "../utils/blobMetadataStore";
import type { NdkContextValue } from "../../app/context/NdkContext";

export type RepublishProgress = {
  current: number;
  total: number;
  currentBlob?: BlossomBlob;
};

export type RepublishResult = {
  succeeded: number;
  failed: number;
  errors: Array<{ sha256: string; error: Error }>;
};

export type RepublishMetadataOptions = {
  ndk: NdkContextValue["ndk"];
  signer: NdkContextValue["signer"];
  blobs: BlossomBlob[];
  serverUrl: string;
  relays: readonly string[];
  onProgress?: (progress: RepublishProgress) => void;
  signal?: AbortSignal;
};

/**
 * Republishes NIP-94 metadata for a list of blobs with updated server URLs.
 * This is useful when files have been moved to a new server and the metadata
 * on relays still points to the old server URL.
 */
export const republishBlobMetadata = async ({
  ndk,
  signer,
  blobs,
  serverUrl,
  relays,
  onProgress,
  signal,
}: RepublishMetadataOptions): Promise<RepublishResult> => {
  if (!ndk) {
    throw new Error("NDK unavailable");
  }
  if (!signer) {
    throw new Error("Signer unavailable");
  }

  const normalizedServerUrl = serverUrl.replace(/\/+$/, "");
  const total = blobs.length;
  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ sha256: string; error: Error }> = [];

  for (let i = 0; i < blobs.length; i++) {
    if (signal?.aborted) {
      break;
    }

    const blob = blobs[i];
    if (!blob) continue;

    // Skip private blobs - they use a different metadata system
    if (blob.privateData) {
      succeeded++;
      onProgress?.({ current: i + 1, total, currentBlob: blob });
      continue;
    }

    // Create a blob with the correct URL for this server
    const blobWithCorrectUrl: BlossomBlob = {
      ...blob,
      url: `${normalizedServerUrl}/${blob.sha256}`,
      serverUrl: normalizedServerUrl,
    };

    try {
      const extraTags = extractExtraNip94Tags(blob.nip94);
      const alias = getBlobMetadataName(blob) ?? blob.name ?? null;
      const folderPath = blob.folderPath ?? undefined;

      await publishNip94Metadata({
        ndk,
        signer,
        blob: blobWithCorrectUrl,
        relays,
        alias,
        folderPath,
        extraTags,
        timeoutMs: 10000,
      });

      succeeded++;
    } catch (error) {
      failed++;
      errors.push({
        sha256: blob.sha256,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    onProgress?.({ current: i + 1, total, currentBlob: blob });
  }

  return { succeeded, failed, errors };
};
