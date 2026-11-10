#!/usr/bin/env bash
set -Eeuo pipefail
# Hostinger UNLOCKERTOOLS only. Requires privileged deploy account.
APP=/opt/websystem
ARCHIVE=/tmp/websystem-release.tar.gz
BACKUP_CMD=/usr/local/sbin/websystem-backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGE=/opt/websystem-stage-$STAMP
PREVIOUS=/opt/websystem-previous-$STAMP
LOG=/tmp/websystem-deploy-$STAMP.log
exec > >(tee -a "$LOG") 2>&1
echo "Starting guarded WebSystem deploy at $STAMP"
test "$(id -u)" -eq 0 || { echo 'Requires root privileges'; exit 1; }
test -d "$APP" && test -f "$APP/compose.yaml" && test -f "$ARCHIVE" || { echo 'Missing app or release archive'; exit 1; }
test -x "$BACKUP_CMD" || { echo 'Verified backup executable unavailable'; exit 1; }
command -v docker >/dev/null && command -v tar >/dev/null
cd "$APP"
docker compose config -q
docker compose ps --status running --services | grep -qx websystem || { echo 'Current service not running; aborting'; exit 1; }
# A backup tool must exit successfully and independently verify both databases.
"$BACKUP_CMD"
echo 'Backup command completed; preserving existing Docker volume'
mkdir -m 700 "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE"
test -f "$STAGE/compose.yaml" && test -f "$STAGE/Dockerfile" && test -f "$STAGE/api/server.mjs"
# Preserve server-local overrides and untracked configuration.
if test -f "$APP/compose.override.yaml"; then cp -a "$APP/compose.override.yaml" "$STAGE/"; fi
# Keep production data on the existing named Docker volume, never in release archive.
cp -a "$APP" "$PREVIOUS"
cleanup() { rm -f "$ARCHIVE"; }
trap cleanup EXIT
rollback() {
  echo 'Deployment failed; restoring previous application files'
  rsync -a --delete --exclude=compose.override.yaml --exclude=data --exclude=backups "$PREVIOUS/" "$APP/" || true
  cd "$APP"
  docker compose up -d --build --no-deps websystem || true
  echo 'Rollback of application files attempted; database migrations require manual verification'
}
trap rollback ERR
command -v rsync >/dev/null || { echo 'rsync required'; exit 1; }
rsync -a --delete --exclude=compose.override.yaml --exclude=data --exclude=backups "$STAGE/" "$APP/"
cd "$APP"
docker compose config -q
docker compose up -d --build --no-deps websystem
healthy=0
for i in $(seq 1 30); do
  if docker compose exec -T websystem node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 3
done
test "$healthy" -eq 1 || { echo 'New container failed health checks'; exit 1; }
trap - ERR
echo "DEPLOY_SUCCESS $STAMP"
