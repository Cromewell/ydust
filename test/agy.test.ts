import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// A fake agy (a script, so not on Windows): prints the events in EVENTS and exits with CODE.
const dir = await mkdtemp(path.join(tmpdir(), "ydust-agy-"));
const bin = path.join(dir, "agy");
await writeFile(
  bin,
  `#!${process.execPath}
if (process.argv[2] === "models") process.exit(0);
process.stdin.resume().on("end", () => { for (const e of JSON.parse(process.env.EVENTS)) console.log(JSON.stringify(e)); process.exit(Number(process.env.CODE ?? 0)); });
`,
);
await chmod(bin, 0o755);
process.env.AGY_BIN = bin;
process.env.AGY_SETTINGS = path.join(dir, "none.json");
const { agy } = await import("../server/providers/agy.ts");
afterAll(() => rm(dir, { recursive: true, force: true }));

const run = (events: unknown[], code = 0) => {
  process.env.EVENTS = JSON.stringify(events);
  process.env.CODE = String(code);
  return agy.run({ prompt: "q", cwd: dir, onEvent: () => {} });
};
const init = { event: "init", conversation_id: "c1" };
const text = (t: string) => ({ event: "step_update", step_update: { step_type: "agent_response", step_index: 1, text_delta: t } });

describe.skipIf(process.platform === "win32")("agy's result", () => {
  it("is an error when it failed after a part of the answer", async () => {
    const r = await run([init, text("Half an"), { event: "result", result: { status: "ERROR", conversation_id: "c1", error: "quota exceeded" } }]);
    expect(r).toMatchObject({ status: "ERROR", response: "Half an", error: "quota exceeded" });
  });
  it("is an answer when it succeeded, and an error when it just ended", async () => {
    expect(await run([init, text("All of it"), { event: "result", result: { status: "SUCCESS", conversation_id: "c1" } }])).toMatchObject({ response: "All of it", error: null });
    expect(await run([init, text("Half")], 1)).toMatchObject({ status: "ERROR", error: "agy exited with code 1" });
  });
});
