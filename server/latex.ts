/**
 * Local LaTeX compilation (pdflatex / lualatex / tectonic) and prompt helpers
 * for converting handwritten scratchpad sheets into real, compilable .tex & PDF.
 *
 * Security: AI-generated .tex is compiled in an isolated temp directory with
 * shell-escape disabled and kpathsea openin_any=p / openout_any=p so TeX can
 * never execute commands or read/write files outside the temp folder.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cached, runQuick } from "./providers/types.ts";

export const MAX_TEX_BYTES = 500_000;

type Compiler = { name: "pdflatex" | "tectonic"; bin: string };

const detectCompiler = cached<Compiler | null>(5 * 60_000, async () => {
  // Note: lualatex is intentionally excluded from auto-detection because Lua's io.open
  // can bypass kpathsea openin_any restrictions. Users can still set PDFLATEX_BIN explicitly.
  const candidates: Compiler[] = [
    ...(process.env.PDFLATEX_BIN ? [{ name: "pdflatex" as const, bin: process.env.PDFLATEX_BIN }] : []),
    { name: "pdflatex", bin: "pdflatex" },
    { name: "tectonic", bin: "tectonic" },
  ];
  for (const c of candidates) {
    const r = await runQuick(c.bin, ["--version"], { timeout: 5_000 });
    if (r.ok) return c;
  }
  return null;
});

export async function latexStatus(): Promise<{ available: boolean; compiler: string | null }> {
  const c = await detectCompiler();
  return { available: !!c, compiler: c?.name ?? null };
}

/** Pull clean .tex source out of an AI answer (strips markdown fences and surrounding prose). */
export function extractTex(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:latex|tex)?\s*\n([\s\S]*?)```/i);
  let body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("\\documentclass");
  const end = body.lastIndexOf("\\end{document}");
  if (start !== -1 && end !== -1 && end > start) {
    body = body.slice(start, end + "\\end{document}".length).trim();
  }
  return body;
}

/** Pull the most helpful lines out of a pdflatex log on failure. */
export function summarizeLatexError(log: string): string {
  const lines = log.split(/\r?\n/);
  const picked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^! |^(?:\.\/)?main\.tex:\d+:|LaTeX Error:|Undefined control sequence|Missing .* inserted|Emergency stop/.test(l)) {
      picked.push(...lines.slice(i, Math.min(lines.length, i + 4)));
      i += 3;
      if (picked.length >= 24) break;
    }
  }
  const summary = (picked.length ? picked : lines.slice(-20)).join("\n").trim();
  return summary.slice(0, 3000) || "LaTeX compilation failed.";
}

export type CompileResult =
  | { ok: true; pdf: Buffer; log: string; compiler: string }
  | { ok: false; error: string; log: string; compiler: string | null };

/** Compile standalone .tex source to a PDF buffer in a sandboxed temp directory. */
export async function compileLatex(tex: string, opts: { timeoutMs?: number } = {}): Promise<CompileResult> {
  if (typeof tex !== "string" || !tex.trim()) return { ok: false, error: "LaTeX source is empty.", log: "", compiler: null };
  if (Buffer.byteLength(tex, "utf8") > MAX_TEX_BYTES) return { ok: false, error: "LaTeX source is too large (max 500 kB).", log: "", compiler: null };
  const compiler = await detectCompiler();
  if (!compiler) {
    return {
      ok: false,
      error: "No LaTeX compiler found (pdflatex, lualatex, or tectonic). Install TeX Live or set PDFLATEX_BIN.",
      log: "",
      compiler: null,
    };
  }

  const work = await mkdtemp(path.join(tmpdir(), "ydust-tex-"));
  const timeout = opts.timeoutMs ?? 25_000;
  try {
    await writeFile(path.join(work, "main.tex"), tex, "utf8");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Paranoia mode: TeX may only read/write inside the isolated temp directory.
      openin_any: "p",
      openout_any: "p",
      max_print_line: "1000",
    };
    const args =
      compiler.name === "tectonic"
        ? ["-X", "compile", "main.tex"]
        : ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"];

    let res = await runQuick(compiler.bin, args, { timeout, cwd: work, env });
    // Second pass if references/labels need resolving.
    if (res.ok && compiler.name !== "tectonic" && /Rerun to get|Label\(s\) may have changed/i.test(res.stdout)) {
      res = await runQuick(compiler.bin, args, { timeout, cwd: work, env });
    }
    const logFile = await readFile(path.join(work, "main.log"), "utf8").catch(() => "");
    const fullLog = (res.stdout + "\n" + res.stderr + "\n" + logFile).trim();
    if (!res.ok) {
      const primary = (res.stdout + "\n" + res.stderr).trim();
      return { ok: false, error: summarizeLatexError(primary || logFile), log: fullLog.slice(-12_000), compiler: compiler.name };
    }
    const pdf = await readFile(path.join(work, "main.pdf")).catch(() => null);
    if (!pdf) {
      return { ok: false, error: "Compiler exited cleanly but produced no PDF.", log: fullLog.slice(-12_000), compiler: compiler.name };
    }
    return { ok: true, pdf, log: fullLog.slice(-8_000), compiler: compiler.name };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export function buildLatexConvertPrompt(opts: { imagePaths: string[]; title?: string; language?: string; compiler?: string | null }) {
  const n = opts.imagePaths.length;
  const usesPdflatex = !opts.compiler || opts.compiler === "pdflatex";
  const langHint = opts.language
    ? `Keep prose/headings in ${opts.language} (or the language written in the handwriting if clearer).`
    : `Keep prose/headings in the exact language written in the handwriting (e.g. German with \\usepackage[ngerman]{babel} if German).`;
  return [
    `Convert the attached handwritten ${n === 1 ? "page" : `${n} pages`} into a clean, standalone, immediately compilable LaTeX (.tex) document.`,
    opts.title ? `Document title context: "${opts.title}".` : "",
    `Read ${n === 1 ? "the image" : "all images in order"} with your file-reading tool:`,
    opts.imagePaths.map((p, i) => `${i + 1}. ${p}`).join("\n"),
    ``,
    `Requirements:`,
    `- Output ONLY the complete .tex source (starting with \\documentclass and ending with \\end{document}), with no explanations before or after.`,
    `- Use \\documentclass[11pt,a4paper]{article} and standard packages only (amsmath, amssymb, amsthm, mathtools, enumitem, geometry).`,
    usesPdflatex
      ? `- Target pdflatex: include \\usepackage[utf8]{inputenc} and \\usepackage[T1]{fontenc}; avoid Unicode math characters in formulas (use LaTeX macros like \\alpha, \\mathbb{R}, \\implies).`
      : `- Target ${opts.compiler}: standard UTF-8 LaTeX.`,
    `- ${langHint}`,
    `- Preserve every mathematical step, definition, theorem, calculation, and proof structure faithfully. Use align*/gather*/proof environments cleanly. Do NOT invent steps that aren't written, and mark any genuinely illegible word as [?].`,
    `- Never use \\write18, external image files, or non-standard packages.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildLatexFixPrompt(tex: string, errorLog: string) {
  return [
    `The following LaTeX document failed to compile with pdflatex. Fix the LaTeX errors while keeping all mathematical content intact.`,
    `Output ONLY the complete fixed .tex source (from \\documentclass to \\end{document}), with no prose.`,
    ``,
    `Compiler error:`,
    `\`\`\``,
    errorLog.slice(0, 3000),
    `\`\`\``,
    ``,
    `Current .tex:`,
    `\`\`\`latex`,
    tex.slice(0, 60_000),
    `\`\`\``,
  ].join("\n");
}
