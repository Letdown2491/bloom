import type { BlossomBlob } from "../api/blossomClient";
import type { FolderSharePolicy } from "../domain/folderList";

export type ShareFolderScope = "aggregated" | "server";

export type FolderShareHint = {
  path: string;
  scope: ShareFolderScope;
  serverUrl?: string | null;
};

export type ShareFolderRequest = FolderShareHint & {
  blobs?: BlossomBlob[];
  items?: ShareFolderItem[];
  sharePolicy?: FolderSharePolicy | null;
};

export type ShareFolderItem = {
  blob: BlossomBlob;
  privateLinkAlias?: string | null;
  privateLinkUrl?: string | null;
};
