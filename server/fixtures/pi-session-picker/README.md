# pi session picker, rendered

These are the screens of pi 1.3.0's `/resume` picker (`SessionSelectorComponent`, in
`dist/modes/interactive/components/session-selector.js`), rendered by that component itself at 120,
46 and 36 columns, with ANSI codes removed. The renders use pi's dark theme and the keybindings
pi resolves for every key the picker reads: the defaults, checked with `KeybindingsManager`. The
component gets the options `interactive-mode.js` passes (rename hint, keybindings, a current session
file) and fixed session lists in place of pi's loaders. Every session is fictional: the paths are
`C:/Users/x/...` and the messages are `session N: ...`.

| File pattern | State |
| --- | --- |
| `list-W` | the current folder, threaded, cursor on the first row |
| `cursor-15-of-23-W` | 23 sessions, cursor on row 15: the window starts at row 10 and the counter reads `(15/23)` |
| `scope-all-W` | scope All: the cwd is shown on each row |
| `search-thing-W` | search text `session 1` typed after ctrl+k (the search line reads `> session 1`) |
| `delete-confirm-W` | ctrl+d on a row that is not the active session: the hint line becomes `Delete session? ...` |
| `loading-W` | the loader has not answered: the scope reads `Loading ...` |
| `empty-current-W` | the current folder has no sessions |
| `tree-W` | forked sessions: the rows carry `├─` and `└─` tree prefixes |

`W` is the pane width in columns. At 46 and 36 the title row is cut away, and the hint lines are
cut with `…`, so the parser must not rely on the title or on a full hint.

The parser's test is `server/pi-session.test.ts`. To render again, import pi's dist from its install
(`dist/index.js` exports `SessionSelectorComponent`; the component resolves the nested
`node_modules/@earendil-works/pi-tui`, so keybindings must be set there with `setKeybindings`), call
`initTheme`, build the component with `{ keybindings, showRenameHint: true, renameSession }` and a session
file path as its eighth argument (the current session), then `render(width)`. Regenerate only when pi's picker
changes; a changed render is a new reading to check, not a reason to loosen the parser.
