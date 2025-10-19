export type RelayPublishFailure = {
  url: string;
  message?: string;
};

export type PublishPhaseState = {
  status: "idle" | "publishing" | "ready" | "partial" | "error";
  total: number | null;
  succeeded: number;
  failed: RelayPublishFailure[];
  message?: string;
};

export type PublishOperationSummary = {
  total: number;
  succeeded: number;
  failed: RelayPublishFailure[];
  error?: string;
};

export type FolderSharePhases = {
  list: PublishPhaseState;
  metadata: PublishPhaseState;
};
