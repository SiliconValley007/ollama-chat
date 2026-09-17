#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
export OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-gpt-oss:120b-cloud}"

if [ ! -f .app_token ]; then
  command -v openssl >/dev/null 2>&1 || { echo "[ERROR] openssl not found. Install it, or manually create .app_token with a random 32-char hex string."; exit 1; }
  openssl rand -hex 16 > .app_token
fi
export APP_TOKEN="$(cat .app_token)"

command -v node >/dev/null 2>&1 || { echo "[ERROR] Node.js not found. Install from https://nodejs.org"; exit 1; }

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Access: http://localhost:${PORT}/?token=${APP_TOKEN}"
TS_IP="$(command -v ifconfig >/dev/null 2>&1 && ifconfig | grep -oE 'inet (addr:)?100\.[0-9]+\.[0-9]+\.[0-9]+' | awk '{print $NF}' | head -1 || true)"
[ -z "$TS_IP" ] && TS_IP="$(command -v ip >/dev/null 2>&1 && ip -4 addr show | grep -oE '100\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ -n "$TS_IP" ] && echo "Phone (Tailscale): http://${TS_IP}:${PORT}/?token=${APP_TOKEN}"
PORT="$PORT" node server.js