import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { shareUnchangedTurns, turnRevision } from "./turnRevision.ts";
import { RenderBoundary } from "../components/RenderBoundary.tsx";

const turn = (text: string, end?: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-02T00:00:00Z", ...(end ? { end_ts: end } : {}), parts: [{ kind: "text", text }] });

test("an immutable settled message is scanned only once across repeated renders", () => {
  const value = turn("settled");
  const parts = value.parts;
  let reads = 0;
  Object.defineProperty(value, "parts", { get: () => { reads++; return parts; } });
  const first = turnRevision(value, true);
  const initialReads = reads;
  expect(initialReads).toBeGreaterThan(0);
  expect(turnRevision(value, true)).toBe(first);
  expect(reads).toBe(initialReads);
  expect(turnRevision(turn("changed"), true)).not.toBe(first);
});

test("ordinary revision reads still detect mutation, including same-length edits", () => {
  const value = turn("ab");
  const first = turnRevision(value);
  value.parts = [{ kind: "text", text: "cd" }];
  expect(turnRevision(value)).not.toBe(first);
});

test("a turn parsed again unchanged keeps its revision; new content or a later end changes it", () => {
  expect(turnRevision(turn("same"))).toBe(turnRevision(structuredClone(turn("same"))));
  expect(turnRevision(turn("same"))).not.toBe(turnRevision(turn("same, and more")));
  expect(turnRevision(turn("same"))).not.toBe(turnRevision(turn("same", "2026-10-02T00:00:09Z")));
  // rewritten to the same length, or a tool renamed: still a change
  expect(turnRevision(turn("ab"))).not.toBe(turnRevision(turn("cd")));
  const tool = (name: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "tool", name, summary: "", input: "{}", output: "" }] });
  expect(turnRevision(tool("read"))).not.toBe(turnRevision(tool("edit")));
  const shown = (summary: string, ref: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "tool", name: "read", summary, input: "{}", output: "", images: [{ media_type: "image/png", ref }] }] });
  expect(turnRevision(shown("a.ts", "pi:1:0"))).not.toBe(turnRevision(shown("b.ts", "pi:1:0")));
  expect(turnRevision(shown("a.ts", "pi:1:0"))).not.toBe(turnRevision(shown("a.ts", "pi:2:0")));
});

test("the boundary tries again in the render where its key changes, and not while it stays", () => {
  const props = (resetKey: unknown) => ({ resetKey, fallback: () => null, children: null });
  expect(RenderBoundary.getDerivedStateFromProps(props("a"), { failed: true, key: "a" })).toBeNull();
  expect(RenderBoundary.getDerivedStateFromProps(props("b"), { failed: true, key: "a" })).toEqual({ failed: false, key: "b" });
});

test("a change the text does not show still changes the revision: a text phase, a notice's label, a compaction's tokens, the turn's settings", () => {
  const phased = (phase: "commentary" | "final_answer"): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "text", text: "same", phase }] });
  expect(turnRevision(phased("commentary"))).not.toBe(turnRevision(phased("final_answer")));
  const notice = (label: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "notice", text: "same", label }] });
  expect(turnRevision(notice("a"))).not.toBe(turnRevision(notice("b")));
  const compact = (tokens: number): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "compact", text: "same", tokens }] });
  expect(turnRevision(compact(1))).not.toBe(turnRevision(compact(2)));
  const settled = (model: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "text", text: "same" }], settings: { model, reasoning_effort: null, mode: null } });
  expect(turnRevision(settled("a"))).not.toBe(turnRevision(settled("b")));
  expect(turnRevision(turn("same"))).toBe(turnRevision(turn("same")));
});

describe("shareUnchangedTurns", () => {
  const user = (text: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "text", text }] });
  const agent = (text: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "text", text }] });

  test("hands back the previous object of each unchanged turn, in the new order, and keeps a changed or new turn's own object", () => {
    const [a, b, c] = [user("a"), agent("b"), agent("c")];
    const streamed = agent("c, streamed further");
    const added = user("d");
    // a parse gives every turn a new object: the unchanged ones are matched by content, the others keep the new object
    const fresh = [a, b, streamed, added].map((turn) => structuredClone(turn));
    const shared = shareUnchangedTurns([a, b, c], fresh);
    expect(shared.map((turn) => turnRevision(turn))).toEqual(fresh.map((turn) => turnRevision(turn)));
    expect(shared[0]).toBe(a);
    expect(shared[1]).toBe(b);
    expect(shared[2]).toBe(fresh[2]);
    expect(shared[3]).toBe(fresh[3]);
  });

  test("keeps sharing when the page moved: a turn dropped from its start and one appended", () => {
    const [a, b, c] = [user("a"), agent("b"), agent("c")];
    const fresh = [b, c, user("d")].map((turn) => structuredClone(turn));
    const shared = shareUnchangedTurns([a, b, c], fresh);
    expect(shared[0]).toBe(b);
    expect(shared[1]).toBe(c);
    expect(shared[2]).toBe(fresh[2]);
  });

  test("returns the previous array when every turn is the same object, and takes the new array when one is not", () => {
    const [a, b] = [user("a"), agent("b")];
    const previous = [a, b];
    expect(shareUnchangedTurns(previous, [a, b])).toBe(previous);
    expect(shareUnchangedTurns(previous, [b, a])).not.toBe(previous);
    expect(shareUnchangedTurns(previous, [b, a])).toEqual([b, a]);
    expect(shareUnchangedTurns(previous, [a])).toEqual([a]);
    expect(shareUnchangedTurns([], [a, b])).toEqual([a, b]);
  });
});
