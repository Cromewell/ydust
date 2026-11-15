import { diffLines } from "diff";

/** One line of a unified diff, with its numbers in the old and the new text. */
export type Line = { kind: "same" | "add" | "del"; text: string; old?: number; new?: number };
/** A diff to show: lines, and folded runs of unchanged lines (expandable). */
export type Row = Line | { kind: "fold"; lines: Line[] };

const split = (value: string) => {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop(); // a trailing newline ends the last line, it doesn't start one
  return lines;
};

/** Line diff of `a` → `b`, unchanged runs folded to `context` lines around each change. */
export function diffRows(a: string, b: string, context = 3): Row[] {
  const lines: Line[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(a, b)) {
    for (const text of split(part.value)) {
      if (part.added) lines.push({ kind: "add", text, new: n++ });
      else if (part.removed) lines.push({ kind: "del", text, old: o++ });
      else lines.push({ kind: "same", text, old: o++, new: n++ });
    }
  }
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== "same") {
      rows.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "same") j++;
    const run = lines.slice(i, j);
    const keepBefore = i === 0 ? 0 : context; // context after the previous change
    const keepAfter = j === lines.length ? 0 : context; // context before the next change
    if (run.length > keepBefore + keepAfter + 1) {
      rows.push(...run.slice(0, keepBefore), { kind: "fold", lines: run.slice(keepBefore, run.length - keepAfter) }, ...run.slice(run.length - keepAfter));
    } else {
      rows.push(...run);
    }
    i = j;
  }
  return rows;
}

/** How many lines were added and removed. */
export const diffStats = (rows: Row[]) => {
  let add = 0;
  let del = 0;
  for (const r of rows) {
    if (r.kind === "add") add++;
    else if (r.kind === "del") del++;
  }
  return { add, del };
};
