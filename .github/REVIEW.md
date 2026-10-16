# Review priorities

Report concrete failing scenarios and regressions before style suggestions. A passing
AI review is advisory; `bun run check` and maintainer review determine whether a PR can merge.

- This app bridges herdr-owned PTYs. Never load node-pty in Bun or rebuild an attached terminal's
  output from viewport snapshots (only a mirrored pane, `server/mirror.ts`, is drawn that way). Keep xterm scrollback at zero.
- `--takeover` is never automatic: an attach, a retry or a reconnect waits for the holder.
  Only a user's explicit request for that pane, from an interact connection, may take it.
- Observe connections cannot input, send keys or resize. Enforce this on the server.
- Never queue terminal input across disconnections. Only control frames replay.
- Concurrent attaches share pending creation; detach/close during creation must cancel
  that client's claim. Release the sidecar after its last client leaves.
- Each herdr RPC needs a fresh socket; only subscriptions stay connected. Pass the
  same socket to terminal attach through `HERDR_SOCKET_PATH`.
- Tests mutate only panes they create and use temporary app state. UI/media captures
  use isolated test/demo sessions. Preserve the user's running terminals and push keys.
- Generate `shared/herdr-api.generated.ts` from the committed schema. Check changes
  to HTTP/WS contracts on both client and server and cover them with contract tests.
- A malformed VAPID file must fail without rotating the key. The service worker must
  show a notification for every push, including while the app is visible.
- Preserve IME and native clipboard input. Use existing theme tokens for component CSS.
- The `conventions.test.ts` baselines only shrink, and a shallow checkout cannot compare them
  with main: flag a PR that raises a count in `scripts/fixed-sleeps.json` (a rename moves its entry
  with the same count) or adds an allowlist entry (DEMO_404, DEMO_IGNORES, UNIX_CONNECT_ALLOWED,
  NET_CONNECT_ALLOWED) without a reason that holds.
- Installed updaters discover Git tags immediately. Release only the exact commit
  that passed `bun run check full`; never create the release tag as a prerequisite for validation.
- External contributors' PRs get the same priority and the same bar as maintainers'
  own: review them when they arrive and consider them for the next release. Nothing runs a
  fork PR's checks for you: before running `bun run check` on one, read the scripts, tests and
  `package.json` scripts it changes, since the checks execute them on your machine.

[CONTRIBUTING.md](../CONTRIBUTING.md) is the process contributors follow. The
[AGENTS.md](../AGENTS.md) files give these invariants with their reasons and the conventions
of each directory. A PR is held only to rules committed in this repository.
