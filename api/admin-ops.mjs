// Admin operations toolkit (read-only): filtered/paginated orders, summary report, audited CSV export,
// audit-log search and a redacted queue of customer order drafts.
// Mounted under /api/admin/ops. server.mjs already protects /api/admin with the admin IP gate and the
// admin-session guard; this router additionally fails closed when req.user is not an admin.
// Nothing here mutates business data (the only write is the audit row recorded for each CSV export).
import {Router} from 'express';
import {ORDER_TRANSITIONS} from './order-transitions.mjs';

const STATUSES=Object.keys(ORDER_TRANSITIONS);
const OPEN_STATUSES=['pendente','em_processamento'];
const DONE_STATUSES=['concluido','entregue'];
for(const s of [...OPEN_STATUSES,...DONE_STATUSES])if(!STATUSES.includes(s))throw Error('admin-ops: status "'+s+'" missing from the order state machine');
const SORTS={id_desc:'o.id DESC',id_asc:'o.id ASC',updated_desc:'o.updated_at DESC,o.id DESC',price_desc:'o.price_brl DESC,o.id DESC'};
const DRAFT_KINDS=['imei','server','api','legacy'];
const CSV_MAX_ROWS=5000,EXPORT_WINDOW_MS=10*60*1000,EXPORT_MAX=10;
const CSV_COLUMNS=[['id','id','int'],['criado_em','created_at'],['atualizado_em','updated_at'],['cliente','customer_name'],['contato','customer_contact'],['marca','device_brand'],['modelo','device_model'],['servico','service_name'],['valor_brl','price_brl','money'],['pagamento','payment_status'],['status','status']];

class BadRequest extends Error{}
const bad=message=>{throw new BadRequest(message)};
const intParam=(v,{min,max,def,name})=>{
 if(v===undefined||v==='')return def;
 if(typeof v!=='string'||!/^-?\d{1,9}$/.test(v))bad(name+' inválido');
 const n=Number(v);if(n<min||n>max)bad(name+' fora do intervalo permitido');return n;
};
const dateParam=(v,name)=>{
 if(v===undefined||v==='')return null;
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))bad(name+' inválida (use AAAA-MM-DD)');
 const d=new Date(v+'T00:00:00Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==v)bad(name+' inválida');return v;
};
const textParam=(v,name,max=80)=>{
 if(v===undefined||v==='')return null;
 if(typeof v!=='string')bad(name+' inválido');
 const s=v.trim();if(s.length>max)bad(name+' muito longo');return s||null;
};
const slugParam=(v,name,max)=>{const s=textParam(v,name,max);if(s&&!/^[a-z_]+$/.test(s))bad(name+' inválido');return s};
const like=s=>'%'+s.replace(/[\\%_]/g,'\\$&')+'%';
const pageParams=query=>({limit:intParam(query.limit,{min:1,max:200,def:50,name:'limit'}),offset:intParam(query.offset,{min:0,max:100000,def:0,name:'offset'})});
const dateRange=(query,column,where,args,applied)=>{
 const from=dateParam(query.from,'from'),to=dateParam(query.to,'to');
 if(from&&to&&from>to)bad('Período inválido: "from" é posterior a "to"');
 if(from){where.push('date('+column+')>=?');args.push(from);applied.from=from}
 if(to){where.push('date('+column+')<=?');args.push(to);applied.to=to}
};
const money=n=>Math.round((Number(n)||0)*100)/100;
const csvCell=(v,type,sep)=>{
 if(type==='int')return String(Number(v)||0);
 if(type==='money')return money(v).toFixed(2).replace('.',sep===';'?',':'.');
 let s=v==null?'':String(v);
 if(/^[=+\-@\t\r]/.test(s))s="'"+s; // neutralise spreadsheet formula injection
 return s.includes(sep)||/["\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
};
// Draft details may hold customer credentials (account, license key, free-text); only field names leave the server.
const summarizeDraft=raw=>{
 let parsed={};try{parsed=JSON.parse(raw||'{}')}catch{}
 const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
 const o=plain(parsed),details=plain(o.details),api=plain(details.api_fields);
 return {
  kind:DRAFT_KINDS.includes(o.kind)?o.kind:'legacy',
  mode:typeof details.mode==='string'?details.mode.slice(0,20):null,
  provided_fields:Object.keys(details).filter(k=>k!=='api_fields'&&details[k]!=null&&details[k]!=='').slice(0,12).map(k=>k.slice(0,40)),
  api_field_names:Object.keys(api).slice(0,24).map(k=>k.slice(0,60))
 };
};

export function mountAdminOps(app,db){
 const one=(sql,...a)=>db.prepare(sql).get(...a),many=(sql,...a)=>db.prepare(sql).all(...a);
 const hasTable=name=>Boolean(one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",name));
 const router=Router();
 router.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.user?.role!=='admin')return res.status(403).json({error:'Acesso restrito'});
  next();
 });
 const wrap=fn=>(req,res)=>{
  try{fn(req,res)}
  catch(e){
   if(e instanceof BadRequest)return res.status(400).json({error:e.message});
   console.error('admin-ops failure:',e.message);res.status(500).json({error:'Erro interno'});
  }
 };

 const ORDERS_FROM=' FROM orders o LEFT JOIN services s ON s.id=o.service_id';
 function orderFilter(query){
  const where=[],args=[],applied={};
  const status=textParam(query.status,'status',120);
  if(status){
   const list=[...new Set(status.split(',').map(s=>s.trim()).filter(Boolean))];
   if(!list.length||list.some(s=>!STATUSES.includes(s)))bad('status inválido');
   where.push('o.status IN ('+list.map(()=>'?').join(',')+')');args.push(...list);applied.status=list;
  }
  const pay=slugParam(query.payment_status,'payment_status',30);
  if(pay){where.push('o.payment_status=?');args.push(pay);applied.payment_status=pay}
  const sid=intParam(query.service_id,{min:1,max:2147483647,def:null,name:'service_id'});
  if(sid!==null){where.push('o.service_id=?');args.push(sid);applied.service_id=sid}
  dateRange(query,'o.created_at',where,args,applied);
  const q=textParam(query.q,'q');
  if(q){
   const cols=['o.customer_name','o.customer_contact','o.device_brand','o.device_model','o.anydesk_id','s.name'];
   const parts=cols.map(c=>c+" LIKE ? ESCAPE '\\'");args.push(...cols.map(()=>like(q)));
   if(/^\d{1,9}$/.test(q)){parts.push('o.id=?');args.push(Number(q))}
   where.push('('+parts.join(' OR ')+')');applied.q=q;
  }
  return {where:where.length?' WHERE '+where.join(' AND '):'',args,applied};
 }

 router.get('/orders',wrap((req,res)=>{
  const {where,args,applied}=orderFilter(req.query),{limit,offset}=pageParams(req.query);
  const sort=req.query.sort===undefined?'id_desc':String(req.query.sort);
  if(!Object.hasOwn(SORTS,sort))bad('sort inválido');
  const total=one('SELECT COUNT(*) AS n'+ORDERS_FROM+where,...args).n;
  const items=many('SELECT o.*,s.name AS service_name'+ORDERS_FROM+where+' ORDER BY '+SORTS[sort]+' LIMIT ? OFFSET ?',...args,limit,offset);
  res.json({items,total,limit,offset,sort,filters:applied});
 }));

 const exportsByUser=new Map();
 const allowExport=user=>{
  const now=Date.now(),recent=(exportsByUser.get(user)||[]).filter(t=>now-t<EXPORT_WINDOW_MS);
  if(recent.length>=EXPORT_MAX){exportsByUser.set(user,recent);return false}
  recent.push(now);exportsByUser.set(user,recent);
  if(exportsByUser.size>200)for(const [k,v] of exportsByUser)if(!v.some(t=>now-t<EXPORT_WINDOW_MS))exportsByUser.delete(k);
  return true;
 };
 router.get('/orders.csv',wrap((req,res)=>{
  const {where,args,applied}=orderFilter(req.query);
  const sepName=req.query.sep===undefined?'comma':String(req.query.sep);
  if(!['comma','semicolon'].includes(sepName))bad('sep inválido');
  const sep=sepName==='semicolon'?';':',';
  const total=one('SELECT COUNT(*) AS n'+ORDERS_FROM+where,...args).n;
  if(total>CSV_MAX_ROWS)return res.status(422).json({error:'Exportação limitada a '+CSV_MAX_ROWS+' linhas ('+total+' encontradas): refine período ou status',total,max:CSV_MAX_ROWS});
  if(!allowExport(req.user.username)){
   res.setHeader('Retry-After',String(EXPORT_WINDOW_MS/1000));
   return res.status(429).json({error:'Limite de exportações atingido; tente novamente em alguns minutos'});
  }
  const rows=many('SELECT o.*,s.name AS service_name'+ORDERS_FROM+where+' ORDER BY o.id ASC',...args);
  const lines=[CSV_COLUMNS.map(c=>c[0]).join(sep),...rows.map(r=>CSV_COLUMNS.map(([,key,type])=>csvCell(r[key],type,sep)).join(sep))];
  // Audit trail for bulk customer-data exports; the free-text search term is never stored.
  const logged={...applied};if(logged.q)logged.q=true;
  db.prepare('INSERT INTO audit_logs(entity,entity_id,action,detail) VALUES (?,?,?,?)').run('export',null,'orders_csv',('by='+req.user.username+';rows='+rows.length+';filters='+JSON.stringify(logged)).slice(0,500));
  const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,13).replace('T','-');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="os-'+stamp+'.csv"');
  res.send(String.fromCharCode(0xFEFF)+lines.join('\r\n')+'\r\n'); // BOM so Excel opens the UTF-8 file with the right encoding
 }));

 router.get('/summary',wrap((req,res)=>{
  const days=intParam(req.query.days,{min:1,max:366,def:30,name:'days'});
  const today=new Date(),dayList=[];
  for(let i=days-1;i>=0;i--)dayList.push(new Date(today.getTime()-i*86400000).toISOString().slice(0,10));
  const from=dayList[0],to=dayList[dayList.length-1];
  const rows=many('SELECT date(created_at) AS day,status,payment_status,COUNT(*) AS n,COALESCE(SUM(price_brl),0) AS total FROM orders WHERE date(created_at)>=? GROUP BY day,status,payment_status',from);
  const byStatus=new Map(STATUSES.map(s=>[s,{status:s,count:0,total_brl:0}])),byPayment=new Map(),daily=new Map(dayList.map(d=>[d,{day:d,count:0,total_brl:0}]));
  let count=0,sum=0,completed=0;
  for(const r of rows){
   const st=byStatus.get(r.status)||byStatus.set(r.status,{status:r.status,count:0,total_brl:0}).get(r.status);
   const pay=byPayment.get(r.payment_status)||byPayment.set(r.payment_status,{payment_status:r.payment_status,count:0,total_brl:0}).get(r.payment_status);
   const day=daily.get(r.day);
   for(const bucket of [st,pay,day])if(bucket){bucket.count+=r.n;bucket.total_brl+=r.total}
   count+=r.n;sum+=r.total;if(DONE_STATUSES.includes(r.status))completed+=r.total;
  }
  const rounded=list=>[...list.values()].map(x=>({...x,total_brl:money(x.total_brl)}));
  const open=one('SELECT COUNT(*) AS n FROM orders WHERE status IN ('+OPEN_STATUSES.map(()=>'?').join(',')+')',...OPEN_STATUSES).n;
  const drafts=hasTable('client_order_drafts')?one("SELECT COUNT(*) AS total,COALESCE(SUM(date(created_at)>=date('now','-6 days')),0) AS last_7_days FROM client_order_drafts"):{total:0,last_7_days:0};
  res.json({
   generated_at:new Date().toISOString(),timezone:'UTC',period:{from,to,days},
   orders:{count,total_brl:money(sum),completed_total_brl:money(completed)},
   by_status:rounded(byStatus),by_payment_status:rounded(byPayment).sort((a,b)=>String(a.payment_status).localeCompare(String(b.payment_status))),daily:rounded(daily),
   backlog:{open_orders:open,open_tickets:one("SELECT COUNT(*) AS n FROM support_tickets WHERE status='open'").n},
   client_drafts:{total:drafts.total,last_7_days:drafts.last_7_days}
  });
 }));

 router.get('/client-drafts',wrap((req,res)=>{
  const {limit,offset}=pageParams(req.query);
  const where=[],args=[],applied={};
  // Same classification as summarizeDraft(): anything that is not a known kind (bad JSON, NULL, other types) is 'legacy'.
  // Nested CASE keeps json_extract from ever running on malformed JSON.
  const kindExpr="CASE WHEN json_valid(d.details_json) THEN CASE WHEN json_extract(d.details_json,'$.kind') IN ("+DRAFT_KINDS.map(k=>"'"+k+"'").join(',')+") THEN json_extract(d.details_json,'$.kind') ELSE 'legacy' END ELSE 'legacy' END";
  const kind=textParam(req.query.kind,'kind',10);
  if(kind&&!DRAFT_KINDS.includes(kind))bad('kind inválido');
  dateRange(req.query,'d.created_at',where,args,applied);
  const q=textParam(req.query.q,'q');
  if(q){
   const cols=['d.service_name','d.device_model','d.identifier','u.email','u.display_name'];
   where.push('('+cols.map(c=>c+" LIKE ? ESCAPE '\\'").join(' OR ')+')');args.push(...cols.map(()=>like(q)));applied.q=q;
  }
  if(!hasTable('client_order_drafts')||!hasTable('client_users'))return res.json({items:[],total:0,limit,offset,by_kind:{},filters:applied});
  const base=' FROM client_order_drafts d JOIN client_users u ON u.id=d.client_id';
  const whereSql=where.length?' WHERE '+where.join(' AND '):'';
  const byKind=Object.fromEntries(many('SELECT '+kindExpr+' AS kind,COUNT(*) AS n'+base+whereSql+' GROUP BY kind',...args).map(r=>[r.kind,r.n]));
  if(kind){where.push(kindExpr+'=?');args.push(kind);applied.kind=kind}
  const filtered=where.length?' WHERE '+where.join(' AND '):'';
  const total=one('SELECT COUNT(*) AS n'+base+filtered,...args).n;
  const items=many('SELECT d.id,d.created_at,d.service_name,d.device_model,d.identifier,d.details_json,u.id AS client_id,u.email,u.display_name'+base+filtered+' ORDER BY d.id DESC LIMIT ? OFFSET ?',...args,limit,offset).map(r=>({
   id:r.id,created_at:r.created_at,status:'draft',client:{id:r.client_id,email:r.email,display_name:r.display_name},
   service_name:r.service_name,device_model:r.device_model,identifier:r.identifier,details_summary:summarizeDraft(r.details_json)
  }));
  res.json({items,total,limit,offset,by_kind:byKind,filters:applied});
 }));

 router.get('/audit',wrap((req,res)=>{
  const {limit,offset}=pageParams(req.query);
  const where=[],args=[],applied={};
  const entity=slugParam(req.query.entity,'entity',30),action=slugParam(req.query.action,'action',40);
  if(entity){where.push('entity=?');args.push(entity);applied.entity=entity}
  if(action){where.push('action=?');args.push(action);applied.action=action}
  const eid=intParam(req.query.entity_id,{min:1,max:2147483647,def:null,name:'entity_id'});
  if(eid!==null){where.push('entity_id=?');args.push(eid);applied.entity_id=eid}
  dateRange(req.query,'created_at',where,args,applied);
  const q=textParam(req.query.q,'q');
  if(q){where.push("detail LIKE ? ESCAPE '\\'");args.push(like(q));applied.q=q}
  const whereSql=where.length?' WHERE '+where.join(' AND '):'';
  const total=one('SELECT COUNT(*) AS n FROM audit_logs'+whereSql,...args).n;
  const items=many('SELECT id,entity,entity_id,action,detail,created_at FROM audit_logs'+whereSql+' ORDER BY id DESC LIMIT ? OFFSET ?',...args,limit,offset);
  res.json({items,total,limit,offset,filters:applied,facets:{entities:many('SELECT DISTINCT entity FROM audit_logs ORDER BY entity LIMIT 100').map(r=>r.entity),actions:many('SELECT DISTINCT action FROM audit_logs ORDER BY action LIMIT 100').map(r=>r.action)}});
 }));

 app.use('/api/admin/ops',router);
}
