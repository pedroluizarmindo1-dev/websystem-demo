#!/usr/bin/env bash
set -Eeuo pipefail
APP=/opt/websystem
ARCHIVE=/tmp/websystem-release.tar.gz
BACKUP_CMD=/usr/local/sbin/websystem-backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGE=/opt/websystem-stage-$STAMP
PREVIOUS=/opt/websystem-previous-$STAMP
LOG=/tmp/websystem-deploy-$STAMP.log
exec > >(tee -a "$LOG") 2>&1
echo "DEPLOY_START $STAMP"
test "$(id -u)" -eq 0 || { echo 'Root required'; exit 1; }
test -f "$APP/compose.yaml" && test -f "$ARCHIVE" && test -x "$BACKUP_CMD"
for cmd in docker tar rsync python3; do command -v "$cmd" >/dev/null; done
cd "$APP"
docker compose config -q
docker compose ps --status running --services | grep -qx websystem
# Abort if real-money wallet requests are enabled in the current container.
docker compose exec -T websystem node -e "if(process.env.WALLET_REQUESTS_ENABLED==='true')process.exit(1)"
"$BACKUP_CMD"
echo 'DEPLOY_BACKUP_OK'
mkdir -m 700 "$STAGE" "$PREVIOUS"
# Validate archive members before extraction: no traversal, absolute paths,
# symlinks, hardlinks, special files, environment secrets or live data.
python3 - "$ARCHIVE" <<'PY'
import pathlib,sys,tarfile
archive=sys.argv[1]
with tarfile.open(archive,"r:gz") as tf:
    members=tf.getmembers()
    if not members:
        raise SystemExit("Empty deployment archive")
    for m in members:
        p=pathlib.PurePosixPath(m.name)
        parts=[part for part in p.parts if part not in (".","")]
        if p.is_absolute() or ".." in parts or not (m.isfile() or m.isdir()):
            raise SystemExit("Unsafe deployment archive member")
        if any(part in (".env",".env.production","data","backups",".git") for part in parts):
            raise SystemExit("Forbidden deployment archive member")
print("DEPLOY_ARCHIVE_VALIDATED")
PY
tar -xzf "$ARCHIVE" -C "$STAGE"
test -f "$STAGE/compose.yaml" && test -f "$STAGE/Dockerfile" && test -f "$STAGE/api/server.mjs"
# Save application files; do not copy live SQLite data or secret configuration.
rsync -a --exclude=.git --exclude=node_modules --exclude=data --exclude=backups --exclude=dist --exclude=.env --exclude=.env.production "$APP/" "$PREVIOUS/"
rollback() {
 echo 'DEPLOY_FAILED: attempting application rollback'
 rsync -a --checksum --delete --exclude=compose.override.yaml --exclude=data --exclude=backups --exclude=.env --exclude=.env.production --exclude=.git --exclude=node_modules --exclude=dist "$PREVIOUS/" "$APP/" || true
 cd "$APP"
 docker compose up -d --build --no-deps websystem || true
 echo 'ROLLBACK_ATTEMPTED: verify health and database manually'
}
trap rollback ERR
# Forward sync preserves server-local files and secrets; rollback removes only newly introduced unprotected application files.
rsync -a --exclude=compose.override.yaml --exclude=data --exclude=backups --exclude=.env --exclude=.env.production --exclude=.git --exclude=node_modules --exclude=dist "$STAGE/" "$APP/"
cd "$APP"
docker compose config -q
docker compose up -d --build --no-deps websystem
healthy=0
for i in $(seq 1 30); do
 if docker compose exec -T websystem node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
 sleep 3
done
test "$healthy" -eq 1
docker compose exec -T websystem node -e "if(process.env.WALLET_REQUESTS_ENABLED==='true')process.exit(1)"
trap - ERR
rm -f "$ARCHIVE"
echo "DEPLOY_SUCCESS $STAMP"
