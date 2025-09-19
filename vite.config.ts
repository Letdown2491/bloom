import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const vendorChunkGroups = [
  { name: "ndk", test: /[\\/]node_modules[\\/]@nostr-dev-kit[\\/]/ },
  { name: "react-query", test: /[\\/]node_modules[\\/]@tanstack[\\/]react-query[\\/]/ },
  { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
];

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      tseep: path.resolve(projectRoot, "src/lib/tseep.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          for (const group of vendorChunkGroups) {
            if (group.test.test(id)) {
              return group.name;
            }
          }
          return "vendor";
        },
      },
    },
  },
});
