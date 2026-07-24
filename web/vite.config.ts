import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// webBasePath from config.json so the dev server mirrors the gateway's
// runtime prefix. Build keeps "./" so assets are relative and the gateway
// can rewrite <base href> at serve time under any prefix.
function gatewayConfig(): { port: number; webBasePath: string } {
  let port = 8787;
  let webBasePath = "/";
  try {
    let raw = fs.readFileSync(path.join(dirname, "..", "config.json"), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM, same as src/config.ts
    const cfg = JSON.parse(raw) as { port?: unknown; webBasePath?: unknown };
    if (cfg && typeof cfg === "object") {
      if (typeof cfg.port === "number" && Number.isFinite(cfg.port))
        port = cfg.port;
      const b = cfg.webBasePath;
      if (typeof b === "string" && b.trim()) {
        let v = b.trim();
        if (v !== "/") {
          if (!v.startsWith("/")) v = "/" + v;
          if (!v.endsWith("/")) v += "/";
        }
        webBasePath = v;
      }
    }
  } catch {
    /* missing/unparseable config.json -> defaults */
  }
  return { port, webBasePath };
}
const gateway = gatewayConfig();
const backendPort = gateway.port;

export default defineConfig(({ command }) => ({
  // Relative assets in production so the gateway can point them at any
  // webBasePath via a boot-time <base href>. Absolute "/" would pin assets
  // to the origin root and break under a non-"/" prefix.
  base: command === "build" ? "./" : gateway.webBasePath,
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
      "/api": `http://127.0.0.1:${backendPort}`,
      "/v1": `http://127.0.0.1:${backendPort}`,
      "/health": `http://127.0.0.1:${backendPort}`,
      "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true },
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
}));
