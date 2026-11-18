import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app, runtime } from "./app.ts";
import { DEFAULT_LIBRARY_DIR, LIBRARY_DIR, LIBRARY_IN_APP_FOLDER, ensureAliases, ensureLibrary, migrateChats } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8787);
// Local only: this server drives an AI agent on your machine, don't expose it to the network.
const HOST = process.env.HOST ?? "127.0.0.1";
const DEV = !(process.argv.includes("--production") || process.env.NODE_ENV === "production");

// `npm start` passes --production (works on every OS, unlike NODE_ENV=… in a script).
if (!DEV) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

/** YDUST_AUTH=1 (shared computers): a sign-in token, kept in the library, readable only by you. */
async function authToken() {
  const file = path.join(LIBRARY_DIR, ".auth-token");
  const saved = (await readFile(file, "utf8").catch(() => "")).trim();
  if (/^[0-9a-f]{64}$/.test(saved)) return saved;
  const token = randomBytes(32).toString("hex");
  await writeFile(file, token + "\n", { mode: 0o600 });
  return token;
}

await ensureLibrary();
await migrateChats();
await ensureAliases();
if (process.env.YDUST_AUTH === "1") runtime.authToken = await authToken();

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const host = HOST === "::1" ? "[::1]" : HOST === "localhost" ? "localhost" : "127.0.0.1";
  // ydust's MCP server hands drafts back here (always over loopback).
  runtime.apiBase = `http://${host}:${info.port}`;
  console.log(`ydust server on http://${HOST}:${info.port}  (library: ${LIBRARY_DIR})`);
  if (runtime.authToken) {
    const web = DEV ? `http://${host}:${process.env.YDUST_DEV_PORT || 5173}` : runtime.apiBase;
    console.log(`Sign in once per browser: ${web}/api/auth?token=${runtime.authToken}`);
  }
  if (LIBRARY_IN_APP_FOLDER) {
    console.warn(
      `\nNote: your library is still inside the app's folder (${LIBRARY_DIR}).\n` +
        `There a "git clean" can delete it, and Claude Code picks up the repository's CLAUDE.md and git status.\n` +
        `Stop ydust and move it to ${DEFAULT_LIBRARY_DIR} (ydust uses that folder once ./library is gone), or set YDUST_LIBRARY.\n`,
    );
  }
});
