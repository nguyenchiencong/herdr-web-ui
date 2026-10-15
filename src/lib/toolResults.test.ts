import { describe, expect, it } from "bun:test";

import { classifierAnswers, looksLikeMarkdown, rendersAsMarkdown, resultMeta } from "./toolResults.ts";

describe("looksLikeMarkdown", () => {
  it("reads a heading, a fenced block, a table with its rule, or two list items as Markdown", () => {
    expect(looksLikeMarkdown("## Findings\n\nThe records live in one file.")).toBe(true);
    expect(looksLikeMarkdown("Here is the fix:\n\n```ts\nconst a = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("| file | lines |\n|---|---|\n| a.ts | 3 |")).toBe(true);
    expect(looksLikeMarkdown("- first\n- second")).toBe(true);
  });

  it("leaves plain text, a single list item, a shell listing and a diff as text", () => {
    expect(looksLikeMarkdown("Done, 3 files changed.")).toBe(false);
    expect(looksLikeMarkdown("- one item")).toBe(false);
    expect(looksLikeMarkdown("total 4\n-rw-r--r-- 1 a a 0 x")).toBe(false);
    expect(looksLikeMarkdown("@@ -1 +1 @@\n- old\n+ new\n- gone")).toBe(false);
  });
});

describe("rendersAsMarkdown", () => {
  const output = "## Result\n\n- a\n- b";

  it("draws a subagent's answer as Markdown, and not a shell's, a file's or a plain profile's output", () => {
    expect(rendersAsMarkdown({ name: "get_subagent_result", input: "{}", output }, output)).toBe(true);
    expect(rendersAsMarkdown({ name: "Agent", input: "{}", output }, output)).toBe(true);
    expect(rendersAsMarkdown({ name: "bash", input: '{"command":"ls"}', output }, output)).toBe(false);
    expect(rendersAsMarkdown({ name: "read", input: '{"path":"a.md"}', output }, output)).toBe(false);
    expect(rendersAsMarkdown({ name: "bg_logs", input: '{"taskId":"b1"}', output }, output)).toBe(false);
    expect(rendersAsMarkdown({ name: "rg_grep", input: '{"pattern":"x"}', output }, output)).toBe(false);
  });
});

describe("resultMeta", () => {
  it("reads a finished subagent's scalars as one line, and leaves its ids out", () => {
    expect(resultMeta({ status: "completed", durationMs: 1531000, tokens: "660k", toolUses: 96, turnCount: 3, agentId: "ad7f39b" }))
      .toBe("done · 25m 31s · 660k tokens · 96 tool calls · 3 turns");
  });

  it("words one tool call and one turn in the singular, and formats a numeric token count", () => {
    expect(resultMeta({ status: "failed", toolUses: 1, tokens: 660000, turnCount: 1 })).toBe("failed · 660k tokens · 1 tool call · 1 turn");
  });

  it("is empty when the result carries none of them", () => {
    expect(resultMeta(undefined)).toBe("");
    expect(resultMeta({ agentId: "x", path: "a" })).toBe("");
  });
});

describe("classifierAnswers", () => {
  const answers = {
    complexity: { type: "score", score: 2.72, confidence: 0.75, legend: { 3: "moderate" }, probabilities: {} },
    model_tier: { type: "choice", choice: "sonnet", confidence: 0.9, probabilities: {} },
    plan_first: { type: "noul", noul: 0.42 },
  };

  it("reads each question's answer when every entry carries its type's value", () => {
    expect(classifierAnswers({ answers })).toEqual([
      { question: "complexity", kind: "score", value: 2.72, confidence: 0.75 },
      { question: "model_tier", kind: "choice", value: "sonnet", confidence: 0.9 },
      { question: "plan_first", kind: "noul", value: 0.42, confidence: null },
    ]);
  });

  it("is null unless every entry has the shape: a value of the wrong kind, a stray entry, a list, or no answers", () => {
    expect(classifierAnswers({ answers: { complexity: { type: "score", choice: "3" } } })).toBeNull();
    expect(classifierAnswers({ answers: { ...answers, extra: "x" } })).toBeNull();
    expect(classifierAnswers({ answers: [] })).toBeNull();
    expect(classifierAnswers({ answers: {} })).toBeNull();
    expect(classifierAnswers({ agentId: "x" })).toBeNull();
    expect(classifierAnswers(undefined)).toBeNull();
  });
});
