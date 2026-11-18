import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchState } from "../components/PdfViewer";
import type { SearchHit } from "../components/SearchBar";
import { api } from "../lib/api";
import { findInString, snippet } from "../lib/textMatch";

const MAX_HITS = 1000;

/**
 * Search in the open document (Ctrl+F): across all pages, from document.txt (the PDF viewer
 * only has the text of the pages it rendered). `page`: where you are reading, to start there.
 */
export function useDocSearch(doc: { id: string; hasText: boolean | null } | null, page: number) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [textsVersion, setTextsVersion] = useState(0);
  const texts = useRef<{ id: string; pages: string[] } | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;

  // The page texts, once per document (again after a new extraction, see `forget`).
  useEffect(() => {
    if (!open || !doc || texts.current?.id === doc.id || !doc.hasText) return;
    let cancelled = false;
    setLoading(true);
    api
      .pages(doc.id)
      .then((r) => {
        if (cancelled) return;
        texts.current = { id: doc.id, pages: r.pages };
        setTextsVersion((v) => v + 1);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, doc?.id, doc?.hasText, textsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = query.trim();
    const pages = texts.current?.id === doc?.id ? texts.current?.pages : null;
    if (!open || q.length < 2 || !pages) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      const found: SearchHit[] = [];
      pages.forEach((text, i) => {
        findInString(text, q, MAX_HITS - found.length).forEach(([a, b], n) => found.push({ page: i + 1, n, ...snippet(text, a, b) }));
      });
      setHits(found);
      // Start at the first hit at or after the page you're reading.
      const from = found.findIndex((h) => h.page >= pageRef.current);
      setIndex(from === -1 ? 0 : from);
      setNonce(Date.now());
    }, 180);
    return () => clearTimeout(t);
  }, [query, open, textsVersion, doc?.id]);

  /** What the PDF viewer marks: the query and the active hit. */
  const state = useMemo<SearchState | null>(() => {
    if (!open || query.trim().length < 2) return null;
    const h = hits[index];
    return { query: query.trim(), current: h ? { page: h.page, n: h.n } : null, nonce };
  }, [open, query, hits, index, nonce]);

  return {
    open,
    query,
    setQuery,
    hits,
    index,
    loading,
    focusNonce,
    state,
    /** Open the search bar and put the cursor in it. */
    show: useCallback(() => {
      setOpen(true);
      setFocusNonce(Date.now());
    }, []),
    toggle: useCallback(() => {
      setOpen((o) => !o);
      setFocusNonce(Date.now());
    }, []),
    close: useCallback(() => setOpen(false), []),
    /** Show the i-th hit (again). */
    go: useCallback((i: number) => {
      setIndex(i);
      setNonce(Date.now());
    }, []),
    /** That document's text was extracted anew: load it again when searching. */
    forget: useCallback((id: string) => {
      if (texts.current?.id === id) {
        texts.current = null;
        setTextsVersion((v) => v + 1);
      }
    }, []),
  };
}
