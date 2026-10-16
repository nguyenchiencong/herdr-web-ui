### Changed
- The main script is 31% smaller (302,711 bytes brotli, down from 438,526). The settings, the command
  palette and the dialogs and viewers for files, diffs, images, machines, worktrees and new sessions
  load the first time they are needed; the palette and the new-session dialog are fetched while the
  app is idle, so they normally open at once.

### Maintenance
- An unchanged auth answer no longer re-renders the app on each five-second health poll. A chat read
  keeps the turns it did not change as the same objects, so their memoized turn components skip their
  render.
- A visible terminal acknowledges its output once per animation frame, or 50 ms after the wait began
  where no frame runs, and checks it for a password prompt once per frame, not once per chunk. A
  hidden page acknowledges and checks each chunk as xterm parses it, and sends a held acknowledgement
  when it is hidden. The acknowledgement stays cumulative, so the bridge's flow control is unchanged.
