import puppeteer from 'puppeteer-core';

const base=(process.env.WEB_INSPECT_URL||'https://unlockertools.tech').replace(/\\/$/,'');
const chrome=process.env.CHROME_PATH||'/usr/bin/google-chrome';
const failures=[];
const check=(condition,message)=>{console.log((condition?'PASS':'FAIL')+' '+message);if(!condition)failures.push(message)};
// Unauthenticated public probes may be stopped by the Admin IP Gate (404/503)
// before reaching session auth (401); a role denial may return 403.
const isProtectedStatus=status=>[401,403,404,503].includes(status);
const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
  // Production admin UI is intentionally restricted to allowlisted IPs.
  // Inspect public pages remotely; admin UI has dedicated isolated authenticated QA.
  for(const width of [390,1280]){
    const page=await browser.newPage();
    await page.setViewport({width,height:850,deviceScaleFactor:1});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto(base+'/',{waitUntil:'networkidle2',timeout:60000});
    check(response?.status()===200,`Public homepage HTTP 200 · viewport ${width}px`);
    check(errors.length===0,`Homepage JavaScript clean · ${width}px${errors.length?' ('+errors.join('; ')+')':''}`);
    check((await page.title()).length>0,`Homepage title · ${width}px`);
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),`Homepage no horizontal overflow · ${width}px`);
    await page.close();
  }
  const admin=await fetch(base+'/admin/',{redirect:'manual'});
  check([403,404,503].includes(admin.status),'Admin page restricted from public runner');
  const auth=await fetch(base+'/api/auth/me');
  check([403,404,503].includes(auth.status),'Admin authentication restricted from public runner');
  const health=await fetch(base+'/api/health');
  check(health.ok&&((await health.json()).ok===true),'API health');
  const privateResponse=await fetch(base+'/api/orders');
  check(isProtectedStatus(privateResponse.status),`API privada protegida · HTTP ${privateResponse.status}`);
  const supplier=await fetch(base+'/api/integrations/imeive/status');
  check(isProtectedStatus(supplier.status),`Fornecedor protegido · HTTP ${supplier.status}`);
  const readiness=await fetch(base+'/api/readiness');
  check(isProtectedStatus(readiness.status),`Diagnóstico de produção protegido · HTTP ${readiness.status}`);
  const publicPage=await browser.newPage();
  await publicPage.setViewport({width:390,height:844});
  const publicErrors=[];publicPage.on('pageerror',e=>publicErrors.push(e.message));
  const publicResponse=await publicPage.goto(base+'/consulta.html',{waitUntil:'networkidle2',timeout:60000});
  check(publicResponse?.status()===200,'Consulta pública HTTP 200');
  check(await publicPage.$('#code')!==null,'Consulta pública possui código de acesso');
  check(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Consulta pública responsiva');
  check(publicErrors.length===0,'Consulta pública sem erros JavaScript');
  await publicPage.close();
  const invalid=await fetch(base+'/api/public/order-lookup',{method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.APP_ORIGIN||'https://unlockertools.tech'},body:JSON.stringify({id:1,token:'0'.repeat(64)})});
  check(invalid.status===404||invalid.status===429,'Consulta pública rejeita token não autorizado');
}finally{await browser.close()}
if(failures.length){console.error('Web Inspector: '+failures.length+' falha(s)');process.exitCode=1}else console.log('Web Inspector: verificações concluídas com sucesso');
