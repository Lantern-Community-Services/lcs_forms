#!/bin/sh
set -e

# Database migrations are a release step, never part of starting the API.
#
#   RUN_MIGRATIONS=true   apply prisma/migrations to DATABASE_URL
#                         (`prisma migrate deploy`), then exit. The pipeline
#                         runs the image once like this before it swaps in
#                         the new version.
#
# Anything else starts the API against a schema that's already up to date.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  exec ./node_modules/.bin/prisma migrate deploy
fi

exec "$@"
