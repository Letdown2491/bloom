export type NdkModule = typeof import("@nostr-dev-kit/ndk");

let ndkModulePromise: Promise<NdkModule> | null = null;

export const loadNdkModule = (): Promise<NdkModule> => {
  if (!ndkModulePromise) {
    ndkModulePromise = import("@nostr-dev-kit/ndk");
  }
  return ndkModulePromise;
};
