import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const lib = await mkdtemp(path.join(tmpdir(), "ydust-fsearch-"));
process.env.YDUST_LIBRARY = lib;
const { app } = await import("../server/app.ts");
const store = await import("../server/store.ts");
afterAll(() => rm(lib, { recursive: true, force: true }));

const get = async (url: string) => app.request(url, { headers: { host: "127.0.0.1:8787" } });
const pdf = new TextEncoder().encode("%PDF-1.7\n");

it("searches all PDFs of a folder, with the hit numbers of the in-document search", async () => {
  const folder = await store.createFolder("Algebra");
  const add = async (name: string, pages: string[] | null) => {
    const d = await store.createDoc(name, pdf);
    await store.setDocFolder(d.id, folder.id);
    if (pages) {
      await store.writeText(d.id, pages);
      await store.updateMeta(d.id, (m) => void (m.hasText = true));
    }
    return d.id;
  };
  const a = await add("A", ["Nichts hier.", "Ein Körper, zwei Körper."]);
  const b = await add("B", ["Koerper? Nein: KÖRPER-\nerweiterung."]);
  await add("Scan", null);
  await add("C", ["Gruppen."]);
  const r = await (await get(`/api/folders/${folder.id}/search?q=${encodeURIComponent("körper")}`)).json();
  expect(r.unread).toBe(1);
  expect(r.docs.map((d: any) => [d.id, d.total])).toEqual([
    [a, 2],
    [b, 1],
  ]);
  expect(r.docs[0].hits.map((h: any) => [h.page, h.n, h.match])).toEqual([
    [2, 0, "Körper"],
    [2, 1, "Körper"],
  ]);
  expect(await (await get(`/api/folders/${folder.id}/search?q=k`)).json()).toEqual({ docs: [], unread: 0 });
  expect((await get(`/api/folders/${crypto.randomUUID()}/search?q=abc`)).status).toBe(404);
});
