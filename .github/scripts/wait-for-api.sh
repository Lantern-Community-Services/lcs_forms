#!/usr/bin/env bash
# Waits until the api answers /api/health/deploy as the given build with the given
# migration applied, or fails the job.
#
#   wait-for-api.sh <base url> <commit> <migration> [timeout seconds, default 600]
#
# The commit check matters: while App Service starts a new container the old one keeps
# answering, so "the api answers 200" says nothing about which build or schema is live.
set -u
url="$1/api/health/deploy"
commit="$2"
migration="$3"
deadline=$(( $(date +%s) + ${4:-600} ))

echo "waiting for commit $commit with migration $migration at $url"
body=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  body=$(curl -s --max-time 10 "$url" || true)
  got_commit=$(printf '%s' "$body" | jq -r '.commit // empty' 2>/dev/null || true)
  got_migration=$(printf '%s' "$body" | jq -r '.migration // empty' 2>/dev/null || true)
  echo "$(date -u +%H:%M:%S) commit=${got_commit:-?} migration=${got_migration:-?}"
  if [ "$got_commit" = "$commit" ] && [ "$got_migration" = "$migration" ]; then
    echo "api is on $commit with $migration applied"
    exit 0
  fi
  sleep 10
done

echo "::error::api did not report commit $commit with migration $migration in time. Last answer: ${body:-none}"
exit 1
