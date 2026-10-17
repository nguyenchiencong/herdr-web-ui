import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { InteractivePrompt } from "../shared/protocol.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

/** pi 1.3.0's `/resume` picker as its own component renders it (server/fixtures/pi-session-picker/README.md). */
const picker = (name: string): string => readFileSync(new URL(`./fixtures/pi-session-picker/${name}`, import.meta.url), "utf8");
const parse = (name: string): InteractivePrompt | null => parseInteractivePrompt("pi", picker(name));
const WIDTHS = [120, 46, 36] as const;
const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);
const actionIds = (prompt: InteractivePrompt | null) => prompt?.actions?.map((action) => action.id);
/** an answer as the route receives it: the test names a kind the card may not offer, to see it refused */
const answerOf = (value: Record<string, unknown>) => value as Parameters<typeof answerKeys>[1];
const keysOf = (steps: ReturnType<typeof answerKeys>) => steps.flatMap((step) => step.keys ?? []);

describe("pi's session picker", () => {
  test("reads the current folder's list at 120, 46 and 36 columns: its rows, its scope and its search", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`list-${width}.txt`);
      expect(prompt).toMatchObject({
        agent: "pi",
        kind: "question",
        title: "",
        question: "Resume a session in this folder",
        multi_select: false,
        custom_option_index: null,
        window: { first: 0, total: 3 },
        search: { value: "" },
      });
      expect(labels(prompt)?.[0]).toBe("refactor the sleep card");
      expect(prompt?.options).toHaveLength(3);
      expect(actionIds(prompt)).toEqual(["scope", "cancel"]);
      expect(prompt?.actions?.[0]).toEqual({ id: "scope", label: "All", to: "all" });
    }
  });

  test("reads a long list as pi windows it: ten rows around the cursor, the counter's place in the whole list", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`cursor-15-of-23-${width}.txt`);
      // the cursor is session 15 of 23: the window starts five rows above it, at the tenth session
      expect(prompt?.window).toEqual({ first: 9, total: 23 });
      expect(prompt?.options).toHaveLength(10);
      expect(labels(prompt)?.[5]).toBe("session 14: hello");
      expect(actionIds(prompt)).toEqual(["scope", "earlier", "later", "cancel"]);
    }
  });

  test("reads a search: the text on the search line, and the matching rows with their counter", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`search-thing-${width}.txt`);
      expect(prompt?.search).toEqual({ value: "session 1" });
      expect(prompt?.window).toEqual({ first: 0, total: 12 });
      expect(prompt?.options).toHaveLength(10);
      expect(labels(prompt)?.[0]?.startsWith("session 1")).toBe(true);
    }
  });

  test("reads All with each row's folder, and offers the other scope", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`scope-all-${width}.txt`);
      expect(prompt?.question).toBe("Resume a session from any folder");
      expect(prompt?.options[0]?.description).toBe("C:/Users/x/Dev/app \u00b7 3 messages");
      expect(actionIds(prompt)).toEqual(["scope", "cancel"]);
      expect(prompt?.actions?.[0]).toEqual({ id: "scope", label: "Current folder", to: "current" });
    }
  });

  test("reads a forked list with its tree branches, none of which is part of a label", () => {
    for (const width of WIDTHS) {
      expect(labels(parse(`tree-${width}.txt`))).toEqual(["root message", "fork a", "grand", "root message"]);
    }
  });

  test("offers Cancel alone while a delete is asked in the terminal: no row, no search, no paging", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`delete-confirm-${width}.txt`);
      expect(prompt?.question).toBe("Delete this session? Cancel keeps every session.");
      expect(prompt?.options).toEqual([]);
      expect(actionIds(prompt)).toEqual(["cancel"]);
      expect(prompt).not.toHaveProperty("search");
      expect(prompt).not.toHaveProperty("window");
    }
  });

  test("offers Cancel alone while the list loads, since its rows are still arriving", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`loading-${width}.txt`);
      expect(prompt?.question).toBe("Loading sessions");
      expect(prompt?.options).toEqual([]);
      expect(actionIds(prompt)).toEqual(["cancel"]);
      expect(prompt).not.toHaveProperty("search");
    }
  });

  test("offers the other scope and Cancel for an empty list, with its search still open", () => {
    for (const width of WIDTHS) {
      const prompt = parse(`empty-current-${width}.txt`);
      expect(prompt?.question).toBe("No sessions in this folder");
      expect(prompt?.options).toEqual([]);
      expect(prompt?.search).toEqual({ value: "" });
      expect(actionIds(prompt)).toEqual(["scope", "cancel"]);
    }
  });
});

describe("the answers to pi's session picker", () => {
  test("answers a row by moving the cursor down to it and pressing Enter", () => {
    expect(answerKeys(parse("list-120.txt")!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("answers a row of a long list by its distance from the cursor within the window", () => {
    // the cursor is the window's sixth row, so the first row is five rows up
    expect(answerKeys(parse("cursor-15-of-23-120.txt")!, { option_index: 0 })).toEqual([
      ...Array.from({ length: 5 }, () => ({ keys: ["up"] })),
      { keys: ["enter"] },
    ]);
  });

  test("pages with the arrows, landing the cursor where pi's own page keys would", () => {
    const prompt = parse("cursor-15-of-23-120.txt");
    // the cursor is session 15 (index 14) of 23: Earlier moves ten rows up, to index 4; Later moves eight, to the last row
    expect(answerKeys(prompt!, { action: "earlier" })).toEqual([{ keys: Array(10).fill("up"), view: true, landing: 4 }]);
    expect(answerKeys(prompt!, { action: "later" })).toEqual([{ keys: Array(8).fill("down"), view: true, landing: 22 }]);
  });

  test("scope is Tab, a view that commits nothing", () => {
    expect(answerKeys(parse("list-120.txt")!, { action: "scope" })).toEqual([{ keys: ["tab"], view: true }]);
  });

  test("Cancel is Escape, the one key that ends the answer", () => {
    expect(answerKeys(parse("list-120.txt")!, { action: "cancel" })).toEqual([{ keys: ["esc"] }]);
    expect(answerKeys(parse("delete-confirm-120.txt")!, { action: "cancel" })).toEqual([{ keys: ["esc"] }]);
  });

  test("the search clears its text with the editor's keys, then types the new text with no Enter", () => {
    const prompt = parse("list-120.txt");
    expect(answerKeys(prompt!, { search_text: "session 1" })).toEqual([{ keys: ["ctrl+k", "ctrl+u"], view: true }, { text: "session 1", view: true }]);
    expect(answerKeys(prompt!, { search_text: "" })).toEqual([{ keys: ["ctrl+k", "ctrl+u"], view: true }]);
  });

  test("no answer to a picker ever sends a key that deletes, renames, sorts or toggles the picker's options", () => {
    const forbidden = ["ctrl+d", "ctrl+r", "ctrl+s", "ctrl+n", "ctrl+p", "ctrl+backspace", "ctrl+enter"];
    const answers = [{ action: "scope" }, { action: "earlier" }, { action: "later" }, { action: "cancel" }, { search_text: "x" }, { option_index: 0 }];
    for (const name of ["list-120.txt", "cursor-15-of-23-120.txt", "scope-all-120.txt", "empty-current-120.txt", "delete-confirm-120.txt"]) {
      const prompt = parse(name)!;
      for (const answer of answers) {
        let steps: ReturnType<typeof answerKeys> | null = null;
        try {
          steps = answerKeys(prompt, answerOf(answer));
        } catch {
          // the card does not offer this answer: nothing is sent for it
        }
        if (steps === null) continue;
        for (const key of keysOf(steps)) expect(forbidden).not.toContain(key);
      }
    }
  });

  test("refuses an answer the card does not offer", () => {
    const list = parse("list-120.txt")!;
    expect(() => answerKeys(list, answerOf({ action: "delete" }))).toThrow("This control is not on the card.");
    expect(() => answerKeys(list, answerOf({ action: "rename" }))).toThrow("This control is not on the card.");
    expect(() => answerKeys(list, answerOf({ action: "sort" }))).toThrow("This control is not on the card.");
    expect(() => answerKeys(list, answerOf({ option_index: 3 }))).toThrow("A valid option index is required.");
    expect(() => answerKeys(list, answerOf({ search_text: "a\nb" }))).toThrow("one line");
    expect(() => answerKeys(list, answerOf({ search_text: "\u0004" }))).toThrow("one line");
    expect(() => answerKeys(list, answerOf({ search_text: "x".repeat(201) }))).toThrow("at most 200 characters");
    expect(() => answerKeys(list, answerOf({ action: "scope", option_index: 0 }))).toThrow("Exactly one answer is required.");
  });

  test("refuses a row, a search or paging while a delete is asked or the list loads", () => {
    const confirming = parse("delete-confirm-120.txt")!;
    expect(() => answerKeys(confirming, answerOf({ option_index: 0 }))).toThrow();
    expect(() => answerKeys(confirming, answerOf({ search_text: "x" }))).toThrow("This prompt has no search.");
    expect(() => answerKeys(confirming, answerOf({ action: "earlier" }))).toThrow("This control is not on the card.");
    const loading = parse("loading-120.txt")!;
    expect(() => answerKeys(loading, answerOf({ option_index: 0 }))).toThrow();
    expect(() => answerKeys(loading, answerOf({ search_text: "x" }))).toThrow("This prompt has no search.");
  });
});

describe("what is not pi's session picker", () => {
  test("a picker followed by pi's footer is still the card; followed by output, it is output left in scrollback", () => {
    const footer = `${picker("list-120.txt")}~/Dev/app\n0.0%/215k (auto)  some-model\n`;
    expect(parseInteractivePrompt("pi", footer)).not.toBeNull();
    const withOutput = `${picker("list-120.txt")}assistant output one\nassistant output two\nassistant output three\n`;
    expect(parseInteractivePrompt("pi", withOutput)).toBeNull();
  });

  test("a screen whose picker lacks its scope, its search, its cursor or a row's count is refused", () => {
    const list = picker("list-120.txt");
    expect(parseInteractivePrompt("pi", list.replace("\u25c9 Current Folder | \u25cb All", ""))).toBeNull();
    expect(parseInteractivePrompt("pi", list.replace(/^>\s*$/m, ""))).toBeNull();
    expect(parseInteractivePrompt("pi", list.replace("\u203a ", "  "))).toBeNull();
    expect(parseInteractivePrompt("pi", list.replace("3 1d", "3 one"))).toBeNull();
  });

  test("a counter that does not match the rows on the screen is refused: the window is not guessed", () => {
    const long = picker("cursor-15-of-23-120.txt");
    expect(parseInteractivePrompt("pi", long.split("\n").filter((line) => !line.includes("session 9:")).join("\n"))).toBeNull();
    expect(parseInteractivePrompt("pi", long.replace("(15/23)", "(15/9)"))).toBeNull();
  });

  test("a chat's own quoted line is not a picker", () => {
    expect(parseInteractivePrompt("pi", "> hello\nworld\n")).toBeNull();
  });
});
