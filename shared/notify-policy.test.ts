import { describe, expect, it } from "bun:test";
import { paneTitle, shouldNotifyStatus } from "./notify-policy.ts";

describe("the sleep transitions are no news", () => {
  it("moves a pane between idle and unknown on sleep and resume, which notify nothing", () => {
    // pi idle; the launcher holds the pane (none); its label listing (idle); released on resume (none); pi again (idle)
    const steps = ["idle", "unknown", "idle", "unknown", "idle"] as const;
    for (let index = 1; index < steps.length; index += 1) expect(shouldNotifyStatus(steps[index - 1]!, steps[index]!)).toBe(false);
  });

  it("is no finish either when a turn ended just before the sleep, which the label's idle reads as", () => {
    expect(shouldNotifyStatus("done", "idle")).toBe(false);
  });
});

describe("paneTitle", () => {
  const launcher = { pane_id: "w4:pZ", cwd: "/home/me/dev/api", terminal_title: "zz .pi", terminal_title_stripped: "zz .pi" };

  it("names a pi session asleep in its pane by its own title, never by the launcher's zz title", () => {
    expect(paneTitle({ ...launcher, hibernated: { title: "refactor" } })).toBe("refactor");
  });

  it("names a pi session asleep in its pane by its own title when herdr names pi for the pane", () => {
    const named = { ...launcher, agent: "pi", hibernated: { title: "refactor" } };
    expect(paneTitle(named)).toBe("refactor");
  });

  it("trims the session's title", () => {
    expect(paneTitle({ ...launcher, hibernated: { title: "  refactor  " } })).toBe("refactor");
  });

  it("keeps the live title of a pane without the annotation, even one whose title starts with zz", () => {
    expect(paneTitle(launcher)).toBe("zz .pi");
    expect(paneTitle({ ...launcher, hibernated: null })).toBe("zz .pi");
  });

  it("falls back to the terminal title, then the working directory, then the pane id", () => {
    expect(paneTitle({ pane_id: "w1:p1", terminal_title: "vim notes.md", terminal_title_stripped: "vim notes.md" })).toBe("vim notes.md");
    expect(paneTitle({ pane_id: "w1:p1", cwd: "/work/api", terminal_title: null, terminal_title_stripped: null })).toBe("/work/api");
    expect(paneTitle({ pane_id: "w1:p1" })).toBe("w1:p1");
  });
});
