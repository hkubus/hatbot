import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the brain runs on :8080 (HATBOT_PUBLIC_URL=http://localhost:5173).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8080", ws: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
