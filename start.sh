#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
export OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-gpt-oss:120b-cloud}"

if [ ! -f .app_token ]; then
  openssl rand -hex 16 > .app_token
fi
export APP_TOKEN="$(cat .app_token)"

command -v node >/dev/null 2>&1 || { echo "[ERROR] Node.js not found. Install from https://nodejs.org"; exit 1; }

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Access: http://localhost:${PORT}/?token=${APP_TOKEN}"
PORT="$PORT" node server.js