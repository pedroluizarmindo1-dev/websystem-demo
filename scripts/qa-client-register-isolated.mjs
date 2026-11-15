#!/usr/bin/env node
// Isolated regression for the customer sign-up and mail flows: uniform answers (no account enumeration), answers that
// do not wait for the mail server, and the admin outbox going through the shared mail abstraction.
// A local fake SMTP server (STARTTLS with a throw-away self-signed certificate made by openssl) receives the messages:
// nothing leaves this machine. Throw-away copy of api/ with its own SQLite files; fictitious addresses only.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'ws-register-')),origin='https://unlockertools.tech';
const check=(ok,msg)=>{if(!ok)throw Error('CLIENT_REGISTER_FAIL: '+msg)};
const ssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{encoding:'utf8'});
if(ssl.error||ssl.status!==0){rmSync(temp,{recursive:true,force:true});console.error('CLIENT_REGISTER_BLOCKED: openssl is required to create the throw-away certificate');process.exit(2)}

// Minimal SMTP sink: EHLO, STARTTLS, AUTH PLAIN, MAIL/RCPT/DATA. `delayMs` slows the final answer, `reject` refuses senders.
function fakeSmtp(key,cert){
 const state={mails:[],delayMs:0,reject:false},context=tls.createSecureContext({key,cert});
 const session=(sock,secure)=>{
  let buffer='',inData=false,to=[];
  const send=line=>{if(!sock.destroyed)sock.write(line+'\r\n')};
  sock.on('error',()=>{});
  sock.on('data',chunk=>{
   buffer+=chunk.toString('latin1');
   for(;;){
    if(inData){
     const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;
     const raw=buffer.slice(0,end);buffer=buffer.slice(end+5);inData=false;
     const mail={to,raw,subject:(/^Subject: (.*)$/mi.exec(raw)||[])[1]||''};to=[];
     setTimeout(()=>{state.mails.push(mail);send('250 queued')},state.delayMs);
     continue;
    }
    const nl=buffer.indexOf('\r\n');if(nl<0)return;
    const line=buffer.slice(0,nl),cmd=line.toUpperCase();buffer=buffer.slice(nl+2);
    if(cmd.startsWith('EHLO')||cmd.startsWith('HELO')){send('250-fake.local');send(secure?'250 AUTH PLAIN':'250 STARTTLS')}
    else if(cmd==='STARTTLS'&&!secure){send('220 ready');sock.removeAllListeners('data');session(new tls.TLSSocket(sock,{isServer:true,secureContext:context}),true);return}
    else if(cmd.startsWith('AUTH PLAIN'))send('235 authenticated');
    else if(cmd.startsWith('MAIL FROM:'))send(state.reject?'451 temporarily unavailable':'250 ok');
    else if(cmd.startsWith('RCPT TO:')){to.push(line.slice(8).replace(/[<>]/g,'').trim().toLowerCase());send('250 ok')}
    else if(cmd==='DATA'){inData=true;send('354 end with a dot')}
    else if(cmd==='QUIT'){send('221 bye');sock.end()}
    else send('250 ok');
   }
  });
 };
 const server=net.createServer(sock=>{sock.write('220 fake.local ESMTP\r\n');session(sock,false)});
 return new Promise(done=>server.listen(0,'127.0.0.1',()=>done({server,state,port:server.address().port})));
}

let child,smtp;
try{
 smtp=await fakeSmtp(readFileSync(join(temp,'key.pem')),readFileSync(join(temp,'cert.pem')));
 const mails=smtp.state.mails;
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword('isolated-register-admin-password-123');
 const adminToken=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('register-admin',h.salt,h.hash,'admin').lastInsertRowid)});
 const port=String(39000+Math.floor(Math.random()*900));
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:origin,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false',
  HOSTINGER_MAIL_API_TOKEN:'',SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),SMTP_USER:'qa-user',SMTP_PASS:'qa-password',MAIL_FROM:'UNLOCKER Tools <no-reply@example.test>',NODE_EXTRA_CA_CERTS:join(temp,'cert.pem')},stdio:'pipe'});
 let output='';child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{output+=d});
 const direct=new http.Agent();
 // `ip` becomes X-Forwarded-For: the loopback peer is a trusted proxy, so each value is a separate client for the limiters.
 const call=(path,{body,ip,token}={})=>new Promise((done,failed)=>{
  const payload=body?JSON.stringify(body):null,headers={Origin:origin};
  if(payload){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(payload)}
  if(ip)headers['X-Forwarded-For']=ip;if(token)headers.Cookie='ws_session='+token;
  const started=Date.now();
  const req=http.request({host:'127.0.0.1',port,path,method:payload?'POST':'GET',headers,agent:direct},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>{text+=c});
   res.on('end',()=>{let data=null;try{data=JSON.parse(text)}catch{}done({status:res.statusCode,data,text,ms:Date.now()-started})});
  });
  req.on('error',failed);req.end(payload||undefined);
 });
 let ready=false;for(let i=0;i<60;i++){try{if((await call('/api/health')).status===200){ready=true;break}}catch{}await delay(200)}
 check(ready,'server did not start: '+output.slice(-300));
 const waitMails=async n=>{for(let i=0;i<80&&mails.length<n;i++)await delay(100);check(mails.length===n,'expected '+n+' messages in the SMTP sink, got '+mails.length)};
 const same=(a,b)=>a.status===b.status&&a.text===b.text;
 const db=()=>{const d=new DatabaseSync(join(temp,'data','websystem.sqlite'));d.exec('PRAGMA busy_timeout=5000');return d};
 const person=(email,password,name='Cliente QA')=>({email,display_name:name,password,country_code:'BR',phone_e164:'+5511999990000',preferred_locale:'pt-BR'});
 const register=(email,password,ip,name)=>call('/api/client/register',{body:person(email,password,name),ip});
 const login=(email,password,ip)=>call('/api/client/login',{body:{email,password},ip});
 const A='ana@example.test',P1='first-password-0123456789',P2='other-password-9876543210';

 // ---- sign-up: new, pending and already active addresses are indistinguishable from the outside
 const fresh=await register(A,P1,'198.51.100.1');
 check(fresh.status===202&&fresh.data?.ok===true&&typeof fresh.data.message==='string','new address -> '+fresh.status+' '+fresh.text);
 await waitMails(1);check(mails[0].to.join()===A&&mails[0].subject==='Confirme sua conta UNLOCKER Tools','verification message for the new address');
 const pending=await register(A,P1,'198.51.100.2');
 check(same(pending,fresh),'pending address must answer exactly like a new one: '+pending.status+' '+pending.text);
 await waitMails(2);check(mails[1].subject==='Confirme sua conta UNLOCKER Tools','pending address gets a fresh verification link');
 let d=db();d.prepare('UPDATE client_users SET enabled=1 WHERE email=?').run(A);
 const before=d.prepare('SELECT display_name,password_salt,password_hash,enabled FROM client_users WHERE email=?').get(A);
 const tokensBefore=d.prepare('SELECT COUNT(*) AS n FROM client_auth_tokens').get().n;d.close();
 check((await login(A,P1,'198.51.100.3')).status===200,'activated account can sign in');
 const existing=await register(A,P2,'198.51.100.4','Outro Nome');
 check(same(existing,fresh),'active address must answer exactly like a new one: '+existing.status+' '+existing.text);
 await waitMails(3);
 check(mails[2].to.join()===A&&mails[2].subject==='Tentativa de cadastro na UNLOCKER Tools'&&!/token=/.test(mails[2].raw.replace(/=\r\n/g,'')),'owner of the active account is notified, without any link carrying a token');
 d=db();
 const after=d.prepare('SELECT display_name,password_salt,password_hash,enabled FROM client_users WHERE email=?').get(A);
 check(JSON.stringify(after)===JSON.stringify(before),'an active account must not be modified by a sign-up attempt');
 check(d.prepare('SELECT COUNT(*) AS n FROM client_auth_tokens').get().n===tokensBefore,'no new token for an active account');
 check(d.prepare("SELECT COUNT(*) AS n FROM client_security_events WHERE action='client_register' AND outcome='existing_account'").get().n===1,'attempt recorded as a security event');
 d.close();
 check((await login(A,P1,'198.51.100.5')).status===200&&(await login(A,P2,'198.51.100.6')).status===401,'the original password still works and the attempted one does not');

 // ---- mail server failure: same answer for a new and for an active address
 smtp.state.reject=true;
 const failNew=await register('bruno@example.test',P1,'198.51.100.7'),failExisting=await register(A,P2,'198.51.100.8');
 smtp.state.reject=false;
 check(failNew.status===503&&same(failNew,failExisting),'mail failure must look the same for new and active addresses: '+failNew.status+' / '+failExisting.status);
 check(mails.length===3,'no message accepted while the mail server refuses');

 // ---- password recovery and verification resend: generic answers that do not wait for the mail server
 smtp.state.delayMs=2500;
 const forgotKnown=await call('/api/client/forgot-password',{body:{email:A},ip:'198.51.100.9'});
 const forgotUnknown=await call('/api/client/forgot-password',{body:{email:'nobody@example.test'},ip:'198.51.100.10'});
 check(forgotKnown.status===200&&same(forgotKnown,forgotUnknown),'password recovery must answer the same for known and unknown addresses');
 check(forgotKnown.ms<1200&&mails.length===3,'password recovery must not wait for the mail server (took '+forgotKnown.ms+' ms)');
 const resendPending=await call('/api/client/resend-verification',{body:{email:'bruno@example.test'},ip:'198.51.100.11'});
 const resendUnknown=await call('/api/client/resend-verification',{body:{email:'nobody@example.test'},ip:'198.51.100.12'});
 check(resendPending.status===200&&same(resendPending,resendUnknown),'verification resend must answer the same for pending and unknown addresses');
 check(resendPending.ms<1200,'verification resend must not wait for the mail server (took '+resendPending.ms+' ms)');
 await waitMails(5);smtp.state.delayMs=0;
 check(mails.slice(3).map(m=>m.to.join()).sort().join()===[A,'bruno@example.test'].sort().join(),'recovery and resend messages are still delivered, only to existing accounts');

 // ---- admin outbox goes through the shared mail abstraction (works for SMTP here, and for the Hostinger Mail API)
 const admin=(path,body)=>call('/api/admin/client-area'+path,{body,token:adminToken});
 check((await admin('/mail/queue',{recipient:'carla@example.test',subject:'Aviso QA',body:'Mensagem de teste'})).status===201,'queue a message');
 const sent=await admin('/mail/send-pending',{});
 check(sent.status===200&&sent.data.sent===1&&sent.data.failed===0,'send pending -> '+sent.text);
 await waitMails(6);check(mails[5].to.join()==='carla@example.test'&&mails[5].subject==='Aviso QA','queued message delivered');
 smtp.state.reject=true;
 check((await admin('/mail/queue',{recipient:'dora@example.test',subject:'Aviso QA 2',body:'Mensagem de teste'})).status===201,'queue a second message');
 const failed=await admin('/mail/send-pending',{});
 check(failed.status===200&&failed.data.sent===0&&failed.data.failed===1,'failed delivery is counted and kept pending -> '+failed.text);
 smtp.state.reject=false;
 const retried=await admin('/mail/send-pending',{});
 check(retried.data.sent===1&&retried.data.failed===0,'pending message is delivered on retry -> '+retried.text);
 await waitMails(7);
 check(!output.includes(P1)&&!output.includes(P2),'passwords must never reach the server log');
 console.log('CLIENT_REGISTER_PASS: uniform sign-up answers, active account untouched and notified, uniform mail failure, recovery and resend not tied to the mail server, admin outbox via shared mail abstraction');
}finally{
 if(child){child.kill('SIGTERM');await delay(150)}
 if(smtp)smtp.server.close();
 rmSync(temp,{recursive:true,force:true});
}
