import React, { useMemo, useRef, useState } from "react";
import pLimit from "p-limit";
import type { ManagedServer } from "../hooks/useServers";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { uploadBlobToServer, type BlossomBlob } from "../lib/blossomClient";
import { uploadBlobToNip96 } from "../lib/nip96Client";
import { resizeImage, stripImageMetadata } from "../utils/image";
import { computeBlurhash } from "../utils/blurhash";
import { prettyBytes } from "../utils/format";
import { useQueryClient } from "@tanstack/react-query";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { rememberBlobMetadata } from "../utils/blobMetadataStore";

const RESIZE_OPTIONS = [
  { id: 0, label: "Original" },
  { id: 1, label: "Large (2048px)", size: 2048 },
  { id: 2, label: "Medium (1280px)", size: 1280 },
  { id: 3, label: "Small (720px)", size: 720 },
];

export type TransferState = {
  id: string;
  serverUrl: string;
  fileName: string;
  transferred: number;
  total: number;
  status: "idle" | "uploading" | "success" | "error";
  message?: string;
  kind?: "manual" | "sync" | "transfer";
};

export type UploadPanelProps = {
  servers: ManagedServer[];
  selectedServerUrl?: string | null;
  onUploaded: (success: boolean) => void;
  syncTransfers?: TransferState[];
};

const buildFileEvent = (blob: BlossomBlob, blurhash?: { hash: string; width: number; height: number }) => {
  const tags: string[][] = [["url", blob.url || ""], ["m", blob.type || ""]];
  if (blob.size) tags.push(["size", String(blob.size)]);
  if (blurhash) {
    tags.push(["blurhash", blurhash.hash]);
    tags.push(["dim", `${blurhash.width}x${blurhash.height}`]);
  }
  return { kind: 1063, content: blob.name || "", tags };
};

export const UploadPanel: React.FC<UploadPanelProps> = ({
  servers,
  selectedServerUrl,
  onUploaded,
  syncTransfers = [],
}) => {
  const [selectedServers, setSelectedServers] = useState<string[]>(() => {
    if (selectedServerUrl) {
      const match = servers.find(server => server.url === selectedServerUrl);
      if (match) return [match.url];
    }
    return servers.slice(0, 1).map(s => s.url);
  });
  const [files, setFiles] = useState<File[]>([]);
  const [cleanMetadata, setCleanMetadata] = useState(true);
  const [resizeOption, setResizeOption] = useState(0);
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const { signEventTemplate, ndk } = useNdk();
  const pubkey = useCurrentPubkey();

  const serverMap = useMemo(() => new Map(servers.map(server => [server.url, server])), [servers]);

  const requiresAuthSelected = useMemo(
    () => selectedServers.some(url => serverMap.get(url)?.requiresAuth),
    [selectedServers, serverMap]
  );

  const canUpload = requiresAuthSelected ? Boolean(ndk?.signer) : true;

  React.useEffect(() => {
    setSelectedServers(prev => {
      const available = servers.map(server => server.url);
      const filtered = prev.filter(url => available.includes(url));

      if (selectedServerUrl && available.includes(selectedServerUrl)) {
        if (filtered.length === 1 && filtered[0] === selectedServerUrl) {
          return filtered;
        }
        return [selectedServerUrl];
      }

      if (filtered.length > 0) return filtered;

      const fallback = available[0];
      return fallback ? [fallback] : [];
    });
  }, [servers, selectedServerUrl]);

  const toggleServer = (url: string) => {
    setSelectedServers(prev => (prev.includes(url) ? prev.filter(item => item !== url) : [...prev, url]));
  };

  const reset = () => {
    setFiles([]);
    setTransfers([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const publishMetadata = async (blob: BlossomBlob, blurHash?: { hash: string; width: number; height: number }) => {
    if (!ndk || !ndk.signer) return;
    const template = buildFileEvent(blob, blurHash);
    const event = new NDKEvent(ndk, template);
    await event.sign();
    await event.publish().catch(() => undefined);
  };

  const handleUpload = async () => {
    if (!files.length || !selectedServers.length) return;
    if (requiresAuthSelected && !ndk?.signer) {
      alert("Connect your NIP-07 signer to upload to servers that require auth.");
      return;
    }
    setBusy(true);
    const limit = pLimit(2);
    const preparedFiles: File[] = [];

    for (const file of files) {
      let processed = file;
      if (cleanMetadata && file.type.startsWith("image/")) {
        processed = await stripImageMetadata(processed);
      }
      const resize = RESIZE_OPTIONS.find(r => r.id === resizeOption && r.size);
      if (resize && file.type.startsWith("image/")) {
        processed = await resizeImage(processed, resize.size!, resize.size!);
      }
      preparedFiles.push(processed);
    }

    const blurhashCache = new Map<string, { hash: string; width: number; height: number } | undefined>();

    let encounteredError = false;

    await Promise.all(
      preparedFiles.map((file, fileIndex) =>
        Promise.all(
          selectedServers.map(serverUrl =>
            limit(async () => {
              const server = serverMap.get(serverUrl);
              if (!server) return;
              const transferKey = `${serverUrl}-${file.name}`;
              setTransfers(prev => [
                ...prev.filter(t => t.id !== transferKey),
                {
                  id: transferKey,
                  serverUrl,
                  fileName: file.name,
                  transferred: 0,
                  total: file.size,
                  status: "uploading",
                  kind: "manual",
                },
              ]);
              try {
                const blurHash = file.type.startsWith("image/")
                  ? blurhashCache.get(file.name) ?? (await computeBlurhash(file))
                  : undefined;
                if (!blurhashCache.has(file.name)) {
                  blurhashCache.set(file.name, blurHash);
                }
                const uploader = server.type === "nip96" ? uploadBlobToNip96 : uploadBlobToServer;
                const uploaded = await uploader(
                  server.url,
                  file,
                  server.requiresAuth ? signEventTemplate : undefined,
                  Boolean(server.requiresAuth),
                  progress => {
                    setTransfers(prev =>
                      prev.map(item =>
                        item.id === transferKey
                          ? {
                              ...item,
                              transferred: progress.loaded,
                              total: progress.total || file.size,
                            }
                          : item
                      )
                    );
                  }
                );
                const blob: BlossomBlob = {
                  ...uploaded,
                  name: uploaded.name || file.name,
                  type: uploaded.type || file.type,
                };
                rememberBlobMetadata(server.url, blob);
                if (pubkey) {
                  queryClient.setQueryData<BlossomBlob[]>(["server-blobs", server.url, pubkey, server.type], prev => {
                    if (!prev) return [blob];
                    const index = prev.findIndex(item => item.sha256 === blob.sha256);
                    if (index >= 0) {
                      const next = [...prev];
                      next[index] = { ...prev[index], ...blob };
                      return next;
                    }
                    return [...prev, blob];
                  });
                }
                setTransfers(prev =>
                  prev.map(item => (item.id === transferKey ? { ...item, transferred: item.total, status: "success" } : item))
                );
                await publishMetadata(blob, blurHash);
                queryClient.invalidateQueries({ queryKey: ["server-blobs", server.url, pubkey, server.type] });
              } catch (err: any) {
                encounteredError = true;
                setTransfers(prev =>
                  prev.map(item =>
                    item.id === transferKey
                      ? {
                          ...item,
                          status: "error",
                          message: err?.message || "Upload failed",
                        }
                      : item
                  )
                );
              }
            })
          )
        )
      )
    );

    setBusy(false);
    onUploaded(!encounteredError);
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Upload</h2>
        <p className="text-xs text-slate-400">Optimise images, keep track of uploads and publish metadata events automatically.</p>
      </header>
      <div className="space-y-3">
        <div>
          <label className="text-sm text-slate-300">Choose files</label>
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={e => setFiles(e.target.files ? Array.from(e.target.files) : [])}
            className="mt-1 w-full"
          />
          {!canUpload && (
            <div className="mt-2 text-xs text-red-400">Connect your NIP-07 signer to upload.</div>
          )}
          {files.length > 0 && (
            <div className="mt-2 text-xs text-slate-400">
              {files.length} file(s), total {prettyBytes(files.reduce((acc, file) => acc + file.size, 0))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={cleanMetadata} onChange={e => setCleanMetadata(e.target.checked)} />
            Remove metadata from images
          </label>
          <label className="flex items-center gap-2">
            <span>Resize:</span>
            <select value={resizeOption} onChange={e => setResizeOption(Number(e.target.value))} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-sm">
              {RESIZE_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="space-y-2">
          <span className="text-sm text-slate-300">Upload to</span>
          <div className="flex flex-wrap gap-3">
            {servers.map(server => (
              <label key={server.url} className={`px-3 py-2 rounded-xl border text-sm cursor-pointer ${
                selectedServers.includes(server.url)
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-slate-800 bg-slate-900/60"
              }`}>
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={selectedServers.includes(server.url)}
                  onChange={() => toggleServer(server.url)}
                />
                {server.name}
              </label>
            ))}
            {servers.length === 0 && <span className="text-xs text-slate-400">Add a server first.</span>}
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleUpload}
            disabled={!files.length || !selectedServers.length || busy || !canUpload}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
          <button onClick={reset} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" disabled={busy}>
            Reset
          </button>
        </div>
      </div>
      {transfers.length + syncTransfers.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2 text-xs text-slate-300">
          {Array.from(new Map([...syncTransfers, ...transfers].map(item => [item.id, item])).values()).map(item => {
            const serverName = serverMap.get(item.serverUrl)?.name || item.serverUrl;
            const percentRaw = item.total ? (item.transferred / item.total) * 100 : item.status === "success" ? 100 : 0;
            const percent = Math.min(100, Math.max(0, Math.round(percentRaw)));
            return (
              <div key={item.id} className="space-y-1">
                <div className="flex justify-between">
                  <span>{item.fileName}</span>
                  <span>
                  {item.status === "uploading" && `${percent}%`}
                  {item.status === "success" && "done"}
                  {item.status === "error" && (item.message || "error")}
                </span>
              </div>
              <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
                <div
                  className={`h-full ${item.status === "error" ? "bg-red-500" : "bg-emerald-500"}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="text-slate-300">{serverName}</div>
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
