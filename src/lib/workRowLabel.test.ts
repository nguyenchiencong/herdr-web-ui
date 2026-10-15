import { describe, expect, it } from "bun:test";
import { workRowLabel } from "./workRowLabel.ts";

describe("workRowLabel", () => {
  it("shows an agent's own sentence alone while keeping the existing verb decision for details", () => {
    expect(workRowLabel({ name: "eval", input: '{"summary":"Run the checks","code":"check()"}' }, "Run the checks")).toEqual({ narration: true, verb: null });
    expect(workRowLabel({ name: "Bash", input: '{"description":"Check ports","command":"lsof -i"}' }, "Check ports")).toEqual({ narration: true, verb: null });
  });

  it("shows a profiled tool's label, never its agent's sentence as a narration", () => {
    expect(workRowLabel({ name: "Agent", input: '{"description":"Find the task records","subagent_type":"explore"}' }, "Find the task records")).toEqual({ narration: false, verb: "Subagent" });
    expect(workRowLabel({ name: "bg_run", input: '{"command":"npm test","name":"unit"}' }, "unit")).toEqual({ narration: false, verb: "Background task" });
  });

  it("retains verbs and tool names for non-narration summaries", () => {
    expect(workRowLabel({ name: "Read", input: '{"file_path":"src/a.ts"}' }, "src/a.ts")).toEqual({ narration: false, verb: "Read" });
    expect(workRowLabel({ name: "lookup", input: "{}" }, "lookup")).toEqual({ narration: false, verb: null });
    expect(workRowLabel({ name: "eval", input: "{" }, "Run the checks")).toEqual({ narration: false, verb: null });
  });
});
