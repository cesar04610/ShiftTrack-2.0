#!/usr/bin/env bash
set -euo pipefail
cd /workspace/ShiftTrack-2.0
node --version
npm ci
if [ ! -e .env ]; then cp .env.example .env; fi
if docker inspect shifttrack-postgres >/dev/null 2>&1; then
  docker start shifttrack-postgres >/dev/null
else
  docker run -d --name shifttrack-postgres \
    -e POSTGRES_USER=shifttrack \
    -e POSTGRES_PASSWORD=shifttrack_local_only \
    -e POSTGRES_DB=shifttrack \
    -v shifttrack-dev-db:/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 postgres:17-alpine >/dev/null
fi
ready=false
for attempt in {1..30}; do
  if docker exec shifttrack-postgres pg_isready -U shifttrack -d shifttrack >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then echo 'PostgreSQL no disponible.' >&2; exit 1; fi
npm run db:migrate
npm run db:seed
npm run build:local
