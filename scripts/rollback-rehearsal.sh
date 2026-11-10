#!/usr/bin/env bash
set -Eeuo pipefail
# Non-production rollback rehearsal. No SSH, Docker, or production DB access.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/current/api" "$tmp/previous/api" "$tmp/new/api" "$tmp/current/data"
printf 'old-version\n' > "$tmp/current/api/server.mjs"
printf 'original-secret\n' > "$tmp/current/.env"
printf 'original-data\n' > "$tmp/current/data/auth.sqlite"
printf 'old-version\n' > "$tmp/previous/api/server.mjs"
printf 'new-version\n' > "$tmp/new/api/server.mjs"
# Simulate deploying the new release.
cp "$tmp/new/api/server.mjs" "$tmp/current/api/server.mjs"
test "$(cat "$tmp/current/api/server.mjs")" = new-version
# Simulate a failed health check and the guarded application-file rollback.
cp "$tmp/previous/api/server.mjs" "$tmp/current/api/server.mjs"
test "$(cat "$tmp/current/api/server.mjs")" = old-version
test "$(cat "$tmp/current/.env")" = original-secret
test "$(cat "$tmp/current/data/auth.sqlite")" = original-data
echo 'ROLLBACK_REHEARSAL_PASS: old application restored; secret and data untouched'
