import type { NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";

import { buildNip94EventTemplate } from "../../../shared/api/nip94";
import {
  collectRelayTargets,
  DEFAULT_PUBLIC_RELAYS,
  normalizeRelayUrls,
  sanitizeRelayUrl,
} from "../../../shared/utils/relays";
import type { BlossomBlob } from "../../../shared/api/blossomClient";
import {
  buildFolderEventTemplate,
  type FolderListRecord,
  type FolderSharePolicy,
} from "../../../shared/domain/folderList";
import { buildShareableItemHints } from "../../../shared/domain/folderShareHelpers";
import type { ShareFolderItem } from "../../../shared/types/shareFolder";
import type { PublishOperationSummary, RelayPublishFailure } from "../ui/folderShareStatus";
import type { NdkEventInstance, NdkModule, NdkRelayInstance } from "../../../shared/api/ndkModule";
import type {
  RelayPreparationOptions,
  RelayPreparationResult,
} from "../../../shared/api/ndkRelayManager";

type NdkInstance = InstanceType<NdkModule["default"]>;

export type FolderSharePublisherDeps = {
  ndk: NdkInstance | null;
  signer: NDKSigner | null;
  user: NDKUser | null;
  getModule: () => Promise<NdkModule>;
  prepareRelaySet: (
    relayUrls: readonly string[],
    options?: RelayPreparationOptions,
  ) => Promise<RelayPreparationResult>;
};

export type EnsureFolderListOptions = {
  allowedShas?: ReadonlySet<string> | null;
  sharePolicy?: FolderSharePolicy | null;
  items?: ShareFolderItem[] | null;
};

const FOLDER_METADATA_FETCH_TIMEOUT_MS = 7000;

const ensureAllowedSha = (sha: string, allowed: ReadonlySet<string> | null): boolean => {
  if (!allowed) return true;
  return allowed.has(sha);
};

export const createFolderSharePublisher = ({
  ndk,
  signer,
  user,
  getModule,
  prepareRelaySet,
}: FolderSharePublisherDeps) => {
  const ensureFolderListOnRelays = async (
    record: FolderListRecord,
    relayUrls: readonly string[],
    blobs?: BlossomBlob[],
    options?: EnsureFolderListOptions,
  ): Promise<{ record: FolderListRecord; summary: PublishOperationSummary }> => {
    const sanitizedRelays = collectRelayTargets(relayUrls, DEFAULT_PUBLIC_RELAYS);
    const baseSummary: PublishOperationSummary = {
      total: sanitizedRelays.length,
      succeeded: 0,
      failed: [],
    };
    if (!ndk || !signer || !user) {
      return {
        record,
        summary: {
          ...baseSummary,
          error: "Signer unavailable",
        },
      };
    }
    if (!sanitizedRelays.length) {
      return {
        record,
        summary: {
          ...baseSummary,
          error: "No relays configured",
        },
      };
    }

    const { relaySet } = await prepareRelaySet(sanitizedRelays, { waitForConnection: true });
    if (!relaySet) {
      return {
        record,
        summary: {
          ...baseSummary,
          error: "Unable to connect to relays",
          failed: sanitizedRelays.map(url => ({ url, message: "Connection pending" })),
        },
      };
    }

    const allowedInput = options?.allowedShas;
    const normalizedAllowed = allowedInput
      ? new Set(
          Array.from(allowedInput)
            .map(value => value.toLowerCase())
            .filter(value => value.length === 64),
        )
      : null;

    const policyRaw = options?.sharePolicy ?? record.sharePolicy ?? "all";
    const sharePolicy: FolderSharePolicy =
      policyRaw === "private-only" || policyRaw === "public-only" ? policyRaw : "all";

    const candidateItems =
      options?.items && options.items.length > 0
        ? options.items
        : Array.isArray(blobs)
          ? blobs
              .filter((blob): blob is BlossomBlob =>
                Boolean(blob && typeof blob.sha256 === "string"),
              )
              .map(blob => ({
                blob,
                privateLinkAlias: null,
                privateLinkUrl: null,
              }))
          : [];

    const normalizedItems = candidateItems
      .filter(item => item && item.blob && typeof item.blob.sha256 === "string")
      .map(item => ({
        blob: item.blob,
        privateLinkAlias: item.privateLinkAlias ?? null,
        privateLinkUrl: item.privateLinkUrl ?? null,
      }))
      .filter(item => {
        const sha = item.blob.sha256?.toLowerCase();
        if (!sha || sha.length !== 64) return false;
        return ensureAllowedSha(sha, normalizedAllowed);
      });

    const { shas, hints } = buildShareableItemHints({
      record,
      items: normalizedItems,
      sharePolicy,
    });

    const shareRecord: FolderListRecord = {
      ...record,
      shas,
      pubkey: record.pubkey ?? user.pubkey,
      fileHints: Object.keys(hints).length > 0 ? hints : record.fileHints,
      sharePolicy,
    };

    const summary: PublishOperationSummary = {
      total: sanitizedRelays.length,
      succeeded: 0,
      failed: [],
    };

    try {
      const module = await getModule();
      const createdAt = Math.floor(Date.now() / 1000);
      const template = buildFolderEventTemplate(shareRecord, shareRecord.pubkey ?? user.pubkey, {
        createdAt,
        fileHints: shareRecord.fileHints ? Object.values(shareRecord.fileHints) : undefined,
        sharePolicy: shareRecord.sharePolicy ?? null,
      });
      const event = new module.NDKEvent(ndk);
      event.kind = template.kind;
      event.pubkey = template.pubkey;
      event.created_at = template.created_at;
      event.tags = template.tags;
      event.content = template.content;
      await event.sign();
      try {
        const publishedRelays = await event.publish(relaySet, undefined, 0);
        const successUrls = new Set<string>();
        publishedRelays.forEach(relay => {
          const normalized = sanitizeRelayUrl(relay.url);
          if (normalized) {
            successUrls.add(normalized);
          }
        });
        summary.succeeded = successUrls.size;
        summary.failed = sanitizedRelays
          .filter(url => !successUrls.has(url))
          .map(url => ({ url, message: "No acknowledgement" }));
        summary.error = summary.failed.length
          ? "Some relays did not acknowledge the folder list."
          : undefined;
      } catch (publishError) {
        const successUrls = new Set<string>();
        const failedMap = new Map<string, string | undefined>();
        if (
          publishError &&
          typeof publishError === "object" &&
          "publishedToRelays" in publishError &&
          publishError.publishedToRelays instanceof Set
        ) {
          (publishError.publishedToRelays as Set<NdkRelayInstance>).forEach(relay => {
            const normalized = sanitizeRelayUrl(relay.url);
            if (normalized) {
              successUrls.add(normalized);
            }
          });
        }
        if (
          publishError &&
          typeof publishError === "object" &&
          "errors" in publishError &&
          publishError.errors instanceof Map
        ) {
          (publishError.errors as Map<NdkRelayInstance, Error>).forEach((err, relayInstance) => {
            const normalized = sanitizeRelayUrl(relayInstance.url);
            if (normalized) {
              failedMap.set(normalized, err instanceof Error ? err.message : String(err));
            }
          });
        }
        summary.succeeded = successUrls.size;
        const failedUrls = sanitizedRelays.filter(url => !successUrls.has(url));
        summary.failed = failedUrls.map(url => ({
          url,
          message:
            failedMap.get(url) ??
            (publishError instanceof Error ? publishError.message : "Publish failed"),
        }));
        summary.error =
          summary.failed.length > 0
            ? publishError instanceof Error
              ? publishError.message
              : "Failed to publish to some relays"
            : publishError instanceof Error
              ? publishError.message
              : "Publish error";
        console.warn("Failed to publish folder list to relays", publishError);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      summary.error = message;
      summary.failed =
        sanitizedRelays.length > 0
          ? sanitizedRelays.map(url => ({
              url,
              message,
            }))
          : [];
      console.warn("Failed to publish folder list to relays", error);
    }

    return { record: shareRecord, summary };
  };

  const ensureFolderMetadataOnRelays = async (
    record: FolderListRecord,
    relayUrls: readonly string[],
    blobs?: BlossomBlob[],
  ): Promise<PublishOperationSummary> => {
    const sanitizedRelays = collectRelayTargets(relayUrls, DEFAULT_PUBLIC_RELAYS);
    const summary: PublishOperationSummary = {
      total: sanitizedRelays.length,
      succeeded: 0,
      failed: [],
    };
    if (!ndk) {
      summary.error = "Nostr connection unavailable";
      return summary;
    }
    if (!sanitizedRelays.length) {
      summary.error = "No relays configured";
      return summary;
    }
    const { relaySet } = await prepareRelaySet(sanitizedRelays, { waitForConnection: true });
    if (!relaySet) {
      summary.error = "Unable to prepare relays";
      summary.failed = sanitizedRelays.map(url => ({ url, message: "Connection pending" }));
      return summary;
    }
    const module = await getModule();
    const shas = Array.from(
      new Set(record.shas.map(sha => sha?.toLowerCase()).filter(Boolean) as string[]),
    );
    if (!shas.length) {
      summary.succeeded = sanitizedRelays.length;
      return summary;
    }

    const blobLookup = new Map<string, BlossomBlob>();
    blobs?.forEach(blob => {
      if (blob?.sha256) {
        blobLookup.set(blob.sha256.toLowerCase(), blob);
      }
    });

    let fetchedEvents: Set<NdkEventInstance> = new Set<NdkEventInstance>();
    let metadataFetchTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const metadataFetch = ndk.fetchEvents(
        [
          { kinds: [1063], "#x": shas, limit: shas.length },
          { kinds: [1063], "#ox": shas, limit: shas.length },
        ],
        { closeOnEose: true, groupable: false },
        relaySet,
      ) as Promise<Set<NdkEventInstance>>;
      fetchedEvents = (await Promise.race([
        metadataFetch.finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
        }),
        new Promise<Set<NdkEventInstance>>(resolve => {
          timeoutHandle = setTimeout(() => {
            metadataFetchTimedOut = true;
            timeoutHandle = null;
            resolve(new Set<NdkEventInstance>());
          }, FOLDER_METADATA_FETCH_TIMEOUT_MS);
        }),
      ])) as Set<NdkEventInstance>;
    } catch (error) {
      console.warn("Unable to fetch existing file metadata for share", error);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }
    if (metadataFetchTimedOut) {
      console.warn(
        `Timed out after ${FOLDER_METADATA_FETCH_TIMEOUT_MS}ms while fetching metadata events for shared items`,
      );
    }

    const found = new Set<string>();
    const eventsToPublish: NdkEventInstance[] = [];

    fetchedEvents.forEach(eventInstance => {
      if (!eventInstance || !Array.isArray(eventInstance.tags)) return;
      const shaTag = eventInstance.tags.find(
        (tag: unknown) =>
          Array.isArray(tag) && (tag[0] === "x" || tag[0] === "ox") && typeof tag[1] === "string",
      ) as string[] | undefined;
      if (!shaTag || typeof shaTag[1] !== "string") return;
      const sha = shaTag[1].toLowerCase();
      if (!shas.includes(sha)) return;
      found.add(sha);
      eventsToPublish.push(eventInstance);
    });

    const missing = shas.filter(sha => !found.has(sha));
    if (missing.length && signer) {
      missing.forEach(sha => {
        const blob = blobLookup.get(sha);
        if (!blob || !blob.url) return;
        const template = buildNip94EventTemplate({ blob });
        const event = new module.NDKEvent(ndk, template);
        eventsToPublish.push(event);
        found.add(sha);
      });
    }

    if (!eventsToPublish.length) {
      summary.succeeded = sanitizedRelays.length;
      return summary;
    }

    const relayFailures = new Map<string, string>();
    const relaySuccesses = new Map<string, number>();

    const trackSuccess = (url: string) => {
      relaySuccesses.set(url, (relaySuccesses.get(url) ?? 0) + 1);
    };
    const trackFailure = (url: string, message: string) => {
      if (relayFailures.has(url)) return;
      relayFailures.set(url, message);
    };

    for (const event of eventsToPublish) {
      try {
        if (!event.sig) {
          await event.sign();
        }
        const published = await event.publish(relaySet, undefined, 0);
        published.forEach(relay => {
          const normalized = sanitizeRelayUrl(relay.url);
          if (normalized) {
            trackSuccess(normalized);
          }
        });
      } catch (publishError) {
        const successUrls = new Set<string>();
        const failureMap = new Map<string, string | undefined>();
        if (
          publishError &&
          typeof publishError === "object" &&
          "publishedToRelays" in publishError &&
          publishError.publishedToRelays instanceof Set
        ) {
          (publishError.publishedToRelays as Set<NdkRelayInstance>).forEach(relay => {
            const normalized = sanitizeRelayUrl(relay.url);
            if (normalized) {
              successUrls.add(normalized);
              trackSuccess(normalized);
            }
          });
        }
        if (
          publishError &&
          typeof publishError === "object" &&
          "errors" in publishError &&
          publishError.errors instanceof Map
        ) {
          (publishError.errors as Map<NdkRelayInstance, Error>).forEach((err, relayInstance) => {
            const normalized = sanitizeRelayUrl(relayInstance.url);
            if (normalized) {
              failureMap.set(normalized, err instanceof Error ? err.message : String(err));
            }
          });
        }
        const fallbackMessage =
          publishError instanceof Error ? publishError.message : "Failed to publish metadata event";
        sanitizedRelays.forEach(url => {
          if (successUrls.has(url)) return;
          trackFailure(url, failureMap.get(url) ?? fallbackMessage);
        });
        console.warn("Failed to publish metadata event to all relays", publishError);
      }
    }

    const succeededRelays = sanitizedRelays.filter(
      url => !relayFailures.has(url) && (relaySuccesses.get(url) ?? 0) >= eventsToPublish.length,
    );
    summary.succeeded = succeededRelays.length;
    summary.failed = sanitizedRelays
      .filter(url => !succeededRelays.includes(url))
      .map(url => ({
        url,
        message: relayFailures.get(url) ?? "No acknowledgement",
      }));
    summary.error =
      summary.failed.length > 0 ? "Some relays did not receive file metadata." : undefined;

    if (shas.some(sha => !found.has(sha))) {
      console.warn(
        "Some shared items are missing metadata events",
        shas.filter(sha => !found.has(sha)),
      );
    }

    return summary;
  };

  return {
    ensureFolderListOnRelays,
    ensureFolderMetadataOnRelays,
  };
};

export const mergeRelayFailures = (
  failed: RelayPublishFailure[] | undefined,
  additional: RelayPublishFailure[],
) => {
  if (!failed || failed.length === 0) return additional;
  const existing = new Map(failed.map(entry => [entry.url, entry]));
  additional.forEach(entry => {
    if (existing.has(entry.url)) {
      const current = existing.get(entry.url)!;
      existing.set(entry.url, {
        ...current,
        message: entry.message ?? current.message,
      });
    } else {
      existing.set(entry.url, entry);
    }
  });
  return Array.from(existing.values());
};

export const resolveRelayUniverse = (
  relayHints: readonly string[] | undefined | null,
  fallback: readonly string[],
) => {
  if (relayHints && relayHints.length > 0) {
    return normalizeRelayUrls(relayHints);
  }
  return normalizeRelayUrls(fallback);
};
