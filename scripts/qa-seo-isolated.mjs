#!/usr/bin/env node
// Isolated check for robots.txt, sitemap.xml, favicon.ico and the www -> canonical host redirect.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..');
const check=(ok,msg)=>{if(!ok)throw Error('SEO_FAIL: '+msg);console.log('ok -',msg)};
const temp=mkdtempSync(join(tmpdir(),'ws-seo-'));let child;
const get=(port,path,host,method='GET')=>new Promise((ok,ko)=>{const r=request({host:'127.0.0.1',port,path,method,headers:{Host:host}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>ok({status:res.statusCode,headers:res.headers,body:b}))});r.on('error',ko);r.end()});
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});if(existsSync(join(root,'dist')))cpSync(join(root,'dist'),join(temp,'dist'),{recursive:true});
 mkdirSync(join(temp,'data'));symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const port=38700+Math.floor(Math.random()*150);
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',APP_ORIGIN:'https://unlockertools.tech',DEMO_MODE:'false'},stdio:'ignore'});
 let ready=false;for(let i=0;i<60;i++){try{if((await get(port,'/api/health','unlockertools.tech')).status===200){ready=true;break}}catch{}await delay(150)}
 check(ready,'server started');
 const robots=await get(port,'/robots.txt','unlockertools.tech');
 check(robots.status===200&&/^text\/plain/.test(robots.headers['content-type'])&&robots.body.includes('Disallow: /api/')&&robots.body.includes('Disallow: /admin')&&robots.body.includes('Sitemap: https://unlockertools.tech/sitemap.xml'),'robots.txt blocks private areas and points to the sitemap');
 const map=await get(port,'/sitemap.xml','unlockertools.tech');
 check(map.status===200&&/xml/.test(map.headers['content-type'])&&map.body.includes('<loc>https://unlockertools.tech/services</loc>')&&!map.body.includes('/client')&&!map.body.includes('/admin'),'sitemap.xml lists only public pages');
 const fav=await get(port,'/favicon.ico','unlockertools.tech');
 check(fav.status===301&&fav.headers.location==='/unlocker-tools-mark.svg','favicon.ico redirects to the SVG mark');
 const www=await get(port,'/services?q=1','www.unlockertools.tech');
 check(www.status===301&&www.headers.location==='https://unlockertools.tech/services?q=1','www host redirects to the canonical origin keeping path and query');
 check((await get(port,'/services','unlockertools.tech')).status===200,'canonical host served normally');
 check((await get(port,'/api/health','www.unlockertools.tech','POST')).status!==301,'non-GET requests are not redirected');
 console.log('SEO_PASS: robots.txt, sitemap.xml, favicon.ico, canonical www redirect');
}finally{if(child){child.kill('SIGTERM');await delay(150)}rmSync(temp,{recursive:true,force:true})}
