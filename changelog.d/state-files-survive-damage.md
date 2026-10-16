### Fixed
- A state file that an unclean shutdown left zero-filled or truncated no longer stops the server
  from starting. It is moved aside to `<name>.corrupt-<time>` with a warning in the server log,
  and the server starts with that state empty. In `machines.json` and `herdr-profile-state.json`
  only an entry that does not check out is dropped: the other PCs keep their state, and the file
  is copied to `<name>.corrupt-<time>`. Devices, the Portal state and the push key are never moved
  aside: a damaged one is refused instead.
- A state file that cannot be read for another reason, such as one another program holds open, is
  no longer taken for damaged: it is left in place, and the server does not save its empty state
  over it. The server keeps running without its contents until it can be read. Losing approvals
  from a damaged `herdr-profile-state.json` removes the generated SSH keys of the saved herdr PCs
  that lost them, so each asks for approval again.
- State files are written durably, with the data on disk before the file replaces the previous
  one, so a crash no longer leaves an empty file in its place.
