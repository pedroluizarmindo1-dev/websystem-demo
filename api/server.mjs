import express from 'express';
import cors from 'cors';
import {getAnnouncements} from './telegram-announcements.mjs';
import {verify,issue,getSession,revoke} from './auth.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const app=express(); app.use(express.json({limit:'128kb'})); app.use(cors({origin:false}));
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
const failures=new Map();
app.post('/api/auth/login',wrap((req,res)=>{const ip=req.ip||'unknown',now=Date.now(),entry=failures.get(ip)||{count:0,until:0};if(entry.until>now)return res.status(429).json({error:'Muitas tentativas; tente novamente mais tarde'});const username=String(req.body?.username||'').slice(0,100),password=String(req.body?.password||'');if(password.length>256)throw Error('Credenciais inválidas');const user=verify(username,password);if(!user){entry.count++;if(entry.count>=5){entry.until=now+15*60*1000;entry.count=0}failures.set(ip,entry);return res.status(401).json({error:'Usuário ou senha inválidos'})}failures.delete(ip);const token=issue(user);const secure=process.env.COOKIE_SECURE==='true'||req.headers['x-forwarded-proto']==='https';res.setHeader('Set-Cookie',`ws_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure?'; Secure':''}`);res.json({username:user.username,role:user.role})}));
app.get('/api/auth/me',(req,res)=>{const user=session(req);if(!user)return res.status(401).json({error:'Login necessário'});res.json(user)});
app.post('/api/auth/logout',(req,res)=>{revoke(cookies(req).ws_session);res.setHeader('Set-Cookie','ws_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true})});
// Public health endpoint contains no private data.
app.get('/api/health',(req,res)=>res.json({ok:true,app:'WebSystem UNLOCKER Tools'}));
// All application data requires login, including catalog and prices.
app.use('/api',guard);
app.get('/api/telegram/announcements',async(req,res)=>{try{res.json(await getAnnouncements())}catch(e){res.status(502).json({error:'Não foi possível consultar anúncios do Telegram'})}});
const audit=(entity,id,action,detail='')=>run('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)',entity,id,action,detail);
app.get('/api/services',wrap((req,res)=>{const search=String(req.query.q||'').slice(0,100);res.json(all('SELECT * FROM services WHERE name LIKE ? OR category LIKE ? OR brand LIKE ? OR model LIKE ? ORDER BY id DESC LIMIT 1500',...Array(4).fill('%'+search+'%')))}));
app.post('/api/services',guard,wrap((req,res)=>{const s=req.body;if(!s.name||!s.category||!Number.isFinite(Number(s.price_usd))||Number(s.price_usd)<0)throw Error('Serviço inválido');const r=run('INSERT INTO services(external_id,source,name,category,brand,model,price_usd,available,eta) VALUES (?,?,?,?,?,?,?,?,?)',s.external_id||null,s.source||'manual',s.name,s.category,s.brand||'',s.model||'',Number(s.price_usd),s.available===false?0:1,s.eta||'');audit('services',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.get('/api/exchange-rates',wrap((req,res)=>res.json({latest:get('SELECT * FROM exchange_rates ORDER BY id DESC LIMIT 1')||null,settings:config()})));
app.get('/api/convert',wrap((req,res)=>{const x=get('SELECT * FROM exchange_rates ORDER BY id DESC LIMIT 1');if(!x)return res.status(503).json({error:'Cotação ainda não disponível'});const usd=Number(req.query.usd);if(!Number.isFinite(usd)||usd<0)throw Error('Valor USD inválido');const c=config();res.json({usd,rate:x.rate,brl:quote(usd,x.rate,c.margin_percent,c.spread_brl),...c,updated_at:x.updated_at})}));
app.put('/api/settings',guard,wrap((req,res)=>{for(const k of ['margin_percent','spread_brl'])if(req.body[k]!==undefined){const v=Number(req.body[k]);if(!Number.isFinite(v)||v<0||v>10000)throw Error('Configuração inválida');run('UPDATE settings SET value=? WHERE key=?',String(v),k)}res.json(config())}));
app.get('/api/orders',guard,wrap((req,res)=>res.json(all('SELECT * FROM orders ORDER BY id DESC LIMIT 200'))));
app.post('/api/orders',guard,wrap((req,res)=>{const s=req.body;if(!s.customer_name||!s.device_model)throw Error('Cliente e modelo obrigatórios');const r=run('INSERT INTO orders(customer_name,customer_contact,device_brand,device_model,service_id,price_brl,anydesk_id,payment_status) VALUES (?,?,?,?,?,?,?,?)',s.customer_name,s.customer_contact||'',s.device_brand||'',s.device_model,s.service_id||null,Number(s.price_brl)||0,s.anydesk_id||'',s.payment_status||'pendente');audit('orders',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.patch('/api/orders/:id',guard,wrap((req,res)=>{const allowed=['pendente','em_processamento','concluido','entregue'];if(!allowed.includes(req.body.status))throw Error('Status inválido');const r=run('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',req.body.status,Number(req.params.id));if(!r.changes)return res.sendStatus(404);audit('orders',Number(req.params.id),'status',req.body.status);res.json({ok:true})}));
app.get('/api/remote-sessions',guard,wrap((req,res)=>res.json(all('SELECT * FROM remote_sessions ORDER BY id DESC LIMIT 200'))));
app.post('/api/remote-sessions',guard,wrap((req,res)=>{const s=req.body;if(!get('SELECT id FROM orders WHERE id=?',Number(s.order_id))||!s.anydesk_id)throw Error('O.S. e ID AnyDesk obrigatórios');const r=run('INSERT INTO remote_sessions(order_id,anydesk_id,scheduled_at) VALUES (?,?,?)',Number(s.order_id),s.anydesk_id,s.scheduled_at||null);audit('remote_sessions',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.patch('/api/remote-sessions/:id',guard,wrap((req,res)=>{const allowed=['aguardando_conexao','conectado','aguardando_reinicio','concluido','falha','cancelado'];if(!allowed.includes(req.body.status))throw Error('Status inválido');const r=run('UPDATE remote_sessions SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',req.body.status,Number(req.params.id));if(!r.changes)return res.sendStatus(404);audit('remote_sessions',Number(req.params.id),'status',req.body.status);res.json({ok:true})}));
app.get('/api/remote-sessions/:id/messages',guard,wrap((req,res)=>res.json(all('SELECT * FROM remote_messages WHERE session_id=? ORDER BY id ASC LIMIT 300',Number(req.params.id)))));
app.post('/api/remote-sessions/:id/messages',guard,wrap((req,res)=>{const {sender,body}=req.body;if(!['cliente','tecnico'].includes(sender)||!body||String(body).length>2000)throw Error('Mensagem inválida');const r=run('INSERT INTO remote_messages(session_id,sender,body) VALUES (?,?,?)',Number(req.params.id),sender,String(body));res.status(201).json({id:Number(r.lastInsertRowid)})}));
app.get('/api/audit-logs',guard,wrap((req,res)=>res.json(all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100'))));
async function refreshRate(){for(const provider of ['AwesomeAPI','Frankfurter']){try{let rate;if(provider==='AwesomeAPI'){const r=await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();rate=Number(data.USDBRL?.bid)}else{const r=await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();rate=Number(data.rates?.BRL)}if(!(rate>0))throw Error('Cotação inválida');run('INSERT INTO exchange_rates(base,quote,rate,provider) VALUES (?,?,?,?)','USD','BRL',rate,provider);console.log('Cotação atualizada:',rate,provider);return}catch(e){console.error(provider+' indisponível:',e.message)}}}
refreshRate();setInterval(refreshRate,30*60*1000).unref();
const port=Number(process.env.PORT||3100);const host=process.env.HOST||'127.0.0.1';
const dist=resolve(root,'dist');
if(existsSync(resolve(dist,'index.html'))){
 app.use(express.static(dist,{index:false,maxAge:'1h'}));
 app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API endpoint not found'});res.sendFile(resolve(dist,'index.html'))});
}
app.listen(port,host,()=>console.log('WebSystem production: http://'+host+':'+port));
