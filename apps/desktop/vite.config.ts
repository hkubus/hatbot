import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app's own pages (app/tauri.conf.json's frontendDist and devUrl).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { zod: fileURLToPath(new URL("../web/src/zod-stub.ts", import.meta.url)) },
  },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
