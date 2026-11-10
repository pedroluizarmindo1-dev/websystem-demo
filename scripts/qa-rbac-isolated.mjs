#!/usr/bin/env node
// Isolated role-based authorization regression: never touches repository/production SQLite.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'websystem-rbac-'));
const port=String(35000+Math.floor(Math.random()*1000));
let child;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});
 mkdirSync(join(temp,'data'));
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const auth=await import('file://'+join(temp,'api/auth.mjs'));
 const {authdb,hashPassword,issue}=auth;
 const h=hashPassword('isolated-test-password-1234');
 const u=authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('qa-nonadmin',h.salt,h.hash,'viewer');
 const token=issue({id:Number(u.lastInsertRowid)});
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:'https://unlockertools.tech',WALLET_REQUESTS_ENABLED:'false'},stdio:'pipe'});
 const base='http://127.0.0.1:'+port;
 let ready=false;
 for(let i=0;i<40;i++){try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break}}catch{}await delay(250)}
 if(!ready)throw Error('Isolated API did not start');
 const cases=[
  ['GET','/api/security/events'],['GET','/api/orders'],['GET','/api/remote-sessions'],
  ['GET','/api/audit-logs'],['GET','/api/admin/client-area/mail/status'],
  ['POST','/api/telegram/sync'],['POST','/api/services'],['PUT','/api/settings'],
  ['POST','/api/orders'],['PATCH','/api/orders/1'],['POST','/api/remote-sessions']
 ];
 for(const [method,path] of cases){
  const r=await fetch(base+path,{method,headers:{Cookie:'ws_session='+token,Origin:'https://unlockertools.tech','Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'}),signal:AbortSignal.timeout(3000)});
  if(r.status!==403)throw Error(method+' '+path+' expected 403 got '+r.status);
  console.log('RBAC_DENIED',method,path,r.status);
 }
 console.log('RBAC_ISOLATED_PASS');
}finally{if(child){child.kill('SIGTERM');await delay(150)}rmSync(temp,{recursive:true,force:true})}
