#!/usr/bin/env node
// Browser regression for client-area translation of text rendered by JavaScript (public/site-experience.js):
// en and es must not leave known Portuguese strings in visible text or in placeholder/aria-label/title attributes,
// across login error, dashboard, orders, catalog, draft review, wallet, support and profile. pt-BR must stay untouched.
// Isolated server, fictitious data, no supplier or payment contact. Requires `npm run build` and Chrome (CHROME_PATH).
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';

const root=resolve(import.meta.dirname,'..');
const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome'].find(p=>p&&existsSync(p));
if(!chrome){console.error('CLIENT_I18N_BLOCKED: Chrome not found (set CHROME_PATH)');process.exit(2)}
if(!existsSync(join(root,'dist','cliente.html'))){console.error('CLIENT_I18N_BLOCKED: dist/ missing, run "npm run build" first');process.exit(2)}
const check=(ok,msg)=>{if(!ok)throw Error('CLIENT_I18N_FAIL: '+msg);console.log('ok -',msg)};
// Portuguese source strings known to the dictionaries; any of them left visible in en/es is a miss.
const src=readFileSync(join(root,'public','site-experience.js'),'utf8');
const grab=(start,end)=>{const a=src.indexOf(start),b=src.indexOf(end,a);check(a>=0&&b>a,'dictionary block '+start.trim());return Function('return '+src.slice(a+start.length,b).trim().replace(/;$/,''))()};
const base_=grab('const translations=','\nconst dictionary'),more=grab('const more=','\nconst patterns');
const known=locale=>new Set(Object.entries({...base_[locale],...more[locale]}).filter(([k,v])=>k!==v&&k.length>3).map(([k])=>k));
const temp=mkdtempSync(join(tmpdir(),'ws-client-i18n-')),shots=join(root,'reports','client-i18n');
const port=String(37500+Math.floor(Math.random()*300)),base='http://127.0.0.1:'+port;
const EMAIL='cliente.i18n@example.test',PASSWORD='isolated-client-i18n-password-123';
let child,browser;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});
 mkdirSync(join(temp,'data'));mkdirSync(shots,{recursive:true});symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword('isolated-client-i18n-admin-123');
 const admin=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('client-i18n-admin',h.salt,h.hash,'admin').lastInsertRowid)});
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false',COOKIE_SECURE:'false'},stdio:'ignore'});
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}
 check(ready,'server started');
 const api=async(path,body,method='POST')=>{const r=await fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:'ws_session='+admin},body:JSON.stringify(body)});if(!r.ok)throw Error(path+' -> '+r.status);return r.json()};
 const client=await api('/api/admin/client-area/users',{email:EMAIL,display_name:'Cliente QA',password:PASSWORD});
 const order=(await api('/api/orders',{customer_name:'Cliente QA',device_brand:'Apple',device_model:'iPhone 13',price_brl:120})).id;
 await api('/api/orders/'+order,{status:'em_processamento'},'PATCH');
 await api('/api/admin/client-area/users/'+client.id+'/orders',{order_id:order});
 const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));
 db.prepare('INSERT INTO services(name,category,brand,model,price_usd,eta,available) VALUES (?,?,?,?,?,?,1)').run('QA Unlock Code Samsung','Desbloqueio de rede','Samsung','Galaxy',5,'1-2 h');db.close();

 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const leftovers=async(page,set)=>page.evaluate(keys=>{const ks=new Set(keys),out=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const el=n.parentElement;if(!el||el.closest('script,style,textarea,[hidden],option:not([value])'))continue;const t=n.nodeValue.trim();if(ks.has(t))out.push(t)}
  for(const el of document.querySelectorAll('[placeholder],[aria-label],[title]'))for(const a of ['placeholder','aria-label','title']){const v=el.getAttribute(a)?.trim();if(v&&ks.has(v))out.push(a+'='+v)}
  return [...new Set(out)]},[...set]);
 for(const [locale,expect] of [['en',{hi:'Hi, Cliente QA',client:'Client #',summary:/^1 orders · \d+ drafts · \d+ tickets$/,search:'Search by number or model',wrong:'Wrong e-mail or password',cat:'Category: ',eta:'Estimated time: '}],
                               ['es',{hi:'Hola, Cliente QA',client:'Cliente #',summary:/^1 pedidos · \d+ borradores · \d+ tickets$/,search:'Buscar por número o modelo',wrong:'Correo o contraseña incorrectos',cat:'Categoría: ',eta:'Plazo estimado: '}]]){
  const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(15000);const problems=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.evaluateOnNewDocument(l=>{try{localStorage.setItem('ut_locale',l)}catch{}},locale);
  await page.setViewport({width:1280,height:900});
  const set=known(locale),misses=[],hints=new Set();const scan=async label=>{const l=await leftovers(page,set);if(l.length)misses.push(label+': '+l.join(' | '));
   for(const t of await page.evaluate(()=>{const out=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){const el=n.parentElement;if(!el||el.closest('script,style,[hidden]'))continue;const t=n.nodeValue.trim();if(/[ãõçáéíóúâê]|\b(não|de|para|com|seu|sua|você|pedido|serviço)\b/i.test(t))out.push(t.slice(0,90))}return out}))hints.add(label+': '+t)};
  await page.goto(base+'/client/',{waitUntil:'networkidle0'});await page.waitForSelector('#loginBox:not([hidden]) #login');
  await scan('signed out');
  await page.type('#login [name=email]',EMAIL);await page.type('#login [name=password]','wrong-password-for-i18n-check');await page.click('#login button');
  await page.waitForFunction(w=>document.body.innerText.includes(w),{},expect.wrong);check(true,locale+': login error translated');
  await page.$eval('#login [name=password]',i=>i.value='');await page.type('#login [name=password]',PASSWORD);await page.click('#login button');
  await page.waitForFunction(()=>document.body.classList.contains('ca-signed-in'));await page.waitForNetworkIdle();
  const greet=await page.$eval('#greeting',e=>e.textContent);
  check(greet.startsWith(expect.hi)&&greet.includes(expect.client),locale+': greeting "'+greet+'"');
  const summary=await page.$eval('#accountSummary',e=>e.textContent.trim());check(expect.summary.test(summary),locale+': account summary "'+summary+'"');
  await scan('dashboard');
  await page.click('#clientNav [data-panel="orders"]');await page.waitForSelector('#orders>article');await page.waitForNetworkIdle();
  check(await page.$eval('#ordersFilterSearch',i=>i.placeholder)===expect.search,locale+': orders search placeholder');
  await scan('orders');
  await page.click('#clientNav [data-panel="place"]');await page.waitForFunction(()=>document.querySelectorAll('#catalogResults article').length===1);await scan('catalog');
  await page.$eval('#catalogResults article button',b=>b.click());await page.waitForSelector('[data-client-panel="order"]:not([hidden]) #draftOrder');await page.waitForNetworkIdle();
  const sum=await page.$eval('[data-client-panel="order"]',e=>e.innerText);
  check(sum.includes(expect.cat)&&sum.includes(expect.eta),locale+': service summary labels');
  await scan('order form');
  for(const p of ['wallet','support','profile']){await page.click(`#clientNav [data-panel="${p}"]`);await page.waitForNetworkIdle();await scan(p)}
  await page.screenshot({path:join(shots,'client-'+locale+'.png'),fullPage:true});
  console.log('report-only, Portuguese-looking text ('+locale+'):\n   '+[...hints].join('\n   '));
  check(!misses.length,locale+': no known Portuguese string left '+JSON.stringify(misses));
  check(!problems.length,locale+': no JS errors '+problems.join(' | '));
  await ctx.close();
 }
 // pt-BR stays as written
 {const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(15000);
  await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','pt-BR')}catch{}});
  await page.goto(base+'/client/',{waitUntil:'networkidle0'});await page.type('#login [name=email]',EMAIL);await page.type('#login [name=password]',PASSWORD);await page.click('#login button');
  await page.waitForFunction(()=>document.body.classList.contains('ca-signed-in'));await page.waitForNetworkIdle();
  const greet=await page.$eval('#greeting',e=>e.textContent);check(greet.startsWith('Olá, Cliente QA · Cliente #'),'pt-BR: greeting untouched "'+greet+'"');
  await ctx.close()}
 console.log('CLIENT_I18N_PASS: en and es leave no known Portuguese strings (text and attributes) on login, dashboard, orders, catalog, order form, wallet, support and profile; composites and labels translated; pt-BR untouched');
}finally{
 if(browser)await browser.close().catch(()=>{});
 if(child){child.kill('SIGTERM');await delay(150)}
 rmSync(temp,{recursive:true,force:true});
}
