#!/usr/bin/env node
// Isolated admin-operations regression: filters, pagination, summary, audited CSV export, audit search and the
// redacted client-draft queue. Runs against a throw-away copy of api/ with its own SQLite files; never touches
// repository/production data and never contacts a supplier or payment provider.
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'ws-adminops-'));
const port=String(36000+Math.floor(Math.random()*900)),base='http://127.0.0.1:'+port,origin='https://unlockertools.tech';
const check=(ok,msg)=>{if(!ok)throw Error('ADMIN_OPS_FAIL: '+msg)};
let child;
try{
 cpSync(join(root,'api'),join(temp,'api'),{recursive:true});mkdirSync(join(temp,'data'));
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
 const {authdb,hashPassword,issue}=await import('file://'+join(temp,'api/auth.mjs'));
 const makeUser=(name,role)=>{const h=hashPassword('isolated-admin-ops-password-123');const u=authdb.prepare('INSERT INTO users(username,password_salt,password_hash,role) VALUES (?,?,?,?)').run(name,h.salt,h.hash,role);return issue({id:Number(u.lastInsertRowid)})};
 const admin=makeUser('ops-admin','admin'),viewer=makeUser('ops-viewer','viewer');
 child=spawn(process.execPath,[join(temp,'api/server.mjs')],{cwd:temp,env:{...process.env,PORT:port,HOST:'127.0.0.1',APP_ORIGIN:origin,ADMIN_ALLOWED_IPS:'127.0.0.1',WALLET_REQUESTS_ENABLED:'false',DEMO_MODE:'false'},stdio:'pipe'});
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await delay(200)}
 check(ready,'server did not start');

 async function call(path,{method='GET',body,token=admin}={}){
  const headers={Origin:origin};if(body)headers['Content-Type']='application/json';if(token)headers.Cookie='ws_session='+token;
  const r=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
  // Buffer#toString keeps a leading BOM (Response#text() would strip it), so the CSV BOM can be asserted.
  const text=Buffer.from(await r.arrayBuffer()).toString('utf8');let data=null;try{data=JSON.parse(text)}catch{}
  return {status:r.status,headers:r.headers,text,data};
 }
 const parseCsv=(text,sep)=>{const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++}else quoted=false}else cell+=c}else if(c==='"')quoted=true;else if(c===sep){row.push(cell);cell=''}else if(c==='\r'){}else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell=''}else cell+=c}if(cell!==''||row.length){row.push(cell);rows.push(row)}return rows};
 const sdb=new DatabaseSync(join(temp,'data','websystem.sqlite'));sdb.exec('PRAGMA busy_timeout=5000');
 const today=new Date().toISOString().slice(0,10),tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);

 // ---- seed through the public admin API (state machine enforced) and direct inserts for supplier/client data
 sdb.prepare('INSERT INTO services(name,category,price_usd) VALUES (?,?,?)').run('QA Service','Teste',1);
 const orders=[
  {customer_name:'Ana Silva',customer_contact:'ana@example.test',device_brand:'Apple',device_model:'iPhone 13',price_brl:100,payment_status:'pago'},
  {customer_name:'Bruno 100% Teste',device_model:'Moto G',price_brl:50.5},
  {customer_name:'=HYPERLINK("http://evil.example","x")',device_model:'Galaxy S21',price_brl:10},
  {customer_name:'+cmd|calc',device_model:'Pixel',price_brl:20},
  {customer_name:'Maria, "Quote" Souza',device_model:'Xiaomi',price_brl:30},
  {customer_name:'Linha1\nLinha2',device_model:'Nokia',price_brl:5},
  ...Array.from({length:12},(_,i)=>({customer_name:'Bulk '+(i+1),device_model:'Bulk Model',price_brl:1})),
  {customer_name:'Com Servico',device_model:'Svc Model',service_id:1,price_brl:7}
 ];
 const ids=[];
 for(const o of orders){const r=await call('/api/orders',{method:'POST',body:o});check(r.status===201,'seed order '+o.customer_name+' -> '+r.status);ids.push(r.data.id)}
 const patch=async(id,status)=>{const r=await call('/api/orders/'+id,{method:'PATCH',body:{status}});check(r.status===200,'patch '+id+' '+status+' -> '+r.status)};
 await patch(ids[0],'em_processamento');await patch(ids[0],'concluido');await patch(ids[1],'rejeitado');await patch(ids[2],'em_processamento');
 const addClient=(email,name)=>Number(sdb.prepare('INSERT INTO client_users(email,display_name,password_salt,password_hash) VALUES (?,?,?,?)').run(email,name,'salt','hash').lastInsertRowid);
 const c1=addClient('c1@example.test','Cliente Um'),c2=addClient('c2@example.test','Cliente Dois');
 const addDraft=(client,service,model,identifier,details)=>sdb.prepare('INSERT INTO client_order_drafts(client_id,service_name,device_model,identifier,details_json) VALUES (?,?,?,?,?)').run(client,service,model,identifier,details);
 addDraft(c1,'iCloud Check','iPhone 12','356938035643809',JSON.stringify({kind:'imei',details:{mode:'single',comments:'nota privada',api_fields:{Network:'Vivo',Email:'x@y.z'}}}));
 addDraft(c2,'Server Credits','Tool X','user-abc',JSON.stringify({kind:'server',details:{username:'SECRET-USER-777',license_key:'SECRET-LICENSE-123',remote_connection:'SECRET-RC-9'}}));
 addDraft(c1,'Legacy Service','Old','LEG-1',null);
 addDraft(c2,'Broken Details','Odd','BAD-1','{not json');
 addDraft(c1,'Weird Kind','Odd2','WEIRD-1',JSON.stringify({kind:'weird',details:'oops'}));

 // ---- access control: unauthenticated -> 401, non-admin -> 403, on every endpoint
 const endpoints=['/orders','/orders.csv','/summary','/client-drafts','/audit'].map(p=>'/api/admin/ops'+p);
 for(const p of endpoints){
  let r=await call(p,{token:null});check(r.status===401,'unauthenticated '+p+' -> '+r.status);
  r=await call(p,{token:viewer});check(r.status===403,'non-admin '+p+' -> '+r.status);
 }

 // ---- orders list: pagination, filters, sorting, validation
 const list=async q=>call('/api/admin/ops/orders'+(q?'?'+q:''));
 let r=await list();check(r.status===200&&r.data.total===19&&r.data.items.length===19&&r.data.limit===50&&r.data.offset===0&&r.data.sort==='id_desc','default list '+r.status+' '+JSON.stringify(r.data).slice(0,200));
 check(r.data.items[0].id>r.data.items[1].id,'default sort is newest first');
 check(r.data.items.find(o=>o.customer_name==='Com Servico').service_name==='QA Service','service name joined');
 r=await list('limit=5&offset=5');check(r.data.items.length===5&&r.data.total===19,'page 2');
 r=await list('limit=5&offset=15');check(r.data.items.length===4&&r.data.total===19,'last page');
 r=await list('status=concluido');check(r.data.total===1&&r.data.items[0].customer_name==='Ana Silva','status filter');
 r=await list('status=concluido,rejeitado');check(r.data.total===2,'multi status');
 r=await list('status=pendente,foo');check(r.status===400,'invalid status in list -> '+r.status);
 r=await list('status=a&status=b');check(r.status===400,'repeated param rejected');
 r=await list('payment_status=pago');check(r.data.total===1,'payment filter');
 r=await list('payment_status=PAGO');check(r.status===400,'payment slug validation');
 r=await list('q=ana');check(r.data.total===1&&r.data.items[0].customer_name==='Ana Silva','text search');
 r=await list('q=%25');check(r.data.total===1&&r.data.items[0].customer_name.startsWith('Bruno'),'percent is literal in LIKE -> '+r.data.total);
 r=await list('q=_');check(r.status===200&&r.data.total===0,'underscore is literal in LIKE');
 r=await list('q='+encodeURIComponent("' OR 1=1 --"));check(r.status===200&&r.data.total===0,'sql injection attempt matches nothing');
 r=await list('q=19');check(r.data.total===1&&r.data.items[0].id===ids[ids.length-1],'numeric q matches id');
 r=await list('q='+encodeURIComponent('QA Service'));check(r.data.total===1,'search by service name');
 r=await list('from='+today+'&to='+today);check(r.data.total===19,'today range');
 r=await list('from='+tomorrow);check(r.data.total===0,'future range');
 r=await list('from=2026-13-40');check(r.status===400,'impossible date');
 r=await list('from=2026-1-1');check(r.status===400,'date format');
 r=await list('from='+tomorrow+'&to='+today);check(r.status===400,'inverted range');
 r=await list('service_id=1');check(r.data.total===1,'service filter');
 r=await list('service_id=0');check(r.status===400,'service_id lower bound');
 r=await list('service_id=abc');check(r.status===400,'service_id type');
 r=await list('sort=price_desc');check(r.data.items[0].price_brl===100,'price sort');
 r=await list('sort=id_asc');check(r.data.items[0].id===ids[0],'id asc');
 r=await list('sort='+encodeURIComponent('id; DROP TABLE orders'));check(r.status===400,'sort whitelist');
 for(const bad of ['limit=0','limit=201','limit=abc','offset=-1','offset=100001'])check((await list(bad)).status===400,'bounds '+bad);

 // ---- CSV export
 r=await call('/api/admin/ops/orders.csv');
 check(r.status===200&&/^text\/csv/.test(r.headers.get('content-type')),'csv content type');
 check(/^attachment; filename="os-\d{8}-\d{4}\.csv"$/.test(r.headers.get('content-disposition')||''),'csv filename '+r.headers.get('content-disposition'));
 check(r.text.charCodeAt(0)===0xFEFF,'csv BOM');
 let rows=parseCsv(r.text.slice(1),',');
 check(rows[0].join(',')==='id,criado_em,atualizado_em,cliente,contato,marca,modelo,servico,valor_brl,pagamento,status','csv header');
 check(rows.length===20,'csv rows '+rows.length);
 const byId=Object.fromEntries(rows.slice(1).map(x=>[x[0],x]));
 check(byId[ids[2]][3]==="'=HYPERLINK(\"http://evil.example\",\"x\")",'formula injection neutralised: '+byId[ids[2]][3]);
 check(byId[ids[3]][3]==="'+cmd|calc",'plus injection neutralised');
 check(byId[ids[4]][3]==='Maria, "Quote" Souza','quoting round-trip');
 check(byId[ids[5]][3]==='Linha1\nLinha2','newline round-trip');
 check(byId[ids[0]][8]==='100.00'&&byId[ids[0]][10]==='concluido'&&byId[ids[0]][9]==='pago','csv values');
 r=await call('/api/admin/ops/orders.csv?sep=semicolon&status=concluido');
 rows=parseCsv(r.text.slice(1),';');check(rows.length===2&&rows[1][8]==='100,00'&&rows[0].length===11,'semicolon + decimal comma + filter');
 check((await call('/api/admin/ops/orders.csv?sep=tab')).status===400,'csv sep validation');
 check((await call('/api/admin/ops/orders.csv?status=bogus')).status===400,'csv filter validation');
 await call('/api/admin/ops/orders.csv?q=ana');
 r=await call('/api/admin/ops/audit?entity=export&action=orders_csv');
 check(r.data.total===3&&r.data.items.every(i=>i.detail.startsWith('by=ops-admin;rows=')),'export audited (3 successful exports; rejected ones are not audited) -> '+JSON.stringify(r.data).slice(0,600));
 check(r.data.items.some(i=>i.detail.includes('"q":true'))&&r.data.items.every(i=>!/ana/i.test(i.detail.replace('by=ops-admin',''))),'search term not stored in audit');
 // more than 5000 rows is refused (422) and does not consume export quota
 sdb.exec("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<5000) INSERT INTO orders(customer_name,device_model,price_brl) SELECT 'Mass '||n,'Mass Model',0 FROM c");
 r=await call('/api/admin/ops/orders.csv');check(r.status===422&&r.data.total>5000&&r.data.max===5000,'row cap -> '+r.status);
 sdb.exec("DELETE FROM orders WHERE customer_name LIKE 'Mass %'");

 // ---- summary
 r=await call('/api/admin/ops/summary');
 check(r.status===200&&r.data.period.days===30&&r.data.daily.length===30&&r.data.timezone==='UTC','summary shape');
 check(r.data.daily.at(-1).day===today&&r.data.daily.at(-1).count===19&&r.data.daily[0].count===0,'daily series');
 const st=Object.fromEntries(r.data.by_status.map(x=>[x.status,x.count]));
 check(JSON.stringify(r.data.by_status.map(x=>x.status))===JSON.stringify(['pendente','em_processamento','concluido','entregue','rejeitado','reembolsado']),'status order follows the state machine');
 check(st.pendente===16&&st.em_processamento===1&&st.concluido===1&&st.rejeitado===1&&st.entregue===0&&st.reembolsado===0,'status counts '+JSON.stringify(st));
 check(r.data.orders.count===19&&r.data.orders.total_brl===234.5&&r.data.orders.completed_total_brl===100,'totals '+JSON.stringify(r.data.orders));
 const pay=Object.fromEntries(r.data.by_payment_status.map(x=>[x.payment_status,x]));
 check(pay.pago.count===1&&pay.pago.total_brl===100&&pay.pendente.count===18&&pay.pendente.total_brl===134.5,'payment buckets');
 check(r.data.backlog.open_orders===17&&r.data.backlog.open_tickets===0&&r.data.client_drafts.total===5&&r.data.client_drafts.last_7_days===5,'backlog and drafts');
 check(JSON.stringify(r.data.by_payment_status.map(x=>x.payment_status))===JSON.stringify(['pago','pendente']),'payment buckets are sorted deterministically');
 r=await call('/api/admin/ops/summary?days=7');check(r.data.daily.length===7,'days=7');
 for(const bad of ['days=0','days=367','days=x'])check((await call('/api/admin/ops/summary?'+bad)).status===400,'summary '+bad);

 // ---- client drafts queue (read-only, redacted)
 r=await call('/api/admin/ops/client-drafts');
 check(r.status===200&&r.data.total===5&&r.data.items.length===5&&r.data.items[0].service_name==='Weird Kind','drafts list');
 check(r.data.by_kind.imei===1&&r.data.by_kind.server===1&&r.data.by_kind.legacy===3&&Object.keys(r.data.by_kind).length===3,'by_kind groups NULL, bad JSON and unknown kinds as legacy: '+JSON.stringify(r.data.by_kind));
 check(r.data.items[0].details_summary.kind==='legacy'&&r.data.items[0].details_summary.provided_fields.length===0&&r.data.items[0].details_summary.mode===null,'unknown kind and non-object details are tolerated');
 for(const secret of ['SECRET-USER-777','SECRET-LICENSE-123','SECRET-RC-9','nota privada','Vivo','x@y.z','details_json'])check(!r.text.includes(secret),'draft response leaks '+secret);
 const server=r.data.items.find(d=>d.service_name==='Server Credits'),imei=r.data.items.find(d=>d.service_name==='iCloud Check');
 check(server.details_summary.kind==='server'&&server.details_summary.provided_fields.join()==='username,license_key,remote_connection','server field names only');
 check(imei.details_summary.api_field_names.join()==='Network,Email'&&imei.details_summary.mode==='single'&&imei.client.email==='c1@example.test','imei summary');
 check(imei.identifier==='356938035643809'&&imei.status==='draft','identifier visible for fulfilment');
 r=await call('/api/admin/ops/client-drafts?kind=server');check(r.data.total===1&&r.data.items[0].service_name==='Server Credits'&&r.data.by_kind.legacy===3,'kind filter keeps facet counts');
 r=await call('/api/admin/ops/client-drafts?kind=legacy');check(r.data.total===3&&r.data.items.every(d=>d.details_summary.kind==='legacy'),'legacy kind filter matches the summary classification');
 check((await call('/api/admin/ops/client-drafts?kind=bogus')).status===400,'draft kind validation');
 r=await call('/api/admin/ops/client-drafts?q=c2@example.test');check(r.data.total===2,'search by client email');
 r=await call('/api/admin/ops/client-drafts?q=LEG-1');check(r.data.total===1,'search by identifier');
 r=await call('/api/admin/ops/client-drafts?q=%25');check(r.data.total===0,'literal percent');
 r=await call('/api/admin/ops/client-drafts?from='+tomorrow);check(r.data.total===0,'draft date filter');
 r=await call('/api/admin/ops/client-drafts?limit=2&offset=1');check(r.data.items.length===2&&r.data.total===5,'draft pagination');

 // ---- audit search
 r=await call('/api/admin/ops/audit?entity=orders&action=status');check(r.data.total===4&&r.data.items.every(i=>i.entity==='orders'&&i.action==='status'),'audit filters');
 r=await call('/api/admin/ops/audit?entity=orders&entity_id='+ids[0]);check(r.data.total===3,'audit per order (created + 2 status) -> '+r.data.total);
 r=await call('/api/admin/ops/audit?q=concluido');check(r.data.total>=1&&r.data.items.every(i=>i.detail.includes('concluido')),'audit detail search');
 r=await call('/api/admin/ops/audit?from='+tomorrow);check(r.data.total===0,'audit date filter');
 check(r.data.facets.entities.includes('orders')&&r.data.facets.entities.includes('export')&&r.data.facets.actions.includes('status')&&r.data.facets.actions.includes('orders_csv'),'audit facets');
 for(const bad of ["entity=orders'","action=a%20b","entity_id=0","entity_id=1.5"])check((await call('/api/admin/ops/audit?'+bad)).status===400,'audit validation '+bad);

 // ---- backward compatibility of the existing endpoints (contracts unchanged)
 r=await call('/api/orders');check(r.status===200&&Array.isArray(r.data)&&r.data.length===19,'GET /api/orders still returns an array');
 r=await call('/api/orders/'+ids[0]+'/status-history');check(r.status===200&&Array.isArray(r.data)&&r.data.length===3,'status history unchanged');
 r=await call('/api/audit-logs');check(r.status===200&&Array.isArray(r.data),'legacy audit endpoint unchanged');

 // ---- export quota (10 per 10 minutes per admin); keep last because it exhausts the budget
 let limited=null,okCount=0;
 for(let i=0;i<12&&!limited;i++){const x=await call('/api/admin/ops/orders.csv?status=pendente');if(x.status===429)limited=x;else{check(x.status===200,'export before quota -> '+x.status);okCount++}}
 // 3 successful exports happened above; the 400s and the 422 must not have consumed quota, so exactly 7 more fit.
 check(limited&&limited.headers.get('retry-after')==='600'&&okCount===7,'export quota: Retry-After 600 after exactly 10 exports -> extra ok='+okCount);
 console.log('ADMIN_OPS_PASS: authz, filters, pagination, validation, csv safety, summary, redacted drafts, audit search, contracts, export quota');
}finally{
 if(child){child.kill('SIGTERM');await delay(150)}
 rmSync(temp,{recursive:true,force:true});
}
