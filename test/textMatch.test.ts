import { describe, expect, it } from "vitest";
import { findInString, fold, snippet } from "../src/lib/textMatch.ts";

/** The source text each hit covers. */
const hits = (s: string, q: string, limit?: number) => findInString(s, q, limit).map(([a, b]) => s.slice(a, b));

describe("fold", () => {
  it("lowercases and strips accents and umlauts", () => {
    expect(fold("Sätze")).toBe("satze");
    expect(fold("Élève À Ñandú")).toBe("eleveanandu");
  });

  it("turns ß and ẞ into ss", () => {
    expect(fold("Straße")).toBe("strasse");
    expect(fold("GROẞ")).toBe("gross");
  });

  it("drops LaTeX's spacing accents, so they match the composed letter", () => {
    expect(fold("besch¨aftigt")).toBe(fold("beschäftigt"));
    expect(fold("e´tude")).toBe(fold("étude"));
  });

  it("drops whitespace, soft hyphens and dashes", () => {
    expect(fold("ih-\nnen")).toBe("ihnen");
    expect(fold("Ge\u00adsetz")).toBe("gesetz");
    expect(fold("a – b — c\t d")).toBe("abcd");
  });

  it("folds math letters to plain ones", () => {
    expect(fold("𝐴𝑥")).toBe("ax");
  });
});

describe("findInString", () => {
  it("finds a word across a hyphenated line break", () => {
    expect(hits("Mit ih-\nnen reden.", "ihnen")).toEqual(["ih-\nnen"]);
  });

  it("matches umlauts, ß/ss and case in both directions", () => {
    expect(hits("Die Sätze von Rolle", "satze")).toEqual(["Sätze"]);
    expect(hits("Die Satze von Rolle", "Sätze")).toEqual(["Satze"]);
    expect(hits("Eine Strasse, eine Straße", "STRASSE")).toEqual(["Strasse", "Straße"]);
  });

  it("matches a quote across line breaks and extra spaces", () => {
    const s = "Der Satz\nvon   Rolle gilt.";
    expect(hits(s, "Satz von Rolle")).toEqual(["Satz\nvon   Rolle"]);
  });

  it("maps hits back to whole source characters (surrogate pairs, ß)", () => {
    const s = "Sei 𝐴𝑥 = 𝑏.";
    const [[a, b]] = findInString(s, "Ax");
    expect(s.slice(a, b)).toBe("𝐴𝑥");
    // "ss" ends inside the source "ß": the hit still covers the whole character.
    expect(hits("Fuß", "fus")).toEqual(["Fuß"]);
  });

  it("returns non-overlapping hits and honours the limit", () => {
    expect(findInString("aaaa", "aa")).toHaveLength(2);
    expect(findInString("ab ab ab ab", "ab", 3)).toHaveLength(3);
  });

  it("returns nothing for empty or whitespace-only queries, and for misses", () => {
    expect(findInString("text", "")).toEqual([]);
    expect(findInString("text", " - ")).toEqual([]);
    expect(findInString("text", "xyz")).toEqual([]);
  });
});

describe("snippet", () => {
  it("cuts around the match with ellipses and collapses whitespace", () => {
    const s = "x".repeat(50) + " before\nMATCH after " + "y".repeat(50);
    const start = s.indexOf("MATCH");
    const r = snippet(s, start, start + 5, 10);
    expect(r.match).toBe("MATCH");
    expect(r.before.startsWith("…")).toBe(true);
    expect(r.before.endsWith(" before ")).toBe(true);
    expect(r.after.endsWith("…")).toBe(true);
  });

  it("has no ellipses when the whole text fits", () => {
    expect(snippet("a b c", 2, 3)).toEqual({ before: "a ", match: "b", after: " c" });
  });
});
