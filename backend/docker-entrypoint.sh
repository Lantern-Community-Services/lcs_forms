#!/bin/sh
set -e

# Database migrations are a release step, never part of starting the API.
#
#   RUN_MIGRATIONS=true         apply prisma/migrations to DATABASE_URL
#                               (`prisma migrate deploy`), then exit. A
#                               one-off run (docker compose's `migrate`).
#   RUN_MIGRATIONS=then-start   the same, then start the API; if the
#                               migration fails the container exits instead.
#                               The deploy pipeline sets this on App Service,
#                               the only place that reaches the database, and
#                               waits for /api/health/deploy to report the new
#                               commit and migration before clearing it.
#
# Anything else starts the API against a schema that's already up to date.
case "${RUN_MIGRATIONS:-false}" in
  true)
    echo "[entrypoint] prisma migrate deploy"
    exec ./node_modules/.bin/prisma migrate deploy
    ;;
  then-start)
    echo "[entrypoint] prisma migrate deploy, then start"
    ./node_modules/.bin/prisma migrate deploy
    ;;
esac

exec "$@"
