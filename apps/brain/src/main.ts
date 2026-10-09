import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8080);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = Bun.serve({ port, hostname, fetch: createApp().fetch });
console.log(`hatbot brain listening on http://${server.hostname}:${server.port}`);
