import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmoTask } from "../../shared/protocol.ts";
import { formatTokens } from "../lib/compose.ts";
import { formatElapsed } from "../lib/omoTasks.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { BackgroundTaskRow, BackgroundTasks } from "./BackgroundTasks.tsx";

const NOW = Date.parse("2026-10-15T03:00:00.000Z");

const task = (over: Partial<OmoTask>): OmoTask => ({
  id: "t1", title: "task", category: null, model: null, status: "completed", started_at: null, ended_at: null,
  turns: null, tool_calls: null, tokens: null, ...over,
});

/** The element drawn in English, as the settings read the browser's languages, which this runtime does not define. */
function render(element: ReactElement): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("BackgroundTaskRow", () => {
  it("draws a background command by its name, exit code and duration, and offers its output", () => {
    const markup = render(createElement(BackgroundTaskRow, {
      paneId: "pane-1",
      at: NOW,
      task: task({ id: "bg_2a9", title: "unit tests", category: "command", status: "failed", started_at: new Date(NOW - 39_000).toISOString(), ended_at: new Date(NOW - 5_000).toISOString(), exit_code: 1, output: true }),
    }));
    expect(markup).toContain("is-command");
    expect(markup).toContain("unit tests");
    expect(markup).toContain("Exit code 1");
    expect(markup).toContain(formatElapsed(34_000));
    expect(markup).toContain("Command: failed");
    expect(markup).toContain("Show output");
    expect(markup).not.toContain("tool call");
  });

  it("draws a command with no output without the button, and a subagent by its numbers", () => {
    const command = render(createElement(BackgroundTaskRow, {
      paneId: "pane-1",
      at: NOW,
      task: task({ id: "bg_1", title: "lint", category: "command", status: "completed", exit_code: 0, output: false }),
    }));
    expect(command).toContain("Exit code 0");
    expect(command).not.toContain("Show output");

    const subagent = render(createElement(BackgroundTaskRow, {
      paneId: "pane-1",
      at: NOW,
      task: task({ id: "sa_1", title: "Read retry code", category: "reviewer", status: "completed", tool_calls: 6, tokens: 18_420 }),
    }));
    expect(subagent).toContain("reviewer");
    expect(subagent).toContain("6 tool calls");
    expect(subagent).toContain(`${formatTokens(18_420)} tokens`);
    expect(subagent).not.toContain("is-command");
    expect(subagent).not.toContain("Exit code");
    expect(subagent).not.toContain("Show output");
  });
});

describe("BackgroundTasks chip", () => {
  it("says background work is running while the pane rests on it, and counts its tasks otherwise", () => {
    const waiting = render(createElement(BackgroundTasks, { paneId: "pane-1", count: 2, omo: false, pi: true, waiting: true, status: "idle" }));
    expect(waiting).toContain("Background work running");
    expect(waiting).toContain("is-waiting");

    const working = render(createElement(BackgroundTasks, { paneId: "pane-1", count: 2, omo: false, pi: true, status: "working" }));
    expect(working).toContain("2 background tasks");
    expect(working).not.toContain("Background work running");
  });
});
