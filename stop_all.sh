#!/usr/bin/env bash
# Stop everything start_all.sh launched: stream-tts engine (:8000),
# backend (:3000) and frontend (:5173).
cd "$(dirname "$0")"

if [ -f .run_pids ]; then
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < .run_pids
  rm -f .run_pids
fi

# Fallback: kill whatever still owns the ports (nodemon/npm children).
for port in 8000 3000 5173; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
done

echo "Stopped stream-tts (:8000), backend (:3000), frontend (:5173)."
