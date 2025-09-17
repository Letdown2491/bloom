import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { AppProviders } from "./providers/AppProviders";

const el = document.getElementById("root")!;
const root = createRoot(el);
root.render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>
);
