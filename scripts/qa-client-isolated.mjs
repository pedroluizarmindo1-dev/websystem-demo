#!/usr/bin/env node
// Two-client end-to-end isolation: isolated filesystem, SQLite and HTTP server.
import {mkdtempSync,cpSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,scryptSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),dir=mkdtempSync(join(tmpdir(),'ws-clients-'));
let child;
const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
try{
 cpSync(join(root,'api'),join(dir,'api'),{recursive:true});
 mkdirSync(join(dir,'data'));symlinkSync(join(root,'node_modules'),join(dir,'node_modules'),'dir');
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(join(dir,'data','websystem.sqlite'));
 db.exec((await import('node:fs')).readFileSync(join(dir,'api/schema.sql'),'utf8'));
 db.exec('PRAGMA busy_timeout=15000');
 // Client schema is created by server on startup; seed after startup.
 const port=String(36000+Math.floor(Math.random()*1000)),origin='https://unlockertools.tech',base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[join(dir,'api/server.mjs')],{cwd:dir,env:{...process.env,HOST:'127.0.0.1',PORT:port,APP_ORIGIN:origin,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false'},stdio:'pipe'});
 let ready=false;
 for(let i=0;i<45;i++){try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break}}catch{}await delay(250)}
 assert(ready,'API failed to start');
 const users=[];
 for(const i of [1,2]){
  const salt=randomBytes(24).toString('hex'),password='client-password-test-'+i+'-long',hash=scryptSync(password,salt,64).toString('hex');
  const id=Number(db.prepare('INSERT INTO client_users(email,display_name,password_salt,password_hash) VALUES (?,?,?,?)').run('client'+i+'@example.test','QA Client '+i,salt,hash).lastInsertRowid);
  const order=Number(db.prepare('INSERT INTO orders(customer_name,device_model) VALUES (?,?)').run('QA Client '+i,'Test Device '+i).lastInsertRowid);
  db.prepare('INSERT INTO client_order_links(client_id,order_id) VALUES (?,?)').run(id,order);
  users.push({email:'client'+i+'@example.test',password,id,order});
 }
 async function request(path,{cookie='',method='GET',body}={}){
  const r=await fetch(base+'/api/client'+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 }
 for(const u of users){const r=await request('/login',{method:'POST',body:{email:u.email,password:u.password}});assert(r.status===200,'Client login failed');u.cookie=r.cookie}
 const [a,b]=users;
 for(const u of users){
  const r=await request('/orders',{cookie:u.cookie});assert(r.status===200&&r.data.length===1&&r.data[0].id===u.order,'Client order leakage');
 }
 // Order history must be persisted and visible only to the linked client.
 db.prepare('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)').run('orders',a.order,'created','');
 db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run('em_processamento',a.order);
 db.prepare('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)').run('orders',a.order,'status','em_processamento');
 let history=await request('/orders/'+a.order+'/history',{cookie:a.cookie});
 assert(history.status===200&&history.data.history.length===2&&history.data.history[1].status==='em_processamento','Order status history not returned');
 assert(history.data.history_complete===false,'Historical coverage must not be overstated');
 history=await request('/orders/'+a.order+'/history',{cookie:b.cookie});
 assert(history.status===404,'Cross-client order history disclosed');
 history=await request('/orders/'+a.order+'/history');
 assert(history.status===401,'Unauthenticated order history disclosed');
 let r=await request('/tickets',{cookie:a.cookie,method:'POST',body:{subject:'Unauthorized order',description:'Isolation test',order_id:b.order}});
 assert(r.status===403,'Cross-client ticket linked to another client order');
 r=await request('/tickets',{cookie:a.cookie,method:'POST',body:{subject:'Own order',description:'Test support request',order_id:a.order}});
 assert(r.status===201,'Own support ticket creation failed');
 const ticketId=r.data.id;
 r=await request('/tickets',{cookie:b.cookie});assert(r.status===200&&r.data.length===0,'Cross-client ticket disclosure');
 r=await request('/tickets',{cookie:a.cookie});assert(r.status===200&&r.data.some(t=>t.id===ticketId),'Own ticket missing');
 r=await request('/logout',{cookie:a.cookie,method:'POST'});assert(r.status===200,'Logout failed');
 r=await request('/me',{cookie:a.cookie});assert(r.status===401,'Session not revoked on logout');
 console.log('CLIENT_ISOLATION_PASS: login, orders, status history, cross-account access, tickets, logout');
}finally{if(child){child.kill('SIGTERM');await delay(150)}rmSync(dir,{recursive:true,force:true})}