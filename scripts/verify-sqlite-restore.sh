#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/websystem
docker compose ps --status running --services | grep -qx websystem
# Isolated restore rehearsal: create online SQLite snapshots, reopen each in a
# separate temporary directory, verify integrity and compare table definitions.
# No production database is replaced or modified.
docker compose exec -T websystem node --input-type=module -e '
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const tmp=mkdtempSync(join(tmpdir(),"websystem-restore-test-"));
try{
 for(const name of ["websystem.sqlite","auth.sqlite"]){
  const source=new DatabaseSync("/app/data/"+name,{readOnly:true});
  const file=join(tmp,name);
  try{await backup(source,file)}finally{source.close()}
  const original=new DatabaseSync("/app/data/"+name,{readOnly:true});
  const restored=new DatabaseSync(file,{readOnly:true});
  try{
   const integrity=restored.prepare("PRAGMA integrity_check").get()?.integrity_check;
   if(integrity!=="ok")throw Error(name+" restore integrity failed: "+integrity);
   const sql="SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE ? ORDER BY type,name";
   const before=original.prepare(sql).all("sqlite_%");
   const after=restored.prepare(sql).all("sqlite_%");
   if(JSON.stringify(before)!==JSON.stringify(after))throw Error(name+" schema mismatch");
   console.log("ISOLATED_RESTORE_OK",name,"objects",after.length);
  }finally{original.close();restored.close()}
 }
}finally{rmSync(tmp,{recursive:true,force:true})}
'
echo RESTORE_REHEARSAL_PASS
