import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.ts";
import { LIBRARY_DIR, ensureAliases } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8787);
// Local only: this server drives an AI agent on your machine, don't expose it to the network.
const HOST = process.env.HOST ?? "127.0.0.1";

// `npm start` passes --production (works on every OS, unlike NODE_ENV=… in a script).
if (process.argv.includes("--production") || process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

await ensureAliases();
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`ydust server on http://${HOST}:${info.port}  (library: ${LIBRARY_DIR})`);
});
