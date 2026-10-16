import { describe, expect, it } from "bun:test";
import { frameBatch, type FrameClock } from "./frameBatch.ts";

/** A clock the test drives: `turn()` runs the frames waiting, `advance(ms)` moves time and runs the timers that fall due. */
function fakeClock() {
  let now = 0;
  let ids = 0;
  let hidden = false;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { due: number; run: () => void }>();
  const cancelledFrames: number[] = [];
  const cancelledTimers: number[] = [];
  const clock: FrameClock = {
    request(run) {
      ids += 1;
      frames.set(ids, run);
      return ids;
    },
    cancel(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
    after(ms, run) {
      ids += 1;
      timers.set(ids, { due: now + ms, run });
      return ids;
    },
    cancelAfter(id) {
      cancelledTimers.push(id);
      timers.delete(id);
    },
    hidden: () => hidden,
  };
  return {
    clock,
    cancelledFrames,
    cancelledTimers,
    frameCount: () => frames.size,
    timerCount: () => timers.size,
    hide(value: boolean) {
      hidden = value;
    },
    turn() {
      const waiting = [...frames.values()];
      frames.clear();
      for (const run of waiting) run();
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= end).sort(([, a], [, b]) => a.due - b.due)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.due;
        timer.run();
      }
      now = end;
    },
  };
}

describe("frameBatch", () => {
  it("runs once per frame, with the latest value queued in it", () => {
    const ran: string[] = [];
    const frames = fakeClock();
    const batch = frameBatch<string>((value) => ran.push(value), { clock: frames.clock });
    batch.queue("a");
    batch.queue("b");
    batch.queue("c");
    expect(frames.frameCount()).toBe(1);
    expect(ran).toEqual([]);
    frames.turn();
    expect(ran).toEqual(["c"]);
  });

  it("requests a new frame for values queued after one ran, and runs nothing for a frame with no value", () => {
    const ran: string[] = [];
    const frames = fakeClock();
    const batch = frameBatch<string>((value) => ran.push(value), { clock: frames.clock });
    frames.turn();
    expect(ran).toEqual([]);
    batch.queue("a");
    frames.turn();
    batch.queue("b");
    expect(frames.frameCount()).toBe(1);
    frames.turn();
    expect(ran).toEqual(["a", "b"]);
  });

  it("runs each value at once while the page is hidden, and requests no frame or timer", () => {
    const ran: string[] = [];
    const frames = fakeClock();
    const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
    frames.hide(true);
    batch.queue("a");
    batch.queue("b");
    expect(ran).toEqual(["a", "b"]);
    expect(frames.frameCount()).toBe(0);
    expect(frames.timerCount()).toBe(0);
  });

  it("a page hidden with a value waiting runs it at once and drops its frame and timer", () => {
    const ran: string[] = [];
    const frames = fakeClock();
    const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
    batch.queue("a");
    frames.hide(true);
    batch.queue("b");
    expect(ran).toEqual(["b"]);
    expect(frames.cancelledFrames).toEqual([1]);
    expect(frames.cancelledTimers).toEqual([2]);
    expect(frames.frameCount()).toBe(0);
    expect(frames.timerCount()).toBe(0);
  });

  it("flush runs the held value now and drops the frame and the timer, so nothing runs twice", () => {
    const ran: string[] = [];
    const frames = fakeClock();
    const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
    batch.queue("a");
    batch.flush();
    expect(ran).toEqual(["a"]);
    expect(frames.cancelledFrames).toEqual([1]);
    expect(frames.cancelledTimers).toEqual([2]);
    frames.turn();
    frames.advance(100);
    expect(ran).toEqual(["a"]);
    batch.flush();
    expect(ran).toEqual(["a"]);
  });

  describe("with a fallback timer (the acknowledgements)", () => {
    it("runs the held value after the fallback when no frame runs, and drops the frame", () => {
      const ran: string[] = [];
      const frames = fakeClock();
      const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
      batch.queue("a");
      frames.advance(49);
      expect(ran).toEqual([]);
      frames.advance(1);
      expect(ran).toEqual(["a"]);
      expect(frames.frameCount()).toBe(0);
      frames.turn();
      expect(ran).toEqual(["a"]);
    });

    it("a frame that runs first drops the timer, so the value runs once", () => {
      const ran: string[] = [];
      const frames = fakeClock();
      const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
      batch.queue("a");
      frames.turn();
      expect(ran).toEqual(["a"]);
      frames.advance(100);
      expect(ran).toEqual(["a"]);
      expect(frames.timerCount()).toBe(0);
    });

    it("counts the fallback from the first value of the wait: a later value replaces the held one without re-arming it", () => {
      const ran: string[] = [];
      const frames = fakeClock();
      const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
      batch.queue("a");
      frames.advance(30);
      batch.queue("b");
      frames.advance(19);
      expect(ran).toEqual([]);
      frames.advance(1);
      expect(ran).toEqual(["b"]);
      frames.advance(1000);
      expect(ran).toEqual(["b"]);
    });

    it("a value queued after the fallback ran starts a wait of its own", () => {
      const ran: string[] = [];
      const frames = fakeClock();
      const batch = frameBatch<string>((value) => ran.push(value), { fallbackMs: 50, clock: frames.clock });
      batch.queue("a");
      frames.advance(50);
      expect(ran).toEqual(["a"]);
      batch.queue("b");
      frames.advance(49);
      expect(ran).toEqual(["a"]);
      frames.advance(1);
      expect(ran).toEqual(["a", "b"]);
    });
  });

  it("without a fallback a value waits for a frame, however long that takes (the prompt scan)", () => {
    const ran: string[] = [];
    const frames = fakeClock();
    const batch = frameBatch<string>((value) => ran.push(value), { clock: frames.clock });
    batch.queue("a");
    frames.advance(10_000);
    expect(ran).toEqual([]);
    frames.turn();
    expect(ran).toEqual(["a"]);
    expect(frames.timerCount()).toBe(0);
  });
});
