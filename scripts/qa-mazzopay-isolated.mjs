#!/usr/bin/env node
// Isolated regression for automatic PIX top-ups (api/mazzopay.mjs) against a local MazzoPay simulator.
// No real API, no real money: MAZZOPAY_BASE_URL points to a mock server started here, with fictitious keys and data.
// Covers: limits, idempotent creation, cross-client isolation, webhook signature/timestamp/replay, single credit,
// amount mismatch, provider errors (4xx and transient 5xx + retry), pending limit, event reconciliation, admin block.
import {createServer} from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyMazzoSignature} from '../api/mazzopay.mjs';

const root=resolve(import.meta.dirname,'..');
const KEY='mzk_test_isolated_fake_key_not_real',SECRET='whsec_isolated_fake_secret';
const check=(ok,msg)=>{if(!ok)throw Error('MAZZOPAY_FAIL: '+msg);console.log('ok -',msg)};

// ---------- MazzoPay simulator ----------
const mock={charges:new Map(),byKey:new Map(),events:[],seq:0,creates:0,down:false,authFailures:0};
const addEvent=(tipo,c)=>mock.events.push({id:randomUUID(),tipo,criadoEm:new Date().toISOString(),modo:'producao',sequencia:++mock.seq*3,dados:{cobranca:{...c}}});
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','X-Request-Id':randomUUID()});res.end(JSON.stringify(body))};
const err=(res,status,codigo,mensagem,detalhes)=>send(res,status,{erro:{codigo,mensagem,requestId:randomUUID(),...(detalhes?{detalhes}:{})}});
const sim=createServer((req,res)=>{let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
 const url=new URL(req.url,'http://x');
 if(req.headers.authorization!=='Bearer '+KEY){mock.authFailures++;return err(res,401,'NAO_AUTENTICADO','Chave inválida')}
 if(req.method==='POST'&&url.pathname==='/v1/cobrancas'){
  const idem=req.headers['idempotency-key'];if(!idem)return err(res,400,'IDEMPOTENCY_KEY_OBRIGATORIA','Obrigatória');
  const body=JSON.parse(raw||'{}');
  if(mock.down)return err(res,503,'PROVEDOR_INDISPONIVEL','Indisponível');
  if(body.valor===99900)return err(res,422,'LIMITE_EXCEDIDO','Limite diário atingido');
  if(mock.byKey.has(idem)){res.setHeader('Idempotent-Replayed','true');return send(res,201,mock.charges.get(mock.byKey.get(idem)))}
  mock.creates++;const id=randomUUID();
  const c={objeto:'cobranca',id,numero:mock.creates,status:'pendente',valor:body.valor,valorBase:body.valor,taxa:50,valorLiquido:body.valor-50,referencia:body.referencia,descricao:body.descricao,nomeCliente:body.nomeCliente||null,metadados:body.metadados||{},pix:{copiaECola:'00020101021226SIMULADO'+id.slice(0,8),expiraEm:new Date(Date.now()+30*60000).toISOString(),qrCodeBase64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='},pagamento:null,criadaEm:new Date().toISOString(),modo:'producao'};
  mock.charges.set(id,c);mock.byKey.set(idem,id);return send(res,201,c);
 }
 const m=url.pathname.match(/^\/v1\/cobrancas\/([0-9a-f-]+)$/);
 if(req.method==='GET'&&m){const c=mock.charges.get(m[1]);return c?send(res,200,c):err(res,404,'NAO_ENCONTRADO','Não encontrada')}
 if(req.method==='GET'&&url.pathname==='/v1/eventos'){const after=Number(url.searchParams.get('depoisDe')||0);const list=mock.events.filter(e=>e.sequencia>after).slice(0,Number(url.searchParams.get('limite')||50));return send(res,200,{dados:list,proximo:null})}
 if(req.method==='GET'&&url.pathname==='/v1/conta')return send(res,200,{objeto:'conta',modo:'producao',fase:'iniciante',chave:{permissoes:['cobrancas:ler','cobrancas:criar']},limites:{cobrancaMaxPorTx:100000}});
 err(res,404,'NAO_ENCONTRADO','Rota simulada inexistente');
})});
const pay=(id,valor)=>{const c=mock.charges.get(id);c.status='paga';if(valor!=null){c.valor=valor;c.valorBase=valor}c.pagamento={pagoEm:new Date().toISOString(),e2eId:'E2E'+id.slice(0,8),pagador:{nome:'Pagador Fictício',documento:'***',banco:'Banco Teste'}};return c};

let child,temp;
try{
 await new Promise(r=>sim.listen(0,'127.0.0.1',r));const simPort=sim.address().port;
 // ---------- unit: signature ----------
 const body=Buffer.from('{"id":"x"}'),t=Math.floor(Date.now()/1000),sig=createHmac('sha256',SECRET).update(`${t}.`).update(body).digest('hex');
 check(verifyMazzoSignature(body,`t=${t},v1=${sig}`,SECRET),'valid signature accepted');
 check(verifyMazzoSignature(body,`t=${t},v1=${'0'.repeat(64)},v1=${sig}`,SECRET),'second v1 (secret rotation) accepted');
 check(!verifyMazzoSignature(Buffer.from('{"id":"y"}'),`t=${t},v1=${sig}`,SECRET),'tampered body rejected');
 check(!verifyMazzoSignature(body,`t=${t-301},v1=${createHmac('sha256',SECRET).update(`${t-301}.`).update(body).digest('hex')}`,SECRET),'stale timestamp rejected');
 check(!verifyMazzoSignature(body,`t=${t},v1=${sig}`,'whsec_other'),'wrong secret rejected');

 // ---------- isolated app ----------
 temp=mkdtempSync(join(tmpdir(),'ws-mazzo-'));
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));
 const withUi=existsSync(join(root,'dist','cliente.html'));if(withUi)cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const port=String(38100+Math.floor(Math.random()*300)),base='http://127.0.0.1:'+port;
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword('isolated-mazzopay-admin-123');
 const admin=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('mazzo-admin',h.salt,h.hash,'admin').lastInsertRowid)});
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,NODE_ENV:'test',PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',DEMO_MODE:'false',COOKIE_SECURE:'false',WALLET_REQUESTS_ENABLED:'false',
  MAZZOPAY_ENABLED:'true',MAZZOPAY_API_KEY:KEY,MAZZOPAY_WEBHOOK_SECRET:SECRET,MAZZOPAY_BASE_URL:`http://127.0.0.1:${simPort}/v1`},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(150)}
 check(ready,'isolated server started');
 const req=async(method,path,{body,cookie,headers={}}={})=>{const r=await fetch(base+path,{method,headers:{Origin:base,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});let data=null;try{data=await r.json()}catch{}return {status:r.status,data}};
 const adminCookie='ws_session='+admin;
 const makeClient=async(email)=>{const u=await req('POST','/api/admin/client-area/users',{body:{email,display_name:'Cliente '+email.split('@')[0],password:'isolated-client-password-123'},cookie:adminCookie});check(u.status<300,'client created '+email);
  const r=await fetch(base+'/api/client/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password:'isolated-client-password-123'})});check(r.ok,'client login '+email);return r.headers.get('set-cookie').split(';')[0]};
 const A=await makeClient('pix.a@example.test'),B=await makeClient('pix.b@example.test');
 const hook=async(ev,{badSig=false,ts}={})=>{const raw=JSON.stringify(ev),tt=ts??Math.floor(Date.now()/1000);const s=createHmac('sha256',badSig?'whsec_wrong':SECRET).update(`${tt}.${raw}`).digest('hex');const r=await fetch(base+'/api/webhooks/mazzopay',{method:'POST',headers:{'Content-Type':'application/json','Mazzo-Assinatura':`t=${tt},v1=${s}`,'Mazzo-Evento':ev.tipo,'Mazzo-Evento-Id':ev.id,'Mazzo-Tentativa':'1'},body:raw});return {status:r.status,data:await r.json().catch(()=>null)}};
 const balance=async c=>(await req('GET','/api/client/wallet/',{cookie:c})).data.balance_cents;

 const cfg=await req('GET','/api/client/wallet/pix/config',{cookie:A});
 check(cfg.status===200&&cfg.data.enabled&&cfg.data.min_cents===1000&&cfg.data.max_cents===100000,'config exposes limits without secrets');
 check(!JSON.stringify(cfg.data).includes('mzk_')&&!JSON.stringify(cfg.data).includes('whsec_'),'no secret in config');
 check((await req('GET','/api/client/wallet/pix/config')).status===401,'config requires client login');
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:999}})).status===400,'below minimum rejected');
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:100001}})).status===400,'above maximum rejected');
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:'5000'}})).status===400,'non-integer amount rejected');
 const noOrigin=await fetch(base+'/api/client/wallet/pix/charges',{method:'POST',headers:{'Content-Type':'application/json',Cookie:A},body:JSON.stringify({amount_cents:5000})});
 check(noOrigin.status===403,'cross-origin creation blocked');

 // idempotent creation
 const k1='qa-key-'+randomUUID().slice(0,8);
 const c1=await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:5000},headers:{'Idempotency-Key':k1}});
 check(c1.status===201&&c1.data.status==='pendente'&&c1.data.copia_e_cola&&c1.data.qr_code.startsWith('data:image/png;base64,'),'charge created with QR code and copy-paste');
 const c1b=await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:5000},headers:{'Idempotency-Key':k1}});
 check(c1b.status===200&&c1b.data.id===c1.data.id&&mock.creates===1,'same client key returns the same charge (1 provider call)');
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:6000},headers:{'Idempotency-Key':k1}})).status===409,'same key with another amount rejected');
 const remote1=[...mock.charges.values()][0];
 check(remote1.referencia==='ut-dep-'+c1.data.deposit_id&&mock.byKey.has('ut-dep-'+c1.data.deposit_id),'provider receives referencia and Idempotency-Key ut-dep-<deposit>');
 check(mock.authFailures===0,'provider authenticated with server-side key');

 // isolation
 check((await req('GET','/api/client/wallet/pix/charges/'+c1.data.id,{cookie:B})).status===404,'client B cannot read client A charge');
 check((await req('GET','/api/client/wallet/pix/charges',{cookie:B})).data.length===0,'client B list is empty');

 // webhook security
 const evPaid={id:randomUUID(),tipo:'cobranca.paga',criadoEm:new Date().toISOString(),modo:'producao',dados:{cobranca:{id:remote1.id,status:'paga',valor:5000}}};
 check((await hook(evPaid,{badSig:true})).status===401,'webhook with invalid signature rejected');
 check((await hook(evPaid,{ts:Math.floor(Date.now()/1000)-400})).status===401,'webhook with stale timestamp rejected');
 const early=await hook(evPaid);
 check(early.status===503&&await balance(A)===0,'"paga" payload not credited while the provider still reports pending (503 for retry)');
 pay(remote1.id);
 const w1=await hook(evPaid);const evPaid2=evPaid;
 check(w1.status===200&&w1.data.outcome==='credited'&&await balance(A)===5000,'signed webhook + provider confirmation credits once');
 check((await hook(evPaid2)).data.duplicate===true,'replayed event id ignored');
 const w3=await hook({...evPaid,id:randomUUID()});
 check(w3.data.outcome==='already_credited'&&await balance(A)===5000,'new event for paid charge does not credit twice');
 const st=await req('GET','/api/client/wallet/statement',{cookie:A});
 check(st.data.transactions.length===1&&st.data.transactions[0].delta_cents===5000,'statement shows a single credit');
 const view=await req('GET','/api/client/wallet/pix/charges/'+c1.data.id,{cookie:A});
 check(view.data.status==='paga'&&view.data.copia_e_cola===null&&view.data.qr_code===null,'paid charge hides payment code');
 const ping=await hook({id:randomUUID(),tipo:'teste.ping',criadoEm:new Date().toISOString(),modo:'producao',dados:{mensagem:'ok'}});
 check(ping.status===200&&ping.data.outcome==='ping','teste.ping acknowledged');

 // admin cannot manually settle an automatic deposit
 const rev=await req('POST','/api/admin/wallet/deposits/'+c1.data.deposit_id+'/review',{cookie:adminCookie,body:{decision:'approved',verification:'tentativa de aprovação manual em teste'}});
 check(rev.status===409||rev.status===503,'manual review blocked for automatic PIX deposit ('+rev.status+')');

 // amount mismatch
 const c2=await req('POST','/api/client/wallet/pix/charges',{cookie:A,body:{amount_cents:3000}});
 const remote2=mock.charges.get([...mock.charges.keys()].pop());pay(remote2.id,100);
 const w4=await hook({id:randomUUID(),tipo:'cobranca.paga',criadoEm:new Date().toISOString(),modo:'producao',dados:{cobranca:{id:remote2.id}}});
 check(w4.data.outcome==='amount_mismatch'&&await balance(A)===5000,'amount mismatch not credited');
 check((await req('GET','/api/client/wallet/pix/charges/'+c2.data.id,{cookie:A})).data.status==='em_analise','mismatched charge moved to review');

 // provider errors
 const e422=await req('POST','/api/client/wallet/pix/charges',{cookie:B,body:{amount_cents:99900}});
 check(e422.status===400&&e422.data.code==='LIMITE_EXCEDIDO','provider limit error surfaced as 400');
 mock.down=true;const k2='qa-key-'+randomUUID().slice(0,8);
 const e503=await req('POST','/api/client/wallet/pix/charges',{cookie:B,body:{amount_cents:2000},headers:{'Idempotency-Key':k2}});
 check(e503.status===502,'transient provider failure returns 502');
 mock.down=false;
 const retry=await req('POST','/api/client/wallet/pix/charges',{cookie:B,body:{amount_cents:2000},headers:{'Idempotency-Key':k2}});
 check(retry.status===200&&retry.data.status==='pendente','retry with the same key completes the charge');

 // pending limit (3 per client)
 await req('POST','/api/client/wallet/pix/charges',{cookie:B,body:{amount_cents:1500}});
 await req('POST','/api/client/wallet/pix/charges',{cookie:B,body:{amount_cents:1600}});
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:B,body:{amount_cents:1700}})).status===429,'4th pending charge blocked');
 // concurrent submissions with the same client key resolve to one charge
 const C=await makeClient('pix.c@example.test'),k3='qa-race-'+randomUUID().slice(0,8),createsBefore=mock.creates;
 const race=await Promise.all([1,2,3].map(()=>req('POST','/api/client/wallet/pix/charges',{cookie:C,body:{amount_cents:2500},headers:{'Idempotency-Key':k3}})));
 check(race.every(r=>r.status===200||r.status===201)&&new Set(race.map(r=>r.data.id)).size===1&&mock.creates===createsBefore+1,'concurrent duplicate submissions return the same charge');
 // charges stuck in "criando" stop blocking new top-ups after 30 minutes
 mock.down=true;for(const v of [1100,1200]){const r=await req('POST','/api/client/wallet/pix/charges',{cookie:C,body:{amount_cents:v}});check(r.status===502,'stuck charge '+v+' while provider is down')}mock.down=false;
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:C,body:{amount_cents:1300}})).status===429,'recent stuck charges still count toward the pending limit');
 {const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));db.exec('PRAGMA busy_timeout=5000');db.prepare("UPDATE mazzopay_charges SET created_at=datetime('now','-31 minutes') WHERE status='criando'").run();db.close()}
 check((await req('POST','/api/client/wallet/pix/charges',{cookie:C,body:{amount_cents:1300}})).status===201,'old stuck charges no longer block the client');

 // reconciliation through /eventos: one paid (missed webhook) and one expired
 const listB=(await req('GET','/api/client/wallet/pix/charges',{cookie:B})).data.filter(x=>x.status==='pendente');
 const remoteOf=id=>[...mock.charges.values()].find(c=>c.referencia==='ut-dep-'+listB.find(x=>x.id===id).deposit_id);
 const paidB=remoteOf(listB[0].id),expB=remoteOf(listB[1].id);
 addEvent('cobranca.paga',pay(paidB.id));expB.status='expirada';addEvent('cobranca.expirada',expB);
 const rec=await req('POST','/api/admin/wallet/pix/reconcile',{cookie:adminCookie});
 check(rec.status===200&&rec.data.credited===1,'reconciliation credits the missed payment');
 check(await balance(B)===paidB.valor,'client B balance updated by reconciliation');
 const rec2=await req('POST','/api/admin/wallet/pix/reconcile',{cookie:adminCookie});
 check(rec2.data.credited===0&&await balance(B)===paidB.valor,'second reconciliation does not credit again');
 check((await req('GET','/api/client/wallet/pix/charges/'+listB[1].id,{cookie:B})).data.status==='expirada','expired charge recorded');
 const deps=(await req('GET','/api/admin/wallet/deposits',{cookie:adminCookie})).data;
 check(deps.filter(d=>String(d.reference).startsWith('mazzopay:')&&d.status==='approved').length===2,'admin sees 2 approved automatic deposits');

 // admin endpoints
 const sts=await req('GET','/api/admin/wallet/pix/status',{cookie:adminCookie});
 check(sts.status===200&&sts.data.enabled&&sts.data.webhook_secret_configured&&sts.data.account.permissoes.includes('cobrancas:criar')&&sts.data.attention>=1,'admin status shows account, permissions and items needing attention');
 check(!JSON.stringify(sts.data).includes(KEY),'admin status does not expose the API key');
 check((await req('GET','/api/admin/wallet/pix/charges',{cookie:A})).status!==200,'client cannot reach admin PIX routes');
 check(!stderr.includes(KEY)&&!stderr.includes(SECRET),'server logs contain no key or webhook secret');
 // ---------- browser: client area top-up (desktop and phone) ----------
 const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(x=>x&&existsSync(x));
 if(withUi&&chrome){
  const {default:puppeteer}=await import('puppeteer-core');const shots=join(root,'reports','mazzopay-ui');mkdirSync(shots,{recursive:true});
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--lang=pt-BR']});
  try{for(const [name,width,height,mobile,preset,expected] of [['desktop',1440,900,false,'2000',2000],['phone',390,844,true,'5000',5000]]){
   const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(30000);const problems=[];
   page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))problems.push(m.text())});
   await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','pt-BR')}catch{}});await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile});
   await page.goto(base+'/client/',{waitUntil:'domcontentloaded'});await page.waitForSelector('#login');
   await page.type('#login [name=email]','pix.a@example.test');await page.type('#login [name=password]','isolated-client-password-123');await page.click('#login button');
   await page.waitForFunction(()=>document.body.classList.contains('ca-signed-in')&&!document.getElementById('walletTopup').hidden);
   const before=await balance(A);
   await page.click('#walletTopup');await page.waitForSelector('#pixPanel:not([hidden]) #pixForm:not([hidden])');
   check(await page.$eval('#pixLimits',e=>/R\$\s?10,00/.test(e.textContent)&&/R\$\s?1\.000,00/.test(e.textContent)),name+': limits shown');
   await page.click(`[data-pix-amount="${preset}"]`);await page.click('#pixSubmit');
   await page.waitForSelector('#pixCharge:not([hidden]) #pixQr:not([hidden])');
   check(await page.$eval('#pixQr',i=>i.complete&&i.naturalWidth>0&&i.src.startsWith('data:image/png;base64,')),name+': QR code image rendered');
   check(await page.$eval('#pixCode',t=>t.value.startsWith('00020101')),name+': copy-paste code shown');
   check(await page.$eval('#pixStatus',e=>e.textContent.includes('Aguardando')),name+': waiting status');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': no horizontal overflow');
   await page.screenshot({path:join(shots,name+'-pending.png'),fullPage:true});
   const mine=(await req('GET','/api/client/wallet/pix/charges',{cookie:A})).data[0];
   const remote=[...mock.charges.values()].find(c=>c.referencia==='ut-dep-'+mine.deposit_id);check(!!remote&&remote.valor===expected&&remote.status==='pendente',name+': provider charge created for '+expected);pay(remote.id);
   await page.waitForFunction(()=>/Pagamento confirmado/.test(document.getElementById('pixStatus').textContent),{timeout:40000});
   await page.waitForFunction(exp=>document.getElementById('walletPanelBalance').textContent.replace(/\D/g,'')===String(exp),{timeout:15000},before+expected);
   check(await balance(A)===before+expected,name+': balance credited once after payment');
   check(await page.$eval('#pixQr',i=>i.hidden),name+': QR hidden after payment');
   await page.screenshot({path:join(shots,name+'-paid.png'),fullPage:true});
   check(!problems.length,name+': no JS/CSP errors '+problems.join(' | '));await ctx.close()}}
  finally{await browser.close()}
 }else console.log('skip - browser phase (dist/ or Chrome missing)');
 console.log('MAZZOPAY_PASS: limits, idempotency, isolation, webhook signature/replay, single credit, mismatch, provider errors, pending limit, reconciliation, admin'+(withUi?', client-area top-up UI':''));
}finally{
 if(child){child.kill('SIGTERM');await delay(150)}
 sim.close();
 if(temp)rmSync(temp,{recursive:true,force:true});
}
