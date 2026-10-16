import type { SessionSnapshot } from "../shared/protocol.ts";

/** A pane's grid, as its rect in herdr's layout gives it. */
export interface PaneSize {
  cols: number;
  rows: number;
}

/**
 * Each pane's grid as the last herdr layouts gave it. A mirror asks its pane's size here on every
 * read, so it costs herdr nothing: the collector reads the layouts on every layout event and once a
 * minute (collector.ts) and passes them to `learn`. herdr sends layout.updated for every rect change
 * (on 0.9.4 a split, a pane.resize, a zoom and a close each did), so a resize reaches a mirror at the
 * collector's next reconcile.
 */
export interface PaneSizes {
  /** The layouts of a herdr snapshot: they replace what was known, since a snapshot holds every pane. */
  learn(layouts: SessionSnapshot["layouts"]): void;
  /** The pane's grid, or null when no learned layout has it (not yet learned, or without a rect). */
  sizeOf(paneId: string): PaneSize | null;
}

export function createPaneSizes(): PaneSizes {
  let sizes = new Map<string, PaneSize>();
  return {
    learn(layouts) {
      const next = new Map<string, PaneSize>();
      for (const layout of layouts) {
        for (const entry of layout.panes) {
          if (entry.rect) next.set(entry.pane_id, { cols: entry.rect.width, rows: entry.rect.height });
        }
      }
      sizes = next;
    },
    sizeOf: (paneId) => sizes.get(paneId) ?? null,
  };
}
