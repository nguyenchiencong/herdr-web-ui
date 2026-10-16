/**
 * UI text in the user's language. The English string is the key: `t("Rename pane")`,
 * `t("Worked for {duration}", { duration })`. A key a dictionary (i18n.ko.ts, i18n.ja.ts,
 * i18n.zh.ts) lacks comes back in English, so a new string is never blank, and
 * src/lib/i18n.test.ts scans the code for every `t("…")` and fails when one is missing from
 * any dictionary. A dictionary is a chunk of its own, loaded by `loadLanguage` before the UI draws in
 * its language (main.tsx, and SettingsProvider when the language changes).
 *
 * Components take `t` from `useT()`, whose identity changes with the language so memoized
 * work is redone. Helpers outside React (status labels, shortcut labels, work summaries)
 * call the module-level `t`, which reads the language the SettingsProvider last set.
 */
import { useMemo } from "react";
import { lazyChunk } from "./lazyChunk.ts";
import { useSettings } from "./settings.ts";

// in the order the Language menu lists them
export const LANGUAGE_SETTINGS = ["system", "en", "zh", "ja", "ko"] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];
export type Language = Exclude<LanguageSetting, "system">;

export const LANGUAGE_NAMES: Record<LanguageSetting, string> = { system: "System", en: "English", ko: "한국어", ja: "日本語", zh: "简体中文" };

/** The BCP 47 tag for `<html lang>` and Intl formatting. */
export const LOCALE_TAGS: Record<Language, string> = { en: "en-US", ko: "ko-KR", ja: "ja-JP", zh: "zh-CN" };

// English is the key itself, so it has no dictionary. Every other language's dictionary is a chunk of
// its own, fetched the first time the UI is in that language; lazyChunk tells a failed fetch (the app
// offers a reload) and never tries it again.
const LOAD_DICTIONARY: Record<Exclude<Language, "en">, () => Promise<Record<string, string>>> = {
  ko: lazyChunk(() => import("./i18n.ko.ts").then((module) => module.KO)),
  ja: lazyChunk(() => import("./i18n.ja.ts").then((module) => module.JA)),
  zh: lazyChunk(() => import("./i18n.zh.ts").then((module) => module.ZH)),
};
const DICTIONARIES: Partial<Record<Language, Record<string, string>>> = {};

/** Whether `language`'s text can be drawn now: English always, another language once its dictionary is in. */
export function isLanguageLoaded(language: Language): boolean {
  return language === "en" || DICTIONARIES[language] !== undefined;
}

/**
 * Brings `language`'s dictionary in (at once for English) and resolves once it is. A dictionary that
 * fails to load leaves its strings in English, the same fallback a key without a translation gets.
 */
export async function loadLanguage(language: Language): Promise<void> {
  if (language === "en" || DICTIONARIES[language] !== undefined) return;
  try {
    DICTIONARIES[language] = await LOAD_DICTIONARY[language]();
  } catch {
    DICTIONARIES[language] = {};
  }
}

/**
 * `system` follows the browser: the first tag in its list for a supported language picks it
 * (`["en-US", "ko"]` is English), otherwise English. Any Chinese tag, zh-TW included, picks
 * Simplified Chinese, the only Chinese there is.
 */
export function resolveLanguage(setting: LanguageSetting, languages: readonly string[] = typeof navigator !== "undefined" ? navigator.languages : []): Language {
  if (setting !== "system") return setting;
  for (const tag of languages) {
    const match = /^(en|ko|ja|zh)\b/i.exec(tag);
    if (match) return match[1]!.toLowerCase() as Language;
  }
  return "en";
}

let current: Language = "en";

export function setCurrentLanguage(language: Language): void {
  current = language;
}

export function currentLanguage(): Language {
  return current;
}

/** The BCP 47 tag of the language the SettingsProvider last set, for Intl outside React. */
export function currentLocale(): string {
  return LOCALE_TAGS[current];
}

export type Vars = Record<string, string | number>;

/** The text for `key` in `language`, placeholders filled; pure, for tests and for both `t`s. */
export function translate(language: Language, key: string, vars?: Vars): string {
  const text = DICTIONARIES[language]?.[key] ?? key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function t(key: string, vars?: Vars): string {
  return translate(current, key, vars);
}

export type Translate = (key: string, vars?: Vars) => string;

/** `t` bound to the current language, a new function whenever the language changes. */
export function useT(): Translate {
  const { resolvedLanguage } = useSettings();
  return useMemo<Translate>(() => (key, vars) => translate(resolvedLanguage, key, vars), [resolvedLanguage]);
}

/** The BCP 47 tag for Intl formatting in the current language. */
export function useLocale(): string {
  const { resolvedLanguage } = useSettings();
  return LOCALE_TAGS[resolvedLanguage];
}
