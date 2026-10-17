# server/

- Never let an attachment outlive its last client, and never resize from an attach that asked to
  `keep_size` or from an observer.
- Never refresh an OAuth token in `usage.ts`: the CLIs rotate refresh tokens, so our refresh signs
  the user's CLI out. Report `expired` and leave it to the CLI.
- Revoking every paired device must never reopen the LAN, and a `devices.json` that will not parse
  is not a first installation.
- Only proof says herdr is gone: on Windows a dead daemon's pid is reused by the next process.
- The user's API keys go upstream only; no response or error message carries one.
- Only Vite's fingerprinted `/assets/` may be cached long; `sw.js`, the manifest and the app shell
  must revalidate, or an installed PWA is pinned to an old build.
- A state file that holds a trust decision is never moved aside as damaged: starting
  `devices.json` empty would open the LAN, starting `portal/state.json` empty would hide a live
  tunnel, and a new `vapid.json` would orphan every subscribed device. Those fail closed. New
  state files load through `readJsonState` and write through `writeFileAtomic`
  (`server/state-file.ts`). `readJsonState` moves a file aside only when it is damaged (it does not
  parse, or has the wrong shape); any other read error throws and leaves the file in place, and a
  loader that catches it must not save its empty state over that file.
- A pi session asleep in its pane is held by pi's sleep launcher (`pi-launcher-hibernate.mjs`). An
  older launcher resumes on any chunk that contains a CR or an LF, so a multi-line paste wakes it. The
  current one resumes only on a chunk that is exactly CR, LF or CRLF, so a bare Enter wakes it and a
  paste does not. Both quit on a lone `q` or `Q`, or on any chunk that contains Ctrl+C, and both also
  wake on their schedule or through their loopback wake socket. Whichever launcher holds the pane,
  never type message text into it: wake it with Enter alone, then send once the wake is reached
  (`wakeSleepingPi` in `server/index.ts`: pi reports the session, idle or done, and the banner is gone;
  where herdr named pi before the Enter, also pi's `readyAt` marker for the wake, or a rise of the pane
  agent's `state_change_seq`, else `agent_waking` and nothing typed). Every wake Enter the server sends
  (`startWake`: the card's Resume, a message, a terminal line) is registered as a wake (`PiWakes` in
  `server/pi-sleep.ts`) before it is sent, and holds the pane until it is reached or 60 s pass. A wake the
  launcher began itself holds it while its record reads awake and recent, without `readyAt`
  (`derivedWakingMarker`). A message sent meanwhile is refused as `agent_waking`. A wake that ran out with pi
  not ready refuses one chat message as `agent_not_ready`, unless herdr names pi for the pane, and a sleep it
  left open is woken again instead; a sleep that begins after a wake ends it. No wake Enter and no lone `q` is sent without a fresh
  read of the same sleep record, its launcher alive and the banner the pane's last line (`requireSleeping`,
  `requireLauncherBanner`), and the card is offered only while that banner is the last line (`readPrompt` in
  `server/prompt.ts`). A sleeping record with no `zz` title on its pane refuses a send as `agent_waking` only for `SLEEP_TITLE_WAIT_MS`
  (15 s) after its `sleptAt`, while pi is still going to sleep (`sleepHeldWithoutTitle`, `sleepStartingOf`). `processAlive`
  reads a reused pid as a live launcher, so an older record names no sleep there, and a pane restored as a plain shell must
  take input. The sleep launcher (`pi-launcher-hibernate.mjs`, the copy in the user's `~/.pi/patches`, outside this repo) marks its record
  awake (with `endedAt`) before it clears the title, so an external wake leaves no title-less window. A launcher already running
  keeps the order it started with: a sleep under an earlier one clears the title first, and that window is covered only while the
  sleep is younger than 15 s (`SLEEP_TITLE_WAIT_MS`). A wake the server began is held by its marker at any age. herdr names
  the sleeping pane one
  of three ways, and none of them is awake: no agent (a launcher under its own name), `pi` (a launcher run
  as a process named `pi`, such as a `pi.cmd` wrapper), or the launcher's own label `zz pi`
  (`SLEEP_AGENT_LABEL` in `shared/sleep-agent.ts`: idle, state label `asleep`, sent at sleep start and
  again at 1 s and 3 s, released before the launcher resumes or quits). The label is no agent, and its own
  idle is never pi's ready state: after the Enter, the wake waits for `pi` itself. The sleep record under
  `state/hibernate` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`), whose launcher must
  still be alive, is the evidence (`server/pi-sleep.ts`). A pane carrying the label without such a record
  is a plain terminal, except that a send to it is refused as `pi_asleep` while the banner shows. A sleep record
  that could not be read or parsed is never kept: the next read reads it again (`recordFileOf`, `server/pi-sleep.ts`).
