#!/bin/bash
# Restart the warm Otoha TTS server (manual bounce for local / phone use).
#
# Config via env (nothing machine-specific is hardcoded):
#   OTOHA_PYTHON   python to use            (default: python3)
#   OTOHA_MODEL    path to kokoro-v1.0.onnx (default: next to tts_server.py)
#   OTOHA_VOICES   path to voices-v1.0.bin  (default: next to tts_server.py)
#   OTOHA_HOST     bind address             (default: 127.0.0.1; use 0.0.0.0
#                  to reach it from a phone over LAN/Tailscale)
#   OTOHA_PORT     port                     (default: 8765)
set -e
PY="${OTOHA_PYTHON:-python3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${OTOHA_PORT:-8765}"

lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null || true
sleep 1
"$PY" "$HERE/tts_server.py" >| /tmp/otoha-server.log 2>&1 &
echo "otoha server starting (pid $!), log: /tmp/otoha-server.log"

for i in $(seq 1 30); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok; then
    echo "warm after ${i}s"; exit 0
  fi
  sleep 1
done
echo "did not become healthy in 30s — check /tmp/otoha-server.log"; exit 1
