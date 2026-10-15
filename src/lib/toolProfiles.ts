/**
 * The tool calls a coding agent's extensions make, each named by what a reader wants to know: a
 * label, an icon, the argument that summarises the call, and the work-block category it counts
 * under. Data only, so a new extension tool is one row in TOOL_PROFILES. A tool the table does not
 * know keeps the generic row: its id, a `key: value` summary taken from its arguments, and its
 * arguments as fields (ChatView's ArgumentList).
 */

export type ToolCategory = "subagent" | "command" | "search" | "web" | "other";

/** The glyph a profiled row shows; ChatView maps each name to an icon. */
export type ToolIcon = "subagent" | "steer" | "result" | "background" | "stop" | "code" | "classify" | "claim" | "message" | "search" | "image";

/** The kind of call a summary argument refers to: an Agent's subagent id, or a bg_run's task id. */
export type ReferenceKind = "agent" | "task";

export interface ToolProfile {
  /** what the row shows in place of the tool id: an English key the dictionaries translate */
  label: string;
  icon: ToolIcon;
  /** the argument whose value summarises the call; a `code` argument is summarised by the tools it calls */
  summary: string;
  /** the summary argument is an id of another call in the turn: the row shows that call's own text, else `key: value` */
  refers?: ReferenceKind;
  /** the output is plain text whatever it looks like: a log, a list of matches */
  plain?: true;
  category: ToolCategory;
}

/** A tool call as the chat holds it: what it was asked, and what came back. */
export interface ToolCall {
  name: string;
  input: string;
  output: string;
  details?: Record<string, unknown>;
}

/** The summary is cut to the length the server cuts a row's summary to (server/transcript-records.ts). */
const SUMMARY_LENGTH = 120;

/** Argument keys a reader wants first in a `key: value` summary, in this order. */
const HUMAN_KEYS = ["description", "name", "message", "target", "query", "action"];

/** A scalar argument longer than this is not short enough to put in a summary. */
const SHORT_SCALAR = 80;

/**
 * The profiles by the tool's exact id. Labels are the English keys the dictionaries translate, and
 * src/lib/i18n.test.ts reads them from this table.
 */
export const TOOL_PROFILES: Readonly<Record<string, ToolProfile>> = {
  Agent: { label: "Subagent", icon: "subagent", summary: "description", category: "subagent" },
  get_subagent_result: { label: "Subagent result", icon: "result", summary: "agent_id", refers: "agent", category: "subagent" },
  steer_subagent: { label: "Steer subagent", icon: "steer", summary: "agent_id", refers: "agent", category: "subagent" },
  bg_run: { label: "Background task", icon: "background", summary: "name", plain: true, category: "command" },
  bg_status: { label: "Background status", icon: "background", summary: "taskId", refers: "task", plain: true, category: "command" },
  bg_logs: { label: "Background output", icon: "background", summary: "taskId", refers: "task", plain: true, category: "command" },
  bg_kill: { label: "Stop background task", icon: "stop", summary: "taskId", refers: "task", plain: true, category: "command" },
  codemode: { label: "Code", icon: "code", summary: "code", category: "command" },
  jev_decide: { label: "Classifier", icon: "classify", summary: "goal", category: "other" },
  repo_claim: { label: "Repo claim", icon: "claim", summary: "action", category: "other" },
  send_session_message: { label: "Session message", icon: "message", summary: "target", category: "other" },
  get_session_message: { label: "Session reply", icon: "message", summary: "messageId", category: "other" },
  ffgrep: { label: "Search", icon: "search", summary: "pattern", plain: true, category: "search" },
  fffind: { label: "Find files", icon: "search", summary: "pattern", plain: true, category: "search" },
  rg_grep: { label: "Search", icon: "search", summary: "pattern", plain: true, category: "search" },
  classify_context: { label: "Classify context", icon: "classify", summary: "instructions", category: "other" },
  generate_image: { label: "Generate image", icon: "image", summary: "prompt", category: "other" },
};

/** The profile of a tool the table names, by its exact id; null for any other tool. */
export function toolProfile(name: string): ToolProfile | null {
  return Object.hasOwn(TOOL_PROFILES, name) ? TOOL_PROFILES[name] ?? null : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A call's arguments as the object its input holds; an input that is not one reads as none. */
export function argumentsOf(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** The first line of a text that has something on it, cut to the summary's length. */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, SUMMARY_LENGTH);
}

/** A string argument, trimmed, or null when it is missing or blank. */
function textArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A scalar argument as text when it is short enough for a summary: a single line, a number or a boolean. */
function shortScalar(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string" && value.trim() !== "" && !value.includes("\n") && value.length <= SHORT_SCALAR) return value.trim();
  return null;
}

/**
 * The id of the subagent an Agent call started: its result's details, else the `Agent ID:` line a
 * background run answers with.
 */
export function agentIdOf(call: ToolCall): string | null {
  const id = call.details?.["agentId"];
  if (typeof id === "string" && id.length > 0) return id;
  return /^Agent ID: ([\w-]+)[ \t]*$/m.exec(call.output)?.[1] ?? null;
}

/**
 * The id of the background task a bg_run call started: its result's details, else the `Started
 * background task` line it answers with.
 */
export function taskIdOf(call: ToolCall): string | null {
  const task = call.details?.["task"];
  const id = isRecord(task) ? task["id"] : undefined;
  if (typeof id === "string" && id.length > 0) return id;
  return /^Started background task (\S+)/m.exec(call.output)?.[1] ?? null;
}

/** What each reference kind names: the tool that starts the call, the id its result gives, and the argument that says what it is. */
const REFERENCES: Record<ReferenceKind, { tool: string; idOf: (call: ToolCall) => string | null; text: string }> = {
  agent: { tool: "Agent", idOf: agentIdOf, text: "description" },
  task: { tool: "bg_run", idOf: taskIdOf, text: "name" },
};

/** The text of the latest earlier call that the reference names; null when no call in the turn does. */
function referredText(kind: ReferenceKind, id: string, earlier: readonly ToolCall[]): string | null {
  const reference = REFERENCES[kind];
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const call = earlier[index]!;
    if (call.name !== reference.tool || reference.idOf(call) !== id) continue;
    const text = textArg(argumentsOf(call.input), reference.text);
    if (text !== null) return firstLine(text);
  }
  return null;
}

/**
 * The tools a script calls, as the summary of a `code` argument: `bash ×2, read`. A script that
 * calls none reads as its first line.
 */
export function codeSummary(code: string): string {
  const counts = new Map<string, number>();
  for (const match of code.matchAll(/\btools\.(\w+)\s*\(/g)) {
    const name = match[1]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return firstLine(code);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ").slice(0, SUMMARY_LENGTH);
}

/**
 * `key: value` from a call's arguments: a human key first (description, name, a message's first
 * line, target, query, action), then an id (`agent_id`, `taskId`), then the first short scalar.
 * Null when there is nothing short to show.
 */
export function fallbackSummary(args: Record<string, unknown>): string | null {
  for (const key of HUMAN_KEYS) {
    const text = textArg(args, key);
    if (text !== null) return `${key}: ${firstLine(text)}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const text = /(?:^id|Id|_id)$/.test(key) ? shortScalar(value) : null;
    if (text !== null) return `${key}: ${text}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const text = shortScalar(value);
    if (text !== null) return `${key}: ${text}`;
  }
  return null;
}

/**
 * The summary of a call the table names: its summary argument's first line, the text of the call a
 * reference names, or `key: value` when that call is not in the turn. Empty when the call has no
 * such argument and nothing else short. Null for a tool the table does not know.
 */
export function callSummary(call: ToolCall, earlier: readonly ToolCall[]): string | null {
  return summaryWith(call, (kind, id) => referredText(kind, id, earlier));
}

/** callSummary, with the text a reference names looked up by `refer`. */
function summaryWith(call: ToolCall, refer: (kind: ReferenceKind, id: string) => string | null): string | null {
  const profile = toolProfile(call.name);
  if (profile === null) return null;
  const args = argumentsOf(call.input);
  const value = textArg(args, profile.summary);
  if (value === null) return fallbackSummary(args) ?? "";
  if (profile.summary === "code") return codeSummary(value);
  if (profile.refers === undefined) return firstLine(value);
  return refer(profile.refers, value) ?? `${profile.summary}: ${firstLine(value)}`;
}

/**
 * rowSummary for every call of a turn, in one pass: each call's references resolve against the calls
 * before it, as rowSummary's `earlier` would, but each call's arguments are read once, so a turn of
 * many subagent results is not read again for every row.
 */
export function rowSummaries<Call extends ToolCall & { summary: string }>(calls: readonly Call[]): Map<Call, string> {
  const known: Record<ReferenceKind, Map<string, string>> = { agent: new Map(), task: new Map() };
  const summaries = new Map<Call, string>();
  for (const call of calls) {
    const profiled = summaryWith(call, (kind, id) => known[kind].get(id) ?? null);
    summaries.set(call, profiled ?? (call.summary !== "" && call.summary !== call.name ? call.summary : fallbackSummary(argumentsOf(call.input)) ?? call.summary));
    // this call, once read, is what a later reference to its id names: the latest one wins, as in referredText
    for (const kind of ["agent", "task"] as const) {
      const reference = REFERENCES[kind];
      if (call.name !== reference.tool) continue;
      const id = reference.idOf(call);
      const text = id === null ? null : textArg(argumentsOf(call.input), reference.text);
      if (id !== null && text !== null) known[kind].set(id, firstLine(text));
    }
  }
  return summaries;
}

/**
 * What a work row says after its label or tool id: a profiled call's own summary; else the server's
 * summary when it names the call; else `key: value` from its arguments, so a bare id is never all
 * a reader gets for a call that has arguments.
 */
export function rowSummary(call: ToolCall, earlier: readonly ToolCall[], serverSummary: string): string {
  const profiled = callSummary(call, earlier);
  if (profiled !== null) return profiled;
  if (serverSummary !== "" && serverSummary !== call.name) return serverSummary;
  return fallbackSummary(argumentsOf(call.input)) ?? serverSummary;
}

/** One replaced span of a file: the text it had, and the text it has now. */
export interface EditPair {
  before: string;
  after: string;
}

/** The first of a set of keys that holds a string, as it is (an edit's whitespace is part of it). */
function rawString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function editPair(args: Record<string, unknown>): EditPair | null {
  const before = rawString(args, ["oldText", "old_string"]);
  const after = rawString(args, ["newText", "new_string"]);
  return before === undefined && after === undefined ? null : { before: before ?? "", after: after ?? "" };
}

/**
 * The spans a file edit replaces, in order: each entry of `edits` (pi's `oldText`/`newText`, or
 * Claude's `old_string`/`new_string`), else the call's own pair. Null when the arguments hold no
 * edit, or an entry of the list holds none.
 */
export function editPairs(args: Record<string, unknown>): EditPair[] | null {
  const edits: unknown = args["edits"];
  if (Array.isArray(edits)) {
    const pairs = edits.map((item: unknown) => (isRecord(item) ? editPair(item) : null));
    return pairs.length > 0 && pairs.every((pair): pair is EditPair => pair !== null) ? pairs : null;
  }
  const pair = editPair(args);
  return pair === null ? null : [pair];
}
