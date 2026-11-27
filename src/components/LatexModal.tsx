import { Check, Copy, Download, FileCode2, FileOutput, FolderPlus, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, LatexCompileError, type DocSummary, type LatexStatus } from "../lib/api";
import { downloadText, safeFilename } from "../lib/export";

type Props = {
  title: string;
  converting: boolean;
  convertError: string | null;
  tex: string;
  onChangeTex: (tex: string) => void;
  onFixWithAi: (tex: string, errorLog: string) => Promise<void>;
  fixing: boolean;
  folderName: string | null;
  folderId: string | null;
  onImported: (doc: DocSummary) => void;
  onClose: () => void;
};

export function LatexModal({
  title,
  converting,
  convertError,
  tex,
  onChangeTex,
  onFixWithAi,
  fixing,
  folderName,
  folderId,
  onImported,
  onClose,
}: Props) {
  const [filename, setFilename] = useState(() => safeFilename(title || "Handwritten Notes"));
  const [status, setStatus] = useState<LatexStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [importing, setImporting] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileLog, setCompileLog] = useState<string>("");
  const [showLog, setShowLog] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    api
      .latexStatus()
      .then(setStatus)
      .catch(() => setStatus({ available: false, compiler: null }));
  }, []);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyTex = async () => {
    try {
      await navigator.clipboard.writeText(tex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be blocked */
    }
  };

  const downloadTex = () => {
    const base = safeFilename(filename || title || "notes");
    downloadText(`${base}.tex`, tex);
  };

  const compile = async () => {
    if (!tex.trim() || compiling) return;
    setCompiling(true);
    setCompileError(null);
    setCompileLog("");
    try {
      const blob = await api.compileLatexPdf(tex, filename);
      const nextUrl = URL.createObjectURL(blob);
      setPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch (e) {
      if (e instanceof LatexCompileError) {
        setCompileError(e.message);
        setCompileLog(e.log);
      } else {
        setCompileError((e as Error).message);
      }
    } finally {
      setCompiling(false);
    }
  };

  const downloadPdf = () => {
    if (!pdfUrl) return;
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = `${safeFilename(filename || title || "notes")}.pdf`;
    a.click();
  };

  const importPdf = async () => {
    if (!tex.trim() || importing) return;
    setImporting(true);
    setCompileError(null);
    setCompileLog("");
    try {
      const doc = await api.importLatexPdf(tex, filename || title || "Handwritten Notes", folderId);
      onImported(doc);
      onClose();
    } catch (e) {
      if (e instanceof LatexCompileError) {
        setCompileError(e.message);
        setCompileLog(e.log);
      } else {
        setCompileError((e as Error).message);
      }
    } finally {
      setImporting(false);
    }
  };

  const busy = converting || fixing;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <FileCode2 className="size-4 text-violet-600 dark:text-violet-400" />
          <h2 className="text-sm font-semibold">LaTeX &amp; PDF</h2>
          {status && (
            <span
              className={
                status.available
                  ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : "rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
              }
            >
              {status.available ? status.compiler : "No TeX compiler found"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="Document name"
              aria-label="Document name"
              className="w-44 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button onClick={onClose} className="icon-btn" title="Close (Esc)">
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-2 dark:border-zinc-900">
          <button
            onClick={copyTex}
            disabled={!tex || busy}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy .tex"}
          </button>
          <button
            onClick={downloadTex}
            disabled={!tex || busy}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            <Download className="size-3.5" />
            Download .tex
          </button>
          <button
            onClick={compile}
            disabled={!tex || busy || compiling || status?.available === false}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            title={status?.available === false ? "Install pdflatex / TeX Live to compile PDFs locally" : "Compile locally with pdflatex"}
          >
            {compiling ? <Loader2 className="size-3.5 animate-spin" /> : <FileOutput className="size-3.5" />}
            {compiling ? "Compiling…" : "Compile to PDF"}
          </button>

          {pdfUrl && (
            <>
              <button
                onClick={downloadPdf}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300"
              >
                <Download className="size-3.5" />
                Download PDF
              </button>
              <button
                onClick={importPdf}
                disabled={importing || busy}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                title={folderName ? `Import compiled PDF into folder “${folderName}”` : "Import compiled PDF into your library"}
              >
                {importing ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
                {folderName ? `Import into “${folderName}”` : "Import into Library"}
              </button>
            </>
          )}
        </div>

        {convertError && (
          <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{convertError}</span>
          </div>
        )}

        {compileError && (
          <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">LaTeX compilation failed</p>
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-90">{compileError}</pre>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void onFixWithAi(tex, compileError + (compileLog ? "\n" + compileLog : ""))}
                    disabled={fixing || compiling}
                    className="flex items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
                  >
                    {fixing ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                    {fixing ? "Fixing with AI…" : "Fix with AI"}
                  </button>
                  {compileLog && (
                    <button onClick={() => setShowLog((v) => !v)} className="text-[11px] underline opacity-80 hover:opacity-100">
                      {showLog ? "Hide full log" : "Show full log"}
                    </button>
                  )}
                </div>
                {showLog && compileLog && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/5 p-2 font-mono text-[10px] dark:bg-white/5">{compileLog}</pre>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-zinc-200 dark:divide-zinc-800 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="relative flex min-h-0 flex-col">
            {busy ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-zinc-500">
                <Loader2 className="size-6 animate-spin text-violet-600" />
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  {fixing ? "Fixing LaTeX errors…" : "Converting handwriting to LaTeX…"}
                </p>
                <p className="max-w-xs text-xs">Your local AI assistant is transcribing the handwritten sheet into clean, compilable .tex.</p>
              </div>
            ) : (
              <textarea
                value={tex}
                onChange={(e) => onChangeTex(e.target.value)}
                spellCheck={false}
                placeholder="% Standalone LaTeX (.tex) source appears here…"
                className="min-h-0 flex-1 resize-none bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-900 outline-none dark:bg-zinc-950 dark:text-zinc-100"
              />
            )}
          </div>

          <div className="flex min-h-0 flex-col bg-zinc-100 dark:bg-zinc-900">
            {pdfUrl ? (
              <iframe src={pdfUrl} title="Compiled PDF Preview" className="h-full w-full border-0" />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-zinc-500">
                <FileOutput className="mb-3 size-8 opacity-40" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">PDF Preview</p>
                <p className="mt-1 max-w-xs text-xs">
                  {status?.available === false
                    ? "Install pdflatex (TeX Live) on this machine to compile your .tex into a PDF directly here."
                    : "Review or tweak the LaTeX on the left, then click “Compile to PDF” to render it locally."}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
