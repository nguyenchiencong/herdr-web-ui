import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { PendingMessages } from "./PendingMessages.tsx";

const render = (code: string, message: string): string => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PendingMessages, {
  messages: [{ id: "p1", request_id: 1, text: "ls", state: "held", created_at: "2026-10-14T00:00:00.000Z", serverOwned: true, error: { code, message } }],
  connected: true, blocked: false, unsaved: false, isBusy: () => false,
  onSendNow: async () => {}, onDiscard: async () => {},
}) }));

describe("a pending row's refusal note", () => {
  it("says a held-input refusal as a sentence", () => {
    expect(render("held_input", "send or discard the held input first")).toContain("Not sent: send or discard the held input first.");
  });

  it("keeps the server's reason for other refusals", () => {
    expect(render("agent_blocked", "the agent is busy")).toContain("Not sent: the agent is busy");
  });
});
