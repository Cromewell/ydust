import { createContext, useContext } from "react";
import type { PageLabels } from "../lib/pageLabels";

/** Which labels (printed page numbers) apply where pages are shown. */
export type PageLabelLookup = {
  /** For a page link: its document's alias (none: the open PDF) and its text. */
  cite: (alias?: string, text?: string) => PageLabels;
  /** For a document (none: the one the chat is about, else the open PDF). */
  doc: (id?: string) => PageLabels;
};

export const PageLabelContext = createContext<PageLabelLookup>({ cite: () => undefined, doc: () => undefined });
export const usePageLabels = () => useContext(PageLabelContext);
