// Automatic PIX top-ups through MazzoPay (https://mazzopay.com/docs).
// - Charges are created server-side with an Idempotency-Key; the API key never reaches the browser or the logs.
// - Each charge is tied to a wallet_deposits row (method pix_manual, reference "mazzopay:<id>") so the existing
//   wallet_ledger UNIQUE(deposit_id) guarantees a single credit per charge.
// - Credit happens only when the provider reports the charge as "paga" with the expected amount: from a signed
//   webhook (re-confirmed with GET /cobrancas/{id}), from the client status poll, or from event reconciliation.
// - Disabled unless MAZZOPAY_ENABLED=true and MAZZOPAY_API_KEY is set. No withdrawals are implemented.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {Router} from 'express';

const env=(k,d='')=>String(process.env[k]??d).trim();
const intEnv=(k,d)=>{const n=Number.parseInt(env(k),10);return Number.isSafeInteger(n)&&n>0?n:d};
const baseUrl=()=>env('MAZZOPAY_BASE_URL','https://api.mazzopay.com/v1').replace(/\/$/,'');
export const mazzoEnabled=()=>env('MAZZOPAY_ENABLED')==='true'&&!!env('MAZZOPAY_API_KEY');
const limits=()=>({min:intEnv('MAZZOPAY_MIN_CENTS',1000),max:intEnv('MAZZOPAY_MAX_CENTS',100000),expires:Math.min(120,Math.max(5,intEnv('MAZZOPAY_EXPIRES_MINUTES',30))),pending:intEnv('MAZZOPAY_MAX_PENDING_PER_CLIENT',3)});
const FINAL_UNPAID=['expirada','cancelada','falhou'];
const KNOWN=['pendente','paga','expirada','cancelada','falhou','em_analise','devolvida','devolvida_parcial'];

// Webhook signature: header "t=<unix>,v1=<hex>[,v1=<hex>]", HMAC-SHA256(secret, `${t}.` + raw body), 300 s tolerance.
export function verifyMazzoSignature(raw,header,secret,nowSec=Math.floor(Date.now()/1000)){
 if(!secret||!header||!Buffer.isBuffer(raw))return false;
 let t;const v1=[];
 for(const part of String(header).split(',')){const i=part.indexOf('=');if(i<1)continue;const k=part.slice(0,i).trim(),v=part.slice(i+1).trim();if(k==='t')t=Number(v);if(k==='v1'&&/^[a-f0-9]{64}$/i.test(v))v1.push(v)}
 if(!Number.isInteger(t)||!v1.length||Math.abs(nowSec-t)>300)return false;
 const expected=createHmac('sha256',secret).update(`${t}.`).update(raw).digest();
 return v1.some(hex=>{const got=Buffer.from(hex,'hex');return got.length===expected.length&&timingSafeEqual(got,expected)});
}

export class MazzoError extends Error{constructor(message,{status=0,code='ERRO',details=null,requestId='',transient=false}={}){super(message);this.status=status;this.code=code;this.details=details;this.requestId=requestId;this.transient=transient}}
export async function mazzoCall(method,path,{body,idempotencyKey,timeoutMs=20000}={}){
 const headers={Authorization:'Bearer '+env('MAZZOPAY_API_KEY'),Accept:'application/json'};
 if(body!==undefined)headers['Content-Type']='application/json';
 if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
 let r;
 try{r=await fetch(baseUrl()+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs),redirect:'error'})}
 catch{throw new MazzoError('Provedor PIX indisponível',{code:'REDE',transient:true})}
 const requestId=r.headers.get('x-request-id')||'';let data=null;try{data=await r.json()}catch{}
 if(!r.ok){const e=data?.erro||{};const code=String(e.codigo||'HTTP_'+r.status);throw new MazzoError(String(e.mensagem||'Falha no provedor PIX'),{status:r.status,code,details:e.detalhes??null,requestId,transient:r.status>=500||r.status===429||['IDEMPOTENCY_EM_ANDAMENTO','PROVEDOR_INDISPONIVEL','EM_ANDAMENTO','MUITAS_REQUISICOES'].includes(code)})}
 return {data,requestId};
}

export function mountMazzoPay(app,db,{client,adminGuard}){
 db.exec(`CREATE TABLE IF NOT EXISTS mazzopay_charges(id INTEGER PRIMARY KEY,deposit_id INTEGER NOT NULL UNIQUE REFERENCES wallet_deposits(id),client_id INTEGER NOT NULL REFERENCES client_users(id),
  client_key TEXT,referencia TEXT NOT NULL UNIQUE,provider_id TEXT UNIQUE,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),status TEXT NOT NULL DEFAULT 'criando',
  copia_e_cola TEXT,qr_code TEXT,expires_at TEXT,paid_at TEXT,e2e_id TEXT,fee_cents INTEGER,net_cents INTEGER,attention TEXT,last_error TEXT,request_id TEXT,
  synced_at INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_mazzopay_client_key ON mazzopay_charges(client_id,client_key) WHERE client_key IS NOT NULL;
 CREATE INDEX IF NOT EXISTS idx_mazzopay_client ON mazzopay_charges(client_id,id);
 CREATE TABLE IF NOT EXISTS mazzopay_events(id TEXT PRIMARY KEY,tipo TEXT NOT NULL,sequencia INTEGER,provider_charge_id TEXT,via TEXT NOT NULL,outcome TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS mazzopay_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 const q=(sql,...v)=>db.prepare(sql).get(...v),all=(sql,...v)=>db.prepare(sql).all(...v),run=(sql,...v)=>db.prepare(sql).run(...v);
 const audit=(depositId,actor,action,details='')=>run('INSERT INTO wallet_audit(deposit_id,actor,action,details) VALUES (?,?,?,?)',depositId,actor,action,String(details).slice(0,500));
 const fail=(res,status,error,extra={})=>res.status(status).json({error,...extra});
 const view=c=>c&&({id:c.id,deposit_id:c.deposit_id,amount_cents:c.amount_cents,status:c.status,copia_e_cola:c.status==='pendente'?c.copia_e_cola:null,qr_code:c.status==='pendente'?c.qr_code:null,expires_at:c.expires_at,paid_at:c.paid_at,created_at:c.created_at});

 // Single place where provider state is applied. Runs in one IMMEDIATE transaction; safe to call repeatedly.
 function applyCharge(remote,via){
  if(!remote||typeof remote!=='object')return 'invalid';
  const providerId=String(remote.id||''),ref=String(remote.referencia||''),status=String(remote.status||'');
  if(!KNOWN.includes(status))return 'unknown_status';
  db.exec('BEGIN IMMEDIATE');
  try{
   const c=q('SELECT * FROM mazzopay_charges WHERE (provider_id IS NOT NULL AND provider_id=?) OR referencia=?',providerId,ref);
   if(!c){db.exec('ROLLBACK');return 'unknown_charge'}
   if(c.provider_id&&providerId&&c.provider_id!==providerId){db.exec('ROLLBACK');return 'provider_mismatch'}
   const base=Number.isSafeInteger(remote.valorBase)?remote.valorBase:remote.valor;
   let outcome='noop';
   const touch=(fields)=>{const keys=Object.keys(fields);run(`UPDATE mazzopay_charges SET ${keys.map(k=>k+'=?').join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`,...keys.map(k=>fields[k]),c.id)};
   if(!c.provider_id&&providerId)touch({provider_id:providerId});
   if(status==='paga'){
    if(base!==c.amount_cents){touch({status:'em_analise',attention:'amount_mismatch'});audit(c.deposit_id,'mazzopay:'+via,'pix_amount_mismatch',`esperado ${c.amount_cents}, recebido ${base}`);outcome='amount_mismatch'}
    else{
     const d=q('SELECT * FROM wallet_deposits WHERE id=?',c.deposit_id);
     touch({status:'paga',paid_at:String(remote.pagamento?.pagoEm||new Date().toISOString()),e2e_id:remote.pagamento?.e2eId?String(remote.pagamento.e2eId).slice(0,64):null,fee_cents:Number.isSafeInteger(remote.taxa)?remote.taxa:null,net_cents:Number.isSafeInteger(remote.valorLiquido)?remote.valorLiquido:null,attention:null});
     if(d&&d.status!=='approved'&&!q('SELECT id FROM wallet_ledger WHERE deposit_id=?',d.id)){
      run("UPDATE wallet_deposits SET status='approved',reviewed_by='mazzopay',reviewed_at=CURRENT_TIMESTAMP WHERE id=?",d.id);
      run('INSERT OR IGNORE INTO wallet_accounts(client_id,balance_cents) VALUES (?,0)',d.client_id);
      run('UPDATE wallet_accounts SET balance_cents=balance_cents+? WHERE client_id=?',d.amount_cents,d.client_id);
      const balance=q('SELECT balance_cents FROM wallet_accounts WHERE client_id=?',d.client_id).balance_cents;
      run('INSERT INTO wallet_ledger(client_id,deposit_id,delta_cents,balance_after_cents) VALUES (?,?,?,?)',d.client_id,d.id,d.amount_cents,balance);
      audit(d.id,'mazzopay:'+via,'pix_paid_credited',providerId);outcome='credited';
     }else outcome='already_credited';
    }
   }else if(FINAL_UNPAID.includes(status)){
    if(c.status!=='paga'){touch({status,copia_e_cola:null,qr_code:null});run("UPDATE wallet_deposits SET status='rejected',reviewed_by='mazzopay',reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",c.deposit_id);audit(c.deposit_id,'mazzopay:'+via,'pix_'+status,providerId);outcome=status}
   }else if(status==='devolvida'||status==='devolvida_parcial'){
    // Refunds after credit need a human decision (the ledger only records credits); flag for the admin.
    touch({status,attention:'refund_after_credit'});audit(c.deposit_id,'mazzopay:'+via,'pix_refund_needs_review',providerId);outcome='refund_flagged';
   }else if(status==='em_analise'){if(c.status!=='paga'){touch({status});outcome='in_review'}}
   else if(status==='pendente'&&c.status==='criando'){touch({status})}
   touch({synced_at:Date.now()});
   db.exec('COMMIT');return outcome;
  }catch(e){try{db.exec('ROLLBACK')}catch{}console.error('MazzoPay apply failed:',e.message);throw e}
 }
 const fromCreate=(c,data,requestId)=>run(`UPDATE mazzopay_charges SET provider_id=?,status=?,copia_e_cola=?,qr_code=?,expires_at=?,fee_cents=?,net_cents=?,request_id=?,last_error=NULL,synced_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  String(data.id),KNOWN.includes(data.status)?data.status:'pendente',typeof data.pix?.copiaECola==='string'?data.pix.copiaECola.slice(0,1000):null,
  typeof data.pix?.qrCodeBase64==='string'&&/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(data.pix.qrCodeBase64)&&data.pix.qrCodeBase64.length<200000?data.pix.qrCodeBase64:null,
  data.pix?.expiraEm?String(data.pix.expiraEm):null,Number.isSafeInteger(data.taxa)?data.taxa:null,Number.isSafeInteger(data.valorLiquido)?data.valorLiquido:null,requestId,Date.now(),c.id);
 async function submit(c,clientName){
  const lim=limits();
  try{
   const body={valor:c.amount_cents,descricao:'Recarga de carteira UNLOCKER Tools #'+c.deposit_id,referencia:c.referencia,expiraEmMinutos:lim.expires,metadados:{deposit_id:String(c.deposit_id),client_id:String(c.client_id)}};
   if(clientName)body.nomeCliente=String(clientName).slice(0,80);
   const {data,requestId}=await mazzoCall('POST','/cobrancas',{body,idempotencyKey:c.referencia});
   fromCreate(c,data,requestId);if(data.status&&data.status!=='pendente')applyCharge(data,'create');
  }catch(e){
   if(e.code==='REFERENCIA_DUPLICADA'&&e.details?.id){const {data}=await mazzoCall('GET','/cobrancas/'+encodeURIComponent(e.details.id));fromCreate(c,data,'');applyCharge(data,'create');return}
   run('UPDATE mazzopay_charges SET last_error=?,request_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',e.code,e.requestId||null,c.id);
   if(!e.transient){run("UPDATE mazzopay_charges SET status='falhou' WHERE id=?",c.id);run("UPDATE wallet_deposits SET status='rejected',reviewed_by='mazzopay',reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",c.deposit_id);audit(c.deposit_id,'mazzopay:create','pix_create_failed',e.code+' '+(e.requestId||''))}
   throw e;
  }
 }
 async function refresh(c,via){
  if(!c.provider_id)return c;
  const {data}=await mazzoCall('GET','/cobrancas/'+encodeURIComponent(c.provider_id),{timeoutMs:8000});
  applyCharge(data,via);return q('SELECT * FROM mazzopay_charges WHERE id=?',c.id);
 }
 // Reconciliation: replay provider events after the stored sequence cursor, then re-check old pending charges.
 let reconciling=false;
 async function reconcile(){
  if(!mazzoEnabled()||reconciling)return {skipped:true};reconciling=true;const result={events:0,credited:0,checked:0};
  try{
   let cursor=Number(q("SELECT value FROM mazzopay_state WHERE key='events_cursor'")?.value||0);
   for(let page=0;page<20;page++){
    const {data}=await mazzoCall('GET','/eventos?limite=100&depoisDe='+cursor,{timeoutMs:15000});
    for(const ev of data?.dados||[]){
     result.events++;
     if(String(ev.tipo).startsWith('cobranca.')&&ev.dados?.cobranca){const seen=q('SELECT outcome FROM mazzopay_events WHERE id=?',String(ev.id));if(!seen?.outcome){const out=applyCharge(ev.dados.cobranca,'events');if(out==='credited')result.credited++;run('INSERT INTO mazzopay_events(id,tipo,sequencia,provider_charge_id,via,outcome) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,sequencia=excluded.sequencia',String(ev.id),String(ev.tipo),Number(ev.sequencia)||null,String(ev.dados.cobranca.id||''),'events',out)}}
     if(Number.isSafeInteger(ev.sequencia)&&ev.sequencia>cursor)cursor=ev.sequencia;
    }
    run("INSERT INTO mazzopay_state(key,value) VALUES ('events_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(cursor));
    if(data?.proximo==null)break;
   }
   for(const c of all("SELECT * FROM mazzopay_charges WHERE status IN ('pendente','em_analise') AND provider_id IS NOT NULL AND synced_at<? ORDER BY id LIMIT 25",Date.now()-120000)){try{await refresh(c,'reconcile');result.checked++}catch{}}
   run("INSERT INTO mazzopay_state(key,value) VALUES ('last_reconcile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",new Date().toISOString());
   return result;
  }finally{reconciling=false}
 }
 if(mazzoEnabled()&&env('NODE_ENV')!=='test'){const every=Math.max(60000,intEnv('MAZZOPAY_RECONCILE_MS',300000));setInterval(()=>reconcile().catch(e=>console.error('MazzoPay reconcile failed:',e.code||e.message)),every).unref()}

 // ---- client routes: /api/client/wallet/pix ----
 const createHits=new Map();
 const createLimit=(req,res,next)=>{const now=Date.now(),k=req.walletClient.id;const h=(createHits.get(k)||[]).filter(t=>t>now-600000);if(h.length>=10)return fail(res,429,'Muitas recargas geradas; aguarde alguns minutos');h.push(now);createHits.set(k,h);next()};
 const c=Router();c.use(client);
 c.get('/config',(req,res)=>{const l=limits();res.json({enabled:mazzoEnabled(),min_cents:l.min,max_cents:l.max,expires_minutes:l.expires,provider:'MazzoPay'})});
 c.get('/charges',(req,res)=>res.json(all('SELECT * FROM mazzopay_charges WHERE client_id=? ORDER BY id DESC LIMIT 20',req.walletClient.id).map(view)));
 c.get('/charges/:id',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0)return fail(res,400,'Identificador inválido');
  let row=q('SELECT * FROM mazzopay_charges WHERE id=? AND client_id=?',id,req.walletClient.id);if(!row)return fail(res,404,'Recarga não encontrada');
  if(mazzoEnabled()&&['pendente','em_analise'].includes(row.status)&&Date.now()-row.synced_at>10000){try{row=await refresh(row,'poll')}catch{}}
  res.json(view(row));
 });
 c.post('/charges',createLimit,async(req,res)=>{
  if(!mazzoEnabled())return fail(res,503,'Recarga automática por PIX indisponível no momento');
  const l=limits(),amount=req.body?.amount_cents;
  if(!Number.isSafeInteger(amount)||amount<l.min||amount>l.max)return fail(res,400,`Informe um valor entre ${(l.min/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} e ${(l.max/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`);
  const key=String(req.get('Idempotency-Key')||'').trim();if(key&&!/^[A-Za-z0-9_.:-]{8,64}$/.test(key))return fail(res,400,'Chave de idempotência inválida');
  const clientId=req.walletClient.id;
  if(key){const prev=q('SELECT * FROM mazzopay_charges WHERE client_id=? AND client_key=?',clientId,key);if(prev){if(prev.amount_cents!==amount)return fail(res,409,'Chave de idempotência já usada com outro valor');if(prev.status==='criando'){try{await submit(prev,null)}catch(e){return fail(res,e.transient?502:400,e.transient?'Não foi possível gerar o PIX agora; tente novamente':e.message)}}return res.status(200).json(view(q('SELECT * FROM mazzopay_charges WHERE id=?',prev.id)))}}
  let row;
  db.exec('BEGIN IMMEDIATE');
  try{
   const open=q("SELECT COUNT(*) AS n FROM mazzopay_charges WHERE client_id=? AND status IN ('criando','pendente') AND (expires_at IS NULL OR expires_at>?)",clientId,new Date().toISOString()).n;
   if(open>=l.pending){db.exec('ROLLBACK');return fail(res,429,'Você já tem recargas PIX pendentes. Pague ou aguarde expirar antes de gerar outra.')}
   const depositId=Number(run("INSERT INTO wallet_deposits(client_id,method,amount_cents,reference) VALUES (?,'pix_manual',?,?)",clientId,amount,'mazzopay:pendente').lastInsertRowid);
   const referencia='ut-dep-'+depositId;
   run('UPDATE wallet_deposits SET reference=? WHERE id=?','mazzopay:'+referencia,depositId);
   const id=Number(run('INSERT INTO mazzopay_charges(deposit_id,client_id,client_key,referencia,amount_cents) VALUES (?,?,?,?,?)',depositId,clientId,key||null,referencia,amount).lastInsertRowid);
   audit(depositId,'client:'+clientId,'pix_charge_requested',String(amount));
   db.exec('COMMIT');row=q('SELECT * FROM mazzopay_charges WHERE id=?',id);
  }catch(e){try{db.exec('ROLLBACK')}catch{}console.error('MazzoPay create failed:',e.message);return fail(res,500,'Falha ao registrar a recarga')}
  const name=q('SELECT display_name FROM client_users WHERE id=?',clientId)?.display_name;
  try{await submit(row,name)}catch(e){return fail(res,e.transient?502:400,e.transient?'Não foi possível gerar o PIX agora; tente novamente':(e.code==='LIMITE_EXCEDIDO'?'Limite de recebimento atingido; tente um valor menor ou mais tarde':e.message),{code:e.code})}
  res.status(201).json(view(q('SELECT * FROM mazzopay_charges WHERE id=?',row.id)));
 });
 app.use('/api/client/wallet/pix',c);

 // ---- admin routes: /api/admin/wallet/pix ----
 const a=Router();a.use(adminGuard,(req,res,next)=>req.user?.role==='admin'?next():fail(res,403,'Acesso restrito'));
 a.get('/charges',(req,res)=>res.json(all('SELECT id,deposit_id,client_id,referencia,provider_id,amount_cents,status,expires_at,paid_at,fee_cents,net_cents,attention,last_error,request_id,created_at,updated_at FROM mazzopay_charges ORDER BY id DESC LIMIT 200')));
 a.get('/status',async(req,res)=>{
  const st={enabled:mazzoEnabled(),webhook_secret_configured:!!env('MAZZOPAY_WEBHOOK_SECRET'),last_reconcile:q("SELECT value FROM mazzopay_state WHERE key='last_reconcile'")?.value||null,events_cursor:Number(q("SELECT value FROM mazzopay_state WHERE key='events_cursor'")?.value||0),attention:q("SELECT COUNT(*) AS n FROM mazzopay_charges WHERE attention IS NOT NULL").n};
  if(mazzoEnabled()){try{const {data}=await mazzoCall('GET','/conta',{timeoutMs:8000});st.account={modo:data?.modo,fase:data?.fase,permissoes:data?.chave?.permissoes||[],limites:data?.limites||null}}catch(e){st.account_error=e.code}}
  res.json(st);
 });
 a.post('/reconcile',async(req,res)=>{if(!mazzoEnabled())return fail(res,503,'Integração PIX desativada');try{res.json(await reconcile())}catch(e){fail(res,502,'Falha na reconciliação',{code:e.code})}});
 app.use('/api/admin/wallet/pix',a);

 // ---- webhook (raw body; registered by server.mjs before express.json and the Origin check) ----
 async function webhook(req,res){
  const secret=env('MAZZOPAY_WEBHOOK_SECRET');
  if(!mazzoEnabled()||!secret)return fail(res,503,'Webhook PIX não configurado');
  if(!verifyMazzoSignature(req.body,req.get('Mazzo-Assinatura'),secret))return fail(res,401,'Assinatura inválida');
  let ev;try{ev=JSON.parse(req.body.toString('utf8'))}catch{return fail(res,400,'Corpo inválido')}
  const id=String(ev?.id||'');if(!/^[A-Za-z0-9-]{8,64}$/.test(id))return fail(res,400,'Evento inválido');
  const seen=q('SELECT outcome FROM mazzopay_events WHERE id=?',id);if(seen?.outcome)return res.json({ok:true,duplicate:true});
  const tipo=String(ev.tipo||'');let outcome='ignored';
  if(tipo.startsWith('cobranca.')&&ev.dados?.cobranca?.id){
   // Re-read the charge from the API instead of trusting the payload alone.
   try{const {data}=await mazzoCall('GET','/cobrancas/'+encodeURIComponent(String(ev.dados.cobranca.id)),{timeoutMs:6000});
    // The API has not caught up with the paid event yet: ask MazzoPay to retry instead of marking the event as processed.
    if(tipo==='cobranca.paga'&&data?.status==='pendente')return fail(res,503,'Pagamento ainda não confirmado; tente novamente');
    outcome=applyCharge(data,'webhook')}
   catch(e){console.error('MazzoPay webhook confirm failed:',e.code||e.message);return fail(res,503,'Tente novamente')}
  }else if(tipo==='teste.ping')outcome='ping';
  run('INSERT INTO mazzopay_events(id,tipo,provider_charge_id,via,outcome) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome',id,tipo.slice(0,60),String(ev.dados?.cobranca?.id||'').slice(0,64)||null,'webhook',outcome);
  res.json({ok:true,outcome});
 }
 return {webhook,reconcile,applyCharge};
}
