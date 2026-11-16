const form=document.getElementById('form'),code=document.getElementById('code'),error=document.getElementById('error'),result=document.getElementById('result'),submit=document.getElementById('submit');
const labels={pendente:'Aguardando atendimento',em_processamento:'Em andamento',concluido:'Concluído',entregue:'Entregue',rejeitado:'Não aprovado',reembolsado:'Reembolsado'};
const date=s=>s?String(s).replace('T',' ').slice(0,16):'—';
async function lookup(e){e?.preventDefault();error.textContent='';result.classList.remove('visible');const match=code.value.trim().replace(/^.*#/, '').match(/^(\d+)\.([a-f0-9]{64})$/);if(!match){error.textContent='Código inválido. Confira o link recebido.';return}
submit.disabled=true;submit.textContent='Consultando...';
try{const response=await fetch('/api/public/order-lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(match[1]),token:match[2]}),cache:'no-store'});const data=await response.json();if(!response.ok)throw Error(data.error||'Não foi possível consultar');
document.getElementById('order').textContent='#'+data.order_number;document.getElementById('status').textContent=labels[data.status]||'Em análise';document.getElementById('device').textContent=[data.device_brand,data.device_model].filter(Boolean).join(' · ');document.getElementById('created').textContent=date(data.created_at);document.getElementById('updated').textContent=date(data.updated_at);result.classList.add('visible')}catch(err){error.textContent=err.message}finally{submit.disabled=false;submit.textContent='Consultar andamento'}}
form.addEventListener('submit',lookup);
if(location.hash.length>1){code.value=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname+location.search);lookup()}
