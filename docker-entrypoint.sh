#!/bin/sh
# docker-entrypoint.sh
#
# Container startup: apply pending DB migrations, then start the server as PID 1
# (via exec) so SIGTERM from `docker stop` / compose reaches Node and triggers
# the graceful shutdown in bootstrap/shutdown.ts.
#
# NODE_MAX_OLD_SPACE_MB tunes the V8 heap cap to the container memory limit.
# Default 400 MB suits a ~512 MB container; raise it on a larger VPS.
set -e

echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy

HEAP="${NODE_MAX_OLD_SPACE_MB:-400}"
echo "[entrypoint] starting server (max-old-space-size=${HEAP}MB)..."
exec node --max-old-space-size="${HEAP}" dist/server.js
