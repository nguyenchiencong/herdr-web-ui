import { useRef, useState } from "react";

/**
 * "Reload app", on the update line, in Settings and where a part of the app failed to load. The
 * reload is a navigation, and one the server does not answer is served from the service worker's
 * copy of the last build: that build boots and the same "App updated" notice comes back. So the
 * reload waits for the server to answer, for at most RELOAD_WAIT_MS, then reloads either way. While
 * the device is offline there is nothing to wait for: the copy is all there is.
 */
export const RELOAD_WAIT_MS = 10_000;
const RELOAD_POLL_MS = 500;

export interface ReloadWait {
  /** Whether the server answers now. */
  answers: () => Promise<boolean>;
  reload: () => void;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}

/**
 * Asks `answers` until it says yes or `waitMs` has passed, then reloads once. Resolves with whether
 * the server answered in time.
 */
export async function reloadWhenAnswered(deps: ReloadWait, waitMs: number, pollMs = RELOAD_POLL_MS): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitMs;
  for (;;) {
    if (await deps.answers()) {
      deps.reload();
      return true;
    }
    if (now() >= deadline) {
      deps.reload();
      return false;
    }
    await pause(Math.min(pollMs, deadline - now()));
  }
}

/** Whether the server answers a plain request for the app's shell with a success. */
async function serverAnswers(): Promise<boolean> {
  try {
    return (await fetch("/", { cache: "no-store" })).ok;
  } catch {
    return false;
  }
}

/** A "Reload app" button's action: `waiting` is true from the tap until the reload, and a second tap waits for the same one. */
export function useReloadApp(): { waiting: boolean; reloadApp: () => void } {
  const [waiting, setWaiting] = useState(false);
  const started = useRef(false);
  const reloadApp = () => {
    if (started.current) return;
    started.current = true;
    setWaiting(true);
    const offline = navigator.onLine === false;
    void reloadWhenAnswered({ answers: serverAnswers, reload: () => window.location.reload() }, offline ? 0 : RELOAD_WAIT_MS);
  };
  return { waiting, reloadApp };
}
