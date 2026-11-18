#!/usr/bin/env bash
# Starts every service in the hosted container. If any one exits, the container
# exits too, so Fly restarts the whole machine instead of running half the app.
set -u
cd /app

# A database uploaded as /data/import.sqlite replaces the current one before
# anything opens it (see the README's hosting section).
if [ -f /data/import.sqlite ]; then
  rm -f "$PAYMENTS_CHAIN_DB" "$PAYMENTS_CHAIN_DB-wal" "$PAYMENTS_CHAIN_DB-shm"
  mv /data/import.sqlite "$PAYMENTS_CHAIN_DB"
  echo "Imported database into $PAYMENTS_CHAIN_DB"
fi

(cd apps/facilitator && exec node src/index.ts) &
(cd apps/merchant && exec node src/index.ts) &
(cd apps/receipts && exec node src/index.ts) &
(cd apps/web && exec pnpm exec vite preview --host 0.0.0.0 --port 8080) &

wait -n
echo "A service exited; stopping the container so Fly restarts it." >&2
exit 1
