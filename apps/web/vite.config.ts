import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the brain runs on :8080 (HATBOT_PUBLIC_URL=http://localhost:5173).
export default defineConfig({
  plugins: [react()],
  // @hatbot/shared's schemas would bring all of zod; the web checks nothing with them (zod-stub.ts).
  resolve: { alias: { zod: fileURLToPath(new URL("src/zod-stub.ts", import.meta.url)) } },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8080", ws: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
