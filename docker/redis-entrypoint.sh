#!/bin/sh
# docker/redis-entrypoint.sh
#
# Starts redis-server with --requirepass sourced from REDIS_PASSWORD, which is
# injected into this container via `env_file: .env.production` in
# docker-compose.yml. Using a shell entrypoint (instead of Compose's ${VAR}
# substitution in `command:`) means the password is read from the SAME
# .env.production file the app uses — no second .env file, no duplicated secret.
set -e

if [ -z "$REDIS_PASSWORD" ]; then
  echo "[redis-entrypoint] FATAL: REDIS_PASSWORD is not set (check .env.production)" >&2
  exit 1
fi

exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"
