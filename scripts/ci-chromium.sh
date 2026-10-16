#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/.." && pwd)"
cd "$repo"

cli="node_modules/playwright-core/cli.js"

if [ -n "${CI:-}" ]; then
  printf '%s\n' "[setup] Installing Chromium system dependencies..." >&2
  bun_path="$(command -v bun)"
  # Run apt as root so the bounded retry can kill a timed-out apt process.
  if sudo bash scripts/ci-bounded-retry.sh 300 "$bun_path" "$cli" install-deps chromium >&2; then
    :
  else
    status=$?
    printf '%s\n' "[setup] Failed to install Chromium system dependencies" >&2
    exit "$status"
  fi
fi

printf '%s\n' "[setup] Installing Chromium browser..." >&2
if bun "$cli" install chromium >&2; then
  :
else
  status=$?
  printf '%s\n' "[setup] Failed to install Chromium browser" >&2
  exit "$status"
fi

if chrome_path="$(bun -e 'console.log(require("playwright-core").chromium.executablePath())')"; then
  :
else
  status=$?
  printf '%s\n' "[setup] Failed to resolve the Chromium executable from the project's playwright-core" >&2
  exit "$status"
fi

if [ -z "$chrome_path" ] || [[ "$chrome_path" == *$'\n'* ]] || [ ! -x "$chrome_path" ]; then
  printf '[setup] Chromium executable is missing or not executable: %s\n' "${chrome_path:-<empty>}" >&2
  exit 1
fi

printf '%s\n' "$chrome_path"
