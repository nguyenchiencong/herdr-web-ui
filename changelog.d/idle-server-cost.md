### Changed
- An idle Windows PC uses less CPU: the periodic process-table reads come from one long-lived
  PowerShell helper instead of a new PowerShell process for each read, and the table is not read
  again for an OmO or GJC pane whose processes have not changed, for up to 10 seconds. One-off
  checks (agent start, Portal, the update lock) start a PowerShell query per check and leave none
  running.
- Observers share one herdr session read while it is fresh: the status loops reuse a read for up
  to a second, and a conversation request shares only a read that is still running. A herdr event,
  or any direct read of the session, drops the shared read at once.
- A mirrored Windows terminal learns its pane's size from herdr's layout changes instead of asking
  herdr every two seconds, so a resize reaches the terminal in about a second instead of up to two.
- A terminal's output is encoded once for all of its viewers instead of once for each, and its
  replay tail is trimmed in batches; what a late joiner replays is unchanged.
- An OmO task folder with many records is counted in the background, so a status poll no longer
  blocks the server while it reads every record.
- The PC list is pushed to browsers when it changes, when a layout change reaches the server
  while the list is being read, and otherwise once a minute so a drifted browser copy is
  corrected; machines.json is written only when it has changed.
