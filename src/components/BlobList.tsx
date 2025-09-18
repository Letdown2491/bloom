import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prettyBytes, prettyDate } from "../utils/format";
import { buildAuthorizationHeader, type BlossomBlob, type SignTemplate } from "../lib/blossomClient";
import { buildNip98AuthHeader } from "../lib/nip98";
import { CopyIcon, DownloadIcon, FileTypeIcon, TrashIcon } from "./icons";
import { setStoredBlobMetadata } from "../utils/blobMetadataStore";

export type BlobListProps = {
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  viewMode: "grid" | "list";
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
};

type DetectedKindMap = Record<string, "image" | "video">;

type ResolvedMeta = {
  type?: string;
  name?: string;
};

type ResolvedMetaMap = Record<string, ResolvedMeta>;

type FileKind = "image" | "video" | "document";

type SortKey = "name" | "type" | "size" | "uploaded";

type SortConfig = { key: SortKey; direction: "asc" | "desc" };

export const BlobList: React.FC<BlobListProps> = ({
  blobs,
  baseUrl,
  requiresAuth = false,
  signTemplate,
  serverType = "blossom",
  selected,
  viewMode,
  onToggle,
  onSelectMany,
  onDelete,
  onCopy,
  onPlay,
}) => {
  const [detectedKinds, setDetectedKinds] = useState<DetectedKindMap>({});
  const [resolvedMeta, setResolvedMeta] = useState<ResolvedMetaMap>({});
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const pendingLookups = useRef(new Set<string>());
  const attemptedLookups = useRef(new Set<string>());
  const passiveDetectors = useRef(new Map<string, () => void>());
  const isMounted = useRef(true);

  useEffect(() => {
    return () => {
      isMounted.current = false;
      passiveDetectors.current.forEach(cleanup => cleanup());
      passiveDetectors.current.clear();
    };
  }, []);

  const handleDetect = useCallback((sha: string, kind: "image" | "video") => {
    setDetectedKinds(prev => (prev[sha] === kind ? prev : { ...prev, [sha]: kind }));
  }, []);

  useEffect(() => {
    setDetectedKinds(prev => {
      const next: DetectedKindMap = {};
      blobs.forEach(blob => {
        const kind = prev[blob.sha256];
        if (kind) next[blob.sha256] = kind;
      });
      return next;
    });
    setResolvedMeta(prev => {
      const next: ResolvedMetaMap = {};
      blobs.forEach(blob => {
        const meta = prev[blob.sha256];
        if (meta) next[blob.sha256] = meta;
      });
      return next;
    });
    const currentShas = new Set(blobs.map(blob => blob.sha256));
    attemptedLookups.current.forEach(sha => {
      if (!currentShas.has(sha)) attemptedLookups.current.delete(sha);
    });
    pendingLookups.current.forEach(sha => {
      if (!currentShas.has(sha)) pendingLookups.current.delete(sha);
    });
    passiveDetectors.current.forEach((cleanup, sha) => {
      if (!currentShas.has(sha)) {
        cleanup();
        passiveDetectors.current.delete(sha);
      }
    });
  }, [blobs]);

  useEffect(() => {
    const resolveForBlob = async (blob: BlossomBlob, resourceUrl: string) => {
      pendingLookups.current.add(blob.sha256);

      try {
        const headers: Record<string, string> = {};
        const effectiveType = blob.serverType ?? serverType;
        const buildAuth = async (method: "HEAD" | "GET") => {
          if (!requiresAuth || !signTemplate) return undefined;
          if (effectiveType === "nip96") {
            return buildNip98AuthHeader(signTemplate, {
              url: resourceUrl,
              method,
            });
          }
          let resource: URL | null = null;
          try {
            resource = new URL(resourceUrl);
          } catch (error) {
            resource = null;
          }
          return buildAuthorizationHeader(signTemplate, "get", {
            hash: blob.sha256,
            serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
            urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            expiresInSeconds: 120,
          });
        };

        if (requiresAuth) {
          const auth = await buildAuth("HEAD");
          if (!auth) return;
          headers.Authorization = auth;
        }

        let response = await fetch(resourceUrl, { method: "HEAD", headers, mode: "cors" });
        if (!response.ok) {
          if (response.status === 405 || response.status === 501) {
            const fallbackHeaders: Record<string, string> = { ...headers };
            if (requiresAuth) {
              const auth = await buildAuth("GET");
              if (!auth) return;
              fallbackHeaders.Authorization = auth;
            }
            response = await fetch(resourceUrl, { method: "GET", headers: fallbackHeaders, mode: "cors" });
            if (!response.ok) return;
            if (response.body) {
              try {
                await response.body.cancel();
              } catch (error) {
                // Ignore cancellation errors; the headers are already available.
              }
            }
          } else {
            return;
          }
        }
        const mime = response.headers.get("content-type") || undefined;
        const disposition = response.headers.get("content-disposition") || undefined;
        const inferredName = deriveFilename(disposition);

        const nextType = mime && mime !== "application/octet-stream" ? mime : undefined;
        const nextName = inferredName || undefined;

        const storageServer = blob.serverUrl ?? baseUrl;
        if ((nextType || nextName) && storageServer) {
          setStoredBlobMetadata(storageServer, blob.sha256, {
            name: nextName,
            type: nextType,
          });
        }

        if (isMounted.current) {
          if (nextType?.startsWith("image/")) {
            handleDetect(blob.sha256, "image");
          } else if (nextType?.startsWith("video/")) {
            handleDetect(blob.sha256, "video");
          }
        }

        if (!nextType && !nextName) return;
        if (!isMounted.current) return;

        setResolvedMeta(prev => {
          const current = prev[blob.sha256] ?? {};
          const updated: ResolvedMeta = {
            type: nextType ?? current.type,
            name: nextName ?? current.name,
          };
          if (current.type === updated.type && current.name === updated.name) return prev;
          return { ...prev, [blob.sha256]: updated };
        });
      } catch (error) {
        // Swallow errors; metadata resolution is a best-effort enhancement.
      } finally {
        pendingLookups.current.delete(blob.sha256);
      }
    };

    const ensurePassiveProbe = (blob: BlossomBlob, resourceUrl: string) => {
      if (requiresAuth || passiveDetectors.current.has(blob.sha256) || detectedKinds[blob.sha256]) return;
      const img = new Image();
      img.decoding = "async";
      const cleanup = () => {
        img.onload = null;
        img.onerror = null;
        img.src = "";
        passiveDetectors.current.delete(blob.sha256);
      };
      img.onload = () => {
        if (isMounted.current) {
          handleDetect(blob.sha256, "image");
        }
        cleanup();
      };
      img.onerror = () => {
        cleanup();
      };
      passiveDetectors.current.set(blob.sha256, cleanup);
      img.src = resourceUrl;
    };

    for (const blob of blobs) {
      const overrides = resolvedMeta[blob.sha256];
      const effectiveType = overrides?.type ?? blob.type;
      const effectiveName = overrides?.name ?? blob.name;
      const hasType = Boolean(effectiveType && effectiveType !== "application/octet-stream");
      const hasName = Boolean(effectiveName && effectiveName !== blob.sha256);
      const resourceUrl = blob.url || (() => {
        const fallback = blob.serverUrl ?? baseUrl;
        if (!fallback) return undefined;
        return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
      })();
      if (!resourceUrl) continue;
      const sameOrigin = isSameOrigin(resourceUrl);
      const alreadyAttempted = attemptedLookups.current.has(blob.sha256);
      const alreadyLoading = pendingLookups.current.has(blob.sha256);
      const canFetch = requiresAuth || sameOrigin;

      if (!hasType || !hasName) {
        if (!canFetch) {
          ensurePassiveProbe(blob, resourceUrl);
          continue;
        }
      }

      if ((hasType && hasName) || alreadyAttempted || alreadyLoading) continue;
      if (requiresAuth && !signTemplate) continue;
      attemptedLookups.current.add(blob.sha256);
      void resolveForBlob(blob, resourceUrl);
    }

  }, [blobs, baseUrl, requiresAuth, signTemplate, resolvedMeta, detectedKinds, handleDetect, serverType]);

  const decoratedBlobs = useMemo(() => {
    return blobs.map(blob => {
      const overrides = resolvedMeta[blob.sha256];
      const base = blob.serverUrl ?? baseUrl;
      const normalizedBase = base ? base.replace(/\/$/, "") : undefined;
      return {
        ...blob,
        type: overrides?.type ?? blob.type,
        name: overrides?.name ?? blob.name,
        url: blob.url || (normalizedBase ? `${normalizedBase}/${blob.sha256}` : undefined),
        serverUrl: normalizedBase ?? blob.serverUrl,
        requiresAuth: blob.requiresAuth ?? requiresAuth,
        serverType: blob.serverType ?? serverType,
      };
    });
  }, [blobs, resolvedMeta, baseUrl, requiresAuth, serverType]);

  const sortedBlobs = useMemo(() => {
    if (!sortConfig) return decoratedBlobs;
    const { key, direction } = sortConfig;
    const modifier = direction === "asc" ? 1 : -1;
    const deriveName = (blob: BlossomBlob) => {
      const explicit = blob.name?.trim();
      if (explicit) return explicit.toLowerCase();
      if (blob.url) {
        const tail = blob.url.split("/").pop();
        if (tail) return tail.toLowerCase();
      }
      return blob.sha256.toLowerCase();
    };
    return [...decoratedBlobs].sort((a, b) => {
      if (key === "size") {
        const aSize = typeof a.size === "number" ? a.size : -1;
        const bSize = typeof b.size === "number" ? b.size : -1;
        const diff = aSize - bSize;
        if (diff !== 0) return diff * modifier;
      } else if (key === "uploaded") {
        const aUploaded = typeof a.uploaded === "number" ? a.uploaded : 0;
        const bUploaded = typeof b.uploaded === "number" ? b.uploaded : 0;
        const diff = aUploaded - bUploaded;
        if (diff !== 0) return diff * modifier;
      } else {
        const aValue = key === "name" ? deriveName(a) : (a.type ?? "").toLowerCase();
        const bValue = key === "name" ? deriveName(b) : (b.type ?? "").toLowerCase();
        const diff = aValue.localeCompare(bValue);
        if (diff !== 0) return diff * modifier;
      }
      const fallback = deriveName(a).localeCompare(deriveName(b));
      return fallback * modifier;
    });
  }, [decoratedBlobs, sortConfig]);

  const handleSortToggle = useCallback((key: SortKey) => {
    setSortConfig(current => {
      if (!current || current.key !== key) {
        return { key, direction: "asc" };
      }
      if (current.direction === "asc") {
        return { key, direction: "desc" };
      }
      return null;
    });
  }, []);

  const handleDownload = useCallback(
    async (blob: BlossomBlob) => {
      if (!blob.url) return;
      let objectUrl: string | null = null;
      try {
        const headers: Record<string, string> = {};
        if (blob.requiresAuth) {
          if (!signTemplate) throw new Error("Signer required to authorize this download.");
          const kind = blob.serverType ?? serverType;
          if (kind === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url: blob.url,
              method: "GET",
            });
          } else {
            let resource: URL | null = null;
            try {
              resource = new URL(blob.url);
            } catch (error) {
              resource = null;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: blob.sha256,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : blob.serverUrl,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
              expiresInSeconds: 300,
            });
          }
        }

        const response = await fetch(blob.url, { headers, mode: "cors" });
        if (!response.ok) {
          throw new Error(`Download failed with status ${response.status}`);
        }

        const data = await response.blob();
        const disposition = response.headers.get("content-disposition") || undefined;
        const inferredName = deriveFilename(disposition);
        const baseName = sanitizeFilename(inferredName || blob.name || blob.sha256);
        const typeHint = blob.type || data.type;
        const extension = inferExtensionFromType(typeHint);
        const filename = ensureExtension(baseName, extension);

        objectUrl = URL.createObjectURL(data);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        console.error("Failed to download blob", error);
        if (typeof window !== "undefined") {
          const message = error instanceof Error ? error.message : "Failed to download blob.";
          window.alert(message);
        }
      } finally {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      }
    },
    [signTemplate, serverType]
  );

  const listBlobs = viewMode === "list" ? sortedBlobs : decoratedBlobs;

  return (
    <div className="">
      {viewMode === "list" ? (
        <ListLayout
          blobs={listBlobs}
          baseUrl={baseUrl}
          requiresAuth={requiresAuth}
          signTemplate={signTemplate}
          serverType={serverType}
          selected={selected}
          onToggle={onToggle}
          onSelectMany={onSelectMany}
          onDelete={onDelete}
          onDownload={handleDownload}
          onCopy={onCopy}
          onPlay={onPlay}
          detectedKinds={detectedKinds}
          sortConfig={sortConfig}
          onSort={handleSortToggle}
        />
      ) : (
        <GridLayout
          blobs={decoratedBlobs}
          baseUrl={baseUrl}
          requiresAuth={requiresAuth}
          signTemplate={signTemplate}
          serverType={serverType}
          selected={selected}
          onToggle={onToggle}
          onDelete={onDelete}
          onDownload={handleDownload}
          onCopy={onCopy}
          onPlay={onPlay}
          detectedKinds={detectedKinds}
          onDetect={handleDetect}
        />
      )}
    </div>
  );
};

const GridLayout: React.FC<{
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  detectedKinds: DetectedKindMap;
  onDetect: (sha: string, kind: "image" | "video") => void;
}> = ({ blobs, baseUrl, requiresAuth, signTemplate, serverType, selected, onToggle, onDelete, onDownload, onCopy, onPlay, detectedKinds, onDetect }) => (
  <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
    {blobs.map(blob => {
      const isSelected = selected.has(blob.sha256);
      const isAudio = blob.type?.startsWith("audio/");
      const previewUrl = blob.url;
      const previewRequiresAuth = blob.requiresAuth ?? requiresAuth;
      const displayName = buildDisplayName(blob);
      const toggleSelection = () => onToggle(blob.sha256);
      const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleSelection();
        }
      };
      return (
        <div
          key={blob.sha256}
          role="button"
          tabIndex={0}
          aria-pressed={isSelected}
          onClick={toggleSelection}
          onKeyDown={handleKeyDown}
          className={`rounded-xl border px-4 py-4 flex flex-col gap-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/70 focus:ring-offset-2 focus:ring-offset-slate-900 cursor-pointer transition ${
            isSelected ? "border-emerald-500 bg-emerald-500/10" : "border-slate-800 bg-slate-900/60"
          }`}
        >
          {previewUrl && (
            <BlobPreview
              sha={blob.sha256}
              url={previewUrl}
              name={blob.name || blob.sha256}
              type={blob.type}
              requiresAuth={previewRequiresAuth}
              signTemplate={previewRequiresAuth ? signTemplate : undefined}
              serverType={blob.serverType ?? serverType}
              onDetect={onDetect}
            />
          )}
          <div className="text-sm font-medium text-slate-100 break-words">
            {displayName}
          </div>
          <div className="flex flex-wrap gap-2 mt-auto pt-1">
            {blob.url && (
              <button
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                onClick={event => {
                  event.stopPropagation();
                  onCopy(blob);
                }}
                aria-label="Copy blob URL"
                title="Copy URL"
              >
                <CopyIcon size={16} />
              </button>
            )}
            {blob.url && (
              <button
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                onClick={event => {
                  event.stopPropagation();
                  onDownload(blob);
                }}
                aria-label="Download blob"
                title="Download"
              >
                <DownloadIcon size={16} />
              </button>
            )}
            <button
              className="p-2 rounded-lg bg-red-900/80 hover:bg-red-800 text-slate-100"
              onClick={event => {
                event.stopPropagation();
                onDelete(blob);
              }}
              aria-label="Delete blob"
              title="Delete"
            >
              <TrashIcon size={16} />
            </button>
            {isAudio && onPlay && blob.url && (
              <button
                className="px-2 py-1 text-xs rounded-lg bg-emerald-700/70 hover:bg-emerald-600"
                onClick={event => {
                  event.stopPropagation();
                  onPlay?.(blob);
                }}
              >
                Play
              </button>
            )}
          </div>
        </div>
      );
    })}
    {blobs.length === 0 && (
      <div className="col-span-full text-center text-sm text-slate-300 py-8">No content on this server yet.</div>
    )}
  </div>
);

const ListThumbnail: React.FC<{
  blob: BlossomBlob;
  kind: FileKind;
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
}> = ({ blob, kind, baseUrl, requiresAuth, signTemplate, serverType = "blossom" }) => {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const containerClass = "flex h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80";
  const effectiveRequiresAuth = blob.requiresAuth ?? requiresAuth;
  const effectiveServerType = blob.serverType ?? serverType;
  const previewUrl = blob.url || (() => {
    const fallback = blob.serverUrl ?? baseUrl;
    if (!fallback) return undefined;
    return `${fallback.replace(/\/$/, "")}/${blob.sha256}`;
  })();
  const shouldPreview = kind === "image" && Boolean(previewUrl);

  useEffect(() => {
    setFailed(false);
    setSrc(null);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    if (!shouldPreview || !previewUrl) return;

    if (!effectiveRequiresAuth) {
      setSrc(previewUrl);
      return;
    }

    if (!signTemplate) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    const match = previewUrl.match(/[0-9a-f]{64}/i);

    const load = async () => {
      try {
        const headers: Record<string, string> = {};
        if (effectiveRequiresAuth) {
          if (effectiveServerType === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url: previewUrl,
              method: "GET",
            });
          } else {
            let resource: URL | undefined;
            try {
              resource = new URL(previewUrl);
            } catch (error) {
              resource = undefined;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: match ? match[0] : undefined,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            });
          }
        }

        const response = await fetch(previewUrl, { headers });
        if (!response.ok || response.type === "opaqueredirect" || response.type === "opaque") {
          throw new Error(`Preview fetch failed (${response.status})`);
        }

        const blobData = await response.blob();
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blobData);
        objectUrlRef.current = objectUrl;
        setSrc(objectUrl);
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [shouldPreview, previewUrl, effectiveRequiresAuth, signTemplate, effectiveServerType, blob.sha256]);

  if (!shouldPreview || !src || failed) {
    return (
      <div className={`${containerClass} items-center justify-center`}>
        <FileTypeIcon kind={kind} size={20} className="text-slate-300" />
      </div>
    );
  }

  const altText = blob.name || previewUrl?.split("/").pop() || blob.sha256;

  return (
    <div className={containerClass}>
      <img
        src={src}
        alt={altText}
        className="h-full w-full object-cover"
        loading="lazy"
        onError={() => {
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
          }
          setFailed(true);
        }}
      />
    </div>
  );
};

const ListLayout: React.FC<{
  blobs: BlossomBlob[];
  baseUrl?: string;
  requiresAuth: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  selected: Set<string>;
  onToggle: (sha: string) => void;
  onSelectMany?: (shas: string[], value: boolean) => void;
  onDelete: (blob: BlossomBlob) => void;
  onDownload: (blob: BlossomBlob) => void;
  onCopy: (blob: BlossomBlob) => void;
  onPlay?: (blob: BlossomBlob) => void;
  detectedKinds: DetectedKindMap;
  sortConfig: SortConfig | null;
  onSort: (key: SortKey) => void;
}> = ({
  blobs,
  baseUrl,
  requiresAuth,
  signTemplate,
  serverType,
  selected,
  onToggle,
  onSelectMany,
  onDelete,
  onDownload,
  onCopy,
  onPlay,
  detectedKinds,
  sortConfig,
  onSort,
}) => {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const allSelected = blobs.length > 0 && blobs.every(blob => selected.has(blob.sha256));
  const partiallySelected = !allSelected && blobs.some(blob => selected.has(blob.sha256));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected, allSelected]);

  const indicatorFor = (key: SortKey) => {
    if (!sortConfig || sortConfig.key !== key) return null;
    return sortConfig.direction === "asc" ? "^" : "v";
  };

  const ariaSortFor = (key: SortKey): "ascending" | "descending" | undefined => {
    if (!sortConfig || sortConfig.key !== key) return undefined;
    return sortConfig.direction === "asc" ? "ascending" : "descending";
  };

  return (
    <div className="pb-1">
      <div className="overflow-x-auto">
        <table className="min-w-full table-fixed text-sm text-slate-300">
          <thead className="text-[11px] uppercase tracking-wide text-slate-300">
            <tr>
              <th scope="col" className="w-12 py-2 px-3">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  checked={allSelected}
                  onChange={event => {
                    const value = event.target.checked;
                    if (onSelectMany) {
                      onSelectMany(
                        blobs.map(blob => blob.sha256),
                        value
                      );
                    } else {
                      blobs.forEach(blob => {
                        const isSelected = selected.has(blob.sha256);
                        if (value && !isSelected) onToggle(blob.sha256);
                        if (!value && isSelected) onToggle(blob.sha256);
                      });
                    }
                  }}
                  aria-label="Select all files"
                />
              </th>
              <th
                scope="col"
                className="py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("name")}
                onClick={() => onSort("name")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("name");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Name</span>
                  <span aria-hidden="true">{indicatorFor("name")}</span>
                </div>
              </th>
              <th
                scope="col"
                className="w-48 py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("type")}
                onClick={() => onSort("type")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("type");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Type</span>
                  <span aria-hidden="true">{indicatorFor("type")}</span>
                </div>
              </th>
              <th
                scope="col"
                className="w-24 py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("size")}
                onClick={() => onSort("size")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("size");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Size</span>
                  <span aria-hidden="true">{indicatorFor("size")}</span>
                </div>
              </th>
              <th
                scope="col"
                className="w-32 py-2 px-3 text-left font-semibold"
                aria-sort={ariaSortFor("uploaded")}
                onClick={() => onSort("uploaded")}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSort("uploaded");
                  }
                }}
                tabIndex={0}
              >
                <div className="flex items-center gap-1 text-left uppercase tracking-wide text-slate-300 hover:text-slate-200 cursor-pointer select-none">
                  <span>Updated</span>
                  <span aria-hidden="true">{indicatorFor("uploaded")}</span>
                </div>
              </th>
              <th scope="col" className="w-40 py-2 pl-3 pr-0 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {blobs.map(blob => {
              const kind = decideFileKind(blob, detectedKinds[blob.sha256]);
              const isAudio = blob.type?.startsWith("audio/");
              const displayName = buildDisplayName(blob);
              const isSelected = selected.has(blob.sha256);
              return (
              <tr
                key={blob.sha256}
                className={`border-t border-slate-800 first:border-t-0 transition-colors ${
                  isSelected ? "bg-slate-800/50" : "hover:bg-slate-800/40"
                }`}
                onClick={event => {
                  if (event.target instanceof HTMLInputElement) return;
                  onToggle(blob.sha256);
                }}
              >
                <td className="w-12 py-3 px-3 align-middle">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    checked={isSelected}
                    onChange={() => onToggle(blob.sha256)}
                    aria-label={`Select ${displayName}`}
                    onClick={event => event.stopPropagation()}
                  />
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-3">
                    <ListThumbnail
                      blob={blob}
                      kind={kind}
                      baseUrl={baseUrl}
                      requiresAuth={requiresAuth}
                      signTemplate={signTemplate}
                      serverType={serverType}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-100 truncate">{displayName}</div>
                    </div>
                  </div>
                </td>
                <td className="w-48 py-3 px-3 truncate">
                  {blob.type || "application/octet-stream"}
                </td>
                <td className="w-24 py-3 px-3 text-left whitespace-nowrap">
                  {prettyBytes(blob.size)}
                </td>
                <td className="w-32 py-3 px-3 text-left whitespace-nowrap">
                  {prettyDate(blob.uploaded)}
                </td>
                <td className="w-40 py-3 pl-3 pr-0">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {blob.url && (
                      <button
                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                        onClick={event => {
                          event.stopPropagation();
                          onCopy(blob);
                        }}
                        aria-label="Copy blob URL"
                        title="Copy URL"
                      >
                        <CopyIcon size={16} />
                      </button>
                    )}
                    {blob.url && (
                      <button
                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                        onClick={event => {
                          event.stopPropagation();
                          onDownload(blob);
                        }}
                        aria-label="Download blob"
                        title="Download"
                      >
                        <DownloadIcon size={16} />
                      </button>
                    )}
                    <button
                      className="p-2 rounded-lg bg-red-900/80 hover:bg-red-800 text-slate-100"
                      onClick={event => {
                        event.stopPropagation();
                        onDelete(blob);
                      }}
                      aria-label="Delete blob"
                      title="Delete"
                    >
                      <TrashIcon size={16} />
                    </button>
                    {isAudio && onPlay && blob.url && (
                      <button
                        className="px-2 py-1 text-xs rounded-lg bg-emerald-700/70 hover:bg-emerald-600"
                        onClick={event => {
                          event.stopPropagation();
                          onPlay?.(blob);
                        }}
                      >
                        Play
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
          {blobs.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 px-3 text-sm text-center text-slate-300">
                No content on this server yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
);
};

const BlobPreview: React.FC<{
  sha: string;
  url: string;
  name: string;
  type?: string;
  requiresAuth?: boolean;
  signTemplate?: SignTemplate;
  serverType?: "blossom" | "nip96";
  onDetect: (sha: string, kind: "image" | "video") => void;
}> = ({ sha, url, name, type, requiresAuth = false, signTemplate, serverType = "blossom", onDetect }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewType, setPreviewType] = useState<"image" | "video" | "unknown">(() => inferKind(type, url) ?? "unknown");

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const match = url.match(/[0-9a-f]{64}/i);

    if (!requiresAuth) {
      const inferred = inferKind(type, url);
      if (inferred) {
        setPreviewType(inferred);
        onDetect(sha, inferred);
      }
      setSrc(url);
      setLoading(false);
      setFailed(false);
      return () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }

    const load = async () => {
      setLoading(true);
      setFailed(false);
      try {
        const headers: Record<string, string> = {};
        if (requiresAuth) {
          if (!signTemplate) throw new Error("Auth required but no signer available");
          if (serverType === "nip96") {
            headers.Authorization = await buildNip98AuthHeader(signTemplate, {
              url,
              method: "GET",
            });
          } else {
            let resource: URL | undefined;
            try {
              resource = new URL(url);
            } catch (error) {
              resource = undefined;
            }
            headers.Authorization = await buildAuthorizationHeader(signTemplate, "get", {
              hash: match ? match[0] : undefined,
              serverUrl: resource ? `${resource.protocol}//${resource.host}` : undefined,
              urlPath: resource ? resource.pathname + (resource.search || "") : undefined,
            });
          }
        }
        const response = await fetch(url, { headers });
        if (!response.ok || response.type === "opaqueredirect" || response.type === "opaque") {
          throw new Error(`Preview fetch failed (${response.status})`);
        }
        const blobData = await response.blob();
        const mime = response.headers.get("content-type") || blobData.type || type || "";
        const detectedType = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : previewType;
        objectUrl = URL.createObjectURL(blobData);
        if (!cancelled) {
          setSrc(objectUrl);
          setPreviewType(detectedType);
          if (detectedType === "image" || detectedType === "video") {
            onDetect(sha, detectedType);
          }
          setLoading(false);
        } else if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
          setSrc(null);
          setLoading(false);
        }
      }
    };

    if (requiresAuth && !signTemplate) {
      setFailed(true);
      setLoading(false);
      setSrc(null);
      return () => undefined;
    }

    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sha, url, type, requiresAuth, signTemplate, serverType, onDetect, previewType]);

  return (
    <div className="h-40 w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80 flex items-center justify-center">
      {src && !failed ? (
        previewType === "video" ? (
          <video
            src={src}
            className="max-h-full max-w-full"
            controls={false}
            autoPlay
            muted
            loop
            playsInline
            onLoadedData={() => {
              setPreviewType("video");
              onDetect(sha, "video");
            }}
          />
        ) : (
          <img
            src={src}
            alt={name}
            className="max-h-full max-w-full object-contain"
            loading="lazy"
            onLoad={() => {
              setPreviewType("image");
              onDetect(sha, "image");
            }}
            onError={() => setFailed(true)}
          />
        )
      ) : loading ? (
        <span className="text-xs text-slate-300">Loading preview…</span>
      ) : (
        <span className="text-xs text-slate-300">Preview unavailable</span>
      )}
    </div>
  );
};

function deriveFilename(disposition?: string) {
  if (!disposition) return undefined;
  const starMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8''|)([^;]+)/i);
  if (starMatch?.[1]) {
    const value = starMatch[1].trim().replace(/^UTF-8''/i, "");
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }
  const quotedMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (quotedMatch?.[1]) return quotedMatch[1];
  return undefined;
}

function isSameOrigin(url: string) {
  try {
    const target = new URL(url, window.location.href);
    return target.origin === window.location.origin;
  } catch (error) {
    return false;
  }
}

function decideFileKind(blob: BlossomBlob, detected?: "image" | "video"): FileKind {
  if (detected) return detected;
  const inferred = inferKind(blob.type, blob.name || blob.url);
  if (inferred) return inferred;
  return "document";
}

function inferKind(type?: string, ref?: string | null): "image" | "video" | undefined {
  const mime = type?.toLowerCase() ?? "";
  const name = ref?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|hevc)$/.test(name)) return "video";
  return undefined;
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[\r\n]+/g, " ");
  const segments = cleaned.split(/[\\/]/);
  return segments[segments.length - 1] || "download";
}

function inferExtensionFromType(type?: string) {
  if (!type) return undefined;
  const [mime] = type.split(";");
  const lookup: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  if (!mime) return undefined;
  return lookup[mime.trim().toLowerCase()];
}

function ensureExtension(filename: string, extension?: string) {
  if (!extension) return filename;
  const lower = filename.toLowerCase();
  if (lower.endsWith(`.${extension.toLowerCase()}`)) return filename;
  return `${filename}.${extension}`;
}

function buildDisplayName(blob: BlossomBlob) {
  const raw = blob.name || blob.url?.split("/").pop() || blob.sha256;
  const sanitized = sanitizeFilename(raw);
  const { baseName, extension: existingExtension } = splitNameAndExtension(sanitized);
  const inferredExtension = existingExtension || inferExtensionFromType(blob.type);
  const truncatedBase = truncateMiddle(baseName, 12, 12);
  return inferredExtension ? `${truncatedBase}.${inferredExtension}` : truncatedBase;
}

function splitNameAndExtension(filename: string) {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return { baseName: trimmed, extension: undefined };
  }
  const baseName = trimmed.slice(0, lastDot);
  const extension = trimmed.slice(lastDot + 1);
  return { baseName, extension };
}

function truncateMiddle(value: string, head: number, tail: number) {
  if (value.length <= head + tail) return value;
  const start = value.slice(0, head);
  const end = value.slice(-tail);
  return `${start}...${end}`;
}
