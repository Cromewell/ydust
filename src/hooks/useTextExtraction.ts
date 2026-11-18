import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DocSummary } from "../lib/api";
import { TEXT_VERSION, extractAllText, loadPdf, type PDFDocumentProxy } from "../lib/pdf";

/** Text not extracted yet, or by an older extraction. */
export const needsText = (d: { hasText: boolean | null; textVersion?: number }) => d.hasText === null || (d.textVersion ?? 1) < TEXT_VERSION;

/**
 * Text extraction: every document's pages go to document.txt (and its outline to outline.txt),
 * so the assistant and the search can read all of it. The open document is extracted from
 * its loaded PDF (`extract(id, pdf)`); the others one at a time in the background.
 * `onDone` gets the document's new summary (pages, hasText).
 */
export function useTextExtraction(docs: DocSummary[], activeId: string | null, onDone: (summary: DocSummary) => void) {
  /** Progress per document while it is read. */
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  const jobs = useRef(new Map<string, Promise<void>>());
  const failed = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;

  const extract = useCallback((id: string, loaded?: PDFDocumentProxy) => {
    const running = jobs.current.get(id);
    if (running) return running;
    const job = (async () => {
      const task = loaded ? null : loadPdf(api.fileUrl(id));
      try {
        const p = loaded ?? (await task!.promise);
        setProgress((x) => ({ ...x, [id]: { done: 0, total: p.numPages } }));
        const { pages, outline } = await extractAllText(p, (n, total) => setProgress((x) => ({ ...x, [id]: { done: n, total } })));
        done.current(await api.putText(id, pages, TEXT_VERSION, outline));
      } catch {
        // An open document's PDF is destroyed when you switch away: retried in the background.
        if (!loaded) failed.current.add(id);
      } finally {
        void task?.destroy();
        setProgress(({ [id]: _, ...rest }) => rest);
        jobs.current.delete(id);
        setTick((t) => t + 1);
      }
    })();
    jobs.current.set(id, job);
    return job;
  }, []);

  // In the background, one at a time: every document that isn't extracted (or is outdated).
  useEffect(() => {
    if (jobs.current.size) return;
    const next = docs.find((d) => d.id !== activeId && needsText(d) && !failed.current.has(d.id));
    if (next) void extract(next.id);
  }, [docs, activeId, tick, extract]);

  return { progress, extract };
}
