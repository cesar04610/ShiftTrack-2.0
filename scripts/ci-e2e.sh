#!/usr/bin/env bash
set -euo pipefail
npm run dev:api > /tmp/shifttrack-api.log 2>&1 &
api_pid=$!
npx vite preview --config apps/web/vite.config.ts --port 5174 > /tmp/shifttrack-web.log 2>&1 &
web_pid=$!
trap 'kill "$api_pid" "$web_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:8080/api/v1/health > /dev/null && curl --fail --silent http://127.0.0.1:5174/ > /dev/null; then
    npm run test:e2e
    exit $?
  fi
  sleep 1
done
echo 'Servicios no disponibles para E2E.' >&2
exit 1
