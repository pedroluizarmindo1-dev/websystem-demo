import {mkdtempSync,cpSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'ws-history-'));let child;
const check=(x,msg)=>{if(!x)throw Error(msg)};
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword('integration-admin-password-123456');
 const user=authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('history-admin',h.salt,h.hash,'admin');
 const token=issue({id:Number(user.lastInsertRowid)});
 const port=String(38000+Math.floor(Math.random()*900));const base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:'https://unlockertools.tech',ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false'},stdio:'pipe'});
 let ready=false;for(let i=0;i<50;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}check(ready,'startup');
 async function req(path,method='GET',body,auth=true){const r=await fetch(base+path,{method,headers:{Origin:'https://unlockertools.tech','Content-Type':'application/json',...(auth?{Cookie:'ws_session='+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}}
 let r=await req('/api/orders','POST',{customer_name:'QA History',device_model:'Test Device'});check(r.status===201,'create '+JSON.stringify(r));const id=r.data.id;
 r=await req('/api/orders/'+id+'/status-history');check(r.status===200&&r.data.length===1&&r.data[0].new_status==='pendente','initial event');
 r=await req('/api/orders/'+id,'PATCH',{status:'em_processamento'});check(r.status===200&&r.data.changed===true,'status update');
 r=await req('/api/orders/'+id,'PATCH',{status:'em_processamento'});check(r.status===200&&r.data.changed===false,'idempotence');
 r=await req('/api/orders/'+id+'/status-history');check(r.status===200&&r.data.length===2&&r.data[1].new_status==='em_processamento','history count');
 r=await req('/api/orders/'+id+'/status-history','GET',undefined,false);check(r.status===401,'unauthenticated access');
 r=await req('/api/orders/999999/status-history');check(r.status===404,'not found');
 console.log('ORDER_HISTORY_INTEGRATION_PASS: creation, status, idempotence, auth, 404');
}finally{if(child){child.kill('SIGTERM');await delay(150)}rmSync(temp,{recursive:true,force:true})}