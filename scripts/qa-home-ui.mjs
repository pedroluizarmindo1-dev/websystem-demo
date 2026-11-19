#!/usr/bin/env node
// Browser regression for the public home page (public/home.html) with headless Chrome against an isolated server with
// fictitious catalog rows: renders on desktop, tablet and phone without horizontal overflow, JavaScript errors or CSP
// violations; the hero search reaches the catalog; catalog, chips and the phone menu work. Requires `npm run build`
// and a local Chrome (CHROME_PATH). Throw-away copy of api/ + dist/; no supplier or payment contact.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';

const root=resolve(import.meta.dirname,'..');
const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome'].find(p=>p&&existsSync(p));
if(!chrome){console.error('HOME_UI_BLOCKED: Chrome not found (set CHROME_PATH)');process.exit(2)}
if(!existsSync(join(root,'dist','home.html'))){console.error('HOME_UI_BLOCKED: dist/ missing, run "npm run build" first');process.exit(2)}
const temp=mkdtempSync(join(tmpdir(),'ws-home-ui-')),port=String(37500+Math.floor(Math.random()*400)),base='http://127.0.0.1:'+port;
const check=(ok,msg)=>{if(!ok)throw Error('HOME_UI_FAIL: '+msg)};
let child,browser;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});mkdirSync(join(temp,'data'));
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false'},stdio:'ignore'});
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}
 check(ready,'server did not start');
 const db=new DatabaseSync(join(temp,'data','websystem.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 const ins=db.prepare('INSERT INTO services(name,category,brand,model,price_usd,eta,available) VALUES (?,?,?,?,?,?,1)');
 for(const r of [['QA iCloud Check','Apple · iCloud / FMI','Apple','iPhone',1,'1-5 min'],['QA FRP Samsung','FRP / Contas','Samsung','Galaxy',5,'1-2 h'],['QA FRP Xiaomi','FRP / Contas','Xiaomi','Redmi',6,'1 dia'],['QA License 3 months','Ferramentas / Licenças','QA Tool','',9,'Imediato']])ins.run(...r);
 db.close();
 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--lang=pt-BR']});
 for(const [name,width,height,mobile] of [['desktop',1440,900,false],['tablet',820,1180,true],['phone',390,844,true]]){
  const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','pt-BR')}catch{}});
  const problems=[];
  page.on('pageerror',e=>problems.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to/i.test(m.text()))problems.push('csp: '+m.text().slice(0,160))});
  page.on('response',r=>{if(r.status()>=400&&new URL(r.url()).origin===base)problems.push(r.status()+' '+new URL(r.url()).pathname)});
  await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelectorAll('#catalog-results .ut-catalog-card').length===4);
  check(await page.$$eval('#catalog-chips button',b=>b.length)===4,name+': category chips (Todas + 3 categories)');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': horizontal overflow');
  check(await page.$eval('h1',h=>h.getBoundingClientRect().top<innerHeight&&h.textContent.includes('Serviços GSM')),name+': hero headline above the fold');
  check(await page.$eval('#search',e=>{const r=e.getBoundingClientRect();return r.width>120&&r.top<innerHeight}),name+': hero search visible above the fold');
  const nav=await page.$eval('.hp-nav',n=>getComputedStyle(n).display!=='none'),menu=await page.$eval('.hp-menu',m=>getComputedStyle(m).display!=='none');
  check(name==='desktop'?nav&&!menu:!nav&&menu,name+': desktop nav vs phone menu');
  if(menu){
   await page.click('.hp-menu summary');
   check(await page.$eval('.hp-menu-panel',p=>{const r=p.getBoundingClientRect();return r.height>200&&getComputedStyle(p).visibility!=='hidden'}),name+': menu opens');
   check(await page.$$eval('.hp-menu-panel a[href="/client/?view=register"]',a=>a.length)===1,name+': menu offers sign-up');
   await page.click('.hp-menu summary');
  }
  await page.click('#catalog-chips button:nth-child(2)');
  await page.waitForFunction(()=>document.querySelectorAll('#catalog-results .ut-catalog-card').length===2&&document.querySelector('#catalog-chips button:nth-child(2)')?.getAttribute('aria-pressed')==='true');
  await page.type('#search','Xiaomi');
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.keyboard.press('Enter')]);
  check(new URL(page.url()).searchParams.get('q')==='Xiaomi'&&page.url().endsWith('#catalogo'),name+': hero search goes to the catalog -> '+page.url());
  await page.waitForFunction(()=>document.querySelector('#catalog-search').value==='Xiaomi'&&document.querySelectorAll('#catalog-results .ut-catalog-card').length===1);
  check(await page.$eval('#catalog-results .ut-catalog-card a',a=>a.getAttribute('href').startsWith('/services/')),name+': card links to the service detail');
  check(!problems.length,name+': '+problems.join(' | '));
  await page.close();
 }
 console.log('HOME_UI_PASS: desktop, tablet and phone render without overflow, JS errors or CSP violations; hero search, catalog, chips and phone menu work');
}finally{
 if(browser)await browser.close().catch(()=>{});
 if(child){child.kill('SIGTERM');await delay(150)}
 rmSync(temp,{recursive:true,force:true});
}
