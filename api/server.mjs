import {priceService} from './pricing.mjs';
import {supplierCall,syncSupplier} from './imeive.mjs';
import {randomBytes,createHash} from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {mountCommerce} from './commerce.mjs';
import {mountClientArea} from './client-area.mjs';
import {mountWallet} from './wallet.mjs';
import {getAnnouncements} from './telegram-announcements.mjs';
import {syncEntireCatalog,getCatalogSyncStatus} from './telegram-catalog.mjs';
import {verify,issue,getSession,revoke} from './auth.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const app=express();app.disable('x-powered-by');
// Trust only the local Nginx reverse proxy; never accept arbitrary client-supplied forwarded IPs.
app.set('trust proxy','loopback');
const allowedAdminIPs=()=>String(process.env.ADMIN_ALLOWED_IPS||'').split(',').map(s=>s.trim()).filter(Boolean);
const adminIpGate=(req,res,next)=>{const allowed=allowedAdminIPs();if(!allowed.length)return res.status(503).send('Painel administrativo não configurado');if(!allowed.includes(req.ip))return res.status(404).send('Não encontrado');next()};
// Bounded in-memory rate limit (also enforce at reverse proxy for multi-worker deployments).
const buckets=new Map();let bucketChecks=0;
function rateLimit({max,windowMs,keyPrefix}){return(req,res,next)=>{const now=Date.now();if(++bucketChecks%500===0){for(const [k,v] of buckets)if(v.until<=now)buckets.delete(k)}const key=keyPrefix+':'+req.ip;let b=buckets.get(key);if(!b||b.until<=now){b={n:0,until:now+windowMs};buckets.set(key,b)}if(++b.n>max){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((b.until-now)/1000))));return res.status(429).json({error:'Muitas solicitações; tente novamente mais tarde'})}next()}}
app.use('/api',rateLimit({max:240,windowMs:60000,keyPrefix:'api'}));
app.use('/api/auth/login',adminIpGate,rateLimit({max:10,windowMs:15*60000,keyPrefix:'admin-auth'}));
app.use('/api/auth/me',adminIpGate);
app.use('/api/auth/logout',adminIpGate);
app.use('/api/admin',adminIpGate);

app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");if(req.secure)res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');if(req.path.startsWith('/api/')||req.path==='/login'||req.path.startsWith('/client/')||req.path.startsWith('/admin/'))res.setHeader('Cache-Control','no-store');next()});
app.use(express.json({limit:'128kb'}));app.use(cors({origin:false}));
// Browser session mutations must originate from the configured first-party origin.
app.use('/api',(req,res,next)=>{
 if(['GET','HEAD','OPTIONS'].includes(req.method)||req.path==='/dhru'||req.path.startsWith('/dhru/'))return next();
 const origin=req.headers.origin;
 if(!process.env.APP_ORIGIN||origin!==process.env.APP_ORIGIN)return res.status(403).json({error:'Origem não autorizada'});
 next();
});
const root=resolve(import.meta.dirname,'..');mkdirSync(resolve(root,'data'),{recursive:true});
const db=new DatabaseSync(resolve(root,'data','websystem.sqlite'));
db.exec(readFileSync(resolve(root,'api/schema.sql'),'utf8'));
const all=(sql,...params)=>db.prepare(sql).all(...params),get=(sql,...params)=>db.prepare(sql).get(...params);
const run=(sql,...params)=>db.prepare(sql).run(...params);
const config=()=>Object.fromEntries(all('SELECT key,value FROM settings').map(x=>[x.key,Number(x.value)]));
const quote=(usd,rate,margin,spread)=>Math.round(((Number(usd)*Number(rate))*(1+Number(margin)/100)+Number(spread))*100)/100;
const wrap=fn=>(req,res)=>{try{fn(req,res)}catch(e){res.status(400).json({error:e.message})}};
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').map(decodeURIComponent)).filter(a=>a.length===2));
const session=req=>getSession(cookies(req).ws_session);
const guard=(req,res,next)=>{const user=session(req);if(!user)return res.status(401).json({error:'Login necessário'});req.user=user;next()};
const adminOnly=(req,res,next)=>guard(req,res,()=>req.user.role==='admin'?next():res.status(403).json({error:'Acesso restrito'}));
db.exec(`CREATE TABLE IF NOT EXISTS security_events(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,ip TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
// Persistent IP abuse protection survives container restarts; tokens and passwords are never logged.
db.exec(`CREATE TABLE IF NOT EXISTS auth_ip_limits(ip TEXT NOT NULL,route TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,window_until INTEGER NOT NULL DEFAULT 0,blocked_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(ip,route))`);
app.use(['/api/auth/login','/api/client/login'],(req,res,next)=>{
 const ip=String(req.ip||'unknown').slice(0,90),route=req.path,now=Date.now();
 const q=db.prepare('SELECT failures,window_until,blocked_until FROM auth_ip_limits WHERE ip=? AND route=?').get(ip,route);
 if(q?.blocked_until>now){res.setHeader('Retry-After',String(Math.ceil((q.blocked_until-now)/1000)));return res.status(429).json({error:'IP temporariamente bloqueado por tentativas de autenticação'})}
 res.on('finish',()=>{
  try{
   if(res.statusCode>=200&&res.statusCode<300){db.prepare('DELETE FROM auth_ip_limits WHERE ip=? AND route=?').run(ip,route);return}
   if(res.statusCode!==401)return;
   const current=db.prepare('SELECT failures,window_until FROM auth_ip_limits WHERE ip=? AND route=?').get(ip,route);
   const failures=(current&&current.window_until>now?current.failures:0)+1;
   db.prepare('INSERT INTO auth_ip_limits(ip,route,failures,window_until,blocked_until) VALUES (?,?,?,?,?) ON CONFLICT(ip,route) DO UPDATE SET failures=excluded.failures,window_until=excluded.window_until,blocked_until=excluded.blocked_until').run(ip,route,failures,now+900000,failures>=8?now+900000:0);
  }catch(e){console.error('Auth abuse audit failure:',e.message)}
 });next();
});
const securityEvent=(actor,action,outcome,req)=>{try{db.prepare('INSERT INTO security_events(actor,action,outcome,ip) VALUES (?,?,?,?)').run(String(actor).slice(0,120),String(action).slice(0,100),String(outcome).slice(0,30),String(req.ip||'unknown').slice(0,90))}catch(e){console.error('Security event write failed:',e.message)}};
app.use('/api/admin',(req,res,next)=>adminOnly(req,res,()=>next()));
const failures=new Map();
const usernameForAudit=req=>String(req.body?.username||'anonymous').slice(0,100);
app.post('/api/auth/login',wrap((req,res)=>{const ip=req.ip||'unknown',now=Date.now(),entry=failures.get(ip)||{count:0,until:0};if(entry.until>now){securityEvent(usernameForAudit(req),'admin_login','rate_limited',req);return res.status(429).json({error:'Muitas tentativas; tente novamente mais tarde'})}const username=String(req.body?.username||'').slice(0,100),password=String(req.body?.password||'');if(password.length>256)throw Error('Credenciais inválidas');const user=verify(username,password);if(!user){entry.count++;if(entry.count>=5){entry.until=now+15*60*1000;entry.count=0}failures.set(ip,entry);securityEvent(username,'admin_login','denied',req);return res.status(401).json({error:'Usuário ou senha inválidos'})}failures.delete(ip);securityEvent(user.username,'admin_login','success',req);const token=issue(user);const secure=process.env.COOKIE_SECURE==='true'||req.headers['x-forwarded-proto']==='https';res.setHeader('Set-Cookie',`ws_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure?'; Secure':''}`);res.json({username:user.username,role:user.role})}));
app.get('/api/auth/me',(req,res)=>{const user=session(req);if(!user)return res.status(401).json({error:'Login necessário'});res.json(user)});
app.post('/api/auth/logout',(req,res)=>{const u=session(req);if(u)securityEvent(u.username,'admin_logout','success',req);revoke(cookies(req).ws_session);res.setHeader('Set-Cookie','ws_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true})});
// Public health endpoint contains no private data.
app.get('/api/health',(req,res)=>res.json({ok:true,app:'WebSystem UNLOCKER Tools',version:'1.0.0-rc1'}));
app.get('/api/readiness',guard,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Acesso restrito'});const configured=!!(process.env.IMEIVE_API_URL&&process.env.IMEIVE_API_USERNAME&&process.env.IMEIVE_API_KEY);const count=get("SELECT COUNT(*) AS n FROM services WHERE source='imeive'")?.n||0;res.setHeader('Cache-Control','no-store');res.json({version:'1.0.0-rc1',supplier_credentials_configured:configured,supplier_catalog_count:count,database_persistent:process.env.DATA_DIR?true:false,automatic_fulfillment_enabled:false,production_ready:false})});
// Token-protected reseller endpoints are mounted before the browser session guard.
mountClientArea(app,db,{adminGuard:guard});
mountWallet(app,db,{adminGuard:guard});
mountCommerce(app,db,{sessionGuard:guard,config,quote,audit:(entity,id,action,detail='')=>run('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)',entity,id,action,detail)});
// Public order tracking requires an unguessable token. Never expose customer details, serials, contact or price.
const publicLookupAttempts=new Map();
app.post('/api/public/order-lookup',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const ip=req.ip||'unknown',now=Date.now(),entry=publicLookupAttempts.get(ip)||{count:0,until:0};
  if(entry.until>now)return res.status(429).json({error:'Limite de consultas atingido. Tente novamente mais tarde.'});
  const id=Number(req.body?.id),token=String(req.body?.token||'');
  if(!Number.isSafeInteger(id)||id<=0||!/^[a-f0-9]{64}$/.test(token))return res.status(400).json({error:'Código de consulta inválido'});
  const hash=createHash('sha256').update(token).digest('hex');
  const record=get('SELECT o.id,o.device_brand,o.device_model,o.status,o.created_at,o.updated_at FROM orders o JOIN order_public_links l ON l.order_id=o.id WHERE o.id=? AND l.token_hash=?',id,hash);
  if(!record){entry.count++;if(entry.count>=12){entry.until=now+15*60*1000;entry.count=0}publicLookupAttempts.set(ip,entry);return res.status(404).json({error:'Ordem não encontrada ou acesso inválido'})}
  publicLookupAttempts.delete(ip);
  res.json({order_number:String(record.id).padStart(4,'0'),device_brand:record.device_brand||'',device_model:record.device_model,status:record.status,created_at:record.created_at,updated_at:record.updated_at});
});
// Supplier connection: credentials stay server-side; no order submission or wallet operations.
const integrationAdmin=adminOnly;
app.get('/api/integrations/imeive/status',integrationAdmin,async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{const a=(await supplierCall('accountinfo'))[0]?.AccoutInfo;if(!a)throw Error('Resposta de conta inválida');res.json({connected:true,provider:'IMEI VE Server',currency:a.currency||null,checked_at:new Date().toISOString()})}
 catch(e){res.status(502).json({connected:false,error:e.message})}
});
let supplierSyncRunning=false;
let lastSupplierSync={status:'not_started',checked_at:null,imported:0};
async function performSupplierSync(){
 if(supplierSyncRunning)return {status:'already_running'};
 supplierSyncRunning=true;
 try{const result=await syncSupplier(db);lastSupplierSync={status:'ok',checked_at:result.checked_at,imported:result.imported};console.log('IMEIVE_SYNC_OK',result.imported);return result}
 catch(e){lastSupplierSync={status:'error',checked_at:new Date().toISOString(),imported:0,error:String(e.message).slice(0,130)};console.error('IMEIVE_SYNC_FAILED',lastSupplierSync.error);throw e}
 finally{supplierSyncRunning=false}
}
app.get('/api/public/catalog-sync-status',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json({supplier:lastSupplierSync.status,last_checked_at:lastSupplierSync.checked_at,imported:lastSupplierSync.imported,available_supplier_services:get("SELECT COUNT(*) AS n FROM services WHERE source='imeive' AND available=1")?.n||0})});
app.post('/api/integrations/imeive/sync',integrationAdmin,async(req,res)=>{
 if(supplierSyncRunning)return res.status(409).json({error:'Sincronização em andamento'});
 try{const result=await performSupplierSync();res.json({ok:true,...result})}
 catch(e){res.status(502).json({ok:false,error:e.message})}
});
// Public storefront exposes ONLY allowlisted descriptive fields, never prices or supplier IDs.
app.get('/api/public/catalog',rateLimit({max:90,windowMs:60000,keyPrefix:'public-catalog'}),(req,res)=>{
 const query=String(req.query.q||'').trim().slice(0,80);
 const category=String(req.query.category||'').trim().slice(0,80);
 const limit=Math.min(60,Math.max(1,Number.parseInt(req.query.limit,10)||24));
 const offset=Math.min(10000,Math.max(0,Number.parseInt(req.query.offset,10)||0));
 const where=["(available=1 OR source='telegram-announcement')"];const params=[];
 if(query){where.push('(name LIKE ? OR category LIKE ? OR brand LIKE ? OR model LIKE ?)');params.push(...Array(4).fill('%'+query+'%'))}
 if(category){where.push('category=?');params.push(category)}
 const services=all(`SELECT id,name,category,brand,model,eta,price_usd,CASE WHEN available=1 THEN 'confirmed' ELSE 'reference_only' END AS availability,CASE WHEN source='imeive' THEN 'imeive' WHEN source='telegram-announcement' THEN 'public_announcement' ELSE 'manual' END AS catalog_source FROM services WHERE ${where.join(' AND ')} ORDER BY CASE WHEN source='imeive' THEN 0 WHEN available=1 THEN 1 ELSE 2 END,category,name,id LIMIT ? OFFSET ?`,...params,limit,offset);
 const rate=get('SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1')?.rate;
 const listed=services.map(({price_usd,...service})=>({...service,...(service.catalog_source==='imeive'&&rate>0?{price_brl:priceService({...service,price_usd},rate).selling_brl,currency:'BRL'}:{})}));
 const total=get(`SELECT COUNT(*) AS n FROM services WHERE ${where.join(' AND ')}`,...params)?.n||0;
 const categories=all("SELECT category,COUNT(*) AS total FROM services WHERE available=1 OR source='telegram-announcement' GROUP BY category ORDER BY total DESC LIMIT 40");
 res.setHeader('Cache-Control','public, max-age=60');res.json({services:listed,categories,total,offset,has_more:offset+listed.length<total});
});
// All application data requires login, including catalog and prices.
// Legacy management endpoints are admin-only until finer-grained RBAC is implemented.
app.use('/api',integrationAdmin);
app.get('/api/security/events',adminOnly,(req,res)=>res.json(all('SELECT id,actor,action,outcome,ip,created_at FROM security_events ORDER BY id DESC LIMIT 200')));
app.get('/api/telegram/announcements',async(req,res)=>{try{res.json(await getAnnouncements())}catch(e){res.status(502).json({error:'Não foi possível consultar anúncios do Telegram'})}});
app.get('/api/telegram/catalog-status',(req,res)=>res.json(getCatalogSyncStatus()));
app.post('/api/telegram/sync',adminOnly,(req,res)=>{if(!getCatalogSyncStatus().running)syncEntireCatalog(db).catch(e=>console.error('Telegram import:',e.message));res.status(202).json({started:true,status:getCatalogSyncStatus()})});
const audit=(entity,id,action,detail='')=>run('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)',entity,id,action,detail);
app.get('/api/services',wrap((req,res)=>{const search=String(req.query.q||'').slice(0,100);res.json(all('SELECT * FROM services WHERE name LIKE ? OR category LIKE ? OR brand LIKE ? OR model LIKE ? ORDER BY id DESC LIMIT 10000',...Array(4).fill('%'+search+'%')))}));
app.post('/api/services',adminOnly,wrap((req,res)=>{const s=req.body;if(!s.name||!s.category||!Number.isFinite(Number(s.price_usd))||Number(s.price_usd)<0)throw Error('Serviço inválido');const r=run('INSERT INTO services(external_id,source,name,category,brand,model,price_usd,available,eta) VALUES (?,?,?,?,?,?,?,?,?)',s.external_id||null,s.source||'manual',s.name,s.category,s.brand||'',s.model||'',Number(s.price_usd),s.available===false?0:1,s.eta||'');audit('services',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.get('/api/exchange-rates',wrap((req,res)=>res.json({latest:get('SELECT * FROM exchange_rates ORDER BY id DESC LIMIT 1')||null,settings:config()})));
app.get('/api/convert',adminOnly,wrap((req,res)=>{const x=get('SELECT * FROM exchange_rates ORDER BY id DESC LIMIT 1');if(!x)return res.status(503).json({error:'Cotação ainda não disponível'});const usd=Number(req.query.usd);if(!Number.isFinite(usd)||usd<0)throw Error('Valor USD inválido');const c=config();const id=Number(req.query.service_id);const service=Number.isSafeInteger(id)&&id>0?get('SELECT id,name,category,brand,price_usd FROM services WHERE id=?',id):null;if(req.query.service_id&&!service)return res.status(404).json({error:'Serviço não encontrado'});const calculated=service?priceService(service,x.rate):null;res.json({usd,rate:x.rate,brl:calculated?.selling_brl??quote(usd,x.rate,c.margin_percent,c.spread_brl),pricing:calculated,updated_at:x.updated_at})}));
app.put('/api/settings',adminOnly,wrap((req,res)=>{for(const k of ['margin_percent','spread_brl'])if(req.body[k]!==undefined){const v=Number(req.body[k]);if(!Number.isFinite(v)||v<0||v>10000)throw Error('Configuração inválida');run('UPDATE settings SET value=? WHERE key=?',String(v),k)}res.json(config())}));
app.post('/api/orders/:id/public-link',adminOnly,wrap((req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<=0||!get('SELECT id FROM orders WHERE id=?',id))return res.status(404).json({error:'Ordem não encontrada'});
  const token=randomBytes(32).toString('hex');
  const hash=createHash('sha256').update(token).digest('hex');
  run('INSERT INTO order_public_links(order_id,token_hash) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=CURRENT_TIMESTAMP',id,hash);
  run('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)','orders',id,'public_link_rotated','New customer tracking link');
  res.setHeader('Cache-Control','no-store');
  res.json({url:'/consulta.html#'+id+'.'+token});
}));
app.get('/api/orders',adminOnly,wrap((req,res)=>res.json(all('SELECT * FROM orders ORDER BY id DESC LIMIT 200'))));
app.post('/api/orders',adminOnly,wrap((req,res)=>{const s=req.body;if(!s.customer_name||!s.device_model)throw Error('Cliente e modelo obrigatórios');const r=run('INSERT INTO orders(customer_name,customer_contact,device_brand,device_model,service_id,price_brl,anydesk_id,payment_status) VALUES (?,?,?,?,?,?,?,?)',s.customer_name,s.customer_contact||'',s.device_brand||'',s.device_model,s.service_id||null,Number(s.price_brl)||0,s.anydesk_id||'',s.payment_status||'pendente');audit('orders',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.patch('/api/orders/:id',adminOnly,wrap((req,res)=>{const allowed=['pendente','em_processamento','concluido','entregue','rejeitado','reembolsado'];if(!allowed.includes(req.body.status))throw Error('Status inválido');const r=run('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',req.body.status,Number(req.params.id));if(!r.changes)return res.sendStatus(404);audit('orders',Number(req.params.id),'status',req.body.status);res.json({ok:true})}));
app.get('/api/remote-sessions',adminOnly,wrap((req,res)=>res.json(all('SELECT * FROM remote_sessions ORDER BY id DESC LIMIT 200'))));
app.post('/api/remote-sessions',adminOnly,wrap((req,res)=>{const s=req.body;if(!get('SELECT id FROM orders WHERE id=?',Number(s.order_id))||!s.anydesk_id)throw Error('O.S. e ID AnyDesk obrigatórios');const r=run('INSERT INTO remote_sessions(order_id,anydesk_id,scheduled_at) VALUES (?,?,?)',Number(s.order_id),s.anydesk_id,s.scheduled_at||null);audit('remote_sessions',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.patch('/api/remote-sessions/:id',adminOnly,wrap((req,res)=>{const allowed=['aguardando_conexao','conectado','aguardando_reinicio','concluido','falha','cancelado'];if(!allowed.includes(req.body.status))throw Error('Status inválido');const r=run('UPDATE remote_sessions SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',req.body.status,Number(req.params.id));if(!r.changes)return res.sendStatus(404);audit('remote_sessions',Number(req.params.id),'status',req.body.status);res.json({ok:true})}));
app.get('/api/remote-sessions/:id/messages',adminOnly,wrap((req,res)=>res.json(all('SELECT * FROM remote_messages WHERE session_id=? ORDER BY id ASC LIMIT 300',Number(req.params.id)))));
app.post('/api/remote-sessions/:id/messages',adminOnly,wrap((req,res)=>{const {sender,body}=req.body;if(!['cliente','tecnico'].includes(sender)||!body||String(body).length>2000)throw Error('Mensagem inválida');const r=run('INSERT INTO remote_messages(session_id,sender,body) VALUES (?,?,?)',Number(req.params.id),sender,String(body));res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.get('/api/audit-logs',adminOnly,wrap((req,res)=>res.json(all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100'))));
async function refreshRate(){for(const provider of ['AwesomeAPI','Frankfurter']){try{let rate;if(provider==='AwesomeAPI'){const r=await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();rate=Number(data.USDBRL?.bid)}else{const r=await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();rate=Number(data.rates?.BRL)}if(!(rate>0))throw Error('Cotação inválida');run('INSERT INTO exchange_rates(base,quote,rate,provider) VALUES (?,?,?,?)','USD','BRL',rate,provider);console.log('Cotação atualizada:',rate,provider);return}catch(e){console.error(provider+' indisponível:',e.message)}}}
refreshRate();setInterval(refreshRate,30*60*1000).unref();
// Supplier sync is fail-closed: previous verified records stay intact on network/API errors.
// First refresh after startup, then every 6 hours; no supplier secrets in logs.
if(process.env.IMEIVE_API_URL&&process.env.IMEIVE_API_USERNAME&&process.env.IMEIVE_API_KEY){
 setTimeout(()=>performSupplierSync().catch(()=>{}),20000).unref();
 setInterval(()=>performSupplierSync().catch(()=>{}),6*60*60*1000).unref();
}
if(process.env.DEMO_MODE==='true'){
  // Full historical import on demo startup; hourly refresh of new announcements.
  setTimeout(()=>syncEntireCatalog(db).catch(e=>console.error('Telegram import:',e.message)),2500).unref();
  setInterval(()=>{if(!getCatalogSyncStatus().running)syncEntireCatalog(db).catch(e=>console.error('Telegram import:',e.message))},60*60*1000).unref();
}
const port=Number(process.env.PORT||3100);const host=process.env.HOST||'127.0.0.1';
const dist=resolve(root,'dist');
if(existsSync(resolve(dist,'index.html'))){
 // Do not expose the admin SPA through /index.html or arbitrary fallback paths.
 app.get('/index.html',adminIpGate,(req,res)=>res.redirect(308,'/admin/'));
 app.get('/painel.html',adminIpGate,(req,res)=>res.redirect(308,'/admin/'));
 app.get('/admin',adminIpGate,(req,res,next)=>req.path==='/admin'?res.redirect(308,'/admin/'):next());
 app.get('/admin/',adminIpGate,(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'index.html'))});
 // Named routes share the existing protected applications until dedicated modules are ready.
 app.get(['/admin/users','/admin/services','/admin/orders','/admin/settings','/admin/audit'],adminIpGate,(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'index.html'))});
 app.get('/client',(req,res,next)=>req.path==='/client'?res.redirect(308,'/client/'):next());
 app.get(['/client/','/client/orders','/client/support'],(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'cliente.html'))});
 app.get('/login',(req,res)=>res.redirect(302,'/client/'));
 app.get('/services',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'services.html'))});
 app.get('/register',(req,res)=>res.redirect(302,'/client/?view=register'));
 app.get('/consulta',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'consulta.html'))});
 app.get('/client/wallet',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'wallet.html'))});
 app.use(express.static(dist,{index:false,maxAge:'1h',setHeaders:(res,file)=>{if(/\\.html$/i.test(file))res.setHeader('Cache-Control','no-store')}}));
 app.get('/',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(resolve(dist,'home.html'))});
 app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API endpoint not found'});return res.status(404).send('Página não encontrada')});
}
app.listen(port,host,()=>console.log('WebSystem production: http://'+host+':'+port));
