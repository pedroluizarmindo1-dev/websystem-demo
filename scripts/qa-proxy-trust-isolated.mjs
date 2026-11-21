#!/usr/bin/env node
// Isolated regression for client-IP resolution behind a reverse proxy (TRUST_PROXY, api/proxy-trust.mjs).
// A reverse proxy in front of a Docker-published port is seen by the application as a private, non-loopback peer.
// That is emulated here without Docker by calling the server through this machine's own non-loopback address.
// Throw-away copies of api/ with their own SQLite files; no production data, supplier or payment contact.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {resolveTrustProxy} from '../api/proxy-trust.mjs';

const root=resolve(import.meta.dirname,'..'),origin='https://unlockertools.tech';
const check=(ok,msg)=>{if(!ok)throw Error('PROXY_TRUST_FAIL: '+msg)};
const addresses=Object.values(networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal).map(i=>i.address);
const isPrivate=a=>/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const peer=addresses.find(isPrivate)||addresses[0];
if(!peer){console.error('PROXY_TRUST_BLOCKED: no non-loopback IPv4 address on this machine to emulate a reverse-proxy peer');process.exit(2)}
const ADMIN_IP='203.0.113.7',RESELLER_IP='203.0.113.50',OTHER_IP='198.51.100.9';
const temps=[],children=[],direct=new http.Agent();
async function start(extraEnv,{expectExit=false}={}){
 const temp=mkdtempSync(join(tmpdir(),'ws-proxytrust-'));temps.push(temp);
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const port=String(38000+Math.floor(Math.random()*900));
 const env={...process.env,PORT:port,HOST:'0.0.0.0',APP_ORIGIN:origin,ADMIN_ALLOWED_IPS:ADMIN_IP,WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false',...extraEnv};
 if(!('TRUST_PROXY' in extraEnv))delete env.TRUST_PROXY;
 const child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env,stdio:'pipe'});children.push(child);
 const server={temp,port,child,output:''};
 child.stdout.on('data',d=>{server.output+=d});child.stderr.on('data',d=>{server.output+=d});
 if(expectExit){
  server.code=await Promise.race([new Promise(r=>child.on('exit',r)),delay(8000).then(()=>'still running')]);
  return server;
 }
 // CI runners may take longer than 12 seconds to initialize SQLite and dependencies.
 const deadline=Date.now()+30000;let ready=false;
 while(Date.now()<deadline&&child.exitCode===null){
  try{if((await call(server,'loopback','/api/health')).status===200){ready=true;break}}catch{}
  await delay(250);
 }
 check(ready,'server did not start: '+server.output.slice(-300));
 return server;
}
// via: 'loopback' (proxy in the same network namespace) or 'peer' (private non-loopback proxy, as behind Docker)
async function call(server,via,path,{xff,method='GET',body,headers={}}={}){
 const h={...headers};if(xff)h['X-Forwarded-For']=xff;if(body){h['Content-Type']='application/json';h.Origin=origin}
 const payload=body?JSON.stringify(body):null;if(payload)h['Content-Length']=Buffer.byteLength(payload);
 // Own agent: a direct connection even when this machine routes fetch/global agents through an HTTP proxy.
 return new Promise((done,failed)=>{
  const req=http.request({host:via==='peer'?peer:'127.0.0.1',port:server.port,path,method,headers:h,agent:direct},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>{text+=c});
   res.on('end',()=>{let data=null;try{data=JSON.parse(text)}catch{}done({status:res.statusCode,data})});
  });
  req.on('error',failed);req.end(payload||undefined);
 });
}
const gate=async(server,via,xff)=>(await call(server,via,'/api/auth/me',{xff})).status; // 401 = IP gate passed, 404 = refused

try{
 // ---- parser: safe values accepted, trust-everything values refused
 check(JSON.stringify(resolveTrustProxy(undefined))==='["loopback"]'&&JSON.stringify(resolveTrustProxy(''))==='["loopback"]','default is loopback');
 check(JSON.stringify(resolveTrustProxy(' Loopback , UniqueLocal '))==='["loopback","uniquelocal"]','keywords are normalised');
 for(const ok of ['172.18.0.1','172.18.0.0/16','10.0.0.0/8','::1','fc00::/7','2001:db8::1','2001:db8::/32','loopback,linklocal,10.1.2.3'])check(Array.isArray(resolveTrustProxy(ok)),'should accept '+ok);
 for(const bad of ['true','false','*','1','2','yes','all','0.0.0.0/0','::/0','10.0.0.0/7','2000::/3','999.1.1.1','1.2.3.4/33','::::','1:2:3','1:2:3:4:5:6:7:8:9','2001:db8::/129',',','loopback,,uniquelocal','loopback,all']){
  let refused=false;try{resolveTrustProxy(bad)}catch{refused=true}
  check(refused,'TRUST_PROXY "'+bad+'" must be refused');
 }

 // ---- default (loopback only): a loopback proxy is believed, any other peer cannot forge an address
 const d=await start({});
 check(await gate(d,'loopback',ADMIN_IP)===401,'default: loopback proxy forwarding the allowed admin IP must pass the gate');
 check(await gate(d,'loopback',OTHER_IP)===404&&await gate(d,'loopback')===404,'default: other or missing forwarded IP must be refused');
 check(await gate(d,'peer',ADMIN_IP)===404,'default: X-Forwarded-For from a non-loopback peer must be ignored');
 await gate(d,'peer',ADMIN_IP);await delay(100);
 const warnings=d.output.split('TRUST_PROXY: X-Forwarded-For sent by').length-1;
 check(warnings===(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(peer)?1:0),'ignored-header warning must be logged exactly once for a private peer, got '+warnings);
 check(!d.output.includes(ADMIN_IP),'the warning must not log forwarded addresses');

 // ---- reverse proxy on a private peer, trusted explicitly: real client addresses everywhere
 const variants=[['loopback,'+peer,'explicit address']];if(isPrivate(peer))variants.push(['loopback,uniquelocal','compose default']);
 for(const [value,label] of variants){
  const s=await start({TRUST_PROXY:value});
  check(await gate(s,'peer',ADMIN_IP)===401,label+': allowed admin IP forwarded by the trusted proxy must pass');
  check(await gate(s,'peer',OTHER_IP)===404&&await gate(s,'peer')===404,label+': other or missing forwarded IP must be refused');
  check(await gate(s,'peer',ADMIN_IP+', '+OTHER_IP)===404,label+': a client-supplied prefix must not override the address appended by the proxy');
  check(await gate(s,'peer',OTHER_IP+', '+ADMIN_IP)===401,label+': the address appended by the proxy is the one used');
  check(!s.output.includes('TRUST_PROXY: X-Forwarded-For sent by'),label+': no warning when the proxy is trusted');
  // login lockout is per client, not shared by everyone behind the proxy
  const login=xff=>call(s,'peer','/api/client/login',{xff,method:'POST',body:{email:'nobody@example.test',password:'wrong-password-000000'}});
  for(let i=0;i<5;i++)check((await login('198.51.100.21')).status===401,label+': failed login '+(i+1));
  check((await login('198.51.100.21')).status===429,label+': sixth failure from the same client is locked out');
  check((await login('198.51.100.22')).status===401,label+': another client behind the same proxy is not locked out');
  const sdb=new DatabaseSync(join(s.temp,'data','websystem.sqlite'),{readOnly:true});sdb.exec('PRAGMA busy_timeout=5000');
  const ips=new Set(sdb.prepare('SELECT ip FROM client_security_events').all().map(r=>r.ip));sdb.close();
  check(ips.has('198.51.100.21')&&ips.has('198.51.100.22')&&!ips.has(peer),label+': security events must record client addresses: '+[...ips].join(','));
  // reseller API IP allow-list follows the same client address
  const {authdb,hashPassword,issue}=await import('file://'+join(s.temp,'api/auth.mjs'));
  const h=hashPassword('isolated-proxy-trust-password-123');
  const admin=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('proxy-admin',h.salt,h.hash,'admin').lastInsertRowid)});
  const key=await call(s,'loopback','/api/reseller/keys',{xff:ADMIN_IP,method:'POST',body:{label:'QA Reseller',allowed_ip:RESELLER_IP,tier:'lojista'},headers:{Cookie:'ws_session='+admin}});
  check(key.status===201&&key.data?.token,'reseller key creation -> '+key.status);
  const dhru=xff=>call(s,'peer','/api/dhru?action=accountinfo',{xff,headers:{'X-API-Key':key.data.token}});
  check((await dhru(RESELLER_IP)).status===200,label+': reseller calling from its allowed IP must be accepted');
  check((await dhru(OTHER_IP)).status===403&&(await dhru()).status===403,label+': reseller key from another address must be refused');
 }

 // ---- unsafe configuration: the server must refuse to start
 const bad=await start({TRUST_PROXY:'true'},{expectExit:true});
 check(typeof bad.code==='number'&&bad.code!==0&&bad.output.includes('TRUST_PROXY'),'TRUST_PROXY=true must stop the server at startup, got '+bad.code);
 console.log('PROXY_TRUST_PASS: parser, loopback default, private proxy peer ('+peer+'), forged header ignored, per-client lockout, event IPs, reseller IP allow-list, unsafe value refused');
}finally{
 for(const c of children)if(c.exitCode===null)c.kill('SIGTERM');
 await delay(200);
 for(const t of temps)rmSync(t,{recursive:true,force:true});
}
