import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationPart } from "../../shared/protocol.ts";
import { ChatRowMemoryContext } from "../lib/chatRowState.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { WorkBlockView } from "./ChatView.tsx";

type ToolPart = Extract<ConversationPart, { kind: "tool" }>;

/** A tool call as the server hands it over: its arguments as JSON, its summary as the server cuts it. */
const tool = (name: string, args: unknown, output = "", extra: Partial<ToolPart> = {}): ToolPart => ({
  kind: "tool", name, summary: name, input: JSON.stringify(args, null, 2), output, ...extra,
});

/** A work block of these parts, open, with the rows at `opened` (default: all) expanded. */
function renderBlock(parts: ConversationPart[], opened: number[] = parts.map((_, index) => index)): string {
  const toggles = new Map<string, boolean | null>(opened.map((index) => [`tool:${index}`, true]));
  // the settings read the browser's languages, which this runtime does not define: English, as the TurnTime test sets it
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, {
      children: createElement(ChatRowMemoryContext.Provider, { value: { toggles, outputs: new Map() } },
        createElement(WorkBlockView, { paneId: "pane-1", parts, duration: "7s", live: false, waiting: false, defaultOpen: true, showThinking: false })),
    }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("pi edit", () => {
  it("shows the file and a diff for each replaced span, not an empty diff", () => {
    const html = renderBlock([tool("edit", { path: "src/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }, { oldText: "b()", newText: "c()" }] }, "Successfully replaced 2 blocks in src/a.ts.", { summary: "src/a.ts" })]);
    expect(html).toContain("Edited");
    expect(html).toContain('<p class="chat-tool-file">src/a.ts</p>');
    expect(html.match(/class="chat-diff"/g)?.length).toBe(2);
    expect(html).toContain('<span class="chat-diff-del">- const a = 1;');
    expect(html).toContain('<span class="chat-diff-add">+ const a = 2;');
    expect(html).toContain('<span class="chat-diff-del">- b()');
  });

  it("shows the file of a write and of a read", () => {
    const write = renderBlock([tool("write", { path: "notes.md", content: "# Notes" }, "ok", { summary: "notes.md" })]);
    expect(write).toContain('<p class="chat-tool-file">notes.md</p>');
    expect(write).toContain("# Notes");
    const read = renderBlock([tool("read", { path: "src/b.ts" }, "export const b = 1;", { summary: "src/b.ts" })]);
    expect(read).toContain('<p class="chat-tool-file">src/b.ts</p>');
  });
});

describe("arguments", () => {
  it("draws a codemode script as highlighted JavaScript, line by line", () => {
    const code = "const files = await tools.read({ path: 'a.ts' });\nreturn files.length;";
    const html = renderBlock([tool("codemode", { code }, "2")]);
    expect(html).toContain("Code");
    expect(html).toContain('class="hl-code');
    expect(html).toContain('class="hl-keyword"');
    expect(html).toContain('data-line="2"');
  });

  it("shows a multi-line argument verbatim, not JSON-escaped", () => {
    const html = renderBlock([tool("send_session_message", { target: "reviewer", message: "First line.\nSecond line." }, "sent")]);
    expect(html).toContain("First line.\nSecond line.");
    expect(html).not.toContain("\\n");
  });

  it("reads an unknown tool's arguments as key: value in its row, and as fields in its detail", () => {
    const html = renderBlock([tool("mcp__files__lookup", { action: "list", depth: 2 }, "3 files")]);
    expect(html).toContain('<span class="work-row-summary">action: list</span>');
    expect(html).toContain("<dt>action</dt>");
    expect(html).toContain("<dd>list</dd>");
  });
});

describe("profiled rows", () => {
  it("names a get_subagent_result by the description of the Agent that started it", () => {
    const agent = tool("Agent", { description: "Find where the task records live", subagent_type: "explore", prompt: "Look." }, "Agent started in background.\nAgent ID: a1b2c3\nType: explore");
    const html = renderBlock([agent, tool("get_subagent_result", { agent_id: "a1b2c3" }, "The records live in one file.")], [1]);
    expect(html).toContain("Subagent result");
    expect(html).toContain('<span class="work-row-summary">Find where the task records live</span>');
    expect(html).not.toContain('work-row-summary">agent_id: a1b2c3');
  });

  it("shows the icon and label of a profiled row, the summary after them", () => {
    const html = renderBlock([tool("Agent", { description: "Find it", subagent_type: "explore" }, "")], []);
    expect(html).toContain("work-row-icon");
    expect(html).toContain("Subagent");
    expect(html).toContain('<span class="work-row-summary">Find it</span>');
  });

  it("keeps a narrated row's tool kind in its accessible name", () => {
    const html = renderBlock([tool("eval", { code: "check()", summary: "Run the checks" }, "ok", { summary: "Run the checks" })], []);
    // the global visually-hidden rule: read by assistive tech, never drawn beside the sentence
    expect(html).toContain('<span class="visually-hidden">eval: </span>');
    expect(html).toContain("Run the checks");
  });

  it("names a notice whose text opens with a tag by its runtime, not by the raw tag", () => {
    const html = renderBlock([{ kind: "notice", text: "<task-notification>\n<task-id>t1</task-id>\n</task-notification>", source: "job-result" }], []);
    expect(html).toContain('<span class="work-row-name">job result</span>');
    expect(html).not.toContain("&lt;task-notification&gt;</span>");
  });
});

describe("results", () => {
  it("draws a subagent's answer as Markdown, and a shell's output as text", () => {
    const answer = "## Findings\n\n- The records live in one file.\n- The index is rebuilt on start.";
    const markdown = renderBlock([tool("get_subagent_result", { agent_id: "x" }, answer)]);
    expect(markdown).toContain('class="chat-tool-markdown"');
    expect(markdown).toContain("markdown-h2");
    const shell = renderBlock([tool("bash", { command: "cat notes.md" }, answer, { summary: "cat notes.md" })]);
    expect(shell).not.toContain("chat-tool-markdown");
    expect(shell).toContain('<pre class="chat-tool-io">');
  });

  it("shows a finished subagent's status, duration, tokens and tool calls on one meta line", () => {
    const html = renderBlock([tool("Agent", { description: "Find it", subagent_type: "explore", prompt: "x" }, "Done.", {
      details: { status: "completed", durationMs: 1531000, tokens: "660k", toolUses: 96 },
    })]);
    expect(html).toContain('<p class="chat-tool-meta">done · 25m 31s · 660k tokens · 96 tool calls</p>');
  });

  it("draws a classifier's answers as a table only when details.answers has that shape", () => {
    const answers = {
      complexity: { type: "score", score: 2.72, confidence: 0.75, probabilities: {} },
      model_tier: { type: "choice", choice: "sonnet", confidence: 0.9 },
    };
    const html = renderBlock([tool("jev_decide", { goal: "Pick a model", state: { task: "x" } }, "complexity: 2.72/5 (conf 0.75)", { details: { answers } })]);
    expect(html).toContain('<table class="chat-answers"');
    expect(html).toContain('<span class="chat-answer-fill"');
    expect(html).toContain("75%");
    expect(html).toContain("sonnet");
    const other = renderBlock([tool("repo_claim", { action: "list" }, "[]", { details: { answers: { x: "not an answer" } } })]);
    expect(other).not.toContain("chat-answers");
  });
});
