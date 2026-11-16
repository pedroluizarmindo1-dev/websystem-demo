#!/usr/bin/env node
// No production data or SMTP credentials: fail-closed admin IP, auth rate limit, and registration safety.
import {mkdtempSync,cpSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'ws-security-')),port=String(37000+Math.floor(Math.random()*1000));
let child;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});mkdirSync(join(temp,'data'));symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:'https://unlockertools.tech',ADMIN_ALLOWED_IPS:'',SMTP_HOST:'',WALLET_REQUESTS_ENABLED:'false'},stdio:'pipe'});
 const base='http://127.0.0.1:'+port,origin='https://unlockertools.tech';let ready=false;
 for(let i=0;i<50;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}if(!ready)throw Error('Server did not start');
 const check=async(path,expected,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(r.status!==expected)throw Error(path+' expected '+expected+' got '+r.status);return r};
 await check('/admin/',503);await check('/api/auth/me',503);
 await check('/api/client/register',503,{email:'example@example.com',display_name:'Test',password:'safe-password-123456789'});
 await check('/api/client/forgot-password',503,{email:'example@example.com'});
 await check('/api/client/reset-password',400,{token:'invalid',password:'safe-password-123456789'});
 for(let i=0;i<5;i++)await check('/api/client/login',401,{email:'no-account@example.com',password:'wrong-password'});
 await check('/api/client/login',429,{email:'no-account@example.com',password:'wrong-password'});
 console.log('SECURITY_ISOLATED_PASS: admin fail-closed, SMTP fail-closed, reset token validation, auth IP lockout');
}finally{if(child){child.kill();await delay(150)}rmSync(temp,{recursive:true,force:true})}
