import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { InteractivePrompt } from "../shared/protocol.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

/** pi 1.3.0's own renders of its menus and `/model` (server/fixtures/pi-dialogs/README.md). */
const dialog = (name: string): string => readFileSync(new URL(`./fixtures/pi-dialogs/${name}`, import.meta.url), "utf8");
const parse = (name: string): InteractivePrompt | null => parseInteractivePrompt("pi", dialog(name));
const WIDTHS = [120, 46, 36] as const;
const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);
const keysOf = (steps: ReturnType<typeof answerKeys>) => steps.flatMap((step) => step.keys ?? []);

describe("pi's ctx.ui.select and confirm dialogs", () => {
  test("reads a select at 120, 46 and 36 columns: its title and its options, the cursor on the first", () => {
    for (const width of WIDTHS) {
      expect(parse(`select-${width}.txt`)).toMatchObject({
        agent: "pi",
        kind: "question",
        question: "Allow dangerous command?",
        options: [{ label: "Allow once" }, { label: "Always allow" }, { label: "Block" }],
        multi_select: false,
      });
    }
  });

  test("reads a confirm at 120, 46 and 36 columns as a Yes or No approval, the message under its title", () => {
    for (const width of WIDTHS) {
      expect(parse(`confirm-${width}.txt`)).toMatchObject({
        kind: "approval",
        title: "Clear session?",
        question: "This drops the current conversation.",
        options: [{ label: "Yes" }, { label: "No" }],
      });
    }
  });

  test("answers No by the move down from Yes, then Enter: a confirmation is answered, never cancelled", () => {
    expect(keysOf(answerKeys(parse("confirm-120.txt")!, { option_index: 1 }))).toEqual(["down", "enter"]);
  });
});

describe("pi's /model selector", () => {
  const DEFAULT_ROW = "claude-sonnet-5 [anthropic] \u00b7 default";
  const ROWS = ["gpt-5 [openai]", DEFAULT_ROW, "gemini-3-pro [google]", "qwen-3-8 [openrouter]"];

  test("reads the catalogue at 120, 46 and 36 columns: the current model named, every row whole", () => {
    for (const width of WIDTHS) {
      expect(parse(`model-${width}.txt`)).toMatchObject({
        kind: "question",
        question: "Select model (currently gpt-5 [openai])",
        multi_select: false,
      });
      expect(labels(parse(`model-${width}.txt`))).toEqual(ROWS);
    }
  });

  test("reads a 36-column default row whose \u00b7 default marker wraps onto its own line, as the same row", () => {
    // pi 1.3.0 at 36 columns draws `claude-sonnet-5 [anthropic] ·` and `default` on two lines
    expect(dialog("model-36.txt")).toContain("[anthropic] \u00b7\ndefault");
    expect(labels(parse("model-36.txt"))?.[1]).toBe(DEFAULT_ROW);
  });

  test("reads the scoped catalogue, with its scope line above the filter", () => {
    expect(labels(parse("model-scoped-120.txt"))).toEqual(["gpt-5 [openai]", "gemini-3-pro [google]"]);
  });

  test("reads a filtered catalogue of several matches: the filter after the > is read, and its rows are the choices", () => {
    expect(labels(parse("model-typed-several-120.txt"))).toEqual(["gpt-5 [openai]", "qwen-3-8 [openrouter]", "gemini-3-pro [google]", DEFAULT_ROW]);
  });

  test("offers no card for a filter that leaves one model: a list of one row is not a choice", () => {
    expect(parse("model-typed-one-120.txt")).toBeNull();
  });

  test("answers a model by its move from the cursor, then Enter", () => {
    // the cursor is on gpt-5 (the current model); the default row is one row down
    expect(keysOf(answerKeys(parse("model-120.txt")!, { option_index: 1 }))).toEqual(["down", "enter"]);
  });
});
