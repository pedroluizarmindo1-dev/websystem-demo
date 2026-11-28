// Client checkout: turns an order draft into a paid order using the client's wallet balance.
// - The price is computed on the server (pricing.mjs + latest USD/BRL rate); the client only confirms the amount it saw.
// - One IMMEDIATE transaction debits wallet_accounts (balance can never go negative), records the charge, creates the
//   order (status "pendente", payment "pago"), links it to the client, writes status history and audit, and marks the
//   draft as converted. UNIQUE(draft_id) and the per-client Idempotency-Key make retries return the same order.
// - No supplier submission happens here: the team processes the order. Rejecting or refunding the order returns the
//   amount to the wallet exactly once (refundOrderCharge, called inside the admin status transaction).
import {Router} from 'express';
import {priceService} from './pricing.mjs';

export function ensureCheckoutSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS wallet_order_charges(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES client_users(id),order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),balance_after_cents INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'charged' CHECK(status IN ('charged','refunded')),
  refunded_at TEXT,refund_balance_after_cents INTEGER,refunded_by TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS idx_wallet_order_charges_client ON wallet_order_charges(client_id,id);
 CREATE TABLE IF NOT EXISTS client_checkouts(id INTEGER PRIMARY KEY,draft_id INTEGER NOT NULL UNIQUE,client_id INTEGER NOT NULL REFERENCES client_users(id),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),service_id INTEGER NOT NULL REFERENCES services(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  client_key TEXT,identifier TEXT NOT NULL,details_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_client_checkouts_key ON client_checkouts(client_id,client_key) WHERE client_key IS NOT NULL;`);
 const cols=db.prepare('PRAGMA table_info(client_order_drafts)').all().map(c=>c.name);
 if(cols.length&&!cols.includes('service_id'))db.exec('ALTER TABLE client_order_drafts ADD COLUMN service_id INTEGER');
}

// Must run inside the caller's transaction (the admin status change). Returns the refunded amount or 0.
export function refundOrderCharge(db,orderId,actor){
 const q=(s,...v)=>db.prepare(s).get(...v),run=(s,...v)=>db.prepare(s).run(...v);
 const ch=q("SELECT * FROM wallet_order_charges WHERE order_id=? AND status='charged'",orderId);
 if(!ch)return 0;
 run('UPDATE wallet_accounts SET balance_cents=balance_cents+? WHERE client_id=?',ch.amount_cents,ch.client_id);
 const balance=q('SELECT balance_cents FROM wallet_accounts WHERE client_id=?',ch.client_id).balance_cents;
 const r=run("UPDATE wallet_order_charges SET status='refunded',refunded_at=CURRENT_TIMESTAMP,refund_balance_after_cents=?,refunded_by=? WHERE id=? AND status='charged'",balance,String(actor||'admin').slice(0,100),ch.id);
 if(r.changes!==1)throw Error('Estorno concorrente');
 run("UPDATE orders SET payment_status='reembolsado',updated_at=CURRENT_TIMESTAMP WHERE id=?",orderId);
 return ch.amount_cents;
}

export function mountCheckout(app,db,{client,audit}){
 ensureCheckoutSchema(db);
 const q=(s,...v)=>db.prepare(s).get(...v),all=(s,...v)=>db.prepare(s).all(...v),run=(s,...v)=>db.prepare(s).run(...v);
 const fail=(res,status,error,extra={})=>res.status(status).json({error,...extra});
 const rate=()=>Number(q('SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1')?.rate)||0;
 const quote=service=>{const r=rate();if(!service||service.source!=='imeive'||!service.available||!(r>0))return null;try{const cents=Math.round(priceService(service,r).selling_brl*100);return cents>0?cents:null}catch{return null}};
 const serviceOf=draft=>draft.service_id?q('SELECT * FROM services WHERE id=?',draft.service_id):null;
 const balanceOf=id=>q('SELECT balance_cents FROM wallet_accounts WHERE client_id=?',id)?.balance_cents||0;
 const r=Router();r.use(client);

 // Drafts with a server-side quote and their checkout state.
 r.get('/drafts',(req,res)=>{
  const id=req.walletClient.id;
  const rows=all('SELECT d.id,d.service_name,d.device_model,d.identifier,d.service_id,d.created_at,c.order_id FROM client_order_drafts d LEFT JOIN client_checkouts c ON c.draft_id=d.id WHERE d.client_id=? ORDER BY d.id DESC LIMIT 100',id);
  res.json({balance_cents:balanceOf(id),drafts:rows.map(d=>{const s=d.order_id?null:serviceOf(d);const price=d.order_id?null:quote(s);return {id:d.id,service_name:d.service_name,device_model:d.device_model,created_at:d.created_at,order_id:d.order_id||null,price_cents:price,payable:!d.order_id&&price!=null,reason:d.order_id?'converted':!d.service_id?'no_service':price==null?'price_unavailable':null}})});
 });

 r.post('/drafts/:id',async(req,res)=>{
  const draftId=Number(req.params.id),clientId=req.walletClient.id;
  if(!Number.isSafeInteger(draftId)||draftId<1)return fail(res,400,'Rascunho inválido');
  const key=String(req.get('Idempotency-Key')||'').trim();if(key&&!/^[A-Za-z0-9_.:-]{8,64}$/.test(key))return fail(res,400,'Chave de idempotência inválida');
  const expected=req.body?.expected_amount_cents;
  if(expected!==undefined&&!Number.isSafeInteger(expected))return fail(res,400,'Valor esperado inválido');
  const done=c=>({order_id:c.order_id,amount_cents:c.amount_cents,balance_cents:balanceOf(clientId),status:'pendente',payment_status:'pago'});
  db.exec('BEGIN IMMEDIATE');
  try{
   if(key){const prior=q('SELECT * FROM client_checkouts WHERE client_id=? AND client_key=?',clientId,key);if(prior){db.exec('COMMIT');return prior.draft_id===draftId?res.status(200).json(done(prior)):fail(res,409,'Chave de idempotência já usada em outro rascunho')}}
   const draft=q('SELECT * FROM client_order_drafts WHERE id=? AND client_id=?',draftId,clientId);
   if(!draft){db.exec('ROLLBACK');return fail(res,404,'Rascunho não encontrado')}
   const prior=q('SELECT * FROM client_checkouts WHERE draft_id=?',draftId);
   if(prior){db.exec('COMMIT');return res.status(200).json(done(prior))}
   const service=serviceOf(draft);
   if(!service||service.source!=='imeive'||!service.available){db.exec('ROLLBACK');return fail(res,409,draft.service_id?'Serviço indisponível no momento':'Este rascunho não está ligado a um serviço do catálogo; crie um novo pedido pelo catálogo',{code:'SERVICE_UNAVAILABLE'})}
   const amount=quote(service);
   if(amount==null){db.exec('ROLLBACK');return fail(res,503,'Preço indisponível no momento; tente mais tarde',{code:'PRICE_UNAVAILABLE'})}
   if(expected!==undefined&&expected!==amount){db.exec('ROLLBACK');return fail(res,409,'O preço do serviço mudou; confira o novo valor',{code:'PRICE_CHANGED',amount_cents:amount})}
   run('INSERT OR IGNORE INTO wallet_accounts(client_id,balance_cents) VALUES (?,0)',clientId);
   const balance=balanceOf(clientId);
   if(balance<amount){db.exec('ROLLBACK');return fail(res,402,'Saldo insuficiente',{code:'INSUFFICIENT_BALANCE',balance_cents:balance,amount_cents:amount})}
   const debit=run('UPDATE wallet_accounts SET balance_cents=balance_cents-? WHERE client_id=? AND balance_cents>=?',amount,clientId,amount);
   if(debit.changes!==1){db.exec('ROLLBACK');return fail(res,402,'Saldo insuficiente',{code:'INSUFFICIENT_BALANCE'})}
   const after=balanceOf(clientId);
   const user=q('SELECT display_name,email FROM client_users WHERE id=?',clientId)||{};
   const orderId=Number(run("INSERT INTO orders(customer_name,customer_contact,device_brand,device_model,service_id,price_brl,payment_status,status) VALUES (?,?,?,?,?,?,'pago','pendente')",
    String(user.display_name||'Cliente #'+clientId).slice(0,120),String(user.email||'').slice(0,160)||null,'',(String(draft.device_model)+' · '+String(draft.identifier)).slice(0,200),service.id,amount/100).lastInsertRowid);
   run('INSERT INTO client_order_links(client_id,order_id) VALUES (?,?)',clientId,orderId);
   run('INSERT INTO order_status_history(order_id,previous_status,new_status,origin,actor) VALUES (?,NULL,?,?,?)',orderId,'pendente','client_checkout','client:'+clientId);
   audit('orders',orderId,'created','client_checkout');
   run('INSERT INTO wallet_order_charges(client_id,order_id,amount_cents,balance_after_cents) VALUES (?,?,?,?)',clientId,orderId,amount,after);
   run('INSERT INTO client_checkouts(draft_id,client_id,order_id,service_id,amount_cents,client_key,identifier,details_json) VALUES (?,?,?,?,?,?,?,?)',draftId,clientId,orderId,service.id,amount,key||null,String(draft.identifier).slice(0,160),draft.details_json||null);
   db.exec('COMMIT');
   return res.status(201).json({order_id:orderId,amount_cents:amount,balance_cents:after,status:'pendente',payment_status:'pago'});
  }catch(e){
   try{db.exec('ROLLBACK')}catch{}
   const raced=q('SELECT * FROM client_checkouts WHERE draft_id=? AND client_id=?',draftId,clientId);
   if(raced)return res.status(200).json(done(raced));
   console.error('Checkout failed:',e.message);return fail(res,500,'Não foi possível concluir o pedido; nenhum valor foi debitado')
  }
 });

 r.delete('/drafts/:id',(req,res)=>{
  const draftId=Number(req.params.id),clientId=req.walletClient.id;
  if(!Number.isSafeInteger(draftId)||draftId<1)return fail(res,400,'Rascunho inválido');
  if(q('SELECT 1 FROM client_checkouts WHERE draft_id=?',draftId))return fail(res,409,'Rascunho já convertido em pedido');
  const d=run('DELETE FROM client_order_drafts WHERE id=? AND client_id=?',draftId,clientId);
  if(!d.changes)return fail(res,404,'Rascunho não encontrado');
  res.json({ok:true});
 });
 app.use('/api/client/checkout',r);

 // Admin (behind adminIpGate + adminOnly for /api/admin): full checkout details for an order (identifier and supplier fields the team needs to process it).
 app.get('/api/admin/checkout/orders/:id',(req,res)=>{
  if(req.user?.role!=='admin')return fail(res,403,'Acesso restrito');
  const c=q('SELECT c.*,w.status AS charge_status,w.refunded_at FROM client_checkouts c LEFT JOIN wallet_order_charges w ON w.order_id=c.order_id WHERE c.order_id=?',Number(req.params.id));
  if(!c)return fail(res,404,'Pedido sem checkout de cliente');
  let details=null;try{details=JSON.parse(c.details_json||'null')}catch{}
  res.json({order_id:c.order_id,client_id:c.client_id,service_id:c.service_id,amount_cents:c.amount_cents,identifier:c.identifier,details,charge_status:c.charge_status,refunded_at:c.refunded_at,created_at:c.created_at});
 });
}
