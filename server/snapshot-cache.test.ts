import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { directSessionReadCount, readSessionSnapshot, sessionSnapshot } from "./herdr/client.ts";
import { createSessionSnapshotCaches, createSharedSnapshot, OBSERVED_SNAPSHOT_MS } from "./snapshot-cache.ts";

/** A snapshot told apart by its read number, so a test can see which read answered. */
const answer = (read: number) => ({ panes: [], agents: [], read }) as unknown as SessionSnapshot;
const readNumber = (snapshot: SessionSnapshot) => (snapshot as unknown as { read: number }).read;

describe("shared session snapshot", () => {
  it("shares a read in flight among the askers that come while it runs, each with its own copy", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shared = createSharedSnapshot(async () => {
      await gate;
      return answer(++reads);
    }, 0, () => 0);
    const first = shared.get();
    const second = shared.get();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(readNumber(a)).toBe(1);
    expect(readNumber(b)).toBe(1);
    expect(a).not.toBe(b);
  });

  it("gives each asker a copy it can change without changing another asker's answer", async () => {
    const shared = createSharedSnapshot(async () => ({
      panes: [{ pane_id: "p1", agent_status: "idle" }],
      agents: [],
      read: 1,
    }) as unknown as SessionSnapshot, OBSERVED_SNAPSHOT_MS, () => 0);
    const first = await shared.get();
    (first.panes[0] as { agent_status: string }).agent_status = "working";
    const second = await shared.get();
    expect((second.panes[0] as { agent_status: string }).agent_status).toBe("idle");
  });

  it("answers from a finished read while the window lasts, then reads again", async () => {
    let clock = 0;
    let reads = 0;
    const shared = createSharedSnapshot(async () => answer(++reads), OBSERVED_SNAPSHOT_MS, () => clock);
    expect(readNumber(await shared.get())).toBe(1);
    clock = OBSERVED_SNAPSHOT_MS - 1;
    expect(readNumber(await shared.get())).toBe(1);
    clock = OBSERVED_SNAPSHOT_MS;
    expect(readNumber(await shared.get())).toBe(2);
    expect(reads).toBe(2);
  });

  it("never answers a later asker from a finished read when the window is 0", async () => {
    let reads = 0;
    const shared = createSharedSnapshot(async () => answer(++reads), 0, () => 0);
    expect(readNumber(await shared.get())).toBe(1);
    // a pane that changed between the two requests is seen by the second one
    expect(readNumber(await shared.get())).toBe(2);
    expect(reads).toBe(2);
  });

  it("does not keep a failed read", async () => {
    let reads = 0;
    const shared = createSharedSnapshot(async () => {
      if (++reads === 1) throw new Error("herdr is gone");
      return answer(reads);
    }, OBSERVED_SNAPSHOT_MS, () => 0);
    await expect(shared.get()).rejects.toThrow("herdr is gone");
    expect(readNumber(await shared.get())).toBe(2);
  });

  it("reads again after an invalidation, and gives each read the asker's timeout", async () => {
    let reads = 0;
    const timeouts: (number | undefined)[] = [];
    const shared = createSharedSnapshot(async (timeoutMs) => {
      timeouts.push(timeoutMs);
      return answer(++reads);
    }, OBSERVED_SNAPSHOT_MS, () => 0);
    await shared.get(250);
    shared.invalidate();
    expect(readNumber(await shared.get())).toBe(2);
    expect(timeouts).toEqual([250, undefined]);
  });
});

describe("direct reads and herdr frames", () => {
  it("answers no asker after a direct read from a read begun before it", async () => {
    let reads = 0;
    let generation = 0;
    const shared = createSharedSnapshot(async () => answer(++reads), OBSERVED_SNAPSHOT_MS, () => 0, undefined, () => generation);
    expect(readNumber(await shared.get())).toBe(1);
    // a direct read began: the next asker reads again, and the read after it is shared again
    generation += 1;
    expect(readNumber(await shared.get())).toBe(2);
    expect(readNumber(await shared.get())).toBe(2);
    expect(reads).toBe(2);
  });

  it("does not let an asker that comes after a direct read join a read begun before it", async () => {
    let reads = 0;
    let generation = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shared = createSharedSnapshot(async () => {
      const read = ++reads;
      await gate;
      return answer(read);
    }, 0, () => 0, undefined, () => generation);
    const first = shared.get();
    generation += 1;
    const second = shared.get();
    release();
    expect([readNumber(await first), readNumber(await second)]).toEqual([1, 2]);
  });

  it("drops the read a conversation request would share when a frame arrives, as it drops the observers'", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const caches = createSessionSnapshotCaches(async () => {
      const read = ++reads;
      await gate;
      return answer(read);
    }, () => 0, () => 0);
    const first = caches.coalesced();
    caches.invalidate();
    const second = caches.coalesced();
    release();
    expect([readNumber(await first), readNumber(await second)]).toEqual([1, 2]);
  });

  it("counts a session read asked for outright, and not a shared one", async () => {
    const absent = join(tmpdir(), `herdr-absent-${process.pid}.sock`);
    const before = directSessionReadCount();
    await readSessionSnapshot(absent, 2_000).catch(() => undefined);
    expect(directSessionReadCount()).toBe(before);
    await sessionSnapshot(absent, 2_000).catch(() => undefined);
    expect(directSessionReadCount()).toBe(before + 1);
  });
});
