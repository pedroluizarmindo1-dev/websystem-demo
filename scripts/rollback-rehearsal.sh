#!/usr/bin/env bash
set -Eeuo pipefail
# Exercise the actual rsync flags used for rollback, without Docker or production data.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/current/api" "$tmp/previous/api" "$tmp/current/data"
printf 'old-version\n' > "$tmp/previous/api/server.mjs"
printf 'new-version\n' > "$tmp/current/api/server.mjs"
printf 'original-secret\n' > "$tmp/current/.env"
printf 'original-data\n' > "$tmp/current/data/auth.sqlite"
rsync -a --exclude=compose.override.yaml --exclude=data --exclude=backups --exclude=.env --exclude=.env.production --exclude=.git --exclude=node_modules --exclude=dist "$tmp/previous/" "$tmp/current/"
test "$(cat "$tmp/current/api/server.mjs")" = old-version
test "$(cat "$tmp/current/.env")" = original-secret
test "$(cat "$tmp/current/data/auth.sqlite")" = original-data
echo 'ROLLBACK_REHEARSAL_PASS: rsync restored application; secret and data untouched'
