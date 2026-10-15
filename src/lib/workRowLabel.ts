import { toolProfile } from "./toolProfiles.ts";
import { isToolNarration, toolVerb } from "./toolVerbs.ts";

/**
 * The word a row shows in place of its tool id, and whether its summary is the agent's own sentence.
 * A profiled tool (lib/toolProfiles.ts) shows its label and is never a narration: its summary is the
 * object of the call, under the label. Any other tool keeps the verb and narration decisions.
 */
export function workRowLabel(part: { name: string; input: string }, summary: string): { narration: boolean; verb: string | null } {
  const profile = toolProfile(part.name);
  if (profile !== null) return { narration: false, verb: profile.label };
  return { narration: isToolNarration(part, summary), verb: toolVerb(part, summary) };
}
