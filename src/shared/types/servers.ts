export type ManagedServer = {
  name: string;
  url: string;
  type: "blossom" | "nip96" | "satellite";
  requiresAuth?: boolean;
  note?: string;
  sync?: boolean;
};
