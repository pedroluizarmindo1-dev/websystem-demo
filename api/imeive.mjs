const endpoint='https://imeiveserver.com/api/index.php';
export async function supplierCall(action){
 const {IMEIVE_API_URL:url,IMEIVE_API_USERNAME:username,IMEIVE_API_KEY:key}=process.env;
 if(url!==endpoint||!username||!key)throw Error('Integração não configurada');
 const body=new URLSearchParams({username,apiaccesskey:key,requestformat:'JSON',action});
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw Error('Fornecedor HTTP '+response.status);
 const maxBytes=5*1024*1024;
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>maxBytes)throw Error('Resposta do fornecedor excede o limite permitido');
 const reader=response.body?.getReader();
 if(!reader)throw Error('Fornecedor retornou resposta vazia');
 const chunks=[];let total=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw Error('Resposta do fornecedor excede o limite permitido')}chunks.push(value)}
 }finally{reader.releaseLock()}
 const raw=new TextDecoder().decode(Buffer.concat(chunks.map(x=>Buffer.from(x)),total));let data;
 try{data=JSON.parse(raw)}catch{throw Error('Fornecedor retornou formato não JSON')}
 if(!Array.isArray(data.SUCCESS)||!data.SUCCESS.length)throw Error('Fornecedor: '+String(data.ERROR?.[0]?.MESSAGE||'Resposta sem confirmação de sucesso').slice(0,160));
 return data.SUCCESS;
}
export function normalizeCatalog(results,categoryType){
 const rows=[];
 for(const item of results){
  const groups=item.LIST||{};
  for(const [groupKey,group] of Object.entries(groups)){
   for(const [key,s] of Object.entries(group?.SERVICES||{})){
    const id=String(s.SERVICEID??key),name=String(s.SERVICENAME||'').trim(),price=Number(s.CREDIT);
    if(!id||!name||!Number.isFinite(price)||price<0)continue;
    rows.push({external_id:'imeive:'+id,source:'imeive',name,category:String(group.GROUPNAME||groupKey||categoryType).slice(0,180),brand:'',model:'',price_usd:price,eta:String(s.TIME||'').slice(0,100),available:1,metadata:JSON.stringify({serviceType:s.SERVICETYPE||categoryType,requires:Object.fromEntries(Object.entries(s).filter(([k])=>k.startsWith('Requires.')&&k!=='Requires.Custom')),form_fields:Array.isArray(s.form_fields)?s.form_fields:[],qnt:s.QNT||0}).slice(0,8000)});
   }
  }
 }
 return rows;
}
export async function syncSupplier(db){
 const account=(await supplierCall('accountinfo'))[0]?.AccoutInfo;
 if(!account)throw Error('Formato de informações da conta não reconhecido');
 const currency=String(account.currency||'').toUpperCase();
 if(currency!=='USD')throw Error('Moeda do fornecedor '+(currency||'desconhecida')+'; importação de preços suspensa');
 const groups=[];
 for(const action of ['imeiservicelist','serverservicelist','remoteservicelist']){
  groups.push(...normalizeCatalog(await supplierCall(action),action));
 }
 const unique=[...new Map(groups.map(x=>[x.external_id,x])).values()];
 if(!unique.length)throw Error('Catálogo vazio; nenhuma alteração aplicada');
 db.exec('CREATE TABLE IF NOT EXISTS supplier_service_fields(external_id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 db.exec('BEGIN');
 try{
  const upsert=db.prepare("INSERT INTO services(external_id,source,name,category,brand,model,price_usd,available,eta) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET name=excluded.name,category=excluded.category,price_usd=excluded.price_usd,available=1,eta=excluded.eta,updated_at=CURRENT_TIMESTAMP WHERE services.source='imeive'");
  const fieldUpsert=db.prepare('INSERT INTO supplier_service_fields(external_id,metadata_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(external_id) DO UPDATE SET metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP');
  for(const x of unique){upsert.run(x.external_id,x.source,x.name,x.category,x.brand,x.model,x.price_usd,x.available,x.eta);fieldUpsert.run(x.external_id,x.metadata)}
  const ids=unique.map(x=>x.external_id);
  const deactivate=db.prepare("UPDATE services SET available=0,updated_at=CURRENT_TIMESTAMP WHERE source='imeive' AND external_id=?");
  const old=db.prepare("SELECT external_id FROM services WHERE source='imeive'").all();
  const active=new Set(ids);
  for(const x of old)if(!active.has(x.external_id))deactivate.run(x.external_id);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
 return {imported:unique.length,currency,checked_at:new Date().toISOString()};
}