import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import { AppProviders } from "./providers/AppProviders";
import App from "./App";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element with id 'root' not found");
}

const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>
);
