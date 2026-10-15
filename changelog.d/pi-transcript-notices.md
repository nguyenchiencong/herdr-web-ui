### Changed
- A pi chat shows project context as a chip on the prompt it follows, not as a separate divider,
  and another session's message is labelled with its sender.
- A subagent's or background command's completion in a pi chat shows as a task result; a
  background command that exits non-zero shows as failed.
- Two adjacent pi compactions show as one card, with the later summary.

### Fixed
- A notice that arrives while a pi turn is still at work stays inside that turn, so the turn is no
  longer split into several "Worked for" blocks.
