import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useNdk } from "./NdkContext";
import { useSyncPipeline } from "./SyncPipelineContext";
import type { NDKEvent as NdkEvent } from "@nostr-dev-kit/ndk";
import {
  addShaToRecord,
  buildDefaultFolderRecord,
  deriveNameFromPath,
  isPrivateFolderName,
  loadFolderLists,
  normalizeFolderPath,
  publishFolderList,
  removeShaFromRecord,
  parseFolderEvent,
  FOLDER_LIST_CONSTANTS,
  type FolderListRecord,
  type FolderListVisibility,
} from "../../shared/domain/folderList";
import {
  applyFolderUpdate,
  containsReservedFolderSegment,
  normalizeFolderPathInput,
} from "../../shared/utils/blobMetadataStore";
import { reconcileBlobWithStoredMetadata } from "../../shared/utils/queryBlobCache";

const sortRecords = (records: Iterable<FolderListRecord>) =>
  Array.from(records).sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
  );

type FolderListContextValue = {
  folders: FolderListRecord[];
  foldersByPath: Map<string, FolderListRecord>;
  foldersBySha: Map<string, string[]>;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  addBlobToFolder: (path: string, sha256: string) => Promise<void>;
  removeBlobFromFolder: (path: string, sha256: string) => Promise<void>;
  renameFolder: (path: string, name: string) => Promise<void>;
  getFolderDisplayName: (path: string) => string;
  resolveFolderPath: (path: string) => string;
  deleteFolder: (path: string) => Promise<FolderListRecord | null>;
  setFolderVisibility: (
    path: string,
    visibility: FolderListVisibility,
  ) => Promise<FolderListRecord | null>;
  getFoldersForBlob: (sha256: string) => string[];
  setBlobFolderMembership: (sha256: string, targetPath: string | null) => Promise<void>;
};

const FolderListContext = createContext<FolderListContextValue | undefined>(undefined);

export const FolderListProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ndk, signer, user } = useNdk();
  const { stage, allowRelayRefresh, markRelayStageComplete } = useSyncPipeline();
  const queryClient = useQueryClient();
  const [folders, setFolders] = useState<FolderListRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const foldersRef = useRef(new Map<string, FolderListRecord>());
  const foldersByShaRef = useRef(new Map<string, string[]>());
  const [foldersBySha, setFoldersBySha] = useState<Map<string, string[]>>(new Map());
  const refreshTriggeredRef = useRef(false);
  const refreshCompletedRef = useRef(false);

  const hydrateMetadataFromRecords = useCallback((records: FolderListRecord[]) => {
    records.forEach(record => {
      const normalizedPath = normalizeFolderPathInput(record.path) ?? null;
      const updatedAt = record.updatedAt;
      record.shas.forEach(sha => {
        if (!sha) return;
        applyFolderUpdate(undefined, sha, normalizedPath, updatedAt);
      });
    });
  }, []);

  const updateState = useCallback(
    (records: FolderListRecord[]) => {
      const filtered = records.filter(record => record.shas.length > 0);
      const sorted = sortRecords(filtered);
      foldersRef.current = new Map(sorted.map(record => [record.path, record]));
      const bySha = new Map<string, string[]>();
      sorted.forEach(record => {
        record.shas.forEach(sha => {
          if (!sha) return;
          const normalizedSha = sha.trim();
          if (!normalizedSha) return;
          const existing = bySha.get(normalizedSha);
          if (existing) {
            if (!existing.includes(record.path)) {
              existing.push(record.path);
            }
          } else {
            bySha.set(normalizedSha, [record.path]);
          }
        });
      });
      foldersByShaRef.current = bySha;
      setFoldersBySha(bySha);
      setFolders(sorted);
      hydrateMetadataFromRecords(sorted);
    },
    [hydrateMetadataFromRecords],
  );

  const applyRemoteFolderRecord = useCallback(
    (record: FolderListRecord) => {
      if (!record?.path) return;
      const existing = foldersRef.current.get(record.path) ?? null;
      const incomingSeconds = typeof record.updatedAt === "number" ? record.updatedAt : null;
      const existingSeconds = existing?.updatedAt ?? null;
      if (
        existing &&
        incomingSeconds !== null &&
        existingSeconds !== null &&
        incomingSeconds <= existingSeconds
      ) {
        return;
      }

      const normalizedIncomingPath = normalizeFolderPathInput(record.path) ?? null;
      const normalizedExistingPath = existing
        ? (normalizeFolderPathInput(existing.path) ?? null)
        : null;
      const existingShas = new Set((existing?.shas ?? []).map(sha => sha.trim()).filter(Boolean));
      const incomingShas = new Set((record.shas ?? []).map(sha => sha.trim()).filter(Boolean));

      const removed: string[] = [];
      existingShas.forEach(sha => {
        if (!incomingShas.has(sha)) removed.push(sha);
      });

      const added: string[] = [];
      incomingShas.forEach(sha => {
        if (!existingShas.has(sha)) added.push(sha);
      });

      const reassigned =
        normalizedIncomingPath !== normalizedExistingPath ? Array.from(incomingShas) : added;

      removed.forEach(sha => {
        applyFolderUpdate(undefined, sha, null, incomingSeconds ?? undefined);
        reconcileBlobWithStoredMetadata(queryClient, sha);
      });
      reassigned.forEach(sha => {
        applyFolderUpdate(undefined, sha, normalizedIncomingPath, incomingSeconds ?? undefined);
        reconcileBlobWithStoredMetadata(queryClient, sha);
      });

      const nextMap = new Map(foldersRef.current);
      if (record.shas.length === 0) {
        nextMap.delete(record.path);
      } else {
        nextMap.set(record.path, record);
      }
      updateState(Array.from(nextMap.values()));
    },
    [queryClient, updateState],
  );

  const refresh = useCallback(async () => {
    if (!ndk || !user) {
      updateState([]);
      return;
    }
    setLoading(true);
    try {
      const records = await loadFolderLists(ndk, user.pubkey);
      updateState(records);
      setError(null);
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error("Failed to load folders");
      setError(normalized);
    } finally {
      setLoading(false);
    }
  }, [ndk, updateState, user]);

  useEffect(() => {
    if (stage === "idle" || stage === "settings" || stage === "server") {
      refreshTriggeredRef.current = false;
      refreshCompletedRef.current = false;
    }
  }, [stage]);

  useEffect(() => {
    if (!allowRelayRefresh) return;
    if (refreshCompletedRef.current) return;
    if (refreshTriggeredRef.current) return;
    refreshTriggeredRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } finally {
        if (!cancelled) {
          refreshCompletedRef.current = true;
          markRelayStageComplete();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowRelayRefresh, markRelayStageComplete, refresh]);

  useEffect(() => {
    if (!allowRelayRefresh) return;
    if (!ndk || !user) return;
    const filter = {
      kinds: [FOLDER_LIST_CONSTANTS.KIND],
      authors: [user.pubkey],
    };
    const subscription = ndk.subscribe(filter, { closeOnEose: false });
    let disposed = false;
    const handleEvent = (event: unknown) => {
      if (disposed) return;
      if (!event || typeof event !== "object") return;
      const parsed = parseFolderEvent(event as NdkEvent);
      if (!parsed) return;
      applyRemoteFolderRecord(parsed);
    };
    subscription.on("event", handleEvent);
    return () => {
      disposed = true;
      subscription.stop();
    };
  }, [allowRelayRefresh, applyRemoteFolderRecord, ndk, user]);

  const findRecordByName = useCallback((name: string, excludePath?: string) => {
    const target = name.trim().toLowerCase();
    for (const record of foldersRef.current.values()) {
      if (excludePath && record.path === excludePath) continue;
      if ((record.name ?? "").trim().toLowerCase() === target) {
        return record;
      }
    }
    return null;
  }, []);

  const resolveFolderPath = useCallback(
    (path: string) => {
      const normalized = normalizeFolderPath(path);
      if (!normalized) return normalized;
      const exact = foldersRef.current.get(normalized);
      if (exact) return exact.path;
      const caseInsensitive = Array.from(foldersRef.current.values()).find(
        record => record.path.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0,
      );
      if (caseInsensitive) return caseInsensitive.path;
      const privateRecord = findRecordByName("private");
      if (privateRecord && isPrivateFolderName(deriveNameFromPath(normalized))) {
        return privateRecord.path;
      }
      return normalized;
    },
    [findRecordByName],
  );

  const publishAndStore = useCallback(
    async (record: FolderListRecord) => {
      if (!ndk || !signer || !user) {
        throw new Error("Connect your signer to update folders.");
      }
      const published = await publishFolderList(ndk, signer, user, record);
      const next = new Map(foldersRef.current);
      next.set(published.path, published);
      updateState(Array.from(next.values()));
    },
    [ndk, signer, updateState, user],
  );

  const addBlobToFolder = useCallback(
    async (path: string, sha256: string) => {
      const normalizedPath = resolveFolderPath(path);
      if (!normalizedPath) return;
      if (!sha256) return;
      const existing = foldersRef.current.get(normalizedPath);
      const defaultRecord = existing ?? buildDefaultFolderRecord(normalizedPath, { shas: [] });
      const privateRecord = findRecordByName("private");
      const targetRecord =
        privateRecord &&
        privateRecord.path !== defaultRecord.path &&
        isPrivateFolderName(defaultRecord.name)
          ? privateRecord
          : defaultRecord;
      const previousLength = targetRecord.shas.length;
      const updated = addShaToRecord(targetRecord, sha256);
      if (updated.shas.length === previousLength) {
        return;
      }
      await publishAndStore(updated);
    },
    [findRecordByName, publishAndStore, resolveFolderPath],
  );

  const removeBlobFromFolder = useCallback(
    async (path: string, sha256: string) => {
      const normalizedPath = resolveFolderPath(path);
      if (!normalizedPath) return;
      if (!sha256) return;
      const existing = foldersRef.current.get(normalizedPath);
      if (!existing) return;
      const updated = removeShaFromRecord(existing, sha256);
      if (updated.shas.length === existing.shas.length) {
        return;
      }
      await publishAndStore(updated);
    },
    [publishAndStore, resolveFolderPath],
  );

  const setBlobFolderMembership = useCallback(
    async (sha256: string, targetPath: string | null) => {
      const normalizedSha = sha256.trim();
      if (!normalizedSha) return;
      const currentPaths = foldersByShaRef.current.get(normalizedSha) ?? [];
      const normalizedTarget = targetPath ? resolveFolderPath(targetPath) : null;

      const tasks: Promise<void>[] = [];

      currentPaths.forEach(path => {
        if (!normalizedTarget || path !== normalizedTarget) {
          tasks.push(removeBlobFromFolder(path, normalizedSha));
        }
      });

      if (normalizedTarget) {
        const alreadyAssigned = currentPaths.includes(normalizedTarget);
        if (!alreadyAssigned) {
          tasks.push(addBlobToFolder(normalizedTarget, normalizedSha));
        }
      }

      if (tasks.length === 0) {
        return;
      }

      for (const task of tasks) {
        await task;
      }
    },
    [addBlobToFolder, removeBlobFromFolder, resolveFolderPath],
  );

  const renameFolder = useCallback(
    async (path: string, name: string) => {
      const normalizedPath = resolveFolderPath(path);
      if (!normalizedPath) return;
      const existing =
        foldersRef.current.get(normalizedPath) ??
        buildDefaultFolderRecord(normalizedPath, { shas: [] });

      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error("Folder name cannot be empty.");
      }

      const inputHasPathSeparator = trimmed.includes("/");
      let targetPath: string | null = null;
      let targetName: string | null = null;

      const buildValidatedPath = (candidate: string): string => {
        const normalized = normalizeFolderPath(candidate);
        if (!normalized) {
          throw new Error("Enter a valid folder path.");
        }
        if (containsReservedFolderSegment(normalized)) {
          throw new Error('Folder names cannot include the word "private".');
        }
        return normalized;
      };

      if (inputHasPathSeparator) {
        targetPath = buildValidatedPath(trimmed);
        targetName = deriveNameFromPath(targetPath) || trimmed;
      } else {
        if (containsReservedFolderSegment(trimmed)) {
          throw new Error('Folder names cannot include the word "private".');
        }
        const parentSegments = normalizedPath.split("/");
        parentSegments.pop();
        const candidatePath = [...parentSegments.filter(Boolean), trimmed].join("/");
        targetPath = buildValidatedPath(candidatePath);
        targetName = trimmed;
      }

      if (!targetPath) {
        throw new Error("Enter a valid folder path.");
      }

      if (isPrivateFolderName(targetName ?? "")) {
        const conflict = findRecordByName(targetName ?? "", existing.path);
        if (conflict && conflict.path !== existing.path) {
          throw new Error("You already have a Private folder.");
        }
      }

      const existingForTarget = foldersRef.current.get(targetPath);
      if (existingForTarget && existingForTarget.path !== existing.path) {
        throw new Error("A folder already exists at that location.");
      }

      const isSamePath = targetPath === existing.path;
      const nextName = targetName ?? existing.name;

      if (isSamePath && nextName === existing.name) {
        return;
      }

      if (!ndk || !signer || !user) {
        throw new Error("Connect your signer to update folders.");
      }

      const normalizedTargetPath = normalizeFolderPath(targetPath);
      const normalizedExistingPath = existing.path;

      const buildRecordForPath = (
        record: FolderListRecord,
        path: string,
        nameOverride?: string,
      ): FolderListRecord => {
        const base = buildDefaultFolderRecord(path, {
          name: nameOverride ?? record.name,
          shas: record.shas,
          visibility: record.visibility,
          pubkey: record.pubkey,
          fileHints: record.fileHints,
        });
        return {
          ...record,
          ...base,
          name: nameOverride ?? record.name ?? base.name,
          shas: [...record.shas],
          visibility: record.visibility,
          fileHints: record.fileHints,
        };
      };

      const descendantsToMove = !isSamePath
        ? Array.from(foldersRef.current.values()).filter(record =>
            record.path.startsWith(`${normalizedExistingPath}/`),
          )
        : [];

      const updatedParent = buildRecordForPath(existing, normalizedTargetPath, nextName);
      const updatedDescendants = descendantsToMove.map(descendant => {
        const suffix = descendant.path.slice(normalizedExistingPath.length + 1);
        const descendantTargetPath = normalizedTargetPath
          ? `${normalizedTargetPath}/${suffix}`
          : suffix;
        return buildRecordForPath(descendant, descendantTargetPath);
      });

      const publishedRecords: FolderListRecord[] = [];
      for (const record of [updatedParent, ...updatedDescendants]) {
        const published = await publishFolderList(ndk, signer, user, record);
        publishedRecords.push(published);
      }

      const nextMap = new Map(foldersRef.current);
      nextMap.delete(existing.path);
      descendantsToMove.forEach(record => nextMap.delete(record.path));
      publishedRecords.forEach(record => nextMap.set(record.path, record));
      updateState(Array.from(nextMap.values()));

      if (!isSamePath) {
        const cleanupTargets = [existing, ...descendantsToMove];
        for (const record of cleanupTargets) {
          await publishFolderList(ndk, signer, user, { ...record, shas: [] });
        }
      }
    },
    [findRecordByName, ndk, signer, updateState, resolveFolderPath, user],
  );

  const deleteFolder = useCallback(
    async (path: string) => {
      const normalizedPath = resolveFolderPath(path);
      if (!normalizedPath) return null;
      const existing = foldersRef.current.get(normalizedPath);
      if (!existing) return null;
      if (!ndk || !signer || !user) {
        throw new Error("Connect your signer to update folders.");
      }
      await publishFolderList(ndk, signer, user, { ...existing, shas: [] });
      const next = Array.from(foldersRef.current.values()).filter(
        record => record.path !== normalizedPath,
      );
      updateState(next);
      return existing;
    },
    [ndk, resolveFolderPath, signer, updateState, user],
  );

  const setFolderVisibility = useCallback(
    async (path: string, visibility: FolderListVisibility) => {
      const normalizedPath = resolveFolderPath(path);
      if (!normalizedPath) return null;
      const existing =
        foldersRef.current.get(normalizedPath) ??
        buildDefaultFolderRecord(normalizedPath, { shas: [] });
      if (existing.visibility === visibility) {
        return existing;
      }
      const updated: FolderListRecord = {
        ...existing,
        visibility,
      };
      await publishAndStore(updated);
      return updated;
    },
    [publishAndStore, resolveFolderPath],
  );

  const foldersByPath = useMemo(
    () => new Map(folders.map(record => [record.path, record])),
    [folders],
  );
  const foldersByShaSnapshot = useMemo(() => new Map(foldersBySha), [foldersBySha]);

  const getFoldersForBlob = useCallback((sha256: string) => {
    if (!sha256) return [];
    const normalizedSha = sha256.trim();
    if (!normalizedSha) return [];
    const paths = foldersByShaRef.current.get(normalizedSha);
    return paths ? [...paths] : [];
  }, []);

  const getFolderDisplayName = useCallback(
    (path: string) => {
      const normalizedPath = resolveFolderPath(path);
      const record = foldersByPath.get(normalizedPath);
      if (record) return record.name;
      if (!normalizedPath) return "Home";
      const segments = normalizedPath.split("/");
      return segments[segments.length - 1] || normalizedPath;
    },
    [foldersByPath, resolveFolderPath],
  );

  const value = useMemo<FolderListContextValue>(
    () => ({
      folders,
      foldersByPath,
      foldersBySha: foldersByShaSnapshot,
      loading,
      error,
      refresh,
      addBlobToFolder,
      removeBlobFromFolder,
      renameFolder,
      getFolderDisplayName,
      resolveFolderPath,
      deleteFolder,
      setFolderVisibility,
      getFoldersForBlob,
      setBlobFolderMembership,
    }),
    [
      folders,
      foldersByPath,
      foldersByShaSnapshot,
      loading,
      error,
      refresh,
      addBlobToFolder,
      removeBlobFromFolder,
      renameFolder,
      getFolderDisplayName,
      resolveFolderPath,
      deleteFolder,
      setFolderVisibility,
      getFoldersForBlob,
      setBlobFolderMembership,
    ],
  );

  return <FolderListContext.Provider value={value}>{children}</FolderListContext.Provider>;
};

export const useFolderLists = () => {
  const context = useContext(FolderListContext);
  if (!context) {
    throw new Error("useFolderLists must be used within a FolderListProvider");
  }
  return context;
};
