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
