import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// store.ts (imported by app.ts) reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-access-"));
process.env.YDUST_LIBRARY = lib;
const { app, runtime, AUTH_COOKIE } = await import("../server/app.ts");

afterAll(() => rm(lib, { recursive: true, force: true }));

const LOCAL = "127.0.0.1:8787";
const get = (url: string, headers: Record<string, string>) => app.request(url, { headers });

describe("access middleware", () => {
  it("allows the app itself", async () => {
    for (const host of ["127.0.0.1:8787", "localhost:5173", "LOCALHOST", "[::1]:8787", "127.0.0.1"]) {
      const res = await get("/api/health", { host });
      expect(res.status, host).toBe(200);
    }
    expect(await (await get("/api/health", { host: LOCAL })).json()).toEqual({ ok: true, library: path.resolve(lib) });
  });

  it("allows same-origin requests from the local app", async () => {
    for (const origin of ["http://127.0.0.1:8787", "http://localhost:5173", "http://[::1]:8787"]) {
      const res = await get("/api/health", { host: LOCAL, origin, "sec-fetch-site": "same-origin" });
      expect(res.status, origin).toBe(200);
    }
  });

  it("blocks a foreign Host header (DNS rebinding)", async () => {
    for (const host of ["evil.example", "127.0.0.1.evil.example", "localhost.evil.example:8787", "10.0.0.5:8787", "0.0.0.0:8787", ""]) {
      const res = await get("/api/health", { host });
      expect(res.status, host).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });

  it("blocks a foreign or malformed Origin", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null", "not a url"]) {
      const res = await get("/api/health", { host: LOCAL, origin });
      expect(res.status, origin).toBe(403);
    }
  });

  it("blocks pages of other local web servers (another port)", async () => {
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:8080", "http://127.0.0.1"]) {
      const res = await get("/api/health", { host: LOCAL, origin, "sec-fetch-site": "same-site" });
      expect(res.status, origin).toBe(403);
    }
  });

  it("accepts only JSON or uploads as a body (plain text skips the browser's CORS check)", async () => {
    const res = await app.request("/api/folders", { method: "POST", headers: { host: LOCAL, "content-type": "text/plain" }, body: JSON.stringify({ name: "x" }) });
    expect(res.status).toBe(415);
    const json = await app.request(`/api/docs/${randomUUID()}`, { method: "PATCH", headers: { host: LOCAL, "content-type": "application/json; charset=utf-8" }, body: "{}" });
    expect(json.status).toBe(404); // got past the check
    const empty = await app.request(`/api/docs/${randomUUID()}/stop`, { method: "POST", headers: { host: LOCAL } });
    expect(empty.status).toBe(200);
  });

  it("can't be framed by another site", async () => {
    const res = await get("/api/health", { host: LOCAL });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("blocks cross-site requests by sec-fetch-site", async () => {
    expect((await get("/api/health", { host: LOCAL, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get("/api/health", { host: LOCAL, "sec-fetch-site": "none" })).status).toBe(200);
  });

  it("guards writes too, not just reads", async () => {
    const res = await app.request("/api/folders", {
      method: "POST",
      headers: { host: LOCAL, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "pwned" }),
    });
    expect(res.status).toBe(403);
    const list = await (await get("/api/folders", { host: LOCAL })).json();
    expect(list).toEqual([]);
  });
});

describe("sign-in (YDUST_AUTH)", () => {
  const token = "a".repeat(64);

  it("needs the cookie the printed link sets", async () => {
    runtime.authToken = token;
    try {
      expect((await get("/api/docs", { host: LOCAL })).status).toBe(401);
      expect((await get(`/api/auth?token=${"b".repeat(64)}`, { host: LOCAL })).status).toBe(403);
      const signIn = await get(`/api/auth?token=${token}`, { host: LOCAL });
      expect(signIn.status).toBe(302);
      const cookie = signIn.headers.get("set-cookie")!;
      expect(cookie).toContain(`${AUTH_COOKIE}=${token}`);
      expect(cookie).toMatch(/HttpOnly/i);
      expect((await get("/api/docs", { host: LOCAL, cookie: `${AUTH_COOKIE}=${token}` })).status).toBe(200);
      // ydust's MCP server proves itself with the turn token instead.
      const internal = await app.request("/api/internal/drafts", { method: "POST", headers: { host: LOCAL, "content-type": "application/json" }, body: "{}" });
      expect(internal.status).toBe(403);
      expect(await internal.json()).toEqual({ error: "This conversation turn has ended." });
    } finally {
      runtime.authToken = null;
    }
  });
});

describe("id validation", () => {
  it("answers 404 for malformed ids before any route runs", async () => {
    for (const url of ["/api/docs/not-an-id", "/api/docs/not-an-id/file", "/api/folders/..%2F..%2Fstate", "/api/folders/x/ask"]) {
      const res = await get(url, { host: LOCAL });
      expect(res.status, url).toBe(404);
      expect(await res.json(), url).toEqual({ error: "not found" }); // from the id check, not Hono's fallback
    }
  });

  it("answers 404 for unknown but well-formed ids", async () => {
    expect((await get(`/api/docs/${randomUUID()}`, { host: LOCAL })).status).toBe(404);
    expect((await get(`/api/folders/${randomUUID()}`, { host: LOCAL })).status).toBe(404);
  });
});

describe("routes without a CLI", () => {
  it("creates, renames and deletes a folder", async () => {
    const json = { host: LOCAL, "content-type": "application/json" };
    const created = await app.request("/api/folders", { method: "POST", headers: json, body: JSON.stringify({ name: "  Course  " }) });
    expect(created.status).toBe(201);
    const { id, name } = await created.json();
    expect(name).toBe("Course");
    const renamed = await app.request(`/api/folders/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Renamed" }) });
    expect((await renamed.json()).name).toBe("Renamed");
    expect((await app.request(`/api/folders/${id}`, { method: "DELETE", headers: json })).status).toBe(200);
    expect((await get(`/api/folders/${id}`, { host: LOCAL })).status).toBe(404);
  });

  it("rejects uploads that are not PDFs", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "x.pdf", { type: "application/pdf" }));
    const res = await app.request("/api/docs", { method: "POST", headers: { host: LOCAL }, body: form });
    expect(res.status).toBe(415);
  });

  it("rejects an unknown assistant before starting anything", async () => {
    const f = await (await app.request("/api/folders", { method: "POST", headers: { host: LOCAL, "content-type": "application/json" }, body: "{}" })).json();
    const res = await app.request(`/api/folders/${f.id}/ask`, {
      method: "POST",
      headers: { host: LOCAL, "content-type": "application/json" },
      body: JSON.stringify({ question: "hi", provider: "gpt" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown assistant" });
  });
});
