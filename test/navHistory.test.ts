import { describe, expect, it } from "vitest";
import { NO_HISTORY, leave, step, type Spot } from "../src/lib/navHistory.ts";

const at = (page: number, doc = "a", offset = 0): Spot => ({ doc, page, offset });
const all = () => true;

describe("back and forward", () => {
  it("returns to where you jumped from, and forward again", () => {
    const h = leave(leave(NO_HISTORY, at(1, "a", 0.4)), at(50));
    const b = step(h, "back", at(7, "b"), all)!;
    expect(b.to).toEqual(at(50));
    const c = step(b.history, "back", b.to, all)!;
    expect(c.to).toEqual(at(1, "a", 0.4));
    expect(step(c.history, "back", c.to, all)).toBeNull();
    const f = step(c.history, "forward", c.to, all)!;
    expect(f.to).toEqual(at(50));
    expect(step(f.history, "forward", f.to, all)!.to).toEqual(at(7, "b"));
  });
  it("a new jump ends the way forward, and the same spot is kept once", () => {
    const b = step(leave(NO_HISTORY, at(1)), "back", at(9), all)!;
    expect(leave(b.history, at(1)).forward).toEqual([]);
    expect(leave(leave(NO_HISTORY, at(1)), at(1, "a", 0.01)).back).toHaveLength(1);
  });
  it("skips deleted documents and the spot you are at", () => {
    const h = leave(leave(leave(NO_HISTORY, at(1)), at(2, "gone")), at(3));
    expect(step(h, "back", at(3), (d) => d !== "gone")!.to).toEqual(at(1));
    expect(step(leave(NO_HISTORY, at(2, "gone")), "back", at(1), (d) => d !== "gone")).toBeNull();
  });
  it("is limited", () => {
    let h = NO_HISTORY;
    for (let i = 1; i < 200; i++) h = leave(h, at(i));
    expect(h.back).toHaveLength(50);
  });
});
