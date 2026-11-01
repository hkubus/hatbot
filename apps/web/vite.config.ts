import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

export default defineConfig({
  plugins: [react(), preloadParser(), precompress()],
  // @hatbot/shared's schemas would bring all of zod; the web checks nothing with them (zod-stub.ts).
  resolve: { alias: { zod: fileURLToPath(new URL("src/zod-stub.ts", import.meta.url)) } },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8080", ws: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});

/**
 * The Markdown parser's chunk, fetched with the entry rather than once the entry has run and asked
 * for it (markdown.tsx), since every chat waits for it.
 */
function preloadParser(): Plugin {
  return {
    name: "hatbot-preload-parser",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        const chunks = Object.values(bundle ?? {});
        const parser = chunks.find(
          (c) => c.type === "chunk" && c.facadeModuleId?.endsWith("/md-parse.tsx"),
        );
        if (parser?.type !== "chunk") return [];
        return [parser.fileName, ...parser.imports]
          .filter((f) => !html.includes(`/${f}"`))
          .map((f) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: true, href: `/${f}` },
            injectTo: "head",
          }));
      },
    },
  };
}

/**
 * A .br and a .gz beside each text file, at the highest levels, for the brain to send as they are
 * (apps/brain/src/web.ts). Source maps are left out: only DevTools fetches them.
 */
function precompress(): Plugin {
  let outDir = "";
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  return {
    name: "hatbot-precompress",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir.startsWith("/")
        ? config.build.outDir
        : join(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const file of walk(outDir)) {
        if (!/\.(js|css|html|svg|webmanifest|json|txt)$/.test(file)) continue;
        const raw = readFileSync(file);
        if (raw.length < 1024) continue;
        const br = brotliCompressSync(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        });
        writeFileSync(`${file}.br`, br);
        writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
      }
    },
  };
}
