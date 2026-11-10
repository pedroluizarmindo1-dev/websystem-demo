#!/usr/bin/env bash
set -Eeuo pipefail
APP=/opt/websystem
BACKUP=/usr/local/sbin/websystem-backup
echo "PREFLIGHT_START $(date -u +%FT%TZ)"
test "$(hostname)" = UNLOCKERTOOLS || echo 'Hostname differs from short expected name; verify server identity manually'
test -d "$APP" && test -f "$APP/compose.yaml" || { echo 'Missing WebSystem checkout'; exit 1; }
command -v docker >/dev/null
cd "$APP"
docker compose config -q
docker compose ps --status running --services | grep -qx websystem || { echo 'WebSystem container not running'; exit 1; }
docker compose exec -T websystem node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
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
test -x "$BACKUP" || { echo 'Backup utility missing or not executable'; exit 1; }
"$BACKUP"
echo 'BACKUP_COMMAND_OK'
echo 'PREFLIGHT_PASS'
