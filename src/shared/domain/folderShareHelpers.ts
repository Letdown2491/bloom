import type { BlossomBlob } from "../api/blossomClient";
import type { ShareFolderItem, ShareFolderRequest } from "../types/shareFolder";
import type { FolderListRecord, FolderFileHint, FolderSharePolicy } from "./folderList";
import type { PrivateLinkRecord } from "./privateLinks";

export const normalizeLinkValue = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const deriveServerUrlFromLink = (url: string, sha: string): string | null => {
  if (!url || !sha) return null;
  const trimmedUrl = url.trim();
  const normalizedSha = sha.toLowerCase();
  try {
    const parsed = new URL(trimmedUrl);
    const strippedPath = parsed.pathname.replace(new RegExp(`${normalizedSha}.*$`, "i"), "");
    const normalizedPath = strippedPath.replace(/\/+$/, "");
    const base = `${parsed.origin}${normalizedPath}`;
    return base.replace(/\/+$/, "");
  } catch {
    const index = trimmedUrl.toLowerCase().indexOf(normalizedSha);
    if (index >= 0) {
      return trimmedUrl.slice(0, index).replace(/\/+$/, "");
    }
  }
  return null;
};

export const resolveBlobServerUrl = (blob: BlossomBlob): string | null => {
  const explicit = normalizeLinkValue(blob.serverUrl);
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const direct = normalizeLinkValue(blob.url);
  const sha = typeof blob.sha256 === "string" ? blob.sha256.trim().toLowerCase() : "";
  if (direct && sha.length === 64) {
    const derived = deriveServerUrlFromLink(direct, sha);
    if (derived) return derived;
  }
  return null;
};

export const resolvePublicBlobUrl = (blob: BlossomBlob): string | null => {
  const direct = normalizeLinkValue(blob.url);
  if (direct) return direct;
  const server = resolveBlobServerUrl(blob);
  const sha = typeof blob.sha256 === "string" ? blob.sha256.trim().toLowerCase() : "";
  if (server && sha.length === 64) {
    return `${server}/${sha}`;
  }
  return null;
};

export const buildShareItemsFromRequest = (request: ShareFolderRequest): ShareFolderItem[] => {
  if (Array.isArray(request.items) && request.items.length > 0) {
    return request.items
      .filter(item => item && item.blob && typeof item.blob.sha256 === "string")
      .map(item => ({
        blob: item.blob,
        privateLinkAlias: item.privateLinkAlias ?? null,
        privateLinkUrl: item.privateLinkUrl ?? null,
      }));
  }
  if (Array.isArray(request.blobs) && request.blobs.length > 0) {
    return request.blobs
      .filter(blob => blob && typeof blob.sha256 === "string")
      .map(blob => ({
        blob,
        privateLinkAlias: null,
        privateLinkUrl: null,
      }));
  }
  return [];
};

export const filterItemsByPolicy = (items: ShareFolderItem[], policy: FolderSharePolicy): ShareFolderItem[] => {
  return items.filter(item => {
    const hasPrivate = Boolean(item.privateLinkUrl);
    const hasPublic = Boolean(resolvePublicBlobUrl(item.blob));
    if (policy === "private-only") return hasPrivate;
    if (policy === "public-only") return !hasPrivate && hasPublic;
    return hasPrivate || hasPublic;
  });
};

export const buildItemsFromRecord = (
  record: FolderListRecord,
  activeLinks: Map<string, PrivateLinkRecord>,
  privateLinkHost: string
): ShareFolderItem[] => {
  const normalizedHost = privateLinkHost ? privateLinkHost.replace(/\/+$/, "") : "";
  const items: ShareFolderItem[] = [];
  record.shas.forEach(sha => {
    if (typeof sha !== "string" || sha.length !== 64) return;
    const normalizedSha = sha.toLowerCase();
    const hint = record.fileHints?.[normalizedSha] ?? record.fileHints?.[sha] ?? null;
    const hintUrl = normalizeLinkValue(hint?.url);
    const hintedServer = normalizeLinkValue(hint?.serverUrl);
    const serverUrl = hintedServer ? hintedServer.replace(/\/+$/, "") : undefined;
    const requiresAuth = typeof hint?.requiresAuth === "boolean" ? hint.requiresAuth : undefined;
    const aliasRecord = activeLinks.get(normalizedSha) ?? null;
    const alias = aliasRecord?.alias ?? null;
    const hasHost = normalizedHost.length > 0;
    const isPrivateUrl = Boolean(hasHost && hint?.privateLinkAlias && hintUrl && hintUrl.startsWith(normalizedHost));
    const derivedPublicUrl =
      !isPrivateUrl && hintUrl
        ? hintUrl
        : serverUrl
          ? `${serverUrl}/${normalizedSha}`
          : undefined;
    const sizeValue = typeof hint?.size === "number" && Number.isFinite(hint.size) ? hint.size : undefined;
    const normalizedServerType =
      hint?.serverType === "blossom" || hint?.serverType === "nip96" || hint?.serverType === "satellite"
        ? hint.serverType
        : undefined;
    const blob: BlossomBlob = {
      sha256: normalizedSha,
    };
    if (derivedPublicUrl) blob.url = derivedPublicUrl;
    const effectiveServer =
      serverUrl ??
      (derivedPublicUrl ? deriveServerUrlFromLink(derivedPublicUrl, normalizedSha) ?? undefined : undefined);
    if (effectiveServer) blob.serverUrl = effectiveServer;
    if (typeof requiresAuth === "boolean") blob.requiresAuth = requiresAuth;
    if (normalizedServerType) blob.serverType = normalizedServerType;
    if (typeof sizeValue === "number") blob.size = sizeValue;
    if (hint?.mimeType) blob.type = hint.mimeType;
    if (hint?.name) blob.name = hint.name;

    const privateLinkUrl = alias && hasHost ? `${normalizedHost}/${alias}` : undefined;
    const item: ShareFolderItem = {
      blob,
      privateLinkAlias: alias ?? undefined,
      privateLinkUrl,
    };
    items.push(item);
  });
  return items;
};

export const buildShareableItemHints = ({
  record,
  items,
  sharePolicy,
}: {
  record: FolderListRecord;
  items: ShareFolderItem[];
  sharePolicy: FolderSharePolicy;
}): { shas: string[]; hints: Record<string, FolderFileHint>; filteredItems: ShareFolderItem[] } => {
  const shareableItems = filterItemsByPolicy(items, sharePolicy);
  const filteredItems = shareableItems.filter(item => {
    const sha = item.blob.sha256?.toLowerCase();
    return Boolean(sha && sha.length === 64);
  });

  const shas = Array.from(
    new Set(filteredItems.map(item => (item.blob.sha256 as string).toLowerCase()))
  ).sort((a, b) => a.localeCompare(b));

  const baseHints = record.fileHints ?? {};
  const hintMap: Record<string, FolderFileHint> = {};
  shas.forEach(sha => {
    const existing = baseHints[sha];
    hintMap[sha] = existing ? { ...existing, sha } : { sha };
  });

  filteredItems.forEach(item => {
    const blob = item.blob;
    if (!blob?.sha256 || blob.sha256.length !== 64) return;
    const sha = blob.sha256.toLowerCase();
    if (!hintMap[sha]) {
      hintMap[sha] = { sha };
    }
    const entry = hintMap[sha];
    const normalizedServer = resolveBlobServerUrl(blob) ?? undefined;
    if (normalizedServer) {
      entry.serverUrl = normalizedServer;
    }
    if (typeof blob.requiresAuth === "boolean") entry.requiresAuth = blob.requiresAuth;
    if (blob.serverType) entry.serverType = blob.serverType;
    if (blob.type) entry.mimeType = blob.type;
    if (typeof blob.size === "number" && Number.isFinite(blob.size)) entry.size = blob.size;
    if (blob.name) entry.name = blob.name;

    const publicUrl = resolvePublicBlobUrl(blob) ?? undefined;

    if (sharePolicy === "private-only") {
      if (item.privateLinkUrl) {
        entry.url = item.privateLinkUrl;
        if (item.privateLinkAlias) entry.privateLinkAlias = item.privateLinkAlias;
        else if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      } else if (entry.url) {
        delete entry.url;
        if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      }
    } else if (sharePolicy === "public-only") {
      if (publicUrl) {
        entry.url = publicUrl;
        if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      } else if (entry.url) {
        delete entry.url;
        if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      }
    } else {
      if (item.privateLinkUrl) {
        entry.url = item.privateLinkUrl;
        if (item.privateLinkAlias) entry.privateLinkAlias = item.privateLinkAlias;
        else if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      } else if (publicUrl) {
        entry.url = publicUrl;
        if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      } else if (entry.url) {
        delete entry.url;
        if (entry.privateLinkAlias !== undefined) delete entry.privateLinkAlias;
      }
    }
  });

  const hints = Object.fromEntries(
    Object.entries(hintMap).filter(([, hint]) => {
      if (!hint) return false;
      if (hint.url && hint.url.trim()) return true;
      if (hint.serverUrl && hint.serverUrl.trim()) return true;
      if (typeof hint.requiresAuth === "boolean") return true;
      if (hint.mimeType) return true;
      if (typeof hint.size === "number" && Number.isFinite(hint.size)) return true;
      if (hint.name) return true;
      if (hint.privateLinkAlias) return true;
      return false;
    })
  );

  return { shas, hints, filteredItems };
};
