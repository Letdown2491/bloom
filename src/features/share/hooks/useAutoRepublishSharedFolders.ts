import { useEffect, useRef } from "react";
import type { NDKSigner, NDKUser } from "@nostr-dev-kit/ndk";

import type { BlossomBlob } from "../../../shared/api/blossomClient";
import type { NdkModule } from "../../../shared/api/ndkModule";
import {
  buildItemsFromRecord,
  filterItemsByPolicy,
} from "../../../shared/domain/folderShareHelpers";
import type { FolderListRecord, FolderSharePolicy } from "../../../shared/domain/folderList";
import type { PrivateLinkRecord } from "../../../shared/domain/privateLinks";
import type { ShareFolderItem } from "../../../shared/types/shareFolder";
import type { PublishOperationSummary } from "../ui/folderShareStatus";
import type { EnsureFolderListOptions } from "../services/folderSharePublisher";

type NdkInstance = InstanceType<NdkModule["default"]>;

type EnsureFolderListOnRelays = (
  record: FolderListRecord,
  relayUrls: readonly string[],
  blobs?: BlossomBlob[],
  options?: EnsureFolderListOptions,
) => Promise<{ record: FolderListRecord; summary: PublishOperationSummary }>;

export type AutoRepublishSharedFoldersParams = {
  privateLinkServiceConfigured: boolean;
  privateLinksLoading: boolean;
  privateLinksFetching: boolean;
  privateLinkRecords: PrivateLinkRecord[];
  privateLinkHost: string;
  foldersByPath: Map<string, FolderListRecord>;
  shareRelayCandidates: readonly string[];
  ensureFolderListOnRelays: EnsureFolderListOnRelays;
  folderShareBusyPath: string | null;
  ndk: NdkInstance | null;
  signer: NDKSigner | null;
  user: NDKUser | null;
};

const normalizeShaSet = (items: ShareFolderItem[]): Set<string> => {
  const values = new Set<string>();
  items.forEach(item => {
    const sha = item?.blob?.sha256;
    if (sha && sha.length === 64) {
      values.add(sha.toLowerCase());
    }
  });
  return values;
};

export const useAutoRepublishSharedFolders = ({
  privateLinkServiceConfigured,
  privateLinksLoading,
  privateLinksFetching,
  privateLinkRecords,
  privateLinkHost,
  foldersByPath,
  shareRelayCandidates,
  ensureFolderListOnRelays,
  folderShareBusyPath,
  ndk,
  signer,
  user,
}: AutoRepublishSharedFoldersParams) => {
  const autoRepublishInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!privateLinkServiceConfigured) return;
    if (privateLinksLoading || privateLinksFetching) return;
    if (!ndk || !signer || !user) return;
    if (!shareRelayCandidates.length) return;
    if (!privateLinkHost) return;
    if (folderShareBusyPath) return;

    const activeLinks = new Map<string, PrivateLinkRecord>();
    privateLinkRecords.forEach(record => {
      if (!record || record.status !== "active" || record.isExpired) return;
      const sha = record.target?.sha256;
      if (!sha || sha.length !== 64) return;
      activeLinks.set(sha.toLowerCase(), record);
    });

    const folderRecords = Array.from(foldersByPath.values());
    folderRecords.forEach(record => {
      if (!record || record.visibility !== "public") return;
      const policy: FolderSharePolicy =
        record.sharePolicy === "private-only" || record.sharePolicy === "public-only"
          ? record.sharePolicy
          : "all";
      const allItems = buildItemsFromRecord(record, activeLinks, privateLinkHost);
      const filteredItems = filterItemsByPolicy(allItems, policy);
      if (!filteredItems.length) return;

      const desiredShaSet = normalizeShaSet(filteredItems);
      const currentShaSet = new Set(
        (record.shas ?? []).map(sha => (typeof sha === "string" ? sha.toLowerCase() : String(sha))),
      );

      let needsRepublish = false;
      if (desiredShaSet.size !== currentShaSet.size) {
        needsRepublish = true;
      } else {
        for (const sha of desiredShaSet) {
          if (!currentShaSet.has(sha)) {
            needsRepublish = true;
            break;
          }
        }
      }

      if (!needsRepublish) {
        const hints = record.fileHints ?? {};
        for (const item of filteredItems) {
          const sha = item.blob.sha256.toLowerCase();
          const hint = hints[sha];
          const currentAlias = hint?.privateLinkAlias ?? null;
          const expectedAlias = item.privateLinkAlias ?? null;
          if (policy === "public-only") {
            if (currentAlias) {
              needsRepublish = true;
              break;
            }
          } else if (Boolean(expectedAlias) !== Boolean(currentAlias)) {
            needsRepublish = true;
            break;
          } else if (expectedAlias && currentAlias && expectedAlias !== currentAlias) {
            needsRepublish = true;
            break;
          }
        }
      }

      if (!needsRepublish) return;

      const pathKey = record.path ?? record.identifier;
      if (!pathKey) return;
      if (autoRepublishInFlightRef.current.has(pathKey)) return;
      autoRepublishInFlightRef.current.add(pathKey);

      const blobs = filteredItems.map(item => item.blob);
      const allowedShas = normalizeShaSet(filteredItems);

      void (async () => {
        try {
          const options: EnsureFolderListOptions = {
            allowedShas,
            sharePolicy: policy,
            items: filteredItems,
          };
          const result = await ensureFolderListOnRelays(
            record,
            shareRelayCandidates,
            blobs,
            options,
          );
          if (
            result.summary.failed.length &&
            result.summary.failed.length === result.summary.total
          ) {
            console.warn(
              "Auto-republish failed for shared folder",
              record.path || record.identifier,
            );
          }
        } catch (error) {
          console.warn(
            "Auto-republish encountered an error for shared folder",
            record.path || record.identifier,
            error,
          );
        } finally {
          autoRepublishInFlightRef.current.delete(pathKey);
        }
      })();
    });
  }, [
    privateLinkServiceConfigured,
    privateLinksLoading,
    privateLinksFetching,
    privateLinkRecords,
    privateLinkHost,
    foldersByPath,
    shareRelayCandidates,
    ensureFolderListOnRelays,
    folderShareBusyPath,
    ndk,
    signer,
    user,
  ]);
};
