// Hostinger Mail API transactional delivery. No secret or message content in logs.
const endpoint='https://api.mail.hostinger.com';
export const hostingerMailReady=()=>Boolean(process.env.HOSTINGER_MAIL_API_TOKEN&&process.env.MAIL_FROM);
async function request(path,options={}){
 const response=await fetch(endpoint+path,{...options,headers:{Authorization:`Bearer ${process.env.HOSTINGER_MAIL_API_TOKEN}`,'Content-Type':'application/json',Accept:'application/json'},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error(`Hostinger Mail API HTTP ${response.status}`);
 return response.status===204?null:response.json();
}
export async function getHostingerMailbox(){
 if(!hostingerMailReady())throw Error('Hostinger Mail não configurado');
 const result=await request('/api/v1/me');
 const address=process.env.MAIL_FROM.match(/<([^>]+)>/)?.[1]||process.env.MAIL_FROM;
 const mailbox=result?.data?.mailboxes?.find(m=>m.address?.toLowerCase()===address.toLowerCase());
 if(!mailbox?.resourceId)throw Error('Remetente não autorizado no Hostinger Mail');
 return mailbox;
}
export async function sendHostingerMail(to,subject,body){
 const mailbox=await getHostingerMailbox();
 await request(`/api/v1/mailboxes/${encodeURIComponent(mailbox.resourceId)}/send`,{method:'POST',body:JSON.stringify({to:[to],displayName:'UNLOCKER Tools',subject,text:body})});
}
