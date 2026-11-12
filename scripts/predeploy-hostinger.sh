#!/usr/bin/env bash
set -Eeuo pipefail
APP=/opt/websystem
BACKUP=/usr/local/sbin/websystem-backup
trap 'rc=$?; echo "PREFLIGHT_FAILED step=${STEP:-unknown} exit=$rc line=$LINENO" >&2' ERR
STEP=initial
echo "PREFLIGHT_START $(date -u +%FT%TZ)"
STEP=verify-host-identity
test "$(hostname)" = UNLOCKERTOOLS || echo 'Hostname differs from short expected name; verify server identity manually'
STEP=verify-app-directory
test -d "$APP" && test -f "$APP/compose.yaml" || { echo 'Missing WebSystem checkout'; exit 1; }
STEP=verify-docker-cli
command -v docker >/dev/null
cd "$APP"
STEP=verify-compose-config
docker compose config -q
STEP=verify-running-service
docker compose ps --status running --services | grep -qx websystem || { echo 'WebSystem container not running'; exit 1; }
STEP=verify-container-health
docker compose exec -T websystem node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STEP=verify-sqlite-integrity
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
test -x STEP=execute-backup
"$BACKUP" || { echo 'Backup utility missing or not executable'; exit 1; }
"$BACKUP"
echo 'BACKUP_COMMAND_OK'
echo 'PREFLIGHT_PASS'
