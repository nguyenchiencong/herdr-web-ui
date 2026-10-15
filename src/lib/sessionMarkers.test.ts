import { describe, expect, it } from "bun:test";

import type { TurnSettings } from "../../shared/protocol.ts";
import { settingChanges } from "./sessionMarkers.ts";

const at = (model: string | null, reasoning_effort: string | null = "high", mode: string | null = "orchestrate"): TurnSettings => ({ model, reasoning_effort, mode });

describe("settingChanges", () => {
  it("names each setting that changed between two turns, with its new value", () => {
    expect(settingChanges(at("gpt-a", "high", "orchestrate"), at("gpt-b", "xhigh", "web"))).toEqual([
      { key: "model", value: "gpt-b" },
      { key: "reasoning_effort", value: "xhigh" },
      { key: "mode", value: "web" },
    ]);
  });

  it("draws nothing for a repeat, however often the session recorded the same setting", () => {
    expect(settingChanges(at("gpt-a"), at("gpt-a"))).toEqual([]);
  });

  it("treats a setting a turn does not name as no change, and turns with no settings as nothing to compare", () => {
    expect(settingChanges(at(null), at("gpt-b"))).toEqual([]);
    expect(settingChanges(undefined, at("gpt-b"))).toEqual([]);
    expect(settingChanges(at("gpt-a"), undefined)).toEqual([]);
  });

  it("reports only the setting that moved", () => {
    expect(settingChanges(at("gpt-a", "high"), at("gpt-a", "low"))).toEqual([{ key: "reasoning_effort", value: "low" }]);
  });
});
