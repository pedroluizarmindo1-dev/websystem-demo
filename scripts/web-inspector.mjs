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
  const supplier=await fetch(base+'/api/integrations/imeive/status');
  check(supplier.status===401,'Fornecedor protegido sem login');
  const readiness=await fetch(base+'/api/readiness');
  check(readiness.status===401,'Diagnóstico de produção protegido sem login');
  const publicPage=await browser.newPage();
  await publicPage.setViewport({width:390,height:844});
  const publicErrors=[];publicPage.on('pageerror',e=>publicErrors.push(e.message));
  const publicResponse=await publicPage.goto(base+'/consulta.html',{waitUntil:'networkidle2',timeout:60000});
  check(publicResponse?.status()===200,'Consulta pública HTTP 200');
  check(await publicPage.$('#code')!==null,'Consulta pública possui código de acesso');
  check(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Consulta pública responsiva');
  check(publicErrors.length===0,'Consulta pública sem erros JavaScript');
  await publicPage.close();
  const invalid=await fetch(base+'/api/public/order-lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:1,token:'0'.repeat(64)})});
  check(invalid.status===404||invalid.status===429,'Consulta pública rejeita token não autorizado');
}finally{await browser.close()}
if(failures.length){console.error('Web Inspector: '+failures.length+' falha(s)');process.exitCode=1}else console.log('Web Inspector: verificações concluídas com sucesso');
