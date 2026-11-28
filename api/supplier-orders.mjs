// Supervised supplier submission for orders paid with the client wallet (IMEIve, DHRU Fusion API v6.1).
// Nothing is sent automatically: an administrator reviews each paid order in the admin panel and approves it.
// - One submission per order (UNIQUE order_id). States:
//     enviando -> enviado -> concluido | rejeitado
//              -> falhou   (supplier answered ERROR: nothing was placed; the admin may approve again)
//              -> incerto  (no answer / timeout / unreadable answer: the order MAY exist at the supplier; it is never
//                           retried automatically - an admin checks the supplier panel and resolves it by hand)
// - Order status follows the submission: enviado -> em_processamento, concluido -> concluido,
//   rejeitado -> rejeitado (the wallet charge is refunded once, in the same transaction).
// - DHRU request: POST username, apiaccesskey, requestformat=JSON, action, parameters=base64(JSON).
//   placeimeiorder sends {ID, IMEI, CUSTOMFIELD/customfield=base64(JSON of the other fields)}; getimeiorder sends {ID}.
//   getimeiorder STATUS: 0 new, 1 in process, 3 rejected (refund), 4 available (success, CODE = result).
// - Disabled unless SUPPLIER_ORDERS_ENABLED=true and the IMEIve credentials are configured. Every step is audited.
import {Router} from 'express';
import {canTransitionOrder} from './order-transitions.mjs';
import {refundOrderCharge} from './checkout.mjs';

const ENDPOINT='https://imeiveserver.com/api/index.php';
// The production endpoint is pinned; a local simulator URL is accepted only when NODE_ENV=test.
const supplierUrl=()=>{const u=String(process.env.IMEIVE_API_URL||'');if(u===ENDPOINT)return u;if(process.env.NODE_ENV==='test'&&/^http:\/\/127\.0\.0\.1:\d+\/[\w./-]*$/.test(u))return u;return null};
export const supplierOrdersConfigured=()=>!!supplierUrl()&&!!process.env.IMEIVE_API_USERNAME&&!!process.env.IMEIVE_API_KEY;
export const supplierOrdersEnabled=()=>process.env.SUPPLIER_ORDERS_ENABLED==='true'&&supplierOrdersConfigured();

// Returns {ok:true,success} | {ok:false,error} (the supplier refused) | {transport:true,error} (outcome unknown).
export async function dhruRequest(action,params,{timeoutMs=30000}={}){
 const url=supplierUrl();if(!url)return {transport:true,error:'Fornecedor não configurado'};
 const body=new URLSearchParams({username:process.env.IMEIVE_API_USERNAME||'',apiaccesskey:process.env.IMEIVE_API_KEY||'',requestformat:'JSON',action,parameters:Buffer.from(JSON.stringify(params)).toString('base64')});
 let r;
 try{r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body,redirect:'error',signal:AbortSignal.timeout(timeoutMs)})}
 catch{return {transport:true,error:'Sem resposta do fornecedor'}}
 if(!r.ok)return {transport:true,error:'Fornecedor HTTP '+r.status};
 let text='';try{text=await r.text()}catch{return {transport:true,error:'Resposta interrompida'}}
 if(text.length>1000000)return {transport:true,error:'Resposta grande demais'};
 let data;try{data=JSON.parse(text)}catch{return {transport:true,error:'Resposta ilegível do fornecedor'}}
 if(Array.isArray(data?.SUCCESS)&&data.SUCCESS.length)return {ok:true,success:data.SUCCESS[0]||{}};
 const e=Array.isArray(data?.ERROR)?data.ERROR[0]:null;
 if(e&&(e.MESSAGE||e.FULL_DESCRIPTION))return {ok:false,error:String(e.MESSAGE||e.FULL_DESCRIPTION).slice(0,300)};
 return {transport:true,error:'Resposta sem SUCCESS/ERROR'};
}

export function mountSupplierOrders(app,db,{audit}){
 db.exec(`CREATE TABLE IF NOT EXISTS supplier_submissions(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),supplier_service_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('enviando','enviado','concluido','rejeitado','falhou','incerto')),reference_id TEXT,supplier_status INTEGER,result_code TEXT,error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,approved_by TEXT,approved_at TEXT,sent_at TEXT,completed_at TEXT,synced_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS supplier_submission_events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS idx_supplier_submission_events_order ON supplier_submission_events(order_id,id);`);
 const q=(s,...v)=>db.prepare(s).get(...v),all=(s,...v)=>db.prepare(s).all(...v),run=(s,...v)=>db.prepare(s).run(...v);
 const fail=(res,status,error,extra={})=>res.status(status).json({error,...extra});
 const event=(orderId,actor,action,detail='')=>run('INSERT INTO supplier_submission_events(order_id,actor,action,detail) VALUES (?,?,?,?)',orderId,String(actor).slice(0,100),action,String(detail).slice(0,500));
 const actorOf=req=>'admin:'+String(req.user?.username||'admin').slice(0,80);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){try{db.exec('ROLLBACK')}catch{}throw e}};
 // A process that died while sending leaves "enviando" behind: after 5 minutes it is treated as uncertain.
 const expireSending=()=>{for(const s of all("SELECT order_id FROM supplier_submissions WHERE status='enviando' AND updated_at<datetime('now','-5 minutes')")){run("UPDATE supplier_submissions SET status='incerto',error='Envio interrompido; confira no painel do fornecedor',updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviando'",s.order_id);event(s.order_id,'system','marked_uncertain','enviando expirado')}};
 const moveOrder=(orderId,to,actor,origin)=>{const o=q('SELECT status FROM orders WHERE id=?',orderId);if(!o||o.status===to||!canTransitionOrder(o.status,to))return false;
  run('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',to,orderId);
  run('INSERT INTO order_status_history(order_id,previous_status,new_status,origin,actor) VALUES (?,?,?,?,?)',orderId,o.status,to,origin,actor);
  audit('orders',orderId,'status',to);
  if(to==='rejeitado'){const refunded=refundOrderCharge(db,orderId,actor);if(refunded)audit('orders',orderId,'wallet_refund',String(refunded))}
  return true};
 const context=orderId=>q(`SELECT o.id,o.status,o.payment_status,o.price_brl,o.created_at,o.customer_name,o.customer_contact,s.id AS service_id,s.name AS service_name,s.external_id,s.source,s.price_usd,
  c.identifier,c.details_json,c.amount_cents,m.metadata_json,x.status AS submission_status,x.reference_id,x.error,x.result_code,x.supplier_status,x.attempts,x.approved_by,x.sent_at,x.completed_at,x.updated_at AS submission_updated_at
  FROM orders o JOIN client_checkouts c ON c.order_id=o.id JOIN services s ON s.id=o.service_id LEFT JOIN supplier_service_fields m ON m.external_id=s.external_id
  LEFT JOIN supplier_submissions x ON x.order_id=o.id WHERE o.id=?`,orderId);
 const fieldsOf=row=>{let d=null;try{d=JSON.parse(row.details_json||'null')}catch{}const f=d?.details?.api_fields;return f&&typeof f==='object'&&!Array.isArray(f)?Object.fromEntries(Object.entries(f).map(([k,v])=>[String(k).slice(0,80),String(v??'').slice(0,500)])):{}};
 const supplierId=row=>String(row.external_id||'').startsWith('imeive:')?String(row.external_id).slice(7):null;
 const canSubmit=row=>row.source==='imeive'&&!!supplierId(row)&&row.payment_status==='pago'&&row.status==='pendente'&&(!row.submission_status||row.submission_status==='falhou');
 const view=row=>({order_id:row.id,created_at:row.created_at,order_status:row.status,payment_status:row.payment_status,price_brl:row.price_brl,client:{name:row.customer_name,contact:row.customer_contact},
  service:{id:row.service_id,name:row.service_name,supplier_id:supplierId(row),supplier_price_usd:row.price_usd},identifier:row.identifier,fields:fieldsOf(row),
  submission:row.submission_status?{status:row.submission_status,reference_id:row.reference_id,error:row.error,result_code:row.result_code,supplier_status:row.supplier_status,attempts:row.attempts,approved_by:row.approved_by,sent_at:row.sent_at,completed_at:row.completed_at,updated_at:row.submission_updated_at}:null,
  can_submit:canSubmit(row)});
 const paramsFor=row=>{const f=fieldsOf(row);const imei=f.IMEI||f.SN||row.identifier;const custom=Object.fromEntries(Object.entries(f).filter(([k])=>k!=='IMEI'&&k!=='SN'));
  const p={ID:supplierId(row),IMEI:String(imei||'')};if(Object.keys(custom).length){const enc=Buffer.from(JSON.stringify(custom)).toString('base64');p.CUSTOMFIELD=enc;p.customfield=enc}
  let meta={};try{meta=JSON.parse(row.metadata_json||'{}')}catch{}if(Number(meta.qnt||0)>0)p.QNT=1;return p};

 async function refresh(orderId,actor){
  const s=q('SELECT * FROM supplier_submissions WHERE order_id=?',orderId);
  if(!s||s.status!=='enviado'||!s.reference_id)return s;
  const r=await dhruRequest('getimeiorder',{ID:s.reference_id},{timeoutMs:20000});
  if(!r.ok){tx(()=>{run('UPDATE supplier_submissions SET synced_at=?,error=? WHERE order_id=?',Date.now(),r.error,orderId)});return q('SELECT * FROM supplier_submissions WHERE order_id=?',orderId)}
  const status=Number(r.success.STATUS),code=r.success.CODE==null?null:String(r.success.CODE).slice(0,4000);
  tx(()=>{
   run('UPDATE supplier_submissions SET supplier_status=?,synced_at=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE order_id=?',Number.isFinite(status)?status:null,Date.now(),orderId);
   if(status===4){run("UPDATE supplier_submissions SET status='concluido',result_code=?,completed_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviado'",code,orderId);event(orderId,actor,'supplier_completed','STATUS 4');moveOrder(orderId,'concluido',actor,'supplier_sync')}
   else if(status===3){run("UPDATE supplier_submissions SET status='rejeitado',result_code=?,completed_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviado'",code,orderId);event(orderId,actor,'supplier_rejected','STATUS 3');moveOrder(orderId,'rejeitado',actor,'supplier_sync')}
  });
  return q('SELECT * FROM supplier_submissions WHERE order_id=?',orderId);
 }
 let syncing=false;
 async function syncAll(){if(!supplierOrdersEnabled()||syncing)return {skipped:true};syncing=true;let checked=0;try{expireSending();for(const s of all("SELECT order_id FROM supplier_submissions WHERE status='enviado' AND synced_at<? ORDER BY synced_at LIMIT 20",Date.now()-600000)){try{await refresh(s.order_id,'system');checked++}catch{}}return {checked}}finally{syncing=false}}
 if(supplierOrdersEnabled()&&process.env.NODE_ENV!=='test')setInterval(()=>syncAll().catch(e=>console.error('Supplier sync failed:',e.message)),600000).unref();

 const a=Router(); // mounted under /api/admin (adminIpGate + admin session already enforced for this prefix)
 a.use((req,res,next)=>req.user?.role==='admin'?next():fail(res,403,'Acesso restrito'));
 a.get('/status',(req,res)=>res.json({enabled:supplierOrdersEnabled(),configured:supplierOrdersConfigured(),counts:Object.fromEntries(all('SELECT status,COUNT(*) AS n FROM supplier_submissions GROUP BY status').map(r=>[r.status,r.n])),
  awaiting:q("SELECT COUNT(*) AS n FROM orders o JOIN client_checkouts c ON c.order_id=o.id LEFT JOIN supplier_submissions x ON x.order_id=o.id WHERE o.payment_status='pago' AND o.status='pendente' AND x.id IS NULL").n}));
 a.get('/queue',(req,res)=>{
  expireSending();
  const filter=String(req.query.filter||'aguardando');
  const where={aguardando:"o.payment_status='pago' AND o.status='pendente' AND (x.id IS NULL OR x.status='falhou')",enviados:"x.status IN ('enviando','enviado')",incertos:"x.status='incerto'",concluidos:"x.status IN ('concluido','rejeitado')",todos:'1=1'}[filter];
  if(!where)return fail(res,400,'Filtro inválido');
  const ids=all(`SELECT o.id FROM orders o JOIN client_checkouts c ON c.order_id=o.id LEFT JOIN supplier_submissions x ON x.order_id=o.id WHERE ${where} ORDER BY o.id DESC LIMIT 100`).map(r=>r.id);
  res.json({filter,enabled:supplierOrdersEnabled(),items:ids.map(id=>view(context(id)))});
 });
 a.get('/orders/:id/events',(req,res)=>res.json(all('SELECT actor,action,detail,created_at FROM supplier_submission_events WHERE order_id=? ORDER BY id ASC LIMIT 200',Number(req.params.id))));
 a.post('/orders/:id/submit',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return fail(res,400,'Pedido inválido');
  if(!supplierOrdersEnabled())return fail(res,503,'Envio ao fornecedor desativado (SUPPLIER_ORDERS_ENABLED)');
  if(req.body?.confirm_order_id!==id)return fail(res,400,'Confirme o número do pedido para enviar');
  const actor=actorOf(req);let row;
  try{row=tx(()=>{
   const r=context(id);if(!r)return {err:[404,'Pedido sem checkout de cliente']};
   if(!canSubmit(r))return {err:[409,r.submission_status?'Envio já registrado ('+r.submission_status+')':'Pedido não está pago e pendente, ou o serviço não é do fornecedor']};
   if(r.submission_status==='falhou')run("UPDATE supplier_submissions SET status='enviando',error=NULL,attempts=attempts+1,approved_by=?,approved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='falhou'",actor,id);
   else run("INSERT INTO supplier_submissions(order_id,supplier_service_id,status,attempts,approved_by,approved_at) VALUES (?,?,'enviando',1,?,CURRENT_TIMESTAMP)",id,supplierId(r),actor);
   event(id,actor,'approved_and_sending','ID '+supplierId(r));audit('orders',id,'supplier_submit_approved',actor);return r})}
  catch(e){return fail(res,409,'Envio já em andamento para este pedido')}
  if(row.err)return fail(res,...row.err);
  const r=await dhruRequest('placeimeiorder',paramsFor(row));
  tx(()=>{
   if(r.ok&&r.success.REFERENCEID!=null&&String(r.success.REFERENCEID).trim()){const ref=String(r.success.REFERENCEID).slice(0,64);run("UPDATE supplier_submissions SET status='enviado',reference_id=?,sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviando'",ref,id);event(id,actor,'supplier_accepted','REFERENCEID '+ref);moveOrder(id,'em_processamento',actor,'supplier_submit')}
   else if(r.ok){run("UPDATE supplier_submissions SET status='incerto',error='Fornecedor respondeu sucesso sem REFERENCEID',updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviando'",id);event(id,actor,'supplier_uncertain','sem REFERENCEID')}
   else if(r.transport){run("UPDATE supplier_submissions SET status='incerto',error=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviando'",r.error,id);event(id,actor,'supplier_uncertain',r.error)}
   else{run("UPDATE supplier_submissions SET status='falhou',error=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='enviando'",r.error,id);event(id,actor,'supplier_refused',r.error)}
  });
  const out=view(context(id));
  res.status(out.submission?.status==='enviado'?200:out.submission?.status==='falhou'?422:202).json(out);
 });
 a.post('/orders/:id/refresh',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return fail(res,400,'Pedido inválido');
  if(!supplierOrdersEnabled())return fail(res,503,'Envio ao fornecedor desativado (SUPPLIER_ORDERS_ENABLED)');
  const s=q('SELECT status FROM supplier_submissions WHERE order_id=?',id);if(!s)return fail(res,404,'Pedido ainda não enviado');
  if(s.status==='enviado')await refresh(id,actorOf(req));
  res.json(view(context(id)));
 });
 // Manual resolution of an uncertain submission after checking the supplier panel.
 a.post('/orders/:id/resolve',(req,res)=>{
  const id=Number(req.params.id),outcome=req.body?.outcome,ref=String(req.body?.reference_id||'').trim(),actor=actorOf(req);
  if(!Number.isSafeInteger(id)||id<1||!['sent','not_sent'].includes(outcome))return fail(res,400,'Informe o resultado da conferência');
  if(outcome==='sent'&&!/^[A-Za-z0-9_.:-]{1,64}$/.test(ref))return fail(res,400,'Informe o REFERENCEID encontrado no painel do fornecedor');
  const done=tx(()=>{
   const s=q('SELECT status FROM supplier_submissions WHERE order_id=?',id);if(!s||s.status!=='incerto')return false;
   if(outcome==='sent'){run("UPDATE supplier_submissions SET status='enviado',reference_id=?,error=NULL,sent_at=COALESCE(sent_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE order_id=?",ref,id);event(id,actor,'resolved_sent','REFERENCEID '+ref);moveOrder(id,'em_processamento',actor,'supplier_resolve')}
   else{run("UPDATE supplier_submissions SET status='falhou',error='Conferido: não consta no fornecedor',updated_at=CURRENT_TIMESTAMP WHERE order_id=?",id);event(id,actor,'resolved_not_sent','')}
   audit('orders',id,'supplier_resolve',outcome);return true});
  if(!done)return fail(res,409,'Só envios incertos podem ser resolvidos manualmente');
  res.json(view(context(id)));
 });
 a.post('/sync',async(req,res)=>{if(!supplierOrdersEnabled())return fail(res,503,'Envio ao fornecedor desativado (SUPPLIER_ORDERS_ENABLED)');res.json(await syncAll())});
 app.use('/api/admin/supplier',a);

 // Client: result delivered by the supplier for one of the client's own orders.
 return {resultFor:(clientId,orderId)=>q(`SELECT x.status,x.result_code,x.completed_at FROM supplier_submissions x JOIN client_order_links l ON l.order_id=x.order_id WHERE l.client_id=? AND x.order_id=?`,clientId,orderId)};
}
