#!/usr/bin/env node
// Independent, disposable security regression for the AuxiliarCodeAgent admin API.
// No production DB, supplier API, payment endpoint or shared workspace is touched.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'..');
const tmp=mkdtempSync(join(tmpdir(),'ws-admin-security-'));
const port=String(40000+Math.floor(Math.random()*12000));
const base='http://127.0.0.1:'+port;
const allowed='https://unlockertools.tech';
let server;
const assert=(ok,message)=>{if(!ok)throw Error('SECURITY_GATE_FAIL: '+message)};
try {
  cpSync(join(root,'api'),join(tmp,'api'),{recursive:true});
  mkdirSync(join(tmp,'data'));
  symlinkSync(join(root,'node_modules'),join(tmp,'node_modules'),'dir');
  const {authdb,hashPassword,issue}=await import('file://'+join(tmp,'api/auth.mjs'));
  const tokenFor=(name,role)=>{
    const hash=hashPassword('isolated-security-gate-only-password');
    const row=authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)')
      .run(name,hash.salt,hash.hash,role);
    return issue({id:Number(row.lastInsertRowid)});
  };
  const admin=tokenFor('security-admin','admin');
  const viewer=tokenFor('security-viewer','viewer');
  server=spawn(process.execPath,[join(tmp,'api/server.mjs')],{
    cwd:tmp,
    env:{...process.env,HOST:'127.0.0.1',PORT:port,APP_ORIGIN:allowed,
      ADMIN_ALLOWED_IPS:'127.0.0.1',DEMO_MODE:'false',WALLET_REQUESTS_ENABLED:'false'},
    stdio:'pipe'
  });
  let ready=false;
  for(let i=0;i<60;i++){
    try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}
    await delay(200);
  }
  assert(ready,'isolated API did not start');
  const routes=['/api/admin/ops/orders','/api/admin/ops/orders.csv',
    '/api/admin/ops/summary','/api/admin/ops/client-drafts','/api/admin/ops/audit'];
  for(const route of routes){
    const request=async(token,origin=allowed,method='GET')=>{
      const headers={Origin:origin};
      if(token)headers.Cookie='ws_session='+token;
      return fetch(base+route,{method,headers,redirect:'manual'});
    };
    const anonymous=await request(null);
    assert([401,403,404].includes(anonymous.status),route+' anonymous access '+anonymous.status);
    const unprivileged=await request(viewer);
    assert([403,404].includes(unprivileged.status),route+' viewer access '+unprivileged.status);
    const authorized=await request(admin);
    assert(authorized.status===200,route+' admin access '+authorized.status);
    const crossOrigin=await request(admin,'https://attacker.invalid','POST');
    assert(![200,201,202,204].includes(crossOrigin.status),route+' accepted cross-origin mutation');
    const cors=authorized.headers.get('access-control-allow-origin');
    assert(cors!=='*',route+' wildcard CORS');
  }
  console.log('PASS: five admin routes; anonymous and viewer denied; admin allowed; cross-origin POST denied; no wildcard CORS');
} finally {
  if(server){server.kill('SIGTERM');await delay(250);if(server.exitCode===null)server.kill('SIGKILL')}
  rmSync(tmp,{recursive:true,force:true});
}
