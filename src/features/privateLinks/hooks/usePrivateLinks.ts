import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNdk } from "../../../app/context/NdkContext";
import {
  createPrivateLink,
  generatePrivateLinkAlias,
  loadPrivateLinks,
  revokePrivateLink,
  type CreatePrivateLinkInput,
  type PrivateLinkRecord,
} from "../../../shared/domain/privateLinks";
import {
  isPrivateLinkServiceConfigured,
  PRIVATE_LINK_SERVICE_HOST,
  PRIVATE_LINK_REQUIRED_RELAY,
} from "../../../shared/constants/privateLinks";
import { DEFAULT_PUBLIC_RELAYS, sanitizeRelayUrl } from "../../../shared/utils/relays";

export type UsePrivateLinksOptions = {
  enabled?: boolean;
};

export type PrivateLinkManager = {
  links: PrivateLinkRecord[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (input: CreatePrivateLinkInput) => Promise<PrivateLinkRecord>;
  creating: boolean;
  revoke: (alias: string) => Promise<PrivateLinkRecord>;
  revoking: boolean;
  serviceConfigured: boolean;
  serviceHost: string;
  generateAlias: (length?: number) => string;
};

const buildQueryKey = (pubkey: string | null | undefined) => ["private-links", pubkey ?? "anonymous"] as const;

export const usePrivateLinks = (options?: UsePrivateLinksOptions): PrivateLinkManager => {
  const { ndk, signer, user, prepareRelaySet } = useNdk();
  const queryClient = useQueryClient();
  const serviceConfigured = isPrivateLinkServiceConfigured();
  const enabled = Boolean(options?.enabled && serviceConfigured && ndk && signer && user);

  const queryKey = useMemo(() => buildQueryKey(user?.pubkey), [user?.pubkey]);

  const resolveRelayTargets = useCallback((): string[] => {
    if (!ndk) return [PRIVATE_LINK_REQUIRED_RELAY];
    const base =
      ndk.explicitRelayUrls && ndk.explicitRelayUrls.length > 0
        ? ndk.explicitRelayUrls
        : Array.from(DEFAULT_PUBLIC_RELAYS);
    const set = new Set<string>();
    base.forEach(url => {
      const sanitized = sanitizeRelayUrl(url);
      if (sanitized) set.add(sanitized);
    });
    set.add(PRIVATE_LINK_REQUIRED_RELAY);
    return Array.from(set);
  }, [ndk]);

  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<PrivateLinkRecord[]> => {
      if (!ndk || !signer || !user) return [];
      const relayTargets = resolveRelayTargets();
      let relaySet = undefined;
      if (relayTargets.length > 0) {
        try {
          const preparation = await prepareRelaySet(relayTargets, { waitForConnection: true });
          relaySet = preparation.relaySet ?? undefined;
        } catch (error) {
          console.warn("Failed to prepare relays for private link fetch", error);
        }
      }
      return loadPrivateLinks(ndk, signer, user, { relaySet });
    },
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: async (input: CreatePrivateLinkInput) => {
      if (!ndk || !signer || !user) throw new Error("Connect your Nostr signer first.");
      const relayTargets = resolveRelayTargets();
      let relaySet = undefined;
      if (relayTargets.length > 0) {
        try {
          const preparation = await prepareRelaySet(relayTargets, { waitForConnection: true });
          relaySet = preparation.relaySet ?? undefined;
        } catch (error) {
          console.warn("Failed to prepare relays for private link creation", error);
        }
      }
      return createPrivateLink(ndk, signer, user, input, { relaySet });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (alias: string) => {
      if (!ndk || !signer || !user) throw new Error("Connect your Nostr signer first.");
      const relayTargets = resolveRelayTargets();
      let relaySet = undefined;
      if (relayTargets.length > 0) {
        try {
          const preparation = await prepareRelaySet(relayTargets, { waitForConnection: true });
          relaySet = preparation.relaySet ?? undefined;
        } catch (error) {
          console.warn("Failed to prepare relays for private link revocation", error);
        }
      }
      return revokePrivateLink(ndk, signer, user, alias, { relaySet });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const refresh = async () => {
    if (!enabled) return;
    await queryClient.invalidateQueries({ queryKey });
    await query.refetch();
  };

  const create = async (input: CreatePrivateLinkInput) => {
    const result = await createMutation.mutateAsync(input);
    await query.refetch();
    return result;
  };

  const revoke = async (alias: string) => {
    const result = await revokeMutation.mutateAsync(alias);
    await query.refetch();
    return result;
  };

  return {
    links: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    refresh,
    create,
    creating: createMutation.isPending,
    revoke,
    revoking: revokeMutation.isPending,
    serviceConfigured,
    serviceHost: PRIVATE_LINK_SERVICE_HOST,
    generateAlias: generatePrivateLinkAlias,
  };
};
