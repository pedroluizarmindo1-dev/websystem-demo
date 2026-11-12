#!/usr/bin/env bash
set -Eeuo pipefail
APP=/opt/websystem
BACKUP=/usr/local/sbin/websystem-backup
trap 'rc=$?; echo "PREFLIGHT_FAILED step=${STEP:-unknown} exit=$rc line=$LINENO" >&2' ERR
STEP=initial
echo "PREFLIGHT_STEP $STEP"
echo "PREFLIGHT_START $(date -u +%FT%TZ)"
STEP=verify-host-identity
echo "PREFLIGHT_STEP $STEP"
test "$(hostname)" = UNLOCKERTOOLS || echo 'Hostname differs from short expected name; verify server identity manually'
STEP=verify-app-directory
echo "PREFLIGHT_STEP $STEP"
test -d "$APP" && test -f "$APP/compose.yaml" || { echo 'Missing WebSystem checkout'; exit 1; }
STEP=verify-docker-cli
echo "PREFLIGHT_STEP $STEP"
command -v docker >/dev/null
cd "$APP"
STEP=verify-compose-config
echo "PREFLIGHT_STEP $STEP"
docker compose config -q
STEP=verify-running-service
echo "PREFLIGHT_STEP $STEP"
docker compose ps --status running --services | grep -qx websystem || { echo 'WebSystem container not running'; exit 1; }
STEP=verify-container-health
echo "PREFLIGHT_STEP $STEP"
docker compose exec -T websystem node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>{if(!r.ok){console.error('CONTAINER_HEALTH_HTTP_STATUS',r.status);process.exit(1)}console.log('CONTAINER_HEALTH_OK')}).catch(e=>{console.error('CONTAINER_HEALTH_ERROR',e.cause?.code||e.code||e.name);process.exit(1)})"
STEP=verify-sqlite-integrity
echo "PREFLIGHT_STEP $STEP"
docker compose exec -T websystem node --input-type=module -e '
import {DatabaseSync} from "node:sqlite";
for(const name of ["websystem.sqlite","auth.sqlite"]){
 const db=new DatabaseSync("/app/data/"+name,{readOnly:true});
 try{
  const result=db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if(result!=="ok")throw Error(name+" integrity check failed");
  console.log("SQLITE_INTEGRITY_OK",name);
 }finally{db.close()}
}'
STEP=verify-backup-utility
echo "PREFLIGHT_STEP $STEP"
test -x "$BACKUP" || { echo 'Backup utility missing or not executable'; exit 1; }
STEP=execute-backup
echo "PREFLIGHT_STEP $STEP"
"$BACKUP"
echo 'BACKUP_COMMAND_OK'
echo 'PREFLIGHT_PASS'
