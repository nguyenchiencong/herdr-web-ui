/** Shared native-record rules keep paging, rendering and on-demand results consistent. */
import type { ConversationPart, ConversationTurn, OmoTaskResult } from "../shared/protocol.ts";
import { taskNotification, type SubagentDetail, type TaskNotification } from "./claude-subagents.ts";
import { skillInvocationPrompt } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";

type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (...values: unknown[]): string | undefined => values.find((value) => typeof value === "string") as string | undefined;
export const resultText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map((part) => typeof record(part).text === "string" ? record(part).text : "").join("") : "";

export function isContextClear(value: unknown, source: string): boolean {
  const entry = record(value);
  if (source === "codex-transcript" || source === "scrollback") return false;
  if (source !== "claude-transcript") return entry.type === "custom" && entry.customType === "context_clear";
  const message = record(entry.message);
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || message.role !== "user" || typeof message.content !== "string") return false;
  // Require a whole local-command envelope; quoting /clear in prose is not a reset.
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/.test(message.content);
}

/**
 * Another Claude session's message (Claude Code cross-session messaging). It starts the agent's
 * work like a prompt, but nobody typed it here: a notice, sourced `peer:<sender>`. Claude records it
 * as a meta `user` entry when it arrives between turns, and as a queued_command attachment when it
 * arrives mid-turn; both carry `origin: { kind: "peer", name, body }`.
 */
export function claudePeerNotice(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  if (queued !== null && queued.type !== "queued_command") return null;
  if (queued === null && !(entry.type === "user" && entry.isMeta === true)) return null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  if (origin.kind !== "peer") return null;
  const envelope = queued !== null ? queued.prompt : record(entry.message).content;
  const parsed = typeof envelope === "string" ? /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(envelope) : null;
  const body = typeof origin.body === "string" ? origin.body : parsed?.[2] ?? "";
  // an unnamed sender leaves the source bare (`peer:`); the chat says "another session" for it
  const name = typeof origin.name === "string" && origin.name.trim() ? origin.name.trim() : /\bfrom-name="([^"]+)"/.exec(parsed?.[1] ?? "")?.[1] ?? "";
  return body.trim() ? { kind: "notice", text: body, source: `peer:${name}` } : null;
}

/**
 * One delivery of another session's message, as Claude identifies it: the sender and its message id.
 * Claude can record the same delivery twice (queued mid-turn, then echoed as a meta entry); the second
 * record is the same notice. Null when the record does not carry both.
 */
export function claudePeerId(value: unknown): string | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  return origin.kind === "peer" && typeof origin.from === "string" && typeof origin.msg_id === "string" && origin.from && origin.msg_id
    ? `${origin.from}|${origin.msg_id}` : null;
}

/** Pi-family providers use several spellings for the same tool call/result fields. */
export function piMessage(value: unknown): Row | null {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "message" || message.display === false || entry.display === false) return null;
  const raw = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const content = raw.map((value) => {
    const block = record(value);
    if (block.type === "toolCall") return { ...block, name: string(block.toolName, block.name), id: string(block.toolCallId, block.id, block.callId), arguments: block.toolInput ?? block.input ?? block.arguments };
    if (block.type === "toolResult") return { ...block, toolCallId: string(block.toolCallId, block.callId, block.id), content: block.output ?? block.content ?? block.result };
    return block;
  });
  return { ...message, toolCallId: string(message.toolCallId, message.callId), content };
}

/**
 * One entry's tool results, with the images each carries. pi reads a picture into a tool
 * result as inline base64 beside the text it returns, so only the position is carried in the
 * page: the bytes stay in the file and are fetched when the row is opened, the same way a
 * user-pasted image is. `index` counts the images of that one result, which is what the
 * page's ref quotes, so a fetch never has to agree with the parse about anything else.
 */
export function piResults(message: Row): { id: string; text: string; error: boolean; images: string[]; details: unknown }[] {
  const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content.filter((block) => record(block).type === "toolResult") : [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (typeof block.toolCallId !== "string") return [];
    const images = (Array.isArray(block.content) ? block.content : []).map(piImageOf).filter((image): image is { media_type: string; data: string } => image !== null).map((image) => image.media_type);
    return [{ id: block.toolCallId, text: resultText(block.content), error: block.isError === true, images, details: block.details }];
  });
}

/** The most serialized bytes of a tool result's `details` the chat keeps; a larger one is dropped, the row keeps its output. */
const TOOL_DETAILS_MAX_BYTES = 8 * 1024;

/** A scalar of `details` longer than this is content, not a field the chat reads; it stays out of the page. */
const TOOL_DETAILS_TEXT_MAX = 256;

/**
 * A tool result's `details` as plain JSON, as far as the chat reads them: the short scalars (the meta line, an
 * agent id), a classifier's `answers`, and a started task's id. Everything else (a whole output, a diff, a list of
 * files) stays out, and the rest is dropped past TOOL_DETAILS_MAX_BYTES, so a long session's page carries no copy
 * of what its rows already hold.
 */
function plainToolDetails(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number" || typeof field === "boolean" || (typeof field === "string" && field.length <= TOOL_DETAILS_TEXT_MAX)) kept[key] = field;
    else if (key === "answers" && field !== null && typeof field === "object") kept[key] = field;
    else if (key === "task" && typeof record(field).id === "string") kept[key] = { id: record(field).id };
  }
  let serialized: string | undefined;
  try { serialized = JSON.stringify(kept); } catch { return undefined; }
  if (serialized === undefined || serialized === "{}" || Buffer.byteLength(serialized, "utf8") > TOOL_DETAILS_MAX_BYTES) return undefined;
  return JSON.parse(serialized) as Record<string, unknown>;
}

/** The image types a chat shows; pi names the type `mimeType` where Claude names it `media_type`. */
const PI_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function piImageOf(value: unknown): { media_type: string; data: string } | null {
  const image = record(value);
  if (image.type !== "image") return null;
  const type = typeof image.mimeType === "string" ? image.mimeType : typeof image.media_type === "string" ? image.media_type : null;
  if (type === null || !PI_IMAGE_TYPES.has(type) || typeof image.data !== "string") return null;
  return { media_type: type, data: image.data };
}

/**
 * The `index`th image of the tool result answering `toolCallId`, decoded. `message` must
 * come from piMessage: pi-family providers spell the content field differently, and the
 * page's ref was built from the normalised one, so reading a raw entry could answer with
 * the wrong block.
 */
export function piImageBlock(message: Row, toolCallId: string, index: number): { media_type: string; data: string } | null {
  if (piResults(message).every((result) => result.id !== toolCallId)) return null;
  const blocks = message.role === "toolResult" ? [message] : (Array.isArray(message.content) ? message.content : []).filter((block) => record(block).type === "toolResult" && record(block).toolCallId === toolCallId);
  const images = blocks.flatMap((value) => { const block = record(value); return (Array.isArray(block.content) ? block.content : []).map(piImageOf); }).filter((image): image is { media_type: string; data: string } => image !== null);
  return index >= 0 ? images[index] ?? null : null;
}

/** Enough turns for a conversation. */
export const MAX_TURNS = 100;

/**
 * gjc wakes the agent with a `custom_message` (a background job's result, `display: true`)
 * in the user's seat: the answer before it is final and the work after it is a new turn.
 * Merging across it buried that answer in the work block. The envelope is chrome.
 * omp, omo and gjc keep this rule; pi's own records are classified by piCustomMessage.
 */
export function piNotice(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.display === false || typeof entry.content !== "string") return null;
  const text = entry.content.trim().replace(/^<system-notice>\s*/, "").replace(/\s*<\/system-notice>$/, "").trim();
  if (text.length === 0) return null;
  return typeof entry.customType === "string" ? { kind: "notice", text, source: entry.customType } : { kind: "notice", text };
}

const OMO_TASK_RESULT_MAX = 16_000;
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The most of a context injection a chip keeps; past it the chip says the text was cut. */
const CONTEXT_TEXT_MAX = 16_000;

/** The custom messages pi's own harness writes: `pi-context` injects project context under each prompt. */
const PI_CONTEXT_TYPE = "pi-context";
const PI_CONTEXT_HEADING = "# Project Context (pi-context)";
/** another session's message: its sender is named when the record says who sent it */
const PI_PEER_TYPES = new Set(["session-comms-message", "bots-notification"]);

/** The statuses pi's harness records use, mapped to a task card's. */
const TASK_STATUSES = new Map<string, OmoTaskResult["status"]>([
  ["completed", "completed"], ["done", "completed"], ["success", "completed"],
  ["failed", "failed"], ["error", "failed"],
  ["cancelled", "cancelled"], ["canceled", "cancelled"], ["aborted", "cancelled"], ["stopped", "cancelled"], ["killed", "cancelled"],
]);
const taskStatusOf = (value: unknown): OmoTaskResult["status"] | null => {
  const raw = label(value);
  return raw === null ? null : TASK_STATUSES.get(raw.toLowerCase()) ?? null;
};
const timeOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
/** Where the subagent type an `Agent` call asked for is kept, by task id, in the map OmO's titles share. */
const agentKey = (taskId: string): string => `agent:${taskId}`;

/** A task card from what a completion says; a result past OMO_TASK_RESULT_MAX is cut, and the card says so. */
function taskCard(task: Pick<OmoTaskResult, "id" | "title" | "agent" | "status" | "duration_ms" | "tool_calls" | "tokens" | "result">): OmoTaskResult {
  return {
    ...task,
    model: null,
    turns: null,
    result: task.result.slice(0, OMO_TASK_RESULT_MAX),
    ...(task.result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
  };
}

/**
 * A pi-subagents completion: `details` names the task and its numbers, the envelope's `<result>`
 * (else the preview `details` carries) its answer, and the Agent call that started it its type.
 */
function piSubagentTask(details: Row, text: string, agentType: (taskId: string) => string | null): OmoTaskResult | null {
  const notice = taskNotification(text);
  const id = label(details.id) ?? notice?.taskId ?? null;
  if (id === null) return null;
  const summaryTitle = /^Agent "(.*)"/.exec(notice?.summary ?? "")?.[1]?.trim();
  return taskCard({
    id,
    title: label(details.description) ?? (summaryTitle || null) ?? id,
    agent: agentType(id),
    status: taskStatusOf(details.status) ?? notice?.status ?? "cancelled",
    duration_ms: amount(details.durationMs),
    tool_calls: amount(details.toolUses),
    tokens: amount(details.totalTokens),
    result: notice?.result || label(details.resultPreview) || "",
  });
}

/** A background command's completion (pi-background-jobs): a non-zero exit is a failure, whatever its status says. */
function piBackgroundTask(details: Row): OmoTaskResult | null {
  const id = label(details.id);
  if (id === null) return null;
  const exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
  const failedExit = exitCode !== null && exitCode !== 0;
  const error = label(details.error);
  const stated = taskStatusOf(details.status);
  const started = timeOf(details.startTime);
  const ended = timeOf(details.endTime);
  let status: OmoTaskResult["status"] = stated ?? "completed";
  if (stated !== "cancelled" && (failedExit || error !== null)) status = "failed";
  return taskCard({
    id,
    title: label(details.name) ?? label(details.description) ?? id,
    agent: "command",
    status,
    duration_ms: started !== null && ended !== null && ended >= started ? ended - started : null,
    tool_calls: null,
    tokens: null,
    result: error ?? (failedExit ? `Exit code ${exitCode}` : ""),
  });
}

/** The card a harness completion ends: its details first, its envelope second. Null when it ends no task. */
function piTask(type: string, text: string, details: Row, agentType: (taskId: string) => string | null): OmoTaskResult | null {
  if (type === "background-task-notification" || text.startsWith("<background-task-notification>")) return piBackgroundTask(details);
  if (type === "subagent-notification" || taskNotification(text) !== null) return piSubagentTask(details, text, agentType);
  return null;
}

/** Who sent a message: its details name the sender (pi's session comms and bots), else its first item's sender. */
function piSender(details: Row): string | null {
  const first = record(Array.isArray(details.items) ? details.items[0] : undefined);
  const bot = details.bot;
  return label(details.senderName) ?? label(record(first.from).label) ?? label(bot) ?? label(record(bot).name) ?? label(record(bot).label);
}

/** A custom message's text, without the `<system-notice>` envelope some extensions wrap it in. */
function customMessageText(content: unknown): string {
  const body = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap((block) => { const part = record(block); return part.type === "text" && typeof part.text === "string" ? [part.text] : []; }).join("\n")
    : "";
  return body.trim().replace(/^<system-notice>\s*/, "").replace(/\s*<\/system-notice>$/, "").trim();
}

/** A runtime's name for a notice, read as words: `session-comms-notification` reads "Session comms". */
function humanised(type: string): string {
  const words = type.replace(/[:_-]+/g, " ").replace(/ (?:notification|message)$/i, "").trim().slice(0, 96).trim();
  return words === "" ? "Notice" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Project context a harness injected under a prompt: its counts when it reports them, its text up to CONTEXT_TEXT_MAX. */
function piContextChip(text: string, details: Row): Extract<ConversationPart, { kind: "context" }> {
  const counts = [amount(details.pinnedCount), amount(details.inlineCount)].filter((count): count is number => count !== null);
  const tokens = amount(details.achievedTokens);
  return {
    kind: "context",
    text: text.slice(0, CONTEXT_TEXT_MAX),
    ...(text.length > CONTEXT_TEXT_MAX ? { text_cut: true } : {}),
    ...(counts.length > 0 ? { docs: counts.reduce((sum, count) => sum + count, 0) } : {}),
    ...(tokens !== null ? { tokens } : {}),
  };
}

/** The most of each part of a compaction summary the chat keeps; past it the card says the summary was cut. */
const COMPACT_TEXT_MAX = 16_000;
/** pi writes the summary it folded in a `<previous-summary>` block; the block is the earlier part, the rest the newest. */
const PREVIOUS_SUMMARY = /<previous-summary>([\s\S]*?)(?:<\/previous-summary>|$)/;

/**
 * A compaction's card: the newest part of its summary and, apart from it, the earlier summary pi folded in
 * (the chat shows it on request), each bounded, with the context the compaction folded when pi recorded it.
 */
function piCompactPart(summary: string, tokens: number | null): Extract<ConversationPart, { kind: "compact" }> {
  const match = PREVIOUS_SUMMARY.exec(summary);
  const newest = (match === null ? summary : summary.slice(0, match.index) + summary.slice(match.index + match[0].length)).trim();
  const earlier = match?.[1]?.trim() ?? "";
  const cut = newest.length > COMPACT_TEXT_MAX || earlier.length > COMPACT_TEXT_MAX;
  return {
    kind: "compact",
    text: newest.slice(0, COMPACT_TEXT_MAX),
    ...(earlier.length > 0 ? { earlier: earlier.slice(0, COMPACT_TEXT_MAX) } : {}),
    ...(cut ? { text_cut: true } : {}),
    ...(tokens !== null ? { tokens } : {}),
  };
}

/**
 * What a pi `custom_message` is in the chat, or null when it draws nothing: hidden, empty, or project
 * context with no prompt open to hang on. A harness completion is a task card; another session's
 * message a notice sourced `peer:<sender>`; project context a chip on the prompt it follows (never a
 * turn of its own); anything else a notice labelled from its customType.
 */
export function piCustomMessage(value: unknown, context: { afterPrompt: boolean; agentType: (taskId: string) => string | null }): ConversationPart | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.display === false) return null;
  const text = customMessageText(entry.content);
  if (text.length === 0) return null;
  const type = typeof entry.customType === "string" ? entry.customType : "";
  const details = record(entry.details);
  const task = piTask(type, text, details, context.agentType);
  if (task !== null) return { kind: "task_result", tasks: [task] };
  const sender = piSender(details);
  if (sender !== null || PI_PEER_TYPES.has(type)) return { kind: "notice", text, source: `peer:${sender ?? ""}` };
  // only project context is a chip: any other message after a prompt keeps its own label
  if (type === PI_CONTEXT_TYPE || text.startsWith(PI_CONTEXT_HEADING)) return context.afterPrompt ? piContextChip(text, details) : null;
  return { kind: "notice", text, ...(type === "" ? {} : { source: type }), label: humanised(type) };
}

/** A runtime notice or a task card in the user's seat: it takes no place in the turn budget. */
const isRuntimeTurn = (turn: ConversationTurn): boolean =>
  turn.role === "user" && turn.parts.length > 0 && turn.parts.every((part) => part.kind === "notice" || part.kind === "task_result");

/** The newest `maxTurns` turns, counting only the conversation (see isRuntimeTurn); the notices among or after them stay. */
function keepNewest(turns: ConversationTurn[], maxTurns: number): ConversationTurn[] {
  let counted = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!isRuntimeTurn(turns[index]!)) counted += 1;
    if (counted === maxTurns) return turns.slice(index);
  }
  return turns;
}

/**
 * The summaries OmO's `task` calls gave their tasks, by task id: the call's result names the
 * task it started (`details.task_id`, or one `details.items` entry per task of a batch).
 */
export function omoTaskTitles(message: Row, titles: Map<string, string>): void {
  if (message.role !== "toolResult" || message.toolName !== "task") return;
  const details = record(message.details);
  for (const value of Array.isArray(details.items) ? details.items : [details]) {
    const item = record(value);
    const id = label(item.task_id);
    const title = label(item.task_summary) ?? label(item.description);
    if (id !== null && title !== null) titles.set(id, title);
  }
}

/**
 * OmO wakes its agent when a background task ends with a `custom_message` (`omo-senpi:wake`,
 * `display: false`) whose details hold one `senpi-task.completion` per task. It is the only
 * record that the task ended and what it found, so it is drawn in the user's seat as gjc's
 * notice is; a wake that carries no task result (a monitor's event) stays the runtime's.
 */
export function omoTaskResults(value: unknown, titles: ReadonlyMap<string, string>): OmoTaskResult[] | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.customType !== "omo-senpi:wake" || !Array.isArray(entry.details)) return null;
  // one row per task: a task reported twice in one wake is the later report (the rows are keyed by id)
  const tasks = new Map<string, OmoTaskResult>();
  for (const group of entry.details) {
    if (record(group).customType !== "senpi-task.completion" || !Array.isArray(record(group).details)) continue;
    for (const value of record(group).details as unknown[]) {
      const task = record(value);
      const id = label(task.task_id);
      const raw = label(task.status);
      if (id === null || raw === null) continue;
      const stats = record(task.run_stats);
      const agent = label(task.agent_type) ?? label(task.category) ?? label(task.subagent_type);
      const name = label(task.name);
      const result = label(task.final_response) ?? label(task.error) ?? "";
      tasks.set(id, {
        id,
        title: titles.get(id) ?? (name !== null && name !== id ? name : agent ?? id),
        agent,
        model: label(record(task.resolved_model).display) ?? label(task.model),
        status: raw === "completed" ? "completed" : raw === "cancelled" || raw === "canceled" || raw === "aborted" ? "cancelled" : "failed",
        duration_ms: amount(task.duration_ms) ?? amount(stats.runtime_ms),
        turns: amount(stats.turns),
        tool_calls: amount(stats.tool_calls),
        tokens: amount(stats.total_tokens) ?? amount(task.tokens),
        result: result.slice(0, OMO_TASK_RESULT_MAX),
        ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
      });
    }
  }
  return tasks.size > 0 ? [...tasks.values()] : null;
}

/**
 * The card for a Claude Code subagent that ended, from its `<task-notification>` alone and the
 * subagent's meta file (its description and agent type, which never change after it starts), so
 * that a page reads the same from a cold start as from a warm one. The turns, tool calls and
 * tokens a subagent's transcript holds grow with it, and the status line's list shows them.
 */
export function agentTaskResult(notice: TaskNotification, detail: SubagentDetail | undefined): OmoTaskResult {
  const result = notice.result;
  return {
    id: notice.taskId,
    title: detail?.title ?? /^Agent "(.*)"/.exec(notice.summary)?.[1]?.trim() ?? notice.taskId,
    agent: detail?.agent ?? null,
    model: null,
    status: notice.status,
    duration_ms: null,
    turns: null,
    tool_calls: null,
    tokens: null,
    result: result.slice(0, OMO_TASK_RESULT_MAX),
    ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
  };
}

/** The one-line summary a collapsed tool chip shows. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  // an OmO or omp `task` call: the summary it gave the person, one per task of a batch
  if (name === "task") {
    const items = Array.isArray(input["tasks"]) ? input["tasks"].map(record) : [input];
    const titles = items.map((item) => label(item["task_summary"]) ?? label(item["description"])).filter((title) => title !== null);
    if (titles.length > 0) return titles.join(" · ").slice(0, 120);
  }
  // what the agent itself said the call is for: OmO's eval `summary`, the `description` Claude
  // gives a Bash command or a subagent's prompt. Another tool's `description` is its own data.
  const said = typeof input["code"] === "string" ? label(input["summary"])
    : typeof input["command"] === "string" || typeof input["prompt"] === "string" ? label(input["description"]) : null;
  if (said !== null) return said.slice(0, 120);
  // pi names a file `path` where Claude names it `file_path`, and a notebook `notebook_path`.
  const first = input["command"] ?? input["file_path"] ?? input["notebook_path"] ?? input["path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/**
 * Splits one omp session jsonl into turns. Same shape of result as the Claude
 * parser: adjacent assistant messages merge, toolCall parts adopt the output
 * of the toolResult entry that answers them (matched by toolCallId), thinking
 * stays private to the agent.
 *
 * An assistant message that stopped for good (`stopReason: "stop"`) ends its turn: the next one
 * was woken by something nobody typed, such as omo's hidden monitor or background-task
 * notification. Merging across it folded the answer before it into the next turn's work block.
 *
 * With `options.pi` the records are pi's own (see piCustomMessage): a notice that arrives while the
 * turn is at work stays in that turn, adjacent compactions merge into one card, and runtime notices
 * take no place in `maxTurns`.
 */
export function parseOmpTranscript(text: string, maxTurns = MAX_TURNS, options: { toolImages?: boolean; taskTitles?: Map<string, string>; pi?: boolean } = {}): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pi = options.pi === true;
  /** tool parts still waiting for their result, by toolCall id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  /** what OmO's `task` calls called their tasks, by task id: the caller's, when it parses a page in stretches; pi's subagent types too (agentKey) */
  const taskTitles = options.taskTitles ?? new Map<string, string>();
  /** the last assistant message stopped for good: the next one starts a turn of its own */
  let settled = false;
  /** the prompt no assistant message has answered yet: project context injected now belongs to it */
  let openPrompt: ConversationTurn | null = null;
  /** the subagent type each pi `Agent` call asked for, by call id, until its result names the subagent's id */
  const agentCalls = new Map<string, string>();

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant" && !settled) return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  const contentParts = (content: unknown): { type?: string; text?: unknown }[] =>
    Array.isArray(content) ? content.filter((part) => typeof part === "object" && part !== null) : [];

  /**
   * A custom message pi's harness wrote, placed in the chat. Context joins the prompt it follows; a
   * notice or a task card joins the turn still at work, so that turn stays whole, and else starts a
   * user-seat turn of its own. Adjacent task cards merge into one.
   */
  const placePiMessage = (entry: unknown, ts: string | undefined): void => {
    const part = piCustomMessage(entry, { afterPrompt: openPrompt !== null, agentType: (taskId) => taskTitles.get(agentKey(taskId)) ?? null });
    if (part === null) return;
    if (part.kind === "context") {
      openPrompt?.parts.push(part);
      return;
    }
    const last = turns[turns.length - 1];
    if (!settled && last?.role === "assistant") {
      last.parts.push(part);
      return;
    }
    const previous = last?.role === "user" ? last.parts[0] : undefined;
    if (part.kind === "task_result" && last?.role === "user" && last.parts.length === 1 && previous?.kind === "task_result") {
      const seen = new Set(previous.tasks.map((task) => task.id));
      last.parts[0] = { kind: "task_result", tasks: [...previous.tasks, ...part.tasks.filter((task) => !seen.has(task.id))] };
      return;
    }
    turns.push({ role: "user", ts: ts ?? null, parts: [part] });
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while omp is mid-append
    }
    if (entry === null || typeof entry !== "object") continue;
    if (isContextClear(entry, "omp-transcript")) { turns.length = 0; pending.clear(); openPrompt = null; continue; }
    const timestamp = (entry as { timestamp?: string }).timestamp;
    if (pi && (entry as { type?: unknown }).type === "custom_message") {
      placePiMessage(entry, timestamp);
      continue;
    }
    const notice = piNotice(entry);
    if (notice !== null) {
      turns.push({ role: "user", ts: timestamp ?? null, parts: [notice] });
      continue;
    }
    const results = omoTaskResults(entry, taskTitles);
    if (results !== null) {
      turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "task_result", tasks: results }] });
      continue;
    }
    // pi folds old context into a summary of its own accord and on /compact. The entry is a
    // tree entry, not a message, so it reaches the chat only through this branch: the card
    // says where the conversation was cut, and pi keeps answering from the summary onward.
    // piNotice (and placePiMessage) above only claim `custom_message`, so a compaction entry always reaches here.
    if ((entry as { type?: unknown }).type === "compaction") {
      const summary = (entry as { summary?: unknown }).summary;
      openPrompt = null;
      if (typeof summary === "string" && summary.trim().length > 0) {
        const part = piCompactPart(summary, amount((entry as { tokensBefore?: unknown }).tokensBefore));
        const card: ConversationTurn = { role: "user", ts: timestamp ?? null, parts: [part] };
        const last = turns[turns.length - 1];
        const earlierCard = last?.role === "user" && last.parts.length === 1 ? last.parts[0] : undefined;
        // pi folds again before a fold's card was read: the later summary carries the earlier one inside it, and the
        // card keeps the later figure, or the earlier one when the later records none
        if (pi && earlierCard?.kind === "compact") {
          if (part.tokens === undefined && earlierCard.tokens !== undefined) part.tokens = earlierCard.tokens;
          turns[turns.length - 1] = card;
        } else turns.push(card);
      }
      continue;
    }
    const message = piMessage(entry);
    if (message === null) continue;
    const applyResults = () => {
      for (const result of piResults(message)) {
        // the result an Agent call got names the subagent it started; that subagent's completion reports the type
        const subagentType = agentCalls.get(result.id);
        const subagentId = subagentType === undefined ? undefined : /Agent ID:\s*([A-Za-z0-9_-]+)/.exec(result.text)?.[1];
        if (pi && subagentType !== undefined && subagentId !== undefined) taskTitles.set(agentKey(subagentId), subagentType);
        const tool = pending.get(result.id);
        if (!tool) continue;
        pending.delete(result.id);
        trimOutput(tool, result.text, result.id);
        if (result.error) tool.error = true;
        // pi's structured result for the row: the chat reads it, the output above stays as it was
        const details = pi ? plainToolDetails(result.details) : undefined;
        if (details !== undefined) tool.details = details;
        if (options.toolImages === true && result.images.length > 0) {
          // addressed by the call it answers: a nested result shares its entry with other
          // blocks, so the entry id alone could not say which one an image came from
          tool.images = result.images.map((media_type, index) => ({ media_type, ref: `pi:${result.id}:${index}` }));
        }
      }
    };
    if (message.role !== "assistant") applyResults();
    omoTaskTitles(message, taskTitles);

    if (message.role === "user") {
      const prompt =
        typeof message.content === "string"
          ? message.content
          : contentParts(message.content)
              .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
              .filter((part) => part.length > 0)
              .join("\n");
      if (prompt.length === 0) continue; // image-only user parts have no text to show
      // a skill invocation reads as what the user asked, the skill as a chip on it: not as the
      // SKILL.md the runtime put before it. Kept on this record, so no page boundary can part them
      const invocation = skillInvocationPrompt(prompt);
      const asked = invocation === null ? prompt : invocation.request || invocation.skills.map((skill) => `/skill:${skill.name}`).join(" ");
      const turn: ConversationTurn = { role: "user", ts: timestamp ?? null, parts: [{ kind: "text", text: asked }, ...(invocation?.skills ?? []).map((skill) => ({ kind: "skill" as const, skill }))] };
      turns.push(turn);
      openPrompt = turn;
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      openPrompt = null;
      const turn = assistantTurn(timestamp);
      if (timestamp) turn.end_ts = timestamp;
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; intent?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const input = (typeof b.arguments === "object" && b.arguments !== null ? b.arguments : {}) as Record<string, unknown>;
          const summary = typeof b.intent === "string" && b.intent.length > 0 ? b.intent : toolSummary(b.name, input);
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: summary.slice(0, 120),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          turn.parts.push(part);
          if (typeof b.id === "string") pending.set(b.id, part);
          if (pi && b.name === "Agent" && typeof b.id === "string") {
            const subagentType = input["subagent_type"];
            if (typeof subagentType === "string") agentCalls.set(b.id, subagentType);
          }
        }
        // unsupported transcript parts are intentionally ignored
      }
      // A provider can place a result beside its call in the same assistant record.
      applyResults();
      // a failed request (a 401, an overloaded provider) leaves an empty message: without its
      // error the chat showed the prompt with no answer at all
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
        turn.parts.push({ kind: "text", text: `Error: ${message.errorMessage}` });
      }
      settled = message.stopReason === "stop";
    }
  }

  const shown = turns.filter((turn) => turn.parts.length > 0);
  return pi ? keepNewest(shown, maxTurns) : shown.slice(-maxTurns);
}
