import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NdkProvider } from "../context/NdkContext";
import { AudioProvider } from "../context/AudioContext";
import { SelectionProvider } from "../../features/selection/SelectionContext";
import { Nip46Provider } from "../context/Nip46Context";
import { UserPreferencesProvider } from "../context/UserPreferencesContext";
import { PrivateLibraryProvider } from "../context/PrivateLibraryContext";
import { FolderListProvider } from "../context/FolderListContext";
import { DialogProvider } from "../context/DialogContext";

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
        <Nip46Provider>
          <AudioProvider>
            <UserPreferencesProvider>
              <PrivateLibraryProvider>
                <FolderListProvider>
                  <DialogProvider>
                    <SelectionProvider>{children}</SelectionProvider>
                  </DialogProvider>
                </FolderListProvider>
              </PrivateLibraryProvider>
            </UserPreferencesProvider>
          </AudioProvider>
        </Nip46Provider>
      </NdkProvider>
    </QueryClientProvider>
  );
};

export default AppProviders;
