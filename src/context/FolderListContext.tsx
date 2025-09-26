import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useNdk } from "./NdkContext";
import {
  addShaToRecord,
  buildDefaultFolderRecord,
  deriveNameFromPath,
  isPrivateFolderName,
  loadFolderLists,
  normalizeFolderPath,
  publishFolderList,
  removeShaFromRecord,
  type FolderListRecord,
} from "../lib/folderList";

const sortRecords = (records: Iterable<FolderListRecord>) =>
  Array.from(records).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));

type FolderListContextValue = {
  folders: FolderListRecord[];
  foldersByPath: Map<string, FolderListRecord>;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  addBlobToFolder: (path: string, sha256: string) => Promise<void>;
  removeBlobFromFolder: (path: string, sha256: string) => Promise<void>;
  renameFolder: (path: string, name: string) => Promise<void>;
  getFolderDisplayName: (path: string) => string;
  resolveFolderPath: (path: string) => string;
  deleteFolder: (path: string) => Promise<FolderListRecord | null>;
};

const FolderListContext = createContext<FolderListContextValue | undefined>(undefined);

export const FolderListProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ndk, signer, user } = useNdk();
  const [folders, setFolders] = useState<FolderListRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const foldersRef = useRef(new Map<string, FolderListRecord>());

  const updateState = useCallback((records: FolderListRecord[]) => {
    const filtered = records.filter(record => record.shas.length > 0);
    const sorted = sortRecords(filtered);
    foldersRef.current = new Map(sorted.map(record => [record.path, record]));
    setFolders(sorted);
  }, []);

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
    void refresh();
  }, [refresh]);

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
      const caseInsensitive = Array.from(foldersRef.current.values()).find(record =>
        record.path.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0
      );
      if (caseInsensitive) return caseInsensitive.path;
      const privateRecord = findRecordByName("private");
      if (privateRecord && isPrivateFolderName(deriveNameFromPath(normalized))) {
        return privateRecord.path;
      }
      return normalized;
    },
    [findRecordByName]
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
    [ndk, signer, updateState, user]
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
        privateRecord && privateRecord.path !== defaultRecord.path && isPrivateFolderName(defaultRecord.name)
          ? privateRecord
          : defaultRecord;
      const previousLength = targetRecord.shas.length;
      const updated = addShaToRecord(targetRecord, sha256);
      if (updated.shas.length === previousLength) {
        return;
      }
      await publishAndStore(updated);
    },
    [findRecordByName, publishAndStore, resolveFolderPath]
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
    [publishAndStore, resolveFolderPath]
  );

  const renameFolder = useCallback(
    async (path: string, name: string) => {
      const normalizedPath = resolveFolderPath(path);
      if (!normalizedPath) return;
      const existing = foldersRef.current.get(normalizedPath) ?? buildDefaultFolderRecord(normalizedPath, { shas: [] });
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error("Folder name cannot be empty.");
      }
      if (isPrivateFolderName(trimmed)) {
        const conflict = findRecordByName(trimmed, existing.path);
        if (conflict && conflict.path !== existing.path) {
          throw new Error("You already have a Private folder.");
        }
      }
      if (existing.name === trimmed) return;
      const updated: FolderListRecord = {
        ...existing,
        name: trimmed,
      };
      await publishAndStore(updated);
    },
    [findRecordByName, publishAndStore, resolveFolderPath]
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
      const next = Array.from(foldersRef.current.values()).filter(record => record.path !== normalizedPath);
      updateState(next);
      return existing;
    },
    [ndk, resolveFolderPath, signer, updateState, user]
  );

  const foldersByPath = useMemo(() => new Map(folders.map(record => [record.path, record])), [folders]);

  const getFolderDisplayName = useCallback(
    (path: string) => {
      const normalizedPath = resolveFolderPath(path);
      const record = foldersByPath.get(normalizedPath);
      if (record) return record.name;
      if (!normalizedPath) return "Home";
      const segments = normalizedPath.split("/");
      return segments[segments.length - 1] || normalizedPath;
    },
    [foldersByPath, resolveFolderPath]
  );

  const value = useMemo<FolderListContextValue>(
    () => ({
      folders,
      foldersByPath,
      loading,
      error,
      refresh,
      addBlobToFolder,
      removeBlobFromFolder,
      renameFolder,
      getFolderDisplayName,
      resolveFolderPath,
      deleteFolder,
    }),
    [
      folders,
      foldersByPath,
      loading,
      error,
      refresh,
      addBlobToFolder,
      removeBlobFromFolder,
      renameFolder,
      getFolderDisplayName,
      resolveFolderPath,
      deleteFolder,
    ]
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
