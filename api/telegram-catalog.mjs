// Public Telegram channel catalog importer. No HeartUnlocks credentials are used.
const CHANNEL='PriceNotification';
const ROOT='https://t.me/s/'+CHANNEL;
const unescape=s=>s.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#\d+);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&nbsp;':' ','&#39;':"'" }[x]|| (x.startsWith('&#')?String.fromCodePoint(Number(x.slice(2,-1))):x)));
const strip=s=>unescape(s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
const category=name=>{
 const n=name.toLowerCase();
 if(/gift card|voucher|itunes|google play card|amazon card/.test(n))return 'Gift Cards';
 if(/icloud|fmi|find my iphone|apple id/.test(n))return 'Apple · iCloud / FMI';
 if(/imei|gsx|serial|sold.by|warranty|check|carrier info|blacklist|status report/.test(n))return 'Consultas IMEI / GSX';
 if(/network unlock|sim unlock|carrier unlock|operator unlock|flex policy|simlock|unlock code/.test(n))return 'Desbloqueio de rede';
 if(/frp|factory reset protection|google account|mi account/.test(n))return 'FRP / Contas';
 if(/mdm|knox|payjoy|it admin|finance lock/.test(n))return 'MDM / Gerenciamento';
 if(/flash|auth|edl|brom|preloader|otp/.test(n))return 'Flash / Autorização';
 if(/server|credit|balance|api|reseller/.test(n))return 'Créditos / API';
 if(/tool|license|licence|activation|subscription|renewal|dongle|box|register|user|rent/.test(n))return 'Ferramentas / Licenças';
 if(/iphone|ipad|apple|ios/.test(n))return 'Apple · Outros';
 if(/samsung|xiaomi|oppo|realme|vivo|motorola|pixel|huawei|honor|oneplus/.test(n))return 'Android · Outros';
 return 'Outros serviços';
};
const brand=name=>['Samsung','Xiaomi','OPPO','Realme','Vivo','Motorola','Huawei','Honor','OnePlus','Google Pixel','Apple','iPhone','iPad'].find(b=>name.toLowerCase().includes(b.toLowerCase()))||'';
const parsePost=(block)=>{
 const id=Number(block.match(/data-post="PriceNotification\/(\d+)"/)?.[1]);if(!id)return [];
 const body=block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];if(!body)return [];
 const dt=block.match(/<time[^>]*datetime="([^"]+)"/)?.[1]||null;
 const lines=body.replace(/<br\s*\/?\s*>/gi,'\n').split('\n').map(s=>s.trim()).filter(Boolean);
 const items=[];let current=null;
 for(const line of lines){
  if(/Date:\s*\d{4}/i.test(line))break;
  const match=line.match(/<a\b[^>]*href="([^"]*heartunlocks\.com\/product\/\?alias=[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if(match){
   const name=strip(match[2]).replace(/^•\s*/,'');
   if(name.length>=3&&name.length<=300){
    const alias=match[1].match(/[?&]alias=([^&"\s]+)/)?.[1]||'';
    current={name,alias,post_id:id,post_url:'https://t.me/'+CHANNEL+'/'+id,date:dt};
    items.push(current);
   }continue;
  }
  if(!current)continue;
  const prices=[...strip(line).matchAll(/(\d+(?:\.\d+)?)\s*USD/gi)].map(m=>Number(m[1]));
  if(prices.length)current.price_usd=prices[prices.length-1];
 }
 return items.filter(x=>Number.isFinite(x.price_usd)&&x.price_usd>=0&&x.alias);
};
const fetchPage=async(before)=>{
 const url=ROOT+(before?'?before='+before:'');
 const res=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'Mozilla/5.0 (compatible; WebSystemCatalog/1.0)'}});
 if(!res.ok)throw Error('Telegram HTTP '+res.status);
 const html=await res.text();
 const blocks=html.split(/(?=<div class="tgme_widget_message_wrap)/);
 const ids=[...html.matchAll(/data-post="PriceNotification\/(\d+)"/g)].map(m=>Number(m[1]));
 return {items:blocks.flatMap(parsePost),oldest:ids.length?Math.min(...ids):null,posts:ids.length};
};
let state={running:false,pages:0,posts:0,services:0,error:null,finished:false,startedAt:null,completedAt:null};
export const getCatalogSyncStatus=()=>({...state});
export async function syncEntireCatalog(db,{maxPages=200}={}){
 if(state.running)return getCatalogSyncStatus();
 state={running:true,pages:0,posts:0,services:0,error:null,finished:false,startedAt:new Date().toISOString(),completedAt:null};
 const upsert=db.prepare(`INSERT INTO services(external_id,source,name,category,brand,model,price_usd,available,eta,updated_at)
 VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
 ON CONFLICT(external_id) DO UPDATE SET name=excluded.name,category=excluded.category,brand=excluded.brand,price_usd=excluded.price_usd,updated_at=CURRENT_TIMESTAMP`);
 // Read oldest first in the collected page; preserve newest message for duplicate product aliases.
 const latest=new Map();
 let before=null;
 try{
  for(let page=0;page<maxPages;page++){
   const result=await fetchPage(before);
   if(!result.oldest||!result.posts)break;
   state.pages++;state.posts+=result.posts;
   for(const item of result.items){
    const key=item.alias.toLowerCase();
    if(!latest.has(key))latest.set(key,item);
   }
   // Incrementally save so partial progress remains useful if Telegram rate limits.
   for(const item of result.items){
    const key=item.alias.toLowerCase();
    if(latest.get(key)!==item)continue;
    const existing=db.prepare('SELECT id FROM services WHERE external_id=?').get('telegram:heartunlocks:'+key);
    upsert.run('telegram:heartunlocks:'+key,'telegram-announcement',item.name,category(item.name),brand(item.name),'',item.price_usd,0,'Preço anunciado; disponibilidade não confirmada');
    if(!existing)state.services++;
   }
   if(result.oldest<=1||result.oldest===before)break;
   before=result.oldest;
   // Yield between requests; avoid hammering the public channel.
   await new Promise(r=>setTimeout(r,350));
  }
  state.finished=true;
 }catch(e){state.error=e.message;console.error('Telegram catalog import:',e.message)}
 finally{state.running=false;state.completedAt=new Date().toISOString()}
 return getCatalogSyncStatus();
}
