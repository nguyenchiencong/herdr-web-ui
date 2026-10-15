# Fictional pi-harness session

`orchestration.jsonl` is a hand-written pi session: 26 records, one JSON object per line, with the
record shapes the pi harness writes (`message`, `custom_message`, `compaction`, `model_change`,
`thinking_level_change`). It was written from the shapes described in
[docs/audits/2026-10-15-pi-harness-ux.md](../../../docs/audits/2026-10-15-pi-harness-ux.md), not
copied from any session. Every name, id, path and model is fictional: `sa_7f3c` and `sa_9b21` are
subagent ids, `bg_2a9` and `bg_3c08` are background task ids, `Atlas` is a sender,
`fictional-model-1` is the model, and `/fictional/...` is every path.

The story: one prompt starts two subagents and a background command. Their completions, a peer
message and a fallback notice all arrive while the turn is still at work, so they stay inside it. A
second prompt follows a settled answer and a background wake. Two adjacent compactions close the
session.

| Record | What the chat shows |
| --- | --- |
| `pi-context` after the first prompt | a `Project context` chip under that prompt: `6 docs · 5k tokens` |
| `subagent-notification` `sa_7f3c` (mid-work) | a task row in the work turn: `reviewer · 1m 1s · 6 tool calls · 18k tokens`, status `done` |
| `background-task-notification` `bg_2a9` (mid-work, exit 1) | a task row in the work turn: `command · 34s`, status `failed`; opened, its result `Exit code 1` |
| `session-comms-message` from `Atlas` (mid-work) | a notice labelled `Message from another session: Atlas`; its text keeps pi's untrusted-data wrapper |
| `release-lint:warning` (mid-work) | a notice labelled `Release lint warning` |
| `subagent-notification` `sa_9b21` (mid-work) | a task row in the work turn: `explorer · 40s · 3 tool calls · 6k tokens`, status `done` |
| `background-task-notification` `bg_3c08` (after the settled answer) | a task card in its own user turn: `command · 5s`, status `done` |
| `pi-context` after the second prompt | a `Project context` chip under that prompt: `3 docs · 2k tokens` |
| two adjacent `compaction` records | one compaction card, `Conversation compacted · 9k tokens`, with the later summary |

The parse is checked by `server/pi.test.ts`, "reads the demo fixture as its README describes it".
The chat formats the record's numbers: tokens are rounded to whole thousands (`formatTokens`), and
durations use `formatElapsed`.

## Loading it in the demo's `cli` pane

The browser demo does not parse transcripts. `site/demo/transport.ts` answers
`/api/pane/conversation` from `CHATS` in `site/demo/fixtures.ts`; the general mechanism is in
[the browser demo](../../../docs/development.md#the-browser-demo). The `cli` pane is the one with
the key `cli` and `agent: "pi"` in `SPECS`, and its chat is `CHATS.cli`. To show this session there:

1. Print the parsed page in the shape `CHATS` declares:

   ```bash
   bun -e "import { transcriptPage } from './server/conversation.ts'; const page = transcriptPage('pi-transcript', 'server/fixtures/pi-harness/orchestration.jsonl'); console.log(JSON.stringify({ turns: page.turns, metadata: { model: page.metadata.model, reasoning_effort: page.metadata.reasoning_effort } }, null, 1))"
   ```

2. Paste the printed object over the value of `CHATS.cli` in `site/demo/fixtures.ts`. `CHATS` declares `metadata` as `{ model, reasoning_effort }`, so the page's `context` is left out.
3. Rebuild the demo with `bun run build:site`.

`scripts/readme-media/stage.ts` reads the same `CHATS`, so the README's staged media use the new chat too.

`CHATS.cli` now holds this session. Its timestamps were moved onto the clock of `site/demo/fixtures.ts`
(`t(16, 10)` to `t(22, 30)` for 09:00:10 to 09:06:30): the demo shifts every chat by one amount so the
newest turn ended three minutes ago, and a later date here would push the other chats days back. Redo
that mapping when you paste a new parse. The fixture has no `<previous-summary>` and records no mode,
so the demo shows neither "Show earlier summary" nor a mode marker.
