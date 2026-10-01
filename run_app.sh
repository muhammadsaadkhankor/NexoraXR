#!/usr/bin/env bash
# Starts the dtalk backend (Express, port 3000) and frontend (Vite, port 5173).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed or not on PATH" >&2
  exit 1
fi

if [ ! -f src/backend/.env ]; then
  echo "Warning: src/backend/.env is missing. Copy src/backend/env.template.txt to src/backend/.env and fill in your API keys." >&2
fi

for dir in src/backend src/frontend; do
  if [ ! -d "$dir/node_modules" ]; then
    echo "Installing $dir dependencies..."
    npm install --prefix "$dir"
  fi
done

PIDS=()

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Shutting down..."
  for pid in "${PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Starting backend on http://localhost:3000 ..."
setsid npm --prefix src/backend run dev &
PIDS+=("$!")

echo "Starting frontend on http://localhost:5173 ..."
setsid npm --prefix src/frontend run dev &
PIDS+=("$!")

echo "Both services are running. Press Ctrl+C to stop."

# Exit as soon as either process dies, then clean up the other.
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "A service exited; stopping the other."
      exit 1
    fi
  done
  sleep 1
done
