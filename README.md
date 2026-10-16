# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

A browser and phone client for [herdr](https://github.com/herdrdev/herdr). Supported agents (Claude Code, Codex and [others](docs/guide.md#supported-agents)) show their chat, and every agent pane has its live terminal a click away. Remote PCs join over SSH, and web push alerts tell you when an agent needs input. It runs beside herdr's own TUI on the same panes, not instead of it. On Windows the terminal is a screen mirror (typing and a fixed grid), because herdr cannot attach terminals there yet. The upstream [website](https://herdrweb.dev/) has a [demo](https://herdrweb.dev/demo/).

Docs: [user guide](docs/guide.md) · [development](docs/development.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md)

## install

This checkout runs as a locally linked herdr plugin on Windows x64. You need herdr 0.9.0+, Bun 1.4+ and Git for Windows.

```powershell
cd path\to\herdr-web-ui
bun install
bun run build
herdr plugin link "$PWD" --enabled
```

- **Settings**: `%APPDATA%\herdr\plugins\config\devswha.herdr-web-ui\env`, one `KEY=value` per line: `HOST` (default `127.0.0.1`, this PC only), `PORT` (`7317`), `HERDR_WEB_TOKEN`. It holds the token, so keep it private. Restart after editing: `hweb restart`.
- **State**: `~/.config/herdr-web-ui` (push keys, paired devices, update builds). **Log**: `%LOCALAPPDATA%\herdr\plugins\devswha.herdr-web-ui\server.log`.
- **Run**: herdr starts the server with itself. Open **http://localhost:7317**. For the phone, run the **Phone setup** action: `herdr plugin action invoke devswha.herdr-web-ui.phone-windows`.
- **Don't** click **Update and restart** (Settings → About), or the update line under the header. It installs the newest `vX.Y.Z` tag from `origin`, a release build instead of this checkout. Use `hweb update`.

## hweb

`hweb` is a personal helper for this checkout, run from Git Bash, PowerShell or cmd (`hweb.cmd` calls Git for Windows' bash). Its launchers live outside the repo, in `~\bin` by default. Install them from the checkout, with Git for Windows and Bun on PATH:

```powershell
bun run hweb:install   # writes hweb and hweb.cmd into ~\bin; --dir <folder> chooses another
```

The installer moves an older `hweb` aside before replacing it, never overwrites another file without `--force`, and prints the line that adds its folder to PATH; it never changes PATH itself. `bun run hweb:uninstall` removes the launchers. `start`, `stop`, `restart` and `update` need herdr on PATH. Windows is the tested platform: on macOS and Linux the same commands use the plain `start` and `stop` actions, which is untested.

| Command | What it does |
| --- | --- |
| `hweb start` | start; wait up to 30 s for health |
| `hweb stop` | stop; wait up to 15 s for health to go |
| `hweb restart` | stop, then start |
| `hweb status` | running revision vs checkout HEAD: `up to date`, `rebuild needed` or `not running` |
| `hweb update` | install dependencies only if `package.json` or `bun.lock` changed or `node_modules` is missing, build, restart. No git pull |
| `hweb log` | last 40 lines of `server.log` |

`hweb help` lists them. `--dry-run` before `start`, `stop`, `restart` or `update` prints the plan and changes nothing. A failed install or build leaves the running server alone.

Without the helper: `herdr plugin action invoke devswha.herdr-web-ui.start-windows` (or `stop-windows`, `status-windows`), and `curl http://127.0.0.1:7317/api/health` (its `web_ui.revision` is the running commit). hweb finds the checkout from its own location and reads `PORT` and `HOST` from the plugin's settings (`herdr plugin config-dir devswha.herdr-web-ui`), so it follows a changed port. A stale `%LOCALAPPDATA%\hweb\operation.lock` blocks it: delete it only when no hweb command is running.

## sync with upstream

`git fetch upstream`, then `git merge upstream/main` (resolve conflicts), then `hweb update`. `origin` is your fork; `upstream` is devswha/herdr-web-ui.

## development

`bun run server` and the plugin both use port 7317, so run `hweb stop` first. Vite proxies `/api` and `/ws` to 7317.

```bash
bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173, in a second terminal
bun run typecheck
bun run check fast  # generated types, typecheck, build, unit tests; no herdr needed
bun test            # all tests; herdr-backed ones use an isolated session
```

There is no GitHub CI: `bun run check full` is the gate before a merge, and releases are made by hand.
Commands, checks and releases are in [docs/development.md](docs/development.md). A user-visible change gets a `changelog.d/` fragment, not a CHANGELOG.md edit.

## security

- `HOST=0.0.0.0` over plain `http://` exposes `HERDR_WEB_TOKEN` to anyone on that network: prefer Tailscale (`tailscale serve`) or `HOST=127.0.0.1`.
- Phone install and push alerts need HTTPS or localhost: see [on your phone](docs/guide.md#on-your-phone).
- Anonymous install and update counts are on by default and go to the upstream maintainer's telemetry Worker. Turn them off in **Settings → About → Anonymous usage counts**, or set `HERDR_WEB_TELEMETRY=0` in the settings file.

## thanks and license

Built on [herdr](https://github.com/herdrdev/herdr) and forked from [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui), with thanks to its contributors. [MIT](LICENSE), Copyright (c) 2026 devswha. Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
