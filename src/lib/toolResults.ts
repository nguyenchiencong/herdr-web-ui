/**
 * What a tool result shows beyond its text: whether its output reads as Markdown, the scalars of its
 * structured result as one meta line, and a classifier's answers as a table. Each is decided by the
 * shape of the data, not by the tool's name, except where a call is a shell, a file or an edit.
 */
import { formatTokens } from "./compose.ts";
import { t } from "./i18n.ts";
import { formatElapsed } from "./omoTasks.ts";
import { isRecord, toolProfile, type ToolCall } from "./toolProfiles.ts";
import { toolVerbKind } from "./toolVerbs.ts";

/**
 * Whether text reads as Markdown: a heading, a fenced block, a table with its rule, or two or more
 * list items. A unified diff is never Markdown, though its hunks read as list items.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (/^ {0,3}#{1,6}[ \t]+\S/m.test(text) || /^ {0,3}(?:`{3,}|~{3,})/m.test(text)) return true;
  if (/^[ \t]*\|.*\|[ \t]*$/m.test(text) && /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m.test(text)) return true;
  if (/^(?:@@ |diff --git |\+\+\+ )/m.test(text)) return false;
  return (text.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/gm) ?? []).length >= 2;
}

/**
 * Whether a call's output is drawn as Markdown. A shell's, a file's or an edit's output never is
 * (its verb says so), nor is a profile's plain output (a log, a list of matches); any other output
 * that reads as Markdown is.
 */
export function rendersAsMarkdown(call: ToolCall, output: string): boolean {
  if (toolVerbKind(call.name, call.input) !== null || toolProfile(call.name)?.plain === true) return false;
  return looksLikeMarkdown(output);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A status as the meta line words it: a finished call reads "done", a failed one "failed"; any other status reads as it is. */
function statusWord(status: string): string {
  if (status === "completed" || status === "done") return t("done");
  if (status === "failed" || status === "error") return t("failed");
  if (status === "cancelled" || status === "canceled" || status === "aborted" || status === "stopped") return t("cancelled");
  return status;
}

/**
 * The scalars of a call's structured result as one dim line, `done · 25m 31s · 660k tokens · 96 tool
 * calls · 3 turns`: its status, duration, tokens, tool calls and turns, whichever it carries. Other
 * fields (ids, paths, lists) stay out of the line. Empty when none of them is there.
 */
export function resultMeta(details: Record<string, unknown> | undefined): string {
  if (details === undefined) return "";
  const items: string[] = [];
  const status = details["status"];
  if (typeof status === "string" && status.trim() !== "") items.push(statusWord(status.trim()));
  const duration = details["durationMs"];
  if (isCount(duration)) items.push(formatElapsed(duration));
  const tokens = details["tokens"];
  if (isCount(tokens)) items.push(t("{n} tokens", { n: formatTokens(tokens) }));
  else if (typeof tokens === "string" && tokens.trim() !== "") items.push(t("{n} tokens", { n: tokens.trim() }));
  const toolUses = details["toolUses"];
  if (isCount(toolUses)) items.push(t(toolUses === 1 ? "{n} tool call" : "{n} tool calls", { n: toolUses }));
  const turns = details["turnCount"];
  if (isCount(turns)) items.push(t(turns === 1 ? "{n} turn" : "{n} turns", { n: turns }));
  return items.join(" · ");
}

/** One of a classifier's answers: the question it answers, the kind and value of the answer, and how sure the classifier was. */
export interface ClassifierAnswer {
  question: string;
  kind: "score" | "choice" | "noul";
  value: number | string;
  /** 0 to 1; null for an answer that carries none, such as a yes-or-no */
  confidence: number | null;
}

function classifierAnswer(question: string, answer: unknown): ClassifierAnswer | null {
  if (!isRecord(answer)) return null;
  const rawConfidence = answer["confidence"];
  const confidence = typeof rawConfidence === "number" ? rawConfidence : null;
  const type = answer["type"];
  const score = answer["score"];
  const choice = answer["choice"];
  const noul = answer["noul"];
  if (type === "score" && typeof score === "number") return { question, kind: "score", value: score, confidence };
  if (type === "choice" && typeof choice === "string") return { question, kind: "choice", value: choice, confidence };
  if (type === "noul" && typeof noul === "number") return { question, kind: "noul", value: noul, confidence };
  return null;
}

/**
 * A `jev_decide`-shaped answer table: `details.answers` holds one entry per question, and each entry
 * has its `type` and the value that type carries (`score`, `choice` or `noul`). Null unless every
 * entry has that shape, so a tool that merely has an `answers` field is not drawn as a classifier.
 */
export function classifierAnswers(details: Record<string, unknown> | undefined): ClassifierAnswer[] | null {
  const answers = details?.["answers"];
  if (!isRecord(answers)) return null;
  const rows = Object.entries(answers).map(([question, answer]) => classifierAnswer(question, answer));
  return rows.length > 0 && rows.every((row): row is ClassifierAnswer => row !== null) ? rows : null;
}
