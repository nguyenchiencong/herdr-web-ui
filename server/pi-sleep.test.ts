import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentMayBeAsleep,
  annotateHibernated,
  derivedWakingMarker,
  hasSleepTitle,
  launcherSleepOf,
  PI_WAKING_MS,
  PiWakes,
  piReadyForInput,
  processAlive,
  readSleepRecordNow,
  readSleepRecords,
  readyMarked,
  resetSleepRecordCache,
  samePath,
  sessionReported,
  sleepBannerAtEnd,
  sleepingLineAction,
  sleepingRecordOf,
  sleepKey,
  sleepStartingOf,
  SLEEP_TITLE_WAIT_MS,
  sleptAfterWake,
  unmarkedWakeAt,
  wakeReached,
  wakeReadiness,
  wakeVerdict,
  wakingState,
  type SleepRecord,
} from "./pi-sleep.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-sleep-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => resetSleepRecordCache());

// The launcher's banner: `zz <title> · <cwd> — Enter to resume, q to quit`, then CRLF.
const banner = "zz .pi \u00b7 C:\\Users\\Nguyen Chien Cong\\Dev\\ai\\tools\\herdr-web-ui \u2014 Enter to resume, q to quit";
const footer = "/tmp/app\n0.0%/215k (auto)     some-model \u2022 medium";

describe("the sleep banner at the end of the screen", () => {
  test("reads the banner on a wide pane, with the screen's blank rows after it", () => {
    expect(sleepBannerAtEnd(`earlier output\n\n${banner}\n\n\n`)).toBe(true);
  });

  test("reads the banner a narrow pane wrapped over several rows", () => {
    const wrapped = ["zz .pi \u00b7 C:\\Users\\Nguyen Chien", "Cong\\Dev\\ai\\tools\\herdr-web-ui", "\u2014 Enter to resume, q to", "quit"];
    expect(sleepBannerAtEnd(`${wrapped.join("\n")}\n`)).toBe(true);
    expect(sleepBannerAtEnd("zz .pi \u00b7 /tmp/app \u2014 Enter\nto resume, q to quit\n")).toBe(true);
  });

  test("ignores the escape sequences the launcher's reset and colours put around it", () => {
    expect(sleepBannerAtEnd(`\u001b[?2026l\u001b[0m\u001b[7m${banner}\u001b[0m\n`)).toBe(true);
  });

  test("is not the banner once pi's own output follows it on the screen", () => {
    expect(sleepBannerAtEnd(`${banner}\n${footer}\n`)).toBe(false);
    expect(sleepBannerAtEnd(`${banner}\nsome output\n`)).toBe(false);
  });

  test("is not the banner when the same sentence sits inside other text", () => {
    expect(sleepBannerAtEnd(`the docs say: ${banner} for the launcher\n`)).toBe(false);
    expect(sleepBannerAtEnd(`> ${banner.slice(3)}\n`)).toBe(false);
  });

  test("is not the banner without the title's marker, or without its tail", () => {
    expect(sleepBannerAtEnd(`${banner.replace("zz .pi", "pi .pi")}\n`)).toBe(false);
    expect(sleepBannerAtEnd("zz .pi \u00b7 /tmp/app \u2014 Enter to resume\n")).toBe(false);
    expect(sleepBannerAtEnd("")).toBe(false);
  });
});

describe("the launcher's title on a pane", () => {
  test("is read from any of herdr's title fields that starts with the marker", () => {
    expect(hasSleepTitle({ title: "zz .pi" })).toBe(true);
    expect(hasSleepTitle({ terminal_title_stripped: "zz refactor" })).toBe(true);
    expect(hasSleepTitle({ title: null, terminal_title: "zz .pi", terminal_title_stripped: null })).toBe(true);
  });

  test("is not read from another title, or from none", () => {
    expect(hasSleepTitle({ title: "pi - herdr-web-ui" })).toBe(false);
    expect(hasSleepTitle({ title: "zzz", terminal_title_stripped: "zZ .pi" })).toBe(false);
    expect(hasSleepTitle({})).toBe(false);
  });
});

describe("what a line typed into a sleeping pane does", () => {
  test("an empty line is the Enter that resumes the session", () => {
    expect(sleepingLineAction("")).toBe("enter");
  });

  test("a lone q or Q is the key the banner names, and only that", () => {
    expect(sleepingLineAction("q")).toBe("quit");
    expect(sleepingLineAction("Q")).toBe("quit");
    for (const text of ["q ", " q", "qq", "quit", "\r", "hello"]) expect(sleepingLineAction(text)).toBe("type");
  });
});

const sleepingPane = { pane_id: "w4:pZ", agent: null, title: "zz .pi", terminal_title: "zz .pi", terminal_title_stripped: "zz .pi" };
const alive = (): boolean => true;

function record(overrides: Partial<SleepRecord> = {}): SleepRecord {
  return {
    sessionId: "s-1",
    sessionFile: join(root, "sessions", "s-1.jsonl"),
    cwd: "/tmp/app",
    title: ".pi",
    state: "sleeping",
    paneId: "w4:pZ",
    launcherPid: process.pid,
    draft: "",
    nextDueAt: null,
    sleptAt: "2026-10-17T07:00:00.000Z",
    readyAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe("which pane a sleep record holds", () => {
  test("matches a sleeping record to the pane it names, with no agent, the launcher's title and a live launcher", () => {
    expect(sleepingRecordOf(sleepingPane, [record()], alive)?.sessionId).toBe("s-1");
  });

  test("holds a pane herdr names pi for as asleep too, as it holds one it names no agent for", () => {
    expect(sleepingRecordOf({ ...sleepingPane, agent: "pi" }, [record()], alive)?.sessionId).toBe("s-1");
  });

  test("holds a pane the launcher's own label names as asleep too, with the same record and title", () => {
    expect(sleepingRecordOf({ ...sleepingPane, agent: "zz pi" }, [record()], alive)?.sessionId).toBe("s-1");
  });

  test("refuses the launcher's label once no live record names the pane", () => {
    expect(sleepingRecordOf({ ...sleepingPane, agent: "zz pi" }, [record({ state: "awake" })], alive)).toBeNull();
    expect(sleepingRecordOf({ ...sleepingPane, agent: "zz pi" }, [record()], () => false)).toBeNull();
  });

  test("refuses a pane another agent holds, whatever its title says", () => {
    expect(sleepingRecordOf({ ...sleepingPane, agent: "claude" }, [record()], alive)).toBeNull();
    expect(sleepingRecordOf({ ...sleepingPane, agent: "codex" }, [record()], alive)).toBeNull();
  });

  test("refuses a pane without the launcher's title, so a reused pane id is not read as asleep", () => {
    expect(sleepingRecordOf({ ...sleepingPane, title: "pi - app", terminal_title: null, terminal_title_stripped: null }, [record()], alive)).toBeNull();
  });

  test("refuses a record that is no longer sleeping, or names another pane", () => {
    expect(sleepingRecordOf(sleepingPane, [record({ state: "awake" })], alive)).toBeNull();
    expect(sleepingRecordOf(sleepingPane, [record({ state: "quit" })], alive)).toBeNull();
    expect(sleepingRecordOf(sleepingPane, [record({ paneId: "w4:pY" })], alive)).toBeNull();
  });

  test("refuses a record whose launcher is gone: after a restart or a reboot it holds nothing", () => {
    expect(sleepingRecordOf(sleepingPane, [record()], () => false)).toBeNull();
    expect(sleepingRecordOf(sleepingPane, [record({ launcherPid: null })], alive)).toBeNull();
  });

  test("holds the newest sleep of a pane whose launcher is alive, when an earlier one was left behind", () => {
    const older = record({ sessionId: "old", sleptAt: "2026-10-16T09:00:00.000Z" });
    const newer = record({ sessionId: "new", sleptAt: "2026-10-17T06:00:00.000Z" });
    expect(sleepingRecordOf(sleepingPane, [older, newer], alive)?.sessionId).toBe("new");
    expect(sleepingRecordOf(sleepingPane, [newer, older], alive)?.sessionId).toBe("new");
  });
});

describe("whether a launcher is still alive on this host", () => {
  test("a live process is alive", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  test("a process another user holds is alive: EPERM says it exists", () => {
    expect(processAlive(4242, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); })).toBe(true);
  });

  test("a process that is gone is not alive, and neither is one that cannot be asked", () => {
    expect(processAlive(4242, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); })).toBe(false);
    expect(processAlive(4242, () => { throw new Error("unknown"); })).toBe(false);
  });
});

describe("reading the sleep records of the agent directory", () => {
  const agentDir = join(root, "agent-a");
  const hibernate = join(agentDir, "state", "hibernate");
  const write = (name: string, value: unknown) => writeFileSync(join(hibernate, name), typeof value === "string" ? value : JSON.stringify(value));

  test("reads each valid record and skips a file that is not one", () => {
    mkdirSync(hibernate, { recursive: true });
    write("s-1.json", { version: 1, state: "sleeping", sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), cwd: "/tmp/app", title: "refactor", paneId: "w4:pZ", launcherPid: process.pid, draft: "half a sentence", nextDueAt: null, sleptAt: "2026-10-17T07:00:00.000Z" });
    write("broken.json", "{ not json");
    write("no-pane.json", { version: 1, state: "sleeping", sessionId: "s-2", sessionFile: join(root, "s-2.jsonl"), paneId: null });
    write("notes.txt", "ignored");
    const records = readSleepRecords(agentDir);
    expect(records.map((entry) => entry.sessionId)).toEqual(["s-1"]);
    expect(records[0]).toMatchObject({ title: "refactor", draft: "half a sentence", state: "sleeping", paneId: "w4:pZ", launcherPid: process.pid });
  });

  test("keeps a launcher pid only when it is a positive whole number", () => {
    const dir = join(root, "agent-pid");
    const folder = join(dir, "state", "hibernate");
    mkdirSync(folder, { recursive: true });
    for (const [index, pid] of ["4242", -1, 1.5, 4242].entries()) {
      writeFileSync(join(folder, `p${index}.json`), JSON.stringify({ state: "sleeping", sessionId: `p${index}`, sessionFile: join(root, `p${index}.jsonl`), paneId: "w1:p1", launcherPid: pid }));
    }
    const pids = Object.fromEntries(readSleepRecords(dir, 1_000).map((entry) => [entry.sessionId, entry.launcherPid]));
    expect(pids).toEqual({ p0: null, p1: null, p2: null, p3: 4242 });
  });

  test("reads nothing from a directory that does not exist", () => {
    expect(readSleepRecords(join(root, "no-such-agent-dir"))).toEqual([]);
  });

  test("answers from its cache while the directory is unchanged, and re-reads it once the directory's time moves", () => {
    const dir = join(root, "agent-b");
    const folder = join(dir, "state", "hibernate");
    mkdirSync(folder, { recursive: true });
    const first = readSleepRecords(dir, 1_000);
    expect(readSleepRecords(dir, 1_500)).toBe(first);
    writeFileSync(join(folder, "s-9.json"), JSON.stringify({ state: "sleeping", sessionId: "s-9", sessionFile: join(root, "s-9.jsonl"), paneId: "w9:p1", launcherPid: process.pid }));
    // the launcher's rename moves the directory's time; set it here so the test does not depend on the clock's grain
    const moved = new Date(Date.now() + 60_000);
    utimesSync(folder, moved, moved);
    const after = readSleepRecords(dir, 1_600);
    expect(after).not.toBe(first);
    expect(after.map((entry) => entry.sessionId)).toEqual(["s-9"]);
  });

  test("re-reads after the cache's 2 s safety interval even when the directory did not move", () => {
    const dir = join(root, "agent-c");
    mkdirSync(join(dir, "state", "hibernate"), { recursive: true });
    const first = readSleepRecords(dir, 1_000);
    expect(readSleepRecords(dir, 1_000 + 1_999)).toBe(first);
    expect(readSleepRecords(dir, 1_000 + 2_001)).not.toBe(first);
  });

  test("parses only the files that changed, and keeps the rest as they were", () => {
    const dir = join(root, "agent-d");
    const folder = join(dir, "state", "hibernate");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.json"), JSON.stringify({ state: "sleeping", sessionId: "a", sessionFile: join(root, "a.jsonl"), paneId: "w1:p1", launcherPid: process.pid }));
    writeFileSync(join(folder, "b.json"), JSON.stringify({ state: "sleeping", sessionId: "b", sessionFile: join(root, "b.jsonl"), paneId: "w2:p1", launcherPid: process.pid }));
    const first = readSleepRecords(dir, 1_000);
    const unchanged = first.find((entry) => entry.sessionId === "a");
    writeFileSync(join(folder, "b.json"), JSON.stringify({ state: "awake", sessionId: "b", sessionFile: join(root, "b.jsonl"), paneId: "w2:p1", launcherPid: process.pid }));
    const moved = new Date(Date.now() + 60_000);
    utimesSync(folder, moved, moved);
    const second = readSleepRecords(dir, 1_600);
    // a's file is the same bytes with the same time: it is the same record, not a re-parse
    expect(second.find((entry) => entry.sessionId === "a")).toBe(unchanged);
    expect(second.find((entry) => entry.sessionId === "b")?.state).toBe("awake");
  });

  test("forgets a record whose file was removed", () => {
    const dir = join(root, "agent-e");
    const folder = join(dir, "state", "hibernate");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "gone.json"), JSON.stringify({ state: "sleeping", sessionId: "gone", sessionFile: join(root, "gone.jsonl"), paneId: "w1:p1", launcherPid: process.pid }));
    expect(readSleepRecords(dir, 1_000).map((entry) => entry.sessionId)).toEqual(["gone"]);
    unlinkSync(join(folder, "gone.json"));
    const moved = new Date(Date.now() + 60_000);
    utimesSync(folder, moved, moved);
    expect(readSleepRecords(dir, 1_600)).toEqual([]);
  });
});

describe("the snapshot's hibernated annotation", () => {
  test("marks only the sleeping pane, and carries no transcript path", () => {
    const agentDir = join(root, "agent-f");
    mkdirSync(join(agentDir, "state", "hibernate"), { recursive: true });
    writeFileSync(join(agentDir, "state", "hibernate", "s-1.json"), JSON.stringify({ state: "sleeping", sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), cwd: "/tmp/app", title: "refactor", paneId: "w4:pZ", launcherPid: process.pid, nextDueAt: "2026-10-17T09:00:00.000Z", sleptAt: "2026-10-17T07:00:00.000Z" }));
    const working = { pane_id: "w4:pA", agent: "pi", title: "pi - x", terminal_title: null, terminal_title_stripped: null };
    const panes = annotateHibernated([sleepingPane, working], agentDir, 1_000);
    expect(panes[0]).toMatchObject({ pane_id: "w4:pZ", hibernated: { agent: "pi", title: "refactor", slept_at: "2026-10-17T07:00:00.000Z", next_due_at: "2026-10-17T09:00:00.000Z" } });
    expect(panes[0]?.hibernated).not.toHaveProperty("session_path");
    expect(panes[1]).toBe(working);
  });

  test("a launcher that is gone leaves its pane unannotated", () => {
    const agentDir = join(root, "agent-g");
    mkdirSync(join(agentDir, "state", "hibernate"), { recursive: true });
    writeFileSync(join(agentDir, "state", "hibernate", "s-1.json"), JSON.stringify({ state: "sleeping", sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), title: "refactor", paneId: "w4:pZ", launcherPid: 999999999 }));
    const panes = annotateHibernated([sleepingPane], agentDir, 1_000);
    expect(panes[0]).not.toHaveProperty("hibernated");
  });

  test("annotates a sleeping pane herdr names pi for, as it does one it names no agent for", () => {
    const agentDir = join(root, "agent-h");
    mkdirSync(join(agentDir, "state", "hibernate"), { recursive: true });
    writeFileSync(join(agentDir, "state", "hibernate", "s-1.json"), JSON.stringify({ state: "sleeping", sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), cwd: "/tmp/app", title: "refactor", paneId: "w4:pZ", launcherPid: process.pid, nextDueAt: null, sleptAt: "2026-10-17T07:00:00.000Z" }));
    const panes = annotateHibernated([{ ...sleepingPane, agent: "pi" }], agentDir, 1_000);
    expect(panes[0]).toMatchObject({ pane_id: "w4:pZ", agent: "pi", hibernated: { agent: "pi", title: "refactor" } });
  });

  test("returns the panes unchanged when no record holds one", () => {
    const panes = [sleepingPane];
    expect(annotateHibernated(panes, join(root, "no-agent-dir"), 1_000)).toBe(panes);
  });
});

describe("the session herdr reports, and when a woken pi is ready", () => {
  const sessionFile = join(root, "sessions", "Refactor.jsonl");
  const session = { sessionId: "s-1", sessionFile };

  test("names the record's session by its path, or by its id", () => {
    expect(sessionReported({ kind: "path", value: sessionFile }, session, "linux")).toBe(true);
    expect(sessionReported({ kind: "id", value: "s-1" }, session, "linux")).toBe(true);
    expect(sessionReported({ kind: "path", value: join(root, "sessions", "other.jsonl") }, session, "linux")).toBe(false);
    expect(sessionReported(null, session)).toBe(false);
    expect(sessionReported({ kind: "other", value: sessionFile }, session)).toBe(false);
  });

  test("compares paths case-insensitively with normalized separators on Windows, and exactly elsewhere", () => {
    expect(samePath("C:\\Users\\Me\\Sessions\\A.jsonl", "c:/users/me/sessions/a.jsonl/", "win32")).toBe(true);
    expect(samePath("/Users/me/A.jsonl", "/Users/me/a.jsonl", "linux")).toBe(false);
  });

  const ready = { agent: "pi", agent_status: "idle", agent_session: { kind: "path", value: sessionFile } };

  test("is ready once pi is named idle or done, with the record's session and no banner on the screen", () => {
    expect(piReadyForInput(ready, session, "> ", "linux")).toBe(true);
    expect(piReadyForInput({ ...ready, agent_status: "done" }, session, "> ", "linux")).toBe(true);
  });

  test("is not ready while the launcher's banner still ends the screen", () => {
    expect(piReadyForInput(ready, session, `${banner}\n`, "linux")).toBe(false);
  });

  test("is not ready for another session, another agent, or a pi still working", () => {
    expect(piReadyForInput({ ...ready, agent_session: { kind: "path", value: join(root, "other.jsonl") } }, session, "> ", "linux")).toBe(false);
    expect(piReadyForInput({ ...ready, agent: null }, session, "> ", "linux")).toBe(false);
    expect(piReadyForInput({ ...ready, agent: "claude" }, session, "> ", "linux")).toBe(false);
    expect(piReadyForInput({ ...ready, agent_status: "working" }, session, "> ", "linux")).toBe(false);
  });
});

describe("which agent may hold a sleeping pane", () => {
  test("is none, or pi: the two names herdr gives a launcher's pane", () => {
    expect(agentMayBeAsleep(null)).toBe(true);
    expect(agentMayBeAsleep(undefined)).toBe(true);
    expect(agentMayBeAsleep("")).toBe(true);
    expect(agentMayBeAsleep("  ")).toBe(true);
    expect(agentMayBeAsleep("pi")).toBe(true);
  });

  test("is no other agent, whatever the title says", () => {
    expect(agentMayBeAsleep("claude")).toBe(false);
    expect(agentMayBeAsleep("omo")).toBe(false);
    expect(agentMayBeAsleep("pi-extra")).toBe(false);
  });
});

describe("a send refused while pi wakes", () => {
  const session = { sessionId: "s-1", sessionFile: join(root, "sessions", "s-1.jsonl") };
  const ready = { agent: "pi", agent_status: "idle", agent_session: { kind: "path", value: session.sessionFile } };
  // herdr named no agent for the pane before the Enter: the checks alone say the wake is reached
  const unnamed = { until: 60_000, ...session, start: { wokeAt: Date.parse("2026-10-17T07:00:10.000Z"), namedBefore: false, seq: null } };

  test("waits while pi is not ready, and lets the send through once the marker has run out", () => {
    expect(wakingState(unnamed, { agent: null }, "", null, 2_000, "linux")).toBe("waiting");
    expect(wakingState(unnamed, { agent: null }, "", null, 61_000, "linux")).toBe("done");
  });

  test("lets the send through as soon as pi is ready, before the marker runs out", () => {
    expect(wakingState(unnamed, ready, "> ", null, 2_000, "linux")).toBe("done");
  });
});

describe("a wake herdr named pi for before the Enter", () => {
  const sessionFile = join(root, "sessions", "s-1.jsonl");
  const session = { sessionId: "s-1", sessionFile };
  const wokeAt = Date.parse("2026-10-17T07:00:10.000Z");
  // pi named idle on the session it slept in, with the agent's state counter at 4 before the Enter
  const named = { wokeAt, namedBefore: true, seq: 4 };
  const idle = { agent: "pi", agent_status: "idle", agent_session: { kind: "path", value: sessionFile } };
  const marker = { until: 60_000, ...session, start: named };
  const withReadyAt = (readyAt: string | null): SleepRecord => ({
    sessionId: "s-1", sessionFile, cwd: "/tmp/app", title: "s-1", state: "awake", paneId: "w4:pZ",
    launcherPid: null, draft: "", nextDueAt: null, sleptAt: "2026-10-17T06:59:00.000Z", readyAt, endedAt: null,
  });

  test("is reached on pi's readyAt marker for this wake, though the counter did not move", () => {
    expect(wakingState(marker, { ...idle, state_change_seq: 4 }, "> ", withReadyAt("2026-10-17T07:00:10.000Z"), 2_000, "linux")).toBe("done");
  });

  test("is not reached on a readyAt from an earlier wake", () => {
    expect(wakingState(marker, { ...idle, state_change_seq: 4 }, "> ", withReadyAt("2026-10-17T06:00:00.000Z"), 2_000, "linux")).toBe("waiting");
  });

  test("is not reached while the counter holds what it was before the Enter, however idle pi is", () => {
    expect(wakeReached(named, session, { ...idle, state_change_seq: 4 }, "> ", null, "linux")).toBe(false);
    expect(wakingState(marker, { ...idle, state_change_seq: 4 }, "> ", null, 2_000, "linux")).toBe("waiting");
    expect(wakingState(marker, { ...idle, state_change_seq: 4 }, "> ", null, 61_000, "linux")).toBe("done");
  });

  test("is reached once the counter has risen since before the Enter, with no marker", () => {
    expect(wakeReached(named, session, { ...idle, state_change_seq: 5 }, "> ", null, "linux")).toBe(true);
  });

  test("is not reached while pi's checks fail, whatever the counter or the marker says", () => {
    expect(wakeReached(named, session, { ...idle, agent_status: "working", state_change_seq: 5 }, "> ", withReadyAt("2026-10-17T07:00:10.000Z"), "linux")).toBe(false);
    expect(wakeReached(named, session, { ...idle, state_change_seq: 5 }, `${banner}\n`, withReadyAt("2026-10-17T07:00:10.000Z"), "linux")).toBe(false);
    expect(wakeReached(named, session, { ...idle, agent_session: { kind: "path", value: join(root, "other.jsonl") }, state_change_seq: 5 }, "> ", null, "linux")).toBe(false);
  });

  test("is not reached without the counter, or without one read before the Enter", () => {
    expect(wakeReached(named, session, idle, "> ", null, "linux")).toBe(false);
    expect(wakeReached({ ...named, seq: null }, session, { ...idle, state_change_seq: 5 }, "> ", null, "linux")).toBe(false);
  });

  test("reads a pane herdr named no agent for by the checks alone, with no counter", () => {
    const unnamed = { wokeAt, namedBefore: false, seq: null };
    expect(wakeReached(unnamed, session, idle, "> ", null, "linux")).toBe(true);
    expect(wakeReached(unnamed, session, idle, `${banner}\n`, null, "linux")).toBe(false);
  });
});

describe("the launcher's own label is not pi", () => {
  const sessionFile = join(root, "sessions", "s-1.jsonl");
  const session = { sessionId: "s-1", sessionFile };
  const wokeAt = Date.parse("2026-10-17T07:00:10.000Z");
  const label = { agent: "zz pi", agent_status: "idle", agent_session: { kind: "path", value: sessionFile } };

  test("is never ready on its own idle: the agent must be pi", () => {
    expect(piReadyForInput(label, session, "> ", "linux")).toBe(false);
    expect(wakeReached({ wokeAt, namedBefore: false, seq: null }, session, label, "> ", null, "linux")).toBe(false);
  });

  test("is ready once pi replaces it, idle, on the session, with no banner", () => {
    expect(wakeReached({ wokeAt, namedBefore: false, seq: null }, session, { ...label, agent: "pi" }, "> ", null, "linux")).toBe(true);
  });
});

describe("the sleeping pane's title", () => {
  test("is the only mark that shows a pane asleep, so a pane without it is never annotated", () => {
    expect(hasSleepTitle({ title: "pi" })).toBe(false);
  });
});

describe("pi's readyAt marker for a wake", () => {
  const wokeAt = Date.parse("2026-10-17T07:00:10.000Z");
  const recordWith = (readyAt: string | null): SleepRecord => ({
    sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), cwd: "/tmp/app", title: "s-1", state: "awake",
    paneId: "w4:pZ", launcherPid: null, draft: "", nextDueAt: null, sleptAt: "2026-10-17T06:59:00.000Z", readyAt, endedAt: null,
  });

  test("marks the wake once it is at or after the wake", () => {
    expect(readyMarked(recordWith("2026-10-17T07:00:10.000Z"), wokeAt)).toBe(true);
    expect(readyMarked(recordWith("2026-10-17T07:00:12.500Z"), wokeAt)).toBe(true);
  });

  test("allows two seconds of clock skew before the wake, and no more", () => {
    expect(readyMarked(recordWith("2026-10-17T07:00:08.500Z"), wokeAt)).toBe(true);
    expect(readyMarked(recordWith("2026-10-17T07:00:07.900Z"), wokeAt)).toBe(false);
  });

  test("is no marker when it is absent, unreadable, an earlier wake's, or there is no record", () => {
    expect(readyMarked(recordWith(null), wokeAt)).toBe(false);
    expect(readyMarked(recordWith("not a time"), wokeAt)).toBe(false);
    expect(readyMarked(recordWith("2026-10-17T06:00:00.000Z"), wokeAt)).toBe(false);
    expect(readyMarked(null, wokeAt)).toBe(false);
  });

  test("is read from the record's file as it is now, though the directory was read before the wake", () => {
    const agentDir = join(root, "fresh-agent");
    const file = join(agentDir, "state", "hibernate", "s-1.json");
    mkdirSync(join(agentDir, "state", "hibernate"), { recursive: true });
    writeFileSync(file, JSON.stringify({ sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), state: "awake", paneId: "w4:pZ", title: "s-1" }));
    expect(readSleepRecords(agentDir, 1_000)).toHaveLength(1);
    writeFileSync(file, JSON.stringify({ sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), state: "awake", paneId: "w4:pZ", title: "s-1", readyAt: "2026-10-17T07:00:10.000Z" }));
    expect(readSleepRecordNow(agentDir, "s-1")?.readyAt).toBe("2026-10-17T07:00:10.000Z");
  });

  test("names no record for a session id that is not a plain file name, or for a missing record", () => {
    expect(readSleepRecordNow(join(root, "fresh-agent"), "../s-1")).toBeNull();
    expect(readSleepRecordNow(join(root, "fresh-agent"), "missing")).toBeNull();
  });
});

describe("the settle a woken pi holds before the message goes", () => {
  test("is the short settle once pi marked the wake", () => {
    const readiness = wakeReadiness(150, 500);
    expect(readiness(true, true, 0)).toBe(false);
    expect(readiness(true, true, 149)).toBe(false);
    expect(readiness(true, true, 150)).toBe(true);
  });

  test("is the long settle while pi has not marked the wake: an install that writes none", () => {
    const readiness = wakeReadiness(150, 500);
    expect(readiness(true, false, 0)).toBe(false);
    expect(readiness(true, false, 499)).toBe(false);
    expect(readiness(true, false, 500)).toBe(true);
  });

  test("counts from the first ready reading, and starts again whenever pi is not ready", () => {
    const readiness = wakeReadiness(150, 500);
    expect(readiness(true, false, 0)).toBe(false);
    expect(readiness(false, false, 300)).toBe(false);
    expect(readiness(true, false, 310)).toBe(false);
    expect(readiness(true, false, 809)).toBe(false);
    expect(readiness(true, false, 810)).toBe(true);
  });

  test("takes a marker that lands mid-wait: the short settle counts from the first ready reading", () => {
    const readiness = wakeReadiness(150, 500);
    expect(readiness(true, false, 0)).toBe(false);
    expect(readiness(true, true, 150)).toBe(true);
  });

  test("is never ready on a marker alone: the checks must hold", () => {
    const readiness = wakeReadiness(150, 500);
    expect(readiness(false, true, 0)).toBe(false);
    expect(readiness(false, true, 1_000)).toBe(false);
  });
});

describe("a launcher's sleep with no title on its pane", () => {
  const untitled = { pane_id: "w4:pZ", title: null, terminal_title: null, terminal_title_stripped: null };

  test("is held by launcherSleepOf, which reads the record without the title, while sleepingRecordOf still needs it", () => {
    expect(launcherSleepOf({ ...untitled, agent: null }, [record()], alive)?.sessionId).toBe("s-1");
    expect(sleepingRecordOf({ ...untitled, agent: null }, [record()], alive)).toBeNull();
  });

  test("is held for a pane named pi or by the launcher's label, and for no other agent", () => {
    expect(launcherSleepOf({ ...untitled, agent: "pi" }, [record()], alive)?.sessionId).toBe("s-1");
    expect(launcherSleepOf({ ...untitled, agent: "zz pi" }, [record()], alive)?.sessionId).toBe("s-1");
    expect(launcherSleepOf({ ...untitled, agent: "claude" }, [record()], alive)).toBeNull();
  });

  test("is not held once the record is awake, or its launcher is gone", () => {
    expect(launcherSleepOf({ ...untitled, agent: null }, [record({ state: "awake" })], alive)).toBeNull();
    expect(launcherSleepOf({ ...untitled, agent: null }, [record()], () => false)).toBeNull();
  });
});

describe("a record file that could not be read", () => {
  test("is not kept: the next read sees the file as it is once it reads", () => {
    const dir = join(root, "agent-failed-read");
    const folder = join(dir, "state", "hibernate");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "s-1.json");
    writeFileSync(file, "{ half a record");
    expect(readSleepRecords(dir, 1_000)).toEqual([]);
    expect(readSleepRecordNow(dir, "s-1")).toBeNull();
    writeFileSync(file, JSON.stringify({ state: "sleeping", sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), cwd: "/tmp/app", title: "s-1", paneId: "w4:pZ", launcherPid: process.pid, sleptAt: "2026-10-17T07:00:00.000Z" }));
    expect(readSleepRecordNow(dir, "s-1")?.state).toBe("sleeping");
    expect(readSleepRecords(dir, 1_001).map((entry) => entry.sessionId)).toEqual(["s-1"]);
  });
});

describe("the record of a wake the launcher ended", () => {
  const endedAt = "2026-10-17T07:00:10.000Z";
  const endedMs = Date.parse(endedAt);
  const awake = record({ state: "awake", endedAt, readyAt: null, sleptAt: "2026-10-17T06:59:00.000Z" });

  test("is a wake from its end while pi has not marked it ready, for PI_WAKING_MS", () => {
    expect(unmarkedWakeAt(awake, endedMs + 1_000)).toBe(endedMs);
    expect(unmarkedWakeAt(awake, endedMs + PI_WAKING_MS - 1)).toBe(endedMs);
    expect(unmarkedWakeAt(awake, endedMs + PI_WAKING_MS)).toBeNull();
  });

  test("is no wake once pi marked it ready, or when it is an earlier wake's marker, or the record is not awake or ended", () => {
    expect(unmarkedWakeAt(record({ ...awake, readyAt: "2026-10-17T07:00:11.000Z" }), endedMs + 1_000)).toBeNull();
    expect(unmarkedWakeAt(record({ ...awake, readyAt: "2026-10-17T06:00:00.000Z" }), endedMs + 1_000)).toBe(endedMs);
    expect(unmarkedWakeAt(record({ state: "sleeping", endedAt: null }), endedMs + 1_000)).toBeNull();
    expect(unmarkedWakeAt(record({ state: "awake", endedAt: null }), endedMs + 1_000)).toBeNull();
    expect(unmarkedWakeAt(record({ state: "awake", endedAt: "not a time" }), endedMs + 1_000)).toBeNull();
  });

  test("is not a wake from the future beyond the clock skew", () => {
    expect(unmarkedWakeAt(awake, endedMs - 5_000)).toBeNull();
    expect(unmarkedWakeAt(awake, endedMs - 1_000)).toBe(endedMs);
  });

  test("is derived for the pane it names, and names pi only where herdr named pi for the pane", () => {
    const named = derivedWakingMarker("w4:pZ", { agent: "pi" }, [awake], () => false, endedMs + 1_000);
    expect(named?.marker.start).toEqual({ wokeAt: endedMs, namedBefore: true, seq: null });
    expect(named?.marker.until).toBe(endedMs + PI_WAKING_MS);
    expect(derivedWakingMarker("w4:pZ", { agent: null }, [awake], () => false, endedMs + 1_000)?.marker.start.namedBefore).toBe(false);
    expect(derivedWakingMarker("w4:pY", undefined, [awake], () => false, endedMs + 1_000)).toBeNull();
  });

  test("is not derived for a sleep whose wake already concluded", () => {
    expect(derivedWakingMarker("w4:pZ", undefined, [awake], (sleep) => sleep === sleepKey(awake), endedMs + 1_000)).toBeNull();
  });
});

describe("the wakes the server holds, one per pane", () => {
  const endedMs = Date.parse("2026-10-17T07:00:10.000Z");
  const awake = record({ state: "awake", endedAt: "2026-10-17T07:00:10.000Z", readyAt: null, sleptAt: "2026-10-17T06:59:00.000Z" });
  const own = (wokeAt: number) => ({
    marker: { until: wokeAt + PI_WAKING_MS, sessionId: "s-1", sessionFile: join(root, "s-1.jsonl"), start: { wokeAt, namedBefore: false, seq: null } },
    sleep: sleepKey(awake),
  });

  test("holds the wake the server began, while the records show no later sleep", () => {
    const wakes = new PiWakes();
    wakes.begin("w4:pZ", own(endedMs));
    expect(wakes.holding("w4:pZ", undefined, [awake], endedMs + 1_000)?.marker.start.wokeAt).toBe(endedMs);
  });

  test("holds a wake read off the launcher's record when the server began none", () => {
    const wakes = new PiWakes();
    expect(wakes.holding("w4:pZ", undefined, [awake], endedMs + 1_000)?.marker.start.wokeAt).toBe(endedMs);
    expect(wakes.holding("w4:pY", undefined, [awake], endedMs + 1_000)).toBeUndefined();
  });

  test("is over once a later sleep of its pane began: the wake is dropped, and its sleep concluded", () => {
    const wakes = new PiWakes();
    wakes.begin("w4:pZ", own(endedMs));
    const resleep = record({ state: "sleeping", sessionId: "s-2", sleptAt: "2026-10-17T07:05:00.000Z" });
    expect(wakes.holding("w4:pZ", undefined, [awake, resleep], endedMs + 1_000)).toBeUndefined();
    expect(wakes.holding("w4:pZ", undefined, [awake, resleep], endedMs + 2_000)).toBeUndefined();
  });

  test("concludes a wake that ended, so the record of its sleep begins no wake again", () => {
    const wakes = new PiWakes();
    wakes.begin("w4:pZ", own(endedMs));
    wakes.end("w4:pZ");
    expect(wakes.holding("w4:pZ", undefined, [awake], endedMs + 1_000)).toBeUndefined();
  });

  test("keeps a cancelled wake's sleep open: the record of it begins a wake again", () => {
    const wakes = new PiWakes();
    wakes.begin("w4:pZ", own(endedMs));
    wakes.cancel("w4:pZ");
    expect(wakes.holding("w4:pZ", undefined, [awake], endedMs + 1_000)?.marker.start.wokeAt).toBe(endedMs);
  });
});

describe("a wake's verdict on one read", () => {
  const marker = { until: 60_000, sessionId: "s-1", sessionFile: join(root, "sessions", "s-1.jsonl"), start: { wokeAt: Date.parse("2026-10-17T07:00:10.000Z"), namedBefore: false, seq: null } };
  const ready = { agent: "pi", agent_status: "idle", agent_session: { kind: "path", value: join(root, "sessions", "s-1.jsonl") } };

  test("is reached once pi is ready, at any time", () => {
    expect(wakeVerdict(marker, ready, "> ", null, 1, "linux")).toBe("reached");
  });

  test("is waiting until the marker runs out, and expired after it", () => {
    expect(wakeVerdict(marker, {}, "", null, 59_999, "linux")).toBe("waiting");
    expect(wakeVerdict(marker, {}, "", null, 60_000, "linux")).toBe("expired");
  });
});

describe("a sleep that began after a wake", () => {
  test("is found for the pane that slept again, after the wake's start, and only for that pane", () => {
    const wokeAt = Date.parse("2026-10-17T07:00:10.000Z");
    const before = record({ state: "awake", sleptAt: "2026-10-17T06:59:00.000Z", endedAt: "2026-10-17T07:00:10.000Z" });
    const after = record({ sessionId: "s-2", sleptAt: "2026-10-17T07:01:00.000Z" });
    expect(sleptAfterWake([before], "w4:pZ", wokeAt)).toBe(false);
    expect(sleptAfterWake([before, after], "w4:pZ", wokeAt)).toBe(true);
    expect(sleptAfterWake([after], "w4:pY", wokeAt)).toBe(false);
  });
});

describe("a sleep with no title on its pane, by how long ago its sleep began", () => {
  const untitled = { pane_id: "w4:pZ", agent: null, title: null, terminal_title: null, terminal_title_stripped: null };
  const began = Date.parse("2026-10-17T07:00:00.000Z");
  const sleptAt = (at: number, overrides: Partial<SleepRecord> = {}): SleepRecord => record({ sleptAt: new Date(at).toISOString(), ...overrides });

  test("holds a sleep that began less than the wait before now, while its launcher is alive", () => {
    expect(sleepStartingOf(untitled, [sleptAt(began)], began + 1_000, alive)?.sessionId).toBe("s-1");
    expect(sleepStartingOf(untitled, [sleptAt(began)], began + SLEEP_TITLE_WAIT_MS - 1, alive)?.sessionId).toBe("s-1");
  });

  test("holds nothing once the wait has passed, so a reused pid cannot hold a pane restored as a shell", () => {
    // an hour old, and its launcher's pid taken by another process: alive, but no launcher
    expect(sleepStartingOf(untitled, [sleptAt(began - 3_600_000, { launcherPid: 4242 })], began, () => true)).toBeNull();
    expect(sleepStartingOf(untitled, [sleptAt(began)], began + SLEEP_TITLE_WAIT_MS, alive)).toBeNull();
  });

  test("holds nothing for a launcher that is gone, however recent the sleep", () => {
    expect(sleepStartingOf(untitled, [sleptAt(began)], began + 1_000, () => false)).toBeNull();
  });

  test("holds nothing for a sleep dated past the clock beyond the skew, or with no readable time", () => {
    expect(sleepStartingOf(untitled, [sleptAt(began + 1_000)], began, alive)?.sessionId).toBe("s-1");
    expect(sleepStartingOf(untitled, [sleptAt(began + 5_000)], began, alive)).toBeNull();
    expect(sleepStartingOf(untitled, [sleptAt(began, { sleptAt: "" })], began, alive)).toBeNull();
  });

  test("holds nothing for another agent, a woken record, or another pane", () => {
    expect(sleepStartingOf({ ...untitled, agent: "claude" }, [sleptAt(began)], began, alive)).toBeNull();
    expect(sleepStartingOf(untitled, [sleptAt(began, { state: "awake" })], began, alive)).toBeNull();
    expect(sleepStartingOf({ ...untitled, pane_id: "w4:pY" }, [sleptAt(began)], began, alive)).toBeNull();
  });

  test("reads the newest sleep of the pane, whatever the order of the records", () => {
    const older = sleptAt(began - 3_600_000, { sessionId: "s-0" });
    const newer = sleptAt(began, { sessionId: "s-1" });
    expect(sleepStartingOf(untitled, [older, newer], began + 1_000, alive)?.sessionId).toBe("s-1");
    expect(sleepStartingOf(untitled, [newer, older], began + 1_000, alive)?.sessionId).toBe("s-1");
  });
});

describe("a wake read off an awake record holds a pane for at most PI_WAKING_MS", () => {
  const endedAt = Date.parse("2026-10-17T07:00:10.000Z");
  const awake = record({ state: "awake", endedAt: "2026-10-17T07:00:10.000Z", readyAt: null, sleptAt: "2026-10-17T06:59:00.000Z", launcherPid: 4242 });

  test("is held until PI_WAKING_MS after its endedAt, whatever the pid, and never for a sleeping record", () => {
    expect(derivedWakingMarker("w4:pZ", { agent: null }, [awake], () => false, endedAt + PI_WAKING_MS - 1)).not.toBeNull();
    expect(derivedWakingMarker("w4:pZ", { agent: null }, [awake], () => false, endedAt + PI_WAKING_MS)).toBeNull();
    expect(derivedWakingMarker("w4:pZ", { agent: null }, [record({ launcherPid: 4242 })], () => true, endedAt + 1_000)).toBeNull();
  });

  test("is expired on its verdict once the bound passes, so a send is not held by it", () => {
    const held = new PiWakes().holding("w4:pZ", { agent: null }, [awake], endedAt + 1_000);
    expect(held).toBeDefined();
    expect(wakeVerdict(held!.marker, {}, "", awake, endedAt + 1_000, "linux")).toBe("waiting");
    expect(wakeVerdict(held!.marker, {}, "", awake, endedAt + PI_WAKING_MS, "linux")).toBe("expired");
  });
});

describe("a wake this server began, at any age of the sleep it ends", () => {
  test("holds its pane while the wake runs, whatever the age of the record", () => {
    const untitled = { pane_id: "w4:pZ", agent: null, title: null, terminal_title: null, terminal_title_stripped: null };
    const old = record({ sleptAt: "2026-10-16T07:00:00.000Z" });
    const wokeAt = Date.parse("2026-10-17T07:00:10.000Z");
    const wakes = new PiWakes();
    wakes.begin("w4:pZ", { marker: { until: wokeAt + PI_WAKING_MS, sessionId: "s-1", sessionFile: old.sessionFile, start: { wokeAt, namedBefore: false, seq: null } }, sleep: sleepKey(old) });
    const held = wakes.holding("w4:pZ", undefined, [old], wokeAt + 1_000);
    expect(held).toBeDefined();
    expect(wakeVerdict(held!.marker, {}, "", old, wokeAt + 1_000, "linux")).toBe("waiting");
    // the same day-old sleep holds no pane with no title: the wake is what holds it
    expect(sleepStartingOf(untitled, [old], wokeAt + 1_000, alive)).toBeNull();
  });
});
