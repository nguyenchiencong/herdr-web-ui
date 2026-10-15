import { describe, expect, it } from "bun:test";
import { reloadWhenAnswered } from "./reloadApp.ts";

/** A clock the waits move: each pause advances it, and each answer is what the server said at that time. */
function clock(answers: boolean[]) {
  let time = 0;
  let asked = 0;
  const pauses: number[] = [];
  const reloads: number[] = [];
  return {
    now: () => time,
    pause: async (ms: number) => { pauses.push(ms); time += ms; },
    answers: async () => answers[Math.min(asked++, answers.length - 1)]!,
    reload: () => { reloads.push(time); },
    pauses,
    reloads,
  };
}

describe("the reload a tap starts", () => {
  it("reloads at once when the server already answers", async () => {
    const c = clock([true]);
    expect(await reloadWhenAnswered(c, 10_000)).toBe(true);
    expect(c.reloads).toEqual([0]);
    expect(c.pauses).toEqual([]);
  });

  it("waits, asking again, until the server answers, and reloads then", async () => {
    const c = clock([false, false, true]);
    expect(await reloadWhenAnswered(c, 10_000, 500)).toBe(true);
    expect(c.pauses).toEqual([500, 500]);
    expect(c.reloads).toEqual([1000]);
  });

  it("gives up at the end of its wait and reloads anyway, never waiting past it", async () => {
    const c = clock([false]);
    expect(await reloadWhenAnswered(c, 1200, 500)).toBe(false);
    expect(c.pauses).toEqual([500, 500, 200]);
    expect(c.reloads).toEqual([1200]);
  });

  it("reloads at once while offline, where waiting cannot bring the server", async () => {
    const c = clock([false]);
    expect(await reloadWhenAnswered(c, 0)).toBe(false);
    expect(c.pauses).toEqual([]);
    expect(c.reloads).toEqual([0]);
  });
});
