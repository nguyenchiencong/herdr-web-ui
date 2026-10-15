### Changed
- A pi tool call shows what it acts on instead of a bare tool id: a subagent, a subagent's result or
  steer, a background task or its output, a script, a search, a classifier call, a session message or
  an image has an icon and a label, and its summary names the subagent or task it refers to when that
  call is earlier in the same turn.
- A call's arguments read as fields: a multi-line value is shown verbatim, not JSON-escaped, and a
  script's `code` is highlighted as JavaScript. On a phone the values wrap.
- A tool's output that reads as Markdown renders as Markdown, except a shell's, a file's or an edit's
  output. A result's status, duration and tokens show on one meta line, and a classifier's answers
  show as a table.
- The work block's header counts subagents, searches and web requests under their own names
  (`2 subagents · 1 command`) instead of as "other tools".

### Fixed
- A pi `edit` call shows its file and a diff for each replaced span. Its diff was empty before, and
  its file did not show.
