# pi thinking-level selector, rendered

These are the screens of pi 1.3.0's thinking selector (`ThinkingSelectorComponent`, in
`dist/modes/interactive/components/thinking-selector.js`), rendered by that component itself at 120,
46 and 36 columns, with the ANSI codes and pi-tui's cursor markers removed. The renders use pi's dark
theme and the keybindings pi resolves by default (`KeybindingsManager.create` on an empty agent
directory): `app.thinking.cycle` is Shift+Tab, `app.thinking.save` is Ctrl+S, `tui.select.confirm` is
Enter and `tui.select.cancel` is Escape/Ctrl+C. The component gets the levels `off` to `xhigh`, the
current level `high` and the default level `medium`, so the current row carries `✓` and the default row
carries `· default` where its description fits. The levels and their descriptions are the component's own
(`LEVEL_DESCRIPTIONS`), and it holds no session data.

| File pattern | State |
| --- | --- |
| `thinking-W` | the selector as it opens: the cursor on the current level (`→ ✓ high`) |
| `thinking-filter-W` | the search text `hi` typed: the list is filtered (`high`, `xhigh`, `low`) and the search line reads `> hi` |

`W` is the pane width in columns. At 46 the descriptions are cut to the pane and the hint wraps; at 36
the descriptions are gone, the shortcut line and the hint wrap, and the parser must read the hint as
the joined lines. Enter picks the level for the session; the hint's Ctrl+S (save as default) is never
offered as an answer.

The reader is `parsePiThinking` in `server/prompt.ts`; its tests are `server/pi-thinking.test.ts`.

To render again, import pi's dist from its install: `dist/index.js` exports `ThinkingSelectorComponent`
and `initTheme`; the component resolves the nested `node_modules/@earendil-works/pi-tui`, so keybindings
are set there with `setKeybindings(KeybindingsManager.create(emptyDir))`. Then call `initTheme("dark")`,
build the component as `new ThinkingSelectorComponent("high", levels, onSelect, onCancel, onSelectAsDefault,
"medium")`, call `render(width)`, strip the ANSI sequences, the OSC and APC sequences, and trailing spaces.
Regenerate only when pi's selector changes; a changed render is a new reading to check, not a reason to
loosen the parser.
