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

# WHY THIS OVERRIDES REDIS_URL:
# .env.production's REDIS_URL points at an external Redis host, because that
# same file is also used for non-compose deployments (e.g. Render) where Redis
# isn't self-hosted. In THIS docker-compose stack, Redis runs as the `redis`
# service instead, so the external value would be wrong here. Rather than
# maintain a second env file (or rely on Compose ${VAR} substitution, which
# only reads a top-level .env — not env_file: contents) just to point at the
# compose-local Redis, we re-derive REDIS_URL at container start from
# REDIS_PASSWORD, which .env.production already defines for the external host's
# credentials. This exported value overrides whatever env_file loaded, and is
# what queue/redis.ts actually connects with. REDIS_HOST/REDIS_PORT default to
# the compose service name/port but can be overridden for non-compose runs
# (e.g. bare `docker run` against a differently-named Redis host).
if [ -n "$REDIS_PASSWORD" ]; then
  REDIS_HOST="${REDIS_HOST:-redis}"
  REDIS_PORT="${REDIS_PORT:-6379}"
  export REDIS_URL="redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}"
fi

echo "[entrypoint] applying database migrations..."
#npx prisma migrate deploy
echo "Skipping migrations"

HEAP="${NODE_MAX_OLD_SPACE_MB:-400}"
echo "[entrypoint] starting server (max-old-space-size=${HEAP}MB)..."
exec node --max-old-space-size="${HEAP}" dist/server.js
