### Added
- A pi pane's background list shows its ended subagents and background commands (`bg_run`), the
  newest ten that ended in the last day. A command shows its exit code and duration, and **Show
  output** reads the end of its log (the last 64 KB) from pi's background-job folder only.

### Changed
- A pi pane whose turn ends while its subagents still run reads BG. Any pane that waits on its
  background work now says **Background work running** in the sidebar, and on its chip while a
  task runs. The sidebar used to read "Agent waiting on background work".
- A merged compaction card shows the context it folded when pi recorded it. It shows only the
  newest summary, with **Show earlier summary** for the part before it, and says so when a
  summary is cut to its start.
