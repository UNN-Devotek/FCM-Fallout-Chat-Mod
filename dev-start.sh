#!/usr/bin/env bash
# FCM local dev stack startup
# run from repo root
# Usage: bash dev-start.sh

set -e
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "==> Starting infrastructure (postgres, redis, minio)..."
$COMPOSE up -d postgres redis minio

echo "==> Waiting for postgres to be healthy..."
for i in $(seq 1 60); do
  status=$($COMPOSE ps postgres --format json 2>/dev/null | grep -o '"Health":"[^"]*"' | cut -d'"' -f4 || echo "")
  if [ "$status" = "healthy" ]; then
    echo "    postgres healthy after ${i}s"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "ERROR: postgres not healthy after 60s"
    $COMPOSE logs postgres --tail=20
    exit 1
  fi
  sleep 1
done

# Reset the DB user password to match .env, guards against stale passwords
# from previous container incarnations where the volume survived but env changed.
# Use PGPASSWORD + \set rather than string interpolation to avoid SQL injection
# from a local password that contains a quote character.
DB_PASSWORD=$(grep '^DB_PASSWORD=' "$ROOT/backend/.env" | cut -d= -f2 | tr -d ' ')
DB_USER=$(grep '^DB_USER=' "$ROOT/backend/.env" | cut -d= -f2 | tr -d ' ')
DB_NAME=$(grep '^DB_NAME=' "$ROOT/backend/.env" | cut -d= -f2 | tr -d ' ')
if [ -n "$DB_PASSWORD" ] && [ -n "$DB_USER" ]; then
  docker exec -e PGPASSWORD="$DB_PASSWORD" fcm-fallout-chat-mod-postgres-1 \
    psql -U "$DB_USER" -d "${DB_NAME:-fo76_chat}" \
    -c "ALTER USER \"$DB_USER\" WITH PASSWORD \$\$${DB_PASSWORD}\$\$" > /dev/null 2>&1 \
    && echo "    db password synced for $DB_USER" \
    || echo "    (password sync skipped — user may not exist yet)"
fi

echo "==> Waiting for redis to be healthy..."
for i in $(seq 1 30); do
  status=$($COMPOSE ps redis --format json 2>/dev/null | grep -o '"Health":"[^"]*"' | cut -d'"' -f4 || echo "")
  if [ "$status" = "healthy" ]; then
    echo "    redis healthy after ${i}s"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "ERROR: redis not healthy after 30s"
    exit 1
  fi
  sleep 1
done

echo "==> Starting backend (will npm install + prisma db push on first run)..."
# --no-recreate keeps postgres/redis/minio intact; backend gets recreated to pick up env changes
$COMPOSE up -d --no-recreate postgres redis minio
$COMPOSE up -d backend

echo "==> Waiting for backend to be healthy (up to 3 min for first-run npm install)..."
for i in $(seq 1 180); do
  status=$($COMPOSE ps backend --format json 2>/dev/null | grep -o '"Health":"[^"]*"' | cut -d'"' -f4 || echo "")
  state=$($COMPOSE ps backend --format json 2>/dev/null | grep -o '"State":"[^"]*"' | cut -d'"' -f4 || echo "")
  if [ "$status" = "healthy" ]; then
    echo "    backend healthy after ${i}s"
    break
  fi
  if [ "$state" = "exited" ]; then
    echo "ERROR: backend exited. Last logs:"
    $COMPOSE logs backend --tail=30
    exit 1
  fi
  if [ "$i" = "180" ]; then
    echo "ERROR: backend not healthy after 3 min. Last logs:"
    $COMPOSE logs backend --tail=30
    exit 1
  fi
  # Print progress every 15s
  if [ $((i % 15)) = "0" ]; then
    echo "    still waiting... (${i}s) last log: $($COMPOSE logs backend --tail=1 2>/dev/null | tail -1)"
  fi
  sleep 1
done

echo ""
echo "==> Stack is up."
echo "    Backend:   http://localhost:7076/api/health"
echo "    Dashboard: run 'cd admin-dashboard && npm run dev' then open http://localhost:7075"
echo "    Login:     http://localhost:7075/auth/dev-login/admin"
echo ""

# Quick health check
curl -sf http://localhost:7076/api/health | grep -o '"status":"[^"]*"' && echo " <- backend OK" || echo "WARNING: backend health check failed"
