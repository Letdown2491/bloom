import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNdk } from "../context/NdkContext";
import {
  createPrivateLink,
  generatePrivateLinkAlias,
  loadPrivateLinks,
  revokePrivateLink,
  type CreatePrivateLinkInput,
  type PrivateLinkRecord,
} from "../lib/privateLinks";
import { isPrivateLinkServiceConfigured, PRIVATE_LINK_SERVICE_HOST } from "../constants/privateLinks";

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
  const { ndk, signer, user } = useNdk();
  const queryClient = useQueryClient();
  const serviceConfigured = isPrivateLinkServiceConfigured();
  const enabled = Boolean(options?.enabled && serviceConfigured && ndk && signer && user);

  const queryKey = useMemo(() => buildQueryKey(user?.pubkey), [user?.pubkey]);

  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<PrivateLinkRecord[]> => {
      if (!ndk || !signer || !user) return [];
      return loadPrivateLinks(ndk, signer, user);
    },
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: async (input: CreatePrivateLinkInput) => {
      if (!ndk || !signer || !user) throw new Error("Connect your Nostr signer first.");
      return createPrivateLink(ndk, signer, user, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (alias: string) => {
      if (!ndk || !signer || !user) throw new Error("Connect your Nostr signer first.");
      return revokePrivateLink(ndk, signer, user, alias);
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
