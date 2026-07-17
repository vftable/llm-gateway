import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: {},
  },
  resolve: {
    alias: { "@": path.resolve(dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/v1": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the single ~930kB bundle into cacheable vendor chunks so a
        // dependency bump doesn't invalidate the whole app, and the browser
        // can fetch them in parallel. Grouped by how often each moves: React
        // itself rarely changes; recharts (+ its d3 dependency graph) is the
        // single biggest chunk and only used on the dashboard/usage pages.
        // Everything NOT matched here is left for Rollup's own automatic
        // grouping (returning undefined) rather than forced into one more
        // named bucket — a static catch-all here creates chunk-graph cycles
        // with the named chunks below (each pulls in shared internal modules
        // that Rollup would otherwise place with them).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return "vendor-react";
          if (/[\\/]react-router(-dom)?[\\/]/.test(id)) return "vendor-router";
          if (
            /[\\/](recharts|d3-[^/\\]+|victory-vendor|internmap|delaunator|robust-predicates|decimal\.js-light|eventemitter3|fast-equals)[\\/]/.test(
              id,
            )
          )
            return "vendor-charts";
          if (/[\\/]@radix-ui[\\/]/.test(id)) return "vendor-radix";
          return undefined;
        },
      },
    },
  },
});
