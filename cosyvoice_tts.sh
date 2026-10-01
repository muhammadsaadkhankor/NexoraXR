#!/usr/bin/env bash
# Start CosyVoice TTS (5000), NexoraXR Node backend (3000), and Vite frontend (5173 or next free).
# Run with: bash cosyvoice_tts.sh

cd "$(dirname "$0")"

set -euo pipefail

mkdir -p logs

echo "[*] Stopping any existing services on ports 5000, 3000, 5173..."
kill -9 $(lsof -t -i :5000 2>/dev/null) 2>/dev/null || true
kill -9 $(lsof -t -i :3000 2>/dev/null) 2>/dev/null || true
kill -9 $(lsof -t -i :5173 2>/dev/null) 2>/dev/null || true

# Activate the cosyvoice conda environment
if [ -f "$HOME/anaconda3/etc/profile.d/conda.sh" ]; then
  source "$HOME/anaconda3/etc/profile.d/conda.sh"
  conda activate cosyvoice
elif [ -f "$HOME/miniconda3/etc/profile.d/conda.sh" ]; then
  source "$HOME/miniconda3/etc/profile.d/conda.sh"
  conda activate cosyvoice
else
  echo "[!] Could not find conda. Make sure the 'cosyvoice' environment exists."
  exit 1
fi

echo "[*] Starting CosyVoice FastAPI on port 5000..."
cd CosyVoice
export PYTHONPATH=$(pwd):$(pwd)/third_party/Matcha-TTS
nohup python runtime/python/fastapi/server.py --model_dir pretrained_models/CosyVoice2-0.5B > ../logs/cosyvoice.log 2>&1 &
COSSYPID=$!
cd ..

echo "[*] Starting NexoraXR backend on port 3000..."
cd src/backend
nohup node server.js > ../../logs/backend.log 2>&1 &
NODEPID=$!
cd ../..

echo "[*] Starting Vite frontend dev server..."
cd src/frontend
nohup npm run dev:frontend > ../../logs/frontend.log 2>&1 &
NPMYPID=$!
cd ../..

cat > .run_pids <<EOF
$COSSYPID
$NODEPID
$NPMYPID
EOF

echo ""
echo "All services started. Open:"
echo "  Frontend : http://localhost:5173"
echo "  Backend  : http://localhost:3000"
echo "  CosyVoice: http://localhost:5000"
echo ""
echo "PIDs saved to .run_pids"
echo "Logs are in logs/"
echo "To stop: kill -9 \$(cat .run_pids)"
echo ""
echo "Tail logs:"
echo "  tail -f logs/cosyvoice.log"
echo "  tail -f logs/backend.log"
echo "  tail -f logs/frontend.log"
