#!/usr/bin/env node
// Read-only layout audit of the public pages (GET requests only, no login, no forms submitted).
// Usage: node scripts/qa-layout-audit.mjs [base-url]   (default: isolated local server started from dist/)
// For each page at 1440x900 and 390x844 it reports: HTTP status, horizontal overflow, elements wider than the viewport,
// JS/CSP errors, failed same-origin requests, broken images, images without alt, inputs without label, h1 count,
// tap targets smaller than 40px on phones and text smaller than 11px. Screenshots go to reports/layout-audit/.
// Exit 1 when a blocking problem is found (status >= 400, overflow, JS/CSP error, broken image, 0 or 2+ h1).
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const root=resolve(import.meta.dirname,'..');
const chrome=[process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome'].find(p=>p&&existsSync(p));
if(!chrome){console.error('LAYOUT_AUDIT_BLOCKED: Chrome not found (set CHROME_PATH)');process.exit(2)}
const shots=join(root,'reports','layout-audit');mkdirSync(shots,{recursive:true});
let base=process.argv[2]||'',child,temp;
const PAGES=['/','/services','/consulta','/client/','/client/?view=register','/client/?view=forgot','/client/wallet','/terms.html','/privacy.html','/refunds.html','/pagina-inexistente'];
const report=[];let blocking=0;
try{
 if(!base){
  if(!existsSync(join(root,'dist','home.html'))){console.error('LAYOUT_AUDIT_BLOCKED: dist/ missing, run "npm run build" first');process.exit(2)}
  temp=mkdtempSync(join(tmpdir(),'ws-layout-'));
  cpSync(join(root,'api'),join(temp,'api'),{recursive:true});cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});mkdirSync(join(temp,'data'));
  symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
  const port=String(37500+Math.floor(Math.random()*300));base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:base,DEMO_MODE:'false',COOKIE_SECURE:'false',WALLET_REQUESTS_ENABLED:'false'},stdio:'ignore'});
  let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}
  if(!ready)throw Error('LAYOUT_AUDIT_FAIL: server did not start');
 }
 const origin=new URL(base).origin;
 const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--lang=pt-BR']});
 for(const [vp,width,height,mobile] of [['desktop',1440,900,false],['phone',390,844,true]]){
  for(const path of PAGES){
   const ctx=await browser.createBrowserContext();const page=await ctx.newPage();page.setDefaultTimeout(20000);
   await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('ut_locale','pt-BR')}catch{}});
   await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile});
   const errors=[],failed=[];
   page.on('pageerror',e=>errors.push('js: '+e.message.slice(0,140)));
   page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errors.push('console: '+m.text().slice(0,140))});
   page.on('response',r=>{const u=new URL(r.url());if(u.origin===origin&&r.status()>=400&&!u.pathname.startsWith('/api/client/')&&u.pathname!==new URL(base+path).pathname)failed.push(r.status()+' '+u.pathname)});
   page.on('requestfailed',r=>{const u=new URL(r.url());if(u.origin===origin)failed.push('failed '+u.pathname)});
   let status=0;try{const res=await page.goto(base+path,{waitUntil:'networkidle2'});status=res?.status()||0}catch(e){errors.push('navigation: '+e.message.slice(0,100))}
   await delay(400);
   const m=await page.evaluate(mob=>{
    const vw=document.documentElement.clientWidth;const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};
    const all=[...document.body.querySelectorAll('*')].filter(vis);
    const wide=all.filter(e=>{const r=e.getBoundingClientRect();return r.right>vw+1&&getComputedStyle(e).position!=='fixed'&&!e.closest('[style*="overflow"],.ut-scroll,[data-scroll]')&&!['auto','scroll','hidden'].includes(getComputedStyle(e.parentElement).overflowX)}).slice(0,5).map(e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\s+/).slice(0,2).join('.'):'')+'→'+Math.round(e.getBoundingClientRect().right));
    const imgs=[...document.images];
    const inputs=[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(vis);
    const unlabeled=inputs.filter(i=>!(i.labels&&i.labels.length)&&!i.getAttribute('aria-label')&&!i.getAttribute('aria-labelledby')&&!i.title).map(i=>i.name||i.id||i.type);
    const taps=mob?[...document.querySelectorAll('a,button,select,input[type=checkbox],input[type=radio],summary')].filter(vis).filter(e=>{const r=e.getBoundingClientRect();return r.height<40&&!e.classList.contains('hp-skip')&&!e.classList.contains('ss-skip')&&!(e.tagName==='A'&&e.closest('p,li,small'))}).slice(0,8).map(e=>(e.textContent||e.getAttribute('aria-label')||e.tagName).trim().slice(0,24)+'('+Math.round(e.getBoundingClientRect().height)+')'):[];
    const tiny=all.filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.nodeValue.trim())&&parseFloat(getComputedStyle(e).fontSize)<11&&parseFloat(getComputedStyle(e).fontSize)>0).slice(0,6).map(e=>e.textContent.trim().slice(0,24)+'('+getComputedStyle(e).fontSize+')');
    return {title:document.title,lang:document.documentElement.lang,overflow:document.documentElement.scrollWidth>vw+1,scrollWidth:document.documentElement.scrollWidth,wide,h1:document.querySelectorAll('h1').length,visibleH1:[...document.querySelectorAll('h1')].filter(vis).length,brokenImg:imgs.filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.src.slice(-40)),noAlt:imgs.filter(i=>!i.hasAttribute('alt')).length,unlabeled,taps,tiny,height:document.documentElement.scrollHeight,viewportMeta:!!document.querySelector('meta[name=viewport]'),description:!!document.querySelector('meta[name=description]')};
   },mobile);
   const slug=(path.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'home');
   await page.screenshot({path:join(shots,vp+'-'+slug+'.png'),fullPage:true}).catch(()=>{});
   const expect404=path==='/pagina-inexistente';
   const block=[];
   if(expect404?status!==404:status>=400)block.push('status '+status);
   if(m.overflow)block.push('overflow '+m.scrollWidth+'px '+m.wide.join(' '));
   if(errors.length)block.push(...errors);
   if(m.brokenImg.length)block.push('broken img '+m.brokenImg.join(','));
   if(!expect404&&m.visibleH1!==1)block.push('visible h1='+m.visibleH1);
   const warn=[];
   if(failed.length)warn.push('requests: '+[...new Set(failed)].join(', '));
   if(m.noAlt)warn.push('img without alt: '+m.noAlt);
   if(m.unlabeled.length)warn.push('inputs without label: '+m.unlabeled.join(','));
   if(m.taps.length)warn.push('small tap targets: '+m.taps.join(' | '));
   if(m.tiny.length)warn.push('text <11px: '+m.tiny.join(' | '));
   if(!m.description&&!expect404)warn.push('no meta description');
   if(!m.viewportMeta)block.push('no viewport meta');
   blocking+=block.length;
   report.push({viewport:vp,path,status,title:m.title,lang:m.lang,height:m.height,block,warn});
   console.log((block.length?'FAIL ':warn.length?'WARN ':'OK   ')+vp.padEnd(8)+path.padEnd(24)+status+' '+[...block,...warn].join(' ; '));
   await ctx.close();
  }
 }
 await browser.close();
 writeFileSync(join(shots,'report.json'),JSON.stringify({base,at:new Date().toISOString(),report},null,1));
 console.log(blocking?'LAYOUT_AUDIT_FAIL: '+blocking+' blocking problem(s)':'LAYOUT_AUDIT_PASS: '+report.length+' page checks');
 process.exitCode=blocking?1:0;
}finally{
 if(child){child.kill('SIGTERM');await delay(150)}
 if(temp)rmSync(temp,{recursive:true,force:true});
}
