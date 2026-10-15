import { describe, expect, it } from "bun:test";

import type { ConversationMetadata, ConversationTurn, TurnSettings } from "../shared/protocol.ts";
import { piCarry, withPiSettings } from "./pi-settings.ts";

const none: TurnSettings = { model: null, reasoning_effort: null, mode: null };
const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
const turn = (ts: string | null): ConversationTurn => ({ role: "user", ts, parts: [] });

describe("withPiSettings", () => {
  it("gives each turn the settings in effect where it starts, so a change shows before the turn after it", () => {
    const text = [
      line({ type: "model_change", timestamp: "2026-10-03T12:00:00.000Z", provider: "openai", modelId: "gpt-a" }),
      line({ type: "thinking_level_change", timestamp: "2026-10-03T12:00:01.000Z", thinkingLevel: "high" }),
      line({ type: "custom", customType: "pi-modes-state", timestamp: "2026-10-03T12:00:02.000Z", data: { name: "orchestrate" } }),
      line({ type: "message", timestamp: "2026-10-03T12:00:03.000Z" }),
      line({ type: "model_change", timestamp: "2026-10-03T12:05:00.000Z", provider: "openai", modelId: "gpt-b" }),
    ].join("\n");
    const turns = [turn("2026-10-03T12:00:04.000Z"), turn("2026-10-03T12:06:00.000Z")];

    expect(withPiSettings(turns, "pi-transcript", text, none)).toBe(turns);
    expect(turns[0]!.settings).toEqual({ model: "gpt-a", reasoning_effort: "high", mode: "orchestrate" });
    expect(turns[1]!.settings).toEqual({ model: "gpt-b", reasoning_effort: "high", mode: "orchestrate" });
  });

  it("starts from what the transcript said before the chunk, and holds a change after the last turn for the next chunk", () => {
    const carry: TurnSettings = { model: "gpt-a", reasoning_effort: "medium", mode: null };
    const first = [turn("2026-10-03T12:09:00.000Z"), turn("2026-10-03T12:11:00.000Z")];
    withPiSettings(first, "pi-transcript", line({ type: "thinking_level_change", timestamp: "2026-10-03T12:10:00.000Z", thinkingLevel: "xhigh" }), carry);
    expect(first[0]!.settings).toEqual({ model: "gpt-a", reasoning_effort: "medium", mode: null });
    expect(first[1]!.settings).toEqual({ model: "gpt-a", reasoning_effort: "xhigh", mode: null });

    const second = [turn("2026-10-03T12:20:00.000Z")];
    withPiSettings(second, "pi-transcript", line({ type: "model_change", timestamp: "2026-10-03T12:30:00.000Z", provider: "openai", modelId: "gpt-c" }), { model: "gpt-a", reasoning_effort: "xhigh", mode: null });
    expect(second[0]!.settings?.model).toBe("gpt-a");
    const third = [turn("2026-10-03T12:40:00.000Z")];
    withPiSettings(third, "pi-transcript", "", { model: "gpt-c", reasoning_effort: "xhigh", mode: null });
    expect(third[0]!.settings?.model).toBe("gpt-c");
  });

  it("ignores lines that are torn, untimed or not a setting, and leaves a turn without a time on the settings before it", () => {
    const text = [
      line({ type: "model_change", modelId: "untimed" }),
      "{\"type\":\"model_change\",\"timest",
      line({ type: "message", timestamp: "2026-10-03T12:01:00.000Z", modelId: "not a setting" }),
      line({ type: "custom", customType: "other-state", timestamp: "2026-10-03T12:01:00.000Z", data: { name: "not a mode" } }),
    ].join("\n");
    const turns = [turn(null), turn("2026-10-03T12:02:00.000Z")];
    withPiSettings(turns, "pi-transcript", text, { model: "gpt-a", reasoning_effort: null, mode: null });
    expect(turns[0]!.settings).toEqual({ model: "gpt-a", reasoning_effort: null, mode: null });
    expect(turns[1]!.settings).toEqual({ model: "gpt-a", reasoning_effort: null, mode: null });
  });

  it("leaves a turn unstamped until a setting is recorded, so a session without one keeps its turns as they were", () => {
    const turns = [turn("2026-10-03T12:00:04.000Z"), turn("2026-10-03T12:09:00.000Z")];
    withPiSettings(turns, "pi-transcript", line({ type: "model_change", timestamp: "2026-10-03T12:05:00.000Z", modelId: "gpt-a" }), none);
    expect("settings" in turns[0]!).toBeFalse();
    expect(turns[1]!.settings?.model).toBe("gpt-a");
  });

  it("stamps only pi transcripts", () => {
    const turns = [turn("2026-10-03T12:00:04.000Z")];
    withPiSettings(turns, "omp-transcript", line({ type: "model_change", timestamp: "2026-10-03T12:00:00.000Z", modelId: "gpt-a" }), none);
    expect(turns[0]!.settings).toBeUndefined();
  });
});

describe("piCarry", () => {
  it("reads the settings a chunk starts from out of the metadata fold, with no mode recorded as null", () => {
    const metadata: ConversationMetadata = { model: "gpt-a", reasoning_effort: "high" };
    expect(piCarry(metadata)).toEqual({ model: "gpt-a", reasoning_effort: "high", mode: null });
    expect(piCarry({ ...metadata, mode: "orchestrate" })).toEqual({ model: "gpt-a", reasoning_effort: "high", mode: "orchestrate" });
  });
});
