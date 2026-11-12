import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {Router} from 'express';
const hash=s=>createHash('sha256').update(s).digest('hex');
const safe=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const error=(res,code,message)=>res.status(code).json({error:message});
const validIp=(s)=>/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)||s==='::1'||/^[a-f\d:]+$/i.test(s);
const clientIp=req=>(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
const priceFor=(base,tier,settings)=>Math.round(Math.max(0,base*(1+(Number(settings.retail_markup_percent)||0)/100)*(1-(Number(settings[tier+'_discount_percent'])||0)/100))*100)/100;
export function mountCommerce(app,db,{sessionGuard,config,quote,audit}){
 const all=(s,...p)=>db.prepare(s).all(...p),get=(s,...p)=>db.prepare(s).get(...p),run=(s,...p)=>db.prepare(s).run(...p);
 const protect=(req,res,next)=>sessionGuard(req,res,()=>req.user?.role==='admin'?next():error(res,403,'Acesso restrito'));
 const wrap=fn=>(req,res)=>{try{fn(req,res)}catch(e){error(res,400,e.message)}};
 const fx=()=>get('SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1')?.rate||0;
 const wallet=()=>{const entries=all('SELECT * FROM wallet_entries ORDER BY id DESC LIMIT 300');const balance=all("SELECT kind,amount_brl FROM wallet_entries WHERE status='approved'").reduce((n,e)=>n+(e.kind==='credit'||e.kind==='refund'?e.amount_brl:-e.amount_brl),0);return {balance_brl:Math.round(balance*100)/100,entries}};
 // Compatibility subset of DHRU-style API: action + key; intentionally no supplier fulfillment.
 const router=Router();
 const apiAuth=(req,res,next)=>{
  const token=String(req.headers['x-api-key']||req.body?.key||'');
  if(token.length<32||token.length>256)return error(res,401,'Chave API necessária');
  const digest=hash(token);const key=get('SELECT * FROM reseller_keys WHERE token_hash=? AND enabled=1',digest);
  if(!key||!safe(key.token_hash,digest))return error(res,401,'Chave inválida');
  if(key.allowed_ip!==clientIp(req))return error(res,403,'IP não autorizado');
  req.reseller=key;next();
 };
 router.use(apiAuth);
 const process=(req,res)=>{
  const action=String(req.body?.action||req.query.action||'').toLowerCase();
  const tier=req.reseller.tier,rate=fx(),settings=config();
  if(action==='accountinfo'||action==='balance')return res.json({SUCCESS:[{AccountName:req.reseller.label,Tier:tier,Currency:'BRL',Balance:wallet().balance_brl}]});
  if(action==='imeiservicelist'||action==='servicelist')return res.json({SUCCESS:all('SELECT id,name,category,price_usd,eta,available FROM services ORDER BY id DESC LIMIT 5000').map(s=>({SERVICEID:s.id,SERVICENAME:s.name,CATEGORY:s.category,CREDIT:rate?priceFor(quote(s.price_usd,rate,settings.margin_percent,settings.spread_brl),tier,settings):null,TIME:s.eta||'Consultar',AVAILABLE:!!s.available}))});
  if(action==='getimeiorder'||action==='orderstatus'){const id=Number(req.body?.id||req.body?.orderid||req.query.id);const o=get('SELECT id,status,created_at FROM orders WHERE id=? AND customer_name=?',id,req.reseller.label);return o?res.json({SUCCESS:[{ID:o.id,STATUS:o.status,CREATED:o.created_at}]}):error(res,404,'Pedido não encontrado')}
  if(action==='placeimeiorder'||action==='placeorder'){
   const serviceId=Number(req.body?.serviceid||req.body?.service_id),imei=String(req.body?.imei||req.body?.device_id||'').trim();
   if(!Number.isSafeInteger(serviceId)||!/^[-A-Za-z0-9]{8,40}$/.test(imei))return error(res,400,'Serviço e identificador válidos são obrigatórios');
   const s=get('SELECT * FROM services WHERE id=?',serviceId);
   if(!s)return error(res,404,'Serviço não encontrado');
   // Record request only: no wallet debit or external supplier action until confirmed.
   const cost=rate?priceFor(quote(s.price_usd,rate,settings.margin_percent,settings.spread_brl),tier,settings):0;
   const order=run('INSERT INTO orders(customer_name,device_model,service_id,price_brl,payment_status,status) VALUES (?,?,?,?,?,?)',req.reseller.label,imei,serviceId,cost,'pendente','pendente');
   audit('orders',Number(order.lastInsertRowid),'reseller_api_request',req.reseller.label);
   return res.status(202).json({SUCCESS:[{ID:Number(order.lastInsertRowid),STATUS:'Pending',MESSAGE:'Solicitação registrada. Aguardando validação; não enviada ao fornecedor.'}]});
  }
  return error(res,400,'Ação não suportada. Use accountinfo, imeiservicelist, placeimeiorder ou getimeiorder.');
 };
 router.get('/',wrap(process));router.post('/',wrap(process));app.use('/api/dhru',router);
 app.get('/api/reseller/keys',protect,wrap((req,res)=>res.json(all('SELECT id,label,allowed_ip,tier,enabled,created_at FROM reseller_keys ORDER BY id DESC'))));
 app.post('/api/reseller/keys',protect,wrap((req,res)=>{
  if(req.user.role!=='admin')return error(res,403,'Acesso restrito');
  const {label,allowed_ip,tier='lojista'}=req.body||{};
  if(!label||String(label).length>100||!validIp(String(allowed_ip))||!['lojista','atacado','retail'].includes(tier))throw Error('Dados inválidos. Informe IP explícito.');
  const token='ws_'+randomBytes(32).toString('hex');
  const r=run('INSERT INTO reseller_keys(label,token_hash,allowed_ip,tier) VALUES (?,?,?,?)',String(label),hash(token),String(allowed_ip),tier);
  audit('reseller_keys',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid),token,warning:'Guarde a chave agora; ela não será exibida novamente.'});
 }));
 app.patch('/api/reseller/keys/:id',protect,wrap((req,res)=>{if(req.user.role!=='admin')return error(res,403,'Acesso restrito');run('UPDATE reseller_keys SET enabled=0 WHERE id=?',Number(req.params.id));res.json({ok:true})}));
 app.get('/api/wallet',protect,wrap((req,res)=>res.json(wallet())));
 app.post('/api/wallet/deposits',protect,wrap((req,res)=>{
  const {method,amount_brl,reference,proof}=req.body||{};
  if(!['pix','bank','usdt_trc20','usdt_bep20'].includes(method)||!Number.isFinite(Number(amount_brl))||Number(amount_brl)<=0||Number(amount_brl)>1000000||!String(reference||'').trim()||String(reference).length>180||String(proof||'').length>1000)throw Error('Informe método, valor e referência/TXID válidos');
  const r=run("INSERT INTO wallet_entries(kind,amount_brl,method,reference,proof,status,description) VALUES (?,?,?,?,?,'pending',?)",'credit',Number(amount_brl),method,String(reference),String(proof||''),'Depósito aguardando conferência');
  audit('wallet',Number(r.lastInsertRowid),'deposit_requested');res.status(201).json({id:Number(r.lastInsertRowid),status:'pending',message:'Aguardando validação manual; saldo não creditado.'});
 }));
 app.patch('/api/wallet/entries/:id',protect,wrap((req,res)=>{
  if(req.user.role!=='admin')return error(res,403,'Acesso restrito');
  if(!['approved','rejected'].includes(req.body?.status))throw Error('Status inválido');
  const row=get('SELECT * FROM wallet_entries WHERE id=?',Number(req.params.id));
  if(!row||row.status!=='pending'||row.kind!=='credit')return error(res,409,'Depósito não está pendente');
  run('UPDATE wallet_entries SET status=? WHERE id=?',req.body.status,row.id);audit('wallet',row.id,req.body.status);res.json({ok:true});
 }));
 app.get('/api/tickets',protect,wrap((req,res)=>res.json(all('SELECT * FROM support_tickets ORDER BY id DESC LIMIT 300'))));
 app.post('/api/tickets',protect,wrap((req,res)=>{
  const {order_id,subject,description}=req.body||{};
  if(!subject||String(subject).length>160||!description||String(description).length>4000)throw Error('Assunto e descrição obrigatórios');
  if(order_id&&!get('SELECT id FROM orders WHERE id=?',Number(order_id)))throw Error('Ordem não encontrada');
  const r=run('INSERT INTO support_tickets(order_id,subject,description) VALUES (?,?,?)',order_id||null,String(subject),String(description));
  audit('tickets',Number(r.lastInsertRowid),'created');res.status(201).json({id:Number(r.lastInsertRowid),status:'open'});
 }));
 app.patch('/api/tickets/:id',protect,wrap((req,res)=>{
  if(req.user.role!=='admin')return error(res,403,'Acesso restrito');
  if(!['open','in_review','resolved','rejected'].includes(req.body?.status))throw Error('Status inválido');
  run('UPDATE support_tickets SET status=?,resolution=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',req.body.status,String(req.body.resolution||'').slice(0,2000),Number(req.params.id));res.json({ok:true});
 }));
 app.get('/api/campaigns',protect,wrap((req,res)=>res.json(all('SELECT * FROM campaigns WHERE active=1 ORDER BY id DESC LIMIT 20'))));
 app.get('/api/reseller/tiers',protect,wrap((req,res)=>res.json({retail:0,lojista:Number(config().lojista_discount_percent||0),atacado:Number(config().atacado_discount_percent||0)})));
}
