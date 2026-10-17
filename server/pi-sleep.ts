import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { HibernatedPane } from "../shared/protocol.ts";
import { agentMayBeAsleep } from "../shared/sleep-agent.ts";
import { piAgentDir } from "./pi-models.ts";

export { agentMayBeAsleep };

/**
 * A pi session the sleep launcher holds in its pane (pi-launcher-hibernate.mjs). The launcher
 * keeps the pane alive, prints the banner below and reports `zz <title>` as the pane title. herdr
 * names no agent for that pane when the launcher runs under its own name, and keeps naming pi when
 * the launcher runs as a process named pi (a `pi.cmd` wrapper, a `pi.exe` copy): then the agent's
 * status and session are the ones pi reported before the sleep. The launcher also reports its pane as
 * the agent `zz pi` (SLEEP_AGENT_LABEL, idle, state label `asleep`) while it sleeps, and releases that
 * listing before it resumes or quits. The sleep record pi's hibernate extension writes at
 * `<agent dir>/state/hibernate/<session id>.json` is what ties the pane to the session.
 */

/** The launcher's banner tail, compacted (spaces gone), so a pane that wraps it still matches. */
const SLEEP_BANNER_TAIL = "\u2014Entertoresume,qtoquit";
/** How many rows above the screen's end a wrapped banner can take on a narrow pane. */
const SLEEP_BANNER_ROWS = 16;
const SLEEP_TITLE_PREFIX = "zz ";
const RECORD_DIR = ["state", "hibernate"] as const;
/** The record files are small; a draft is the only part that grows, and the extension caps it. */
const RECORD_MAX_BYTES = 512 * 1024;
/**
 * A directory whose modification time has not moved is still scanned after this: a safety net for
 * filesystems with coarse times. A scan stats each record and parses only the ones that changed.
 */
const RECORD_CACHE_MS = 2_000;
/**
 * How long a wake holds its pane: nothing is typed into a pane that pi is still starting in, and the hold runs out after
 * this with pi not ready (PiWakes, refuseWhileWaking in server/index.ts).
 */
export const PI_WAKING_MS = 60_000;
/**
 * How long a sleep may still be starting while its pane shows no launcher title. pi exits before the launcher sets its
 * `zz` title, and pi-hibernate writes the sleep's record (sleptAt) before pi exits, so the title follows sleptAt. A real
 * launcher run measured the title 0.5 to 0.9 s after /sleep; 15 s is more than fifteen times the slowest of those, a margin
 * for a slower run. Past the window a record with no title holds nothing: processAlive reads a pid another process has
 * reused as a live launcher, and a pane restored as a plain shell has no title to say otherwise. A wake the server began is
 * held by its marker at any age (PiWakes), not by this window.
 */
export const SLEEP_TITLE_WAIT_MS = 15_000;

export interface SleepRecord {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  title: string;
  state: string;
  paneId: string;
  /** the launcher holding the pane: a record whose launcher is gone holds nothing (sleepingRecordOf) */
  launcherPid: number | null;
  draft: string;
  nextDueAt: string | null;
  sleptAt: string;
  /** when pi's hibernate extension finished a resumed launch, written after the draft is restored; null for an install that writes none (readyMarked) */
  readyAt: string | null;
  /** when the launcher ended the sleep (state awake or quit); null while the record sleeps (unmarkedWakeAt) */
  endedAt: string | null;
}

/**
 * The screen ends with the launcher's banner: its last row is the screen's last non-blank row, and
 * its words, joined without spaces, end with the tail. A narrow pane wraps the banner over rows that
 * begin with no marker of their own, so the first row only has to begin `zz `. Output after the
 * banner, or the same words inside other text, is not the banner.
 */
export function sleepBannerAtEnd(screen: string): boolean {
  const rows = screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map((row) => row.trim()).filter((row) => row !== "");
  for (let start = rows.length - 1; start >= Math.max(0, rows.length - SLEEP_BANNER_ROWS); start -= 1) {
    if (!rows[start]!.startsWith(SLEEP_TITLE_PREFIX)) continue;
    if (rows.slice(start).join("").replace(/\s+/g, "").endsWith(SLEEP_BANNER_TAIL)) return true;
  }
  return false;
}

/** herdr's pane titles that name the launcher's `zz ` title; a pane whose herdr shows none is not read as asleep. */
export function hasSleepTitle(pane: PaneTitles): boolean {
  return [pane.title, pane.terminal_title_stripped, pane.terminal_title].some((title) => typeof title === "string" && title.startsWith(SLEEP_TITLE_PREFIX));
}

export interface PaneTitles {
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
}

/**
 * What a line typed into a sleeping pane does. The launcher resumes on a bare Enter (an older one on
 * any chunk that holds a CR or an LF) and quits on a lone q or Q, so an empty line is the Enter a keyboard
 * sends, and a lone q or Q is the key the banner names. Any other text is typed only after pi is ready
 * (wakeSleepingPi in server/index.ts).
 */
export type SleepingLine = "enter" | "quit" | "type";

export function sleepingLineAction(text: string): SleepingLine {
  if (text === "") return "enter";
  if (text === "q" || text === "Q") return "quit";
  return "type";
}

/** A record file as it was last read; kept only while its modification time and size are the same (recordFileOf). */
interface RecordFile {
  mtimeMs: number;
  size: number;
  record: SleepRecord | null;
}
interface RecordDirectory {
  stamp: number;
  at: number;
  paths: string[];
  records: SleepRecord[];
}
/** Each record file by its path. A read that failed is kept by neither map, so the next read tries the file again. */
const recordFiles = new Map<string, RecordFile>();
const recordDirs = new Map<string, RecordDirectory>();

/** Test hook: forget what was read, so the next read sees the directory as it is now. */
export function resetSleepRecordCache(): void {
  recordFiles.clear();
  recordDirs.clear();
}

function validRecord(value: unknown): SleepRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["sessionId"] !== "string" || typeof raw["sessionFile"] !== "string" || typeof raw["state"] !== "string") return null;
  if (typeof raw["paneId"] !== "string" || raw["paneId"] === "") return null;
  const pid = raw["launcherPid"];
  return {
    sessionId: raw["sessionId"],
    sessionFile: raw["sessionFile"],
    cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : "",
    title: typeof raw["title"] === "string" && raw["title"] !== "" ? raw["title"] : raw["sessionId"],
    state: raw["state"],
    paneId: raw["paneId"],
    launcherPid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    draft: typeof raw["draft"] === "string" ? raw["draft"] : "",
    nextDueAt: typeof raw["nextDueAt"] === "string" ? raw["nextDueAt"] : null,
    sleptAt: typeof raw["sleptAt"] === "string" ? raw["sleptAt"] : "",
    readyAt: typeof raw["readyAt"] === "string" ? raw["readyAt"] : null,
    endedAt: typeof raw["endedAt"] === "string" ? raw["endedAt"] : null,
  };
}

/**
 * A record file's content: the record, null for a file that holds none (too large, or not one), or undefined when it
 * cannot be read or parsed now (a rename in progress, a lock, a half-written file): no evidence either way, not kept.
 */
function readRecordFile(path: string, size: number): SleepRecord | null | undefined {
  if (size > RECORD_MAX_BYTES) return null;
  try {
    return validRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * A record file as it is now: its content as it was last read, read again only when its modification time or size has
 * moved. null: the file is gone. undefined: it cannot be read or parsed now, and nothing about it is kept.
 */
function recordFileOf(path: string): RecordFile | null | undefined {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    recordFiles.delete(path);
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  const known = recordFiles.get(path);
  if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known;
  const record = readRecordFile(path, stat.size);
  if (record === undefined) {
    recordFiles.delete(path);
    return undefined;
  }
  const file: RecordFile = { mtimeMs: stat.mtimeMs, size: stat.size, record };
  recordFiles.set(path, file);
  return file;
}

/**
 * Every readable sleep record of the agent directory. A file that has not changed (its modification time and size) is
 * not read again, so a scan costs a stat per record. The directory is scanned again when its modification time moves, or
 * after RECORD_CACHE_MS. A missing directory holds none. A scan that could not read a file is not kept, so the next
 * scan reads it again.
 */
export function readSleepRecords(agentDir: string, now = Date.now()): SleepRecord[] {
  const dir = join(agentDir, ...RECORD_DIR);
  let stamp: number;
  try {
    stamp = statSync(dir).mtimeMs;
  } catch {
    recordDirs.delete(dir);
    return [];
  }
  const cached = recordDirs.get(dir);
  if (cached && cached.stamp === stamp && now - cached.at < RECORD_CACHE_MS) return cached.records;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const paths: string[] = [];
  const records: SleepRecord[] = [];
  let unread = false;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const file = recordFileOf(path);
    if (file === undefined) {
      unread = true;
      continue;
    }
    if (file === null) continue;
    paths.push(path);
    if (file.record !== null) records.push(file.record);
  }
  // a file the previous scan held and this one does not hold is gone
  for (const path of cached?.paths ?? []) if (!paths.includes(path)) recordFiles.delete(path);
  if (unread) recordDirs.delete(dir);
  else recordDirs.set(dir, { stamp, at: now, paths, records });
  return records;
}

/**
 * One session's record as its file is now, without a directory scan: the file is stat-ed and read again only when it
 * changed (recordFileOf), so a marker written at the wake is seen at once. A session id that is not a plain file name
 * names no record.
 */
export function readSleepRecordNow(agentDir: string, sessionId: string): SleepRecord | null {
  if (sessionId === "" || basename(sessionId) !== sessionId) return null;
  return recordFileOf(join(agentDir, ...RECORD_DIR, `${sessionId}.json`))?.record ?? null;
}

/**
 * Whether a process id names a live process, on this host. EPERM means the process exists under
 * another user, so it is alive: only ESRCH (or any other failure) says it is gone. A pid another process has reused reads
 * as alive here too. A pane with the launcher's title is held by its record; a pane without one is held only by a sleep that
 * is recent (sleepStartingOf), so a reused pid cannot hold a shell.
 */
export function processAlive(pid: number, kill: (pid: number, signal: number) => void = (target, signal) => process.kill(target, signal)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The sleep record of a pane that pi holds asleep, or null: the launcher's title on the pane, and the record of
 * launcherSleepOf. A record left by a launcher that died (a reboot, a restart of herdr, a crash) holds nothing, and a
 * reused pane id finds no title.
 */
export function sleepingRecordOf(pane: PaneTitles & { pane_id: string; agent?: string | null }, records: SleepRecord[], alive: (pid: number) => boolean = processAlive): SleepRecord | null {
  if (!hasSleepTitle(pane)) return null;
  return launcherSleepOf(pane, records, alive);
}

/**
 * The sleeping record that holds this pane while pi sleeps: no agent, pi or the launcher's label (agentMayBeAsleep,
 * shared/sleep-agent.ts), and a record naming this pane whose launcher is still alive. The newest sleep of the pane is the
 * one that holds it. The title is not needed to find it, but without one this is no proof of a sleep: a reused pid reads as
 * alive, so a pane with no title is held only by sleepStartingOf, while its sleep is recent.
 */
export function launcherSleepOf(pane: { pane_id: string; agent?: string | null }, records: SleepRecord[], alive: (pid: number) => boolean = processAlive): SleepRecord | null {
  if (!agentMayBeAsleep(pane.agent)) return null;
  let found: SleepRecord | null = null;
  for (const record of records) {
    if (!stillSleepingIn(record, pane.pane_id, alive)) continue;
    // a launcher that died asleep leaves its record behind: the newest sleep of this pane is the one that holds it
    if (found === null || record.sleptAt > found.sleptAt) found = record;
  }
  return found;
}

/** Whether a record is a sleep of this pane that its launcher still holds: state sleeping, this pane, a live launcher. */
export function stillSleepingIn(record: SleepRecord | null, paneId: string, alive: (pid: number) => boolean = processAlive): record is SleepRecord {
  return record !== null && record.state === "sleeping" && record.paneId === paneId && record.launcherPid !== null && alive(record.launcherPid);
}

/**
 * The sleep that holds a pane with no launcher title while pi is still going to sleep (sleepHeldWithoutTitle in
 * server/index.ts): launcherSleepOf, and only while that sleep began less than SLEEP_TITLE_WAIT_MS before `now`. An older
 * record holds nothing here, whatever its pid says. A sleep dated more than READY_CLOCK_SKEW_MS past the clock, or with no
 * readable time, is no recent sleep either.
 */
export function sleepStartingOf(pane: { pane_id: string; agent?: string | null }, records: SleepRecord[], now = Date.now(), alive: (pid: number) => boolean = processAlive): SleepRecord | null {
  const record = launcherSleepOf(pane, records, alive);
  if (record === null) return null;
  const age = now - Date.parse(record.sleptAt);
  return age > -READY_CLOCK_SKEW_MS && age < SLEEP_TITLE_WAIT_MS ? record : null;
}

/** The snapshot's view of a sleeping session: what a client needs to show its card and its row. */
export function hibernatedView(record: SleepRecord): HibernatedPane {
  return {
    agent: "pi",
    title: record.title,
    slept_at: record.sleptAt,
    next_due_at: record.nextDueAt,
  };
}

/** Panes with a `hibernated` annotation where the sleep records hold one; the other panes pass unchanged. */
export function annotateHibernated<T extends PaneTitles & { pane_id: string; agent?: string | null }>(panes: T[], agentDir = piAgentDir(), now = Date.now()): (T & { hibernated?: HibernatedPane })[] {
  // the launcher's title is the only thing that marks a sleeping pane: the records are read only for a pane that has it
  if (!panes.some((pane) => hasSleepTitle(pane))) return panes;
  const records = readSleepRecords(agentDir, now);
  if (records.length === 0) return panes;
  return panes.map((pane) => {
    const record = sleepingRecordOf(pane, records);
    return record === null ? pane : { ...pane, hibernated: hibernatedView(record) };
  });
}

/** Two paths name one file: on Windows the separators and the letter case are not the file's. */
export function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const normal = (value: string): string => platform === "win32" ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : value;
  return normal(left) === normal(right);
}

/** The session herdr reports for the pane is the record's: by its path, or by its id. */
export function sessionReported(agentSession: { kind?: string; value?: string } | null | undefined, record: { sessionId: string; sessionFile: string }, platform: NodeJS.Platform = process.platform): boolean {
  if (!agentSession || typeof agentSession.value !== "string") return false;
  if (agentSession.kind === "path") return samePath(agentSession.value, record.sessionFile, platform);
  if (agentSession.kind === "id") return agentSession.value === record.sessionId;
  return false;
}

export interface ReadyPane {
  agent?: string | null;
  agent_status?: string | null;
  agent_session?: { kind?: string; value?: string } | null;
}

/**
 * A woken pi's checks: herdr names pi, idle or done, reports the session the record names, and the screen
 * no longer ends with the launcher's banner. The session check is what makes the reading specific: herdr
 * names pi for any session, and the banner goes only when the launcher hands the pane over. These checks
 * alone do not show that the wake happened (a pane herdr kept naming pi for shows them before the sleep
 * too): wakeReached adds pi's `readyAt` marker, or a rise of the agent's state counter.
 */
export function piReadyForInput(pane: ReadyPane, record: { sessionId: string; sessionFile: string }, screen: string, platform: NodeJS.Platform = process.platform): boolean {
  if (pane.agent !== "pi" || (pane.agent_status !== "idle" && pane.agent_status !== "done")) return false;
  if (!sessionReported(pane.agent_session, record, platform)) return false;
  return !sleepBannerAtEnd(screen);
}

/** A readyAt may precede the wake by this much: pi and the server read one host's clock, and the slack is for their skew. */
const READY_CLOCK_SKEW_MS = 2_000;

/**
 * Whether pi's hibernate extension has marked this wake ready: the record's `readyAt` is at or after the
 * wake, less READY_CLOCK_SKEW_MS. An older `readyAt` is an earlier wake's, and none at all is an install that
 * writes none, or a resume whose lease was refused: both fall back to the inferred reading.
 */
export function readyMarked(record: SleepRecord | null, wokeAt: number): boolean {
  if (record === null || record.readyAt === null) return false;
  const at = Date.parse(record.readyAt);
  return Number.isFinite(at) && at >= wokeAt - READY_CLOCK_SKEW_MS;
}

/**
 * The ready reading of one wake, taken on each poll: pi is ready once `reached` (wakeReached) has held for
 * the settle, `markedMs` when pi marked this wake (readyMarked), else `inferredMs`. A poll that does not reach
 * it starts the count again.
 */
export function wakeReadiness(markedMs: number, inferredMs: number): (reached: boolean, marked: boolean, now: number) => boolean {
  let readySince: number | null = null;
  return (reached, marked, now) => {
    if (!reached) {
      readySince = null;
      return false;
    }
    readySince ??= now;
    return now - readySince >= (marked ? markedMs : inferredMs);
  };
}

/** What herdr showed of a pane right before the Enter that wakes its sleeping session. */
export interface WakeStart {
  /** the wake's own time: pi's readyAt marker for this wake is at or after it (readyMarked) */
  wokeAt: number;
  /** herdr named pi for the pane before the Enter: then the wake is read as a change of that agent's state too */
  namedBefore: boolean;
  /** that agent's state_change_seq before the Enter; null where it was not read */
  seq: number | null;
}

/** The pane as a wake reads it: the fields piReadyForInput reads, and the agent's state_change_seq when it was read. */
export type WakePane = ReadyPane & { state_change_seq?: number | null };

/**
 * Whether a woken session is ready for input, read on one poll. pi's checks must hold (piReadyForInput), and the
 * wake must show it: pi's readyAt marker for this wake, or, where herdr named pi for the pane before the Enter, a
 * rise of the agent's state counter since. A pi that only reports the state it held before the sleep shows
 * neither, so it is not ready. A pane herdr named no agent for is read by the checks alone: its agent appears
 * with pi's first report.
 */
export function wakeReached(start: WakeStart, session: { sessionId: string; sessionFile: string }, pane: WakePane, screen: string, current: SleepRecord | null, platform: NodeJS.Platform = process.platform): boolean {
  if (!piReadyForInput(pane, session, screen, platform)) return false;
  if (!start.namedBefore || readyMarked(current, start.wokeAt)) return true;
  return start.seq !== null && typeof pane.state_change_seq === "number" && pane.state_change_seq > start.seq;
}

/**
 * A pane whose send was refused while pi woke: nothing is typed into it until the wake is reached or the marker
 * runs out. `start` is the wake's start (WakeStart), which decides what reaching the wake means.
 */
export interface WakingMarker {
  until: number;
  sessionId: string;
  sessionFile: string;
  start: WakeStart;
}

/** What a wake's marker says on one read: reached (pi is ready for a send), still waiting, or run out with pi not ready. */
export type WakeVerdict = "waiting" | "reached" | "expired";

export function wakeVerdict(marker: WakingMarker, pane: WakePane, screen: string, current: SleepRecord | null, now = Date.now(), platform: NodeJS.Platform = process.platform): WakeVerdict {
  if (wakeReached(marker.start, marker, pane, screen, current, platform)) return "reached";
  return now < marker.until ? "waiting" : "expired";
}

/** `waiting` refuses a send; `done` (the wake reached, or the marker expired) lets the send through. */
export function wakingState(marker: WakingMarker, pane: WakePane, screen: string, current: SleepRecord | null, now = Date.now(), platform: NodeJS.Platform = process.platform): "waiting" | "done" {
  return wakeVerdict(marker, pane, screen, current, now, platform) === "waiting" ? "waiting" : "done";
}

/** A sleep that began after the wake's start: the pane is asleep again, so the wake it followed is over. */
export function sleptAfterWake(records: SleepRecord[], paneId: string, wokeAt: number): boolean {
  return records.some((record) => record.paneId === paneId && Date.parse(record.sleptAt) > wokeAt);
}

/** The key of the sleep a record is: its session and when it began. One wake ends one sleep. */
export function sleepKey(record: SleepRecord): string {
  return `${record.sessionId}\u0000${record.sleptAt}`;
}

/**
 * When a wake the launcher ended began, while pi has not marked it ready: an awake record ended within PI_WAKING_MS,
 * with no readyAt at or after its end (readyMarked). Null otherwise.
 */
export function unmarkedWakeAt(record: SleepRecord, now: number): number | null {
  if (record.state !== "awake" || record.endedAt === null) return null;
  const endedAt = Date.parse(record.endedAt);
  if (!Number.isFinite(endedAt)) return null;
  const age = now - endedAt;
  if (age < -READY_CLOCK_SKEW_MS || age >= PI_WAKING_MS) return null;
  return readyMarked(record, endedAt) ? null : endedAt;
}

/** A wake the server holds in one pane: its marker, and the sleep it ends (sleepKey). */
export interface PaneWake {
  marker: WakingMarker;
  sleep: string;
}

/**
 * The wake of a pane the server did not begin, read off the launcher's record: the launcher's own timer or socket woke
 * it, or a key was typed into the pane. Its start is what herdr shows now. Where herdr names pi for the pane, pi's readyAt
 * alone marks the wake (the state counter from before it is not known); where it names no pi, the checks alone say when
 * pi is ready. Null when no awake record of this pane holds a wake, or the wake of this sleep has already run its course
 * (`concluded`).
 */
export function derivedWakingMarker(paneId: string, pane: { agent?: string | null } | undefined, records: SleepRecord[], concluded: (sleep: string) => boolean, now = Date.now()): PaneWake | null {
  for (const record of records) {
    if (record.paneId !== paneId) continue;
    const wokeAt = unmarkedWakeAt(record, now);
    if (wokeAt === null) continue;
    const sleep = sleepKey(record);
    if (concluded(sleep)) continue;
    const start: WakeStart = { wokeAt, namedBefore: pane?.agent === "pi", seq: null };
    return { marker: { until: wokeAt + PI_WAKING_MS, sessionId: record.sessionId, sessionFile: record.sessionFile, start }, sleep };
  }
  return null;
}

/**
 * The wakes this server holds, one per pane: the wake its own Enter began (begin), or, where it began none, one read off
 * the launcher's record (derivedWakingMarker). A wake holds its pane until it is reached or its marker runs out. A wake
 * that is over (end) concludes the sleep it ends, so the record of that same sleep begins no derived wake; a later sleep
 * does. A wake whose Enter was never written, or that leaves the sleep asleep, is cancelled instead, so the sleep stays open.
 */
export class PiWakes {
  private readonly wakes = new Map<string, PaneWake>();
  private readonly concluded = new Map<string, string>();

  begin(paneId: string, wake: PaneWake): void {
    this.wakes.set(paneId, wake);
  }

  /**
   * The wake that holds the pane now: its own, or one derived from the records. A wake that a later sleep of the pane
   * began is over (sleptAfterWake), and is ended here; the caller reads the marker's time and the verdict.
   */
  holding(paneId: string, pane: { agent?: string | null } | undefined, records: SleepRecord[], now = Date.now()): PaneWake | undefined {
    let wake = this.wakes.get(paneId);
    if (wake === undefined) {
      const derived = derivedWakingMarker(paneId, pane, records, (sleep) => this.concluded.get(paneId) === sleep, now);
      if (derived === null) return undefined;
      this.wakes.set(paneId, derived);
      wake = derived;
    }
    if (sleptAfterWake(records, paneId, wake.marker.start.wokeAt)) {
      this.end(paneId);
      return undefined;
    }
    return wake;
  }

  end(paneId: string): void {
    const wake = this.wakes.get(paneId);
    if (wake !== undefined) this.concluded.set(paneId, wake.sleep);
    this.wakes.delete(paneId);
  }

  cancel(paneId: string): void {
    this.wakes.delete(paneId);
  }
}
