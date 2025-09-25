import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const vendorChunkGroups = [
  { name: "ndk", test: /[\\/]node_modules[\\/]@nostr-dev-kit[\\/]/ },
  { name: "react-query", test: /[\\/]node_modules[\\/]@tanstack[\\/]react-query[\\/]/ },
  { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
];

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const shouldAnalyze = process.env.ANALYZE === "true";

export default defineConfig({
  plugins: [react(), shouldAnalyze ? visualizer({
    filename: path.resolve(projectRoot, "dist/bundle-visualizer.html"),
    template: "treemap",
    gzipSize: true,
    brotliSize: true,
  }) : null].filter(Boolean),
  resolve: {
    alias: {
      tseep: path.resolve(projectRoot, "src/shims/tseep.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: false,
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
  optimizeDeps: {
    esbuildOptions: {
      sourcemap: false,
    },
  },
});
