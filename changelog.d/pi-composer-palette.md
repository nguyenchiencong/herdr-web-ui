### Added
- A pi pane's `/` menu lists the skills of the packages in your pi settings, as `/skill:<name>`.
- Typing `@` in a pi pane completes the pi-subagents agents first, then the matching files. The
  agents are yours in `~/.pi/agent/agents`, and the project's `.pi/agents` and `.agents/agents`
  only where pi trusts the project.
- A pi chat draws a thin marker above a turn where the model, the thinking level or the mode
  changed since the turn before, and the composer shows the session's mode beside the model.

### Changed
- The `/` menu offers a pi skill only when its `SKILL.md` declares a description, as pi loads it,
  and offers no skill command at all while `enableSkillCommands` is off in your pi settings.
