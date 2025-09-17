import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NdkProvider } from "../context/NdkContext";
import { AudioProvider } from "../context/AudioContext";

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
        <AudioProvider>{children}</AudioProvider>
      </NdkProvider>
    </QueryClientProvider>
  );
};
