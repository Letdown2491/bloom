import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import { AppProviders } from "./providers/AppProviders";
import App from "./App";
import { PublicFolderPage } from "./features/folderShare/PublicFolderPage";

type InitialView =
  | { mode: "app" }
  | { mode: "public-folder"; naddr: string };

const resolveInitialView = (): InitialView => {
  if (typeof window === "undefined") {
    return { mode: "app" };
  }
  const path = window.location.pathname || "/";
  const match = path.match(/^\/folders\/([^/]+)\/?$/i);
  if (!match) {
    return { mode: "app" };
  }
  const raw = match[1] ?? "";
  try {
    return { mode: "public-folder", naddr: decodeURIComponent(raw) };
  } catch {
    return { mode: "public-folder", naddr: raw };
  }
};

const initialView = resolveInitialView();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element with id 'root' not found");
}

const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <AppProviders>
      {initialView.mode === "public-folder" ? <PublicFolderPage naddr={initialView.naddr} /> : <App />}
    </AppProviders>
  </StrictMode>
);
