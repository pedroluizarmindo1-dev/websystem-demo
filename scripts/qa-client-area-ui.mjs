#!/usr/bin/env node
// Browser regression for the redesigned client area (public/cliente.html + cliente.js), with headless Chrome against
// an isolated server and fictitious data: signed-out screen, login, signed-in shell (sidebar on desktop, bottom bar on
// phones), dashboard, orders with status badges and history, catalog -> draft order, support ticket, profile and
// logout. Requires `npm run build` and a local Chrome (CHROME_PATH). No supplier or payment contact.
// Screenshots go to reports/client-area-ui/ (not versioned).
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';

const root=resolve(import.meta.dirname,'..');
const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome'].find(p=>p&&existsSync(p));
if(!chrome){console.error('CLIENT_AREA_UI_BLOCKED: Chrome not found (set CHROME_PATH)');process.exit(2)}
if(!existsSync(join(root,'dist','cliente.html'))){console.error('CLIENT_AREA_UI_BLOCKED: dist/ missing, run "npm run build" first');process.exit(2)}
const temp=mkdtempSync(join(tmpdir(),'ws-client-ui-')),shots=join(root,'reports','client-area-ui');
const port=String(37100+Math.floor(Math.random()*300)),base='http://127.0.0.1:'+port;
const EMAIL='cliente.qa@example.test',PASSWORD='isolated-client-area-password-123';
const check=(ok,msg)=>{if(!ok)throw Error('CLIENT_AREA_UI_FAIL: '+msg)};
let child,browser;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});
 mkdirSync(join(temp,'data'));mkdirSync(shots,{recursive:true});
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const h=hashPassword('isolated-client-area-admin-123');
 const admin=issue({id:Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run('client-ui-admin',h.salt,h.hash,'admin').lastInsertRowid)});
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false',COOKIE_SECURE:'false'},stdio:'ignore'});
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}
 check(ready,'server did not start');
 const api=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:'ws_session='+admin},body:JSON.stringify(body)});check(r.ok,path+' -> '+r.status);return r.json()};
 // fictitious customer, 3 linked orders in different states, 2 catalog services
 const client=await api('/api/admin/client-area/users',{email:EMAIL,display_name:'Cliente QA',password:PASSWORD});
 const orders=[];for(const o of [{customer_name:'Cliente QA',device_brand:'Apple',device_model:'iPhone 13',price_brl:120},{customer_name:'Cliente QA',device_brand:'Samsung',device_model:'Galaxy S22',price_brl:80},{customer_name:'Cliente QA',device_brand:'Xiaomi',device_model:'Redmi Note 12',price_brl:45}])orders.push((await api('/api/orders',o)).id);
 const patch=async(id,status)=>{const r=await fetch(base+'/api/orders/'+id,{method:'PATCH',headers:{Origin:base,'Content-Type':'application/json',Cookie:'ws_session='+admin},body:JSON.stringify({status})});check(r.ok,'patch '+id+' -> '+r.status)};
 await patch(orders[0],'em_processamento');await patch(orders[0],'concluido');await patch(orders[1],'em_processamento');
 for(const id of orders)await api('/api/admin/client-area/users/'+client.id+'/orders',{order_id:id});
 const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 const ins=db.prepare('INSERT INTO services(name,category,brand,model,price_usd,eta,available) VALUES (?,?,?,?,?,?,1)');
 ins.run('QA iCloud Check','Apple · iCloud / FMI','Apple','iPhone',1,'1-5 min');ins.run('QA Unlock Code Samsung','Desbloqueio de rede','Samsung','Galaxy',5,'1-2 h');
 db.close();
 // Facets must follow the active search/type filters, not show unrelated global categories.
 const facetResponse=await fetch(base+'/api/public/catalog?q='+encodeURIComponent('QA iCloud'));
 check(facetResponse.ok,'filtered catalog API');
 const facets=await facetResponse.json();
 check(facets.total===1&&facets.categories.length===1&&facets.categories[0].category==='Apple · iCloud / FMI','catalog facets follow search');

 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--lang=pt-BR']});
 for(const [name,width,height,mobile] of [['desktop',1440,900,false],['phone',390,844,true]]){
  const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(15000);
  await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','pt-BR')}catch{}});
  const problems=[];
  page.on('pageerror',e=>problems.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to/i.test(m.text()))problems.push('csp: '+m.text().slice(0,160))});
  page.on('response',r=>{const u=new URL(r.url());if(r.status()>=500||(r.status()>=400&&u.origin===base&&!u.pathname.startsWith('/api/client/me')))problems.push(r.status()+' '+u.pathname)});
  await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile});
  const noOverflow=async label=>check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': horizontal overflow on '+label);

  // signed out
  await page.goto(base+'/client/',{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#loginBox:not([hidden]) #login');
  check(await page.$eval('#dashboard',d=>getComputedStyle(d).display==='none'),name+': dashboard hidden while signed out');
  await noOverflow('login');await page.screenshot({path:join(shots,name+'-login.png'),fullPage:true});
  await page.type('#login [name=email]',EMAIL);await page.type('#login [name=password]',PASSWORD);await page.click('#login button');

  // signed in: shell
  await page.waitForFunction(()=>document.body.classList.contains('ca-signed-in')&&/Cliente QA/.test(document.getElementById('greeting').textContent));
  check(await page.$eval('.ca-auth',e=>getComputedStyle(e).display==='none'),name+': login screen hidden after sign-in');
  await page.waitForFunction(()=>document.querySelectorAll('#clientKpis>div').length===4);
  const kpis=await page.$$eval('#clientKpis>div strong',s=>s.map(x=>x.textContent));
  // the phone run reuses the account after the desktop run created one draft and one ticket; one order is concluded
  check(JSON.stringify(kpis)===JSON.stringify(mobile?['3','2','1','1']:['3','2','0','0']),name+': dashboard indicators '+JSON.stringify(kpis));
  const side=await page.$eval('.ca-side',s=>{const r=s.getBoundingClientRect();return {pos:getComputedStyle(s).position,top:Math.round(r.top),bottom:Math.round(r.bottom),h:innerHeight,w:Math.round(r.width)}});
  if(mobile)check(side.pos==='fixed'&&side.bottom===side.h&&side.top>side.h-110,name+': bottom navigation bar '+JSON.stringify(side));
  else check(side.pos==='sticky'&&side.w>=200&&side.top===0,name+': sidebar navigation '+JSON.stringify(side));
  check(await page.$$eval('#clientNav button',b=>b.every(x=>x.scrollWidth<=x.clientWidth+1)),name+': navigation labels fit');
  await noOverflow('dashboard');await page.screenshot({path:join(shots,name+'-dashboard.png'),fullPage:true});

  // orders: badges and history
  await page.click('[data-goto="orders"]');
  await page.waitForSelector('[data-client-panel="orders"]:not([hidden]) #orders>article');
  const badges=await page.$$eval('#orders>article .ca-pill',p=>p.map(x=>x.textContent+'|'+x.className));
  check(badges.some(b=>b.startsWith('Concluído|')&&b.includes('ca-ok'))&&badges.some(b=>b.startsWith('Em andamento|')&&b.includes('ca-run'))&&badges.some(b=>b.startsWith('Pendente|')&&b.includes('ca-wait'))&&badges.some(b=>b.startsWith('Pagamento: Pendente')),name+': status badges '+JSON.stringify(badges));
  check(await page.$eval('#clientNav [data-panel="orders"]',b=>b.getAttribute('aria-current')==='page'),name+': navigation marks the current page');
  await page.click('#orders>article details>summary');
  await page.waitForFunction(()=>/Status alterado|Pedido criado/.test(document.querySelector('#orders>article details').textContent));
  await noOverflow('orders');await page.screenshot({path:join(shots,name+'-orders.png'),fullPage:true});

  // new order: catalog -> draft
  await page.click('#clientNav [data-panel="place"]');
  await page.waitForFunction(()=>document.querySelectorAll('#catalogResults article').length===2);
  await noOverflow('catalog');await page.screenshot({path:join(shots,name+'-catalog.png'),fullPage:true});
  // type tabs and category chips
  check(await page.$$eval('#catalogTypes [data-main]',b=>b.length)===5,name+': catalog type tabs');
  const chips=await page.$$eval('#catalogCategories button',b=>b.map(x=>x.textContent));
  check(chips.length===3&&chips.some(c=>c.startsWith('Desbloqueio de rede')),name+': category chips '+JSON.stringify(chips));
  await page.$$eval('#catalogCategories button',b=>b.find(x=>x.textContent.startsWith('Desbloqueio de rede')).click());
  await page.waitForFunction(()=>document.querySelectorAll('#catalogResults article').length===1&&!document.getElementById('catalogClear').hidden);
  await page.click('#catalogTypes [data-main="IMEI"]');
  await page.waitForFunction(()=>/Nenhum serviço/.test(document.getElementById('catalogResults').textContent));
  await page.click('#catalogClear');
  await page.waitForFunction(()=>document.querySelectorAll('#catalogResults article').length===2&&document.getElementById('catalogClear').hidden&&document.querySelector('#catalogTypes [data-main=""]').getAttribute('aria-pressed')==='true');
  await page.$$eval('#catalogResults article',arts=>arts.find(a=>a.textContent.includes('QA Unlock Code Samsung')).querySelector('button').click());
  await page.waitForSelector('[data-client-panel="order"]:not([hidden]) #draftOrder');
  await page.type('#imeiPrimary','490154203237518');await page.type('#draftOrder [name=device_model]','Galaxy S22');
  await page.click('#reviewDraft');await page.waitForSelector('#orderReview:not([hidden])');
  const review=await page.$eval('#orderReviewSummary',r=>r.textContent);
  check(!/[{}]/.test(review)&&review.includes('Identificação: IMEI único')&&review.includes('Tipo: IMEI / Serial')&&!review.includes('Detalhes:'),name+': readable order review '+JSON.stringify(review.slice(0,200)));
  await noOverflow('order review');await page.screenshot({path:join(shots,name+'-order-review.png'),fullPage:true});
  await page.click('#saveDraft');
  await page.waitForFunction(()=>/Rascunho salvo/.test(document.getElementById('msg').textContent)&&!document.querySelector('[data-client-panel="place"]').hidden);
  const toast=await page.$eval('#msg',m=>{const s=getComputedStyle(m),r=m.getBoundingClientRect(),nav=document.querySelector('.ca-side').getBoundingClientRect();return {ok:s.display!=='none'&&s.position==='fixed'&&r.width>200,top:Math.round(r.top),bottom:Math.round(r.bottom),navTop:Math.round(nav.top),h:innerHeight}});
  check(toast.ok,name+': confirmation toast visible while signed in');
  // phone: the toast sits just above the bottom navigation (not over the header); desktop: top-right
  check(mobile?toast.bottom<=toast.navTop&&toast.top>toast.h/2:toast.top<toast.h/3,name+': toast placement '+JSON.stringify(toast));
  await page.waitForFunction(()=>[...document.querySelectorAll('#drafts>article')].some(a=>a.textContent.includes('QA Unlock Code Samsung')&&a.querySelector('.ca-pill')));

  // wallet panel: balance and read-only statement
  await page.click('#clientNav [data-panel="wallet"]');
  await page.waitForFunction(()=>/Nenhuma movimentação/.test(document.getElementById('walletHistory').textContent)&&/R\$\s?0,00/.test(document.getElementById('walletPanelBalance').textContent));
  await noOverflow('wallet');await page.screenshot({path:join(shots,name+'-wallet.png'),fullPage:true});
  // support ticket
  await page.click('#clientNav [data-panel="support"]');
  await page.type('#ticket [name=subject]','Pedido #'+orders[1]+' sem retorno');await page.type('#ticket [name=description]','Mensagem de teste do QA.');
  await page.click('#ticket button');
  await page.waitForFunction(()=>[...document.querySelectorAll('#tickets>article')].some(a=>a.textContent.includes('sem retorno')&&a.querySelector('.ca-pill')));
  await noOverflow('support');await page.screenshot({path:join(shots,name+'-support.png'),fullPage:true});

  // profile and logout
  await page.click('#clientNav [data-panel="profile"]');
  check(await page.$eval('#profileInfo',p=>p.textContent.includes('cliente.qa@example.test')&&p.querySelectorAll('dt').length===3),name+': profile shows the account e-mail');
  await noOverflow('profile');await page.screenshot({path:join(shots,name+'-profile.png'),fullPage:true});
  await page.click('#logout');
  await page.waitForFunction(()=>!document.body.classList.contains('ca-signed-in')&&!document.getElementById('loginBox').hidden);
  check(await page.$eval('.ca-auth',e=>getComputedStyle(e).display!=='none')&&await page.$eval('#msg',m=>m.textContent.includes('Sessão encerrada')),name+': back to the login screen after logout');
  check(!problems.length,name+': '+problems.join(' | '));
  await ctx.close();
 }
 // English locale: static texts and status badges follow the language selector
 {const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(15000);
  await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','en')}catch{}});
  await page.setViewport({width:1280,height:800});
  await page.goto(base+'/client/',{waitUntil:'domcontentloaded'});await page.waitForSelector('#loginBox:not([hidden]) #login');
  await page.waitForFunction(()=>document.querySelector('.ca-auth-intro h1').textContent.includes('Orders and support'));
  await page.type('#login [name=email]',EMAIL);await page.type('#login [name=password]',PASSWORD);await page.click('#login button');
  await page.waitForFunction(()=>document.body.classList.contains('ca-signed-in'));
  const nav=await page.$$eval('#clientNav button',b=>b.map(x=>x.textContent.trim()));
  check(nav.includes('New order')&&nav.includes('Wallet')&&nav.includes('Profile'),'en: navigation '+JSON.stringify(nav));
  await page.click('#clientNav [data-panel="orders"]');await page.waitForSelector('#orders>article .ca-pill');
  const pills=await page.$$eval('#orders>article .ca-pill',p=>p.map(x=>x.textContent));
  check(pills.includes('Completed')&&pills.includes('In progress')&&pills.some(x=>x.startsWith('Payment: ')),'en: status badges '+JSON.stringify(pills));
  await page.screenshot({path:join(shots,'desktop-en-orders.png'),fullPage:true});
  await ctx.close()}
 console.log('CLIENT_AREA_UI_PASS: login, sidebar/bottom bar, dashboard indicators, order badges and history, catalog -> draft, ticket, profile, logout on desktop and phone; catalog type/category filters; wallet statement; readable order review; toast placement; English locale');
}finally{
 if(browser)await browser.close().catch(()=>{});
 if(child){child.kill('SIGTERM');await delay(150)}
 rmSync(temp,{recursive:true,force:true});
}
