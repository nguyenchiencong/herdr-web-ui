/**
 * UI text. The English string is the key: `t("Rename pane")`, `t("Worked for {duration}", { duration })`.
 * `t` fills the placeholders and otherwise gives the key back as it is written.
 *
 * Components take `t` from `useT()`. Helpers outside React (status labels, shortcut labels, work
 * summaries) import `t` directly.
 */

export type Vars = Record<string, string | number>;

/** The text for `key` with its placeholders filled; a placeholder `vars` does not name stays as written. */
export function t(key: string, vars?: Vars): string {
  if (vars === undefined) return key;
  return key.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export type Translate = typeof t;

/** `t`, for components. */
export function useT(): Translate {
  return t;
}

/** The BCP 47 tag dates, numbers and language names are formatted in. */
export const LOCALE = "en-US";
