#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/packages/api"
VENV_DIR="$API_DIR/.venv"
REQ_FILE="$API_DIR/requirements.txt"
REQ_STAMP="$VENV_DIR/.requirements.sha256"
PYTHON_BIN="${PYTHON_BIN:-python3}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

log() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$1"
}

if command -v curl >/dev/null 2>&1 && curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then
  log "VibeCheck API is already running on localhost:$PORT"
  printf 'Health check: http://localhost:%s/health\n' "$PORT"
  printf 'Metrics health: http://localhost:%s/metrics/health\n' "$PORT"
  exit 0
fi

if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$PORT" | grep -q ":$PORT"; then
  printf '\nPort %s is already in use, but /health did not respond.\n' "$PORT"
  printf 'A previous broken uvicorn process may still be holding the port.\n\n'
  printf 'Find it with:\n'
  printf '  ss -ltnp | grep :%s\n\n' "$PORT"
  printf 'Then stop that process and rerun:\n'
  printf '  npm run start:api\n\n'
  exit 1
fi

if [[ ! -f "$VENV_DIR/bin/activate" || ! -x "$VENV_DIR/bin/python" ]]; then
  log "Creating API virtualenv"
  if ! "$PYTHON_BIN" -m venv --clear "$VENV_DIR"; then
    printf '\nFailed to create virtualenv. On Ubuntu/WSL, install python venv support first:\n'
    printf '  sudo apt install python3.12-venv\n\n'
    exit 1
  fi
fi

source "$VENV_DIR/bin/activate"

CURRENT_REQ_HASH="$(python - "$REQ_FILE" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as f:
    print(hashlib.sha256(f.read()).hexdigest())
PY
)"

INSTALLED_REQ_HASH=""
if [[ -f "$REQ_STAMP" ]]; then
  INSTALLED_REQ_HASH="$(cat "$REQ_STAMP")"
fi

if [[ "$CURRENT_REQ_HASH" != "$INSTALLED_REQ_HASH" ]]; then
  log "Installing API dependencies"
  python -m pip install --upgrade pip
  python -m pip install -r "$REQ_FILE"
  printf '%s\n' "$CURRENT_REQ_HASH" > "$REQ_STAMP"
else
  log "API dependencies already installed"
fi

log "Starting VibeCheck API on $HOST:$PORT"
printf 'Health check: http://localhost:%s/health\n' "$PORT"
printf 'Metrics health: http://localhost:%s/metrics/health\n' "$PORT"
cd "$ROOT_DIR"
exec uvicorn packages.api.main:app --reload --reload-dir "$API_DIR" --host "$HOST" --port "$PORT"
