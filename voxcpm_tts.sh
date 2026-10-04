#!/usr/bin/env bash
# Start VoxCPM2 TTS (5001), NexoraXR Node backend (3000), and Vite frontend (5173 or next free).
# VoxCPM2 replaces CosyVoice — 30 languages incl. Arabic, cloned professor voice (abed101).
# Run with: bash voxcpm_tts.sh

cd "$(dirname "$0")"

set -euo pipefail

mkdir -p logs

echo "[*] Stopping any existing services on ports 8010, 3000, 5173..."
kill -9 $(lsof -t -i :8010 2>/dev/null) 2>/dev/null || true
kill -9 $(lsof -t -i :3000 2>/dev/null) 2>/dev/null || true
kill -9 $(lsof -t -i :5173 2>/dev/null) 2>/dev/null || true

# Activate the voxcpm conda environment
if [ -f "$HOME/anaconda3/etc/profile.d/conda.sh" ]; then
  source "$HOME/anaconda3/etc/profile.d/conda.sh"
  conda activate voxcpm
elif [ -f "$HOME/miniconda3/etc/profile.d/conda.sh" ]; then
  source "$HOME/miniconda3/etc/profile.d/conda.sh"
  conda activate voxcpm
else
  echo "[!] Could not find conda. Make sure the 'voxcpm' environment exists."
  exit 1
fi

echo "[*] Starting vLLM-Omni VoxCPM2 on port 8010..."
nohup vllm serve openbmb/VoxCPM2 --omni --host 0.0.0.0 --port 8010 \
  --gpu-memory-utilization 0.35 \
  --allowed-local-media-path "$(pwd)" > logs/voxcpm.log 2>&1 &
VOXPID=$!

echo "[*] Starting NexoraXR backend on port 3000 (TTS -> vLLM-Omni :8010)..."
cd src/nexora_server
VOXCPM_BASE_URL=http://localhost:8010 nohup node server.js > ../../logs/backend.log 2>&1 &
NODEPID=$!
cd ../..

echo "[*] Starting Vite frontend dev server..."
cd src/nexora_client
nohup npm run dev:frontend > ../../logs/frontend.log 2>&1 &
NPMYPID=$!
cd ../..

cat > .run_pids <<EOF
$VOXPID
$NODEPID
$NPMYPID
EOF

echo ""
echo "All services started. Open:"
echo "  Frontend : http://localhost:5173"
echo "  Backend  : http://localhost:3000"
echo "  VoxCPM   : http://localhost:8010  (vLLM-Omni, OpenAI /v1/audio/speech)"
echo ""
echo "PIDs saved to .run_pids"
echo "Logs are in logs/"
echo "To stop: kill -9 \$(cat .run_pids)"
echo ""
echo "Tail logs:"
echo "  tail -f logs/voxcpm.log"
echo "  tail -f logs/backend.log"
echo "  tail -f logs/frontend.log"
