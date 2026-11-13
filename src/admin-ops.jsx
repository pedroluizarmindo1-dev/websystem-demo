// Admin "Operações" page: UI for the read-only /api/admin/ops endpoints (see docs/admin-ops-api.md).
// Self-contained on purpose: src/main.jsx only imports it, shows one admin-only navigation button and renders the page.
// Nothing here changes orders: status changes stay in the existing order table ("Meus Pedidos").
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {BarChart3,ClipboardList,Clock,Download,Inbox,RefreshCw,Wallet} from 'lucide-react';
import './admin-ops.css';

const PAGE_SIZE=25;
const STATUS_LABELS={pendente:'Pendente',em_processamento:'Em andamento',concluido:'Concluído',entregue:'Entregue',rejeitado:'Rejeitado',reembolsado:'Reembolsado'};
const PAYMENT_LABELS={pendente:'Pendente',pago:'Pago'};
const KIND_LABELS={imei:'IMEI',server:'Server',api:'API',legacy:'Legado'};
const SORT_LABELS={id_desc:'Mais recentes',id_asc:'Mais antigas',updated_desc:'Última atualização',price_desc:'Maior valor'};
const TABS=[['resumo','Resumo'],['os','O.S.'],['rascunhos','Rascunhos'],['auditoria','Auditoria']];
const ORDER_FILTERS={q:'',status:'',payment_status:'',from:'',to:'',sort:'id_desc'};
const AUDIT_FILTERS={entity:'',action:'',entity_id:'',q:'',from:'',to:''};

const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n)||0);
const human=(map,value)=>map[value]||String(value||'—').replaceAll('_',' ');
const osNumber=id=>'#'+String(id).padStart(4,'0');
const plural=(n,one,many)=>n+' '+(n===1?one:many);
const minute=value=>String(value||'').slice(0,16)||'—';
const query=params=>{
 const q=new URLSearchParams();
 for(const [k,v] of Object.entries(params))if(v!==undefined&&v!==null&&String(v).trim()!=='')q.set(k,String(v).trim());
 const s=q.toString();return s?'?'+s:'';
};
async function failure(r){
 let d=null;try{d=await r.json()}catch{}
 return Error(d?.error||(r.status===401?'Sessão expirada. Entre novamente.':r.status===403?'Acesso restrito a administradores.':'Falha na consulta ('+r.status+')'));
}
async function opsGet(path,params){
 const r=await fetch('/api/admin/ops'+path+query(params),{headers:{Accept:'application/json'}});
 if(!r.ok)throw await failure(r);
 return r.json();
}
// Loads one endpoint; reloads when the parameters change or the tab becomes visible again; ignores stale answers.
function useOps(path,params,active){
 const [state,setState]=useState({data:null,loading:false,error:''});
 const seq=useRef(0),key=path+query(params);
 const load=useCallback(()=>{
  const id=++seq.current;
  setState(s=>({...s,loading:true,error:''}));
  opsGet(path,params)
   .then(data=>{if(id===seq.current)setState({data,loading:false,error:''})})
   .catch(e=>{if(id===seq.current)setState(s=>({...s,loading:false,error:e.message}))});
 },[key]);
 useEffect(()=>{if(active)load()},[load,active]);
 useEffect(()=>()=>{seq.current++},[]);
 return {...state,reload:load};
}
// If the result shrank (for example after a refresh) and the current page no longer exists, go back to the last page.
function useLastPage(data,offset,setOffset){
 useEffect(()=>{if(data&&offset>0&&offset>=data.total)setOffset(Math.max(0,(Math.ceil(data.total/PAGE_SIZE)-1)*PAGE_SIZE))},[data,offset]);
}

function ErrorLine({text}){return text?<p className="opsError" role="alert">{text}</p>:null}
function Card({icon:Icon,label,value,note}){return <div className="metric"><div className="metrichead"><span>{label}</span><div className="metricicon"><Icon size={19}/></div></div><div className="metricvalue">{value}</div><small>{note}</small></div>}
function Pager({total,offset,loading,onChange}){
 const pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),current=Math.min(pages,Math.floor(offset/PAGE_SIZE)+1);
 return <div className="servicePagination"><span>Página {current} de {pages} · {plural(total,'resultado','resultados')}</span><div><button type="button" disabled={loading||offset<=0} onClick={()=>onChange(Math.max(0,offset-PAGE_SIZE))}>Anterior</button><button type="button" disabled={loading||offset+PAGE_SIZE>=total} onClick={()=>onChange(offset+PAGE_SIZE)}>Próxima</button></div></div>;
}
function Breakdown({title,head,rows}){
 return <div className="panel"><div className="panelhead"><h2>{title}</h2></div><div className="tablewrap">
  <table><thead><tr><th>{head}</th><th className="opsNumber">O.S.</th><th className="opsNumber">Valor</th></tr></thead>
  <tbody>{rows.map(([name,count,total])=><tr key={name}><td>{name}</td><td className="opsNumber">{count}</td><td className="opsNumber">{money(total)}</td></tr>)}</tbody></table>
  {!rows.length&&<div className="empty"><p>Nenhuma O.S. no período.</p></div>}
 </div></div>;
}

function Summary({active}){
 const [days,setDays]=useState(30);
 const {data,loading,error,reload}=useOps('/summary',{days},active);
 const daily=data?.daily||[],max=Math.max(1,...daily.map(d=>d.count));
 const peak=daily.reduce((a,b)=>b.count>a.count?b:a,daily[0]||{day:'',count:0});
 return <>
  <div className="opsToolbar">
   <label>Período<select name="days" value={days} onChange={e=>setDays(Number(e.target.value))}>{[7,30,90].map(n=><option key={n} value={n}>Últimos {n} dias</option>)}</select></label>
   <button type="button" className="outline" onClick={reload} disabled={loading}><RefreshCw size={15}/> {loading?'Atualizando...':'Atualizar'}</button>
   <span className="opsHint">Datas e dias em UTC.</span>
  </div>
  <ErrorLine text={error}/>
  {!data&&loading&&<p className="opsHint">Carregando...</p>}
  {data&&<>
   <div className="metrics">
    <Card icon={ClipboardList} label="O.S. no período" value={data.orders.count} note={data.period.from+' a '+data.period.to}/>
    <Card icon={Wallet} label="Valor das O.S." value={money(data.orders.total_brl)} note={'Concluídas e entregues: '+money(data.orders.completed_total_brl)}/>
    <Card icon={Clock} label="O.S. em aberto" value={data.backlog.open_orders} note={plural(data.backlog.open_tickets,'ticket de suporte aberto','tickets de suporte abertos')}/>
    <Card icon={Inbox} label="Rascunhos de clientes" value={data.client_drafts.total} note={data.client_drafts.last_7_days+' nos últimos 7 dias'}/>
   </div>
   <div className="opsSplit">
    <Breakdown title="Por status" head="Status" rows={data.by_status.map(r=>[human(STATUS_LABELS,r.status),r.count,r.total_brl])}/>
    <Breakdown title="Por pagamento" head="Pagamento" rows={data.by_payment_status.map(r=>[human(PAYMENT_LABELS,r.payment_status),r.count,r.total_brl])}/>
   </div>
   <div className="panel">
    <div className="panelhead"><div><h2>O.S. por dia</h2><p>{peak.count?'Pico de '+peak.count+' O.S. em '+peak.day:'Nenhuma O.S. registrada no período'}</p></div></div>
    <div className="opsBars" role="img" aria-label={'O.S. criadas por dia nos últimos '+data.period.days+' dias'}>
     {daily.map(d=><div key={d.day} className={'opsBar'+(d.count?'':' opsBarEmpty')} title={d.day+': '+d.count+' O.S., '+money(d.total_brl)}><span style={{height:(d.count/max*100)+'%'}}/></div>)}
    </div>
    <div className="opsBarsAxis"><span>{data.period.from}</span><span>{data.period.to}</span></div>
   </div>
  </>}
 </>;
}

function Orders({active}){
 const [draft,setDraft]=useState(ORDER_FILTERS),[applied,setApplied]=useState(ORDER_FILTERS),[offset,setOffset]=useState(0);
 const [exporting,setExporting]=useState(''),[exportError,setExportError]=useState('');
 const {data,loading,error,reload}=useOps('/orders',{...applied,limit:PAGE_SIZE,offset},active);
 useLastPage(data,offset,setOffset);
 const items=data?.items||[],total=data?.total||0;
 const field=k=>({name:k,value:draft[k],onChange:e=>setDraft({...draft,[k]:e.target.value})});
 const submit=e=>{e.preventDefault();if(offset===0&&query(draft)===query(applied))reload();else{setOffset(0);setApplied({...draft})}};
 const clear=()=>{setDraft(ORDER_FILTERS);setApplied(ORDER_FILTERS);setOffset(0)};
 async function exportCsv(sep){
  setExporting(sep);setExportError('');
  try{
   const {sort,...filters}=applied;
   const r=await fetch('/api/admin/ops/orders.csv'+query({...filters,sep}));
   if(!r.ok)throw await failure(r);
   const name=/filename="([^"]+)"/.exec(r.headers.get('content-disposition')||'')?.[1]||'os.csv';
   const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');
   a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }catch(e){setExportError(e.message)}finally{setExporting('')}
 }
 return <div className="panel">
  <div className="panelhead"><div><h2>Consulta de O.S.</h2><p>Filtre, ordene e exporte. Para mudar o status de uma O.S., use "Meus Pedidos".</p></div><span className="count">{plural(total,'resultado','resultados')}</span></div>
  <form className="opsFilters" onSubmit={submit}>
   <label className="opsWide">Busca<input {...field('q')} maxLength={80} placeholder="Cliente, contato, aparelho, serviço ou nº da O.S."/></label>
   <label>Status<select {...field('status')}><option value="">Todos</option><option value="pendente,em_processamento">Em aberto</option>{Object.entries(STATUS_LABELS).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
   <label>Pagamento<select {...field('payment_status')}><option value="">Todos</option>{Object.entries(PAYMENT_LABELS).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
   <label>De<input type="date" {...field('from')}/></label>
   <label>Até<input type="date" {...field('to')}/></label>
   <label>Ordenar por<select {...field('sort')}>{Object.entries(SORT_LABELS).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
   <div className="opsActions opsWide">
    <button className="primary" type="submit" disabled={loading}>{loading?'Consultando...':'Filtrar'}</button>
    <button className="outline" type="button" onClick={clear}>Limpar</button>
    <button className="outline" type="button" data-ops="export-comma" disabled={!!exporting||!total} onClick={()=>exportCsv('comma')}><Download size={15}/> {exporting==='comma'?'Exportando...':'Exportar CSV'}</button>
    <button className="outline" type="button" data-ops="export-semicolon" disabled={!!exporting||!total} onClick={()=>exportCsv('semicolon')}><Download size={15}/> {exporting==='semicolon'?'Exportando...':'CSV para Excel (;)'}</button>
   </div>
  </form>
  <p className="opsHint opsPad">A exportação usa os filtros aplicados (até 5.000 linhas) e fica registrada na auditoria. Datas em UTC.</p>
  <ErrorLine text={error||exportError}/>
  <div className="tablewrap">
   <table><thead><tr><th>O.S.</th><th>Criada em (UTC)</th><th>Cliente</th><th>Aparelho</th><th>Serviço</th><th className="opsNumber">Valor</th><th>Pagamento</th><th>Status</th></tr></thead>
   <tbody>{items.map(o=><tr key={o.id}>
    <td>{osNumber(o.id)}</td><td>{minute(o.created_at)}</td>
    <td><strong>{o.customer_name}</strong>{o.customer_contact&&<small>{o.customer_contact}</small>}</td>
    <td>{[o.device_brand,o.device_model].filter(Boolean).join(' ')||'—'}</td>
    <td>{o.service_name||'—'}</td><td className="opsNumber">{money(o.price_brl)}</td>
    <td>{human(PAYMENT_LABELS,o.payment_status)}</td>
    <td><span className={'status'+(['rejeitado','reembolsado'].includes(o.status)?' muted':'')}>{human(STATUS_LABELS,o.status)}</span></td>
   </tr>)}</tbody></table>
   {data&&!items.length&&<div className="empty"><p>Nenhuma O.S. encontrada com esses filtros.</p></div>}
   {!data&&loading&&<p className="opsHint opsPad">Carregando...</p>}
  </div>
  <Pager total={total} offset={offset} loading={loading} onChange={setOffset}/>
 </div>;
}

function Drafts({active}){
 const [kind,setKind]=useState(''),[text,setText]=useState(''),[q,setQ]=useState(''),[offset,setOffset]=useState(0);
 const {data,loading,error,reload}=useOps('/client-drafts',{kind,q,limit:PAGE_SIZE,offset},active);
 useLastPage(data,offset,setOffset);
 const items=data?.items||[],total=data?.total||0,byKind=data?.by_kind||{};
 const chips=[['','Todos',Object.values(byKind).reduce((a,b)=>a+b,0)],...Object.entries(KIND_LABELS).map(([k,t])=>[k,t,byKind[k]||0])];
 const submit=e=>{e.preventDefault();if(offset===0&&text.trim()===q)reload();else{setOffset(0);setQ(text.trim())}};
 return <div className="panel">
  <div className="panelhead"><div><h2>Rascunhos de clientes</h2><p>Pedidos iniciados na área do cliente que ainda não viraram O.S. Por privacidade, só os nomes dos campos preenchidos aparecem; os valores não são exibidos.</p></div><span className="count">{plural(total,'rascunho','rascunhos')}</span></div>
  <div className="quickChips opsChips">{chips.map(([k,t,n])=><button type="button" key={k||'all'} data-kind={k||'all'} aria-pressed={kind===k} className={kind===k?'selected':''} onClick={()=>{setKind(k);setOffset(0)}}>{t} ({n})</button>)}</div>
  <form className="opsFilters" onSubmit={submit}>
   <label className="opsWide">Busca<input name="q" value={text} onChange={e=>setText(e.target.value)} maxLength={80} placeholder="E-mail ou nome do cliente, serviço, modelo ou identificador"/></label>
   <div className="opsActions"><button className="primary" type="submit" disabled={loading}>{loading?'Consultando...':'Filtrar'}</button></div>
  </form>
  <ErrorLine text={error}/>
  <div className="tablewrap">
   <table><thead><tr><th>Rascunho</th><th>Recebido em (UTC)</th><th>Cliente</th><th>Serviço</th><th>Modelo</th><th>Identificador</th><th>Tipo</th><th>Campos preenchidos</th></tr></thead>
   <tbody>{items.map(d=><tr key={d.id}>
    <td>#{d.id}</td><td>{minute(d.created_at)}</td>
    <td><strong>{d.client.display_name}</strong><small>{d.client.email}</small></td>
    <td>{d.service_name||'—'}</td><td>{d.device_model||'—'}</td><td>{d.identifier||'—'}</td>
    <td><span className="status muted">{human(KIND_LABELS,d.details_summary.kind)}</span></td>
    <td className="opsWrap">{[...d.details_summary.provided_fields,...d.details_summary.api_field_names].join(', ')||'—'}</td>
   </tr>)}</tbody></table>
   {data&&!items.length&&<div className="empty"><p>Nenhum rascunho encontrado.</p></div>}
   {!data&&loading&&<p className="opsHint opsPad">Carregando...</p>}
  </div>
  <Pager total={total} offset={offset} loading={loading} onChange={setOffset}/>
 </div>;
}

function Audit({active}){
 const [draft,setDraft]=useState(AUDIT_FILTERS),[applied,setApplied]=useState(AUDIT_FILTERS),[offset,setOffset]=useState(0);
 const {data,loading,error,reload}=useOps('/audit',{...applied,limit:PAGE_SIZE,offset},active);
 useLastPage(data,offset,setOffset);
 const items=data?.items||[],total=data?.total||0,facets=data?.facets||{entities:[],actions:[]};
 const field=k=>({name:k,value:draft[k],onChange:e=>setDraft({...draft,[k]:e.target.value})});
 const submit=e=>{e.preventDefault();if(offset===0&&query(draft)===query(applied))reload();else{setOffset(0);setApplied({...draft})}};
 const clear=()=>{setDraft(AUDIT_FILTERS);setApplied(AUDIT_FILTERS);setOffset(0)};
 return <div className="panel">
  <div className="panelhead"><div><h2>Trilha de auditoria</h2><p>Criação e mudança de status de O.S., exportações e demais eventos registrados.</p></div><span className="count">{plural(total,'evento','eventos')}</span></div>
  <form className="opsFilters" onSubmit={submit}>
   <label>Entidade<select {...field('entity')}><option value="">Todas</option>{facets.entities.map(v=><option key={v} value={v}>{v}</option>)}</select></label>
   <label>Ação<select {...field('action')}><option value="">Todas</option>{facets.actions.map(v=><option key={v} value={v}>{v}</option>)}</select></label>
   <label>ID do registro<input type="number" min="1" step="1" {...field('entity_id')}/></label>
   <label>De<input type="date" {...field('from')}/></label>
   <label>Até<input type="date" {...field('to')}/></label>
   <label className="opsWide">Texto do detalhe<input {...field('q')} maxLength={80} placeholder="Ex.: concluido, rows=, nome do usuário"/></label>
   <div className="opsActions opsWide"><button className="primary" type="submit" disabled={loading}>{loading?'Consultando...':'Filtrar'}</button><button className="outline" type="button" onClick={clear}>Limpar</button></div>
  </form>
  <ErrorLine text={error}/>
  <div className="tablewrap">
   <table><thead><tr><th>Evento</th><th>Data (UTC)</th><th>Entidade</th><th>ID</th><th>Ação</th><th>Detalhe</th></tr></thead>
   <tbody>{items.map(a=><tr key={a.id}><td>#{a.id}</td><td>{minute(a.created_at)}</td><td>{a.entity}</td><td>{a.entity_id??'—'}</td><td>{a.action}</td><td className="opsWrap">{a.detail||'—'}</td></tr>)}</tbody></table>
   {data&&!items.length&&<div className="empty"><p>Nenhum evento encontrado com esses filtros.</p></div>}
   {!data&&loading&&<p className="opsHint opsPad">Carregando...</p>}
  </div>
  <Pager total={total} offset={offset} loading={loading} onChange={setOffset}/>
 </div>;
}

const PANELS={resumo:Summary,os:Orders,rascunhos:Drafts,auditoria:Audit};
// Tabs stay mounted once opened (filters are kept) and refresh their data every time they become visible again.
export default function AdminOps(){
 const [tab,setTab]=useState('resumo'),[opened,setOpened]=useState({resumo:true});
 const open=id=>{setTab(id);setOpened(o=>({...o,[id]:true}))};
 return <div className="opsPage">
  <div className="quickChips opsTabs" role="tablist" aria-label="Seções de operações">{TABS.map(([id,text])=><button type="button" key={id} role="tab" id={'ops-tab-'+id} data-tab={id} aria-controls={'ops-panel-'+id} aria-selected={tab===id} className={tab===id?'selected':''} onClick={()=>open(id)}>{text}</button>)}</div>
  {TABS.map(([id])=>{const Panel=PANELS[id];return opened[id]?<div key={id} role="tabpanel" id={'ops-panel-'+id} data-panel={id} aria-labelledby={'ops-tab-'+id} hidden={tab!==id}><Panel active={tab===id}/></div>:null})}
 </div>;
}
// Navigation entry rendered by main.jsx for administrators only (sidebar button, or bottom-dock button with `dock`).
export function AdminOpsNavButton({active,onClick,dock=false}){
 return <button type="button" className={(active?'active ':'')+(dock?'opsDockButton':'opsNavButton')} aria-current={dock&&active?'page':undefined} onClick={onClick}><BarChart3 size={dock?20:19}/>{dock?<span>Operações</span>:'Operações'}</button>;
}
