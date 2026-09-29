#!/bin/sh
set -e

# Bring the database schema up to date before the API starts.
#
# `prisma db push` refuses changes that would lose data (no --accept-data-loss),
# so a bad schema change fails the container instead of dropping a column.
# Once the app is on Azure SQL and you use `prisma migrate`, set
# DB_PUSH_ON_START=false and run `prisma migrate deploy` as a release step.
if [ "${DB_PUSH_ON_START:-true}" = "true" ]; then
  echo "[entrypoint] prisma db push"
  ./node_modules/.bin/prisma db push --skip-generate
fi

exec "$@"
