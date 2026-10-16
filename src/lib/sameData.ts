/**
 * Polls and the event stream hand over fresh objects every few seconds even when nothing
 * changed; storing them re-rendered the whole app (the chat transcript included) each time.
 */
export function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The object a state setter keeps: `previous` when it holds the same data as `next`, else `next`. */
export function keepIfSame<T>(previous: T | null, next: T): T {
  return previous !== null && sameData(previous, next) ? previous : next;
}
