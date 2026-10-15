import { describe, expect, it } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationPart } from "../../shared/protocol.ts";
import { formatTokens } from "../lib/compose.ts";
import { ChatRowMemoryContext } from "../lib/chatRowState.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { CompactCard } from "./ChatView.tsx";

type Compact = Extract<ConversationPart, { kind: "compact" }>;

/** The card drawn in English, as the settings read the browser's languages, which this runtime does not define. */
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

/** The first button in a rendered tree: what a click on the card lands on. */
function buttonIn(node: ReactNode): ReactElement<{ onClick: () => void; "aria-expanded": boolean }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = buttonIn(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === "button") return node as ReactElement<{ onClick: () => void; "aria-expanded": boolean }>;
  return buttonIn(node.props.children);
}

describe("CompactCard", () => {
  it("shows the newest part of the summary and the tokens it folded, and keeps the earlier summary behind a button", () => {
    const compact: Compact = { kind: "compact", text: "## Session Goal\n- second fold", earlier: "## Old goal\n- first fold", tokens: 9120 };
    const markup = render(createElement(CompactCard, { compact, time: null }));
    expect(markup).toContain("Conversation compacted");
    expect(markup).toContain(`${formatTokens(9120)} tokens`);
    expect(markup).toContain("Session Goal");
    expect(markup).toContain("Show earlier summary");
    expect(markup).not.toContain("Old goal");
  });

  it("opens the earlier summary on a click of Show earlier summary, and folds it on Hide earlier summary", () => {
    const compact: Compact = { kind: "compact", text: "## Session Goal\n- second fold", earlier: "## Old goal\n- first fold", tokens: 9120 };
    // the row's memory, as the chat's list keeps it for each row: the card's state outlives a remount
    const memory = { toggles: new Map<string, boolean | null>(), outputs: new Map<string, string>() };
    let drawn: ReactNode = null;
    // the card drawn by a probe that keeps what it drew, so the test can press the button in it
    const Probe = () => (drawn = CompactCard({ compact, time: null }));
    const draw = () => render(createElement(ChatRowMemoryContext.Provider, { value: memory }, createElement(Probe)));
    const click = () => {
      const button = buttonIn(drawn);
      expect(button).not.toBeNull();
      button!.props.onClick();
    };

    const closed = draw();
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Old goal");
    click();
    const opened = draw();
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain("Hide earlier summary");
    expect(opened).toContain("Old goal");
    expect(opened).toContain("Session Goal");
    click();
    const folded = draw();
    expect(folded).toContain("Show earlier summary");
    expect(folded).not.toContain("Old goal");
  });

  it("draws neither the figure nor the button for a compaction that records neither, and says a cut summary is its first part", () => {
    const compact: Compact = { kind: "compact", text: "## Session Goal", text_cut: true };
    const markup = render(createElement(CompactCard, { compact, time: null }));
    expect(markup).not.toContain("tokens");
    expect(markup).not.toContain("earlier summary");
    expect(markup).toContain("This is the first part of the summary");
  });
});
