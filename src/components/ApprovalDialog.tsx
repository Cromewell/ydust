import { Check, Globe, Loader2, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Approval } from "../lib/api";

/**
 * "Claude wants to search the web for: …" — every query needs a click. Edit changes the query
 * before allowing it. The assistant waits meanwhile (and gives up after 5 minutes).
 */
export function ApprovalDialog({
  approval,
  by,
  onDecide,
}: {
  approval: Approval;
  /** Which assistant asks ("Claude"). */
  by: string;
  onDecide: (decision: "allow" | "deny", query?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState(approval.query);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEditing(false);
    setQuery(approval.query);
    setError(null);
    allowRef.current?.focus();
  }, [approval.id, approval.query]);

  const decide = async (decision: "allow" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, decision === "allow" && editing ? query.trim() : undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-zinc-950/30 p-4 pt-[15vh] backdrop-blur-[1px]">
      <div
        role="alertdialog"
        aria-labelledby="approval-title"
        aria-describedby="approval-query"
        onKeyDown={(e) => e.key === "Escape" && !busy && void decide("deny")}
        className="animate-pop w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
            <Globe className="size-4" />
          </span>
          <h2 id="approval-title" className="flex-1 text-sm font-semibold">
            {by} wants to search the web for:
          </h2>
          {approval.n > 1 && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800">search {approval.n}</span>}
        </div>
        {editing ? (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && query.trim() && void decide("allow")}
            maxLength={500}
            className="w-full rounded-lg border border-sky-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/20 dark:border-sky-500/40 dark:bg-zinc-950"
            aria-label="Search query"
          />
        ) : (
          <p id="approval-query" className="rounded-lg bg-zinc-50 px-3 py-2 text-sm break-words dark:bg-zinc-950">
            {approval.query}
          </p>
        )}
        <p className="mt-2 text-[11px] text-zinc-500">The query goes to the search provider. Nothing from your documents is sent unless it is in the query.</p>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex items-center gap-2">
          <button
            ref={allowRef}
            onClick={() => void decide("allow")}
            disabled={busy || (editing && !query.trim())}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {editing ? "Search this" : "Allow"}
          </button>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <Pencil className="size-3.5" /> Edit
            </button>
          )}
          <button
            onClick={() => void decide("deny")}
            disabled={busy}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-red-500/10"
          >
            <X className="size-3.5" /> Deny
          </button>
        </div>
      </div>
    </div>
  );
}
