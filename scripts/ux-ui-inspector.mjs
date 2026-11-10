#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const root=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);const idx=args.indexOf('--base');
const base=idx<0?'http://127.0.0.1:39879':args[idx+1];
if(!/^https?:\/\//.test(base))throw Error('Expected --base http(s)://...');
const local=idx<0;let server;
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const dir=join(root,'reports','ux-ui',stamp);mkdirSync(dir,{recursive:true});
const pages=[['home','/'],['services','/services'],['client','/client/'],['register','/client/?view=register'],['forgot','/client/?view=forgot'],['wallet','/client/wallet']];
const sizes=[['mobile',390,844],['tablet',768,1024],['desktop',1440,900]];
const report={agent:'UX/UI Inspector&Designer',base,created_at:new Date().toISOString(),results:[]};
try{
 if(local){server=spawn(process.execPath,['api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:'39879',APP_ORIGIN:'https://unlockertools.tech',ADMIN_ALLOWED_IPS:'127.0.0.1'},stdio:'ignore'});let ready=false;for(let i=0;i<40;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await sleep(250)}if(!ready)throw Error('Local preview did not start')}
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server']});
 try{
  for(const [size,width,height] of sizes){for(const [name,path] of pages){const page=await browser.newPage();const errors=[];const failures=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
   await page.setViewport({width,height,deviceScaleFactor:1});
   try{const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:15000});await sleep(350);
    const audit=await page.evaluate(()=>{const doc=document.documentElement;const imgs=[...document.images];const forms=[...document.querySelectorAll('form')];const links=[...document.querySelectorAll('a[href]')];return {title:document.title,viewport:innerWidth,scroll_width:doc.scrollWidth,overflow:doc.scrollWidth>innerWidth+1,headings:[...document.querySelectorAll('h1')].map(x=>x.textContent.trim()),broken_images:imgs.filter(x=>!x.complete||x.naturalWidth===0).map(x=>x.src),forms:forms.length,unlabeled_inputs:[...document.querySelectorAll('input:not([type="hidden"]),textarea,select')].filter(x=>!x.labels?.length&&!x.getAttribute('aria-label')&&!x.getAttribute('aria-labelledby')).map(x=>x.name||x.id||x.outerHTML.slice(0,100)),small_click_targets:[...document.querySelectorAll('button,a')].filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0&&(r.width<24||r.height<24)}).slice(0,12).map(x=>x.textContent.trim().slice(0,50)),empty_links:links.filter(x=>x.getAttribute('href')==='#').length,logo:imgs.some(x=>x.src.includes('unlocker-tools-mark.svg'))}});
    const filename=`${size}-${name}.png`;await page.screenshot({path:join(dir,filename),fullPage:true});report.results.push({size,page:name,path,status:response?.status(),...audit,errors,failures,screenshot:filename});console.log(`${size.padEnd(8)} ${name.padEnd(9)} ${response?.status()} overflow=${audit.overflow} broken_images=${audit.broken_images.length} js_errors=${errors.length}`);
   }catch(e){report.results.push({size,page:name,path,error:e.message});console.error(size,name,e.message)}finally{await page.close()}
  }}
 }finally{await browser.close()}
}finally{if(server)server.kill();writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));const bad=report.results.filter(x=>x.error||x.overflow||x.broken_images?.length||x.errors?.length||x.status!==200);writeFileSync(join(dir,'SUMMARY.md'),`# UX/UI Inspection — ${report.created_at}\n\nTarget: ${base}\n\nPages inspected: ${report.results.length}\nPotential issues: ${bad.length}\n\n${bad.map(x=>`- ${x.size} ${x.path}: ${JSON.stringify({error:x.error,status:x.status,overflow:x.overflow,broken_images:x.broken_images,js_errors:x.errors})}`).join('\n')}\n`);console.log('REPORT',dir,'ISSUES',bad.length)}
