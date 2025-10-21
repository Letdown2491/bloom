import type * as NdkModuleTypes from "@nostr-dev-kit/ndk";

export type NdkModule = typeof NdkModuleTypes;
export type NdkEventInstance = InstanceType<NdkModule["NDKEvent"]>;
export type NdkRelayInstance = InstanceType<NdkModule["NDKRelay"]>;

let ndkModulePromise: Promise<NdkModule> | null = null;

export const loadNdkModule = (): Promise<NdkModule> => {
  if (!ndkModulePromise) {
    ndkModulePromise = import("@nostr-dev-kit/ndk") as Promise<NdkModule>;
  }
  return ndkModulePromise;
};
