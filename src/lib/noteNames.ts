/**
 * Names of note files ("summary.md"), shared by the server (which enforces them) and the
 * browser (which suggests and pre-checks them). A valid name is a plain file name that
 * means the same on Linux, macOS and Windows: no path, no hidden file, no reserved name.
 */

export const MAX_NOTE_NAME = 80;

// Letters and digits of any script, space, dot, underscore, hyphen.
const ALLOWED = /^[\p{L}\p{N} ._-]+$/u;
// Windows reserves these as device names, with any extension ("con.md", "COM1.notes.md").
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Why `name` can't be a note's file name, or null if it can. */
export function noteNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "The name is empty.";
  if (name.length > MAX_NOTE_NAME) return `The name is longer than ${MAX_NOTE_NAME} characters.`;
  if (name !== name.normalize("NFC")) return "The name is not in normalized form.";
  if (!name.endsWith(".md")) return "The name must end in .md.";
  if (!ALLOWED.test(name)) return "Use only letters, digits, spaces, dots, _ and -.";
  if (name.startsWith(".") || name.startsWith(" ")) return "The name can't start with a dot or a space.";
  if (name === ".md" || name.slice(0, -3).trim() === "" || /[ .]$/.test(name.slice(0, -3))) return "The name needs a word before .md.";
  if (RESERVED.test(name.split(".")[0].trim())) return "That name is reserved on Windows.";
  return null;
}

export const isValidNoteName = (name: unknown): name is string => noteNameProblem(name) === null;

/**
 * Turn what someone typed ("Chapter 3: Limits") into a valid name ("Chapter 3 Limits.md"),
 * or null if nothing usable is left.
 */
export function toNoteName(input: string): string | null {
  let base = input.normalize("NFC").trim().replace(/\.md$/i, "");
  base = base
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "");
  base = base.slice(0, MAX_NOTE_NAME - 3).replace(/[ .]+$/, "");
  if (!base) return null;
  const name = `${base}.md`;
  return isValidNoteName(name) ? name : `${base}_.md`.length <= MAX_NOTE_NAME && isValidNoteName(`${base}_.md`) ? `${base}_.md` : null;
}

/** Same name on a case-insensitive file system (Windows, macOS)? */
export const sameNoteName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
