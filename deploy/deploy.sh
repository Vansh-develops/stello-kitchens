#!/usr/bin/env bash
# One-command deploy for the Stello Kitchens stack. Run from anywhere; it operates
# only inside this repo. Builds the workspace image, then builds+starts the stack.
#
#   ./deploy/deploy.sh          # build + (re)start the whole stack
#   ./deploy/deploy.sh --seed   # after first start: load demo tenant/menu (ONCE)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
COMPOSE="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"

# --- secrets: generate once, then reuse ---
if [ ! -f deploy/.env ]; then
  echo "==> generating deploy/.env with fresh secrets"
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "CONNECTOR_KEY=$(openssl rand -hex 24)"
  } > deploy/.env
  chmod 600 deploy/.env
fi

if [ "${1:-}" = "--seed" ]; then
  echo "==> seeding demo data (one-shot; only run this on a fresh database)"
  $COMPOSE run --rm -w /repo/apps/api api pnpm exec prisma db seed
  echo "==> seed complete"
  exit 0
fi

echo "==> building workspace image (stello-build)"
docker build -f deploy/Dockerfile.build -t stello-build:latest .

echo "==> building service images + starting the stack"
$COMPOSE up -d --build

echo "==> stack status"
$COMPOSE ps
cat <<'EOF'

Done. Services are live on 127.0.0.1:
  18081  api         (api.<domain>)
  18082  dashboard   (admin.<domain>)
  18083  pos         (pos.<domain>)
  18084  kds         (kds.<domain>)
  18085  order       (order.<domain>)
  18086  connector   (connector.<domain>)

First deploy? Load demo data once:   ./deploy/deploy.sh --seed
Then point the host nginx at these ports — see deploy/nginx-host.conf.example
EOF
