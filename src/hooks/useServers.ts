import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { USER_BLOSSOM_SERVER_LIST_KIND } from "blossom-client-sdk";
import { useCurrentPubkey, useNdk } from "../context/NdkContext";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { deriveServerNameFromUrl } from "../utils/serverName";

export type ManagedServer = {
  name: string;
  url: string;
  type: "blossom" | "nip96" | "satellite";
  requiresAuth?: boolean;
  note?: string;
  sync?: boolean;
};

const DEFAULT_SERVERS: ManagedServer[] = [
  { name: "Nostrcheck", url: "https://nostrcheck.me", type: "nip96", requiresAuth: true, sync: false },
  { name: "Primal", url: "https://blossom.primal.net", type: "blossom", requiresAuth: true, sync: false },
  { name: "Satellite Earth", url: "https://cdn.satellite.earth", type: "satellite", requiresAuth: true, sync: false },
];

function parseServerTags(event: NDKEvent): ManagedServer[] {
  const seen = new Set<string>();
  const servers: ManagedServer[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "server") continue;
    const rawUrl = (tag[1] || "").trim();
    if (!rawUrl) continue;
    const url = rawUrl.replace(/\/$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    const rawType = (tag[2] as ManagedServer["type"]) || "blossom";
    const type: ManagedServer["type"] = rawType === "nip96" || rawType === "satellite" ? rawType : "blossom";
    const flag = tag[3] || "";
    const note = tag[4];
    const requiresAuth = type === "satellite" ? true : flag.includes("auth");
    const sync = flag.includes("sync");
    const derivedName = deriveServerNameFromUrl(url);
    const name = derivedName || url.replace(/^https?:\/\//, "");
    servers.push({ url, name, type, requiresAuth, note, sync });
  }
  return servers;
}

export const sortServersByName = (servers: ManagedServer[]): ManagedServer[] => {
  return servers.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
};

export const useServers = () => {
  const { ndk } = useNdk();
  const pubkey = useCurrentPubkey();
  const queryClient = useQueryClient();

  const canFetchUserServers = Boolean(ndk && pubkey);

  const query = useQuery({
    queryKey: ["servers", pubkey],
    enabled: canFetchUserServers,
    staleTime: 1000 * 60,
    queryFn: async (): Promise<ManagedServer[]> => {
      if (!ndk || !pubkey) {
        throw new Error("Nostr context unavailable");
      }
      await ndk.connect().catch(() => undefined);
      const events = await ndk.fetchEvents({
        authors: [pubkey],
        kinds: [USER_BLOSSOM_SERVER_LIST_KIND],
      });
      if (events.size === 0) return [];
      const newest = Array.from(events).sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
      if (!newest) return [];
      return parseServerTags(newest);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (servers: ManagedServer[]) => {
      if (!ndk || !pubkey || !ndk.signer) throw new Error("Connect your Nostr signer first.");
      const event = new NDKEvent(ndk);
      event.kind = USER_BLOSSOM_SERVER_LIST_KIND;
      event.created_at = Math.floor(Date.now() / 1000);
      event.pubkey = pubkey;
      event.content = "";
      event.tags = servers.map(s => {
        const flagParts: string[] = [];
        if (s.requiresAuth) flagParts.push("auth");
        if (s.sync) flagParts.push("sync");
        const flag = flagParts.join(",");
        return ["server", s.url, s.type, flag, s.note || ""];
      });
      await event.sign();
      await event.publish();
      return servers;
    },
    onSuccess: (_, variables) => {
      queryClient.setQueryData(["servers", pubkey], variables);
    },
  });

  const { mutateAsync: mutateServersAsync, isPending } = saveMutation;

  const guardedSaveServers = useCallback(
    async (servers: ManagedServer[]) => {
      if (isPending) {
        throw new Error("Server list update already in progress.");
      }
      return mutateServersAsync(servers);
    },
    [isPending, mutateServersAsync]
  );

  const servers = useMemo(() => {
    if (!pubkey) {
      return sortServersByName(DEFAULT_SERVERS);
    }
    if (query.isError) {
      return sortServersByName(DEFAULT_SERVERS);
    }
    const list = query.data ?? [];
    return sortServersByName(list);
  }, [pubkey, query.isError, query.data]);

  return {
    servers,
    isLoading: query.isLoading,
    saveServers: guardedSaveServers,
    saving: isPending,
    error: query.error || saveMutation.error,
  };
};
