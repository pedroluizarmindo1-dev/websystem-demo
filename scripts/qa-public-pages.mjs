#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
const base=(process.env.PUBLIC_BASE_URL||'https://unlockertools.tech').replace(/\/$/,'');
const pages=['/','/services','/consulta.html','/login','/client/','/client/orders','/client/support','/client/wallet','/privacy.html','/terms.html','/refunds.html'];
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
let failed=0;
try{
 for(const width of [390,1280]){
  const page=await browser.newPage();await page.setViewport({width,height:844});
  for(const path of pages){
   const errors=[];const onError=e=>errors.push(e.message);page.on('pageerror',onError);
   try{
    const response=await page.goto(base+path,{waitUntil:'networkidle2',timeout:30000});
    const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+2,title:document.title,body:document.body.innerText.length}));
    const ok=response.status()===200&&!metrics.overflow&&!errors.length&&metrics.body>20;
    console.log(ok?'PASS':'FAIL',width,path,'HTTP',response.status(),'overflow',metrics.overflow,'errors',errors.length,'body',metrics.body);
    if(!ok)failed++;
   }catch(e){console.error('FAIL',width,path,e.message);failed++}
   page.off('pageerror',onError);
  }
  await page.close();
 }
}finally{await browser.close()}
if(failed){console.error('PUBLIC_PAGES_FAIL',failed);process.exitCode=1}else console.log('PUBLIC_PAGES_PASS',pages.length*2);
