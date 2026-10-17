import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { alertPaneTitle, displayPaneTitle } from "./Sidebar.tsx";

function pane(fields: Partial<HerdrPane> = {}): HerdrPane {
  return { pane_id: "w4:pZ", workspace_id: "w4", tab_id: "w4:t1", terminal_id: "term-w4", revision: 1, focused: false, agent_status: "unknown", ...fields };
}

const asleep = { agent: "pi" as const, title: "Ship the retry flag", slept_at: "2026-10-17T07:00:00.000Z", next_due_at: null };

describe("the title a pane is shown and alerted by", () => {
  it("names a pi session asleep in its pane by its own title, in the header and in an alert", () => {
    const sleeping = pane({ agent: null, label: null, title: "zz Ship the retry flag", terminal_title: "zz Ship the retry flag", terminal_title_stripped: "zz Ship the retry flag", hibernated: asleep });
    expect(displayPaneTitle(sleeping)).toBe("Ship the retry flag");
    expect(alertPaneTitle(sleeping)).toBe("Ship the retry flag");
  });

  it("names a pi session asleep in its pane by its own title when herdr names pi for the pane", () => {
    const sleeping = pane({ agent: "pi", label: null, title: "zz Ship the retry flag", terminal_title: "zz Ship the retry flag", terminal_title_stripped: "zz Ship the retry flag", hibernated: asleep });
    expect(displayPaneTitle(sleeping)).toBe("Ship the retry flag");
    expect(alertPaneTitle(sleeping)).toBe("Ship the retry flag");
  });

  it("keeps the chrome of a pane that carries only the launcher's label: a plain terminal has no agent to strip", () => {
    expect(displayPaneTitle(pane({ agent: "zz pi", label: null, title: "π vim notes.md", terminal_title: "π vim notes.md", terminal_title_stripped: "π vim notes.md" }))).toBe("π vim notes.md");
    expect(displayPaneTitle(pane({ agent: "pi", label: null, title: "π vim notes.md", terminal_title: "π vim notes.md", terminal_title_stripped: "π vim notes.md" }))).toBe("vim notes.md");
  });

  it("keeps the user's label over the session's title", () => {
    const labelled = pane({ agent: null, label: "retry", terminal_title: "zz retry", terminal_title_stripped: "zz retry", hibernated: asleep });
    expect(displayPaneTitle(labelled)).toBe("retry");
    expect(alertPaneTitle(labelled)).toBe("retry");
  });

  it("keeps the title of a pane without the annotation, even one whose title starts with zz", () => {
    const launcherless = pane({ agent: null, title: "zz .pi", terminal_title: "zz .pi", terminal_title_stripped: "zz .pi" });
    expect(displayPaneTitle(launcherless)).toBe("zz .pi");
    expect(alertPaneTitle(launcherless)).toBe("zz .pi");
  });

  it("falls back to the pane id for a pane with nothing to call it", () => {
    expect(displayPaneTitle(pane({ agent: null }))).toBe("w4:pZ");
  });
});
