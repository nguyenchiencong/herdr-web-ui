import type { SessionSnapshot } from "../shared/protocol.ts";
import { directSessionReadCount, readSessionSnapshot } from "./herdr/client.ts";

/**
 * How old a finished session snapshot an observer may be given. The roster, the OmO and GJC status
 * loops and the mirror's size check each ask every few seconds, and one read this fresh answers them
 * as well as their own would. A herdr event drops it at once (invalidateSessionSnapshots), and so does
 * any read of the session asked for outright (sessionSnapshot in herdr/client.ts).
 */
export const OBSERVED_SNAPSHOT_MS = 1000;

export interface SharedSnapshot {
  /** The session snapshot: a read in flight is shared, and a finished read while the window lasts. */
  get(timeoutMs?: number): Promise<SessionSnapshot>;
  /** A herdr event changed the session: no finished read is reused from now on. */
  invalidate(): void;
}

/**
 * One herdr read, shared by its askers: those that come while it runs and, for `windowMs` after it
 * finished, those after it too. `windowMs` 0 shares a read only while it is in flight. A failed read
 * is never reused, so the next asker reads again. Each asker gets its own copy of the answer: a caller
 * may change what it was given, and another asker must not see that change. `generation` counts the
 * direct reads: a read begun before the latest of them answers no asker after it.
 */
export function createSharedSnapshot(
  read: (timeoutMs?: number) => Promise<SessionSnapshot>,
  windowMs: number,
  now: () => number = Date.now,
  copy: (snapshot: SessionSnapshot) => SessionSnapshot = (snapshot) => structuredClone(snapshot),
  generation: () => number = directSessionReadCount,
): SharedSnapshot {
  let current: { startedAt: number; generation: number; settled: boolean; snapshot: Promise<SessionSnapshot> } | null = null;
  return {
    get(timeoutMs) {
      if (!current || current.generation !== generation() || (current.settled && now() - current.startedAt >= windowMs)) {
        const startedAt = now();
        const startedGeneration = generation();
        const started = { startedAt, generation: startedGeneration, settled: false, snapshot: read(timeoutMs) };
        current = started;
        started.snapshot.then(
          () => { started.settled = true; },
          () => { if (current === started) current = null; },
        );
      }
      return current.snapshot.then(copy);
    },
    invalidate() {
      current = null;
    },
  };
}

/** The observers' shared read and the conversations' one, over `read`. A herdr frame drops both (`invalidate`). */
export function createSessionSnapshotCaches(
  read: (timeoutMs?: number) => Promise<SessionSnapshot>,
  now: () => number = Date.now,
  generation: () => number = directSessionReadCount,
) {
  const observed = createSharedSnapshot(read, OBSERVED_SNAPSHOT_MS, now, undefined, generation);
  const coalesced = createSharedSnapshot(read, 0, now, undefined, generation);
  return {
    observed: (timeoutMs?: number): Promise<SessionSnapshot> => observed.get(timeoutMs),
    coalesced: (timeoutMs?: number): Promise<SessionSnapshot> => coalesced.get(timeoutMs),
    invalidate: (): void => {
      observed.invalidate();
      coalesced.invalidate();
    },
  };
}

const caches = createSessionSnapshotCaches((timeoutMs) => readSessionSnapshot(undefined, timeoutMs));

/** For observers only: the 5 s loops and the mirror's size check. A finished read may answer for OBSERVED_SNAPSHOT_MS. */
export const observedSessionSnapshot = caches.observed;

/**
 * For conversation requests: one that arrives while a read runs shares it, and none is answered from an
 * earlier read. A conversation binds to the panes as they are now, and two requests a few hundred
 * milliseconds apart can see a pane change between them.
 */
export const coalescedSessionSnapshot = caches.coalesced;

/** Called for every herdr event the collector receives: no read begun before it answers an asker after it. */
export const invalidateSessionSnapshots = caches.invalidate;
