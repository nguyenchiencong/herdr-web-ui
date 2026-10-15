import type { ConversationMetadata, ConversationTurn, TurnSettings } from "../shared/protocol.ts";

/** One settings change a pi transcript records: the setting, its new value and when it was recorded. */
interface SettingEvent {
  at: number;
  key: keyof TurnSettings;
  value: string;
}

/** The lines that can hold a settings change, so every other line is never parsed. */
const SETTING_LINE = /"(?:model_change|thinking_level_change|pi-modes-state)"/;

const labelOf = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** The setting an entry changes and its value: a model switch, a thinking-level switch, or pi-modes' mode state. */
function settingChange(entry: unknown): { key: keyof TurnSettings; value: string } | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const change = (key: keyof TurnSettings, value: unknown) => {
    const label = labelOf(value);
    return label === null ? null : { key, value: label };
  };
  if (record["type"] === "model_change") return change("model", record["modelId"]);
  if (record["type"] === "thinking_level_change") return change("reasoning_effort", record["thinkingLevel"]);
  if (record["type"] === "custom" && record["customType"] === "pi-modes-state") {
    const data = record["data"];
    return change("mode", data !== null && typeof data === "object" ? (data as Record<string, unknown>)["name"] : undefined);
  }
  return null;
}

/** The settings changes in a pi transcript, in file order. A line that is torn, or has no time, is no change. */
function settingEvents(text: string): SettingEvent[] {
  const events: SettingEvent[] = [];
  for (const line of text.split("\n")) {
    if (!SETTING_LINE.test(line)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while pi is mid-append
    }
    const change = settingChange(entry);
    const at = typeof (entry as { timestamp?: unknown } | null)?.timestamp === "string" ? Date.parse((entry as { timestamp: string }).timestamp) : NaN;
    if (change !== null && !Number.isNaN(at)) events.push({ at, ...change });
  }
  return events;
}

/**
 * Stamps each pi turn with the settings in effect where it starts. `carry` is what the transcript
 * said before `text` (the metadata fold's values), and a change in `text` takes effect at the first
 * turn that starts after it, so a change is shown before the turn it precedes and only there. A
 * change after the last turn of `text` reaches the turns of the next chunk through `carry`. Other
 * sources are returned as they are.
 */
export function withPiSettings(turns: ConversationTurn[], source: string, text: string, carry: TurnSettings): ConversationTurn[] {
  if (source !== "pi-transcript") return turns;
  const events = settingEvents(text);
  const current: TurnSettings = { ...carry };
  let next = 0;
  for (const turn of turns) {
    const at = turn.ts === null ? NaN : Date.parse(turn.ts);
    if (!Number.isNaN(at)) {
      while (next < events.length && events[next]!.at <= at) {
        const event = events[next++]!;
        current[event.key] = event.value;
      }
    }
    // a session that has recorded no setting yet gets no field, so its turns keep their shape
    if (current.model !== null || current.reasoning_effort !== null || current.mode !== null) turn.settings = { ...current };
  }
  return turns;
}

/** The settings a chunk of a pi transcript starts from: what its metadata fold has read so far. */
export function piCarry(metadata: ConversationMetadata): TurnSettings {
  return { model: metadata.model, reasoning_effort: metadata.reasoning_effort, mode: metadata.mode ?? null };
}
