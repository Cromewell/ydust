import clsx from "clsx";
import { ChevronRight, ListTree, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePageLabels } from "../hooks/usePageLabels";
import { pageLabel } from "../lib/pageLabels";
import { loadOutline, type OutlineNode as Node, type PDFDocumentProxy } from "../lib/pdf";

export function OutlinePanel({
  pdf,
  page,
  onJump,
  onClose,
  header,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  onJump: (page: number) => void;
  onClose: () => void;
  /** Replaces the default header (e.g. Contents | Highlights tabs). */
  header?: React.ReactNode;
}) {
  const labels = usePageLabels().cite();
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setNodes(null);
    loadOutline(pdf).then(
      (n) => {
        if (cancelled) return;
        setNodes(n);
        setOpen(new Set(n.length <= 12 ? n.map((x) => x.id) : [])); // small outlines start expanded
      },
      () => !cancelled && setNodes([]),
    );
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  // The entry you're currently reading: the last one (in reading order) that starts at or before this page.
  const { activeId, ancestors } = useMemo(() => {
    let activeId: string | null = null;
    let ancestors: string[] = [];
    const visit = (list: Node[], path: string[]) => {
      for (const node of list) {
        if (node.page != null && node.page <= page) {
          activeId = node.id;
          ancestors = path;
        }
        visit(node.children, [...path, node.id]);
      }
    };
    visit(nodes ?? [], []);
    return { activeId, ancestors };
  }, [nodes, page]);

  // Keep the active entry visible.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (list: Node[], depth: number) =>
    list.map((node) => {
      const expanded = open.has(node.id) || ancestors.includes(node.id);
      const active = node.id === activeId;
      return (
        <li key={node.id}>
          <div className="flex items-start" style={{ paddingLeft: depth * 12 }}>
            {node.children.length ? (
              <button
                type="button"
                onClick={() => toggle(node.id)}
                className="mt-1 flex size-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                <ChevronRight className={clsx("size-3.5 transition", expanded && "rotate-90")} />
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <button
              ref={active ? activeRef : undefined}
              type="button"
              disabled={node.page == null}
              onClick={() => node.page != null && onJump(node.page)}
              className={clsx(
                "flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[13px] leading-snug transition disabled:opacity-50",
                active
                  ? "bg-violet-100 font-medium text-violet-800 dark:bg-violet-500/15 dark:text-violet-200"
                  : "text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )}
            >
              <span className="min-w-0 flex-1">{node.title}</span>
              {node.page != null && <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">{pageLabel(labels, node.page)}</span>}
            </button>
          </div>
          {expanded && node.children.length > 0 && <ul>{render(node.children, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-950">
      {header ?? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
          <ListTree className="size-4 text-zinc-400" />
          <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Contents</span>
          <button onClick={onClose} className="icon-btn ml-auto size-7" title="Close contents">
            <X className="size-4" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {nodes === null ? (
          <div className="flex justify-center p-6 text-zinc-400">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : nodes.length === 0 ? (
          <p className="p-4 text-xs leading-relaxed text-zinc-500">
            This PDF has no built-in table of contents. Use search (Ctrl+F) to find chapters.
          </p>
        ) : (
          <ul>{render(nodes, 0)}</ul>
        )}
      </div>
    </div>
  );
}
