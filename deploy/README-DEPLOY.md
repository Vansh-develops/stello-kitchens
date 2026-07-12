# Deploying Stello Kitchens

A self-contained Docker Compose stack. Everything runs inside this folder's
containers; nothing on the host is modified except the images/volumes Docker owns.

## What runs where

| Service | Container port | Host bind | Subdomain | Notes |
|---|---|---|---|---|
| api | 3001 | `127.0.0.1:18081` | `api.` | NestJS REST + Socket.IO |
| dashboard | 3002 | `127.0.0.1:18082` | `app.` / `admin.` | Unified staff app — one login → POS / KDS / Console by role (was: Console only) |
| order | 80 | `127.0.0.1:18085` | `order.` | Vite PWA (diner Scan & Order) |
| connector | 3003 | `127.0.0.1:18086` | `connector.` | Aggregator webhooks (BullMQ) |
| postgres | 5432 | internal only | — | data in `pgdata` volume |
| redis | 6379 | internal only | — | data in `redisdata` volume |

`apps/edge` (offline Electron terminal) is **not** deployed here — it runs on each
store's device and syncs to `api.`.

## Deploy

```bash
./deploy/deploy.sh          # build + start everything
./deploy/deploy.sh --seed   # ONCE, on a fresh DB: load the demo tenant/menu
```

Secrets are generated into `deploy/.env` on first run (Postgres password, JWT
secret, connector shared-key). Keep that file; it is git-ignored.

Demo logins after `--seed`: `admin@demo.com` / `cashier@demo.com` /
`kitchen@demo.com`, all `password123`.

## Expose the subdomains (host nginx — done by the server admin)

The stack only binds to `127.0.0.1`. To make it public, point the host nginx at
the six ports and issue TLS certs — see [`nginx-host.conf.example`](nginx-host.conf.example).
You need six DNS records (`api`, `admin`, `pos`, `kds`, `order`, `connector`) all
pointing at the server.

## Common operations

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs -f api
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env restart api
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env down      # stop (keeps volumes)
```

To ship new code: re-sync the repo and re-run `./deploy/deploy.sh` (migrations
apply automatically; the DB volume persists).
