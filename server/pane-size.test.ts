import { expect, it } from "bun:test";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { startStatusCollector, type StatusCollectorDeps, type StatusCollectorHandlers } from "./collector.ts";
import type { EventFrame } from "./herdr/client.ts";
import { MirrorSession } from "./mirror.ts";
import { createPaneSizes, type PaneSizes } from "./pane-size.ts";

type Layout = SessionSnapshot["layouts"][number];

/** One tab's layout, each pane with the rect herdr gives it. */
function tabLayout(tab: string, panes: { pane_id: string; width: number; height: number }[]): Layout {
  return {
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: panes[0]!.pane_id,
    panes: panes.map((pane) => ({ focused: false, pane_id: pane.pane_id, rect: { x: 0, y: 0, width: pane.width, height: pane.height } })),
    splits: [],
    tab_id: tab,
    workspace_id: "w1",
    zoomed: false,
  };
}

/** A herdr whose snapshot holds one tab's layout, and which announces a rect change with layout.updated on demand. */
function fakeHerdr(initial: Layout) {
  let layout = initial;
  let snapshots = 0;
  let lifecycle: ((frame: EventFrame) => void) | null = null;
  const deps: Partial<StatusCollectorDeps> = {
    reconnectMinMs: 5,
    reconnectMaxMs: 40,
    backstopMs: 60_000,
    debounceMs: 5,
    snapshotRetryMs: 5,
    replaySettleMs: 5,
    subscribe: (subscriptions, handlers) => {
      if (subscriptions.some((subscription) => subscription.type === "layout.updated")) lifecycle = handlers.onEvent;
      return { close: () => undefined };
    },
    snapshot: async () => {
      snapshots += 1;
      const panes = layout.panes.map((pane) => ({ pane_id: pane.pane_id, agent_status: "idle", agent: null }) as unknown as HerdrPane);
      return { panes, layouts: [layout] };
    },
  };
  return {
    deps,
    snapshots: () => snapshots,
    resize(paneId: string, width: number, height: number) {
      layout = { ...layout, panes: layout.panes.map((pane) => (pane.pane_id === paneId ? { ...pane, rect: { ...pane.rect, width, height } } : pane)) };
      lifecycle!({ event: "layout.updated", data: { type: "layout_updated" } });
    },
  };
}

/** A viewer of one pane: its mirror asks the pane's size of `sizes` at every read, and reads the pane's screen all the while. */
function viewer(sizes: PaneSizes, paneId: string, start: { cols: number; rows: number }, resized: string[]) {
  let reads = 0;
  const session = new MirrorSession({
    cols: start.cols,
    rows: start.rows,
    read: async () => { reads += 1; return "$ "; },
    write: async () => undefined,
    onData: () => undefined,
    onExit: () => undefined,
    size: async () => sizes.sizeOf(paneId),
    onResize: (cols, rows) => resized.push(`${paneId} ${cols}x${rows}`),
    activeMs: 1,
    idleMs: 1,
    wholeMs: 60_000,
    quietMs: 60_000,
  });
  return { session, reads: () => reads };
}

/** Resolves once `ready()` holds; a condition that never holds fails the test instead of hanging it. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await Bun.sleep(5);
  }
}

it("gives each pane the grid of its rect in the latest layout, and none to a pane no layout holds", () => {
  const sizes = createPaneSizes();
  expect(sizes.sizeOf("w1:p1")).toBeNull();
  sizes.learn([tabLayout("w1:t1", [{ pane_id: "w1:p1", width: 80, height: 24 }])]);
  expect(sizes.sizeOf("w1:p1")).toEqual({ cols: 80, rows: 24 });
  // a snapshot holds every pane: one it lacks has no size any more
  sizes.learn([tabLayout("w1:t2", [{ pane_id: "w1:p2", width: 40, height: 10 }])]);
  expect(sizes.sizeOf("w1:p1")).toBeNull();
  expect(sizes.sizeOf("w1:p2")).toEqual({ cols: 40, rows: 10 });
});

it("reads herdr once per layout change, however many viewers watch their panes", async () => {
  const herdr = fakeHerdr(tabLayout("w1:t1", [{ pane_id: "w1:p1", width: 80, height: 24 }, { pane_id: "w1:p2", width: 40, height: 24 }]));
  const sizes = createPaneSizes();
  const resized: string[] = [];
  const handlers: StatusCollectorHandlers = {
    onStatus: () => undefined,
    onBaseline: () => undefined,
    onLayouts: (layouts) => sizes.learn(layouts),
    onPaneEnded: () => undefined,
    onStructureChange: () => undefined,
  };
  const collector = startStatusCollector(handlers, herdr.deps);
  const viewers = [
    viewer(sizes, "w1:p1", { cols: 80, rows: 24 }, resized),
    viewer(sizes, "w1:p1", { cols: 80, rows: 24 }, resized),
    viewer(sizes, "w1:p2", { cols: 40, rows: 24 }, resized),
  ];
  try {
    await until(() => viewers.every((view) => view.reads() > 20));
    expect(herdr.snapshots()).toBe(1);
    herdr.resize("w1:p1", 100, 30);
    await until(() => resized.length === 2);
    // the two viewers of w1:p1 see the new grid at their next read; the viewer of w1:p2 sees none
    expect(resized).toEqual(["w1:p1 100x30", "w1:p1 100x30"]);
    expect(herdr.snapshots()).toBe(2);
    const reads = viewers.map((view) => view.reads());
    await until(() => viewers.every((view, at) => view.reads() > reads[at]! + 20));
    expect(herdr.snapshots()).toBe(2);
  } finally {
    collector.stop();
    for (const view of viewers) view.session.kill();
  }
});
