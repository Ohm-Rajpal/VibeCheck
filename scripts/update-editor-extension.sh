#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/vscode-extension"
VSIX_PATH="$EXT_DIR/vibecheck-0.0.1.vsix"
TSC_BIN="$EXT_DIR/node_modules/typescript/bin/tsc"

log() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$1"
}

warn() {
  printf '\033[1;33mWARN:\033[0m %s\n' "$1"
}

install_if_available() {
  local cli="$1"
  if command -v "$cli" >/dev/null 2>&1; then
    log "Installing VibeCheck into $cli"
    "$cli" --install-extension "$VSIX_PATH" --force
  else
    warn "$cli CLI not found; skipping."
  fi
}

log "Compiling VS Code extension"
if [[ -x "$EXT_DIR/node_modules/.bin/tsc" ]]; then
  "$EXT_DIR/node_modules/.bin/tsc" -p "$EXT_DIR" --pretty false
elif [[ -f "$TSC_BIN" ]]; then
  node "$TSC_BIN" -p "$EXT_DIR" --pretty false
else
  warn "TypeScript compiler not found. Run npm install from the repo root first."
  exit 1
fi

log "Packaging VSIX"
if [[ -x "$EXT_DIR/node_modules/.bin/vsce" ]]; then
  (cd "$EXT_DIR" && "$EXT_DIR/node_modules/.bin/vsce" package --no-dependencies)
elif [[ -x "$EXT_DIR/node_modules/.bin/vsce.cmd" ]]; then
  (cd "$EXT_DIR" && "$EXT_DIR/node_modules/.bin/vsce.cmd" package --no-dependencies)
else
  (cd "$EXT_DIR" && npx --yes @vscode/vsce package --no-dependencies)
fi

if [[ ! -f "$VSIX_PATH" ]]; then
  warn "Expected VSIX not found at $VSIX_PATH"
  exit 1
fi

install_if_available windsurf
install_if_available code
install_if_available code-insiders
install_if_available cursor
install_if_available codium

log "Done"
printf 'Reload Windsurf/VS Code/Cursor windows to use the updated extension.\n'
printf 'Expected status bar: VibeCheck: clean · 🔥– 🧠–\n'
