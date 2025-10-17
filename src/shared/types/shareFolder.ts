import type { BlossomBlob } from "../api/blossomClient";

export type ShareFolderScope = "aggregated" | "server";

export type FolderShareHint = {
  path: string;
  scope: ShareFolderScope;
  serverUrl?: string | null;
};

export type ShareFolderRequest = FolderShareHint & {
  blobs?: BlossomBlob[];
};
