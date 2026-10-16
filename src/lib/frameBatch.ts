/**
 * Runs `run` once per animation frame, with the latest value queued in that frame. A chunk of output
 * asks for two things that only the latest state needs: its acknowledgement (cumulative, so the last
 * covers the rest) and the prompt scan (which reads the screen as it stands). A hidden page runs no
 * frames, so there each value runs at once, as each chunk always did.
 *
 * With `fallbackMs`, a waiting value also runs once that long has passed since the wait began, if no
 * frame has run it: a page whose frames stop while it still looks visible must not hold an
 * acknowledgement the pty is waiting on. Whichever comes first runs the value and cancels the other.
 */
export interface FrameClock {
  request(run: () => void): number;
  cancel(id: number): void;
  after(ms: number, run: () => void): number;
  cancelAfter(id: number): void;
  hidden(): boolean;
}

export interface FrameBatch<T> {
  /** Holds `value` until the wait ends; a later value in the same wait replaces it. */
  queue(value: T): void;
  /** Runs the held value now and cancels the wait, if any: a pane left, a terminal disposed, a page hidden. */
  flush(): void;
}

export interface FrameBatchOptions {
  /** Runs a held value this many ms after the wait began, when no frame has (omitted: frames only). */
  fallbackMs?: number;
  /** The frames and timers to use; the browser's when omitted. */
  clock?: FrameClock;
}

const BROWSER_CLOCK: FrameClock = {
  request: (run) => window.requestAnimationFrame(run),
  cancel: (id) => window.cancelAnimationFrame(id),
  after: (ms, run) => window.setTimeout(run, ms),
  cancelAfter: (id) => window.clearTimeout(id),
  hidden: () => document.visibilityState === "hidden",
};

export function frameBatch<T>(run: (value: T) => void, { fallbackMs, clock = BROWSER_CLOCK }: FrameBatchOptions = {}): FrameBatch<T> {
  let held: { value: T } | null = null;
  let frame: number | null = null;
  let timer: number | null = null;
  const flush = (): void => {
    if (frame !== null) {
      clock.cancel(frame);
      frame = null;
    }
    if (timer !== null) {
      clock.cancelAfter(timer);
      timer = null;
    }
    const next = held;
    held = null;
    if (next !== null) run(next.value);
  };
  return {
    queue(value) {
      held = { value };
      if (clock.hidden()) {
        flush();
        return;
      }
      frame ??= clock.request(() => {
        frame = null;
        flush();
      });
      if (fallbackMs !== undefined) {
        timer ??= clock.after(fallbackMs, () => {
          timer = null;
          flush();
        });
      }
    },
    flush,
  };
}
