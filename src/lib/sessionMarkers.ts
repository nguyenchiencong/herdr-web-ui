import type { TurnSettings } from "../../shared/protocol.ts";

/** A setting a pi session changed, with the value it changed to. */
export interface SettingChange {
  key: keyof TurnSettings;
  value: string;
}

const SETTINGS: readonly (keyof TurnSettings)[] = ["model", "reasoning_effort", "mode"];

/**
 * The settings that changed between two turns, for a marker above the later one. A setting that either
 * turn does not name is no change, and a setting that stays the same is no marker, however often it was
 * recorded; a turn with no settings at all (a transcript that records none) has nothing to compare.
 */
export function settingChanges(before: TurnSettings | undefined, after: TurnSettings | undefined): SettingChange[] {
  if (before === undefined || after === undefined) return [];
  return SETTINGS.flatMap((key) => {
    const previous = before[key];
    const next = after[key];
    return previous !== null && next !== null && previous !== next ? [{ key, value: next }] : [];
  });
}
