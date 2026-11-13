#!/usr/bin/env node
// Browser regression for the admin "Operações" page (src/admin-ops.jsx), driven with headless Chrome against an
// isolated server: throw-away copy of api/ + dist/, own SQLite files, fictitious data. Requires `npm run build`
// first and a local Chrome (CHROME_PATH or a common install path). Never touches repository/production data and
// never contacts a supplier or payment provider. Screenshots go to reports/admin-ops-ui/ (not versioned).
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';

const root=resolve(import.meta.dirname,'..');
const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome'].find(p=>p&&existsSync(p));
if(!chrome){console.error('ADMIN_OPS_UI_BLOCKED: Chrome not found (set CHROME_PATH)');process.exit(2)}
if(!existsSync(join(root,'dist','index.html'))){console.error('ADMIN_OPS_UI_BLOCKED: dist/ missing, run "npm run build" first');process.exit(2)}

const temp=mkdtempSync(join(tmpdir(),'ws-adminops-ui-')),downloads=join(temp,'downloads'),shots=join(root,'reports','admin-ops-ui');
const port=String(37000+Math.floor(Math.random()*900)),base='http://127.0.0.1:'+port,password='isolated-admin-ops-ui-password-123';
const check=(ok,msg)=>{if(!ok)throw Error('ADMIN_OPS_UI_FAIL: '+msg)};
const clean=s=>String(s).replace(/\s+/g,' ').trim();
let child,browser;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});
 mkdirSync(join(temp,'data'));mkdirSync(downloads);mkdirSync(shots,{recursive:true});
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const makeUser=(name,role)=>{const h=hashPassword(password);return Number(authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run(name,h.salt,h.hash,role).lastInsertRowid)};
 const adminToken=issue({id:makeUser('ops-ui-admin','admin')});makeUser('ops-ui-viewer','viewer');
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false',COOKIE_SECURE:'false'},stdio:'pipe'});
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}
 check(ready,'server did not start');

 // ---- fictitious data: 30 orders through the admin API (state machine enforced) and 3 customer drafts
 const api=async(path,method,body)=>{const r=await fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:'ws_session='+adminToken},body:JSON.stringify(body)});check(r.ok,method+' '+path+' -> '+r.status);return r.json()};
 const seed=[{customer_name:'Ana Silva',customer_contact:'ana@example.test',device_brand:'Apple',device_model:'iPhone 13',price_brl:100,payment_status:'pago'},{customer_name:'Bruno Lima',device_model:'Moto G',price_brl:50},{customer_name:'=HYPERLINK("http://evil.example","x")',device_model:'Galaxy S21',price_brl:10},...Array.from({length:27},(_,i)=>({customer_name:'Cliente '+(i+1),device_model:'Modelo '+(i+1),price_brl:1}))];
 const ids=[];for(const o of seed)ids.push((await api('/api/orders','POST',o)).id);
 await api('/api/orders/'+ids[0],'PATCH',{status:'em_processamento'});await api('/api/orders/'+ids[0],'PATCH',{status:'concluido'});await api('/api/orders/'+ids[1],'PATCH',{status:'rejeitado'});
 const sdb=new DatabaseSync(join(temp,'data','websystem.sqlite'));sdb.exec('PRAGMA busy_timeout=5000');
 const client=(email,name)=>Number(sdb.prepare('INSERT INTO client_users(email,display_name,password_salt,password_hash) VALUES (?,?,?,?)').run(email,name,'salt','hash').lastInsertRowid);
 const draft=(c,service,model,identifier,details)=>sdb.prepare('INSERT INTO client_order_drafts(client_id,service_name,device_model,identifier,details_json) VALUES (?,?,?,?,?)').run(c,service,model,identifier,details);
 const c1=client('c1@example.test','Cliente Um'),c2=client('c2@example.test','Cliente Dois');
 draft(c1,'iCloud Check','iPhone 12','356938035643809',JSON.stringify({kind:'imei',details:{mode:'single',comments:'nota privada',api_fields:{Network:'Vivo'}}}));
 draft(c2,'Server Credits','Tool X','user-abc',JSON.stringify({kind:'server',details:{username:'SECRET-USER-777',license_key:'SECRET-LICENSE-123'}}));
 draft(c1,'Legacy Service','Old','LEG-1',null);
 sdb.close();

 // ---- browser session
 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const cdp=await browser.target().createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 const page=await browser.newPage();page.setDefaultTimeout(15000);
 const problems=[];let adminFlow=true;
 page.on('pageerror',e=>problems.push('pageerror: '+e.message));
 // Known and unrelated: style.css @imports Google Fonts, which the application's own CSP already blocks.
 page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to/i.test(m.text())&&!m.text().includes('fonts.googleapis.com'))problems.push('console: '+m.text())});
 page.on('response',r=>{if(adminFlow&&r.url().includes('/api/admin/ops')&&r.status()>=400)problems.push('ops request failed: '+r.status()+' '+r.url())});
 const login=async user=>{await page.waitForSelector('#ws-username');await page.type('#ws-username',user);await page.type('#ws-password',password);await page.click('.loginSubmit');await page.waitForSelector('.sidebar nav button')};
 const panel=id=>'[data-panel="'+id+'"]';
 const waitRows=(id,n)=>page.waitForFunction((sel,count)=>{const p=document.querySelector(sel);return p&&!p.querySelector('button[type="submit"]:disabled')&&p.querySelectorAll('tbody tr').length===count},{},panel(id),n);
 const text=sel=>page.$eval(sel,el=>el.innerText);
 const waitPager=(id,fragment)=>page.waitForFunction((sel,part)=>(document.querySelector(sel)?.innerText||'').includes(part),{},panel(id)+' .servicePagination span',fragment);
 const openTab=async id=>{await page.click('[data-tab="'+id+'"]');await page.waitForSelector(panel(id)+':not([hidden])')};

 await page.setViewport({width:1440,height:900});
 await page.goto(base+'/admin/',{waitUntil:'domcontentloaded'});
 await login('ops-ui-admin');
 await page.waitForSelector('.sidebar nav .opsNavButton');
 await page.click('.sidebar nav .opsNavButton');

 // Resumo
 await page.waitForFunction(sel=>document.querySelectorAll(sel+' .metricvalue').length===4,{},panel('resumo'));
 const metrics=(await page.$$eval(panel('resumo')+' .metricvalue',list=>list.map(el=>el.innerText))).map(clean);
 check(JSON.stringify(metrics)===JSON.stringify(['30','R$ 187,00','28','3']),'summary cards '+JSON.stringify(metrics));
 const summary=clean(await text(panel('resumo')));
 check(/Pendente 28 R\$ 37,00/.test(summary)&&/Concluído 1 R\$ 100,00/.test(summary)&&/Rejeitado 1 R\$ 50,00/.test(summary)&&/Pago 1 R\$ 100,00/.test(summary),'summary breakdown: '+summary.slice(0,600));
 check(await page.$$eval(panel('resumo')+' .opsBar',list=>list.length===30&&!list[29].classList.contains('opsBarEmpty')&&list[0].classList.contains('opsBarEmpty')),'daily bars');
 await page.screenshot({path:join(shots,'desktop-resumo.png'),fullPage:true});

 // O.S.: pagination, search, status filter, kept filters
 await openTab('os');await waitRows('os',25);
 check(clean(await text(panel('os')+' .servicePagination span'))==='Página 1 de 2 · 30 resultados','pager page 1');
 await page.click(panel('os')+' .servicePagination button:last-of-type');await waitRows('os',5);
 check(clean(await text(panel('os')+' .servicePagination span'))==='Página 2 de 2 · 30 resultados','pager page 2');
 await page.type(panel('os')+' input[name="q"]','Ana');await page.keyboard.press('Enter');await waitRows('os',1);
 check(/Ana Silva/.test(await text(panel('os')+' tbody'))&&/ana@example\.test/.test(await text(panel('os')+' tbody'))&&clean(await text(panel('os')+' .servicePagination span'))==='Página 1 de 1 · 1 resultado','search by name');
 await page.click(panel('os')+' .opsActions button.outline');await waitRows('os',25);
 await page.select(panel('os')+' select[name="status"]','concluido');await page.click(panel('os')+' button[type="submit"]');await waitRows('os',1);
 check(/Concluído/.test(await text(panel('os')+' tbody')),'status filter');
 await page.select(panel('os')+' select[name="status"]','pendente,em_processamento');await page.click(panel('os')+' button[type="submit"]');await waitRows('os',25);
 check(clean(await text(panel('os')+' .servicePagination span'))==='Página 1 de 2 · 28 resultados','open orders filter');
 await page.click(panel('os')+' .opsActions button.outline');await waitPager('os','30 resultados');await waitRows('os',25);
 await page.screenshot({path:join(shots,'desktop-os.png'),fullPage:true});

 // CSV export through the UI: real download, BOM, header, row count and formula neutralisation
 await page.click('[data-ops="export-comma"]');
 let file=null;for(let i=0;i<60&&!file;i++){file=readdirSync(downloads).find(f=>/^os-\d{8}-\d{4}\.csv$/.test(f));if(!file)await delay(250)}
 check(file,'CSV download not received: '+readdirSync(downloads).join(','));
 const bytes=readFileSync(join(downloads,file)),csv=bytes.toString('utf8');
 check(bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF,'csv BOM');
 check(csv.split('\r\n').filter(Boolean).length===31&&csv.includes('id,criado_em,atualizado_em,cliente')&&csv.includes('"\'=HYPERLINK('),'csv content');
 await page.type(panel('os')+' input[name="q"]','Bruno');await page.keyboard.press('Enter');await waitRows('os',1);

 // Rascunhos: counts, redaction, kind filter
 await openTab('rascunhos');await waitRows('rascunhos',3);
 const drafts=await text(panel('rascunhos'));
 for(const secret of ['SECRET-USER-777','SECRET-LICENSE-123','nota privada','Vivo'])check(!drafts.includes(secret),'draft panel leaks '+secret);
 check(/license_key/.test(drafts)&&/Network/.test(drafts)&&/356938035643809/.test(drafts)&&/c2@example\.test/.test(drafts),'draft field names and identifiers');
 check(JSON.stringify((await page.$$eval(panel('rascunhos')+' .opsChips button',list=>list.map(b=>b.innerText))).map(clean))===JSON.stringify(['Todos (3)','IMEI (1)','Server (1)','API (0)','Legado (1)']),'draft kind chips');
 await page.click(panel('rascunhos')+' [data-kind="server"]');await waitRows('rascunhos',1);
 check(/Server Credits/.test(await text(panel('rascunhos')+' tbody')),'draft kind filter');

 // Auditoria: the export made above is searchable
 await openTab('auditoria');await page.waitForFunction(sel=>[...document.querySelectorAll(sel+' select[name="entity"] option')].some(o=>o.value==='export'),{},panel('auditoria'));
 await page.select(panel('auditoria')+' select[name="entity"]','export');await page.click(panel('auditoria')+' button[type="submit"]');await waitRows('auditoria',1);
 check(/orders_csv/.test(await text(panel('auditoria')+' tbody'))&&/by=ops-ui-admin;rows=30/.test(await text(panel('auditoria')+' tbody')),'export audit row');
 await page.screenshot({path:join(shots,'desktop-auditoria.png'),fullPage:true});

 // Returning to a tab keeps its filters and refreshes the data
 await openTab('os');await waitRows('os',1);
 check(await page.$eval(panel('os')+' input[name="q"]',el=>el.value)==='Bruno'&&/Bruno Lima/.test(await text(panel('os')+' tbody')),'filters kept when returning to the tab');

 // Mobile (switching to mobile emulation reloads the page; the session cookie is kept): the dock entry opens the
 // page, the dock stays on a single row and nothing overflows horizontally
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await page.waitForSelector('.mobileDock .opsDockButton',{visible:true});
 const dock=await page.$$eval('.mobileDock button',list=>list.map(b=>Math.round(b.getBoundingClientRect().top)));
 check(dock.length===6&&new Set(dock).size===1,'dock on one row: '+dock.join(','));
 check(await page.$$eval('.mobileDock button',list=>list.every(b=>b.querySelector('span').scrollWidth<=b.clientWidth+1)),'dock labels must fit inside their buttons');
 await page.click('.mobileDock .opsDockButton');
 await page.waitForFunction(sel=>document.querySelectorAll(sel+' .metricvalue').length===4,{},panel('resumo'));
 check(await page.$eval('.mobileDock .opsDockButton',b=>b.classList.contains('active')&&b.getAttribute('aria-current')==='page'),'dock entry marked as current');
 await page.screenshot({path:join(shots,'mobile-resumo.png'),fullPage:true});
 await openTab('os');await waitRows('os',25);
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'no horizontal page overflow on mobile');
 await page.screenshot({path:join(shots,'mobile-os.png'),fullPage:true});
 check(!problems.length,'browser problems: '+problems.join(' | '));

 // Non-admin: no navigation entry and the API refuses
 adminFlow=false;
 await page.setViewport({width:1440,height:900});
 await page.waitForSelector('.logout');await page.click('.logout');await login('ops-ui-viewer');
 check(!(await page.$('.opsNavButton'))&&!(await page.$('.opsDockButton'))&&!(await page.$('.opsPage')),'non-admin must not see the operations entry');
 check(await page.evaluate(()=>fetch('/api/admin/ops/summary').then(r=>r.status))===403,'non-admin API access must be 403');
 check(!problems.length,'browser problems: '+problems.join(' | '));
 console.log('ADMIN_OPS_UI_PASS: login, summary, pagination, filters, CSV download, redacted drafts, audit, kept filters, mobile dock, non-admin denied');
}finally{
 if(browser)await browser.close().catch(()=>{});
 if(child){child.kill('SIGTERM');await delay(150)}
 rmSync(temp,{recursive:true,force:true});
}
