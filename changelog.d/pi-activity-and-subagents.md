### Added
- The Agents list shows a pi pane's activity beside its badges: a build or test running (`▶`),
  subagents (`◐`), background commands (`◑`) and bot turns (`◓`), as the pi extension reports
  them in its `activity_dots` token. A row whose activity shows subagents leaves out its
  background count, so the subagents are not counted twice.
- A pi pane's running subagents count in its background-tasks button and on its Agents row. The
  button lists them with their type, model and elapsed time.
