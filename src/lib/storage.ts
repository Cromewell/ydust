/** The app's preferences in localStorage ("ydust:<key>"); never throws (private mode, blocked storage). */
export const store = {
  get(key: string) {
    try {
      return localStorage.getItem(`ydust:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`ydust:${key}`, value);
    } catch {
      /* ignore */
    }
  },
};
