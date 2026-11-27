import { describe, expect, it } from "vitest";
import { encodeQr, qrSvgPath } from "../src/lib/qr.ts";

describe("QR code generator", () => {
  it("encodes short URLs into Version 1–5 matrices with valid finder patterns", () => {
    const qr = encodeQr("http://192.168.1.42:8788/pad?token=0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(qr.version).toBeGreaterThanOrEqual(4);
    expect(qr.version).toBeLessThanOrEqual(6);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);

    // Check top-left, top-right, bottom-left 7x7 finder pattern outer rings and 3x3 centers
    const checkFinder = (r0: number, c0: number) => {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          expect(qr.modules[r0 + dr][c0 + dc]).toBe(border || core);
        }
      }
    };
    checkFinder(0, 0);
    checkFinder(0, qr.size - 7);
    checkFinder(qr.size - 7, 0);

    // Dark module always set at (size - 8, 8)
    expect(qr.modules[qr.size - 8][8]).toBe(true);
  });

  it("handles longer strings up to Version 10 and builds a valid SVG path", () => {
    const longText = "http://100.100.100.100:8788/pad?token=" + "a".repeat(200);
    const qr = encodeQr(longText);
    expect(qr.version).toBeGreaterThanOrEqual(7);
    expect(qr.version).toBeLessThanOrEqual(10);
    const path = qrSvgPath(qr, 4);
    expect(path.startsWith("M")).toBe(true);
    expect(path).toContain("h1v1h-1z");
  });

  it("rejects text that exceeds Version 10 capacity", () => {
    expect(() => encodeQr("x".repeat(300))).toThrow(/too long/i);
  });
});
