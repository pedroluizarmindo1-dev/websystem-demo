import {createHash} from 'node:crypto';
import {Router} from 'express';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=(res,status,error)=>res.status(status).json({error});
const integer=v=>Number.isSafeInteger(v)&&v>0;
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const maxAmount=100000000; // BRL 1,000,000 in cents; operational ceiling must be reduced before launch
export function mountWallet(app,db,{adminGuard}){
 db.exec(`CREATE TABLE IF NOT EXISTS wallet_accounts(client_id INTEGER PRIMARY KEY REFERENCES client_users(id) ON DELETE RESTRICT,balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents>=0));
 CREATE TABLE IF NOT EXISTS wallet_deposits(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES client_users(id),method TEXT NOT NULL CHECK(method IN ('pix_manual','usdt_bep20')),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),reference TEXT,tx_hash TEXT,reviewed_by TEXT,reviewed_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_bep20_tx ON wallet_deposits(tx_hash) WHERE tx_hash IS NOT NULL;
 CREATE TABLE IF NOT EXISTS wallet_ledger(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES client_users(id),deposit_id INTEGER NOT NULL UNIQUE REFERENCES wallet_deposits(id),delta_cents INTEGER NOT NULL CHECK(delta_cents>0),balance_after_cents INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS wallet_audit(id INTEGER PRIMARY KEY,deposit_id INTEGER,actor TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS idx_wallet_deposits_client ON wallet_deposits(client_id,id);`);
 const q=(sql,...v)=>db.prepare(sql).get(...v),all=(sql,...v)=>db.prepare(sql).all(...v),run=(sql,...v)=>db.prepare(sql).run(...v);
 const client=(req,res,next)=>{const token=cookie(req).ws_client;if(!token||!/^[a-f0-9]{64}$/.test(token))return fail(res,401,'Login necessário');const user=q('SELECT u.id,u.email FROM client_sessions s JOIN client_users u ON u.id=s.client_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1',sha(token),Date.now());if(!user)return fail(res,401,'Login necessário');req.walletClient=user;next()};
 const origin=(req,res,next)=>{if(['GET','HEAD','OPTIONS'].includes(req.method))return next();if(!process.env.APP_ORIGIN||req.headers.origin!==process.env.APP_ORIGIN)return fail(res,403,'Origem não autorizada');next()};
 const enabled=()=>process.env.WALLET_REQUESTS_ENABLED==='true';
 const audit=(id,actor,action,details='')=>run('INSERT INTO wallet_audit(deposit_id,actor,action,details) VALUES (?,?,?,?)',id,actor,action,details);
 const clientRouter=Router();clientRouter.use(origin,client);
 clientRouter.get('/',(req,res)=>{const id=req.walletClient.id;const a=q('SELECT balance_cents FROM wallet_accounts WHERE client_id=?',id);res.json({currency:'BRL',balance_cents:a?.balance_cents||0,requests_enabled:enabled(),methods:['pix_manual','usdt_bep20'],usdt_network:'BEP20',usdt_token_contract_configured:!!process.env.USDT_BEP20_CONTRACT,usdt_deposit_address_configured:!!process.env.USDT_BEP20_ADDRESS})});
 clientRouter.get('/deposits',(req,res)=>res.json(all('SELECT id,method,amount_cents,status,reference,tx_hash,created_at,reviewed_at FROM wallet_deposits WHERE client_id=? ORDER BY id DESC LIMIT 100',req.walletClient.id)));
 clientRouter.get('/ledger',(req,res)=>res.json(all('SELECT id,deposit_id,delta_cents,balance_after_cents,created_at FROM wallet_ledger WHERE client_id=? ORDER BY id DESC LIMIT 100',req.walletClient.id)));
 clientRouter.get('/statement',(req,res)=>{
  const id=req.walletClient.id;
  const account=q('SELECT balance_cents FROM wallet_accounts WHERE client_id=?',id);
  const entries=all(`SELECT l.id AS ledger_id,l.deposit_id,l.delta_cents,l.balance_after_cents,l.created_at,d.method,d.status
   FROM wallet_ledger l JOIN wallet_deposits d ON d.id=l.deposit_id WHERE l.client_id=? ORDER BY l.id DESC LIMIT 100`,id);
  res.json({currency:'BRL',balance_cents:account?.balance_cents||0,transactions:entries.map(e=>({id:'deposit:'+e.ledger_id,type:'deposit',delta_cents:e.delta_cents,balance_after_cents:e.balance_after_cents,reference_id:e.deposit_id,method:e.method,created_at:e.created_at})),note:'Este extrato inclui somente depósitos aprovados na carteira do cliente. Débitos e reembolsos serão exibidos após integração transacional dos pedidos.'});
 });
 clientRouter.post('/deposits',(req,res)=>{
  if(!enabled())return fail(res,503,'Solicitações de recarga desativadas');
  const {method,amount_cents}=req.body||{};
  if(!['pix_manual','usdt_bep20'].includes(method)||!integer(amount_cents)||amount_cents>maxAmount)return fail(res,400,'Método ou valor inválido');
  if(method==='usdt_bep20'&&(!process.env.USDT_BEP20_CONTRACT||!process.env.USDT_BEP20_ADDRESS))return fail(res,503,'USDT BEP20 ainda não configurado');
  const id=Number(run('INSERT INTO wallet_deposits(client_id,method,amount_cents) VALUES (?,?,?)',req.walletClient.id,method,amount_cents).lastInsertRowid);
  audit(id,'client:'+req.walletClient.id,'deposit_requested',method);
  res.status(201).json({id,status:'pending',method,amount_cents,note:'Nenhum saldo será creditado automaticamente'});
 });
 clientRouter.post('/deposits/:id/evidence',(req,res)=>{
  if(!enabled())return fail(res,503,'Solicitações de recarga desativadas');
  const id=Number(req.params.id),d=q('SELECT * FROM wallet_deposits WHERE id=? AND client_id=?',id,req.walletClient.id);
  if(!d)return fail(res,404,'Solicitação não encontrada');if(d.status!=='pending')return fail(res,409,'Solicitação encerrada');
  const reference=String(req.body?.reference||'').trim();
  const tx=String(req.body?.tx_hash||'').trim().toLowerCase();
  if(d.method==='pix_manual'&&(!reference||reference.length>160))return fail(res,400,'Referência PIX inválida');
  if(d.method==='usdt_bep20'&&!/^0x[a-f0-9]{64}$/.test(tx))return fail(res,400,'Hash BEP20 inválido');
  try{run('UPDATE wallet_deposits SET reference=?,tx_hash=? WHERE id=?',d.method==='pix_manual'?reference:null,d.method==='usdt_bep20'?tx:null,id);audit(id,'client:'+req.walletClient.id,'evidence_submitted');res.json({ok:true,status:'pending'})}
  catch(e){return fail(res,409,'Transação já informada em outra solicitação')}
 });
 app.use('/api/client/wallet',clientRouter);
 const admin=Router();admin.use(origin,adminGuard,(req,res,next)=>req.user?.role==='admin'?next():fail(res,403,'Acesso restrito'));
 admin.get('/deposits',(req,res)=>res.json(all('SELECT id,client_id,method,amount_cents,status,reference,tx_hash,created_at,reviewed_at FROM wallet_deposits ORDER BY id DESC LIMIT 200')));
 admin.get('/audit',(req,res)=>res.json(all('SELECT * FROM wallet_audit ORDER BY id DESC LIMIT 200')));
 admin.post('/deposits/:id/review',(req,res)=>{
  if(!enabled())return fail(res,503,'Operações de carteira desativadas');
  const id=Number(req.params.id),decision=req.body?.decision,verification=String(req.body?.verification||'').trim();
  if(!integer(id)||!['approved','rejected'].includes(decision))return fail(res,400,'Decisão inválida');
  if(decision==='approved'&&verification.length<20)return fail(res,400,'Informe justificativa e verificação independente');
  db.exec('BEGIN IMMEDIATE');
  try{
   const d=q('SELECT * FROM wallet_deposits WHERE id=?',id);
   if(!d){db.exec('ROLLBACK');return fail(res,404,'Solicitação não encontrada')}
   if(d.status!=='pending'){db.exec('ROLLBACK');return fail(res,409,'Solicitação já analisada')}
   if(decision==='approved'&&!(d.method==='pix_manual'?d.reference:d.tx_hash)){db.exec('ROLLBACK');return fail(res,409,'Comprovante ou transação ausente')}
   const actor=String(req.user.username||'admin').slice(0,100);
   run('UPDATE wallet_deposits SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status=?',decision,actor,id,'pending');
   if(decision==='approved'){
    run('INSERT OR IGNORE INTO wallet_accounts(client_id,balance_cents) VALUES (?,0)',d.client_id);
    run('UPDATE wallet_accounts SET balance_cents=balance_cents+? WHERE client_id=?',d.amount_cents,d.client_id);
    const balance=q('SELECT balance_cents FROM wallet_accounts WHERE client_id=?',d.client_id).balance_cents;
    run('INSERT INTO wallet_ledger(client_id,deposit_id,delta_cents,balance_after_cents) VALUES (?,?,?,?)',d.client_id,id,d.amount_cents,balance);
   }
   audit(id,'admin:'+actor,'deposit_'+decision,verification.slice(0,500));
   db.exec('COMMIT');res.json({id,status:decision});
  }catch(e){db.exec('ROLLBACK');console.error('Wallet review failed:',e.message);return fail(res,500,'Falha ao processar solicitação')}
 });
 app.use('/api/admin/wallet',admin);
}