import puppeteer from 'puppeteer-core';

const base=(process.env.WEB_INSPECT_URL||'https://websystem-unlocker-demo.onrender.com').replace(/\/$/,'');
const chrome=process.env.CHROME_PATH||'/usr/bin/google-chrome';
const failures=[];
const check=(condition,message)=>{console.log((condition?'PASS':'FAIL')+' '+message);if(!condition)failures.push(message)};
const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
  for(const width of [390,1280]){
    const page=await browser.newPage();
    await page.setViewport({width,height:850,deviceScaleFactor:1});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto(base,{waitUntil:'networkidle2',timeout:60000});
    check([200,304].includes(response?.status()),`HTTP 200 · viewport ${width}px`);
    check(errors.length===0,`Sem erros JavaScript · ${width}px${errors.length?' ('+errors.join('; ')+')':''}`);
    check(await page.evaluate(()=>[...document.querySelectorAll('h2')].some(x=>x.textContent.includes('Entrar na conta'))),`Login renderizado · ${width}px`);
    check(await page.$('#ws-username')!==null&&await page.$('#ws-password')!==null,`Campos de login · ${width}px`);
    check(await page.evaluate(()=>{const logo=document.querySelector('.loginBrandLogo');return !!logo&&logo.tagName.toLowerCase()==='svg'&&!!logo.querySelector('path')}),`Marca vetorial visível · ${width}px`);
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),`Sem overflow horizontal · ${width}px`);
    if(width===390){
      await page.evaluate(()=>document.querySelector('button[aria-label="Mostrar senha"]')?.click());
      check(await page.$eval('#ws-password',e=>e.type)==='text','Alternar visibilidade da senha');
    }
    await page.close();
  }
  const health=await fetch(base+'/api/health');
  check(health.ok&&((await health.json()).ok===true),'API health');
  const privateResponse=await fetch(base+'/api/orders');
  check(privateResponse.status===401,'API privada bloqueada sem login');
}finally{await browser.close()}
if(failures.length){console.error('Web Inspector: '+failures.length+' falha(s)');process.exitCode=1}else console.log('Web Inspector: verificações concluídas com sucesso');
