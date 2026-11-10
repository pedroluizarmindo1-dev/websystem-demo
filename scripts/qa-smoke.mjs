#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const port=String(32000+Math.floor(Math.random()*1500));
const child=spawn(process.execPath,['api/server.mjs'],{env:{...process.env,PORT:port,HOST:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',APP_ORIGIN:'https://unlockertools.tech'},stdio:'pipe'});
let stderr='';child.stderr.on('data',d=>stderr+=String(d).slice(-800));
const base='http://127.0.0.1:'+port;
try{
 let ready=false;
 for(let i=0;i<35;i++){if(child.exitCode!==null)break;try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break}}catch{}await delay(250)}
 if(!ready)throw Error('API startup failed '+stderr.slice(-400));
 for(const [path,expected] of [['/',200],['/services',200],['/client/',200],['/client/wallet',200],['/admin/',200],['/api/health',200],['/api/client/wallet',401],['/api/admin/wallet/deposits',401],['/route-that-does-not-exist',404]]){
  const r=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(3000)});
  if(r.status!==expected)throw Error(path+' expected '+expected+' got '+r.status);
  console.log(path,r.status);
 }
 // Ensure private client and administrative resources reject unauthenticated users.
 for(const path of ['/api/auth/me','/api/client/me','/api/client/orders','/api/client/tickets','/api/admin/client-area/mail/status']){
  const r=await fetch(base+path,{signal:AbortSignal.timeout(3000)});
  if(r.status!==401)throw Error(path+' must reject unauthenticated requests, got '+r.status);
  console.log('AUTH_REQUIRED',path,r.status);
 }
 // Origin/CSRF guard must reject state-changing requests without a trusted Origin.
 for(const path of ['/api/auth/login','/api/client/login','/api/client/tickets','/api/client/wallet/deposits']){
  const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});
  if(r.status!==403)throw Error(path+' missing Origin must be rejected, got '+r.status);
  console.log('ORIGIN_REQUIRED',path,r.status);
 }
}finally{child.kill('SIGTERM')}
