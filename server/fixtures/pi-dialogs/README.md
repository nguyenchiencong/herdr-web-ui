# pi dialogs and the /model selector, rendered

These are pi 1.3.0's own renders of the menus the chat reads besides the session picker, rendered by
the components themselves at 120, 46 and 36 columns, with the ANSI codes and pi-tui's cursor markers
removed. `server/pi-dialogs.test.ts` reads each one with the readers `parsePiDialog` and `parsePiModel`
in `server/prompt.ts`.

| File | Component and state |
| --- | --- |
| `select-W` | `ctx.ui.select`: `ExtensionSelectorComponent` with the title `Allow dangerous command?` and three options, the cursor on the first |
| `confirm-W` | `ctx.ui.confirm`: the same component with the title and the message as one title (`Clear session?` over its message) and the options `Yes` and `No` |
| `model-W` | `/model`: `ModelSelectorComponent` with no scoped models (the configured-providers line shows), the current model `gpt-5` and `claude-sonnet-5` as the default |
| `model-scoped-120` | `/model` with two scoped models: the scope line `Scope: all \| scoped` and its tab hint show |
| `model-typed-several-120` | `/model` with the filter `o` typed: four models match, the search line reads `> o` |
| `model-typed-one-120` | `/model` with the filter `qwen` typed: one model matches, so the list has one row |

The `/model` runtime is a stub with four models and a refresh that resolves without errors, so the
catalog-refreshed line shows. The 36-column `/model` wraps `· default` onto its own line, which the
reader joins back to its row; the typed filter is read as the list under `>`. A list that leaves one
model is not a choice: `piModelRows` returns no list of fewer than two rows, so no card is offered for
`model-typed-one-120`.

To render again, use the same setup as `server/fixtures/pi-thinking-selector/README.md`, construct the component
with the stub runtime, wait for its refresh to settle, then `render(width)`. Regenerate only when pi's
components change; a changed render is a new reading to check, not a reason to loosen the readers.
