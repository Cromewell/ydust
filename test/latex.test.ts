import { describe, expect, it } from "vitest";
import { buildLatexConvertPrompt, buildLatexFixPrompt, compileLatex, extractTex, latexStatus, summarizeLatexError } from "../server/latex.ts";

describe("LaTeX helpers", () => {
  it("extracts standalone .tex from markdown fences and surrounding prose", () => {
    const raw = `Here is your LaTeX:\n\n\`\`\`latex\n\\documentclass{article}\n\\begin{document}\n$x^2 + 1 = 0$\n\\end{document}\n\`\`\`\nHope this helps!`;
    expect(extractTex(raw)).toBe(`\\documentclass{article}\n\\begin{document}\n$x^2 + 1 = 0$\n\\end{document}`);
  });

  it("summarizes pdflatex error lines concisely", () => {
    const log = [
      "This is pdfTeX, Version 3.141592653",
      "entering extended mode",
      "./main.tex:12: Undefined control sequence.",
      "l.12 \\foo",
      "          + 1",
      "! Emergency stop.",
    ].join("\n");
    const summary = summarizeLatexError(log);
    expect(summary).toContain("Undefined control sequence");
    expect(summary).toContain("\\foo");
  });

  it("builds clear conversion and fix prompts", () => {
    const p = buildLatexConvertPrompt({ imagePaths: ["/tmp/p1.png", "/tmp/p2.png"], title: "Proof 1", language: "German", compiler: "pdflatex" });
    expect(p).toContain("/tmp/p1.png");
    expect(p).toContain("/tmp/p2.png");
    expect(p).toContain("Proof 1");
    expect(p).toContain("German");
    expect(p).toContain("pdflatex");

    const f = buildLatexFixPrompt("\\documentclass{article}", "Undefined control sequence");
    expect(f).toContain("Undefined control sequence");
    expect(f).toContain("\\documentclass{article}");
  });

  it("rejects empty or oversized input without spawning a compiler", async () => {
    const empty = await compileLatex("   ");
    expect(empty.ok).toBe(false);
    const huge = await compileLatex("a".repeat(600_000));
    expect(huge.ok).toBe(false);
  });
});

describe("Local pdflatex compilation", () => {
  it("compiles a valid standalone .tex document into a real PDF", async () => {
    const status = await latexStatus();
    if (!status.available) return;
    const tex = [
      "\\documentclass[11pt]{article}",
      "\\usepackage{amsmath,amssymb}",
      "\\begin{document}",
      "\\section*{Test Proof}",
      "For all $n \\in \\mathbb{N}$, $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$.",
      "\\end{document}",
    ].join("\n");
    const res = await compileLatex(tex);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(res.pdf.byteLength).toBeGreaterThan(1000);
    }
  });

  it("returns a helpful error on broken LaTeX", async () => {
    const status = await latexStatus();
    if (!status.available) return;
    const res = await compileLatex("\\documentclass{article}\\begin{document}\\definitelyNotACommand\\end{document}");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Undefined control sequence|Emergency stop|failed/i);
    }
  });

  it("blocks reading files outside the temp dir (openin_any=p)", async () => {
    const status = await latexStatus();
    if (!status.available) return;
    const res = await compileLatex("\\documentclass{article}\\begin{document}\\input{/etc/passwd}\\end{document}");
    expect(res.ok).toBe(false);
  });
});
