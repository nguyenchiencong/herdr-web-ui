import type { ConversationTurn } from "../../shared/protocol.ts";

const revisions = new WeakMap<ConversationTurn, string>();

/**
 * What changes when a turn's content does. Each poll parses the page anew, so a turn that did not
 * change is still a new object: keyed on the object, a message the chat could not draw was drawn
 * (and failed, and logged) again on every poll that changed some other turn. A 32-bit FNV-1a hash
 * of the parts and the settings, as JSON, so a rewrite of the same length tells too (two contents
 * can still collide). Every field counts, not only the text a part shows: a text part's phase, a
 * notice's label or a compaction's token count change what is drawn.
 */
export function turnRevision(turn: ConversationTurn, immutable = false): string {
  // Only parsed API snapshots opt in; ordinary callers may still mutate a turn.
  const known = immutable ? revisions.get(turn) : undefined;
  if (known !== undefined) return known;
  let hash = 0x811c9dc5;
  const add = (value: string): void => {
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
    hash = Math.imul(hash ^ 0x1f, 0x01000193);
  };
  add(JSON.stringify(turn.parts));
  // the settings marker drawn between two turns comes from this turn's settings
  add(JSON.stringify(turn.settings ?? null));
  const revision = `${turn.role}|${turn.ts ?? ""}|${turn.end_ts ?? ""}|${turn.parts.length}|${(hash >>> 0).toString(36)}`;
  if (immutable) revisions.set(turn, revision);
  return revision;
}

/**
 * The turns of a newly read page, each one whose content matches a turn of `previous` replaced by
 * that turn's object, so a memoized row drawn from that object skips its render. Matched by revision
 * rather than by position: a page that moved (a turn dropped from its start, one appended) still
 * shares the rest. The order is `next`'s, and `previous` itself comes back when nothing changed.
 */
export function shareUnchangedTurns(previous: ConversationTurn[], next: readonly ConversationTurn[]): ConversationTurn[] {
  const byRevision = new Map<string, ConversationTurn>();
  for (const turn of previous) {
    const revision = turnRevision(turn, true);
    if (!byRevision.has(revision)) byRevision.set(revision, turn);
  }
  const shared = next.map((turn) => byRevision.get(turnRevision(turn, true)) ?? turn);
  const unchanged = shared.length === previous.length && shared.every((turn, index) => turn === previous[index]);
  return unchanged ? previous : shared;
}
