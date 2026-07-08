#!/usr/bin/env bash
# Guards the standalone docker-compose.prod.external-data.yml against drifting
# from docker-compose.prod.yml: both are rendered by the same compose binary
# and every shared service definition must match exactly, except the fields
# that legitimately differ (depends_on on the bundled data services, and the
# data-service env: DATABASE_URL / WORLD_DATABASE_URL / S3_ENDPOINT / S3_BUCKET
# / S3_REGION). Run from anywhere; CI runs it in the prod-compose job.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVFILE=$(mktemp)
trap 'rm -f "$ENVFILE"' EXIT
cat > "$ENVFILE" <<'EOF'
APP_DOMAIN=drift.example.com
IMAGE_TAG=drift
POSTGRES_PASSWORD=drift
GARAGE_RPC_SECRET=drift
S3_ACCESS_KEY_ID=GKdeadbeefdeadbeefdeadbeefdeadbeef
S3_SECRET_ACCESS_KEY=drift
ENCRYPTION_MASTER_KEY=drift
PLATFORM_JWT_SECRET=drift
BETTER_AUTH_SECRET=drift
WORKER_SHARED_SECRET=drift
WORKER_ID=00000000-0000-0000-0000-000000000000
DATABASE_URL=postgres://drift@db.example.com:5432/product
WORLD_DATABASE_URL=postgres://drift@db.example.com:5432/world
S3_ENDPOINT=https://s3.example.com
EOF

base=$(docker compose --env-file "$ENVFILE" -f docker-compose.prod.yml config --format json)
ext=$(docker compose --env-file "$ENVFILE" -f docker-compose.prod.external-data.yml config --format json)

strip='del(.depends_on, .environment.DATABASE_URL, .environment.WORLD_DATABASE_URL, .environment.S3_ENDPOINT, .environment.S3_BUCKET, .environment.S3_REGION)'

status=0
for svc in web control-plane migrate worker cloudflared; do
  a=$(jq --arg s "$svc" ".services[\$s] | $strip" <<<"$base")
  b=$(jq --arg s "$svc" ".services[\$s] | $strip" <<<"$ext")
  if [ "$a" != "$b" ]; then
    echo "DRIFT in service '$svc' (docker-compose.prod.yml vs docker-compose.prod.external-data.yml):" >&2
    diff <(echo "$a") <(echo "$b") >&2 || true
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "prod compose variants consistent"
fi
exit "$status"
