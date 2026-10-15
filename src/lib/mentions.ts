import type { PaneAgent } from "../../shared/protocol.ts";

export type ActiveTrigger = {
  kind: "slash" | "file";
  /** `$`: a skill named the way Codex takes it (`$name`), anywhere a word starts; absent for `/` */
  prefix?: "$";
  query: string;
  /** Inclusive index of the trigger character. */
  start: number;
  /** Exclusive end of the token being completed. */
  end: number;
};

const SLASH_QUERY = /^[\p{L}\p{N}_-]*$/u;
const FILE_QUERY = /^\S+$/u;

// A skill token stops at the first character a skill name cannot hold, so `/del,` keeps its comma.
function tokenEnd(text: string, from: number, part: RegExp = /\S/u): number {
  let end = from;
  while (end < text.length && part.test(text[end] ?? "")) end += 1;
  return end;
}
const SKILL_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * Finds the completion token at the caret. `/` begins a word; the caller limits later tokens
 * to skills its agent honours there. With `skills`, `$skill` also completes (Codex's syntax).
 */
export function activeTrigger(text: string, caret: number, options: { skills?: boolean } = {}): ActiveTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  const lineStart = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  if (options.skills) {
    const dollar = text.lastIndexOf("$", Math.max(0, caret - 1));
    const query = dollar >= lineStart ? text.slice(dollar + 1, caret) : "";
    if (dollar >= lineStart && (dollar === 0 || /\s/u.test(text[dollar - 1] ?? "")) && SLASH_QUERY.test(query)) {
      return { kind: "slash", prefix: "$", query, start: dollar, end: tokenEnd(text, caret, SKILL_CHAR) };
    }
  }
  const slash = text.lastIndexOf("/", Math.max(0, caret - 1));
  if (slash >= lineStart && (slash === 0 || /\s/u.test(text[slash - 1] ?? ""))) {
    const query = text.slice(slash + 1, caret);
    if (SLASH_QUERY.test(query)) {
      return { kind: "slash", query, start: slash, end: tokenEnd(text, caret, SKILL_CHAR) };
    }
  }

  const at = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (at < lineStart) return null;
  const query = text.slice(at + 1, caret);
  if (query.length === 0 || !FILE_QUERY.test(query)) return null;
  return { kind: "file", query, start: at, end: tokenEnd(text, caret) };
}

/** Replaces exactly the active token and returns the caret position after the inserted completion.
 * A completion's trailing space reuses the space already after the token instead of doubling it,
 * and gives way to punctuation that follows it, leaving the caret before that punctuation. */
export function applyCompletion(
  text: string,
  trigger: ActiveTrigger,
  replacement: string,
): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const punctuated = replacement.endsWith(" ") && /^\p{P}/u.test(after);
  const inserted = replacement.endsWith(" ") && (after.startsWith(" ") || punctuated) ? replacement.slice(0, -1) : replacement;
  return { text: text.slice(0, trigger.start) + inserted + after, caret: trigger.start + (punctuated ? inserted : replacement).length };
}

/** One row of the `@` menu: a pi agent the message can mention, or a file path. */
export type MentionChoice = { kind: "agent"; agent: PaneAgent } | { kind: "file"; path: string };

/** The most agents the `@` menu lists, so the files beneath them stay in view. */
const MENTION_AGENT_LIMIT = 8;

/**
 * What the `@` menu offers for a query: the agents whose name starts with it, then those with a word
 * of the name starting with it, then those containing it; then the files, in the order given. An agent
 * always ranks above a file, and a path-like query matches no agent name.
 */
export function rankMentionChoices(query: string, agents: readonly PaneAgent[], files: readonly string[]): MentionChoice[] {
  const needle = query.toLocaleLowerCase();
  const matched = agents.flatMap((agent) => {
    const name = agent.name.toLocaleLowerCase();
    const tier = needle === "" || name.startsWith(needle) ? 0
      : name.split(/[-_]/).some((word) => word.startsWith(needle)) ? 1
        : name.includes(needle) ? 2 : null;
    return tier === null ? [] : [{ agent, tier }];
  });
  matched.sort((left, right) => left.tier - right.tier || left.agent.name.localeCompare(right.agent.name));
  return [
    ...matched.slice(0, MENTION_AGENT_LIMIT).map(({ agent }): MentionChoice => ({ kind: "agent", agent })),
    ...files.map((path): MentionChoice => ({ kind: "file", path })),
  ];
}

/** The identity of a menu row, so the highlight follows the row across renders. */
export function mentionChoiceId(choice: MentionChoice): string {
  return choice.kind === "agent" ? `agent:${choice.agent.name}` : `file:${choice.path}`;
}

/** What completing a row puts after the `@`. */
export function mentionText(choice: MentionChoice): string {
  return choice.kind === "agent" ? choice.agent.name : choice.path;
}
