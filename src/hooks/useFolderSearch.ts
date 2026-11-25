import { useEffect, useState } from "react";
import { api, type FolderHits } from "../lib/api";

/** Search in all documents of a folder (on the server, which has their texts). */
export function useFolderSearch(folderId: string | null, query: string, active: boolean) {
  const [result, setResult] = useState<{ key: string; data: FolderHits } | null>(null);
  const [failed, setFailed] = useState(false);
  const q = query.trim();
  const key = active && folderId && q.length >= 2 ? `${folderId}\n${q}` : null;

  useEffect(() => {
    setFailed(false);
    if (!key || !folderId) return;
    const abort = new AbortController();
    const t = setTimeout(() => {
      api.searchFolder(folderId, q, abort.signal).then(
        (data) => setResult({ key, data }),
        () => !abort.signal.aborted && setFailed(true),
      );
    }, 250);
    return () => {
      clearTimeout(t);
      abort.abort();
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = key && result?.key === key ? result.data : null;
  return { data, loading: !!key && !data && !failed, failed };
}
