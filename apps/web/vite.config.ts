import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const apiTarget = process.env.LAMBDATA_API_URL || "http://127.0.0.1:4317";
const webPort = Number(process.env.LAMBDATA_WEB_PORT) || 5173;

function vendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//.test(id)) return "vendor-react";
  if (/node_modules\/@tanstack\//.test(id)) return "vendor-query";
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  root: __dirname,
  cacheDir: process.env.LAMBDATA_VITE_CACHE_DIR || undefined,
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@lambdata/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: webPort,
    strictPort: !!process.env.LAMBDATA_WEB_PORT,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        ws: true,
      },
      "/functions/v1": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
