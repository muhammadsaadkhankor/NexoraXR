#!/usr/bin/env bash
# Start the full NexoraXR stack:
#   1. stream-tts engine (VoxCPM2 via nano-vllm) on :8000  — conda env "tts"
#   2. Express backend on :3000
#   3. Vite frontend on :5173
#
# Run with: bash start_all.sh
# Stop with: bash stop_all.sh
set -e
cd "$(dirname "$0")"
mkdir -p logs

echo "==> Killing anything already on :8000, :3000, :5173"
for port in 8000 3000 5173; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
done
sleep 1

echo "==> Starting stream-tts engine on :8000 (conda env: tts, GPU_UTIL see stream-tts/.env)"
# start_server.sh needs `conda` as a shell function — source conda.sh and
# export the function set so the child bash inherits them.
if ! command -v conda >/dev/null 2>&1 || ! type conda 2>/dev/null | grep -q function; then
  for c in "$HOME/anaconda3" "$HOME/miniconda3" "$HOME/miniforge3"; do
    if [ -f "$c/etc/profile.d/conda.sh" ]; then . "$c/etc/profile.d/conda.sh"; break; fi
  done
fi
conda activate tts
export -f conda __conda_activate __conda_reactivate __conda_hashr __conda_exe 2>/dev/null || true

nohup bash stream-tts/scripts/start_server.sh > logs/stream_tts.log 2>&1 &
TTS_PID=$!
echo "$TTS_PID" > .run_pids

echo "==> Waiting for engine /ready (model load ~30 s)"
for i in $(seq 1 60); do
  if curl -sf -m 2 http://localhost:8000/ready 2>/dev/null | grep -q '"ready": *true'; then
    echo "    engine ready after ~$((i * 5))s"
    break
  fi
  if ! kill -0 "$TTS_PID" 2>/dev/null; then
    echo "ERROR: engine died during startup — see logs/stream_tts.log" >&2
    exit 1
  fi
  if [ "$i" -eq 60 ]; then
    echo "WARNING: engine not ready after 300 s — continuing anyway (check logs/stream_tts.log)" >&2
  fi
  sleep 5
done

echo "==> Starting backend on :3000"
cd src/nexora_server
nohup npm run dev > ../../logs/backend.log 2>&1 &
echo "$!" >> ../../.run_pids
cd ../..

echo "==> Starting frontend on :5173"
cd src/nexora_client
nohup npm run dev > ../../logs/frontend.log 2>&1 &
echo "$!" >> ../../.run_pids
cd ../..

echo ""
echo "All services launched:"
echo "  stream-tts engine :8000   (logs/stream_tts.log)"
echo "  backend           :3000   (logs/backend.log)"
echo "  frontend          :5173   (logs/frontend.log)"
echo "PIDs in .run_pids — stop everything with: bash stop_all.sh"
