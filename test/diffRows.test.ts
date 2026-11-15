import { describe, expect, it } from "vitest";
import { diffRows, diffStats, type Line, type Row } from "../src/lib/diffRows.ts";

const show = (rows: Row[]) => rows.map((r) => (r.kind === "fold" ? `… ${r.lines.length}` : `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`));
const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`).join("\n") + "\n";

describe("diffRows", () => {
  it("shows a new note as all added, numbered", () => {
    const rows = diffRows("", "# Title\n\ntext\n");
    expect(show(rows)).toEqual(["+# Title", "+", "+text"]);
    expect((rows as Line[]).map((r) => r.new)).toEqual([1, 2, 3]);
  });

  it("folds the unchanged start of a note, keeping 3 lines of context", () => {
    const rows = diffRows(lines(20), lines(20) + "added\n");
    expect(show(rows)).toEqual(["… 17", " line 18", " line 19", " line 20", "+added"]);
  });

  it("folds between two changes but keeps context on both sides", () => {
    const a = lines(30);
    const b = a.replace("line 2\n", "line two\n").replace("line 29\n", "line twenty-nine\n");
    const out = show(diffRows(a, b));
    expect(out.slice(0, 7)).toEqual([" line 1", "-line 2", "+line two", " line 3", " line 4", " line 5", "… 20"]);
    expect(out.slice(-6)).toEqual([" line 26", " line 27", " line 28", "-line 29", "+line twenty-nine", " line 30"]);
  });

  it("doesn't fold a run that is barely longer than its context", () => {
    const a = lines(8);
    const b = a.replace("line 1\n", "one\n").replace("line 8\n", "eight\n");
    expect(show(diffRows(a, b)).some((r) => r.startsWith("…"))).toBe(false);
  });

  it("numbers old and new lines separately", () => {
    const rows = diffRows("a\nb\nc\n", "a\nc\nd\n") as Line[];
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ["same", 1, 1],
      ["del", 2, undefined],
      ["same", 3, 2],
      ["add", undefined, 3],
    ]);
    expect(diffStats(rows)).toEqual({ add: 1, del: 1 });
  });

  it("is empty for identical texts", () => {
    expect(show(diffRows("same\n", "same\n"))).toEqual([" same"]);
    expect(diffStats(diffRows("same\n", "same\n"))).toEqual({ add: 0, del: 0 });
  });
});
