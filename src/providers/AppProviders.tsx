import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NdkProvider } from "../context/NdkContext";
import { AudioProvider } from "../context/AudioContext";
import { SelectionProvider } from "../features/selection/SelectionContext";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60,
    },
  },
});

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <QueryClientProvider client={client}>
      <NdkProvider>
        <AudioProvider>
          <SelectionProvider>{children}</SelectionProvider>
        </AudioProvider>
      </NdkProvider>
    </QueryClientProvider>
  );
};
