import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { InteractivePrompt } from "../shared/protocol.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

/** pi 1.3.0's thinking selector as its own component renders it (server/fixtures/pi-thinking-selector/README.md). */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/pi-thinking-selector/${name}`, import.meta.url), "utf8");
const parse = (screen: string): InteractivePrompt | null => parseInteractivePrompt("pi", screen);
const WIDTHS = [120, 46, 36] as const;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);
const keysOf = (steps: ReturnType<typeof answerKeys>) => steps.flatMap((step) => step.keys ?? []);
/** an answer as the route receives it: the test names a kind the card may not offer, to see it refused */
const answerOf = (value: Record<string, unknown>) => value as Parameters<typeof answerKeys>[1];

describe("pi's thinking-level selector", () => {
  test("reads the levels at 120, 46 and 36 columns, with the current level named in the question", () => {
    for (const width of WIDTHS) {
      const prompt = parse(fixture(`thinking-${width}.txt`));
      expect(prompt).toMatchObject({
        agent: "pi",
        kind: "question",
        title: "",
        question: "Select thinking level (currently high)",
        multi_select: false,
        custom_option_index: null,
      });
      expect(labels(prompt)).toEqual(LEVELS);
      expect(prompt).not.toHaveProperty("search");
      expect(prompt).not.toHaveProperty("actions");
      expect(prompt).not.toHaveProperty("window");
    }
  });

  test("reads the filtered list the search leaves, in the order pi shows it", () => {
    for (const width of WIDTHS) {
      expect(labels(parse(fixture(`thinking-filter-${width}.txt`)))).toEqual(["high", "xhigh", "low"]);
    }
  });

  test("reads the selector with pi's footer under it, as the chat's pane shows it", () => {
    const footer = "~/Dev/app\n0.0%/215k (auto)     some-model \u2022 medium\n";
    expect(labels(parse(fixture("thinking-46.txt") + footer))).toEqual(LEVELS);
  });

  test("answers a level with the moves from the cursor's level, then Enter", () => {
    const prompt = parse(fixture("thinking-120.txt"))!;
    // the cursor is on high (index 4): off is four rows up, xhigh one row down, high is where the cursor already is
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([...Array.from({ length: 4 }, () => ({ keys: ["up"] })), { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 5 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: ["enter"] }]);
  });

  test("answers a level of the filtered list from its own cursor", () => {
    const prompt = parse(fixture("thinking-filter-36.txt"))!;
    // the filter leaves high (cursor), xhigh and low: low is two rows down
    expect(keysOf(answerKeys(prompt, { option_index: 2 }))).toEqual(["down", "down", "enter"]);
  });

  test("never sends the key that saves the level as the default, and offers no other control", () => {
    for (const width of WIDTHS) {
      const prompt = parse(fixture(`thinking-${width}.txt`))!;
      for (let index = 0; index < LEVELS.length; index += 1) {
        expect(keysOf(answerKeys(prompt, { option_index: index }))).not.toContain("ctrl+s");
      }
      expect(() => answerKeys(prompt, answerOf({ action: "cancel" }))).toThrow("This control is not on the card.");
      expect(() => answerKeys(prompt, answerOf({ search_text: "x" }))).toThrow("This prompt has no search.");
    }
  });

  test("refuses an option the list does not have", () => {
    expect(() => answerKeys(parse(fixture("thinking-120.txt"))!, answerOf({ option_index: 6 }))).toThrow("A valid option index is required.");
  });

  test("offers no card once the level has been picked and pi's output follows the selector", () => {
    const answered = `${fixture("thinking-120.txt")}assistant output one\nassistant output two\nassistant output three\n`;
    expect(parse(answered)).toBeNull();
  });

  test("reads nothing that is not the selector: no title, a level it does not name, or a list without its marks", () => {
    const screen = fixture("thinking-120.txt");
    expect(parse(screen.replace("Thinking Level", "Thinking"))).toBeNull();
    expect(parse(screen.replace("    xhigh     Extra-high", "    turbo     Extra-high"))).toBeNull();
    expect(parse(screen.replace("\u2192 \u2713 high", "  \u2713 high"))).toBeNull();
    expect(parse(screen.replace("    low       Light", "\u2192 low       Light"))).toBeNull();
    expect(parse(screen.replace("Enter to select", "Enter to pick"))).toBeNull();
  });

  test("reads nothing when the hint is not set just below the list", () => {
    const screen = fixture("thinking-120.txt").replace("\n  Enter to select", "\nOutput in between\n  Enter to select");
    expect(parse(screen)).toBeNull();
  });

  test("offers no card for a list of one level", () => {
    const one = ["Thinking Level", "", "Shift+Tab cycles thinking levels in-session", "", "> ", "", "\u2192 \u2713 high      Deep reasoning (~16k tokens)", "", "  Enter to select \u00b7 Ctrl+S to set as default \u00b7 Escape/Ctrl+C to cancel"].join("\n");
    expect(parse(one)).toBeNull();
  });
});
