#!/usr/bin/env node
// Isolated regression for the supervised supplier submission (api/supplier-orders.mjs) against a local DHRU simulator.
// Fictitious data only; IMEIVE_API_URL points to the simulator (accepted only with NODE_ENV=test). No real supplier call.
// Covers: approval required, DHRU request format, single placement (repeat and concurrent clicks), supplier refusal and
// re-approval, uncertain outcomes (connection drop, unreadable answer, stale "enviando") never retried automatically,
// manual resolution, status sync (in process / success with code / rejected with wallet refund), client result access,
// admin-only routes, audit events, secrets kept out of logs, and the admin "Fornecedor" tab.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const root=resolve(import.meta.dirname,'..');
const check=(ok,msg)=>{if(!ok)throw Error('SUPPLIER_ORDERS_FAIL: '+msg);console.log('ok -',msg)};
const USER='qa-reseller',KEY='qa-fake-dhru-key-not-real-0001',ADMIN_PASSWORD='isolated-supplier-admin-123';

// ---------- DHRU simulator ----------
const sim={placements:[],status:new Map(),mode:new Map(),next:9000,authFailures:0};
const dhru=createServer((req,res)=>{let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
 const f=new URLSearchParams(raw);const send=o=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
 if(f.get('username')!==USER||f.get('apiaccesskey')!==KEY){sim.authFailures++;return send({ERROR:[{MESSAGE:'Authentication Failed'}]})}
 let p={};try{p=JSON.parse(Buffer.from(f.get('parameters')||'','base64').toString('utf8'))}catch{}
 if(f.get('action')==='placeimeiorder'){
  const mode=sim.mode.get(p.IMEI)||'ok';sim.placements.push({...p,mode});
  if(mode==='error')return send({ERROR:[{MESSAGE:'Invalid IMEI for this service'}]});
  if(mode==='drop')return req.socket.destroy();
  if(mode==='html'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<html>maintenance</html>')}
  const ref=String(++sim.next);sim.status.set(ref,{STATUS:1});return send({SUCCESS:[{MESSAGE:'Order received',REFERENCEID:ref}]});
 }
 if(f.get('action')==='getimeiorder'){const s=sim.status.get(String(p.ID));return s?send({SUCCESS:[{STATUS:s.STATUS,CODE:s.CODE??''}]}):send({ERROR:[{MESSAGE:'Order not found'}]})}
 send({ERROR:[{MESSAGE:'Invalid Action'}]});
})});

let child,temp;
try{
 await new Promise(r=>dhru.listen(0,'127.0.0.1',r));const simUrl=`http://127.0.0.1:${dhru.address().port}/api/index.php`;
 temp=mkdtempSync(join(tmpdir(),'ws-supplier-'));
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const withUi=existsSync(join(root,'dist','index.html'));if(withUi)cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});
 const port=String(38600+Math.floor(Math.random()*300)),base='http://127.0.0.1:'+port;
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword(ADMIN_PASSWORD);
 const admin=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('supplier-admin',h.salt,h.hash,'admin').lastInsertRowid)});
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,NODE_ENV:'test',PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',DEMO_MODE:'false',COOKIE_SECURE:'false',
  SUPPLIER_ORDERS_ENABLED:'true',IMEIVE_API_URL:simUrl,IMEIVE_API_USERNAME:USER,IMEIVE_API_KEY:KEY},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(150)}
 check(ready,'isolated server started');
 const req=async(method,path,{body,cookie}={})=>{const r=await fetch(base+path,{method,headers:{Origin:base,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});let data=null;try{data=await r.json()}catch{}return {status:r.status,data}};
 const adminCookie='ws_session='+admin;
 const makeClient=async email=>{const u=await req('POST','/api/admin/client-area/users',{body:{email,display_name:'Cliente '+email.split('@')[0],password:'isolated-client-password-123'},cookie:adminCookie});
  const r=await fetch(base+'/api/client/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password:'isolated-client-password-123'})});return {cookie:r.headers.get('set-cookie').split(';')[0],id:u.data.id}};
 const A=await makeClient('supplier.a@example.test'),B=await makeClient('supplier.b@example.test');
 const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 db.prepare("INSERT INTO services(external_id,source,name,category,price_usd,available) VALUES ('imeive:4321','imeive','QA iCloud Check','QA',2,1)").run();
 db.prepare("INSERT INTO supplier_service_fields(external_id,metadata_json) VALUES ('imeive:4321',?)").run(JSON.stringify({serviceType:'IMEI',form_fields:[]}));
 const serviceId=db.prepare("SELECT id FROM services WHERE external_id='imeive:4321'").get().id;
 db.prepare('INSERT INTO wallet_accounts(client_id,balance_cents) VALUES (?,0)').run(A.id);
 let draftSeq=1000;
 const paidOrder=(client,imei,extra={})=>{const amount=3900;db.exec('BEGIN IMMEDIATE');
  const id=Number(db.prepare("INSERT INTO orders(customer_name,customer_contact,device_brand,device_model,service_id,price_brl,payment_status,status) VALUES ('Cliente QA','qa@example.test','',?,?,39,'pago','pendente')").run('Serviço IMEI · '+imei,serviceId).lastInsertRowid);
  db.prepare('INSERT INTO client_order_links(client_id,order_id) VALUES (?,?)').run(client.id,id);
  db.prepare('INSERT INTO client_checkouts(draft_id,client_id,order_id,service_id,amount_cents,identifier,details_json) VALUES (?,?,?,?,?,?,?)').run(++draftSeq,client.id,id,serviceId,amount,imei,JSON.stringify({kind:'api',details:{api_fields:{IMEI:imei,...extra}}}));
  db.prepare('INSERT INTO wallet_order_charges(client_id,order_id,amount_cents,balance_after_cents) VALUES (?,?,?,0)').run(client.id,id,amount);
  db.exec('COMMIT');return id};
 const imei=n=>'35'+String(n).padStart(13,'0');
 const oA=paidOrder(A,imei(1),{MODEL:'iPhone 13'}),oB=paidOrder(A,imei(2)),oC=paidOrder(A,imei(3)),oD=paidOrder(A,imei(4)),oE=paidOrder(A,imei(5)),oF=paidOrder(A,imei(6));
 sim.mode.set(imei(2),'error');sim.mode.set(imei(3),'drop');sim.mode.set(imei(4),'html');
 const orderStatus=id=>db.prepare('SELECT status,payment_status FROM orders WHERE id=?').get(id);
 const submit=(id,confirm=id)=>req('POST','/api/admin/supplier/orders/'+id+'/submit',{cookie:adminCookie,body:{confirm_order_id:confirm}});

 const st=await req('GET','/api/admin/supplier/status',{cookie:adminCookie});
 check(st.status===200&&st.data.enabled&&st.data.awaiting===6,'admin status: enabled with 6 paid orders awaiting approval');
 const queue=await req('GET','/api/admin/supplier/queue?filter=aguardando',{cookie:adminCookie});
 const qa=queue.data.items.find(i=>i.order_id===oA);
 check(qa&&qa.can_submit&&qa.service.supplier_id==='4321'&&qa.identifier===imei(1)&&qa.fields.MODEL==='iPhone 13','queue shows service, supplier id, identifier and fields');
 check((await req('GET','/api/admin/supplier/queue',{cookie:A.cookie})).status>=401,'client cannot reach the supplier queue');
 check((await submit(oA,0)).status===400&&sim.placements.length===0,'submission requires confirming the order number');
 const noOrigin=await fetch(base+'/api/admin/supplier/orders/'+oA+'/submit',{method:'POST',headers:{'Content-Type':'application/json',Cookie:adminCookie},body:JSON.stringify({confirm_order_id:oA})});
 check(noOrigin.status===403&&sim.placements.length===0,'cross-origin submission blocked');

 // approved submission
 const sA=await submit(oA);
 check(sA.status===200&&sA.data.submission.status==='enviado'&&sA.data.submission.reference_id==='9001','approved order accepted by the supplier with REFERENCEID');
 const pA=sim.placements[0];
 check(pA.ID==='4321'&&pA.IMEI===imei(1)&&JSON.parse(Buffer.from(pA.CUSTOMFIELD,'base64').toString()).MODEL==='iPhone 13'&&pA.customfield===pA.CUSTOMFIELD&&sim.authFailures===0,'DHRU parameters: ID, IMEI and base64 custom fields with server-side credentials');
 check(orderStatus(oA).status==='em_processamento','order moved to em_processamento');
 check(db.prepare("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id=? AND origin='supplier_submit'").get(oA).n===1,'status history records the supervised submission');
 check((await submit(oA)).status===409&&sim.placements.length===1,'second approval of the same order rejected without a new placement');

 // supplier refusal -> can be approved again
 const sB=await submit(oB);
 check(sB.status===422&&sB.data.submission.status==='falhou'&&/Invalid IMEI/.test(sB.data.submission.error)&&orderStatus(oB).status==='pendente','supplier refusal recorded as falhou; order stays pending');
 sim.mode.delete(imei(2));
 const sB2=await submit(oB);
 check(sB2.status===200&&sB2.data.submission.status==='enviado'&&sB2.data.submission.attempts===2,'refused order approved again and accepted');

 // uncertain outcomes: never retried automatically
 const sC=await submit(oC);
 check(sC.status===202&&sC.data.submission.status==='incerto','dropped connection recorded as incerto');
 const before=sim.placements.length;
 check((await submit(oC)).status===409&&sim.placements.length===before,'uncertain submission cannot be re-sent');
 check((await req('POST','/api/admin/supplier/orders/'+oC+'/resolve',{cookie:adminCookie,body:{outcome:'sent'}})).status===400,'resolving as sent requires the supplier REFERENCEID');
 const rC=await req('POST','/api/admin/supplier/orders/'+oC+'/resolve',{cookie:adminCookie,body:{outcome:'not_sent'}});
 check(rC.status===200&&rC.data.submission.status==='falhou'&&rC.data.can_submit,'admin resolves "not at supplier": order can be approved again');
 sim.mode.delete(imei(3));
 check((await submit(oC)).data.submission.status==='enviado','re-approved after resolution');
 const sD=await submit(oD);
 check(sD.status===202&&sD.data.submission.status==='incerto','unreadable answer recorded as incerto');
 sim.status.set('7777',{STATUS:1});
 const rD=await req('POST','/api/admin/supplier/orders/'+oD+'/resolve',{cookie:adminCookie,body:{outcome:'sent',reference_id:'7777'}});
 check(rD.status===200&&rD.data.submission.status==='enviado'&&rD.data.submission.reference_id==='7777'&&orderStatus(oD).status==='em_processamento','admin resolves "found at supplier" with its REFERENCEID');

 // concurrent approvals of one order: one placement
 const p0=sim.placements.length;
 const race=await Promise.all([1,2,3].map(()=>submit(oE)));
 check(sim.placements.length===p0+1&&race.filter(r=>r.status===200).length===1,'concurrent approvals place the order once');

 // stale "enviando" becomes uncertain
 db.prepare("INSERT INTO supplier_submissions(order_id,supplier_service_id,status,attempts,updated_at) VALUES (?,'4321','enviando',1,datetime('now','-10 minutes'))").run(oF);
 await req('GET','/api/admin/supplier/queue?filter=incertos',{cookie:adminCookie});
 check(db.prepare('SELECT status FROM supplier_submissions WHERE order_id=?').get(oF).status==='incerto','interrupted "enviando" is treated as incerto');

 // status sync
 const refA=sA.data.submission.reference_id;
 check((await req('POST','/api/admin/supplier/orders/'+oA+'/refresh',{cookie:adminCookie})).data.submission.status==='enviado','in-process order stays enviado');
 sim.status.set(refA,{STATUS:4,CODE:'UNLOCK-CODE-123 <b>ok</b>'});
 const fA=await req('POST','/api/admin/supplier/orders/'+oA+'/refresh',{cookie:adminCookie});
 check(fA.data.submission.status==='concluido'&&orderStatus(oA).status==='concluido','STATUS 4 completes the submission and the order');
 const resA=await req('GET','/api/client/checkout/orders/'+oA+'/result',{cookie:A.cookie});
 check(resA.status===200&&resA.data.result==='UNLOCK-CODE-123 <b>ok</b>','client receives the supplier result for their order');
 check((await req('GET','/api/client/checkout/orders/'+oA+'/result',{cookie:B.cookie})).status===404,'other clients cannot read the result');
 sim.status.set(sB2.data.submission.reference_id,{STATUS:3,CODE:'Not supported'});
 const fB=await req('POST','/api/admin/supplier/orders/'+oB+'/refresh',{cookie:adminCookie});
 check(fB.data.submission.status==='rejeitado'&&orderStatus(oB).status==='rejeitado'&&orderStatus(oB).payment_status==='reembolsado','STATUS 3 rejects the order and refunds the wallet payment');
 check(db.prepare('SELECT balance_cents FROM wallet_accounts WHERE client_id=?').get(A.id).balance_cents===3900,'refund credited exactly once');
 await req('POST','/api/admin/supplier/orders/'+oB+'/refresh',{cookie:adminCookie});
 check(db.prepare('SELECT balance_cents FROM wallet_accounts WHERE client_id=?').get(A.id).balance_cents===3900,'repeated sync does not refund again');
 const events=(await req('GET','/api/admin/supplier/orders/'+oC+'/events',{cookie:adminCookie})).data.map(e=>e.action);
 check(['approved_and_sending','supplier_uncertain','resolved_not_sent','supplier_accepted'].every(a=>events.includes(a)),'audit trail of approvals, uncertainty and resolution');
 check(!stderr.includes(KEY)&&!/350000000000001/.test(stderr),'server logs contain neither the supplier key nor IMEIs');

 // ---------- browser: admin "Fornecedor" tab ----------
 const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(x=>x&&existsSync(x));
 if(withUi&&chrome){
  const oG=paidOrder(A,imei(7));
  const {default:puppeteer}=await import('puppeteer-core');const shots=join(root,'reports','supplier-ui');mkdirSync(shots,{recursive:true});
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--lang=pt-BR']});
  try{
   const page=await browser.newPage();page.setDefaultTimeout(20000);const problems=[];
   page.on('pageerror',e=>problems.push(e.message));
   await page.setViewport({width:1440,height:900});
   await page.goto(base+'/admin/',{waitUntil:'domcontentloaded'});
   await page.waitForSelector('#ws-username');await page.type('#ws-username','supplier-admin');await page.type('#ws-password',ADMIN_PASSWORD);await page.click('.loginSubmit');
   await page.waitForSelector('.sidebar nav .opsNavButton');await page.click('.sidebar nav .opsNavButton');
   await page.waitForSelector('[data-tab="fornecedor"]');await page.click('[data-tab="fornecedor"]');
   await page.waitForSelector(`[data-panel="fornecedor"] [data-submit="${oG}"]`);
   await page.screenshot({path:join(shots,'queue.png'),fullPage:true});
   const placed=sim.placements.length;
   await page.click(`[data-submit="${oG}"]`);await page.waitForSelector(`[data-confirm-submit="${oG}"]`);
   check(sim.placements.length===placed,'opening the review does not send anything');
   await page.click(`[data-confirm-submit="${oG}"]`);
   await page.waitForFunction(()=>/aceito pelo fornecedor/.test(document.querySelector('[data-supplier-note]')?.textContent||''));
   check(sim.placements.length===placed+1&&orderStatus(oG).status==='em_processamento','admin tab: review + confirm sends the order once');
   await page.click('[data-filter="incertos"]');
   await page.waitForSelector(`[data-resolve-not-sent="${oF}"]`);
   await page.screenshot({path:join(shots,'uncertain.png'),fullPage:true});
   check(!problems.length,'admin tab without JS errors '+problems.join(' | '));
  }finally{await browser.close()}
 }else console.log('skip - browser phase (dist/ or Chrome missing)');
 db.close();
 console.log('SUPPLIER_ORDERS_PASS: approval required, DHRU format, single placement, refusal/retry, uncertain never auto-retried, manual resolution, sync with code and refund, client result, admin-only, audit'+(withUi&&chrome?', admin tab UI':''));
}finally{
 if(child){child.kill('SIGTERM');await delay(150)}
 dhru.close();
 if(temp)rmSync(temp,{recursive:true,force:true});
}
