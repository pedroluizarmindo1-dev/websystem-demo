#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,symlinkSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'ws-dhru-idempotency-'));
let child,stderr='';
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});
 mkdirSync(join(temp,'data'));symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));
 db.exec(readFileSync(join(temp,'api','schema.sql'),'utf8'));
 db.prepare("INSERT INTO services(name,category,price_usd) VALUES ('Test','gsm',10)").run();
 const token='ws_'+randomBytes(32).toString('hex');
 const keyHash=createHash('sha256').update(token).digest('hex');
 db.prepare("INSERT INTO reseller_keys(label,token_hash,allowed_ip) VALUES ('Reseller',?,'127.0.0.1')").run(keyHash);
 const port=String(39000+Math.floor(Math.random()*1000)),base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,HOST:'127.0.0.1',PORT:port,APP_ORIGIN:'https://unlockertools.tech',ADMIN_ALLOWED_IPS:'127.0.0.1',TRUST_PROXY:'loopback'},stdio:'pipe'});
 child.stderr.on('data',d=>{stderr+=d.toString()});
 let ready=false;
 for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break}}catch{}await delay(250)}
 assert.ok(ready,'Isolated server ready: '+stderr.slice(-1000));
 const place=async(key,imei='123456789012345')=>{
  const r=await fetch(base+'/api/dhru',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://unlockertools.tech','x-api-key':token,...(key?{'idempotency-key':key}:{})},body:JSON.stringify({action:'placeimeiorder',serviceid:1,imei})});
  return {status:r.status,body:await r.json()};
 };
 const first=await place('request-00000001');
 assert.equal(first.status,202,JSON.stringify(first));
 const repeat=await place('request-00000001');
 assert.equal(repeat.status,202,JSON.stringify(repeat));
 assert.equal(repeat.body.SUCCESS[0].ID,first.body.SUCCESS[0].ID,'Retry must return same order');
 const collision=await place('request-00000001','987654321098765');
 assert.equal(collision.status,409,'Key reuse for different payload rejected');
 const next=await place('request-00000002');
 assert.equal(next.status,202);
 assert.notEqual(next.body.SUCCESS[0].ID,first.body.SUCCESS[0].ID);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,2,'No duplicate order on replay');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM order_status_history').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reseller_order_requests').get().n,2);
 console.log('DHRU_IDEMPOTENCY_PASS: replay, collision, new key, transactional order and history');
 db.close();
}finally{child?.kill('SIGTERM');await delay(150);rmSync(temp,{recursive:true,force:true})}
