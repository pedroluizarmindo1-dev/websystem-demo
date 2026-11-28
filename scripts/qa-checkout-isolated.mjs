#!/usr/bin/env node
// Isolated regression for paying order drafts with the client wallet (api/checkout.mjs). Fictitious data only:
// isolated SQLite, fake services and exchange rate, wallet credited directly in the test database. No supplier call,
// no PIX, no real money. Covers server-side pricing, insufficient balance, price change, idempotency (same key, other
// key, concurrent), cross-client isolation, draft deletion rules, refunds on reject/refund (exactly once), statement,
// admin details, and the client-area UI (desktop and phone).
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {priceService} from '../api/pricing.mjs';

const root=resolve(import.meta.dirname,'..');
const check=(ok,msg)=>{if(!ok)throw Error('CHECKOUT_FAIL: '+msg);console.log('ok -',msg)};
const IMEI='490154203237518',RATE=5.5;
let child,temp;
try{
 temp=mkdtempSync(join(tmpdir(),'ws-checkout-'));
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const withUi=existsSync(join(root,'dist','cliente.html'));if(withUi)cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});
 const port=String(38400+Math.floor(Math.random()*300)),base='http://127.0.0.1:'+port;
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword('isolated-checkout-admin-123');
 const admin=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('checkout-admin',h.salt,h.hash,'admin').lastInsertRowid)});
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,NODE_ENV:'test',PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',DEMO_MODE:'false',COOKIE_SECURE:'false',WALLET_REQUESTS_ENABLED:'false',MAZZOPAY_ENABLED:'false'},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(150)}
 check(ready,'isolated server started');
 const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 const svc=(name,price,available=1)=>{const ext='imeive:qa-'+randomUUID().slice(0,6);const id=Number(db.prepare("INSERT INTO services(external_id,source,name,category,price_usd,available,eta) VALUES (?,'imeive',?,'QA',?,?,'1-5 min')").run(ext,name,price,available).lastInsertRowid);db.prepare('INSERT INTO supplier_service_fields(external_id,metadata_json) VALUES (?,?)').run(ext,JSON.stringify({serviceType:'IMEI',form_fields:[]}));return {id,name,price_usd:price,category:'QA'}};
 const s1=svc('QA Check Premium IMEI',2),s2=svc('QA Unlock Standard',10),s3=svc('QA Indisponível',3);
 const expected=s=>Math.round(priceService(s,RATE).selling_brl*100);
 const req=async(method,path,{body,cookie,headers={}}={})=>{const r=await fetch(base+path,{method,headers:{Origin:base,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});let data=null;try{data=await r.json()}catch{}return {status:r.status,data}};
 const adminCookie='ws_session='+admin;
 // The server refreshes the real USD/BRL rate once at startup; wait for that attempt so the fictitious rate below
 // stays the latest one for the whole test (otherwise prices could change mid-run).
 for(const until=Date.now()+15000;Date.now()<until;){const r=await req('GET','/api/exchange-rates',{cookie:adminCookie});if(r.data?.latest)break;await delay(300)}
 await delay(500);db.prepare("INSERT INTO exchange_rates(rate,provider) VALUES (?,'qa')").run(RATE);
 check((await req('GET','/api/exchange-rates',{cookie:adminCookie})).data.latest.provider==='qa','fictitious exchange rate is the latest');
 const makeClient=async email=>{const u=await req('POST','/api/admin/client-area/users',{body:{email,display_name:'Cliente '+email.split('@')[0],password:'isolated-client-password-123'},cookie:adminCookie});check(u.status<300,'client created '+email);
  const r=await fetch(base+'/api/client/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password:'isolated-client-password-123'})});check(r.ok,'login '+email);return {cookie:r.headers.get('set-cookie').split(';')[0],id:u.data.id}};
 const A=await makeClient('checkout.a@example.test'),B=await makeClient('checkout.b@example.test');
 const draft=async(c,s)=>{const r=await req('POST','/api/client/order-drafts',{cookie:c.cookie,body:{service_id:s.id,service_name:s.name,device_model:'Serviço IMEI',identifier:IMEI,kind:'api',details:{api_fields:{IMEI}},api_fields:{IMEI}}});check(r.status===201,'draft created for '+s.name+' ('+r.status+')');return r.data.id};
 const credit=(clientId,cents)=>{db.exec('BEGIN IMMEDIATE');const dep=Number(db.prepare("INSERT INTO wallet_deposits(client_id,method,amount_cents,status,reference) VALUES (?,'pix_manual',?,'approved','qa-credit')").run(clientId,cents).lastInsertRowid);db.prepare('INSERT OR IGNORE INTO wallet_accounts(client_id,balance_cents) VALUES (?,0)').run(clientId);db.prepare('UPDATE wallet_accounts SET balance_cents=balance_cents+? WHERE client_id=?').run(cents,clientId);const bal=db.prepare('SELECT balance_cents FROM wallet_accounts WHERE client_id=?').get(clientId).balance_cents;db.prepare('INSERT INTO wallet_ledger(client_id,deposit_id,delta_cents,balance_after_cents) VALUES (?,?,?,?)').run(clientId,dep,cents,bal);db.exec('COMMIT')};
 const balance=async c=>(await req('GET','/api/client/wallet/',{cookie:c.cookie})).data.balance_cents;
 const orderCount=()=>db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

 const d1=await draft(A,s1),d2=await draft(A,s2),d3=await draft(A,s3);
 db.prepare('UPDATE services SET available=0 WHERE id=?').run(s3.id);
 const legacy=Number(db.prepare("INSERT INTO client_order_drafts(client_id,service_name,device_model,identifier) VALUES (?,'Serviço antigo','Modelo','"+IMEI+"')").run(A.id).lastInsertRowid);
 const list=await req('GET','/api/client/checkout/drafts',{cookie:A.cookie});
 const byId=new Map(list.data.drafts.map(x=>[x.id,x]));
 check(list.status===200&&byId.get(d1).price_cents===expected(s1)&&byId.get(d1).payable,'draft priced on the server ('+byId.get(d1).price_cents+' cents)');
 check(byId.get(d3).payable===false&&byId.get(legacy).reason==='no_service','unavailable service and legacy draft are not payable');
 check((await req('GET','/api/client/checkout/drafts')).status===401,'checkout requires client login');

 // insufficient balance: nothing changes
 const before=orderCount();
 const poor=await req('POST','/api/client/checkout/drafts/'+d1,{cookie:A.cookie,body:{expected_amount_cents:expected(s1)}});
 check(poor.status===402&&poor.data.code==='INSUFFICIENT_BALANCE'&&orderCount()===before&&await balance(A)===0,'insufficient balance rejected without order or debit');
 credit(A.id,50000);
 const changed=await req('POST','/api/client/checkout/drafts/'+d1,{cookie:A.cookie,body:{expected_amount_cents:expected(s1)-1}});
 check(changed.status===409&&changed.data.code==='PRICE_CHANGED'&&changed.data.amount_cents===expected(s1),'stale price rejected with the new amount');
 check((await req('POST','/api/client/checkout/drafts/'+d3,{cookie:A.cookie})).status===409,'unavailable service cannot be paid');
 check((await req('POST','/api/client/checkout/drafts/'+legacy,{cookie:A.cookie})).status===409,'legacy draft without service cannot be paid');
 const noOrigin=await fetch(base+'/api/client/checkout/drafts/'+d1,{method:'POST',headers:{'Content-Type':'application/json',Cookie:A.cookie},body:'{}'});
 check(noOrigin.status===403,'cross-origin checkout blocked');
 check((await req('POST','/api/client/checkout/drafts/'+d1,{cookie:B.cookie})).status===404,'client B cannot pay client A draft');

 // success + idempotency
 const k1='qa-co-'+randomUUID().slice(0,8);
 const ok1=await req('POST','/api/client/checkout/drafts/'+d1,{cookie:A.cookie,body:{expected_amount_cents:expected(s1)},headers:{'Idempotency-Key':k1}});
 check(ok1.status===201&&ok1.data.amount_cents===expected(s1)&&ok1.data.balance_cents===50000-expected(s1),'draft paid with wallet balance');
 const o1=db.prepare('SELECT * FROM orders WHERE id=?').get(ok1.data.order_id);
 check(o1.payment_status==='pago'&&o1.status==='pendente'&&o1.service_id===s1.id&&Math.round(o1.price_brl*100)===expected(s1)&&o1.device_model.includes(IMEI),'order created as pending/paid with service, price and identifier');
 check(db.prepare('SELECT COUNT(*) AS n FROM order_status_history WHERE order_id=? AND origin=?').get(o1.id,'client_checkout').n===1,'status history records the checkout');
 const again=await req('POST','/api/client/checkout/drafts/'+d1,{cookie:A.cookie,headers:{'Idempotency-Key':k1}});
 const other=await req('POST','/api/client/checkout/drafts/'+d1,{cookie:A.cookie,headers:{'Idempotency-Key':'qa-co-'+randomUUID().slice(0,8)}});
 check(again.status===200&&other.status===200&&again.data.order_id===o1.id&&other.data.order_id===o1.id&&await balance(A)===50000-expected(s1),'retries (same or new key) return the same order without a second debit');
 check((await req('POST','/api/client/checkout/drafts/'+d2,{cookie:A.cookie,headers:{'Idempotency-Key':k1}})).status===409,'key reused for another draft rejected');
 const race=await Promise.all([1,2,3,4].map(()=>req('POST','/api/client/checkout/drafts/'+d2,{cookie:A.cookie,headers:{'Idempotency-Key':'qa-co-'+randomUUID().slice(0,8)}})));
 const raceIds=new Set(race.filter(r=>r.status<300).map(r=>r.data.order_id));
 check(raceIds.size===1&&race.every(r=>r.status===200||r.status===201)&&await balance(A)===50000-expected(s1)-expected(s2),'concurrent checkouts of one draft create one order and one debit');
 const o2=[...raceIds][0];
 const mine=(await req('GET','/api/client/orders',{cookie:A.cookie})).data.map(o=>o.id);
 check(mine.includes(o1.id)&&mine.includes(o2),'orders visible in the client order list');
 check(!(await req('GET','/api/client/orders',{cookie:B.cookie})).data.some(o=>o.id===o1.id),'client B does not see client A orders');
 const st=(await req('GET','/api/client/wallet/statement',{cookie:A.cookie})).data.transactions;
 check(st.filter(t=>t.type==='order_payment').length===2&&st.some(t=>t.type==='order_payment'&&t.delta_cents===-expected(s1)),'statement shows the order payments');

 // drafts: converted cannot be deleted; others can, only by the owner
 check((await req('DELETE','/api/client/checkout/drafts/'+d1,{cookie:A.cookie})).status===409,'converted draft cannot be deleted');
 check((await req('DELETE','/api/client/checkout/drafts/'+d3,{cookie:B.cookie})).status===404,'client B cannot delete client A draft');
 check((await req('DELETE','/api/client/checkout/drafts/'+d3,{cookie:A.cookie})).status===200,'owner deletes an unconverted draft');

 // refunds through the admin status transitions, exactly once
 const patch=async(id,status)=>req('PATCH','/api/orders/'+id,{cookie:adminCookie,body:{status}});
 const rj=await patch(o1.id,'rejeitado');
 check(rj.status===200&&rj.data.wallet_refund_cents===expected(s1)&&await balance(A)===50000-expected(s2),'rejecting a wallet order refunds the client');
 check(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(o1.id).payment_status==='reembolsado','order payment marked as refunded');
 const rj2=await patch(o1.id,'rejeitado');
 check(rj2.status===200&&!rj2.data.changed&&await balance(A)===50000-expected(s2),'repeating the rejection does not refund twice');
 for(const s of ['em_processamento','concluido'])check((await patch(o2,s)).status===200,'order moved to '+s);
 const rf=await patch(o2,'reembolsado');
 check(rf.data.wallet_refund_cents===expected(s2)&&await balance(A)===50000,'refunding a completed wallet order returns the amount');
 check((await patch(o2,'reembolsado')).data.changed===false&&await balance(A)===50000,'no second refund');
 const st2=(await req('GET','/api/client/wallet/statement',{cookie:A.cookie})).data.transactions;
 check(st2.filter(t=>t.type==='order_refund').length===2,'statement shows both refunds');
 const plain=Number(db.prepare("INSERT INTO orders(customer_name,device_model,price_brl,payment_status,status) VALUES ('Manual','X',10,'pendente','pendente')").run().lastInsertRowid);
 const pr=await patch(plain,'rejeitado');
 check(pr.status===200&&pr.data.wallet_refund_cents===0,'orders without wallet charge are unaffected');

 // admin details
 const det=await req('GET','/api/admin/checkout/orders/'+o1.id,{cookie:adminCookie});
 check(det.status===200&&det.data.identifier===IMEI&&det.data.details?.details?.api_fields?.IMEI===IMEI&&det.data.charge_status==='refunded','admin sees checkout details and refund state');
 check((await req('GET','/api/admin/checkout/orders/'+o1.id,{cookie:A.cookie})).status!==200,'client cannot reach admin checkout details');
 check(db.prepare('SELECT MIN(balance_cents) AS m FROM wallet_accounts').get().m>=0,'no wallet balance below zero');

 // ---------- browser: pay a draft in the client area ----------
 const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(x=>x&&existsSync(x));
 if(withUi&&chrome){
  const {default:puppeteer}=await import('puppeteer-core');const shots=join(root,'reports','checkout-ui');mkdirSync(shots,{recursive:true});
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--lang=pt-BR']});
  try{for(const [name,width,height,mobile] of [['desktop',1440,900,false],['phone',390,844,true]]){
   const dUi=await draft(A,s2),start=await balance(A);
   const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(20000);const problems=[];
   page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused/.test(m.text()))problems.push(m.text())});
   await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','pt-BR')}catch{}});await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile});
   await page.goto(base+'/client/',{waitUntil:'domcontentloaded'});await page.waitForSelector('#login');
   await page.type('#login [name=email]','checkout.a@example.test');await page.type('#login [name=password]','isolated-client-password-123');await page.click('#login button');
   await page.waitForFunction(()=>document.body.classList.contains('ca-signed-in'));
   await page.click('#clientNav [data-panel="place"]');
   await page.waitForSelector(`[data-checkout="${dUi}"]`);await page.waitForNetworkIdle({idleTime:500}).catch(()=>{});
   check(await page.$eval(`[data-checkout="${dUi}"]`,b=>/Pagar com saldo/.test(b.textContent)&&/R\$/.test(b.textContent)),name+': pay button with price');
   await page.$eval(`[data-checkout="${dUi}"]`,b=>b.click());await page.waitForSelector(`[data-confirm-checkout="${dUi}"]`);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': no horizontal overflow');
   await page.screenshot({path:join(shots,name+'-confirm.png'),fullPage:true});
   await page.$eval(`[data-confirm-checkout="${dUi}"]`,b=>b.click());
   await page.waitForFunction(()=>!document.querySelector('[data-client-panel="orders"]').hidden&&/criado e pago com saldo/.test(document.getElementById('msg').textContent));
   check(await balance(A)===start-expected(s2),name+': balance debited once');
   check(await page.$$eval('#orders>article .ca-pill',p=>p.some(x=>/Pagamento: Pago/.test(x.textContent))),name+': new order shows paid badge');
   await page.screenshot({path:join(shots,name+'-orders.png'),fullPage:true});
   check(!problems.length,name+': no JS/CSP errors '+problems.join(' | '));await ctx.close();
  }}finally{await browser.close()}
 }else console.log('skip - browser phase (dist/ or Chrome missing)');
 check(!/\b490154203237518\b/.test(stderr),'server logs do not contain the IMEI');
 db.close();
 console.log('CHECKOUT_PASS: server pricing, insufficient balance, price change, idempotency and concurrency, isolation, draft rules, refunds once, statement, admin details'+(withUi&&chrome?', client-area UI':''));
}finally{
 if(child){child.kill('SIGTERM');await delay(150)}
 if(temp)rmSync(temp,{recursive:true,force:true});
}
