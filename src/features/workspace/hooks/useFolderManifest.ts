import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlossomBlob } from "../../../shared/api/blossomClient";
import {
  clearManifestForPubkey,
  loadManifestViews,
  scopePathKey,
  writeManifestView,
} from "../../../shared/utils/folderManifestStore";
import { useCurrentPubkey } from "../../../app/context/NdkContext";

type ViewMap = Map<string, BlossomBlob[]>;

const supportsStructuredClone = typeof structuredClone === "function";

const cloneBlob = (blob: BlossomBlob): BlossomBlob => {
  if (supportsStructuredClone) {
    return structuredClone(blob);
  }
  return JSON.parse(JSON.stringify(blob)) as BlossomBlob;
};

const makeKey = (scopeKey: string, parentPath: string) => scopePathKey(scopeKey, parentPath);

export type FolderManifestApi = {
  ready: boolean;
  disabled: boolean;
  getView: (scopeKey: string, parentPath: string) => BlossomBlob[] | null;
  saveView: (scopeKey: string, parentPath: string, items: readonly BlossomBlob[]) => void;
  clear: () => void;
};

export const useFolderManifest = (): FolderManifestApi => {
  const pubkey = useCurrentPubkey();
  const pubkeyRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [views, setViews] = useState<ViewMap>(() => new Map());

  useEffect(() => {
    pubkeyRef.current = pubkey ?? null;
    setReady(false);
    setDisabled(false);
    setViews(new Map());
    if (!pubkey) {
      setReady(true);
      return;
    }
    let cancelled = false;
    loadManifestViews(pubkey)
      .then(map => {
        if (cancelled) return;
        const next: ViewMap = new Map();
        map.forEach((items, key) => {
          const restored = (items as BlossomBlob[]).map(entry => cloneBlob(entry));
          next.set(key, restored);
        });
        setViews(next);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDisabled(true);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  const getView = useCallback(
    (scopeKey: string, parentPath: string) => {
      const key = makeKey(scopeKey, parentPath);
      const stored = views.get(key);
      if (!stored) return null;
      return stored.map(entry => cloneBlob(entry));
    },
    [views],
  );

  const saveView = useCallback(
    (scopeKey: string, parentPath: string, items: readonly BlossomBlob[]) => {
      const currentPubkey = pubkeyRef.current;
      if (!currentPubkey) return;
      const key = makeKey(scopeKey, parentPath);
      const cloned = items.map(item => cloneBlob(item));
      setViews(prev => {
        const next = new Map(prev);
        next.set(key, cloned);
        return next;
      });
      if (disabled) return;
      void writeManifestView(
        currentPubkey,
        scopeKey,
        parentPath,
        cloned as unknown as Record<string, unknown>[],
      );
    },
    [disabled],
  );

  const clear = useCallback(() => {
    const currentPubkey = pubkeyRef.current;
    setViews(new Map());
    if (!currentPubkey || disabled) return;
    void clearManifestForPubkey(currentPubkey).catch(() => {
      setDisabled(true);
    });
  }, [disabled]);

  return useMemo(
    () => ({
      ready,
      disabled,
      getView,
      saveView,
      clear,
    }),
    [clear, disabled, getView, ready, saveView],
  );
};
