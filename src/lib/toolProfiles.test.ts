import { describe, expect, it } from "bun:test";

import { argumentsOf, callSummary, editPairs, fallbackSummary, rowSummaries, rowSummary, TOOL_PROFILES, toolProfile, type ToolCall } from "./toolProfiles.ts";

const call = (name: string, input: unknown, output = "", details?: Record<string, unknown>): ToolCall => ({
  name, input: JSON.stringify(input), output, ...(details === undefined ? {} : { details }),
});

describe("TOOL_PROFILES", () => {
  it("names every tool the profile table covers, each under a label", () => {
    const names = [
      "Agent", "get_subagent_result", "steer_subagent", "bg_run", "bg_status", "bg_logs", "bg_kill", "codemode",
      "jev_decide", "repo_claim", "send_session_message", "get_session_message", "ffgrep", "fffind", "rg_grep",
      "classify_context", "generate_image",
    ];
    expect(Object.keys(TOOL_PROFILES).sort()).toEqual([...names].sort());
    for (const name of names) expect(toolProfile(name)?.label.length ?? 0).toBeGreaterThan(0);
  });

  it("is looked up by the exact tool id, and only by its own keys", () => {
    expect(toolProfile("Agent")?.label).toBe("Subagent");
    expect(toolProfile("agent")).toBeNull();
    expect(toolProfile("constructor")).toBeNull();
    expect(toolProfile("mcp__files__read_all")).toBeNull();
  });
});

describe("callSummary", () => {
  it("names a subagent call by its Agent's description, whether the id came in the details or the output", () => {
    const background = call("Agent", { description: "Find the task records", subagent_type: "explore" }, "Agent started in background.\nAgent ID: a1b2c3\nType: explore");
    const detailed = call("Agent", { description: "Check the login" }, "The answer", { agentId: "d4e5f6" });
    expect(callSummary(call("get_subagent_result", { agent_id: "a1b2c3" }), [background])).toBe("Find the task records");
    expect(callSummary(call("steer_subagent", { agent_id: "d4e5f6", message: "stop" }), [background, detailed])).toBe("Check the login");
  });

  it("reads key: value when the Agent is not earlier in the turn, or no call in it has that id", () => {
    const background = call("Agent", { description: "Find the task records" }, "Agent ID: a1b2c3");
    expect(callSummary(call("get_subagent_result", { agent_id: "a1b2c3" }), [])).toBe("agent_id: a1b2c3");
    expect(callSummary(call("get_subagent_result", { agent_id: "zzz" }), [background])).toBe("agent_id: zzz");
  });

  it("names a background task's call by the bg_run's name, found by the task id it started", () => {
    const run = call("bg_run", { command: "npm test", name: "unit-tests" }, "Started background task b533307b2 (unit-tests).\nOutput file: x");
    expect(callSummary(call("bg_logs", { taskId: "b533307b2" }), [run])).toBe("unit-tests");
    expect(callSummary(call("bg_kill", { taskId: "b533307b2" }), [])).toBe("taskId: b533307b2");
    const detailed = call("bg_run", { command: "make", name: "build" }, "", { task: { id: "t9", name: "build" } });
    expect(callSummary(call("bg_status", { taskId: "t9" }), [detailed])).toBe("build");
  });

  it("summarises a script by the tools it calls, or by its first line when it calls none", () => {
    expect(callSummary(call("codemode", { code: "const a = await tools.bash({ command: 'x' });\nconst b = await tools.read({ path: 'y' });\nawait tools.bash({ command: 'z' });" }), [])).toBe("bash ×2, read");
    expect(callSummary(call("codemode", { code: "  const total = 1 + 2;\nreturn total;" }), [])).toBe("const total = 1 + 2;");
  });

  it("summarises the other profiled calls by their own argument", () => {
    expect(callSummary(call("repo_claim", { action: "list" }), [])).toBe("list");
    expect(callSummary(call("ffgrep", { pattern: "TODO", path: "src" }), [])).toBe("TODO");
    expect(callSummary(call("Agent", { subagent_type: "explore", prompt: "look" }), [])).toBe("subagent_type: explore");
  });

  it("is null for a tool the table does not know", () => {
    expect(callSummary(call("mcp__files__lookup", { action: "list" }), [])).toBeNull();
  });
});

describe("fallbackSummary", () => {
  it("reads the arguments as one key: value, human keys first, then ids, then the first short scalar", () => {
    expect(fallbackSummary({ prompt: "a long multi\nline prompt", action: "list" })).toBe("action: list");
    expect(fallbackSummary({ taskId: "b533307b2", maxBytes: 4096 })).toBe("taskId: b533307b2");
    expect(fallbackSummary({ verbose: true, mode: "deep" })).toBe("verbose: true");
    expect(fallbackSummary({ description: "Find it", agent_id: "x" })).toBe("description: Find it");
  });

  it("has nothing to show for arguments with no short value", () => {
    expect(fallbackSummary({ prompt: "x".repeat(200) })).toBeNull();
    expect(fallbackSummary({})).toBeNull();
  });
});

describe("rowSummary", () => {
  it("keeps a profiled call's own summary and a server summary that names the call, and otherwise reads key: value", () => {
    expect(rowSummary(call("Agent", { description: "Find it" }), [], "Find it")).toBe("Find it");
    expect(rowSummary(call("eval", { code: "x" }), [], "Run the checks")).toBe("Run the checks");
    expect(rowSummary(call("mcp__files__lookup", { action: "list" }), [], "mcp__files__lookup")).toBe("action: list");
    expect(rowSummary(call("mcp__files__lookup", {}), [], "mcp__files__lookup")).toBe("mcp__files__lookup");
  });
});

describe("rowSummaries", () => {
  it("gives every row of a turn the summary rowSummary gives it with the calls before it, in one pass", () => {
    const row = (name: string, input: unknown, output = "", summary = name) => ({ ...call(name, input, output), summary });
    const calls = [
      row("get_subagent_result", { agent_id: "a1" }),
      row("Agent", { description: "Find the records" }, "Agent ID: a1"),
      row("get_subagent_result", { agent_id: "a1" }),
      row("Agent", { description: "Look again" }, "Agent ID: a1"),
      row("steer_subagent", { agent_id: "a1", message: "stop" }),
      row("bg_run", { name: "unit tests" }, "Started background task b9"),
      row("bg_logs", { taskId: "b9" }),
      row("mcp__files__lookup", { action: "list" }),
      row("eval", { code: "x" }, "", "Run the checks"),
    ];
    const summaries = rowSummaries(calls);
    calls.forEach((one, index) => expect(summaries.get(one)).toBe(rowSummary(one, calls.slice(0, index), one.summary)));
    expect(calls.map((one) => summaries.get(one))).toEqual([
      "agent_id: a1", "Find the records", "Find the records", "Look again", "Look again", "unit tests", "unit tests", "action: list", "Run the checks",
    ]);
  });
});

describe("editPairs", () => {
  it("reads pi's edits as before-and-after pairs, with their whitespace", () => {
    const args = { path: "src/a.ts", edits: [{ oldText: "  const a = 1;\n", newText: "  const a = 2;\n" }, { oldText: "b", newText: "c" }] };
    expect(editPairs(argumentsOf(JSON.stringify(args)))).toEqual([
      { before: "  const a = 1;\n", after: "  const a = 2;\n" },
      { before: "b", after: "c" },
    ]);
  });

  it("reads Claude's old_string and new_string, as one pair or as a list", () => {
    expect(editPairs({ file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual([{ before: "x", after: "y" }]);
    expect(editPairs({ file_path: "a.ts", edits: [{ old_string: "x", new_string: "" }] })).toEqual([{ before: "x", after: "" }]);
  });

  it("is null for arguments with no edit in them, a list entry with none, or an empty list", () => {
    expect(editPairs({ path: "a.ts", content: "x" })).toBeNull();
    expect(editPairs({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }, {}] })).toBeNull();
    expect(editPairs({ path: "a.ts", edits: [] })).toBeNull();
  });
});

describe("argumentsOf", () => {
  it("reads an input that is not an object as no arguments", () => {
    expect(argumentsOf("not json")).toEqual({});
    expect(argumentsOf("[1]")).toEqual({});
  });
});
